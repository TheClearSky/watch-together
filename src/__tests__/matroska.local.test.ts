/**
 * Opt-in check against a REAL file (not in CI): `WT_LOCAL_MKV=<path> npx
 * vitest run matroska.local`. Expected values were measured on 2026-10-01 with
 * `matroska-subtitles@3.3.2` (the reference parser) on the Slime S4 ep02 file
 * in Repos/ (research/2026-10-01/R3-subtitles.md).
 */
import { open } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { scanMatroska } from '../media/matroskaSubtitles';
import type { ByteSource } from '../media/matroskaSubtitles';

const path = process.env.WT_LOCAL_MKV;

describe.skipIf(!path)('matroska scanner — real file', () => {
  it('matches the reference parser, much faster', async () => {
    const handle = await open(path!, 'r');
    const { size } = await handle.stat();
    const source: ByteSource = {
      size,
      async read(offset, length) {
        const buffer = new Uint8Array(Math.min(length, size - offset));
        await handle.read(buffer, 0, buffer.length, offset);
        return buffer;
      },
    };
    const started = performance.now();
    const result = await scanMatroska(source);
    const elapsed = performance.now() - started;
    await handle.close();
    const perTrack: Record<number, number> = {};
    for (const event of result.events) perTrack[event.track] = (perTrack[event.track] ?? 0) + 1;
    console.log(`scanned ${(size / 1e9).toFixed(2)} GB in ${elapsed.toFixed(0)} ms`, perTrack);
    expect(result.tracks.map((track) => track.number)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(result.tracks.every((track) => track.codec === 'ass')).toBe(true);
    expect(perTrack).toEqual({ 3: 339, 4: 345, 5: 329, 6: 329, 7: 339, 8: 332, 9: 367, 10: 390, 11: 332 });
    expect(result.attachments.length).toBe(15);
    expect(result.attachments[0]).toMatchObject({ name: 'arialbd_3.ttf' });
    expect(result.attachments[0].data.length).toBe(286_620);
  }, 120_000);
});
