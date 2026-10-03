/**
 * The extraction worker's message protocol, and the pure logic on both sides
 * of it (so it is tested without a Worker):
 *
 *   main ──{start, file}──► worker: scanMatroska(blobSource(file))
 *   main ◄──tracks──────── (once, first ~8 MiB: Tracks precede Clusters)
 *   main ◄──font×N──────── (font attachments, ArrayBuffer TRANSFERRED)
 *   main ◄──events×M────── (batched: ≤ BATCH_MAX_EVENTS or every BATCH_MS)
 *   main ◄──progress────── (fraction 0..1, ≥ 1 % steps)
 *   main ◄──done | error── (terminal)
 *
 * Cancelling = `worker.terminate()`; no message is needed.
 */
import type { Attachment, SubtitleEvent, SubtitleTrack } from '../media/matroskaSubtitles';

type EmbeddedFont = { name: string; mimeType: string; data: ArrayBuffer };

type ExtractionSummary = {
  /** False when the file is not Matroska/WebM (nothing was scanned). */
  matroska: boolean;
  tracks: number;
  events: number;
  fonts: number;
  /** Wall time inside the worker, ms. */
  elapsedMs: number;
  /** True when the scan stopped early because the file has no subtitle tracks. */
  stoppedEarly: boolean;
};

type WorkerRequest = { type: 'start'; file: Blob; windowBytes?: number };

type WorkerMessage =
  | { type: 'tracks'; tracks: SubtitleTrack[] }
  | { type: 'font'; font: EmbeddedFont }
  | { type: 'events'; events: SubtitleEvent[] }
  | { type: 'progress'; fraction: number }
  | { type: 'done'; summary: ExtractionSummary }
  | { type: 'error'; message: string };

const BATCH_MAX_EVENTS = 400;
const BATCH_MS = 250;

const FONT_EXTENSIONS = /\.(ttf|otf|ttc|otc|woff2?|pfb|pfa)$/i;

/** True for attachments libass can use as fonts (by MIME type or name). */
function isFontAttachment(attachment: Pick<Attachment, 'name' | 'mimeType'>): boolean {
  const mime = attachment.mimeType.toLowerCase();
  return (
    mime.startsWith('font/') ||
    mime.includes('truetype') ||
    mime.includes('opentype') ||
    mime.includes('font-') ||
    mime === 'application/x-font' ||
    FONT_EXTENSIONS.test(attachment.name)
  );
}

/** An attachment's bytes as a standalone ArrayBuffer (safe to transfer). */
function fontMessage(attachment: Attachment): { message: WorkerMessage; transfer: ArrayBuffer[] } {
  const { data } = attachment;
  const exact =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer
      ? data.buffer
      : (data.slice().buffer as ArrayBuffer);
  return {
    message: { type: 'font', font: { name: attachment.name, mimeType: attachment.mimeType, data: exact } },
    transfer: [exact],
  };
}

/**
 * Collects events and hands them out in batches: when `maxEvents` are
 * waiting, or when `maxMs` passed since the last flush (checked on push), or
 * on `flush()`. Time is injected for tests.
 */
function createEventBatcher(options: {
  send(events: SubtitleEvent[]): void;
  now?: () => number;
  maxEvents?: number;
  maxMs?: number;
}) {
  const now = options.now ?? (() => performance.now());
  const maxEvents = options.maxEvents ?? BATCH_MAX_EVENTS;
  const maxMs = options.maxMs ?? BATCH_MS;
  let pending: SubtitleEvent[] = [];
  let lastFlush = now();
  const flush = () => {
    lastFlush = now();
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    options.send(batch);
  };
  return {
    push(event: SubtitleEvent) {
      pending.push(event);
      if (pending.length >= maxEvents || now() - lastFlush >= maxMs) flush();
    },
    /** Also call on progress ticks so a slow trickle still arrives. */
    tick() {
      if (now() - lastFlush >= maxMs) flush();
    },
    flush,
    get pending() {
      return pending.length;
    },
  };
}

/** Throttles progress to ≥ `step` increments (and always reports 1). */
function createProgressThrottle(send: (fraction: number) => void, step = 0.01) {
  let last = -Infinity;
  return (fraction: number) => {
    if (fraction >= 1 || fraction - last >= step) {
      last = fraction;
      send(Math.min(1, fraction));
    }
  };
}

/** The 4-byte EBML magic every Matroska/WebM file starts with. */
function isEbmlMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

// ── main-thread state, built from worker messages ─────────────────────────

type ExtractionStatus = 'idle' | 'scanning' | 'done' | 'error' | 'none';

type ExtractionState = {
  status: ExtractionStatus;
  progress: number;
  tracks: SubtitleTrack[];
  fonts: EmbeddedFont[];
  /** Per track number, in arrival order (sorted when a script is built). */
  events: Map<number, SubtitleEvent[]>;
  error: string | null;
  summary: ExtractionSummary | null;
  /** Bumps whenever events, tracks or fonts change: cache key for derived data. */
  revision: number;
};

function initialExtractionState(): ExtractionState {
  return { status: 'idle', progress: 0, tracks: [], fonts: [], events: new Map(), error: null, summary: null, revision: 0 };
}

/**
 * Applies one worker message. PURE — React may call a state updater twice
 * (StrictMode does, in dev), so nothing is mutated: only the event lists of
 * the tracks in a batch are copied (one batch touches few tracks).
 */
function applyWorkerMessage(state: ExtractionState, message: WorkerMessage): ExtractionState {
  switch (message.type) {
    case 'tracks': {
      const events = new Map(state.events);
      for (const track of message.tracks) if (!events.has(track.number)) events.set(track.number, []);
      return { ...state, status: 'scanning', tracks: message.tracks, events, revision: state.revision + 1 };
    }
    case 'font':
      return { ...state, fonts: [...state.fonts, message.font], revision: state.revision + 1 };
    case 'events': {
      const byTrack = new Map<number, SubtitleEvent[]>();
      for (const event of message.events) {
        const list = byTrack.get(event.track);
        if (list) list.push(event);
        else byTrack.set(event.track, [event]);
      }
      const events = new Map(state.events);
      for (const [track, added] of byTrack) events.set(track, [...(events.get(track) ?? []), ...added]);
      return { ...state, events, revision: state.revision + 1 };
    }
    case 'progress':
      return { ...state, progress: message.fraction };
    case 'done':
      return {
        ...state,
        status: message.summary.tracks > 0 ? 'done' : 'none',
        progress: 1,
        summary: message.summary,
        revision: state.revision + 1,
      };
    case 'error':
      return { ...state, status: 'error', error: message.message };
  }
}

/** A human label for a track: `name · language`, else `Track N`. */
function trackLabel(track: Pick<SubtitleTrack, 'number' | 'name' | 'language'>): string {
  const parts = [track.name, track.language].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(' · ') : `Track ${track.number}`;
}

export {
  applyWorkerMessage,
  BATCH_MAX_EVENTS,
  BATCH_MS,
  createEventBatcher,
  createProgressThrottle,
  fontMessage,
  initialExtractionState,
  isEbmlMagic,
  isFontAttachment,
  trackLabel,
};
export type { EmbeddedFont, ExtractionState, ExtractionStatus, ExtractionSummary, WorkerMessage, WorkerRequest };
