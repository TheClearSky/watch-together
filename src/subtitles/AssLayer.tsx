/**
 * Renders an ASS/SSA script over a `<video>` with JASSUB (libass in WASM,
 * drawing into an OffscreenCanvas from its own worker).
 *
 * Placement: render `<AssLayer>` as a SIBLING of the `<video>`, inside the
 * video's positioned parent (VideoPlayer's video surface). JASSUB inserts its
 * canvas right after the video and positions it over the video's letterboxed
 * picture using the video's offsets — so the canvas lives inside the player
 * CONTAINER, which is what goes fullscreen; subtitles stay visible there.
 *
 * Lifecycle:
 *  - `script === null` → nothing is loaded (JASSUB is imported lazily, the
 *    first time a script is given).
 *  - script changes (track switch, or more events streamed in) →
 *    `renderer.setTrack(script)`, throttled to once per second while a
 *    scan streams in; no WASM reload.
 *  - fonts arriving later → `renderer.addFonts` (only the new ones).
 *  - video element changes / unmount → `destroy()` (canvas removed, worker
 *    terminated).
 *  - resize: JASSUB watches the video's size; we also watch the parent (the
 *    video's offsets move without a size change when the box widens around a
 *    height-bound video) and `fullscreenchange`.
 *
 * Fallback: if JASSUB cannot load (import/worker/WASM failure, or not ready
 * within READY_TIMEOUT_MS), the same script is shown as plain text (override
 * tags stripped) — subtitles are never silently lost.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type JASSUBType from 'jassub';
import { activeCues, parseAssDialogues } from './assScript';

type AssLayerFont = { name: string; data: ArrayBuffer };

type AssLayerStatus = 'idle' | 'loading' | 'ready' | 'fallback';

type AssLayerProps = {
  video: HTMLVideoElement | null;
  script: string | null;
  fonts: readonly AssLayerFont[];
  /** Observability: renderer state changes (and the error behind a fallback). */
  onStatus?(status: AssLayerStatus, error?: unknown): void;
  /**
   * The true media time now, when the element's own clock is not it — a
   * received stream counts from when the stream started, not from the
   * file's start. Subtitles then follow this instead.
   */
  timeSource?: () => number | null;
  /** Injection point for tests/verification (default: the real JASSUB runtime). */
  loadRuntime?: () => Promise<Runtime>;
};

const READY_TIMEOUT_MS = 20_000;
const SET_TRACK_INTERVAL_MS = 1000;

const defaultLoadRuntime = (): Promise<Runtime> => import('./jassubRuntime');

type Instance = JASSUBType;
type Runtime = typeof import('./jassubRuntime');

function AssLayer({ video, script, fonts, onStatus, timeSource, loadRuntime = defaultLoadRuntime }: AssLayerProps) {
  const timeSourceRef = useRef(timeSource);
  timeSourceRef.current = timeSource;
  const following = timeSource !== undefined;
  const [status, setStatus] = useState<AssLayerStatus>('idle');
  const [failure, setFailure] = useState<unknown>(null);
  const instanceRef = useRef<Instance | null>(null);
  const readyRef = useRef(false);
  const scriptRef = useRef(script);
  scriptRef.current = script;
  const fontsRef = useRef(fonts);
  fontsRef.current = fonts;
  const addedFonts = useRef(new WeakSet<ArrayBuffer>());
  const appliedScript = useRef<string | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const loadRuntimeRef = useRef(loadRuntime);
  loadRuntimeRef.current = loadRuntime;
  const wanted = script !== null;
  const fallback = failure !== null;

  useEffect(() => {
    onStatusRef.current?.(status, status === 'fallback' ? failure : undefined);
  }, [status, failure]);

  // ── create / destroy the renderer ─────────────────────────────────────
  useEffect(() => {
    if (!video || !wanted || fallback) {
      setStatus(fallback ? 'fallback' : 'idle');
      return;
    }
    let cancelled = false;
    let instance: Instance | null = null;
    let timeout: number | undefined;
    const fail = (error: unknown) => {
      if (cancelled) return;
      console.warn('[AssLayer] libass renderer unavailable; showing plain-text subtitles.', error);
      setFailure(error ?? new Error('JASSUB failed'));
    };
    setStatus('loading');
    (async () => {
      const runtime = await loadRuntimeRef.current();
      if (cancelled) return;
      const initialScript = scriptRef.current ?? '';
      const initialFonts = fontsRef.current;
      addedFonts.current = new WeakSet(initialFonts.map((font) => font.data));
      instance = new runtime.JASSUB({
        video,
        subContent: initialScript,
        workerUrl: runtime.workerUrl,
        wasmUrl: runtime.wasmUrl,
        modernWasmUrl: runtime.modernWasmUrl,
        fonts: initialFonts.map((font) => new Uint8Array(font.data)),
        availableFonts: { [runtime.DEFAULT_FONT]: runtime.defaultFontUrl },
        defaultFont: runtime.DEFAULT_FONT,
        queryFonts: 'local',
      });
      appliedScript.current = initialScript;
      instanceRef.current = instance;
      instance._worker.addEventListener('error', (event) => fail(event.message || 'JASSUB worker error'));
      timeout = window.setTimeout(() => fail(new Error(`JASSUB not ready after ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
      await instance.ready;
      // The worker swallows its own init errors (WASM fetch, libass init) and
      // still resolves `ready`; a real round trip proves it is alive.
      if (!instance.renderer) throw new Error('JASSUB renderer missing');
      await instance.renderer.getStyles();
      window.clearTimeout(timeout);
      if (cancelled) return;
      readyRef.current = true;
      setStatus('ready');
      // Anything that changed while loading.
      if (scriptRef.current !== null && scriptRef.current !== appliedScript.current) {
        appliedScript.current = scriptRef.current;
        await instance.renderer.setTrack(scriptRef.current);
      }
      const late = fontsRef.current.filter((font) => !addedFonts.current.has(font.data));
      if (late.length > 0) {
        for (const font of late) addedFonts.current.add(font.data);
        await instance.renderer.addFonts(late.map((font) => new Uint8Array(font.data)));
      }
      await instance.resize(true);
    })().catch(fail);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      readyRef.current = false;
      instanceRef.current = null;
      appliedScript.current = null;
      void instance?.destroy().catch(() => {});
    };
  }, [video, wanted, fallback]);

  // ── script changes: switch track / stream in more events ───────────────
  const lastSetAt = useRef(0);
  useEffect(() => {
    if (status !== 'ready' || script === null) return;
    const apply = () => {
      const instance = instanceRef.current;
      const current = scriptRef.current;
      if (!instance || !readyRef.current || current === null || current === appliedScript.current) return;
      appliedScript.current = current;
      lastSetAt.current = performance.now();
      void (async () => {
        await instance.renderer.setTrack(current);
        await instance.resize(true); // repaint now, even while paused
      })().catch(() => {});
    };
    // Leading-edge throttle: a track switch normally applies at once; the
    // same track growing during a scan updates at most once per interval.
    const wait = SET_TRACK_INTERVAL_MS - (performance.now() - lastSetAt.current);
    if (wait <= 0) {
      apply();
      return;
    }
    const timer = window.setTimeout(apply, wait);
    return () => window.clearTimeout(timer);
  }, [script, status]);

  // ── fonts arriving after start ────────────────────────────────────────
  useEffect(() => {
    const instance = instanceRef.current;
    if (status !== 'ready' || !instance) return;
    const fresh = fonts.filter((font) => !addedFonts.current.has(font.data));
    if (fresh.length === 0) return;
    for (const font of fresh) addedFonts.current.add(font.data);
    void (async () => {
      await instance.renderer.addFonts(fresh.map((font) => new Uint8Array(font.data)));
      await instance.resize(true);
    })().catch(() => {});
  }, [fonts, status]);

  // ── following an outside clock (streams) ──────────────────────────────
  // JASSUB draws at frame.mediaTime + timeOffset; keep the offset equal to
  // (true time − the frame's mediaTime), measured on the same frames.
  useEffect(() => {
    if (status !== 'ready' || !video || !following) return;
    let handle = 0;
    let stopped = false;
    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      const truth = timeSourceRef.current?.();
      const instance = instanceRef.current;
      if (truth !== null && truth !== undefined && instance) {
        const offset = truth - metadata.mediaTime;
        if (Math.abs(offset - instance.timeOffset) > 0.05) instance.timeOffset = offset;
      }
      handle = video.requestVideoFrameCallback(onFrame);
    };
    handle = video.requestVideoFrameCallback(onFrame);
    return () => {
      stopped = true;
      video.cancelVideoFrameCallback(handle);
    };
  }, [video, status, following]);

  // ── layout changes JASSUB's own observer misses ───────────────────────
  useEffect(() => {
    const parent = video?.parentElement;
    if (status !== 'ready' || !video || !parent) return;
    const relayout = () => {
      if (readyRef.current) void instanceRef.current?.resize().catch(() => {});
    };
    const observer = new ResizeObserver(relayout);
    observer.observe(parent);
    document.addEventListener('fullscreenchange', relayout);
    return () => {
      observer.disconnect();
      document.removeEventListener('fullscreenchange', relayout);
    };
  }, [video, status]);

  if (!fallback || script === null || !video) return null;
  return <PlainTextOverlay video={video} script={script} timeSource={timeSourceRef} />;
}

// ── fallback: plain text, override tags stripped ────────────────────────

function PlainTextOverlay({
  video,
  script,
  timeSource,
}: {
  video: HTMLVideoElement;
  script: string;
  timeSource: { current: (() => number | null) | undefined };
}) {
  const cues = useMemo(() => parseAssDialogues(script), [script]);
  const [text, setText] = useState('');
  const [box, setBox] = useState<CSSProperties>({});

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const next = activeCues(cues, timeSource.current?.() ?? video.currentTime)
        .map((cue) => cue.text)
        .join('\n');
      setText((current) => (current === next ? current : next));
    };
    const loop = () => {
      update();
      frame = requestAnimationFrame(loop);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      update();
    };
    if (!video.paused) start();
    else update();
    video.addEventListener('play', start);
    video.addEventListener('pause', stop);
    video.addEventListener('seeked', update);
    video.addEventListener('timeupdate', update);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener('play', start);
      video.removeEventListener('pause', stop);
      video.removeEventListener('seeked', update);
      video.removeEventListener('timeupdate', update);
    };
  }, [cues, video]);

  // Sit over the video's picture (not its letterbox bars).
  useEffect(() => {
    const place = () => setBox(videoPictureBox(video));
    place();
    const observer = new ResizeObserver(place);
    observer.observe(video);
    if (video.parentElement) observer.observe(video.parentElement);
    video.addEventListener('loadedmetadata', place);
    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', place);
    };
  }, [video]);

  if (!text) return null;
  // Inline styles (not Tailwind classes): the fallback must look right in any host.
  const height = typeof box.height === 'number' ? box.height : 360;
  return (
    <div
      data-subtitle-fallback=''
      style={{ ...box, position: 'absolute', pointerEvents: 'none', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div
        style={{
          marginBottom: '5%',
          maxWidth: '90%',
          whiteSpace: 'pre-line',
          textAlign: 'center',
          color: '#fff',
          background: 'rgba(0, 0, 0, 0.6)',
          borderRadius: 4,
          padding: '2px 8px',
          fontSize: `${Math.min(48, Math.max(14, height / 18))}px`,
          lineHeight: 1.25,
          textShadow: '0 0 3px #000',
        }}
      >
        {text}
      </div>
    </div>
  );
}

/** The video's displayed picture inside its element box, as absolute
 *  coordinates in the video's offset parent (the same math JASSUB uses). */
function videoPictureBox(video: HTMLVideoElement): CSSProperties {
  const { clientWidth, clientHeight, offsetLeft, offsetTop, videoWidth, videoHeight } = video;
  if (!clientWidth || !clientHeight) return { left: 0, top: 0, width: '100%', height: '100%' };
  const ratio = videoWidth && videoHeight ? videoWidth / videoHeight : clientWidth / clientHeight;
  const width = clientWidth / clientHeight > ratio ? clientHeight * ratio : clientWidth;
  const height = clientWidth / clientHeight > ratio ? clientHeight : clientWidth / ratio;
  return { left: offsetLeft + (clientWidth - width) / 2, top: offsetTop + (clientHeight - height) / 2, width, height };
}

export { AssLayer };
export type { AssLayerFont, AssLayerProps, AssLayerStatus };
