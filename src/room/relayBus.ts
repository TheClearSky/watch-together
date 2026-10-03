/**
 * The relay bus (feature D) — a messages-only fallback over public Nostr
 * relays, for peers that have NO direct WebRTC path (phone on cellular ↔
 * IPv4-only PC: the direct connection never forms, so NOTHING rides the data
 * channel). It carries only SMALL signed+encrypted control messages — join,
 * approvals, room state, chat, and share control/sync (play/pause/seek + the
 * clock ping/pong). It MUST NOT carry media, file transfers or font blobs:
 * those need WebRTC/TURN.
 *
 * This module is transport only: it connects to the relays, encrypts each
 * message with a key derived from the room CODE (so a relay only ever sees
 * ciphertext), wraps it in an ephemeral Nostr event signed with a throwaway
 * key (relays require a valid schnorr signature), publishes to every relay,
 * and de-duplicates what comes back across them. AUTHENTICITY of who-sent-what
 * is the session's job: it signs the plaintext with the member's identity key
 * and verifies on receive (see session.ts `wrapBus`/`unwrapBus`).
 *
 * Gotchas baked in (R4 research, measured 2026-10-04):
 *  - strfry rejects ephemeral events whose `created_at` is >60 s old, so a
 *    skewed phone clock would break everything — we stamp with Date.now and,
 *    on RECEIVE, never drop on age.
 *  - relays rate-limit; traffic is tiny (sync ~2/s) and we back off a relay
 *    that answers `rate-limited:`.
 *  - max event size ~64 KiB — callers keep messages small; media never here.
 */
import { schnorr } from '@noble/secp256k1';

type BusHandlers = { onMessage(plaintext: string): void };
type Bus = { send(plaintext: string): void; leave(): Promise<void> };
type JoinBus = (roomId: string, code: string, handlers: BusHandlers) => Promise<Bus>;

/** Measured reliable on 2026-10-04 (7/8 delivered 40/40; see relay-fallback-test.mjs). */
const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://purplerelay.com',
  'wss://relay.sigit.io',
  'wss://yabu.me/v2',
  'wss://nostr.data.haus',
  'wss://nostr-01.yakihonne.com',
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** An ephemeral kind (20000–29999) and a topic tag, both from the room id. */
async function topicFor(roomId: string): Promise<{ kind: number; xtag: string }> {
  const digest = await sha256(encoder.encode(`watch-together-bus-topic:${roomId}`));
  const kind = 20000 + ((digest[0] << 8) | digest[1]) % 10000;
  return { kind, xtag: toHex(digest).slice(0, 32) };
}

async function aesKeyFor(code: string): Promise<CryptoKey> {
  const material = await sha256(encoder.encode(`watch-together-bus-key:${code}`));
  return crypto.subtle.importKey('raw', material as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return toBase64(out);
}

async function decrypt(key: CryptoKey, content: string): Promise<string | null> {
  try {
    const bytes = fromBase64(content);
    const iv = bytes.slice(0, 12);
    const cipher = bytes.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher as Uint8Array<ArrayBuffer>);
    return decoder.decode(plain);
  } catch {
    return null; // not ours (different room code) or corrupt
  }
}

type NostrEvent = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };

async function makeEvent(sk: Uint8Array, pubkey: string, kind: number, xtag: string, content: string): Promise<NostrEvent> {
  const created_at = Math.floor(Date.now() / 1000);
  const tags = [['x', xtag]];
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const id = toHex(await sha256(encoder.encode(serialized)));
  // signAsync (not the sync sign) uses WebCrypto's digest, which the browser
  // always has; the sync path needs a hash configured on @noble.
  const sig = toHex(await schnorr.signAsync(hexToBytes(id), sk));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

/** One relay socket, with reconnect and a rate-limit backoff. */
function relaySocket(url: string, subscribe: (ws: WebSocket) => void, onEvent: (event: NostrEvent) => void, isLeaving: () => boolean) {
  let ws: WebSocket | null = null;
  let backoffMs = 1500;
  let rateLimitedUntil = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (isLeaving()) return;
    try {
      ws = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      backoffMs = 1500;
      if (ws) subscribe(ws);
    };
    ws.onmessage = (message) => {
      try {
        const data = JSON.parse(String(message.data));
        if (data[0] === 'EVENT' && data[2]) onEvent(data[2] as NostrEvent);
        else if (data[0] === 'OK' && data[2] === false && /rate-limit/i.test(String(data[3]))) rateLimitedUntil = Date.now() + 10_000;
      } catch {
        // ignore malformed relay frames
      }
    };
    ws.onclose = () => {
      ws = null;
      schedule();
    };
    ws.onerror = () => ws?.close();
  };
  const schedule = () => {
    if (isLeaving() || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      open();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  };
  open();

  return {
    publish(frame: string) {
      if (ws?.readyState === WebSocket.OPEN && Date.now() >= rateLimitedUntil) ws.send(frame);
    },
    close() {
      clearTimeout(retry);
      retry = undefined;
      try {
        ws?.close();
      } catch {
        // already closing
      }
      ws = null;
    },
  };
}

/** The real bus over public Nostr relays. */
function createNostrBus(relays: string[] = DEFAULT_RELAYS): JoinBus {
  return async (roomId, code, handlers) => {
    const { kind, xtag } = await topicFor(roomId);
    const key = await aesKeyFor(code);
    const { secretKey: sk, publicKey } = schnorr.keygen();
    const pubkey = toHex(publicKey); // x-only (32 bytes) already
    const subId = toHex(crypto.getRandomValues(new Uint8Array(8)));
    const seen = new Set<string>();
    let leaving = false;

    const onEvent = (event: NostrEvent) => {
      if (event.kind !== kind || seen.has(event.id)) return;
      seen.add(event.id);
      if (seen.size > 2000) seen.clear(); // bounded
      void decrypt(key, event.content).then((plaintext) => {
        if (plaintext !== null && !leaving) handlers.onMessage(plaintext);
      });
    };
    const subscribe = (ws: WebSocket) => {
      // `since` back a little so a message sent moments before our socket
      // opened is not missed; never an age filter on our own matching.
      ws.send(JSON.stringify(['REQ', subId, { kinds: [kind], '#x': [xtag], since: Math.floor(Date.now() / 1000) - 10 }]));
    };
    const sockets = relays.map((url) => relaySocket(url, subscribe, onEvent, () => leaving));

    return {
      send(plaintext) {
        if (leaving) return;
        void (async () => {
          const event = await makeEvent(sk, pubkey, kind, xtag, await encrypt(key, plaintext));
          const frame = JSON.stringify(['EVENT', event]);
          for (const socket of sockets) socket.publish(frame);
        })();
      },
      async leave() {
        leaving = true;
        for (const socket of sockets) socket.close();
      },
    };
  };
}

/**
 * An in-memory bus network for unit tests: buses sharing a room id + code see
 * each other's messages (and their own are echoed back, like real relays, so
 * the session's self-drop is exercised), de-duplicated by message id.
 */
function createMemoryBusNetwork() {
  const buses: { roomId: string; code: string; handlers: BusHandlers; left: boolean }[] = [];
  const joinBus: JoinBus = async (roomId, code, handlers) => {
    const self = { roomId, code, handlers, left: false };
    buses.push(self);
    return {
      send(plaintext) {
        if (self.left) return;
        const id = Math.random().toString(36).slice(2);
        const envelope = JSON.stringify([id, plaintext]);
        for (const bus of buses) {
          if (bus.left || bus.roomId !== roomId || bus.code !== code) continue;
          queueMicrotask(() => {
            if (!bus.left) bus.handlers.onMessage(JSON.parse(envelope)[1] as string);
          });
        }
      },
      async leave() {
        self.left = true;
      },
    };
  };
  return { joinBus };
}

export { createMemoryBusNetwork, createNostrBus, DEFAULT_RELAYS };
export type { Bus, BusHandlers, JoinBus };
