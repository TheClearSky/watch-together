import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { RoomSession, RoomSnapshot } from '../room/session';
import { newRoomCode, normalizeRoomCode } from '../room/roomCode';
import { Avatar, AvatarStack, avatarSeed, randomAvatar } from '../social/Avatar';
import { InviteShare } from '../social/InviteShare';
import { CurtainCall, EFFECTS_CSS, EmberCard, Embers, GoldCard } from './effects';

/**
 * The front door (2026-10-03: "make the welcome page look much better, and
 * make it socializable … creating, sharing and joining a room all one click
 * with details prefilled in and editable if wanted"; style: "see the style of
 * react-blender-nodes-sound homepage and use that instead").
 *
 *  ┌──────────── stage (#0a0606, embers) ─────────────────────────────┐
 *  │  3D film reel + popcorn       │  WATCH-TOGETHER                    │
 *  │  under a spotlight            │  Movie night, from anywhere.       │
 *  │  (left half, dissolves into   │  ╔═ gold-rimmed ticket booth ════╗ │
 *  │   the page — no seam)         │  ║ (face)🔀  name ✎              ║ │
 *  │                               │  ║ room name [merry-otter-4821]🎲║ │
 *  │                               │  ║ ( Start a room › )            ║ │
 *  │                               │  ║ ── or join ── [code] (Join)   ║ │
 *  │                               │  ╚═══════════════════════════════╝ │
 *  ├──────── Pick tonight's video (ember cards) · Recent ───────────────┤
 *  ├──────── Everything it does, in plain words (ember cards) ──────────┤
 *  └──────── curtain call (curtains part on scroll) · footer ───────────┘
 */

type WelcomeShare = { shareId: string; title: string; sharerName: string; sharerSeed: number };

type WelcomeProps = {
  session: RoomSession | null;
  snapshot: RoomSnapshot | null;
  /** From an invite link (#/room/<code>), until used or dismissed. */
  inviteCode: string | null;
  onDismissInvite(): void;
  onCreate(profile: { name: string; avatar: number }, code: string): void;
  onJoin(profile: { name: string; avatar: number }, code: string): void;
  onOpenRoom(): void;
  /** Settings → Connection (the user's own relay server). */
  onOpenConnection(): void;
  shares: readonly WelcomeShare[];
  onWatch(shareId: string): void;
  onOpenVideo(): void;
  onLinkFolder(): void;
  canLinkFolders: boolean;
  recent: readonly { id: string; name: string; detail: string }[];
  onOpenRecent(id: string): void;
  onNotice(message: string): void;
};

// The 3D stage (three.js) is its own lazy chunk; until it exists — or where
// WebGL is missing — the warm CSS glow below stands in.
// (A glob, not a plain import: the build stays green whether or not the
// scene module is present.)
type BackdropModule = {
  CinemaBackdrop: React.ComponentType<{ className?: string; onReady?(ready: boolean): void }>;
};
const loadBackdrop = import.meta.glob<BackdropModule>('./scene/CinemaBackdrop.tsx')['./scene/CinemaBackdrop.tsx'];
const CinemaBackdrop = loadBackdrop
  ? lazy(() => loadBackdrop().then((module) => ({ default: module.CinemaBackdrop })).catch(() => ({ default: () => null })))
  : () => null;

const KICKER = 'font-serif text-[12px] tracking-[0.42em] text-[#e9d3a8] uppercase';
const LABEL = 'font-serif text-[11px] tracking-[0.3em] text-[#e9d3a8]/75 uppercase';
const FIELD =
  'w-full rounded-full border border-[#e9d3a8]/20 bg-black/40 px-4 py-2.5 text-[15px] text-[#f4ead8] outline-none transition placeholder:text-[#d8c7a8]/35 focus:border-[#e9d3a8]/60 focus:bg-black/60 pointer-coarse:py-3 pointer-coarse:text-[16px]';
const PRIMARY =
  'relative flex w-full cursor-pointer items-center justify-center gap-2 rounded-full border border-[#e9d3a8]/45 bg-white/[0.07] px-6 py-3 text-[16px] font-medium text-[#f4ead8] shadow-[0_0_48px_rgba(255,190,110,0.22)] backdrop-blur-sm transition-colors hover:bg-white/[0.14] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#e9d3a8] disabled:cursor-default disabled:opacity-45 pointer-coarse:py-4';
const SECONDARY =
  'flex cursor-pointer items-center justify-center gap-2 rounded-full border border-[#e9d3a8]/25 bg-black/30 px-5 py-2.5 text-[14px] text-[#e9d3a8] backdrop-blur-sm transition-colors hover:bg-black/55 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#e9d3a8] disabled:cursor-default disabled:opacity-45 pointer-coarse:py-3.5';
const LINK = 'cursor-pointer text-[13px] text-[#e9d3a8] underline-offset-4 hover:underline';
const H2 = 'font-serif text-[30px] text-[#f4ead8] sm:text-[38px]';
const MUTED = 'text-[#d8c7a8]/80';

/** The primary pill, with a soft "ping" ring. */
function Pill({ children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type='button' {...rest} className={`${PRIMARY} ${className}`}>
      {!rest.disabled && <span aria-hidden className='wt-ping pointer-events-none absolute inset-0 rounded-full border border-[#e9d3a8]/40' />}
      {children}
    </button>
  );
}

function PopMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 40 40' aria-hidden>
      <circle cx='12' cy='11' r='6' fill='#f4ead8' />
      <circle cx='20' cy='7' r='7' fill='#f4ead8' />
      <circle cx='28' cy='11' r='6' fill='#f4ead8' />
      <path d='M6 14 H34 L30 37 H10 Z' fill='#a11522' />
      <path d='M14 14 H19 L18.5 37 H13 Z M24 14 H29 L27 37 H22 Z' fill='#e9d3a8' opacity='.9' />
    </svg>
  );
}

const FEATURES = [
  { title: 'Your files never upload', text: 'Videos go straight between browsers, peer to peer. No server ever sees them.' },
  { title: 'Everyone in sync', text: 'Play, pause and seek land for the whole room at once — streamed, or from each person’s own copy.' },
  { title: 'Your own volume', text: 'Volume, mute and subtitles are each person’s own. Turn it down without turning it down for everyone.' },
  { title: 'You decide who gets in', text: 'People knock; you (or helpers you pick) let them in. Choose who may share a tab.' },
  { title: 'Chat & the remote', text: 'Talk in the room. Hand the remote to a friend, take it back any time.' },
  { title: 'Subtitles, styled', text: 'Subtitles inside MKV files — fonts and all — show for everyone, even people watching the stream.' },
];

function Welcome(props: WelcomeProps) {
  const { session, snapshot } = props;
  const status = snapshot?.status.kind ?? 'idle';
  const me = snapshot?.me;
  const nameId = useId();
  const codeId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(me?.name ?? '');
  const [avatar, setAvatar] = useState<number>(me?.avatar ?? 0);
  const [roomCode, setRoomCode] = useState(() => newRoomCode());
  const [joinCode, setJoinCode] = useState('');
  const [editingName, setEditingName] = useState(false);
  // A clock for the "nobody answered yet" hint while knocking.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'waiting') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  // The session loads asynchronously: take its (remembered) name and face.
  useEffect(() => {
    if (!me) return;
    setName((current) => current || me.name);
    if (me.avatar !== undefined) setAvatar(me.avatar);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the session exists
  }, [me?.memberId]);

  const profile = () => ({ name: name.trim() || me?.name || 'Guest', avatar });
  const createCode = normalizeRoomCode(roomCode);
  const joinNormalized = normalizeRoomCode(joinCode);
  const ready = session !== null;
  const toTop = () => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });

  const ticket = (() => {
    if (status === 'in-room' && snapshot?.room && snapshot.code && snapshot.link) {
      const people = [...snapshot.online].map((id) => ({
        id,
        name: session?.nameOf(id) ?? '…',
        seed: avatarSeed(session?.avatarOf(id), id),
      }));
      return (
        <>
          <div className='flex items-center gap-2'>
            <span className='h-2 w-2 animate-pulse rounded-full bg-[#2ecc71] shadow-[0_0_10px_#2ecc71]' />
            <span className={LABEL}>You’re in the room</span>
          </div>
          <div className='flex items-center justify-between gap-3'>
            <span className='truncate font-mono text-[18px] text-[#f4ead8]'>{snapshot.code}</span>
            <AvatarStack people={people} size={34} />
          </div>
          <p className={`-mt-1 text-[14px] ${MUTED}`}>
            {people.length === 1 ? 'Just you so far — invite your people:' : `${people.length} here. Invite more:`}
          </p>
          <p className='-mt-2 text-[12.5px] text-[#d8c7a8]/55 pointer-fine:hidden'>
            Keep this page open — the room lives in the browsers of the people in it.
          </p>
          <InviteShare code={snapshot.code} link={snapshot.link} from={me?.name} onNotice={props.onNotice} />
          {props.shares.length > 0 && (
            <div className='flex flex-col gap-2'>
              <span className={LABEL}>Now showing</span>
              {props.shares.map((share) => (
                <div key={share.shareId} className='flex items-center gap-3 rounded-2xl border border-[#e9d3a8]/15 bg-black/35 p-2.5'>
                  <Avatar seed={share.sharerSeed} size={32} />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[14px] text-[#f4ead8]'>{share.title}</span>
                    <span className={`text-[12px] ${MUTED}`}>shared by {share.sharerName}</span>
                  </span>
                  <button type='button' className={`${SECONDARY} px-4 py-1.5`} onClick={() => props.onWatch(share.shareId)}>
                    Watch ›
                  </button>
                </div>
              ))}
            </div>
          )}
          <button type='button' className={SECONDARY} onClick={props.onOpenRoom}>
            People, chat & settings
          </button>
        </>
      );
    }
    if (status === 'connecting' || status === 'waiting') {
      const waiting = snapshot?.status.kind === 'waiting' ? snapshot.status : null;
      return (
        <>
          <span className={LABEL}>Knock, knock</span>
          <div className='flex items-center gap-4'>
            <Avatar seed={avatar} size={64} className='animate-bounce [animation-duration:1.6s]' />
            <div>
              <p className='font-serif text-[20px] text-[#f4ead8]'>Asking to join {snapshot?.code}…</p>
              <p className={`text-[14px] ${MUTED}`}>
                {waiting && waiting.heard > 0
                  ? 'Someone’s there — waiting for them to let you in.'
                  : waiting && (waiting.unreachable ?? 0) > 0
                    ? 'Found the room, but your network and theirs can’t connect directly (common with mobile data). Join the same Wi-Fi, use one phone’s hotspot, or add a relay in Connection settings.'
                  : waiting && now - waiting.since > 15_000
                    ? 'Nobody from this room is online yet. The person who made it needs to keep the page open (on a phone: screen on, browser in front) — or check the code.'
                    : 'Looking for the room…'}
              </p>
            </div>
          </div>
          <div className='flex gap-2'>
            <button type='button' className={`${SECONDARY} flex-1`} onClick={() => void session?.leave()}>
              Cancel
            </button>
            {waiting && (waiting.unreachable ?? 0) > 0 && waiting.heard === 0 ? (
              <button type='button' className={`${SECONDARY} flex-1`} onClick={props.onOpenConnection}>
                Connection settings
              </button>
            ) : (
              <button type='button' className={`${SECONDARY} flex-1`} onClick={props.onOpenRoom}>
                Details
              </button>
            )}
          </div>
        </>
      );
    }
    if (status === 'rejected' || status === 'kicked' || status === 'error') {
      const text =
        snapshot?.status.kind === 'rejected'
          ? snapshot.status.reason === 'banned'
            ? 'You were removed from that room.'
            : snapshot.status.reason === 'timeout'
              ? 'Nobody let you in in time.'
              : 'Your request to join was declined.'
          : snapshot?.status.kind === 'kicked'
            ? 'You were removed from the room.'
            : 'Something went wrong connecting to the room.';
      return (
        <>
          <span className={LABEL}>The doors are closed</span>
          <p className='font-serif text-[20px] text-[#f4ead8]'>{text}</p>
          <Pill onClick={() => void session?.leave()}>OK</Pill>
        </>
      );
    }

    // idle: the ticket booth (or an invitation)
    const invited = props.inviteCode;
    return (
      <>
        <div className='flex items-center justify-between gap-2'>
          <span className={LABEL}>{invited ? 'You’re invited' : 'Ticket booth'}</span>
          {invited && (
            <span className='truncate rounded-full border border-[#e9d3a8]/35 bg-[#e9d3a8]/10 px-3 py-1 font-mono text-[12.5px] text-[#e9d3a8]'>
              {invited}
            </span>
          )}
        </div>
        <div className='flex items-center gap-4'>
          <button
            type='button'
            onClick={() => setAvatar(randomAvatar())}
            className='group relative shrink-0 cursor-pointer rounded-full border border-[#e9d3a8]/25 bg-black/40 p-2 shadow-[0_0_30px_rgba(255,190,110,0.12)] transition hover:border-[#e9d3a8]/60'
            aria-label='Shuffle my avatar'
            title='Shuffle'
          >
            <Avatar seed={avatar} size={72} />
            <span className='absolute -right-1 -bottom-1 flex h-7 w-7 items-center justify-center rounded-full border border-[#e9d3a8]/35 bg-[#1a100d] text-[12px] text-[#e9d3a8] transition group-hover:rotate-180'>
              ⟳
            </span>
          </button>
          <div className='flex min-w-0 flex-1 flex-col gap-1'>
            <label htmlFor={nameId} className={LABEL}>
              Your name
            </label>
            {editingName ? (
              <input
                id={nameId}
                data-tour='your-name'
                autoFocus
                className={FIELD}
                maxLength={40}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                onBlur={() => setEditingName(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setEditingName(false);
                }}
              />
            ) : (
              <button
                id={nameId}
                type='button'
                data-tour='your-name'
                onClick={() => setEditingName(true)}
                className='group flex cursor-text items-center gap-2 rounded-full px-1 py-0.5 text-left font-serif text-[24px] text-[#f4ead8] hover:bg-white/[0.04]'
                aria-label={`Your name: ${name || '…'} (edit)`}
              >
                <span className='truncate'>{name || '…'}</span>
                <span className='text-[13px] text-[#e9d3a8]/40 group-hover:text-[#e9d3a8]'>✎</span>
              </button>
            )}
          </div>
        </div>

        {invited ? (
          <>
            <Pill data-tour='join-invite' disabled={!ready} onClick={() => props.onJoin(profile(), invited)}>
              Join the room <span aria-hidden>›</span>
            </Pill>
            <p className={`-mt-1 text-center text-[13px] ${MUTED}`}>Someone in the room lets you in — usually in seconds.</p>
            <button type='button' className={`${LINK} self-center`} onClick={props.onDismissInvite}>
              Start my own room instead
            </button>
          </>
        ) : (
          <>
            <div className='flex flex-col gap-1.5'>
              <label htmlFor={codeId} className={LABEL}>
                Room name
              </label>
              <div className='flex gap-2'>
                <input
                  id={codeId}
                  className={`${FIELD} font-mono`}
                  value={roomCode}
                  autoCapitalize='none'
                  autoCorrect='off'
                  spellCheck={false}
                  onChange={(event) => setRoomCode(event.currentTarget.value)}
                />
                <button
                  type='button'
                  className='shrink-0 cursor-pointer rounded-full border border-[#e9d3a8]/20 bg-black/40 px-3.5 text-[16px] text-[#e9d3a8] transition hover:border-[#e9d3a8]/60'
                  aria-label='New room name'
                  title='New room name'
                  onClick={() => setRoomCode(newRoomCode())}
                >
                  ⚄
                </button>
              </div>
              {!createCode && <span className='text-[12px] text-[#f1c40f]'>Use word-word-1234, like merry-otter-4821.</span>}
            </div>
            <Pill data-tour='start-room' disabled={!ready || !createCode} onClick={() => createCode && props.onCreate(profile(), createCode)}>
              Start a room <span aria-hidden>›</span>
            </Pill>
            <div className='flex items-center gap-3 font-serif text-[11px] tracking-[0.3em] text-[#e9d3a8]/45 uppercase'>
              <span className='h-px flex-1 bg-[#e9d3a8]/15' /> or join a friend <span className='h-px flex-1 bg-[#e9d3a8]/15' />
            </div>
            <form
              className='flex gap-2'
              onSubmit={(event) => {
                event.preventDefault();
                if (joinNormalized) props.onJoin(profile(), joinNormalized);
              }}
            >
              <input
                aria-label='Room code or link'
                data-tour='join-code'
                className={`${FIELD} font-mono`}
                placeholder='paste a code or link'
                value={joinCode}
                autoCapitalize='none'
                autoCorrect='off'
                spellCheck={false}
                onChange={(event) => setJoinCode(event.currentTarget.value)}
              />
              <button type='submit' data-tour='join-submit' className={`${SECONDARY} shrink-0`} disabled={!ready || !joinNormalized}>
                Join
              </button>
            </form>
          </>
        )}
        <p className='text-center text-[11px] tracking-[0.18em] text-[#d8c7a8]/40 uppercase'>No accounts · no uploads · you decide who joins</p>
      </>
    );
  })();

  return (
    <div ref={scroller} className='h-full overflow-y-auto bg-[#0a0606] text-[#f4ead8]'>
      <style>{EFFECTS_CSS}</style>

      {/* ── the stage ─────────────────────────────────────────────────── */}
      <section aria-label='Welcome' className='relative overflow-hidden lg:min-h-full'>
        <div
          aria-hidden
          className='pointer-events-none absolute inset-0'
          style={{
            background:
              'radial-gradient(700px 520px at 24% 52%, rgba(120,40,20,0.28), transparent 70%), radial-gradient(900px 600px at 70% 0%, rgba(255,200,140,0.06), transparent 70%)',
          }}
        />
        {/* The 3D stage: the LEFT half on wide screens, a band on top on
            phones. Drag to turn it, pinch (or Ctrl/⌘ + wheel) to zoom. */}
        <div className='absolute inset-x-0 top-0 h-[340px] lg:inset-y-0 lg:right-auto lg:h-auto lg:w-1/2'>
          <Suspense fallback={null}>
            <CinemaBackdrop className='h-full w-full' />
          </Suspense>
        </div>
        <Embers count={22} />
        <div
          aria-hidden
          className='pointer-events-none absolute inset-0'
          style={{ background: 'linear-gradient(to bottom, rgba(10,6,6,0.55), transparent 22%, transparent 78%, rgba(10,6,6,0.95))' }}
        />

        {/* pointer-events pass through the empty left side to the scene */}
        <div className='pointer-events-none relative mx-auto grid max-w-6xl px-4 pt-[300px] pb-14 sm:px-6 lg:min-h-full lg:grid-cols-2 lg:items-center lg:gap-10 lg:py-16'>
          <div className='hidden lg:block' />
          <div className='pointer-events-auto flex flex-col gap-6'>
            <div className='flex flex-col gap-4'>
              <p className={`${KICKER} flex items-center gap-2.5`}>
                <PopMark size={22} /> watch-together
              </p>
              <h1 className='font-serif text-[38px] leading-[1.08] text-balance text-[#f4ead8] drop-shadow-[0_4px_24px_rgba(0,0,0,0.9)] sm:text-[52px]'>
                Movie night, from anywhere.
              </h1>
              <p className={`max-w-lg text-[16px] text-pretty ${MUTED}`}>
                Start a room, send the link, press play. Everyone watches the same moment — straight from your computer to
                theirs.
              </p>
            </div>
            <GoldCard className='w-full max-w-[460px]'>
              <section aria-label='Room' data-tour='ticket' data-state={status} className='flex flex-col gap-4 p-5 sm:p-6'>
                {ticket}
              </section>
            </GoldCard>
          </div>
        </div>
      </section>

      {/* ── tonight's video ───────────────────────────────────────────── */}
      <section aria-label='Open a video' className='border-t border-[#e9d3a8]/10'>
        <div className='mx-auto flex max-w-6xl flex-col gap-8 px-4 py-16 sm:px-6'>
          <h2 className={H2}>Pick tonight’s video</h2>
          <div className='grid gap-4 sm:grid-cols-2'>
            <EmberCard as='button' type='button' data-tour='open-file' onClick={props.onOpenVideo} className='cursor-pointer'>
              <span className='font-serif text-[20px] text-[#f4ead8]'>Open a video file…</span>
              <span className={`text-[14px] leading-relaxed ${MUTED}`}>Any browser, phones too — or drop video files anywhere on this page.</span>
            </EmberCard>
            <EmberCard
              as='button'
              type='button'
              data-tour='link-folder'
              onClick={props.onLinkFolder}
              disabled={!props.canLinkFolders}
              className='cursor-pointer disabled:cursor-default disabled:opacity-50'
            >
              <span className='font-serif text-[20px] text-[#f4ead8]'>Link a video folder…</span>
              <span className={`text-[14px] leading-relaxed ${MUTED}`}>
                {props.canLinkFolders
                  ? 'Optional — browse a whole folder in the library, remembered next time. Read-only or read & write, your choice.'
                  : 'Needs Chrome or Edge on a computer. Single files open everywhere.'}
              </span>
            </EmberCard>
          </div>
          {props.recent.length > 0 && (
            <div className='flex flex-col gap-2'>
              <span className={LABEL}>Recently watched</span>
              <ul className='flex flex-col divide-y divide-[#e9d3a8]/8 rounded-2xl border border-[#e9d3a8]/10 bg-[#140c0b]'>
                {props.recent.slice(0, 6).map((entry) => (
                  <li key={entry.id}>
                    <button
                      type='button'
                      onClick={() => props.onOpenRecent(entry.id)}
                      className='flex w-full cursor-pointer items-baseline gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]'
                    >
                      <span className='truncate text-[14px] text-[#f4ead8]'>{entry.name}</span>
                      <span className='truncate text-[12px] text-[#d8c7a8]/45'>{entry.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      {/* ── what it does ─────────────────────────────────────────────── */}
      <section aria-label='Features' className='border-t border-[#e9d3a8]/10'>
        <div className='mx-auto flex max-w-6xl flex-col gap-8 px-4 py-16 sm:px-6'>
          <h2 className={H2}>Everything it does, in plain words</h2>
          <ul className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
            {FEATURES.map((feature) => (
              <EmberCard key={feature.title} as='li'>
                <h3 className='font-serif text-[18px] text-[#f4ead8]'>{feature.title}</h3>
                <p className={`text-[14px] leading-relaxed ${MUTED}`}>{feature.text}</p>
              </EmberCard>
            ))}
          </ul>
        </div>
      </section>

      {/* ── curtain call ──────────────────────────────────────────────── */}
      <CurtainCall scroller={scroller}>
        <div className='mx-auto flex max-w-6xl flex-col items-center gap-5 px-4 py-28 text-center sm:px-6'>
          <h2 className='font-serif text-[32px] text-balance text-[#f4ead8] sm:text-[44px]'>The lights are going down.</h2>
          <p className={`max-w-xl text-[16px] text-pretty ${MUTED}`}>
            Free and open source (MIT). Runs entirely in your browser — rooms meet over public relays, videos travel directly
            between you.
          </p>
          <div className='w-full max-w-xs'>
            <Pill onClick={toTop}>{status === 'in-room' ? 'Invite your people' : 'Get your ticket'} <span aria-hidden>›</span></Pill>
          </div>
        </div>
      </CurtainCall>

      <footer className='border-t border-white/[0.08] bg-[#151515]'>
        <div className='mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-start sm:justify-between sm:px-6'>
          <div className='flex max-w-sm flex-col gap-2'>
            <span className='flex items-center gap-2 text-[16px] font-semibold'>
              <PopMark size={22} /> watch-together
            </span>
            <p className='text-[13px] text-[#f4ead8]/60'>Movie night, from anywhere — peer to peer, in your browser.</p>
          </div>
          <nav aria-label='Footer' className='grid grid-cols-2 gap-x-10 gap-y-2 text-[14px] text-[#f4ead8]/70'>
            <a className='hover:text-[#f4ead8]' href='https://github.com/TheClearSky/watch-together' target='_blank' rel='noreferrer'>
              Source ↗
            </a>
            <a className='hover:text-[#f4ead8]' href={`${import.meta.env.BASE_URL}THIRD_PARTY_LICENSES.txt`} target='_blank' rel='noreferrer'>
              Licenses
            </a>
            <a className='hover:text-[#f4ead8]' href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.txt`} target='_blank' rel='noreferrer'>
              Subtitle renderer notices
            </a>
          </nav>
        </div>
        <p className='border-t border-white/5 px-4 py-4 text-center text-[12px] text-[#f4ead8]/40'>Open source · MIT · Runs in your browser</p>
      </footer>
    </div>
  );
}

export { Welcome };
export type { WelcomeShare };
