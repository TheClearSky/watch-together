import { describe, expect, it } from 'vitest';
import { ClockEstimate, clockSample } from '../sync/clockSync';
import { decideCorrection, expectedPosition } from '../sync/driftController';

describe('clock sync', () => {
  it('reproduces the plan dry run', () => {
    expect(clockSample(10_000, 52_040, 10_080)).toEqual({ offset: 42_000, rtt: 80, at: 10_080 });
  });

  it('trusts the lowest-RTT sample, not an average', () => {
    const clock = new ClockEstimate();
    clock.add(clockSample(0, 42_400, 600)); // slow leg: offset 42 100, rtt 600
    clock.add(clockSample(1_000, 43_020, 1_040)); // fast: offset 42 000, rtt 40
    clock.add(clockSample(2_000, 44_300, 2_400)); // offset 42 100, rtt 400
    expect(clock.best?.rtt).toBe(40);
    expect(clock.remoteNow(10_600)).toBe(52_600);
  });

  it('ignores impossible samples and forgets old ones', () => {
    const clock = new ClockEstimate(2);
    clock.add(clockSample(100, 5, 50)); // negative rtt
    expect(clock.sampleCount).toBe(0);
    clock.add(clockSample(0, 100, 10));
    clock.add(clockSample(0, 100, 200));
    clock.add(clockSample(0, 100, 300));
    expect(clock.sampleCount).toBe(2);
    expect(clock.best?.rtt).toBe(200);
  });
});

describe('drift controller', () => {
  const sharer = { playing: true, t: 600, at: 52_500, rate: 1 };

  it('reproduces the plan dry run: −0.4 s behind → play 5% faster', () => {
    expect(expectedPosition(sharer, 52_600)).toBeCloseTo(600.1, 6);
    const correction = decideCorrection({ sharer, remoteNow: 52_600, position: 599.7, playing: true });
    expect(correction.kind).toBe('nudge');
    if (correction.kind === 'nudge') {
      expect(correction.drift).toBeCloseTo(-0.4, 6);
      expect(correction.playbackRate).toBeCloseTo(1.05, 6);
    }
  });

  it('ahead → play slower; the nudge is proportional below the cap', () => {
    const ahead = decideCorrection({ sharer, remoteNow: 52_600, position: 600.4, playing: true });
    expect(ahead).toMatchObject({ kind: 'nudge', playbackRate: 0.95 });
    const small = decideCorrection({ sharer, remoteNow: 52_600, position: 599.98, playing: true });
    expect(small.kind).toBe('nudge'); // −0.12 s
    if (small.kind === 'nudge') expect(small.playbackRate).toBeCloseTo(1.03, 6);
  });

  it('hysteresis: start above 0.10 s, stop only at 0.04 s', () => {
    const drift = (position: number, nudging: boolean) =>
      decideCorrection({ sharer, remoteNow: 52_600, position, playing: true, nudging }).kind;
    expect(drift(600.03, false)).toBe('none'); // 0.07 s, not nudging yet
    expect(drift(600.03, true)).toBe('nudge'); // 0.07 s while nudging: keep going
    expect(drift(600.13, true)).toBe('none'); // 0.03 s: settled
  });

  it('no second seek inside the cooldown', () => {
    const base = { sharer, remoteNow: 52_600, position: 590, playing: true, lastSeekAt: 1_000 };
    expect(decideCorrection({ ...base, localNow: 2_500 }).kind).toBe('nudge');
    expect(decideCorrection({ ...base, localNow: 3_100 }).kind).toBe('seek');
  });

  it('more than a second off → seek, with the seek-lead added', () => {
    const correction = decideCorrection({ sharer, remoteNow: 52_600, position: 590, playing: true });
    expect(correction).toMatchObject({ kind: 'seek' });
    if (correction.kind === 'seek') expect(correction.to).toBeCloseTo(600.25, 6);
  });

  it('follows the sharer into pause, frame-exact', () => {
    const paused = { playing: false, t: 612.3, at: 60_000, rate: 1 };
    expect(decideCorrection({ sharer: paused, remoteNow: 99_999, position: 615, playing: true })).toEqual({
      kind: 'pause',
      to: 612.3,
    });
    expect(decideCorrection({ sharer: paused, remoteNow: 99_999, position: 612.31, playing: false }).kind).toBe('none');
  });

  it('starts playing when the sharer does', () => {
    const correction = decideCorrection({ sharer, remoteNow: 52_600, position: 600.1, playing: false });
    expect(correction.kind).toBe('play');
  });

  it('respects the sharer playback rate and the media bounds', () => {
    const fast = { playing: true, t: 10, at: 0, rate: 2 };
    expect(expectedPosition(fast, 1_000)).toBe(12);
    const nudge = decideCorrection({ sharer: fast, remoteNow: 1_000, position: 11.8, playing: true });
    expect(nudge.kind).toBe('nudge');
    if (nudge.kind === 'nudge') expect(nudge.playbackRate).toBeCloseTo(2.1, 9);
    const end = decideCorrection({ sharer, remoteNow: 52_600, position: 10, playing: true, duration: 300 });
    if (end.kind === 'seek') expect(end.to).toBe(300);
  });
});
