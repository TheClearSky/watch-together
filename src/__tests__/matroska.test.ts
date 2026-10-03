import { describe, expect, it } from 'vitest';
import { blobSource, MatroskaError, scanMatroska, toAssDialogue } from '../media/matroskaSubtitles';

// ── a tiny EBML writer, enough to build test files ─────────────────────────
const enc = new TextEncoder();

function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) out.unshift(value & 0xff);
  return out;
}

function sizeBytes(size: number | 'unknown'): number[] {
  if (size === 'unknown') return [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  // 4-byte vint: 0x10 marker + 28 bits
  return [0x10 | ((size >>> 24) & 0x0f), (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff];
}

const el = (id: number, ...payload: (number[] | Uint8Array)[]): number[] => {
  const body = payload.flatMap((part) => Array.from(part));
  return [...idBytes(id), ...sizeBytes(body.length), ...body];
};
const unknownSize = (id: number, ...payload: number[][]): number[] => [...idBytes(id), ...sizeBytes('unknown'), ...payload.flat()];
const uint = (id: number, value: number) => el(id, [value >>> 8, value & 0xff]);
const str = (id: number, value: string) => el(id, enc.encode(value));
/** Block payload: track vint (1 byte), int16 relative time, flags, data. */
const blockBody = (track: number, relative: number, data: number[] | Uint8Array) => [
  0x80 | track,
  (relative >>> 8) & 0xff,
  relative & 0xff,
  0x00,
  ...Array.from(data),
];

function sampleFile(): Uint8Array<ArrayBuffer> {
  const tracks = el(
    0x1654ae6b,
    el(0xae, uint(0xd7, 1), uint(0x83, 0x01), str(0x86, 'V_MPEG4/ISO/AVC')),
    el(0xae, uint(0xd7, 2), uint(0x83, 0x11), str(0x86, 'S_TEXT/ASS'), str(0x22b59c, 'jpn'), str(0x536e, 'Signs'), str(0x63a2, '[Script Info]\nTitle: x')),
    el(0xae, uint(0xd7, 3), uint(0x83, 0x11), str(0x86, 'S_TEXT/UTF8'), str(0x22b59c, 'und')),
  );
  const attachments = el(0x1941a469, el(0x61a7, str(0x466e, 'font.ttf'), str(0x4660, 'font/ttf'), el(0x465c, [1, 2, 3, 4])));
  const video = new Array(5000).fill(7);
  const cluster1 = el(
    0x1f43b675,
    uint(0xe7, 1000),
    el(0xa3, blockBody(1, 0, video)), // video: skipped
    el(0xa0, el(0xa1, blockBody(2, 500, enc.encode('0,0,Default,,0,0,0,,Hello, world'))), uint(0x9b, 2000)),
    el(0xa3, blockBody(3, -100, enc.encode('plain text'))),
  );
  const cluster2 = unknownSize(0x1f43b675, uint(0xe7, 9000), el(0xa3, blockBody(3, 0, enc.encode('in unknown-size cluster'))));
  const tags = el(0x1254c367, [0xff, 0xff]); // a top-level element ends the unknown cluster
  const segment = unknownSize(0x18538067, el(0x1549a966, el(0x2ad7b1, [0x0f, 0x42, 0x40])), tracks, attachments, cluster1, cluster2, tags);
  return new Uint8Array([...el(0x1a45dfa3, str(0x4282, 'matroska')), ...segment]);
}

describe('matroska subtitle scanner', () => {
  it('finds subtitle tracks, fonts and events; skips video', async () => {
    const seen: string[] = [];
    const result = await scanMatroska(blobSource(new Blob([sampleFile()])), {
      onTracks: () => seen.push('tracks'),
      onAttachment: () => seen.push('attachment'),
      onEvent: () => seen.push('event'),
    }, { windowBytes: 64 });
    expect(result.tracks.map((track) => [track.number, track.codec, track.language, track.name])).toEqual([
      [2, 'ass', 'jpn', 'Signs'],
      [3, 'srt', undefined, undefined],
    ]);
    expect(result.tracks[0].header).toBe('[Script Info]\nTitle: x');
    expect(result.attachments).toEqual([{ name: 'font.ttf', mimeType: 'font/ttf', data: new Uint8Array([1, 2, 3, 4]) }]);
    expect(result.events).toEqual([
      { track: 2, start: 1500, duration: 2000, text: '0,0,Default,,0,0,0,,Hello, world' },
      { track: 3, start: 900, duration: undefined, text: 'plain text' },
      { track: 3, start: 9000, duration: undefined, text: 'in unknown-size cluster' },
    ]);
    expect(seen).toEqual(['tracks', 'attachment', 'event', 'event', 'event']); // progressive
  });

  it('turns an ASS block into a script Dialogue line (commas in text kept)', () => {
    expect(toAssDialogue({ track: 2, start: 1500, duration: 2000, text: '7,1,Sign,Bob,0,0,10,,Hi, there, you' })).toBe(
      'Dialogue: 1,0:00:01.50,0:00:03.50,Sign,Bob,0,0,10,,Hi, there, you',
    );
  });

  it('refuses a file that is not Matroska', async () => {
    await expect(scanMatroska(blobSource(new Blob([new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70])])))).rejects.toThrow(MatroskaError);
  });
});
