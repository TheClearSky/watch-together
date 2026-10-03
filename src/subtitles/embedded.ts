/**
 * Embedded subtitles out of a local video file, off the main thread.
 *
 * `extractEmbeddedSubtitles(file, handlers)` sniffs the first 4 bytes on the
 * page (an .mp4 never spins up a worker), then runs the Matroska scanner in a
 * Web Worker over the disk-backed File and streams results back as they are
 * found. Tracks and fonts arrive within the first read window (they precede
 * the clusters); events trickle in over a full sequential read of the file.
 * Abort with `signal` → the worker is terminated at once.
 */
import type { SubtitleEvent, SubtitleTrack } from '../media/matroskaSubtitles';
import { isEbmlMagic } from './protocol';
import type { EmbeddedFont, ExtractionSummary, WorkerMessage, WorkerRequest } from './protocol';

type ExtractHandlers = {
  onTracks?(tracks: SubtitleTrack[]): void;
  onFont?(font: EmbeddedFont): void;
  onEvents?(events: SubtitleEvent[]): void;
  onProgress?(fraction: number): void;
  /** Every raw protocol message (the hook reduces these). */
  onMessage?(message: WorkerMessage): void;
  signal?: AbortSignal;
  /** Read window; tests and tuning only. */
  windowBytes?: number;
};

const NOT_MATROSKA: ExtractionSummary = { matroska: false, tracks: 0, events: 0, fonts: 0, elapsedMs: 0, stoppedEarly: false };

/** True when the blob starts with the EBML magic (Matroska / WebM). */
async function looksLikeMatroska(file: Blob): Promise<boolean> {
  if (file.size < 4) return false;
  return isEbmlMagic(new Uint8Array(await file.slice(0, 4).arrayBuffer()));
}

function abortError(): Error {
  return new DOMException('Subtitle extraction was cancelled.', 'AbortError');
}

/**
 * Resolves with a summary when the scan finishes; rejects on a malformed file
 * or on abort (`AbortError`). Non-Matroska files resolve immediately with
 * `{ matroska: false, tracks: 0 }`.
 */
async function extractEmbeddedSubtitles(file: Blob, handlers: ExtractHandlers = {}): Promise<ExtractionSummary> {
  const { signal } = handlers;
  if (signal?.aborted) throw abortError();
  if (!(await looksLikeMatroska(file))) return NOT_MATROSKA;
  if (signal?.aborted) throw abortError();

  const worker = new Worker(new URL('./embeddedWorker.ts', import.meta.url), { type: 'module', name: 'wt-subtitles' });
  return new Promise<ExtractionSummary>((resolve, reject) => {
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      handlers.onMessage?.(message);
      switch (message.type) {
        case 'tracks':
          handlers.onTracks?.(message.tracks);
          break;
        case 'font':
          handlers.onFont?.(message.font);
          break;
        case 'events':
          handlers.onEvents?.(message.events);
          break;
        case 'progress':
          handlers.onProgress?.(message.fraction);
          break;
        case 'done':
          finish();
          resolve(message.summary);
          break;
        case 'error':
          finish();
          reject(new Error(message.message));
          break;
      }
    });
    worker.addEventListener('error', (event) => {
      finish();
      reject(new Error(event.message || 'The subtitle worker failed to start.'));
    });
    const request: WorkerRequest = { type: 'start', file, windowBytes: handlers.windowBytes };
    worker.postMessage(request);
  });
}

export { extractEmbeddedSubtitles, looksLikeMatroska };
export type { ExtractHandlers };
