import { useEffect, useId, useRef, useState } from 'react';
import { checkRelay, saveRelay, savedRelay, validateRelay } from './relaySettings';
import type { RelaySetting } from './relaySettings';

/**
 * Settings → Connection: the user's own relay (TURN) server (Q-NET-1 C).
 * Optional; saved in this browser; used from the next join. For networks
 * that cannot connect directly (strict mobile networks, some offices).
 */

const FIELD =
  'w-full rounded-lg border border-secondary-dark-gray bg-primary-black px-3 py-2 font-mono text-[13px] text-primary-white outline-none focus:border-accent pointer-coarse:py-3 pointer-coarse:text-[15px]';
const BUTTON =
  'cursor-pointer rounded-full border border-accent/30 px-4 py-2 text-[13px] text-accent transition-colors hover:bg-white/[0.06] disabled:cursor-default disabled:opacity-40 pointer-coarse:py-3';
const PRIMARY =
  'cursor-pointer rounded-full border border-accent/50 bg-white/[0.07] px-5 py-2 text-[13px] font-medium text-primary-white transition-colors hover:bg-white/[0.14] disabled:cursor-default disabled:opacity-40 pointer-coarse:py-3';

function ConnectionSettings({ onClose, inRoom }: { onClose(): void; inRoom: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const saved = savedRelay();
  const [setting, setSetting] = useState<RelaySetting>(saved ?? { url: '', username: '', credential: '' });
  const [check, setCheck] = useState<{ busy: boolean; ok?: boolean; detail?: string }>({ busy: false });
  const [savedNote, setSavedNote] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const invalid = setting.url.trim() ? validateRelay(setting) : null;
  const update = (patch: Partial<RelaySetting>) => {
    setSetting((current) => ({ ...current, ...patch }));
    setCheck({ busy: false });
    setSavedNote(null);
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className='m-auto w-[480px] max-w-[calc(100vw-24px)] rounded-[20px] border border-accent/30 bg-[#120b09] p-5 text-primary-white shadow-[0_30px_80px_rgba(0,0,0,0.75)] backdrop:bg-black/70'
    >
      <div className='flex flex-col gap-4'>
        <h2 id={titleId} className='font-serif text-[20px]'>
          Connection
        </h2>
        <p className='text-[13px] leading-relaxed text-primary-light-gray pointer-coarse:text-[14px]'>
          Rooms connect people directly. Some networks — many mobile carriers, some offices — can’t connect directly to each
          other. For those, add a relay (TURN) server you have an account with: it’s used only when no direct path exists,
          and video stays end-to-end encrypted. Or join the same Wi-Fi, or use one phone’s hotspot.
        </p>
        <label className='flex flex-col gap-1 text-[12px] text-primary-light-gray'>
          Relay server address
          <input
            className={FIELD}
            placeholder='turn:relay.example.com:3478  turns:relay.example.com:443'
            value={setting.url}
            autoCapitalize='none'
            autoCorrect='off'
            spellCheck={false}
            onChange={(event) => update({ url: event.currentTarget.value })}
          />
        </label>
        <div className='grid gap-3 sm:grid-cols-2'>
          <label className='flex flex-col gap-1 text-[12px] text-primary-light-gray'>
            Username
            <input
              className={FIELD}
              value={setting.username}
              autoCapitalize='none'
              autoCorrect='off'
              spellCheck={false}
              onChange={(event) => update({ username: event.currentTarget.value })}
            />
          </label>
          <label className='flex flex-col gap-1 text-[12px] text-primary-light-gray'>
            Password
            <input
              className={FIELD}
              type='password'
              value={setting.credential}
              onChange={(event) => update({ credential: event.currentTarget.value })}
            />
          </label>
        </div>
        {invalid && <p className='text-[12px] text-status-warning'>{invalid}</p>}
        {check.detail && (
          <p role='status' className={`text-[13px] ${check.ok ? 'text-status-completed' : 'text-status-errored'}`}>
            {check.ok ? '✓ ' : '✕ '}
            {check.detail}
          </p>
        )}
        {savedNote && (
          <p role='status' className='text-[13px] text-status-completed'>
            {savedNote}
          </p>
        )}
        <div className='flex flex-wrap items-center justify-end gap-2'>
          {saved && (
            <button
              type='button'
              className={`${BUTTON} mr-auto border-status-errored/40 text-status-errored`}
              onClick={() => {
                saveRelay(null);
                setSetting({ url: '', username: '', credential: '' });
                setSavedNote('Relay removed.');
              }}
            >
              Remove
            </button>
          )}
          <button
            type='button'
            className={BUTTON}
            disabled={check.busy || !setting.url.trim() || invalid !== null}
            onClick={() => {
              setCheck({ busy: true });
              void checkRelay(setting).then((result) => setCheck({ busy: false, ...result }));
            }}
          >
            {check.busy ? 'Checking…' : 'Check relay'}
          </button>
          <button type='button' className={BUTTON} onClick={onClose}>
            Close
          </button>
          <button
            type='button'
            className={PRIMARY}
            disabled={!setting.url.trim() || invalid !== null}
            onClick={() => {
              saveRelay(setting);
              setSavedNote(inRoom ? 'Saved — used the next time you join a room.' : 'Saved — used when you join or start a room.');
            }}
          >
            Save
          </button>
        </div>
      </div>
    </dialog>
  );
}

export { ConnectionSettings };
