/**
 * Small per-browser preferences (volume, display name, resume positions) in
 * localStorage under one namespace. Every access is guarded: storage can be
 * refused (private windows, blocked site data), and a preference that fails
 * to persist must never break playback.
 */

const NAMESPACE = 'watch-together';

function readPreference<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const raw = localStorage.getItem(`${NAMESPACE}.${key}`);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${NAMESPACE}.${key}`, JSON.stringify(value));
  } catch {
    // Not persisted; the session keeps working.
  }
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isRecordOfNumbers = (value: unknown): value is Record<string, number> =>
  typeof value === 'object' && value !== null && Object.values(value).every(isNumber);

// ── resume positions, by path (ids of a linked folder change per scan) ──

const RESUME_KEY = 'resume';
const MAX_RESUME_ENTRIES = 200;

function resumePosition(path: string): number | null {
  const positions = readPreference(RESUME_KEY, {}, isRecordOfNumbers);
  return positions[path] ?? null;
}

/** Remember where `path` was left; near the end counts as finished. */
function rememberPosition(path: string, seconds: number, duration: number): void {
  const positions = { ...readPreference(RESUME_KEY, {}, isRecordOfNumbers) };
  delete positions[path];
  const finished = Number.isFinite(duration) && duration - seconds < 30;
  if (seconds > 5 && !finished) positions[path] = Math.round(seconds);
  const entries = Object.entries(positions);
  // Insertion order = recency (the touched entry was re-added last).
  writePreference(RESUME_KEY, Object.fromEntries(entries.slice(-MAX_RESUME_ENTRIES)));
}

export { isNumber, isString, readPreference, rememberPosition, resumePosition, writePreference };
