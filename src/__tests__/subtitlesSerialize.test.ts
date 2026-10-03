import { describe, expect, it } from 'vitest';
import {
  assembleFont,
  chunkFont,
  chunkPayload,
  createChunkAssembler,
  FONT_CHUNK_BYTES,
  fontChunks,
  fontManifest,
  MAX_CHUNK_BYTES,
  parseSerializedTrack,
  payloadChunkSchema,
  serializeTrack,
  sha256Hex,
  splitPayload,
  trackChunks,
  verifiedFont,
} from '../subtitles/serialize';

const fontBytes = (size: number) => new Uint8Array(size).map((_, index) => (index * 31 + 7) % 256);
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe('track serialization', () => {
  it('ass and text tracks round-trip through JSON and validation', () => {
    const ass = serializeTrack({ id: 'embedded:3', label: 'CR', content: { kind: 'ass', script: '[Script Info]\nDialogue: 0,…,Hi, "you"' } });
    expect(ass).toEqual({ id: 'embedded:3', label: 'CR', kind: 'ass', script: '[Script Info]\nDialogue: 0,…,Hi, "you"' });
    expect(parseSerializedTrack(JSON.parse(JSON.stringify(ass)))).toEqual(ass);

    const text = serializeTrack({ id: 'x', label: 'English', language: 'en', content: { kind: 'text', cues: [{ start: 1.23456, end: 2, text: 'a' }] } });
    expect(text).toEqual({ id: 'x', label: 'English', language: 'en', kind: 'text', cues: [{ start: 1.235, end: 2, text: 'a' }] });
    expect(parseSerializedTrack(JSON.parse(JSON.stringify(text)))).toEqual(text);
  });

  it('rejects malformed tracks from a peer', () => {
    expect(parseSerializedTrack({ id: 'x', label: 'y', kind: 'ass' })).toBeNull(); // no script
    expect(parseSerializedTrack({ id: 'x', label: 'y', kind: 'text', script: 'z' })).toBeNull(); // no cues
    expect(parseSerializedTrack({ id: '', label: 'y', kind: 'ass', script: '' })).toBeNull();
    expect(parseSerializedTrack('nope')).toBeNull();
  });

  it('a big track splits into chunks that each fit one 64 KiB message, and reassembles', () => {
    // ~390 CR-style events with backslashes (JSON doubles them), quotes and non-ASCII.
    const lines = Array.from({ length: 900 }, (_, i) => `Dialogue: 0,0:00:${i % 60}.00,0:00:${i % 60}.50,Default,,0,0,0,,{\\an8}Línea "${i}"\\N日本語 😀`);
    const track = serializeTrack({ id: 'embedded:4', label: 'por', content: { kind: 'ass', script: lines.join('\n') } });
    const chunks = trackChunks(track);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(jsonBytes({ t: 'sub-chunk', shareId: 'abcdef123456', ...chunk })).toBeLessThan(64 * 1024);
      expect(payloadChunkSchema.safeParse(chunk).success).toBe(true);
    }
    const assembler = createChunkAssembler();
    const shuffled = [...chunks].reverse();
    let whole: string | null = null;
    for (const chunk of [...shuffled, shuffled[0]]) whole = assembler.add(chunk) ?? whole; // a duplicate is ignored
    expect(parseSerializedTrack(JSON.parse(whole!))).toEqual(track);
  });

  it('splitPayload never cuts a code point and respects the JSON-encoded budget', () => {
    const text = '😀"\\\n'.repeat(50) + 'é'.repeat(30);
    const pieces = splitPayload(text, 16);
    expect(pieces.join('')).toBe(text);
    for (const piece of pieces) {
      expect(JSON.stringify(piece).length - 2).toBeLessThanOrEqual(16); // ASCII escapes
      expect(new TextEncoder().encode(JSON.stringify(piece)).length - 2).toBeLessThanOrEqual(16);
      expect(/^[\uDC00-\uDFFF]/.test(piece)).toBe(false);
    }
    expect(splitPayload('')).toEqual(['']);
    expect(chunkPayload('k', 'abc')).toEqual([{ key: 'k', index: 0, count: 1, data: 'abc' }]);
  });
});

describe('font chunking', () => {
  it('36 KiB raw → exactly 48 KiB base64 per chunk; round-trips byte for byte', () => {
    const font = fontBytes(286_620); // arialbd_3.ttf's size in the Slime file
    const chunks = chunkFont(font);
    expect(FONT_CHUNK_BYTES * 4 / 3).toBe(MAX_CHUNK_BYTES);
    expect(chunks).toHaveLength(Math.ceil(286_620 / FONT_CHUNK_BYTES));
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    expect(assembleFont(chunks)).toEqual(font);
    expect(assembleFont(chunkFont(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  it('manifest (name, size, sha256, chunks) + keyed chunks → verified bytes on the other side', async () => {
    const data = fontBytes(100_000).buffer;
    const [entry] = await fontManifest([{ name: 'Arial_2.ttf', data }]);
    expect(entry).toMatchObject({ name: 'Arial_2.ttf', size: 100_000, chunks: 3 });
    expect(entry.sha256).toBe(await sha256Hex(new Uint8Array(data)));
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);

    const assembler = createChunkAssembler();
    let base64: string | null = null;
    for (const chunk of fontChunks(entry, data)) {
      expect(chunk.key).toBe(`font:${entry.sha256}`);
      expect(jsonBytes({ t: 'font-chunk', ...chunk })).toBeLessThan(64 * 1024);
      base64 = assembler.add(chunk) ?? base64;
    }
    expect(await verifiedFont(entry, base64!)).toEqual(new Uint8Array(data));
    expect(await verifiedFont({ ...entry, sha256: '0'.repeat(64) }, base64!)).toBeNull();
    expect(await verifiedFont({ ...entry, size: 1 }, base64!)).toBeNull();
  });

  it('the assembler bounds its pending payloads and reports progress', () => {
    const assembler = createChunkAssembler({ maxPending: 2 });
    assembler.add({ key: 'a', index: 0, count: 2, data: 'x' });
    expect(assembler.progress('a')).toBe(0.5);
    assembler.add({ key: 'b', index: 0, count: 2, data: 'x' });
    assembler.add({ key: 'c', index: 0, count: 2, data: 'x' }); // evicts 'a'
    expect(assembler.progress('a')).toBe(0);
    expect(assembler.add({ key: 'c', index: 1, count: 2, data: 'y' })).toBe('xy');
  });
});
