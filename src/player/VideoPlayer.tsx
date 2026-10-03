import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Cue } from '../media/subtitleText';
import { rememberPosition, resumePosition } from '../storage';
import { audioRouteFor, resumeAudio } from './audioRouting';

/**
 * One video tab's player: a `<video>` over a disk-backed File (an object URL
 * streams it — nothing is read into memory), custom controls, and the
 * keyboard. Volume is MY volume, through Web Audio (see audioRouting.ts).
 *
 * `controls: 'locked'` is a viewer of someone else's share: the sharer
 * drives play/pause/seek; volume, captions and fullscreen stay mine.
 */

type SubtitleTrackInput = { id: string; label: string; language?: string; cues: readonly Cue[] };

type VideoPlayerProps = {
  file: File;
  /** Library path, for the remembered position. */
  resumeKey: string;
  active: boolean;
  volume: number;
  muted: boolean;
  onVolumeChange(volume: number, muted: boolean): void;
  onNext?(): void;
  subtitles?: readonly SubtitleTrackInput[];
  controls?: 'full' | 'locked';
  /** Rendered in the control bar's right side (Share button, status…). */
  extraControls?: ReactNode;
  /** The element, once mounted (sharing captures it). */
  onElement?(element: HTMLVideoElement | null): void;
};

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const BUTTON =
  'flex h-8 min-w-8 cursor-pointer items-center justify-center rounded px-2 text-[13px] text-primary-white hover:bg-secondary-dark-gray disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function VideoPlayer(props: VideoPlayerProps) {
  const { file, resumeKey, active, volume, muted, onVolumeChange } = props;
  const locked = props.controls === 'locked';
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

  // An object URL per File; revoked when the file changes or the tab closes.
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    setError(null);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  // The element exists only once the object URL does, so it is reported
  // from the ref callback, not a mount effect (which would see null).
  const onElementRef = useRef(props.onElement);
  onElementRef.current = props.onElement;
  const setVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    onElementRef.current?.(element);
  }, []);

  // Remember the position on unmount and on tab hide. Read the element at
  // SAVE time: at mount it does not exist yet.
  useEffect(() => {
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

  // My volume: the Web Audio gain once routed (after the first play).
  const applyVolume = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const route = audioRoutedRef.current ? audioRouteFor(video) : null;
    if (route) route.setVolume(muted ? 0 : volume);
  }, [muted, volume]);
  const audioRoutedRef = useRef(false);
  useEffect(applyVolume, [applyVolume]);

  const play = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!audioRoutedRef.current) {
      // Inside the click's activation: the AudioContext may start running.
      audioRouteFor(video);
      audioRoutedRef.current = true;
      applyVolume();
    }
    await resumeAudio();
    await video.play().catch((reason: unknown) => setError(String(reason)));
  }, [applyVolume]);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video || locked) return;
    if (video.paused) void play();
    else video.pause();
  }, [locked, play]);

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video || locked) return;
      video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
    },
    [locked],
  );

  // Keyboard, only for the visible player and never while typing.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.closest('[role="tree"]'))) return;
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Sidecar subtitles → native text tracks.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    for (const track of Array.from(video.textTracks)) track.mode = 'disabled';
    const chosen = props.subtitles?.find((track) => track.id === captions);
    if (!chosen) return;
    const track = video.addTextTrack('subtitles', chosen.label, chosen.language ?? '');
    for (const cue of chosen.cues) track.addCue(new VTTCue(cue.start, cue.end, cue.text));
    track.mode = 'showing';
    return () => {
      track.mode = 'disabled';
    };
  }, [captions, props.subtitles]);

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    else await container.requestFullscreen().catch(() => {});
  };

  return (
    <div
      ref={containerRef}
      className='relative flex h-full min-h-0 flex-col bg-black'
      hidden={!active}
      data-player={resumeKey}
    >
      <div className='relative flex min-h-0 flex-1 items-center justify-center'>
        {url && (
          <video
            ref={setVideo}
            src={url}
            playsInline
            className='max-h-full max-w-full'
            onClick={toggle}
            onDoubleClick={() => void toggleFullscreen()}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            onDurationChange={(event) => setDuration(event.currentTarget.duration)}
            onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)}
            onLoadedMetadata={(event) => {
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
            onEnded={() => props.onNext?.()}
          />
        )}
        {error && (
          <div className='absolute inset-x-6 top-6 rounded border border-status-errored/60 bg-status-errored/15 px-3 py-2 text-[13px]'>
            {error}
          </div>
        )}
        {resumedAt !== null && !playing && (
          <div className='absolute bottom-4 left-4 flex items-center gap-2 rounded bg-secondary-black/90 px-3 py-1.5 text-[12px]'>
            Resumed at {formatTime(resumedAt)}
            <button
              type='button'
              className='cursor-pointer text-primary-blue hover:underline'
              onClick={() => {
                if (videoRef.current) videoRef.current.currentTime = 0;
                setResumedAt(null);
              }}
            >
              Start over
            </button>
          </div>
        )}
      </div>

      <div className='flex flex-none flex-col gap-1 border-t border-secondary-dark-gray bg-secondary-black px-3 py-2'>
        <input
          type='range'
          aria-label='Seek'
          min={0}
          max={Number.isFinite(duration) ? duration : 0}
          step={0.1}
          value={time}
          disabled={locked || !Number.isFinite(duration)}
          onChange={(event) => {
            if (videoRef.current) videoRef.current.currentTime = Number(event.currentTarget.value);
          }}
          className='w-full accent-primary-blue'
        />
        <div className='flex flex-wrap items-center gap-1'>
          {locked && <span title='The sharer controls playback'>🔒</span>}
          <button type='button' className={BUTTON} disabled={locked} onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '⏸' : '▶'}
          </button>
          <button type='button' className={BUTTON} disabled={locked} onClick={() => seekBy(-10)} aria-label='Back 10 seconds'>
            ⏪10
          </button>
          <button type='button' className={BUTTON} disabled={locked} onClick={() => seekBy(10)} aria-label='Forward 10 seconds'>
            10⏩
          </button>
          {props.onNext && (
            <button type='button' className={BUTTON} disabled={locked} onClick={props.onNext} aria-label='Next file'>
              ⏭
            </button>
          )}
          <span className='px-2 text-[12px] text-primary-light-gray tabular-nums'>
            {formatTime(time)} / {formatTime(duration)}
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
            className='w-24 accent-primary-blue'
          />
          <select
            aria-label='Speed'
            disabled={locked}
            value={speed}
            onChange={(event) => {
              if (videoRef.current) videoRef.current.playbackRate = Number(event.currentTarget.value);
            }}
            className='h-8 rounded bg-primary-dark-gray px-1 text-[12px] text-primary-white disabled:opacity-40'
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
          {props.subtitles && props.subtitles.length > 0 && (
            <select
              aria-label='Subtitles'
              value={captions ?? ''}
              onChange={(event) => setCaptions(event.currentTarget.value || null)}
              className='h-8 max-w-40 rounded bg-primary-dark-gray px-1 text-[12px] text-primary-white'
            >
              <option value=''>CC off</option>
              {props.subtitles.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.label}
                </option>
              ))}
            </select>
          )}
          <button type='button' className={BUTTON} onClick={() => void toggleFullscreen()} aria-label='Fullscreen'>
            ⛶
          </button>
          {props.extraControls}
        </div>
      </div>
    </div>
  );
}

export { formatTime, VideoPlayer };
export type { SubtitleTrackInput, VideoPlayerProps };
