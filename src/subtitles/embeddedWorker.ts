/**
 * Worker entry: scans a disk-backed File for embedded subtitles, streaming
 * results to the page (protocol.ts). The File is read in 8 MiB slices by
 * `blobSource` — never loaded whole. The page cancels by terminating us.
 */
import { blobSource, scanMatroska } from '../media/matroskaSubtitles';
import type { SubtitleTrack } from '../media/matroskaSubtitles';
import { createEventBatcher, createProgressThrottle, fontMessage, isEbmlMagic, isFontAttachment } from './protocol';
import type { WorkerMessage, WorkerRequest } from './protocol';

/** The worker global, typed minimally (the project's lib is DOM, and DOM +
 *  WebWorker libs conflict when combined). */
declare const self: {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
};

const post = (message: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(message, transfer);

/** Thrown from `onTracks` to stop a scan that cannot find anything. */
class NoSubtitleTracks extends Error {}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  if (event.data?.type !== 'start') return;
  const { file, windowBytes } = event.data;
  const started = performance.now();
  let tracks: SubtitleTrack[] = [];
  let eventCount = 0;
  let fontCount = 0;
  const summary = (matroska: boolean, stoppedEarly: boolean) => ({
    matroska,
    tracks: tracks.length,
    events: eventCount,
    fonts: fontCount,
    elapsedMs: performance.now() - started,
    stoppedEarly,
  });

  try {
    if (!isEbmlMagic(new Uint8Array(await file.slice(0, 4).arrayBuffer()))) {
      post({ type: 'done', summary: summary(false, false) });
      return;
    }
    const batcher = createEventBatcher({ send: (events) => post({ type: 'events', events }) });
    const progress = createProgressThrottle((fraction) => post({ type: 'progress', fraction }));
    try {
      await scanMatroska(
        blobSource(file),
        {
          onTracks(found) {
            tracks = found;
            post({ type: 'tracks', tracks: found });
            if (found.length === 0) throw new NoSubtitleTracks();
          },
          onAttachment(attachment) {
            if (!isFontAttachment(attachment)) return;
            fontCount += 1;
            const { message, transfer } = fontMessage(attachment);
            post(message, transfer);
          },
          onEvent(subtitle) {
            eventCount += 1;
            batcher.push(subtitle);
          },
          onProgress(fraction) {
            batcher.tick();
            progress(fraction);
          },
        },
        { windowBytes },
      );
    } catch (error) {
      if (!(error instanceof NoSubtitleTracks)) throw error;
      progress(1);
      post({ type: 'done', summary: summary(true, true) });
      return;
    }
    batcher.flush();
    post({ type: 'done', summary: summary(true, false) });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
