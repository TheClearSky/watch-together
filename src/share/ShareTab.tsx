import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FileLibrary } from '@theclearsky/easy-folder-management-ui';
import { EmptyState } from '@theclearsky/easy-folder-management-ui/ui';
import type { OpenedFiles } from '../library/openedFiles';
import { formatTime, VideoPlayer } from '../player/VideoPlayer';
import type { SubtitlePayload } from '../player/VideoPlayer';
import type { LocalCopy } from './findLocalCopy';
import { findLocalCopy, matchesShare } from './findLocalCopy';
import { useLocalSync } from './localSync';
import type { ShareController } from './shareController';

/**
 * Someone else's shared tab, as I watch it (Q2: stream OR my own copy).
 *
 *  - STREAM: the sharer's video arrives live; nothing needed on my side.
 *  - MY COPY: I play my own identical file, kept in time (localSync).
 *
 * When my library or opened files hold the same file (same size and sampled
 * hash), a banner SUGGESTS switching (Q7: "suggest switching to local copy if
 * hashes match") — it never switches on its own. I can also pick a file by
 * hand; a different file is refused with a clear message.
 */

type ShareTabProps = {
  shareId: string;
  shares: ShareController;
  library: FileLibrary;
  openedFiles: OpenedFiles;
  volume: number;
  muted: boolean;
  onVolumeChange(volume: number, muted: boolean): void;
  /** Toolbar content added by the app (Download button). */
  extraControls?: React.ReactNode;
  /** The sharer's embedded subtitles (stream mode has no file to read). */
  remoteSubtitles?: SubtitlePayload | null;
  /** Ask the sharer for them (called once the stream is watched). */
  onRequestSubtitles?(): void;
};

const BAR_BUTTON =
  'cursor-pointer rounded px-3 py-1.5 text-[13px] hover:bg-white/10 disabled:cursor-default disabled:opacity-40 pointer-coarse:py-2.5 pointer-coarse:text-[15px]';

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,.mkv,.webm,.mp4,.m4v,.mov';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

function ShareTab(props: ShareTabProps) {
  const { shareId, shares } = props;
  const snapshot = useSyncExternalStore(shares.subscribe, shares.getSnapshot);
  const view = snapshot.shares.find((share) => share.shareId === shareId) ?? shares.view(shareId);
  const [mode, setMode] = useState<'stream' | 'local' | null>(null);
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [suggestion, setSuggestion] = useState<LocalCopy | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const [tick, setTick] = useState(0);
  const clock = shares.clock(shareId);
  const hasControl = shares.hasControl(shareId);
  // Streaming needs a DIRECT connection to the sharer; over the relay bus only
  // "My copy" works. `tick` re-reads it as the connection settles.
  const canStream = shares.canStreamFrom(shareId);
  void tick;

  // Default mode: stream when we actually can; otherwise ask for a copy.
  useEffect(() => {
    if (mode === null && view && !view.ended) setMode(canStream ? 'stream' : null);
  }, [mode, view, canStream]);

  // Stream mode has no file to read subtitles from: ask the sharer (again
  // after a reconnect, and when the share moves to another video — the
  // relay pushes those itself once asked).
  const requestSubtitles = useRef(props.onRequestSubtitles);
  requestSubtitles.current = props.onRequestSubtitles;
  useEffect(() => {
    if (mode === 'stream' && view && !view.lost && !view.ended) requestSubtitles.current?.();
  }, [mode, view?.lost, view?.ended, view?.sharer, view]);

  useEffect(() => {
    if (mode === 'stream') shares.watchStream(shareId);
    else shares.stopStream(shareId);
    if (mode) shares.startClock(shareId);
  }, [mode, shareId, shares]);

  useEffect(
    () => () => {
      shares.stopStream(shareId);
      shares.stopClock(shareId);
    },
    [shareId, shares],
  );

  // Look for my own copy once the fingerprint is known (and again if the
  // sharer moves to another file).
  const fingerprintKey = view?.fingerprint ? `${view.fingerprint.size}:${view.fingerprint.sampleHash}` : null;
  useEffect(() => {
    setSuggestion(null);
    if (!view?.fingerprint) return;
    let cancelled = false;
    void findLocalCopy(view.fingerprint, { openedFiles: props.openedFiles, library: props.library }).then((copy) => {
      if (!cancelled) setSuggestion(copy);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the fingerprint
  }, [fingerprintKey]);

  // The sharer's file changed: my copy is the wrong one now.
  useEffect(() => {
    if (mode === 'local' && localFile && view?.fingerprint && localFile.size !== view.fingerprint.size) {
      setLocalFile(null);
      setMode(canStream ? 'stream' : null);
      setMessage(`${view.sharerName} switched to “${view.title}”.`);
    }
  }, [view?.fingerprint, localFile, mode, view]);

  useLocalSync({ element, state: view?.state ?? null, clock, enabled: mode === 'local' && !!localFile });

  // A ticking clock for the live time shown over a stream.
  useEffect(() => {
    if (mode !== 'stream') return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 500);
    return () => window.clearInterval(timer);
  }, [mode]);

  const remote = useMemo(() => {
    const state = view?.state;
    if (!state) return null;
    const remoteNow = clock.remoteNow(Date.now()) ?? state.at;
    const time = state.playing ? state.t + ((remoteNow - state.at) / 1000) * state.rate : state.t;
    return { time: Math.max(0, time), duration: view?.duration ?? null, playing: state.playing };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` re-evaluates the live time
  }, [view?.state, view?.duration, tick, clock]);

  // The sharer's media time right now, from the synced clock (exact, not
  // the half-second display tick) — stream subtitles follow it.
  const stateRef = useRef(view?.state ?? null);
  stateRef.current = view?.state ?? null;
  const mediaTime = useMemo(
    () => () => {
      const state = stateRef.current;
      if (!state) return null;
      const remoteNow = clock.remoteNow(Date.now()) ?? state.at;
      return Math.max(0, state.playing ? state.t + ((remoteNow - state.at) / 1000) * state.rate : state.t);
    },
    [clock],
  );

  if (!view || view.ended) {
    return (
      <EmptyState
        icon='📡'
        title={view ? `${view.sharerName} stopped sharing “${view.title}”` : 'This share has ended'}
        rows={[{ label: 'Close this tab when you are done', hint: '✕ on the tab' }]}
      />
    );
  }

  const useCopy = async (file: File) => {
    if (!view.fingerprint) {
      setMessage('Still checking the shared file — try again in a moment.');
      return;
    }
    if (!(await matchesShare(file, view.fingerprint))) {
      setMessage(`“${file.name}” is not the same file as “${view.title}” (different size or contents).`);
      return;
    }
    setLocalFile(file);
    setMode('local');
    setMessage(null);
  };

  const stream = snapshot.streams.get(shareId) ?? null;
  const controls = hasControl ? 'remote' : 'locked';
  const onCommand = hasControl ? (command: Parameters<ShareController['sendControl']>[1]) => shares.sendControl(shareId, command) : undefined;

  const bar = (
    <div className='flex flex-wrap items-center gap-1 border-b border-secondary-dark-gray bg-secondary-black px-2 py-1 text-[12px] pointer-coarse:text-[14px]'>
      <span className='px-1 text-primary-light-gray'>
        📡 <strong className='text-primary-white'>{view.sharerName}</strong> · {view.title}
        {view.lost && <span className='ml-2 text-status-warning'>connection lost — waiting…</span>}
      </span>
      <span className='flex-1' />
      <span className='flex items-center gap-1 rounded bg-primary-black p-0.5' role='radiogroup' aria-label='Source'>
        <button
          type='button'
          role='radio'
          aria-checked={mode === 'stream'}
          disabled={!canStream}
          title={
            canStream
              ? 'Watch the sharer’s live stream'
              : view.streamable
                ? 'No direct connection to the sharer (e.g. mobile data) — use your own copy, or add a relay in Connection settings'
                : 'This sharer’s browser cannot stream — use your own copy'
          }
          className={`${BAR_BUTTON} ${mode === 'stream' ? 'bg-primary-dark-gray text-primary-white' : 'text-primary-light-gray'}`}
          onClick={() => setMode('stream')}
        >
          Stream
        </button>
        <button
          type='button'
          role='radio'
          aria-checked={mode === 'local'}
          className={`${BAR_BUTTON} ${mode === 'local' ? 'bg-primary-dark-gray text-primary-white' : 'text-primary-light-gray'}`}
          onClick={() => {
            if (localFile) setMode('local');
            else if (suggestion) void useCopy(suggestion.file);
            else void pickFile().then((file) => file && useCopy(file));
          }}
        >
          My copy
        </button>
      </span>
      {!hasControl && (
        <button
          type='button'
          className={BAR_BUTTON}
          disabled={snapshot.controlPending.has(shareId) || (view.controller !== null && view.controller !== shares.myId)}
          onClick={() => shares.requestControl(shareId)}
        >
          {snapshot.controlPending.has(shareId) ? 'Asked for control…' : '✋ Ask for control'}
        </button>
      )}
      {hasControl && <span className='px-2 text-status-completed'>You have control</span>}
      {props.extraControls}
    </div>
  );

  return (
    <div className='flex h-full min-h-0 flex-col'>
      {bar}
      {suggestion && mode !== 'local' && (
        <div className='flex flex-wrap items-center gap-2 bg-accent/15 px-3 py-2 text-[13px] pointer-coarse:text-[15px]'>
          <span className='flex-1'>
            🎞 You have this video{suggestion.kind === 'file' ? ' in your library' : ''} — play your own copy in original
            quality, kept in sync with {view.sharerName}?
          </span>
          <button type='button' className={`${BAR_BUTTON} bg-accent text-primary-black`} onClick={() => void useCopy(suggestion.file)}>
            Use my copy
          </button>
          <button type='button' className={BAR_BUTTON} onClick={() => setSuggestion(null)}>
            Keep streaming
          </button>
        </div>
      )}
      {message && (
        <div className='flex items-center gap-2 bg-status-warning/10 px-3 py-2 text-[13px]'>
          <span className='flex-1'>{message}</span>
          <button type='button' className={BAR_BUTTON} onClick={() => setMessage(null)}>
            ✕
          </button>
        </div>
      )}
      <div className='relative min-h-0 flex-1'>
        {mode === 'stream' && (
          <VideoPlayer
            stream={stream}
            remoteSubtitles={props.remoteSubtitles}
            mediaTime={mediaTime}
            active
            volume={props.volume}
            muted={props.muted}
            onVolumeChange={props.onVolumeChange}
            controls={controls}
            onCommand={onCommand}
            remote={remote}
            onElement={setElement}
          />
        )}
        {mode === 'local' && localFile && (
          <VideoPlayer
            file={localFile}
            active
            volume={props.volume}
            muted={props.muted}
            onVolumeChange={props.onVolumeChange}
            controls={controls}
            onCommand={onCommand}
            remote={remote}
            onElement={setElement}
          />
        )}
        {mode === 'stream' && !stream && (
          <div className='pointer-events-none absolute inset-x-0 top-1/3 text-center text-[14px] text-primary-light-gray'>
            Connecting to {view.sharerName}’s stream…
          </div>
        )}
        {mode === null && (
          <EmptyState
            icon='🎞'
            title={`${view.sharerName} is sharing “${view.title}”`}
            rows={[
              {
                label: 'Play your own copy of this video',
                hint: suggestion ? 'found it on your device' : 'pick the file',
                onClick: () => {
                  if (suggestion) void useCopy(suggestion.file);
                  else void pickFile().then((file) => file && useCopy(file));
                },
              },
              ...(view.state ? [{ label: 'Their position', hint: formatTime(view.state.t) }] : []),
            ]}
          />
        )}
      </div>
    </div>
  );
}

export { ShareTab };
