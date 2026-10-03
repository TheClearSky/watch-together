import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ShareController } from '../share/shareController';
import type { Downloads } from '../transfer/downloads';
import { TransferRow } from '../transfer/TransferRow';
import { Avatar } from '../social/Avatar';
import type { RoomChat } from './chat';

const SMALL_BUTTON =
  'cursor-pointer rounded px-2 py-1 text-[12px] hover:bg-secondary-dark-gray disabled:cursor-default disabled:opacity-40 pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-[14px]';
const SECTION_TITLE = 'mb-2 text-[11px] font-semibold tracking-[0.12em] text-primary-light-gray uppercase';
const noop = () => () => {};
const emptyTransfers = () => [] as const;

/** What is being shared in the room, and my own shares with their controls. */
function SharesSection({
  shares,
  downloads,
  nameOf,
  onWatch,
  onGoToTab,
}: {
  shares: ShareController;
  downloads?: Downloads | null;
  nameOf(memberId: string): string;
  onWatch(shareId: string): void;
  onGoToTab(tabId: string): void;
}) {
  const snapshot = useSyncExternalStore(shares.subscribe, shares.getSnapshot);
  const transfers = useSyncExternalStore(downloads?.subscribe ?? noop, downloads?.getSnapshot ?? emptyTransfers);
  const outgoing = transfers.filter((transfer) => transfer.direction === 'out');
  return (
    <>
      {snapshot.mine.length > 0 && (
        <section className='border-b border-secondary-dark-gray p-3'>
          <h3 className={SECTION_TITLE}>You are sharing</h3>
          <ul className='flex flex-col gap-3'>
            {snapshot.mine.map((share) => (
              <li key={share.shareId} className='flex flex-col gap-1'>
                <div className='flex items-center gap-2'>
                  <span className='min-w-0 flex-1 truncate'>📡 {share.title}</span>
                  <span className='text-[11px] text-primary-light-gray'>
                    {share.streamViewers} streaming
                  </span>
                </div>
                <div className='flex flex-wrap gap-1'>
                  <button type='button' className={SMALL_BUTTON} onClick={() => onGoToTab(share.tabId)}>
                    Go to tab
                  </button>
                  {share.controller && (
                    <button type='button' className={SMALL_BUTTON} onClick={() => shares.grantControl(share.shareId, null)}>
                      Take back control from {nameOf(share.controller)}
                    </button>
                  )}
                  <button type='button' className={`${SMALL_BUTTON} text-status-errored`} onClick={() => shares.stopShare(share.shareId)}>
                    Stop sharing
                  </button>
                </div>
                {outgoing
                  .filter((transfer) => transfer.shareId === share.shareId)
                  .map((transfer) => (
                    <TransferRow key={transfer.id} transfer={transfer} downloads={downloads!} />
                  ))}
                {share.controlRequests.map((request) => (
                  <div key={request.memberId} className='flex items-center gap-2 rounded bg-status-warning/10 px-2 py-1'>
                    <span className='flex-1'>✋ {request.name} asks for control</span>
                    <button type='button' className={SMALL_BUTTON} onClick={() => shares.denyControl(share.shareId, request.memberId)}>
                      No
                    </button>
                    <button
                      type='button'
                      className={`${SMALL_BUTTON} bg-accent text-primary-black`}
                      onClick={() => shares.grantControl(share.shareId, request.memberId)}
                    >
                      Allow
                    </button>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className='border-b border-secondary-dark-gray p-3'>
        <h3 className={SECTION_TITLE}>Shared in the room</h3>
        {snapshot.shares.length === 0 ? (
          <p className='text-primary-light-gray'>
            Nothing yet. Open a video and press <strong>📡 Share</strong> in the player to watch it together.
          </p>
        ) : (
          <ul className='flex flex-col gap-2'>
            {snapshot.shares.map((share) => (
              <li key={share.shareId} className='flex items-center gap-2'>
                <span className='min-w-0 flex-1 truncate'>
                  📡 {share.title}
                  <span className='text-primary-light-gray'> — {share.sharerName}</span>
                  {share.lost && <span className='text-status-warning'> (reconnecting)</span>}
                </span>
                <button type='button' className={`${SMALL_BUTTON} bg-accent text-primary-black`} onClick={() => onWatch(share.shareId)}>
                  Watch
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Room chat (ephemeral: lives only in the open pages). */
function ChatSection({ chat, seedOf }: { chat: RoomChat; seedOf?(memberId: string): number }) {
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chat.visible = true;
    chat.markRead();
    return () => {
      chat.visible = false;
    };
  }, [chat]);
  useEffect(() => {
    chat.markRead();
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [snapshot.lines.length, chat]);
  return (
    <section className='flex min-h-48 flex-col border-b border-secondary-dark-gray p-3'>
      <h3 className={SECTION_TITLE}>Chat</h3>
      <div ref={listRef} className='mb-2 max-h-64 min-h-16 flex-1 overflow-y-auto' aria-live='polite'>
        {snapshot.lines.length === 0 && <p className='text-primary-light-gray'>Say hi 👋 — messages are not saved anywhere.</p>}
        {snapshot.lines.map((line) => (
          <p key={`${line.from}:${line.id}`} className='flex items-start gap-2 py-1 break-words'>
            {seedOf && <Avatar seed={seedOf(line.from)} size={22} className='mt-0.5 flex-none' />}
            <span className='min-w-0'>
              <span className={line.mine ? 'text-accent' : 'text-status-completed'}>{line.mine ? 'You' : line.name}</span>
              <span className='text-primary-light-gray'>: </span>
              {line.text}
            </span>
          </p>
        ))}
      </div>
      <form
        className='flex gap-2'
        onSubmit={(event) => {
          event.preventDefault();
          chat.send(text);
          setText('');
        }}
      >
        <input
          aria-label='Message'
          value={text}
          maxLength={2000}
          onChange={(event) => setText(event.currentTarget.value)}
          placeholder='Message the room'
          className='min-w-0 flex-1 rounded border border-secondary-dark-gray bg-primary-black px-2 py-1.5 outline-none focus:border-accent pointer-coarse:py-2.5'
        />
        <button type='submit' className={`${SMALL_BUTTON} bg-accent text-primary-black`} disabled={!text.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}

export { ChatSection, SharesSection };
