import { defineKit } from '@theclearsky/easy-tutorial-builder';
import type { JsonArgs, KitTutorial } from '@theclearsky/easy-tutorial-builder';
import {
  any,
  canLinkFolders,
  click,
  currentPage,
  hasJoinRequests,
  inRoom,
  isNarrow,
  isShown,
  joining,
  peopleHere,
  revealPlayerControls,
  roomSection,
  shown,
  textOf,
  visibleVideo,
  withText,
} from './dom';

/**
 * The app's tutorial vocabulary: everything a script may point at, wait
 * for, ask about or ask for. Scripts can ONLY name these.
 *
 * The app is not marked up for tutorials (no `data-tour` attributes): every
 * target is found from what the app already renders for people — accessible
 * names, roles and visible text (see `dom.ts`). Events come from watching
 * the page (`observeApp`): clicks on known targets, the visible video
 * playing/pausing, fullscreen. Everything else is a predicate the library
 * polls (`when` transitions, `skipIf`).
 */

/** Targets without arguments — these also report `clicked` events. */
const plainTargets = {
  'header.library': () => any('headerLibrary'),
  'header.welcome': () => any('headerWelcome'),
  'header.open': () => any('headerOpen'),
  'header.room': () => any('headerRoom'),
  'header.tutorials': () => any('headerTutorials'),
  /** The Welcome page's ticket booth (create / join / invite, one click each). */
  'welcome.ticket': () => shown('welcomeTicket'),
  'welcome.createRoom': () => shown('welcomeStart'),
  'welcome.joinInvite': () => shown('welcomeJoinInvite'),
  'welcome.joinRoom': () => shown('welcomeJoinCode'),
  'welcome.joinSubmit': () => shown('welcomeJoinSubmit'),
  'welcome.name': () => shown('welcomeName'),
  'welcome.inRoom': () => shown('welcomeInRoom'),
  'welcome.shareInvite': () => shown('welcomeShareInvite'),
  'welcome.openFile': () => shown('welcomeOpenFile'),
  'welcome.linkFolder': () => shown('welcomeLinkFolder'),
  'library.sidebar': () => shown('sidebar'),
  'library.tree': () => shown('tree'),
  'library.linkFolder': () => withText('sidebarButtons', 'Link folder'),
  'tabs.strip': () => shown('tabStrip'),
  'tabs.share': () => shown('shareTabs'),
  'player.playPause': () => shown('playPause'),
  'player.seek': () => shown('seek'),
  /** The slider; phones hide it (their volume is in Settings) → the mute button. */
  'player.volume': () => shown('volume') ?? shown('mute'),
  'player.subtitles': () => shown('subtitles'),
  'player.settings': () => shown('settings'),
  'player.settingsPanel': () => shown('settingsPanel'),
  'player.fullscreen': () => shown('fullscreen'),
  'player.share': () => shown('shareButton'),
  /** "📡 Sharing · 2" and its stop button. */
  'player.sharing': () => shown('stopShare')?.parentElement ?? null,
  'room.panel': () => shown('roomPanel'),
  'room.copyLink': () => withText('roomButtons', 'invite link') ?? withText('roomButtons', 'Link copied'),
  'room.letIn': () => withText('roomButtons', 'Let in'),
  'share.source': () => shown('shareSource'),
  'share.stream': () => withText('shareRadios', 'Stream'),
  'share.myCopy': () => withText('shareRadios', 'My copy'),
  'share.askControl': () =>
    withText('contentButtons', 'Ask for control') ?? withText('contentButtons', 'Asked for control'),
  'share.saveCopy': () => shown('saveCopy'),
} satisfies Record<string, () => HTMLElement | null>;

type PlainTarget = keyof typeof plainTargets;

function isPlainTarget(name: unknown): name is PlainTarget {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(plainTargets, name);
}

function str(args: JsonArgs, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

const tutorialKit = defineKit({
  targets: {
    ...plainTargets,
    /** A section of the room panel by its title: Invite, Wants to join,
     *  People, Who can share a tab, Shared in the room, You are sharing, Chat. */
    'room.section': (args: JsonArgs) => roomSection(str(args, 'title')),
  },
  events: ['clicked', 'video.play', 'video.pause', 'video.volume', 'fullscreen.changed'],
  predicates: {
    /** `{page}`: welcome | video | share | empty. */
    'page.is': (args: JsonArgs) => currentPage() === str(args, 'page'),
    /** `{target}`: a plain target is on screen now. */
    shown: (args: JsonArgs) => {
      const name = str(args, 'target');
      return isPlainTarget(name) && isShown(plainTargets[name]());
    },
    'room.in': () => inRoom(),
    'room.joining': () => joining(),
    /** `{n}` */
    'room.peopleAtLeast': (args: JsonArgs) => peopleHere() >= (typeof args.n === 'number' ? args.n : 1),
    'room.panelOpen': () => shown('roomPanel') !== null,
    /** Only the owner sees "Who can share a tab". */
    'room.isOwner': () => roomSection('Who can share a tab') !== null,
    'room.hasRequests': () => hasJoinRequests(),
    /** The ticket booth is on screen (the Welcome page, not in a room yet). */
    'welcome.ticketShown': () => shown('welcomeTicket') !== null,
    /** A valid code/link is typed into "join a friend". */
    'welcome.codeValid': () => {
      const submit = shown('welcomeJoinSubmit') as HTMLButtonElement | null;
      return submit !== null && !submit.disabled;
    },
    'library.open': () => shown('sidebar') !== null,
    'library.hasVideos': () => shown('treeItems') !== null,
    'video.open': () => shown('seek') !== null,
    'video.playing': () => {
      const video = visibleVideo();
      return video !== null && !video.paused && !video.ended;
    },
    'video.fullscreen': () => typeof document !== 'undefined' && document.fullscreenElement !== null,
    'player.hasSubtitles': () => shown('subtitles') !== null,
    'player.settingsOpen': () => shown('settingsPanel') !== null,
    'player.sharing': () => shown('stopShare') !== null,
    'share.open': () => currentPage() === 'share',
    /** `{mode}`: stream | local. */
    'share.mode': (args: JsonArgs) => {
      const radio = withText('shareRadios', str(args, 'mode') === 'local' ? 'My copy' : 'Stream');
      return radio?.getAttribute('aria-checked') === 'true';
    },
    'share.controlAsked': () =>
      withText('contentButtons', 'Asked for control') !== null ||
      (any('content') !== null && /You have control/.test(textOf(any('content')!))),
    'layout.narrow': () => isNarrow(),
    'folders.supported': () => canLinkFolders(),
  },
  assists: {
    // Non-destructive helpers, offered as "Show me" — never run silently.
    openWelcome: () => click(any('headerWelcome')),
    openLibrary: () => {
      if (shown('sidebar') === null) click(any('headerLibrary'));
    },
    openRoomPanel: () => {
      if (shown('roomPanel') === null && inRoom()) click(any('headerRoom'));
    },
    openSettings: () => {
      revealPlayerControls();
      if (shown('settingsPanel') === null) click(shown('settings'));
    },
    showControls: () => revealPlayerControls(),
  },
  capabilities: ['rooms', 'player', 'sharing', 'library'],
});

type AppTutorial = KitTutorial<typeof tutorialKit>;

/**
 * Watch the page and turn what the user does into kit events. Returns the
 * cleanup. Capture phase: it sees a click before the app re-renders (the
 * element is still there), and it sees media events, which don't bubble.
 */
function observeApp(kit: typeof tutorialKit = tutorialKit): () => void {
  if (typeof document === 'undefined') return () => {};
  const names = Object.keys(plainTargets) as PlainTarget[];
  const onClick = (event: MouseEvent) => {
    const node = event.target;
    if (!(node instanceof Node)) return;
    for (const name of names) {
      let element: HTMLElement | null = null;
      try {
        element = plainTargets[name]();
      } catch {
        element = null;
      }
      if (element?.contains(node)) kit.bus.emit('clicked', { target: name });
    }
  };
  const fromContent = (event: Event) => {
    const node = event.target;
    return node instanceof HTMLMediaElement && node.closest('#content') !== null;
  };
  const onPlay = (event: Event) => fromContent(event) && kit.bus.emit('video.play');
  const onPause = (event: Event) => fromContent(event) && kit.bus.emit('video.pause');
  const onVolume = (event: Event) => fromContent(event) && kit.bus.emit('video.volume');
  const onFullscreen = () => kit.bus.emit('fullscreen.changed', { on: document.fullscreenElement !== null });
  document.addEventListener('click', onClick, true);
  document.addEventListener('play', onPlay, true);
  document.addEventListener('pause', onPause, true);
  document.addEventListener('volumechange', onVolume, true);
  document.addEventListener('fullscreenchange', onFullscreen);
  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('play', onPlay, true);
    document.removeEventListener('pause', onPause, true);
    document.removeEventListener('volumechange', onVolume, true);
    document.removeEventListener('fullscreenchange', onFullscreen);
  };
}

export { isPlainTarget, observeApp, plainTargets, tutorialKit };
export type { AppTutorial, PlainTarget };
