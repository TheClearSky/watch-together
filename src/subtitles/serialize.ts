/**
 * Subtitle tracks and fonts over the room's data channel, for stream-mode
 * viewers (they render locally, timed to the sharer's clock — R3).
 *
 * The channel's message limit is 64 KiB, so everything big travels in
 * chunks whose `data` string is at most 48 KiB AS ENCODED IN JSON (headroom
 * for the envelope):
 *
 *   track  → JSON text → chunkPayload('track:<id>', json)  → PayloadChunk[]
 *   font   → bytes → base64 in 36 KiB raw slices (= 48 KiB base64)
 *            → PayloadChunk[] keyed 'font:<sha256>'; the manifest entry
 *            (name, size, sha256, chunk count) goes first so a viewer can
 *            skip fonts it already has and verify what it assembled.
 *
 * Pure (no DOM): Web Crypto + atob/btoa exist in browsers and Node ≥ 18.
 */
import { z } from 'zod';
import type { Cue } from '../media/subtitleText';

type SerializedSubtitleTrack = {
  id: string;
  label: string;
  language?: string;
  kind: 'ass' | 'text';
  /** kind 'ass': the full script. */
  script?: string;
  /** kind 'text': cues in seconds. */
  cues?: Cue[];
};

type FontManifestEntry = { name: string; size: number; sha256: string; chunks: number };

type PayloadChunk = { key: string; index: number; count: number; data: string };

/** Max characters of chunk `data`, measured as JSON-encoded bytes. */
const MAX_CHUNK_BYTES = 48 * 1024;
/** Raw font bytes per chunk: base64 makes 4 chars of 3 bytes → 48 KiB. */
const FONT_CHUNK_BYTES = (MAX_CHUNK_BYTES / 4) * 3;

const cueSchema = z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string().max(10_000) });

const serializedTrackSchema = z
  .object({
    id: z.string().min(1).max(200),
    label: z.string().max(300),
    language: z.string().max(40).optional(),
    kind: z.enum(['ass', 'text']),
    script: z.string().max(20 * 1024 * 1024).optional(),
    cues: z.array(cueSchema).max(100_000).optional(),
  })
  .refine((track) => (track.kind === 'ass' ? typeof track.script === 'string' : Array.isArray(track.cues)), {
    message: 'an ass track needs script, a text track needs cues',
  });

const fontManifestSchema = z.array(
  z.object({
    name: z.string().min(1).max(300),
    size: z.number().int().nonnegative().max(64 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    chunks: z.number().int().positive().max(10_000),
  }),
);

const payloadChunkSchema = z
  .object({
    key: z.string().min(1).max(300),
    index: z.number().int().nonnegative(),
    count: z.number().int().positive().max(10_000),
    data: z.string().max(MAX_CHUNK_BYTES),
  })
  .refine((chunk) => chunk.index < chunk.count, { message: 'index out of range' });

// ── tracks ────────────────────────────────────────────────────────────────

type TrackInput = {
  id: string;
  label: string;
  language?: string;
  content: { kind: 'ass'; script: string } | { kind: 'text'; cues: readonly Cue[] };
};

function serializeTrack(input: TrackInput): SerializedSubtitleTrack {
  const base = { id: input.id, label: input.label, ...(input.language ? { language: input.language } : {}) };
  if (input.content.kind === 'ass') return { ...base, kind: 'ass', script: input.content.script };
  // Rounded to ms: smaller JSON, no float noise.
  const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;
  return { ...base, kind: 'text', cues: input.content.cues.map((cue) => ({ start: ms(cue.start), end: ms(cue.end), text: cue.text })) };
}

/** Validates an untrusted track (from a peer); null when malformed. */
function parseSerializedTrack(value: unknown): SerializedSubtitleTrack | null {
  const result = serializedTrackSchema.safeParse(value);
  return result.success ? result.data : null;
}

// ── chunking any text payload ────────────────────────────────────────────

/** Bytes a code point costs inside a JSON string (escapes included). */
function jsonCost(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2; // \" \\
  if (codePoint < 0x20) return [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(codePoint) ? 2 : 6; // \n or \u00XX
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6; // lone surrogate: \uXXXX
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Splits text into pieces whose JSON-encoded size is ≤ maxBytes, never
 *  inside a code point. `pieces.join('') === text`. */
function splitPayload(text: string, maxBytes = MAX_CHUNK_BYTES): string[] {
  if (maxBytes < 6) throw new RangeError('maxBytes must be ≥ 6');
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index)!;
    const units = codePoint > 0xffff ? 2 : 1;
    const cost = jsonCost(codePoint);
    if (bytes + cost > maxBytes) {
      pieces.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += cost;
    index += units;
  }
  if (start < text.length || pieces.length === 0) pieces.push(text.slice(start));
  return pieces;
}

function chunkPayload(key: string, text: string, maxBytes = MAX_CHUNK_BYTES): PayloadChunk[] {
  const pieces = splitPayload(text, maxBytes);
  return pieces.map((data, index) => ({ key, index, count: pieces.length, data }));
}

/** A track as ready-to-send chunks (each fits one data-channel message). */
function trackChunks(track: SerializedSubtitleTrack, maxBytes = MAX_CHUNK_BYTES): PayloadChunk[] {
  return chunkPayload(`track:${track.id}`, JSON.stringify(track), maxBytes);
}

/**
 * Collects chunks (any order, duplicates ignored) and returns the whole
 * payload when its last missing chunk arrives. Keeps at most `maxPending`
 * partial payloads (oldest dropped) so a misbehaving peer cannot grow it.
 */
function createChunkAssembler(options: { maxPending?: number } = {}) {
  const maxPending = options.maxPending ?? 64;
  const pending = new Map<string, { count: number; parts: (string | undefined)[]; received: number }>();
  return {
    add(chunk: PayloadChunk): string | null {
      let entry = pending.get(chunk.key);
      if (entry && entry.count !== chunk.count) {
        pending.delete(chunk.key); // restarted with a different split
        entry = undefined;
      }
      if (!entry) {
        if (pending.size >= maxPending) pending.delete(pending.keys().next().value!);
        entry = { count: chunk.count, parts: new Array(chunk.count), received: 0 };
        pending.set(chunk.key, entry);
      }
      if (chunk.index >= entry.count || entry.parts[chunk.index] !== undefined) return null;
      entry.parts[chunk.index] = chunk.data;
      entry.received += 1;
      if (entry.received < entry.count) return null;
      pending.delete(chunk.key);
      return entry.parts.join('');
    },
    /** Fraction received for a key (0 when unknown). */
    progress(key: string): number {
      const entry = pending.get(key);
      return entry ? entry.received / entry.count : 0;
    },
    clear() {
      pending.clear();
    },
  };
}

// ── fonts ─────────────────────────────────────────────────────────────────

const asBytes = (data: ArrayBuffer | Uint8Array): Uint8Array => (data instanceof Uint8Array ? data : new Uint8Array(data));

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = asBytes(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000; // String.fromCharCode argument limit stays far away
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A font as base64 strings of ≤ 48 KiB each (36 KiB raw per chunk). */
function chunkFont(data: ArrayBuffer | Uint8Array, chunkBytes = FONT_CHUNK_BYTES): string[] {
  if (chunkBytes % 3 !== 0) throw new RangeError('chunkBytes must be a multiple of 3 (no base64 padding mid-stream)');
  const bytes = asBytes(data);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) chunks.push(toBase64(bytes.subarray(offset, offset + chunkBytes)));
  return chunks.length > 0 ? chunks : [''];
}

/** Inverse of `chunkFont`. */
function assembleFont(chunks: readonly string[]): Uint8Array {
  const parts = chunks.map(fromBase64);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function fontManifest(fonts: readonly { name: string; data: ArrayBuffer | Uint8Array }[]): Promise<FontManifestEntry[]> {
  return Promise.all(
    fonts.map(async (font) => {
      const size = asBytes(font.data).byteLength;
      return { name: font.name, size, sha256: await sha256Hex(font.data), chunks: Math.max(1, Math.ceil(size / FONT_CHUNK_BYTES)) };
    }),
  );
}

/** One font as ready-to-send chunks, keyed by its hash. */
function fontChunks(entry: Pick<FontManifestEntry, 'sha256'>, data: ArrayBuffer | Uint8Array): PayloadChunk[] {
  const pieces = chunkFont(data);
  return pieces.map((piece, index) => ({ key: `font:${entry.sha256}`, index, count: pieces.length, data: piece }));
}

/** Assembled base64 (from `createChunkAssembler`) → bytes, verified against
 *  the manifest; null if the size or hash does not match. */
async function verifiedFont(entry: FontManifestEntry, base64: string): Promise<Uint8Array | null> {
  const bytes = fromBase64(base64);
  if (bytes.byteLength !== entry.size) return null;
  return (await sha256Hex(bytes)) === entry.sha256 ? bytes : null;
}

export {
  assembleFont,
  chunkFont,
  chunkPayload,
  createChunkAssembler,
  FONT_CHUNK_BYTES,
  fontChunks,
  fontManifest,
  fontManifestSchema,
  fromBase64,
  MAX_CHUNK_BYTES,
  parseSerializedTrack,
  payloadChunkSchema,
  serializedTrackSchema,
  serializeTrack,
  sha256Hex,
  splitPayload,
  toBase64,
  trackChunks,
  verifiedFont,
};
export type { FontManifestEntry, PayloadChunk, SerializedSubtitleTrack, TrackInput };
