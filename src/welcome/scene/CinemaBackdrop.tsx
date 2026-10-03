import { useEffect, useRef, useState } from 'react';
import type { CinemaScene } from './cinemaScene';

/** The hero's page colour (only the scene's 'baked' blend mode uses it; this
 *  component uses the transparent mode, which works on any backdrop). */
const CINEMA_BACKGROUND = '#0a0606';

type CinemaBackdropProps = {
  className?: string;
  /** The scene is up (its controls can show), or failed / went away. */
  onReady?(ready: boolean): void;
};

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The procedural cinema still life (film reel, film strip, popcorn) for the
 * Welcome hero. Fills its positioned container. three.js is loaded on
 * demand, in its own chunk. Renders nothing if WebGL is unavailable or the
 * scene fails to build — the page keeps its CSS backdrop.
 *
 * Mount it in a positioned box (e.g. the left half of the hero). The canvas
 * is transparent wherever the scene is dark and fades out at every edge, so
 * it has no visible boundary on any dark backdrop — flat colour, gradient
 * or embers (see cinemaScene.ts, blend 'transparent').
 */
export function CinemaBackdrop({ className, onReady }: CinemaBackdropProps) {
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const sceneRef = useRef<CinemaScene | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A fresh canvas per mount: a disposed renderer forces its context lost,
    // and a lost canvas can never give a new renderer a working context.
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-cinema-backdrop', '');
    const reducedMotion = prefersReducedMotion();
    Object.assign(canvas.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      opacity: '0',
      transition: reducedMotion ? '' : 'opacity 1.4s ease',
    });
    host.appendChild(canvas);
    let cancelled = false;
    let scene: CinemaScene | null = null;
    const cleanups: (() => void)[] = [];

    void import('./cinemaScene')
      .then(({ createCinemaScene }) => {
        if (cancelled) return;
        const created = createCinemaScene(canvas, { reducedMotion, background: CINEMA_BACKGROUND, blend: 'transparent' });
        scene = created;
        sceneRef.current = created;
        onReadyRef.current?.(true);
        const size = () => {
          const rect = canvas.getBoundingClientRect();
          created.resize(rect.width, rect.height);
        };
        size();
        const resizeObserver = new ResizeObserver(size);
        resizeObserver.observe(canvas);
        cleanups.push(() => resizeObserver.disconnect());

        // Run only while on screen and the tab is visible.
        let onScreen = true;
        const update = () => {
          if (onScreen && document.visibilityState === 'visible') created.resume();
          else created.pause();
        };
        const intersection = new IntersectionObserver((entries) => {
          onScreen = entries.some((entry) => entry.isIntersecting);
          update();
        });
        intersection.observe(canvas);
        document.addEventListener('visibilitychange', update);
        cleanups.push(() => {
          intersection.disconnect();
          document.removeEventListener('visibilitychange', update);
        });

        // No cursor tracking: the camera moves on its own (slow zoom, gentle
        // angle changes, an occasional fly-around).
        // Fade in after the first frame is on the canvas.
        requestAnimationFrame(() => {
          if (!cancelled) canvas.style.opacity = '1';
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn('[CinemaBackdrop] scene unavailable:', error);
        setFailed(true);
      });

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
      scene?.dispose();
      scene = null;
      sceneRef.current = null;
      onReadyRef.current?.(false);
      canvas.remove();
    };
  }, []);

  if (failed) return null;
  return <div ref={hostRef} aria-hidden className={className} style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'auto' }} />;
}
