/**
 * The tutorials the app ships, as the MENU needs them: id, title, length.
 *
 * This file is in the main chunk (the Tutorials button lists these); the
 * scripts themselves are loaded only when a tutorial starts. A unit test
 * checks that every entry here matches its script (title, minutes,
 * revision), so the two can't drift.
 */

const TUTORIAL_IDS = [
  'welcome-tour',
  'open-video',
  'create-room',
  'join-room',
  'player-basics',
  'share-tab',
  'owner-controls',
  'watch-share',
] as const;

type TutorialId = (typeof TUTORIAL_IDS)[number];

type TutorialMeta = {
  readonly id: TutorialId;
  readonly title: string;
  readonly minutes: number;
  /** Bumped with the script's `revision`: a changed tutorial is un-ticked. */
  readonly revision: number;
};

const TUTORIAL_META: Readonly<Record<TutorialId, TutorialMeta>> = {
  'welcome-tour': { id: 'welcome-tour', title: 'What is watch-together?', minutes: 1, revision: 1 },
  'open-video': { id: 'open-video', title: 'Open or link a video', minutes: 1, revision: 1 },
  'create-room': { id: 'create-room', title: 'Create a room and invite', minutes: 2, revision: 2 },
  'join-room': { id: 'join-room', title: 'Join a room', minutes: 1, revision: 2 },
  'player-basics': { id: 'player-basics', title: 'Player basics', minutes: 2, revision: 1 },
  'share-tab': { id: 'share-tab', title: 'Share a tab with the room', minutes: 1, revision: 1 },
  'owner-controls': { id: 'owner-controls', title: 'Approve people & who may share', minutes: 2, revision: 1 },
  'watch-share': { id: 'watch-share', title: 'Watch a share: stream or your copy', minutes: 2, revision: 1 },
};

function isTutorialId(value: unknown): value is TutorialId {
  return typeof value === 'string' && (TUTORIAL_IDS as readonly string[]).includes(value);
}

export { isTutorialId, TUTORIAL_IDS, TUTORIAL_META };
export type { TutorialId, TutorialMeta };
