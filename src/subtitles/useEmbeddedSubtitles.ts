/**
 * React side of embedded-subtitle extraction: one scan per File, cancelled
 * when the file changes or the component unmounts. Tracks show up within the
 * first read window; `getTrack(n)` returns what has arrived SO FAR (an ASS
 * track's script grows while the scan runs — `revision` changes with it).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubtitleTrack } from '../media/matroskaSubtitles';
import type { Cue } from '../media/subtitleText';
import { buildAssScript, eventsToCues } from './assScript';
import { extractEmbeddedSubtitles } from './embedded';
import { applyWorkerMessage, initialExtractionState, trackLabel } from './protocol';
import type { EmbeddedFont, ExtractionState, ExtractionStatus, ExtractionSummary } from './protocol';

type EmbeddedTrack = SubtitleTrack & {
  /** `embedded:<number>` — stable for a file. */
  id: string;
  label: string;
  kind: 'ass' | 'text';
  /** Events received so far. */
  eventCount: number;
};

type EmbeddedTrackContent = { kind: 'ass'; script: string } | { kind: 'text'; cues: Cue[] };

type EmbeddedSubtitles = {
  status: ExtractionStatus;
  /** Fraction of the file scanned, 0..1. */
  progress: number;
  tracks: EmbeddedTrack[];
  fonts: EmbeddedFont[];
  error: string | null;
  summary: ExtractionSummary | null;
  /** Changes whenever more events, tracks or fonts arrived. */
  revision: number;
  /** The track's content so far (memoized per revision); null if unknown or
   *  unsupported (bitmap codecs). */
  getTrack(number: number): EmbeddedTrackContent | null;
};

function kindOf(track: SubtitleTrack): 'ass' | 'text' | null {
  if (track.codec === 'ass' || track.codec === 'ssa') return 'ass';
  if (track.codec === 'srt' || track.codec === 'vtt') return 'text';
  return null;
}

/** Content of one track from the reducer state (pure; exported for tests). */
function trackContent(state: Pick<ExtractionState, 'tracks' | 'events'>, number: number): EmbeddedTrackContent | null {
  const track = state.tracks.find((candidate) => candidate.number === number);
  if (!track) return null;
  const kind = kindOf(track);
  const events = state.events.get(number) ?? [];
  if (kind === 'ass') return { kind, script: buildAssScript(track, events) };
  if (kind === 'text') return { kind, cues: eventsToCues(events) };
  return null;
}

function useEmbeddedSubtitles(file: File | null, options: { enabled?: boolean } = {}): EmbeddedSubtitles {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<ExtractionState>(initialExtractionState);
  const cache = useRef(new Map<number, { revision: number; content: EmbeddedTrackContent | null }>());

  useEffect(() => {
    cache.current = new Map();
    setState(initialExtractionState());
    if (!file || !enabled) return;
    const controller = new AbortController();
    setState((current) => ({ ...current, status: 'scanning' }));
    extractEmbeddedSubtitles(file, {
      signal: controller.signal,
      onMessage: (message) => setState((current) => applyWorkerMessage(current, message)),
    })
      .then((summary) => {
        // A non-Matroska file never starts a worker, so no 'done' message came.
        if (!summary.matroska) setState((current) => ({ ...current, status: 'none', progress: 1, summary }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) }));
      });
    return () => controller.abort();
  }, [file, enabled]);

  const tracks = useMemo<EmbeddedTrack[]>(
    () =>
      state.tracks.flatMap((track) => {
        const kind = kindOf(track);
        if (!kind) return [];
        return [{ ...track, id: `embedded:${track.number}`, label: trackLabel(track), kind, eventCount: state.events.get(track.number)?.length ?? 0 }];
      }),
    [state.tracks, state.events],
  );

  const stateRef = useRef(state);
  stateRef.current = state;
  const getTrack = useCallback(
    (number: number) => {
      const current = stateRef.current;
      const hit = cache.current.get(number);
      if (hit && hit.revision === current.revision) return hit.content;
      const content = trackContent(current, number);
      cache.current.set(number, { revision: current.revision, content });
      return content;
    },
    // A new function per revision, so consumers' memos/effects re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.revision],
  );

  return {
    status: state.status,
    progress: state.progress,
    tracks,
    fonts: state.fonts,
    error: state.error,
    summary: state.summary,
    revision: state.revision,
    getTrack,
  };
}

export { trackContent, useEmbeddedSubtitles };
export type { EmbeddedSubtitles, EmbeddedTrack, EmbeddedTrackContent };
