/**
 * Local-copy mode: keep OUR `<video>` (playing our own file) in step with the
 * sharer's. Pure: given the sharer's last state, the clock offset and our
 * player's position, decide one correction. The caller applies it.
 *
 * Small drift is corrected by playing slightly faster or slower, which is
 * inaudible; only a large drift seeks, because a seek re-buffers and
 * stutters. Thresholds follow research/2026-10-01/R2 (R12, from Syncplay,
 * Jellyfin SyncPlay, movienight and watchparty): ignore ≤ 0.10 s (and once
 * nudging, keep going until ≤ 0.04 s — hysteresis, so the rate does not
 * flap at the edge), nudge proportionally up to ±5 % below 1 s, seek above,
 * then hold off seeking again for 2 s while the seek lands.
 *
 * Dry run (plan §7): sharer {playing, t: 600.000, at: 52 500, rate 1};
 * our now 10 600 + offset 42 000 = sharer-now 52 600 → expected 600.100;
 * our position 599.700 → drift −0.400 s → within (0.10, 1.0] → nudge
 * clamp(−0.4 / 4, ±0.05) = −0.05 → rate 1.05; as the drift shrinks the nudge
 * shrinks with it (−0.2 s → 1.05, −0.1 s → 1.025) until ≤ 0.04 s.
 */

type SharerState = {
  playing: boolean;
  /** Media time (s) at the sharer's clock `at` (ms). */
  t: number;
  at: number;
  rate: number;
};

type DriftTuning = {
  /** Start correcting above this |drift| (s). */
  inSync: number;
  /** While already nudging, stop only at or below this |drift| (s). */
  settle: number;
  /** |drift| above this seeks instead of nudging (s). */
  seekAbove: number;
  /** The nudge is drift / `nudgeDivisor`, capped at `maxNudge`. */
  nudgeDivisor: number;
  maxNudge: number;
  /** Added to a seek target: the time a seek itself takes to land (s). */
  seekLead: number;
  /** No second seek within this long of the last one (ms). */
  seekCooldownMs: number;
};

const DEFAULT_TUNING: DriftTuning = {
  inSync: 0.1,
  settle: 0.04,
  seekAbove: 1.0,
  nudgeDivisor: 4,
  maxNudge: 0.05,
  seekLead: 0.15,
  seekCooldownMs: 2000,
};

type Correction =
  | { kind: 'none'; drift: number; playbackRate: number }
  | { kind: 'nudge'; drift: number; playbackRate: number }
  | { kind: 'seek'; drift: number; to: number; playbackRate: number }
  | { kind: 'pause'; to: number }
  | { kind: 'play'; to: number; playbackRate: number };

/** Where the sharer's playhead is at sharer-time `remoteNow` (ms). */
function expectedPosition(state: SharerState, remoteNow: number): number {
  if (!state.playing) return state.t;
  return state.t + ((remoteNow - state.at) / 1000) * state.rate;
}

function decideCorrection(input: {
  sharer: SharerState;
  /** Sharer's clock now (ms), from `ClockEstimate.remoteNow`. */
  remoteNow: number;
  /** Our `<video>`: position (s) and whether it is playing. */
  position: number;
  playing: boolean;
  /** Clamp targets into the media (s); `Infinity` when unknown. */
  duration?: number;
  /** We are currently playing at a nudged rate (hysteresis). */
  nudging?: boolean;
  /** Our clock (ms) of the last seek we made, for the cooldown. */
  lastSeekAt?: number;
  localNow?: number;
  tuning?: Partial<DriftTuning>;
}): Correction {
  const tuning = { ...DEFAULT_TUNING, ...input.tuning };
  const { sharer } = input;
  const duration = input.duration ?? Infinity;
  const clamp = (time: number) => Math.min(Math.max(time, 0), duration);
  const expected = clamp(expectedPosition(sharer, input.remoteNow));

  if (!sharer.playing) {
    // Paused: stop exactly where the sharer stopped (a frame-accurate pause
    // is what people notice).
    if (input.playing || Math.abs(input.position - expected) > tuning.inSync) {
      return { kind: 'pause', to: expected };
    }
    return { kind: 'none', drift: input.position - expected, playbackRate: sharer.rate };
  }

  if (!input.playing) {
    return { kind: 'play', to: clamp(expected + tuning.seekLead), playbackRate: sharer.rate };
  }

  const drift = input.position - expected; // negative = we are behind
  const magnitude = Math.abs(drift);
  const coolingDown =
    input.lastSeekAt !== undefined &&
    input.localNow !== undefined &&
    input.localNow - input.lastSeekAt < tuning.seekCooldownMs;
  if (magnitude > tuning.seekAbove && !coolingDown) {
    return { kind: 'seek', drift, to: clamp(expected + tuning.seekLead), playbackRate: sharer.rate };
  }
  const threshold = input.nudging ? tuning.settle : tuning.inSync;
  if (magnitude > threshold) {
    const nudge = Math.max(-tuning.maxNudge, Math.min(tuning.maxNudge, drift / tuning.nudgeDivisor));
    return { kind: 'nudge', drift, playbackRate: sharer.rate * (1 - nudge) };
  }
  return { kind: 'none', drift, playbackRate: sharer.rate };
}

export { DEFAULT_TUNING, decideCorrection, expectedPosition };
export type { Correction, DriftTuning, SharerState };
