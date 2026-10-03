/**
 * Feature D — the Nostr-relay message fallback — over an IN-MEMORY bus, with
 * WebRTC made impossible (an isolated transport that never connects any peer).
 * Proves that with NO direct path two people can still join/approve, chat, see
 * each other online, and exchange the share announce/state + clock samples that
 * "My copy" runs on.
 */
import { describe, expect, it } from 'vitest';
import { createEphemeralIdentity } from '../room/identity';
import { RoomSession } from '../room/session';
import { createMemoryBusNetwork } from '../room/relayBus';
import type { JoinTransport, TransportRoom } from '../room/transport';
import { RoomChat } from '../room/chat';
import { ShareController } from '../share/shareController';

async function until(check: () => boolean, label: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A WebRTC transport that never connects anyone — forces the bus-only path. */
const isolatedJoin: JoinTransport = async () => {
  const room: TransportRoom = {
    selfId: `iso-${Math.random().toString(36).slice(2)}`,
    send: async () => {},
    on: () => {},
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    peers: () => [],
    closePeer: () => {},
    leave: async () => {},
    media: null,
  };
  return room;
};

function fakeVideo() {
  const listeners = new Map<string, Set<() => void>>();
  const video = {
    paused: false,
    ended: false,
    currentTime: 30,
    playbackRate: 1,
    readyState: 4,
    duration: 1420,
    videoHeight: 1080,
    addEventListener(name: string, fn: () => void) {
      (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(fn);
    },
    removeEventListener(name: string, fn: () => void) {
      listeners.get(name)?.delete(fn);
    },
    fire(name: string) {
      listeners.get(name)?.forEach((fn) => fn());
    },
  };
  return video;
}

async function member(network: ReturnType<typeof createMemoryBusNetwork>, name: string) {
  const identity = await createEphemeralIdentity();
  const session = new RoomSession({ identity, join: isolatedJoin, joinBus: network.joinBus, name, handshakeTimeoutMs: 2000 });
  return { session, id: identity.memberId, shares: new ShareController(session), chat: new RoomChat(session) };
}

describe('relay-bus fallback (no direct WebRTC path)', () => {
  it('join → approve → chat → share state + clock, all over the bus', async () => {
    const network = createMemoryBusNetwork();
    const deepak = await member(network, 'Deepak');
    const asha = await member(network, 'Asha');

    const code = await deepak.session.create();
    await asha.session.join(code);

    // Admission happens over the bus: Deepak sees the request, approves it.
    await until(() => deepak.session.getSnapshot().requests.length === 1, 'Deepak sees the bus join request');
    expect(deepak.session.getSnapshot().requests[0].name).toBe('Asha');
    await deepak.session.approve(asha.id);
    await until(() => asha.session.getSnapshot().status.kind === 'in-room', 'Asha admitted over the bus');

    // Both see each other online (presence travels on the bus).
    await until(() => deepak.session.getSnapshot().online.size === 2, 'Deepak sees 2 online');
    await until(() => asha.session.getSnapshot().online.size === 2, 'Asha sees 2 online');

    // Chat crosses the bus.
    deepak.chat.send('popcorn ready?');
    await until(() => asha.chat.getSnapshot().lines.some((l) => l.text === 'popcorn ready?'), 'Asha gets the chat line');
    expect(asha.chat.getSnapshot().lines.at(-1)!.name).toBe('Deepak');

    // Deepak shares a file; Asha (My copy) receives the announce + playback state.
    const video = fakeVideo();
    const file = new File([new Uint8Array(2048).fill(9)], 'ep.mkv');
    const shareId = deepak.shares.startShare({ tabId: 'file:x', title: 'ep.mkv', element: video as unknown as HTMLVideoElement, file })!;
    await until(() => asha.shares.view(shareId)?.sharer === deepak.id, 'Asha sees the share over the bus');
    await until(() => asha.shares.view(shareId)?.state != null, 'Asha receives playback state');
    const state = asha.shares.view(shareId)!.state!;
    expect(state.playing).toBe(true);
    expect(state.t).toBeGreaterThanOrEqual(30);

    // Clock sync for "My copy": Asha pings, Deepak pongs — a sample lands.
    asha.shares.startClock(shareId);
    await until(() => asha.shares.clock(shareId).remoteNow(Date.now()) != null, 'Asha gets a clock sample over the bus', 6000);

    await deepak.session.leave();
    await asha.session.leave();
  }, 20000);

  it('a directly-connected pair does not double-handle bus messages', async () => {
    // Two sessions that ARE directly connected (memory WebRTC net) AND share a
    // bus: chat must arrive exactly once (bus copy dropped in favour of direct).
    const { createMemoryNetwork } = await import('../room/transport');
    const net = createMemoryNetwork();
    const bus = createMemoryBusNetwork();
    const make = async (name: string) => {
      const identity = await createEphemeralIdentity();
      const session = new RoomSession({ identity, join: net.join, joinBus: bus.joinBus, name, handshakeTimeoutMs: 2000 });
      return { session, id: identity.memberId, chat: new RoomChat(session) };
    };
    const a = await make('A');
    const b = await make('B');
    const code = await a.session.create();
    await b.session.join(code);
    await until(() => a.session.getSnapshot().requests.length === 1, 'request');
    await a.session.approve(b.id);
    await until(() => b.session.getSnapshot().status.kind === 'in-room', 'B in', 8000);
    // Wait for the DIRECT peer to form, so the dedup path (prefer WebRTC, drop
    // the bus copy) is what we actually exercise.
    await until(() => a.session.peersOfMember(b.id).some((id) => !id.startsWith('bus:')), 'A has a direct peer to B', 8000);
    await until(() => b.session.peersOfMember(a.id).some((id) => !id.startsWith('bus:')), 'B has a direct peer to A', 8000);
    a.chat.send('hello');
    await until(() => b.chat.getSnapshot().lines.some((l) => l.text === 'hello'), 'B gets it', 8000);
    await new Promise((r) => setTimeout(r, 400)); // let any bus duplicate arrive too
    expect(b.chat.getSnapshot().lines.filter((l) => l.text === 'hello')).toHaveLength(1);
    await a.session.leave();
    await b.session.leave();
  }, 20000);
});
