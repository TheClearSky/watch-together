/**
 * How the tutorials find things in the app WITHOUT the app marking them:
 * accessible names (aria-label), roles, the folder library's `data-efm`
 * hooks, and visible text. Every selector lives in `SELECTORS` so a unit
 * test can check them all, and the real-Chrome check runs each one through
 * the browser's own parser.
 *
 * Everything here must be cheap (it runs every frame / tick while a step
 * shows) and must never throw — a broken lookup means "not on screen".
 */

const SELECTORS = {
  headerLibrary: 'header button[aria-label="Library"]',
  headerWelcome: 'header button[aria-label="Welcome"]',
  headerOpen: 'header button[aria-label="Open a video file"]',
  headerRoom: 'header button[aria-label^="Room"]',
  headerTutorials: 'header [data-tour="tutorials"], [data-tour="tutorials"]',
  welcomeTicket: '[data-tour="ticket"]',
  welcomeInRoom: '[data-tour="ticket"][data-state="in-room"]',
  welcomeStart: '[data-tour="start-room"]',
  welcomeJoinInvite: '[data-tour="join-invite"]',
  welcomeJoinCode: '[data-tour="join-code"]',
  welcomeJoinSubmit: '[data-tour="join-submit"]',
  welcomeName: '[data-tour="your-name"]',
  welcomeShareInvite: '[data-tour="share-invite"]',
  welcomeOpenFile: '[data-tour="open-file"]',
  welcomeLinkFolder: '[data-tour="link-folder"]',
  sidebar: 'aside[data-efm="file-sidebar"]',
  sidebarButtons: 'aside[data-efm="file-sidebar"] button',
  tree: 'aside[data-efm="file-sidebar"] [role="tree"]',
  treeItems: 'aside[data-efm="file-sidebar"] [role="treeitem"]',
  tabStrip: '[data-efm="tab-strip"]',
  activeTab: '[role="tab"][aria-selected="true"]',
  shareTabs: '[role="tab"][id^="content-tab-share:"]',
  content: '#content',
  videos: '#content video',
  playPause: '#content button[aria-label="Play"], #content button[aria-label="Pause"]',
  seek: '#content input[aria-label="Seek"]',
  volume: '#content input[aria-label="Volume (yours only)"]',
  mute: '#content button[aria-label="Mute"], #content button[aria-label="Unmute"]',
  subtitles: '#content button[aria-label="Subtitles"]',
  settings: '#content button[aria-label="Settings"]',
  settingsPanel: '#content [role="dialog"][aria-label="Player settings"]',
  fullscreen: '#content button[aria-label="Fullscreen"], #content button[aria-label="Exit fullscreen"]',
  shareButton: '#content button[aria-label="Share with the room"]',
  stopShare: '#content button[aria-label="Stop sharing"]',
  roomPanel: 'aside[aria-label="Room"]',
  roomSections: 'aside[aria-label="Room"] section',
  roomButtons: 'aside[aria-label="Room"] button',
  roomClose: 'aside[aria-label="Room"] button[aria-label="Close room panel"]',
  shareSource: '#content [role="radiogroup"][aria-label="Source"]',
  shareRadios: '#content [role="radiogroup"][aria-label="Source"] [role="radio"]',
  contentButtons: '#content button',
  saveCopy: '#content button[aria-label="Save a copy"]',
} as const;

type SelectorName = keyof typeof SELECTORS;

function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

/** On screen: connected, not display:none / hidden, has a size. */
function isShown(element: Element | null | undefined): element is HTMLElement {
  if (!element || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function all(name: SelectorName): HTMLElement[] {
  if (!hasDocument()) return [];
  try {
    return [...document.querySelectorAll<HTMLElement>(SELECTORS[name])];
  } catch {
    return [];
  }
}

/** The first element on screen for a selector (players of other tabs stay
 *  mounted but hidden, so "first in the DOM" is not enough). */
function shown(name: SelectorName): HTMLElement | null {
  return all(name).find(isShown) ?? null;
}

/** Any element for a selector, shown or not. */
function any(name: SelectorName): HTMLElement | null {
  return all(name)[0] ?? null;
}

function textOf(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The first shown element of `name` whose text contains `text`. */
function withText(name: SelectorName, text: string): HTMLElement | null {
  const wanted = text.toLowerCase();
  return all(name).find((element) => isShown(element) && textOf(element).toLowerCase().includes(wanted)) ?? null;
}

/** A room-panel section by the start of its title ("People · 3 here"). */
function roomSection(title: string): HTMLElement | null {
  const wanted = title.toLowerCase();
  return (
    all('roomSections').find((section) => {
      const heading = section.querySelector('h3');
      return heading !== null && isShown(section) && textOf(heading).toLowerCase().startsWith(wanted);
    }) ?? null
  );
}

type Page = 'welcome' | 'video' | 'share' | 'empty';

/** Where the user is, read from the selected tab (`content-tab-<kind>:<key>`). */
function currentPage(): Page {
  const id = any('activeTab')?.id ?? '';
  if (id.startsWith('content-tab-welcome:')) return 'welcome';
  if (id.startsWith('content-tab-share:')) return 'share';
  if (shown('seek')) return 'video';
  return 'empty';
}

/** The header's room button says "Room <code>, <n> here" while in a room. */
function roomLabel(): string {
  return any('headerRoom')?.getAttribute('aria-label') ?? '';
}

function inRoom(): boolean {
  return /^Room \S+, \d+ here$/.test(roomLabel());
}

function peopleHere(): number {
  const match = /, (\d+) here$/.exec(roomLabel());
  return match ? Number(match[1]) : 0;
}

function joining(): boolean {
  const button = any('headerRoom');
  return button !== null && /Joining|⏳/.test(textOf(button));
}

/** The yellow request badge on the Room button (a bare number, no label),
 *  or a "Let in" button in the open panel. */
function hasJoinRequests(): boolean {
  const button = any('headerRoom');
  const badge =
    button !== null &&
    [...button.querySelectorAll('span')].some(
      (span) => !span.hasAttribute('aria-label') && span.classList.contains('absolute') && /^\d+$/.test(textOf(span)),
    );
  return badge || withText('roomButtons', 'Let in') !== null;
}

/** The video of the tab on screen. */
function visibleVideo(): HTMLVideoElement | null {
  return (shown('videos') as HTMLVideoElement | null) ?? null;
}

function canLinkFolders(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

function isNarrow(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches;
}

/**
 * The player hides its controls while a video plays and shows them again on
 * a mouse move. A synthetic move on the controls (it bubbles to the player)
 * brings them back — presentational only, it changes nothing.
 */
function revealPlayerControls(): void {
  const seek = shown('seek') ?? any('seek');
  if (!seek || typeof PointerEvent === 'undefined') return;
  seek.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
}

function click(element: HTMLElement | null): void {
  if (element && !(element as HTMLButtonElement).disabled) element.click();
}

export {
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
  SELECTORS,
  shown,
  textOf,
  visibleVideo,
  withText,
};
export type { Page, SelectorName };
