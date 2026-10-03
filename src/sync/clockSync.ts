/**
 * How far the sharer's clock is from ours, from ping/pong round trips
 * (NTP's idea, simplified): we send `t0` (our clock), the sharer answers with
 * `t1` (theirs), we receive at `t2` (ours). Assuming the two legs take equal
 * time, the sharer's clock read `t1` at our `t0 + rtt / 2`, so
 *
 *   offset = t1 − (t0 + rtt / 2)        sharerNow = ourNow + offset
 *
 * The leg-symmetry assumption is wrong by up to half the RTT, so the sample
 * with the SMALLEST round trip is the most trustworthy — we keep that one
 * among the recent samples rather than averaging in noisy ones.
 *
 * Dry run (plan §7): t0 = 10 000, t1 = 52 040, t2 = 10 080
 *   → rtt = 80, offset = 52 040 − 10 040 = 42 000.
 */

type ClockSample = { offset: number; rtt: number; at: number };

/** One round trip → one sample. `null` for an impossible one (clock went
 *  backwards, or a reply to a ping we never sent). */
function clockSample(t0: number, t1: number, t2: number): ClockSample | null {
  const rtt = t2 - t0;
  if (!Number.isFinite(rtt) || rtt < 0) return null;
  return { offset: t1 - (t0 + rtt / 2), rtt, at: t2 };
}

class ClockEstimate {
  private samples: ClockSample[] = [];

  constructor(
    /** How many recent samples compete for "best". */
    private readonly window = 8,
  ) {}

  add(sample: ClockSample | null): void {
    if (!sample) return;
    this.samples = [...this.samples, sample].slice(-this.window);
  }

  /** The best (lowest-RTT) recent sample, or `null` before the first. */
  get best(): ClockSample | null {
    let best: ClockSample | null = null;
    for (const sample of this.samples) if (best === null || sample.rtt < best.rtt) best = sample;
    return best;
  }

  /** The sharer's clock now, given ours; `null` until a sample exists. */
  remoteNow(localNow: number): number | null {
    const best = this.best;
    return best === null ? null : localNow + best.offset;
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

export { ClockEstimate, clockSample };
export type { ClockSample };
