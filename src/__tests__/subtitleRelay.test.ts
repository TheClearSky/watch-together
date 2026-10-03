/**
 * Subtitles travel with a share: a viewer asks, the sharer sends tracks and
 * verified fonts, and a move to another video replaces them.
 */
import { describe, expect, it } from 'vitest';
import { createEphemeralIdentity } from '../room/identity';
import { RoomSession } from '../room/session';
import { createMemoryNetwork } from '../room/transport';
import { ShareController } from '../share/shareController';
import { SubtitleRelay } from '../share/subtitleRelay';

async function until(check: () => boolean, label: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function room() {
  const network = createMemoryNetwork();
  const make = async (name: string) => {
    const identity = await createEphemeralIdentity();
    const session = new RoomSession({ identity, join: network.join, name, handshakeTimeoutMs: 2000 });
    const shares = new ShareController(session);
    return { session, id: identity.memberId, shares, relay: new SubtitleRelay(session, shares) };
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

const font = (size: number, seed: number) => {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * seed) % 256;
  return bytes.buffer;
};

describe('subtitle relay', () => {
  it('a viewer receives the sharer’s tracks and fonts, and a new video replaces them', async () => {
    const { deepak, asha } = await room();
    const ass = '[Script Info]\nScriptType: v4.00+\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello';
    deepak.relay.setTabSubtitles('file:a', {
      tracks: [
        { id: 'embedded:3', label: 'English (ASS)', kind: 'ass', script: ass },
        { id: 'embedded:4', label: 'Signs', kind: 'text', cues: [{ start: 1, end: 2, text: 'Sign' }] },
      ],
      fonts: [{ name: 'Big.ttf', data: font(200_000, 7) }],
    });
    const shareId = deepak.shares.startShare({ tabId: 'file:a', title: 'ep1.mkv', element: null, file: null })!;
    await until(() => asha.shares.view(shareId) !== null, 'share visible');
    asha.relay.request(shareId);
    await until(() => (asha.relay.subtitlesFor(shareId)?.fonts.length ?? 0) === 1, 'tracks + font arrive', 15000);
    const got = asha.relay.subtitlesFor(shareId)!;
    expect(got.tracks.map((track) => track.label)).toEqual(['English (ASS)', 'Signs']);
    expect(got.tracks[0].script).toBe(ass);
    expect(new Uint8Array(got.fonts[0].data)).toEqual(new Uint8Array(font(200_000, 7)));

    // The share moves on to a video without subtitles: the viewer's clear.
    deepak.shares.retargetShare(shareId, 'file:b');
    await until(() => asha.relay.subtitlesFor(shareId) === null, 'cleared for the next video');
  }, 30000);

});
