import { createProgressStore } from '@theclearsky/easy-tutorial-builder';
import { TUTORIAL_META } from './catalog';
import type { TutorialId } from './catalog';

/**
 * Which tutorials were finished — the library's progress store, under the
 * app's storage namespace. Storage may be refused (private windows, blocked
 * site data): the store already falls back to memory, and reaching
 * `localStorage` at all is guarded here.
 */

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const tutorialProgress = createProgressStore(safeLocalStorage(), 'watch-together.tutorials');

/** Completed at (at least) the current revision of the script. */
function isTutorialDone(id: TutorialId): boolean {
  try {
    return tutorialProgress.isCompleted(id, TUTORIAL_META[id].revision);
  } catch {
    return false;
  }
}

export { isTutorialDone, tutorialProgress };
