import { useEffect } from 'react';

/**
 * Keep the screen awake while `active` (2026-10-03: a room made on a phone
 * vanished — the screen locked, the browser suspended the page, and nobody
 * was left to let people in). A room lives only in the browsers of the
 * people in it, so on phones the page asks for a Screen Wake Lock while in a
 * room, and asks again whenever it becomes visible (the browser drops the
 * lock when the page is hidden). Unsupported browsers: no-op.
 */
function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        // Refused (battery saver, not allowed): nothing else to do.
      }
    };
    const onVisible = () => void acquire();
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}

export { useWakeLock };
