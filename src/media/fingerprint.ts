/**
 * "Is your file the same as mine?" without reading gigabytes.
 *
 * A fingerprint is the file's name and exact size plus a SHA-256 over three
 * 1 MiB samples (start, middle, end) and the size. Hashing a whole 1.5 GB
 * file would take seconds and touch every byte on disk; three samples catch
 * every real-world difference that matters here — a different encode, a
 * different release, a truncated download — because each of those changes
 * the size, the container header at the start, or the index at the end.
 *
 * WebCrypto only: `subtle.digest` takes the ≤3 MiB of samples in one call,
 * so no streaming hash (and no dependency) is needed.
 */

type Fingerprint = {
  name: string;
  size: number;
  /** Lower-case hex SHA-256 of the samples + size. */
  sampleHash: string;
};

const SAMPLE_BYTES = 1024 * 1024;

/** The byte ranges sampled for a file of `size` bytes (deduplicated, so a
 *  small file is hashed whole, once). */
function sampleRanges(size: number): [number, number][] {
  if (size <= SAMPLE_BYTES * 3) return [[0, size]];
  const middle = Math.floor(size / 2 - SAMPLE_BYTES / 2);
  return [
    [0, SAMPLE_BYTES],
    [middle, middle + SAMPLE_BYTES],
    [size - SAMPLE_BYTES, size],
  ];
}

async function fingerprintOf(file: Blob & { name: string }): Promise<Fingerprint> {
  const parts: BlobPart[] = sampleRanges(file.size).map(([start, end]) => file.slice(start, end));
  // The size is part of the hash too, so two files that differ only in a
  // region between samples still differ when their lengths do.
  parts.push(new TextEncoder().encode(`|${file.size}`));
  const digest = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer());
  const sampleHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { name: file.name, size: file.size, sampleHash };
}

/**
 * Cheap pre-filter before hashing: candidates in a library listing whose
 * size matches exactly (names differ between releases and renames, so the
 * name only ORDERS candidates, it never excludes one).
 */
function rankCandidates<T extends { name: string; size: number }>(target: Fingerprint, files: readonly T[]): T[] {
  const sameName = (file: T) => file.name.normalize('NFC').toLowerCase() === target.name.normalize('NFC').toLowerCase();
  return files
    .filter((file) => file.size === target.size)
    .sort((a, b) => Number(sameName(b)) - Number(sameName(a)));
}

function sameFile(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && a.sampleHash === b.sampleHash;
}

export { fingerprintOf, rankCandidates, sameFile, sampleRanges, SAMPLE_BYTES };
export type { Fingerprint };
