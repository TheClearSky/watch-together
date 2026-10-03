import { describe, expect, it } from 'vitest';
import { blobSource, scanMatroska } from '../media/matroskaSubtitles';
import type { SubtitleEvent } from '../media/matroskaSubtitles';
import {
  applyWorkerMessage,
  createEventBatcher,
  createProgressThrottle,
  fontMessage,
  initialExtractionState,
  isEbmlMagic,
  isFontAttachment,
  trackLabel,
} from '../subtitles/protocol';
import type { WorkerMessage } from '../subtitles/protocol';
import { trackContent } from '../subtitles/useEmbeddedSubtitles';

// ── a tiny EBML writer (same shape as matroska.test.ts) ────────────────────
const enc = new TextEncoder();
function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) out.unshift(value & 0xff);
  return out;
}
const sizeBytes = (size: number) => [0x10 | ((size >>> 24) & 0x0f), (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff];
const el = (id: number, ...payload: (number[] | Uint8Array)[]): number[] => {
  const body = payload.flatMap((part) => Array.from(part));
  return [...idBytes(id), ...sizeBytes(body.length), ...body];
};
const uint = (id: number, value: number) => el(id, [value >>> 8, value & 0xff]);
const str = (id: number, value: string) => el(id, enc.encode(value));
const blockBody = (track: number, relative: number, data: Uint8Array) => [0x80 | track, (relative >>> 8) & 0xff, relative & 0xff, 0x00, ...Array.from(data)];
const ASS_HEADER = '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nStyle: Default,Arial,20\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

function mkv(): Uint8Array<ArrayBuffer> {
  const tracks = el(
    0x1654ae6b,
    el(0xae, uint(0xd7, 1), uint(0x83, 0x01), str(0x86, 'V_MPEG4/ISO/AVC')),
    el(0xae, uint(0xd7, 3), uint(0x83, 0x11), str(0x86, 'S_TEXT/ASS'), str(0x536e, 'CR'), str(0x63a2, ASS_HEADER)),
    el(0xae, uint(0xd7, 4), uint(0x83, 0x11), str(0x86, 'S_TEXT/UTF8'), str(0x22b59c, 'por')),
  );
  const attachments = el(
    0x1941a469,
    el(0x61a7, str(0x466e, 'arialbd_3.ttf'), str(0x4660, 'application/x-truetype-font'), el(0x465c, [1, 2, 3, 4])),
    el(0x61a7, str(0x466e, 'cover.jpg'), str(0x4660, 'image/jpeg'), el(0x465c, [9, 9])),
  );
  const cluster = (time: number, ...blocks: number[][]) => el(0x1f43b675, uint(0xe7, time), ...blocks);
  const group = (track: number, relative: number, text: string, duration: number) => el(0xa0, el(0xa1, blockBody(track, relative, enc.encode(text))), uint(0x9b, duration));
  return new Uint8Array([
    ...el(0x1a45dfa3, str(0x4282, 'matroska')),
    ...el(
      0x18538067,
      tracks,
      attachments,
      cluster(4000, group(3, 0, '1,0,Default,,0,0,0,,Later, line', 1000), el(0xa3, blockBody(4, 10, enc.encode('olá')))),
      cluster(1000, group(3, 0, '0,0,Default,,0,0,0,,Earlier', 1500), el(0xa3, blockBody(1, 0, new Uint8Array(3000)))),
    ),
  ]);
}

describe('worker protocol (pure parts)', () => {
  it('sniffs the EBML magic', () => {
    expect(isEbmlMagic(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0]))).toBe(true);
    expect(isEbmlMagic(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe(false); // mp4 ftyp
    expect(isEbmlMagic(new Uint8Array([0x1a]))).toBe(false);
  });

  it('keeps only font attachments', () => {
    expect(isFontAttachment({ name: 'a.ttf', mimeType: 'application/x-truetype-font' })).toBe(true);
    expect(isFontAttachment({ name: 'b.otf', mimeType: 'application/vnd.ms-opentype' })).toBe(true);
    expect(isFontAttachment({ name: 'c.bin', mimeType: 'font/woff2' })).toBe(true);
    expect(isFontAttachment({ name: 'D.TTF', mimeType: 'application/octet-stream' })).toBe(true);
    expect(isFontAttachment({ name: 'cover.jpg', mimeType: 'image/jpeg' })).toBe(false);
  });

  it('font messages carry a standalone, transferable ArrayBuffer', () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const { message, transfer } = fontMessage({ name: 'f.ttf', mimeType: 'font/ttf', data: backing.subarray(2, 5) });
    expect(message.type === 'font' && Array.from(new Uint8Array(message.font.data))).toEqual([2, 3, 4]);
    expect(transfer).toHaveLength(1);
    expect(transfer[0].byteLength).toBe(3);
  });

  it('batches events by count and by time, flushes the rest at the end', () => {
    let clock = 0;
    const sent: number[] = [];
    const batcher = createEventBatcher({ send: (events) => sent.push(events.length), now: () => clock, maxEvents: 3, maxMs: 100 });
    const event: SubtitleEvent = { track: 3, start: 0, duration: 1, text: 'x' };
    for (let i = 0; i < 7; i += 1) batcher.push(event);
    expect(sent).toEqual([3, 3]);
    clock = 150;
    batcher.tick();
    expect(sent).toEqual([3, 3, 1]);
    batcher.push(event);
    batcher.flush();
    batcher.flush(); // nothing pending: no empty batch
    expect(sent).toEqual([3, 3, 1, 1]);
  });

  it('throttles progress to 1 % steps and always reports completion', () => {
    const seen: number[] = [];
    const progress = createProgressThrottle((fraction) => seen.push(fraction));
    for (const fraction of [0, 0.004, 0.011, 0.015, 0.5, 0.505, 1]) progress(fraction);
    expect(seen).toEqual([0, 0.011, 0.5, 1]);
  });

  it('labels tracks by name and language', () => {
    expect(trackLabel({ number: 3, name: 'CR', language: undefined })).toBe('CR');
    expect(trackLabel({ number: 5, name: 'Español', language: 'es-419' })).toBe('Español · es-419');
    expect(trackLabel({ number: 7, name: undefined, language: undefined })).toBe('Track 7');
  });

  it('scanner → worker messages → reducer → scripts and cues (what the worker and hook do)', async () => {
    // Drive the scanner with the same handler wiring as embeddedWorker.ts.
    const messages: WorkerMessage[] = [];
    const batcher = createEventBatcher({ send: (events) => messages.push({ type: 'events', events }), maxEvents: 1 });
    await scanMatroska(
      blobSource(new Blob([mkv()])),
      {
        onTracks: (tracks) => messages.push({ type: 'tracks', tracks }),
        onAttachment: (attachment) => {
          if (isFontAttachment(attachment)) messages.push(fontMessage(attachment).message);
        },
        onEvent: (event) => batcher.push(event),
      },
      { windowBytes: 64 },
    );
    batcher.flush();
    messages.push({ type: 'done', summary: { matroska: true, tracks: 2, events: 3, fonts: 1, elapsedMs: 1, stoppedEarly: false } });
    expect(messages.map((message) => message.type)).toEqual(['tracks', 'font', 'events', 'events', 'events', 'done']);

    let state = initialExtractionState();
    const revisions: number[] = [];
    for (const message of messages) {
      state = applyWorkerMessage(state, message);
      revisions.push(state.revision);
    }
    expect(state.status).toBe('done');
    expect(state.fonts.map((font) => font.name)).toEqual(['arialbd_3.ttf']);
    expect(new Set(revisions).size).toBe(revisions.length); // every message is a new revision

    const ass = trackContent(state, 3);
    expect(ass?.kind).toBe('ass');
    const dialogues = ass?.kind === 'ass' ? ass.script.split('\n').filter((line) => line.startsWith('Dialogue:')) : [];
    // Muxed out of order across clusters → sorted by start in the script.
    expect(dialogues).toEqual([
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Earlier',
      'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,Later, line',
    ]);
    expect(trackContent(state, 4)).toEqual({ kind: 'text', cues: [{ start: 4.01, end: 9.01, text: 'olá' }] });
    expect(trackContent(state, 1)).toBeNull(); // the video track is not a subtitle track
  });

  it('the reducer is pure: applying a batch twice to the same state does not double events (StrictMode)', () => {
    const before = applyWorkerMessage(initialExtractionState(), {
      type: 'tracks',
      tracks: [{ number: 3, codec: 'ass', codecId: 'S_TEXT/ASS', language: undefined, name: 'CR', default: true, forced: false, header: undefined }],
    });
    const batch: WorkerMessage = { type: 'events', events: [{ track: 3, start: 0, duration: 1, text: 'a' }, { track: 3, start: 5, duration: 1, text: 'b' }] };
    applyWorkerMessage(before, batch); // React's discarded first call
    const after = applyWorkerMessage(before, batch);
    expect(after.events.get(3)).toHaveLength(2);
    expect(before.events.get(3)).toHaveLength(0);
  });

  it('a file whose Tracks hold no subtitle track ends with status "none"', () => {
    let state = initialExtractionState();
    state = applyWorkerMessage(state, { type: 'tracks', tracks: [] });
    state = applyWorkerMessage(state, { type: 'done', summary: { matroska: true, tracks: 0, events: 0, fonts: 0, elapsedMs: 1, stoppedEarly: true } });
    expect(state.status).toBe('none');
    expect(state.progress).toBe(1);
  });

  it('an error message sets status and keeps what already arrived', () => {
    let state = initialExtractionState();
    state = applyWorkerMessage(state, { type: 'tracks', tracks: [{ number: 3, codec: 'ass', codecId: 'S_TEXT/ASS', language: undefined, name: 'CR', default: true, forced: false, header: undefined }] });
    state = applyWorkerMessage(state, { type: 'error', message: 'Truncated element' });
    expect(state).toMatchObject({ status: 'error', error: 'Truncated element' });
    expect(state.tracks).toHaveLength(1);
  });
});
