import type { TutorialId } from '../catalog';
import type { AppTutorial } from '../kit';
import { createRoom } from './create-room';
import { joinRoom } from './join-room';
import { openVideo } from './open-video';
import { ownerControls } from './owner-controls';
import { playerBasics } from './player-basics';
import { shareTab } from './share-tab';
import { watchShare } from './watch-share';
import { welcomeTour } from './welcome-tour';

/** Every bundled script, by id. Loaded only with the tutorial overlay. */
const SCRIPTS: Readonly<Record<TutorialId, AppTutorial>> = {
  'welcome-tour': welcomeTour,
  'open-video': openVideo,
  'create-room': createRoom,
  'join-room': joinRoom,
  'player-basics': playerBasics,
  'share-tab': shareTab,
  'owner-controls': ownerControls,
  'watch-share': watchShare,
};

export { SCRIPTS };
