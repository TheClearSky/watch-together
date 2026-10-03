/**
 * Local-copy mode: keep MY `<video>` (my own identical file) in step with the
 * sharer, four times a second, using the measured clock offset and the
 * sharer's last state (driftController.ts, thresholds from research R12).
 */
import { useEffect, useRef } from 'react';
import type { ClockEstimate } from '../sync/clockSync';
import { decideCorrection } from '../sync/driftController';
import type { Playback } from './protocol';

const TICK_MS = 250;

function useLocalSync(input: {
  element: HTMLVideoElement | null;
  state: Playback | null;
  clock: ClockEstimate;
  enabled: boolean;
}): void {
  const latest = useRef(input);
  latest.current = input;
  const nudging = useRef(false);
  const lastSeekAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!input.enabled) return;
    const timer = window.setInterval(() => {
      const { element, state, clock } = latest.current;
      if (!element || !state || element.readyState < 1) return;
      const remoteNow = clock.remoteNow(Date.now()) ?? state.at; // no sample yet: assume no drift since `at`
      const correction = decideCorrection({
        sharer: state,
        remoteNow,
        position: element.currentTime,
        playing: !element.paused,
        duration: Number.isFinite(element.duration) ? element.duration : undefined,
        nudging: nudging.current,
        lastSeekAt: lastSeekAt.current,
        localNow: Date.now(),
      });
      switch (correction.kind) {
        case 'pause':
          element.pause();
          element.currentTime = correction.to;
          nudging.current = false;
          break;
        case 'play':
          element.currentTime = correction.to;
          element.playbackRate = correction.playbackRate;
          void element.play().catch(() => {});
          break;
        case 'seek':
          element.currentTime = correction.to;
          element.playbackRate = correction.playbackRate;
          lastSeekAt.current = Date.now();
          nudging.current = false;
          break;
        case 'nudge':
          element.playbackRate = correction.playbackRate;
          nudging.current = true;
          break;
        case 'none':
          if (element.playbackRate !== correction.playbackRate) element.playbackRate = correction.playbackRate;
          nudging.current = false;
          break;
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [input.enabled]);
}

export { useLocalSync };
