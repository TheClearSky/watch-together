/**
 * The user's own relay (TURN) server — Q-NET-1 C (2026-10-04: "D as a
 * fallback … + C, i absolutely dont want to make it a non fully frontend
 * app"). Saved in this browser only, used at the next join. Browsers still
 * prefer a direct path; the relay carries traffic only when no direct path
 * exists (e.g. a phone on a strict mobile network). Media stays end-to-end
 * encrypted (DTLS-SRTP): the relay only forwards encrypted packets.
 */
import type { RelayServer } from './transport';
import { readPreference, writePreference } from '../storage';

type RelaySetting = { url: string; username: string; credential: string };

const KEY = 'relay';
const isSetting = (value: unknown): value is RelaySetting =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RelaySetting).url === 'string' &&
  typeof (value as RelaySetting).username === 'string' &&
  typeof (value as RelaySetting).credential === 'string';

function savedRelay(): RelaySetting | null {
  const value = readPreference<RelaySetting | null>(KEY, null, (v): v is RelaySetting | null => v === null || isSetting(v));
  return value && value.url.trim() ? value : null;
}

function saveRelay(setting: RelaySetting | null) {
  writePreference(KEY, setting && setting.url.trim() ? { ...setting, url: setting.url.trim() } : null);
}

/** Accepts `turn:` / `turns:` URLs, several separated by spaces or commas. */
function relayUrls(url: string): string[] {
  return url
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function validateRelay(setting: RelaySetting): string | null {
  const urls = relayUrls(setting.url);
  if (urls.length === 0) return 'Add the relay server’s address.';
  const bad = urls.find((url) => !/^turns?:[^\s]+$/i.test(url));
  if (bad) return `“${bad}” is not a relay address — it should start with turn: or turns:`;
  if (!setting.username || !setting.credential) return 'Relay servers need a username and a password.';
  return null;
}

/** What the transport gets (empty when none is set). */
function relayServers(): RelayServer[] {
  const setting = savedRelay();
  if (!setting || validateRelay(setting)) return [];
  return [{ urls: relayUrls(setting.url), username: setting.username, credential: setting.credential }];
}

/**
 * Ask the relay for an address (ICE with relay-only policy). Resolves true when
 * the relay answered with a relay candidate — the credentials and the server
 * work from this network.
 */
async function checkRelay(setting: RelaySetting, timeoutMs = 9000): Promise<{ ok: boolean; detail: string }> {
  const invalid = validateRelay(setting);
  if (invalid) return { ok: false, detail: invalid };
  let pc: RTCPeerConnection | null = null;
  try {
    pc = new RTCPeerConnection({
      iceServers: [{ urls: relayUrls(setting.url), username: setting.username, credential: setting.credential }],
      iceTransportPolicy: 'relay',
    });
    const connection = pc;
    connection.createDataChannel('relay-check');
    const errors: string[] = [];
    const found = new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), timeoutMs);
      connection.onicecandidate = (event) => {
        if (event.candidate && / typ relay/.test(event.candidate.candidate)) {
          window.clearTimeout(timer);
          resolve(true);
        }
      };
      connection.onicecandidateerror = (event) => errors.push(`${event.errorCode} ${event.errorText}`.trim());
      connection.onicegatheringstatechange = () => {
        if (connection.iceGatheringState === 'complete') {
          window.clearTimeout(timer);
          resolve(false);
        }
      };
    });
    await connection.setLocalDescription(await connection.createOffer());
    const ok = await found;
    return ok
      ? { ok: true, detail: 'The relay works from this network.' }
      : { ok: false, detail: errors.length ? `The relay refused: ${[...new Set(errors)].slice(0, 2).join('; ')}` : 'The relay did not answer.' };
  } catch (error) {
    return { ok: false, detail: String(error instanceof Error ? error.message : error) };
  } finally {
    pc?.close();
  }
}

export { checkRelay, relayServers, relayUrls, saveRelay, savedRelay, validateRelay };
export type { RelaySetting };
