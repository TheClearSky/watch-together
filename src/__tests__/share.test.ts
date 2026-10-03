/**
 * Watching together over the in-memory network (no media: the network has
 * no WebRTC, so streams are covered by the real-browser e2e; everything
 * else — announcements, state, permissions, control — is covered here).
 */
import { describe, expect, it } from 'vitest';
import { createEphemeralIdentity } from '../room/identity';
import { RoomSession } from '../room/session';
import { createMemoryNetwork } from '../room/transport';
import { ShareController } from '../share/shareController';

async function until(check: () => boolean, label: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Just enough of an HTMLVideoElement for the sharer side. */
function fakeVideo() {
  const listeners = new Map<string, Set<() => void>>();
  const video = {
    paused: true,
    ended: false,
    currentTime: 0,
    playbackRate: 1,
    readyState: 4,
    duration: 1420,
    videoHeight: 1080,
    addEventListener(name: string, listener: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: () => void) {
      listeners.get(name)?.delete(listener);
    },
    fire(name: string) {
      listeners.get(name)?.forEach((listener) => listener());
    },
    async play() {
      video.paused = false;
      video.fire('play');
    },
    pause() {
      video.paused = true;
      video.fire('pause');
    },
  };
  return video;
}

async function room() {
  const network = createMemoryNetwork();
  const make = async (name: string) => {
    const identity = await createEphemeralIdentity();
    const session = new RoomSession({ identity, join: network.join, name, handshakeTimeoutMs: 2000 });
    return { session, id: identity.memberId, shares: new ShareController(session) };
  };
  const deepak = await make('Deepak');
  const asha = await make('Asha');
  const code = await deepak.session.create();
  await asha.session.join(code);
  await until(() => deepak.session.getSnapshot().requests.length === 1, 'request');
  await deepak.session.approve(asha.id);
  await until(() => asha.session.getSnapshot().online.size === 2, 'Asha in');
  return { deepak, asha };
}

describe('watching together', () => {
  it("a share appears for the room with its sharer, title and live state", async () => {
    const { deepak, asha } = await room();
    const video = fakeVideo();
    const file = new File([new Uint8Array(4096).fill(7)], 'ep02.mkv');
    const shareId = deepak.shares.startShare({ tabId: 'file:x', title: 'ep02.mkv', element: video as unknown as HTMLVideoElement, file });
    expect(shareId).toMatch(/^[a-z0-9]{6,16}$/);
    await until(() => asha.shares.getSnapshot().shares.length === 1, 'Asha sees the share');
    const view = asha.shares.getSnapshot().shares[0];
    expect(view).toMatchObject({ sharer: deepak.id, sharerName: 'Deepak', title: 'ep02.mkv', streamable: false });
    // The fingerprint follows once hashed.
    await until(() => asha.shares.getSnapshot().shares[0].fingerprint !== null, 'fingerprint arrives');
    expect(asha.shares.getSnapshot().shares[0].fingerprint).toMatchObject({ name: 'ep02.mkv', size: 4096 });
    // Playback changes reach the viewer.
    video.currentTime = 600;
    await video.play();
    await until(() => asha.shares.getSnapshot().shares[0].state?.playing === true, 'playing state');
    expect(asha.shares.getSnapshot().shares[0].state?.t).toBe(600);
    video.pause();
    await until(() => asha.shares.getSnapshot().shares[0].state?.playing === false, 'paused state');
  });

  it('stopping a share ends it for viewers', async () => {
    const { deepak, asha } = await room();
    const shareId = deepak.shares.startShare({ tabId: 'file:x', title: 'film.mp4', element: fakeVideo() as unknown as HTMLVideoElement, file: null })!;
    await until(() => asha.shares.getSnapshot().shares.length === 1, 'share seen');
    deepak.shares.stopShare(shareId);
    await until(() => asha.shares.getSnapshot().shares.length === 0, 'share gone');
  });

  it('Q5: a member who may not share cannot start one, and an existing share stops when revoked', async () => {
    const { deepak, asha } = await room();
    deepak.session.setShareRule(asha.id, 'deny');
    await until(() => asha.session.getSnapshot().room?.shareRules[asha.id] === 'deny', 'rule arrives');
    expect(asha.shares.canShareNow()).toBe(false);
    expect(asha.shares.startShare({ tabId: 'file:a', title: 'x', element: null, file: null })).toBeNull();
    deepak.session.setShareRule(asha.id, 'allow');
    await until(() => asha.shares.canShareNow(), 'allowed again');
    asha.shares.startShare({ tabId: 'file:a', title: 'mine.mp4', element: fakeVideo() as unknown as HTMLVideoElement, file: null });
    await until(() => deepak.shares.getSnapshot().shares.length === 1, 'owner sees it');
    deepak.session.setShareRule(asha.id, 'deny');
    await until(() => asha.shares.getSnapshot().mine.length === 0, "Asha's share stopped");
    await until(() => deepak.shares.getSnapshot().shares.length === 0, 'gone for the owner');
  });

  it('a viewer asks for control; once granted, their commands drive the sharer', async () => {
    const { deepak, asha } = await room();
    const video = fakeVideo();
    const shareId = deepak.shares.startShare({ tabId: 'file:x', title: 'ep.mkv', element: video as unknown as HTMLVideoElement, file: null })!;
    await until(() => asha.shares.getSnapshot().shares.length === 1, 'share seen');
    let asked = '';
    deepak.shares.onControlRequest = (_id, _member, name) => (asked = name);
    asha.shares.sendControl(shareId, { type: 'play' }); // not granted: ignored
    asha.shares.requestControl(shareId);
    await until(() => asked === 'Asha', 'sharer asked');
    expect(video.paused).toBe(true);
    deepak.shares.grantControl(shareId, asha.id);
    await until(() => asha.shares.hasControl(shareId), 'Asha has control');
    asha.shares.sendControl(shareId, { type: 'seek', t: 300 });
    asha.shares.sendControl(shareId, { type: 'play' });
    await until(() => !video.paused && video.currentTime === 300, 'commands applied');
    deepak.shares.grantControl(shareId, null);
    await until(() => !asha.shares.hasControl(shareId), 'revoked');
  });

  it('a newcomer learns about shares already running', async () => {
    const { deepak } = await room();
    deepak.shares.startShare({ tabId: 'file:x', title: 'late.mp4', element: fakeVideo() as unknown as HTMLVideoElement, file: null });
    // Ravi joins after the share started.
    const network = (deepak.session as unknown as { joinTransport: unknown }).joinTransport;
    const identity = await createEphemeralIdentity();
    const ravi = new RoomSession({ identity, join: network as never, name: 'Ravi', handshakeTimeoutMs: 2000 });
    const raviShares = new ShareController(ravi);
    await ravi.join(deepak.session.getSnapshot().code!);
    await until(() => deepak.session.getSnapshot().requests.length === 1, 'request');
    await deepak.session.approve(identity.memberId);
    await until(() => raviShares.getSnapshot().shares.some((share) => share.title === 'late.mp4'), 'Ravi sees the share');
  });

  it('clock sync: a viewer measures the offset to the sharer', async () => {
    const { deepak, asha } = await room();
    const shareId = deepak.shares.startShare({ tabId: 'file:x', title: 'x', element: fakeVideo() as unknown as HTMLVideoElement, file: null })!;
    await until(() => asha.shares.getSnapshot().shares.length === 1, 'share seen');
    asha.shares.startClock(shareId);
    await until(() => asha.shares.clock(shareId).sampleCount >= 3, 'clock samples');
    // Same machine, same clock: the offset is ~0.
    expect(Math.abs(asha.shares.clock(shareId).best!.offset)).toBeLessThan(50);
    asha.shares.stopClock(shareId);
  });
});
