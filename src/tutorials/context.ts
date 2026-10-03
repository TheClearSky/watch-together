import { TUTORIAL_IDS } from './catalog';
import type { TutorialId } from './catalog';

/**
 * Which tutorials to offer FIRST, for where the user is (D4: "a tutorial
 * button ... offering different tutorials based on the page you are on").
 * The app computes the context from its own state; this is a pure mapping.
 *
 *  page      in a room?  extra                    offered first
 *  welcome   no          no folder linked         What is it? · Open a video · Create · Join
 *  welcome   no          folder linked            Create · Join · What is it?
 *  welcome   yes         (owner)                  [Approve & who shares] · Watch a share · What is it?
 *  video     no                                   Player basics · Create · Join
 *  video     yes         may share                Share this tab · Player basics · [Approve…]
 *  video     yes         may not share            Player basics · Watch a share · [Approve…]
 *  share     —                                    Watch a share · Player basics
 *  empty     —                                    Open a video · What is it? · [Create · Join]
 *
 * `narrow` (phone layout) changes nothing here: every tutorial works on
 * phones, and the scripts branch on the layout themselves at run time.
 */

type TutorialContext = {
  readonly page: 'welcome' | 'video' | 'share' | 'empty';
  readonly inRoom: boolean;
  readonly isOwner: boolean;
  readonly canShare: boolean;
  readonly hasFolder: boolean;
  readonly narrow: boolean;
};

type TutorialChoice = {
  /** For this page, most relevant first. */
  readonly forThisPage: TutorialId[];
  /** Every tutorial, in catalogue order (the menu shows the ones not
   *  already listed above under "All tutorials"). */
  readonly all: TutorialId[];
};

function forPage(ctx: TutorialContext): TutorialId[] {
  const owner: TutorialId[] = ctx.inRoom && ctx.isOwner ? ['owner-controls'] : [];
  const roomEntry: TutorialId[] = ctx.inRoom ? [] : ['create-room', 'join-room'];
  switch (ctx.page) {
    case 'welcome':
      if (ctx.inRoom) return [...owner, 'watch-share', 'welcome-tour'];
      return ctx.hasFolder ? [...roomEntry, 'welcome-tour'] : ['welcome-tour', 'open-video', ...roomEntry];
    case 'video':
      if (!ctx.inRoom) return ['player-basics', ...roomEntry];
      return ctx.canShare ? ['share-tab', 'player-basics', ...owner] : ['player-basics', 'watch-share', ...owner];
    case 'share':
      return ['watch-share', 'player-basics'];
    case 'empty':
      return ['open-video', 'welcome-tour', ...roomEntry];
  }
}

function tutorialsForContext(ctx: TutorialContext): TutorialChoice {
  const seen = new Set<TutorialId>();
  const forThisPage = forPage(ctx).filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  return { forThisPage, all: [...TUTORIAL_IDS] };
}

export { tutorialsForContext };
export type { TutorialChoice, TutorialContext };
