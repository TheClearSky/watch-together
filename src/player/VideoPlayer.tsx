import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Cue } from '../media/subtitleText';
import { parseSubtitleText } from '../media/subtitleText';
import { readPreference, rememberPosition, resumePosition, writePreference } from '../storage';
import { audioRouteFor, resumeAudio } from './audioRouting';
import { enterFullscreen, exitFullscreen, isFullscreen, isLandscape, isTouchDevice } from './fullscreen';
import { AssLayer } from '../subtitles/AssLayer';
import { serializeTrack } from '../subtitles/serialize';
import type { SerializedSubtitleTrack } from '../subtitles/serialize';
import { useEmbeddedSubtitles } from '../subtitles/useEmbeddedSubtitles';

/** Subtitles that travel with a share (embedded tracks + their fonts). */
type SubtitlePayload = { tracks: SerializedSubtitleTrack[]; fonts: { name: string; data: ArrayBuffer }[] };

/**
 * One video tab's player: a `<video>` over a disk-backed File (an object URL
 * streams it — nothing is read into memory), overlay controls, keyboard and
 * touch gestures. Volume is MY volume, through Web Audio (audioRouting.ts).
 *
 * Mouse: click plays/pauses, double-click toggles fullscreen.
 * Touch: tap shows/hides the controls; double-tap the left or right third
 * seeks ∓10 s, the middle plays/pauses. Rotating a phone to landscape while
 * playing goes fullscreen (a setting; browsers may insist on a tap).
 *
 * Sources: a disk-backed `file`, or a live `stream` (someone else's share).
 * `controls`: `'full'` (mine), `'locked'` (a viewer: the sharer drives
 * play/pause/seek; volume, captions and fullscreen stay mine) or `'remote'`
 * (a viewer GRANTED control: my buttons send `onCommand` to the sharer,
 * whose player stays the authority). `remote` gives the time to show when
 * the element's own clock is not the shared one (a live stream).
 */

type SubtitleTrackInput = { id: string; label: string; language?: string; cues: readonly Cue[] };

type PlayerCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; t: number }
  | { type: 'rate'; rate: number };

type VideoPlayerProps = {
  file?: File | null;
  stream?: MediaStream | null;
  /** Stable key for the remembered position (library path, or name+size);
   *  omit to not remember (a shared video follows the sharer). */
  resumeKey?: string;
  active: boolean;
  volume: number;
  muted: boolean;
  onVolumeChange(volume: number, muted: boolean): void;
  onNext?(): void;
  subtitles?: readonly SubtitleTrackInput[];
  controls?: 'full' | 'locked' | 'remote';
  /** Sharer's position/duration to show instead of the element's own. */
  remote?: { time: number; duration: number | null; playing: boolean } | null;
  /** With `controls: 'remote'`: what my buttons ask the sharer to do. */
  onCommand?(command: PlayerCommand): void;
  /** Rendered in the control bar's right side (Share button, status…). */
  extraControls?: ReactNode;
  /** The element, once mounted (sharing captures it). */
  onElement?(element: HTMLVideoElement | null): void;
  /** The true media time now (a stream's element clock starts at 0 when the
   *  stream starts); subtitles follow it. */
  mediaTime?: () => number | null;
  /** Subtitles received from the sharer (a stream viewer has no file to read). */
  remoteSubtitles?: SubtitlePayload | null;
  /** The file's embedded subtitles, once fully read (the sharer sends them on). */
  onSubtitles?(payload: SubtitlePayload): void;
};

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_AFTER_MS = 2500;
const DOUBLE_TAP_MS = 280;
const BUTTON =
  'flex h-9 min-w-9 cursor-pointer items-center justify-center rounded px-2 text-[14px] text-primary-white hover:bg-white/10 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:text-[17px]';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

function VideoPlayer(props: VideoPlayerProps) {
  const { file, stream, resumeKey, active, volume, muted, onVolumeChange } = props;
  const locked = props.controls === 'locked';
  const remoteControl = props.controls === 'remote' && props.onCommand ? props.onCommand : null;
  const [needsTap, setNeedsTap] = useState(false);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  // Embedded subtitles (MKV), read from the file in a worker; a stream has
  // none of its own (the sharer sends theirs).
  const embedded = useEmbeddedSubtitles(file ?? null, { enabled: !stream });
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(Number.NaN);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [captions, setCaptions] = useState<string | null>(null);
  const [loadedTracks, setLoadedTracks] = useState<SubtitleTrackInput[]>([]);
  const [controlsShown, setControlsShown] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [offerFullscreen, setOfferFullscreen] = useState(false);
  const [ripple, setRipple] = useState<{ side: 'left' | 'right' | 'center'; key: number } | null>(null);
  const [fullscreenOnRotate, setFullscreenOnRotate] = useState(() =>
    readPreference('fullscreenOnRotate', isTouchDevice(), isBoolean),
  );
  const hideTimer = useRef<number | undefined>(undefined);
  const lastTap = useRef<{ at: number; x: number } | null>(null);
  const singleTapTimer = useRef<number | undefined>(undefined);
  const enteredByRotation = useRef(false);
  /** When the last touch happened. Browsers follow a tap with synthetic
   *  `click`/`dblclick` events whose `pointerType` is not reliably "touch"
   *  (Chrome's device emulation reports none), so mouse handlers check THIS:
   *  without it a double-tap seek also toggled fullscreen and play twice. */
  const lastTouchAt = useRef(-Infinity);
  const fromTouch = () => performance.now() - lastTouchAt.current < 800;

  // Every subtitle source in one list: sidecar files, files loaded by hand,
  // embedded text tracks, and text tracks received from the sharer. ASS
  // tracks (styled, with fonts) are drawn by JASSUB instead of native cues.
  const embeddedText: SubtitleTrackInput[] = embedded.tracks
    .filter((track) => track.kind === 'text')
    .map((track) => {
      const content = embedded.getTrack(track.number);
      return { id: track.id, label: track.label, language: track.language, cues: content?.kind === 'text' ? content.cues : [] };
    });
  const remoteText: SubtitleTrackInput[] = (props.remoteSubtitles?.tracks ?? [])
    .filter((track) => track.kind === 'text')
    .map((track) => ({ id: `remote:${track.id}`, label: track.label, language: track.language, cues: track.cues ?? [] }));
  const assTracks: { id: string; label: string; script: () => string | null }[] = [
    ...embedded.tracks
      .filter((track) => track.kind === 'ass')
      .map((track) => ({
        id: track.id,
        label: track.label,
        script: () => {
          const content = embedded.getTrack(track.number);
          return content?.kind === 'ass' ? content.script : null;
        },
      })),
    ...(props.remoteSubtitles?.tracks ?? [])
      .filter((track) => track.kind === 'ass')
      .map((track) => ({ id: `remote:${track.id}`, label: track.label, script: () => track.script ?? null })),
  ];
  const allTracks = [...(props.subtitles ?? []), ...loadedTracks, ...embeddedText, ...remoteText];
  const pickerTracks = [...allTracks.map((track) => ({ id: track.id, label: track.label })), ...assTracks];
  const chosenAss = assTracks.find((track) => track.id === captions) ?? null;
  const assScript = chosenAss ? chosenAss.script() : null;
  const assFonts = props.remoteSubtitles?.fonts ?? embedded.fonts;

  // An object URL per File; revoked when the file changes or the tab closes.
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    setError(null);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  // The element exists only once the object URL does, so it is reported from
  // the ref callback, not a mount effect (which would see null).
  const onElementRef = useRef(props.onElement);
  onElementRef.current = props.onElement;
  const setVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    setVideoElement(element);
    onElementRef.current?.(element);
  }, []);

  // Hand complete embedded tracks (and fonts) to whoever shares this video.
  const onSubtitlesRef = useRef(props.onSubtitles);
  onSubtitlesRef.current = props.onSubtitles;
  useEffect(() => {
    if (embedded.status !== 'done' || embedded.tracks.length === 0) return;
    const tracks: SerializedSubtitleTrack[] = [];
    for (const track of embedded.tracks) {
      const content = embedded.getTrack(track.number);
      if (content) tracks.push(serializeTrack({ id: track.id, label: track.label, language: track.language, content }));
    }
    onSubtitlesRef.current?.({ tracks, fonts: embedded.fonts.map((font) => ({ name: font.name, data: font.data })) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the scan is complete
  }, [embedded.status]);

  // Remember the position on unmount and on tab hide. Read the element at
  // SAVE time: at mount it does not exist yet.
  useEffect(() => {
    if (!resumeKey) return;
    const save = () => {
      const video = videoRef.current;
      if (video && Number.isFinite(video.duration)) rememberPosition(resumeKey, video.currentTime, video.duration);
    };
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      save();
    };
  }, [resumeKey]);

  // ── volume (mine only) ─────────────────────────────────────────────────
  const audioRoutedRef = useRef(false);
  const applyVolume = useCallback(() => {
    const video = videoRef.current;
    if (!video || !audioRoutedRef.current) return;
    audioRouteFor(video).setVolume(muted ? 0 : volume);
  }, [muted, volume]);
  useEffect(applyVolume, [applyVolume]);

  const play = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!audioRoutedRef.current) {
      // Inside the gesture's activation: the AudioContext may start running.
      audioRouteFor(video);
      audioRoutedRef.current = true;
      applyVolume();
    }
    await resumeAudio();
    await video.play().catch((reason: unknown) => setError(String(reason)));
  }, [applyVolume]);

  // A live stream: attach it and start playing (the click that opened the
  // share usually allows sound; if the browser still refuses, offer a tap).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void play().then(
      () => setNeedsTap(video.paused),
      () => setNeedsTap(true),
    );
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-attach only when the stream changes
  }, [stream]);

  const shownTime = props.remote && (stream || locked || remoteControl) ? props.remote.time : time;
  const shownDuration = props.remote && (stream || locked || remoteControl) ? (props.remote.duration ?? Number.NaN) : duration;
  const shownPlaying = props.remote && (stream || remoteControl) ? props.remote.playing : playing;

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (remoteControl) {
      remoteControl({ type: shownPlaying ? 'pause' : 'play' });
      return;
    }
    if (!video || locked) return;
    if (video.paused) void play();
    else video.pause();
  }, [locked, play, remoteControl, shownPlaying]);

  const seekBy = useCallback(
    (delta: number) => {
      if (remoteControl) {
        remoteControl({ type: 'seek', t: Math.max(0, shownTime + delta) });
        return;
      }
      const video = videoRef.current;
      if (!video || locked) return;
      video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
    },
    [locked, remoteControl, shownTime],
  );

  // ── controls visibility ───────────────────────────────────────────────
  const showControls = useCallback(() => {
    setControlsShown(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsShown(false), HIDE_AFTER_MS);
  }, []);
  // Always shown while paused or a menu is open.
  const controlsVisible = controlsShown || !playing || settingsOpen;
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  // ── fullscreen ────────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    if (isFullscreen(container, videoRef.current)) {
      enteredByRotation.current = false;
      await exitFullscreen(videoRef.current);
    } else {
      setOfferFullscreen(false);
      await enterFullscreen(container, videoRef.current);
    }
  }, []);

  useEffect(() => {
    const update = () => setFullscreen(isFullscreen(containerRef.current, videoRef.current));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  // Rotate to landscape while playing → fullscreen; back to portrait → exit
  // (only a fullscreen the rotation itself started).
  useEffect(() => {
    if (!active || !fullscreenOnRotate || typeof matchMedia !== 'function') return;
    const query = matchMedia('(orientation: landscape)');
    const onChange = async () => {
      const container = containerRef.current;
      if (!container) return;
      if (isLandscape() && playing && !isFullscreen(container, videoRef.current)) {
        const entered = await enterFullscreen(container, videoRef.current);
        enteredByRotation.current = entered;
        setOfferFullscreen(!entered);
      } else if (!isLandscape()) {
        setOfferFullscreen(false);
        if (enteredByRotation.current) {
          enteredByRotation.current = false;
          await exitFullscreen(videoRef.current);
        }
      }
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [active, fullscreenOnRotate, playing]);

  // ── keyboard (visible player only, never while typing) ────────────────
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.closest('[role="tree"], [role="tablist"], [role="menu"]'))) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          toggle();
          break;
        case 'ArrowLeft':
        case 'j':
          event.preventDefault();
          seekBy(event.key === 'j' ? -10 : -5);
          break;
        case 'ArrowRight':
        case 'l':
          event.preventDefault();
          seekBy(event.key === 'l' ? 10 : 5);
          break;
        case 'm':
          onVolumeChange(volume, !muted);
          break;
        case 'f':
          void toggleFullscreen();
          break;
        default:
          return;
      }
      showControls();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // A stream's element clock is not the file's: native cues are shifted by
  // (true time − element time), re-measured every second and re-applied when
  // it moves by more than a quarter second.
  const mediaTimeRef = useRef(props.mediaTime);
  mediaTimeRef.current = props.mediaTime;
  const following = props.mediaTime !== undefined;
  const [cueShift, setCueShift] = useState(0);
  useEffect(() => {
    if (!following) {
      setCueShift(0);
      return;
    }
    const measure = () => {
      const video = videoRef.current;
      const truth = mediaTimeRef.current?.();
      if (!video || truth === null || truth === undefined) return;
      const shift = truth - video.currentTime;
      setCueShift((current) => (Math.abs(current - shift) > 0.25 ? shift : current));
    };
    measure();
    const timer = window.setInterval(measure, 1000);
    return () => window.clearInterval(timer);
  }, [following]);

  // ── subtitles → native text tracks ────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    for (const track of Array.from(video.textTracks)) track.mode = 'disabled';
    const chosen = allTracks.find((track) => track.id === captions);
    if (!chosen) return;
    const track = video.addTextTrack('subtitles', chosen.label, chosen.language ?? '');
    for (const cue of chosen.cues) {
      const start = cue.start - cueShift;
      const end = cue.end - cueShift;
      if (end > 0) track.addCue(new VTTCue(Math.max(0, start), end, cue.text));
    }
    track.mode = 'showing';
    return () => {
      track.mode = 'disabled';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tracks change by identity of the lists
  }, [captions, props.subtitles, loadedTracks, embedded.revision, props.remoteSubtitles, cueShift]);

  const loadSubtitleFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt,.vtt,text/vtt';
    input.addEventListener('change', async () => {
      const chosen = input.files?.[0];
      if (!chosen) return;
      const cues = parseSubtitleText(await chosen.text());
      if (cues.length === 0) {
        setError(`No subtitles found in “${chosen.name}”.`);
        return;
      }
      const id = `loaded:${chosen.name}:${chosen.size}`;
      setLoadedTracks((tracks) => [...tracks.filter((track) => track.id !== id), { id, label: chosen.name, cues }]);
      setCaptions(id);
    });
    input.click();
  };

  // ── pointer: mouse clicks vs touch taps ───────────────────────────────
  const onSurfacePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return; // mouse uses click / dblclick below
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const now = performance.now();
    const previous = lastTap.current;
    if (previous && now - previous.at < DOUBLE_TAP_MS && Math.abs(previous.x - x) < 0.2) {
      window.clearTimeout(singleTapTimer.current);
      lastTap.current = null;
      const side = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center';
      if (side === 'center') toggle();
      else seekBy(side === 'left' ? -10 : 10);
      setRipple({ side, key: now });
      showControls();
      return;
    }
    lastTap.current = { at: now, x };
    singleTapTimer.current = window.setTimeout(() => {
      // A single tap only shows or hides the controls.
      if (controlsVisible && playing) {
        window.clearTimeout(hideTimer.current);
        setControlsShown(false);
      } else showControls();
    }, DOUBLE_TAP_MS);
  };

  const setRotatePreference = (value: boolean) => {
    setFullscreenOnRotate(value);
    writePreference('fullscreenOnRotate', value);
  };

  return (
    <div
      ref={containerRef}
      className='relative h-full min-h-0 select-none overflow-hidden bg-black'
      hidden={!active}
      data-player={resumeKey}
      onPointerMove={(event) => {
        if (event.pointerType === 'mouse') showControls();
      }}
    >
      {/* Video surface: owns taps/clicks; the controls sit above it. */}
      <div
        className='absolute inset-0 flex items-center justify-center'
        onPointerDown={(event) => {
          if (event.pointerType === 'touch') lastTouchAt.current = performance.now();
        }}
        onPointerUp={onSurfacePointerUp}
        onClick={() => {
          if (fromTouch()) return;
          setSettingsOpen(false);
          toggle();
        }}
        onDoubleClick={() => {
          if (fromTouch()) return;
          void toggleFullscreen();
        }}
      >
        {(url || stream) && (
          <video
            ref={setVideo}
            src={url ?? undefined}
            playsInline
            // Fill the player, keeping the aspect ratio: a 480p file or a
            // stream still ramping up (it starts small) must not sit in a
            // little box in the middle.
            className='h-full w-full object-contain'
            onPlay={() => {
              setPlaying(true);
              showControls();
            }}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            onDurationChange={(event) => setDuration(event.currentTarget.duration)}
            onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)}
            onLoadedMetadata={(event) => {
              if (!resumeKey) return;
              const saved = resumePosition(resumeKey);
              if (saved !== null && saved < event.currentTarget.duration - 30) {
                event.currentTarget.currentTime = saved;
                setResumedAt(saved);
              }
            }}
            onError={(event) => {
              const code = event.currentTarget.error?.code;
              setError(
                code === 4
                  ? 'This browser cannot play this file (its video or audio codec is not supported).'
                  : 'The video could not be read.',
              );
            }}
            onEnded={() => {
              if (!locked && !remoteControl) props.onNext?.();
            }}
          />
        )}
        <AssLayer video={videoElement} script={assScript} fonts={assFonts} timeSource={props.mediaTime} />
        {ripple && (
          <div
            key={ripple.key}
            className={`pointer-events-none absolute top-1/2 -translate-y-1/2 animate-ping rounded-full bg-white/25 px-5 py-4 text-[18px] ${
              ripple.side === 'left' ? 'left-[12%]' : ripple.side === 'right' ? 'right-[12%]' : 'left-1/2 -translate-x-1/2'
            }`}
            onAnimationIteration={() => setRipple(null)}
          >
            {ripple.side === 'left' ? '⏪ 10' : ripple.side === 'right' ? '10 ⏩' : playing ? '▶' : '⏸'}
          </div>
        )}
      </div>

      {error && (
        <div className='absolute inset-x-4 top-4 rounded border border-status-errored/60 bg-status-errored/15 px-3 py-2 text-[13px]'>
          {error}
          <button type='button' className='ml-2 cursor-pointer text-primary-light-gray' onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
      {needsTap && (
        <button
          type='button'
          className='absolute inset-0 m-auto h-24 w-56 cursor-pointer rounded-xl bg-accent text-[17px] font-semibold text-primary-black shadow-2xl'
          onClick={() => {
            void play().then(() => setNeedsTap(Boolean(videoRef.current?.paused)));
          }}
        >
          ▶ Tap to start watching
        </button>
      )}
      {offerFullscreen && (
        <button
          type='button'
          className='absolute top-4 right-4 cursor-pointer rounded-full bg-accent px-4 py-2 text-[14px] text-primary-black shadow-lg'
          onClick={() => void toggleFullscreen()}
        >
          ⛶ Tap for fullscreen
        </button>
      )}
      {resumedAt !== null && !playing && (
        <div className='absolute top-4 left-4 flex items-center gap-2 rounded bg-secondary-black/90 px-3 py-1.5 text-[12px] pointer-coarse:text-[14px]'>
          Resumed at {formatTime(resumedAt)}
          <button
            type='button'
            className='cursor-pointer text-accent hover:underline'
            onClick={() => {
              if (videoRef.current) videoRef.current.currentTime = 0;
              setResumedAt(null);
            }}
          >
            Start over
          </button>
        </div>
      )}

      {/* Overlay controls: fade out while playing, back on mouse move / tap. */}
      <div
        className={`absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-3 pt-8 pb-2 transition-opacity duration-200 ${
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        } ${fullscreen ? 'pb-[max(0.5rem,env(safe-area-inset-bottom))]' : ''}`}
        onPointerDown={showControls}
      >
        <input
          type='range'
          aria-label='Seek'
          min={0}
          max={Number.isFinite(shownDuration) ? shownDuration : 0}
          step={0.1}
          value={Math.min(shownTime, Number.isFinite(shownDuration) ? shownDuration : shownTime)}
          disabled={locked || !Number.isFinite(shownDuration)}
          onChange={(event) => {
            const target = Number(event.currentTarget.value);
            if (remoteControl) remoteControl({ type: 'seek', t: target });
            else if (videoRef.current) videoRef.current.currentTime = target;
          }}
          className='h-4 w-full cursor-pointer accent-accent pointer-coarse:h-7'
        />
        <div className='flex items-center gap-1'>
          {locked && <span title='The sharer controls playback'>🔒</span>}
          <button type='button' className={BUTTON} disabled={locked} onClick={toggle} aria-label={shownPlaying ? 'Pause' : 'Play'}>
            {shownPlaying ? '⏸' : '▶'}
          </button>
          <button type='button' className={`${BUTTON} max-sm:hidden`} disabled={locked} onClick={() => seekBy(-10)} aria-label='Back 10 seconds'>
            ⏪10
          </button>
          <button type='button' className={`${BUTTON} max-sm:hidden`} disabled={locked} onClick={() => seekBy(10)} aria-label='Forward 10 seconds'>
            10⏩
          </button>
          {props.onNext && !locked && !remoteControl && (
            <button type='button' className={BUTTON} onClick={props.onNext} aria-label='Next file'>
              ⏭
            </button>
          )}
          <span className='min-w-0 truncate px-1 text-[12px] text-primary-white/80 tabular-nums pointer-coarse:text-[13px]'>
            {formatTime(shownTime)} / {formatTime(shownDuration)}
            {stream && <span className='ml-1 rounded bg-status-errored/80 px-1 text-[10px] text-white'>LIVE</span>}
          </span>
          <span className='flex-1' />
          <button
            type='button'
            className={BUTTON}
            onClick={() => onVolumeChange(volume, !muted)}
            aria-label={muted ? 'Unmute' : 'Mute'}
            title='Your volume only'
          >
            {muted || volume === 0 ? '🔇' : '🔊'}
          </button>
          <input
            type='range'
            aria-label='Volume (yours only)'
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(event) => onVolumeChange(Number(event.currentTarget.value), false)}
            className='w-24 accent-accent max-sm:hidden'
          />
          {pickerTracks.length > 0 && (
            <button
              type='button'
              className={`${BUTTON} ${captions ? 'text-accent' : ''}`}
              aria-pressed={captions !== null}
              aria-label='Subtitles'
              onClick={() => setCaptions((current) => (current ? null : (pickerTracks[0]?.id ?? null)))}
            >
              CC
            </button>
          )}
          <div className='relative'>
            <button
              type='button'
              className={BUTTON}
              aria-label='Settings'
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              ⚙
            </button>
            {settingsOpen && (
              <div
                role='dialog'
                aria-label='Player settings'
                className='absolute right-0 bottom-full mb-2 flex w-64 flex-col gap-2 rounded-md border border-secondary-dark-gray bg-primary-dark-gray p-3 text-[13px] shadow-xl pointer-coarse:w-72 pointer-coarse:text-[15px]'
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setSettingsOpen(false);
                }}
              >
                <label className='flex items-center justify-between gap-2'>
                  Speed
                  <select
                    disabled={locked || Boolean(stream)}
                    value={speed}
                    onChange={(event) => {
                      const rate = Number(event.currentTarget.value);
                      if (remoteControl) remoteControl({ type: 'rate', rate });
                      else if (videoRef.current) videoRef.current.playbackRate = rate;
                    }}
                    className='rounded bg-secondary-black px-2 py-1 disabled:opacity-40'
                  >
                    {SPEEDS.map((value) => (
                      <option key={value} value={value}>
                        {value}×
                      </option>
                    ))}
                  </select>
                </label>
                <label className='flex items-center justify-between gap-2'>
                  Subtitles
                  <select
                    aria-label='Subtitle track'
                    value={captions ?? ''}
                    onChange={(event) => setCaptions(event.currentTarget.value || null)}
                    className='max-w-36 rounded bg-secondary-black px-2 py-1'
                  >
                    <option value=''>Off</option>
                    {pickerTracks.map((track) => (
                      <option key={track.id} value={track.id}>
                        {track.label}
                      </option>
                    ))}
                  </select>
                </label>
                {embedded.status === 'scanning' && (
                  <p className='text-[12px] text-primary-light-gray'>
                    Reading subtitles from the file… {Math.round(embedded.progress * 100)}%
                  </p>
                )}
                <button type='button' className='cursor-pointer self-start text-accent hover:underline' onClick={loadSubtitleFile}>
                  Load subtitle file (.srt, .vtt)…
                </button>
                <label className='flex items-center justify-between gap-2 sm:hidden'>
                  Your volume
                  <input
                    type='range'
                    min={0}
                    max={1}
                    step={0.01}
                    value={muted ? 0 : volume}
                    onChange={(event) => onVolumeChange(Number(event.currentTarget.value), false)}
                    className='w-32 accent-accent'
                  />
                </label>
                <label className='flex items-center justify-between gap-2'>
                  Fullscreen when rotated
                  <input
                    type='checkbox'
                    checked={fullscreenOnRotate}
                    onChange={(event) => setRotatePreference(event.currentTarget.checked)}
                    className='h-4 w-4 accent-accent'
                  />
                </label>
              </div>
            )}
          </div>
          <button
            type='button'
            className={BUTTON}
            onClick={() => void toggleFullscreen()}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? '🗗' : '⛶'}
          </button>
          {props.extraControls}
        </div>
      </div>
    </div>
  );
}

export { formatTime, VideoPlayer };
export type { PlayerCommand, SubtitlePayload, SubtitleTrackInput, VideoPlayerProps };
