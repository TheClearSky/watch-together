/**
 * A damped spring, stepped by the caller's animation frame. Semi-implicit
 * Euler with a clamped time step, so a background tab coming back (a huge
 * `dt`) never flings Pop across the screen.
 */

type Spring = { value: number; velocity: number; target: number };

const MAX_DT = 1 / 30;

function spring(value: number): Spring {
  return { value, velocity: 0, target: value };
}

function stepSpring(s: Spring, dtSeconds: number, stiffness = 170, damping = 22): void {
  let remaining = Math.max(0, dtSeconds);
  while (remaining > 0) {
    const dt = Math.min(remaining, MAX_DT);
    const acceleration = stiffness * (s.target - s.value) - damping * s.velocity;
    s.velocity += acceleration * dt;
    s.value += s.velocity * dt;
    remaining -= dt;
  }
}

function snapSpring(s: Spring, value = s.target): void {
  s.value = value;
  s.target = value;
  s.velocity = 0;
}

function isSettled(s: Spring, epsilon = 0.05): boolean {
  return Math.abs(s.target - s.value) < epsilon && Math.abs(s.velocity) < epsilon;
}

export { isSettled, snapSpring, spring, stepSpring };
export type { Spring };
