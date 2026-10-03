/**
 * "Do I already have this video?" — for Q7 ("suggest switching to local copy
 * if hashes match"). Looks through videos opened this session and the linked
 * library: exact size first (cheap), then the sampled hash (≤ 3 MiB read).
 */
import type { FileLibrary } from '@theclearsky/easy-folder-management-ui';
import { isOpenableFile } from '@theclearsky/easy-folder-management-ui';
import type { Fingerprint } from '../media/fingerprint';
import { fingerprintOf, rankCandidates, sameFile } from '../media/fingerprint';
import type { OpenedFiles } from '../library/openedFiles';

type LocalCopy = { kind: 'opened'; id: string; file: File } | { kind: 'file'; id: string; file: File };

const MAX_LIBRARY_FILES = 3000;
/** Library file sizes, by node id — `getFile()` is a stat, but thousands add up. */
const sizeCache = new WeakMap<FileLibrary, Map<string, number>>();

async function librarySizes(library: FileLibrary): Promise<{ id: string; name: string; size: number }[]> {
  let cache = sizeCache.get(library);
  if (!cache) sizeCache.set(library, (cache = new Map()));
  const tree = library.tree;
  const out: { id: string; name: string; size: number }[] = [];
  let looked = 0;
  for (const node of Object.values(tree.nodes)) {
    if (!isOpenableFile(node, library.policy)) continue;
    if (++looked > MAX_LIBRARY_FILES) break;
    let size = cache.get(node.id);
    if (size === undefined) {
      size = await library
        .getFile(node.id)
        .then((file) => file.size)
        .catch(() => -1);
      cache.set(node.id, size);
    }
    if (size >= 0) out.push({ id: node.id, name: node.name, size });
  }
  return out;
}

async function findLocalCopy(
  target: Fingerprint,
  sources: { openedFiles: OpenedFiles; library: FileLibrary },
): Promise<LocalCopy | null> {
  // Opened files first: they are what the user most recently picked.
  for (const id of sources.openedFiles.ids()) {
    const entry = sources.openedFiles.get(id);
    if (!entry?.file || entry.size !== target.size) continue;
    if (sameFile(await fingerprintOf(entry.file), target)) return { kind: 'opened', id, file: entry.file };
  }
  const mode = sources.library.mode.kind;
  if (mode !== 'folder' && mode !== 'memory') return null;
  for (const candidate of rankCandidates(target, await librarySizes(sources.library))) {
    const file = await sources.library.getFile(candidate.id).catch(() => null);
    if (file && sameFile(await fingerprintOf(file), target)) return { kind: 'file', id: candidate.id, file };
  }
  return null;
}

/** A file the user picks by hand to watch along with: is it the same? */
async function matchesShare(file: File, target: Fingerprint): Promise<boolean> {
  return file.size === target.size && sameFile(await fingerprintOf(file), target);
}

export { findLocalCopy, matchesShare };
export type { LocalCopy };
