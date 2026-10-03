/**
 * Fullscreen that behaves on phones (2026-10-03: "making the video fullscreen
 * in landscape mode if wanted").
 *
 *  - Normal path: the player CONTAINER goes fullscreen (so our controls and
 *    subtitles come along), then, for a landscape video on a touch device,
 *    the screen is locked to landscape (`screen.orientation.lock`, which only
 *    works while fullscreen — Chrome on Android).
 *  - iPhone Safari has no element fullscreen; there the `<video>` itself
 *    enters Safari's native player (`webkitEnterFullscreen`). Native text
 *    tracks still show; our custom controls do not.
 *  - Browsers only allow fullscreen from a user gesture. A request made
 *    outside one (an orientation change) may be refused; callers handle
 *    `false` by offering a tap.
 */

type IOSVideo = HTMLVideoElement & {
  webkitEnterFullscreen?(): void;
  webkitExitFullscreen?(): void;
  webkitDisplayingFullscreen?: boolean;
};

type LockableOrientation = ScreenOrientation & { lock?(orientation: 'landscape'): Promise<void> };

function isFullscreen(container: HTMLElement | null, video: HTMLVideoElement | null): boolean {
  if (container && document.fullscreenElement === container) return true;
  return Boolean((video as IOSVideo | null)?.webkitDisplayingFullscreen);
}

function isTouchDevice(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** Resolves `true` when fullscreen was entered. */
async function enterFullscreen(container: HTMLElement, video: HTMLVideoElement | null): Promise<boolean> {
  try {
    if (container.requestFullscreen) {
      await container.requestFullscreen({ navigationUI: 'hide' });
      const landscapeVideo = video !== null && video.videoWidth >= video.videoHeight;
      if (landscapeVideo && isTouchDevice()) {
        await (screen.orientation as LockableOrientation | undefined)?.lock?.('landscape').catch(() => {});
      }
      return true;
    }
    const ios = video as IOSVideo | null;
    if (ios?.webkitEnterFullscreen) {
      ios.webkitEnterFullscreen();
      return true;
    }
  } catch {
    // Refused (no user gesture, or not allowed in this context).
  }
  return false;
}

async function exitFullscreen(video: HTMLVideoElement | null): Promise<void> {
  try {
    screen.orientation?.unlock?.();
  } catch {
    // Not locked, or unsupported.
  }
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  const ios = video as IOSVideo | null;
  if (ios?.webkitDisplayingFullscreen) ios.webkitExitFullscreen?.();
}

function isLandscape(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(orientation: landscape)').matches;
}

export { enterFullscreen, exitFullscreen, isFullscreen, isLandscape, isTouchDevice };
