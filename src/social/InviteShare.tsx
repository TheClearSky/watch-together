import { useEffect, useMemo, useState } from 'react';
import { renderSVG } from 'uqr';

/**
 * Invite people in one click: the phone's own share sheet where there is one
 * (WhatsApp, Messages, Discord… whatever is installed), otherwise the link is
 * copied. Quick links for the usual apps, and a QR code for the phone on the
 * sofa or the TV across the room.
 */

type InviteShareProps = {
  code: string;
  link: string;
  /** Who is inviting (goes into the message). */
  from?: string;
  /** Feedback ("Link copied"). */
  onNotice?(message: string): void;
  compact?: boolean;
};

const canNativeShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / denied: a hidden textarea + execCommand.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function inviteMessage(code: string, from?: string): string {
  return `🍿 ${from ? `${from} invited you to` : 'Join'} a watch party on watch-together — room ${code}`;
}

const CHIP =
  'flex cursor-pointer items-center gap-1.5 rounded-full border border-[#e9d3a8]/20 bg-black/35 px-3 py-1.5 text-[13px] text-[#e9d3a8] no-underline transition-colors hover:border-[#e9d3a8]/50 hover:bg-black/60 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-[15px]';

function InviteShare({ code, link, from, onNotice, compact = false }: InviteShareProps) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const message = inviteMessage(code, from);
  const qr = useMemo(
    () => (showQr ? renderSVG(link, { border: 2, whiteColor: '#f4ead8', blackColor: '#120b09' }) : ''),
    [showQr, link],
  );
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (await copyText(link)) {
      setCopied(true);
      onNotice?.('Invite link copied');
    }
  };
  const share = async () => {
    if (canNativeShare()) {
      try {
        await navigator.share({ title: 'watch-together', text: message, url: link });
        return;
      } catch (error) {
        if ((error as DOMException)?.name === 'AbortError') return; // the person closed the sheet
      }
    }
    await copy();
  };

  const encodedText = encodeURIComponent(`${message}\n${link}`);
  // For crawlers/redirects that drop the #fragment (Facebook): ?room=<code>,
  // which the app turns back into #/room/<code> on load (main.tsx).
  const queryLink = `${link.split('#')[0]}?room=${encodeURIComponent(code)}`;
  // Instagram has no web share link: the phone's share sheet has it; on a
  // computer, copy the invite and open Instagram's messages to paste it.
  const instagram = async () => {
    if (canNativeShare()) {
      await share();
      return;
    }
    if (await copyText(`${message}\n${link}`)) onNotice?.('Invite copied — paste it into an Instagram message');
    window.open('https://www.instagram.com/direct/inbox/', '_blank', 'noopener,noreferrer');
  };
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-stretch gap-2'>
        <input
          readOnly
          aria-label='Invite link'
          value={link}
          onFocus={(event) => event.currentTarget.select()}
          className='min-w-0 flex-1 rounded-full border border-[#e9d3a8]/20 bg-black/40 px-4 py-2 font-mono text-[12.5px] text-[#d8c7a8] outline-none focus:border-[#e9d3a8]/60 pointer-coarse:py-3 pointer-coarse:text-[14px]'
        />
        <button
          type='button'
          onClick={() => void copy()}
          className='cursor-pointer rounded-full border border-[#e9d3a8]/25 bg-black/35 px-4 text-[13px] text-[#e9d3a8] transition-colors hover:bg-black/60 pointer-coarse:px-5'
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <button
        type='button'
        data-tour='share-invite'
        onClick={() => void share()}
        className='relative flex cursor-pointer items-center justify-center gap-2 rounded-full border border-[#e9d3a8]/45 bg-white/[0.07] px-6 py-3 text-[16px] font-medium text-[#f4ead8] shadow-[0_0_48px_rgba(255,190,110,0.22)] backdrop-blur-sm transition-colors hover:bg-white/[0.14] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#e9d3a8] pointer-coarse:py-4'
      >
        <ShareIcon /> {canNativeShare() ? 'Share invite' : copied ? 'Link copied — paste it anywhere' : 'Copy invite link'}
      </button>
      {!compact && (
        <div className='flex flex-wrap gap-2' aria-label='Send the invite with'>
          <a className={CHIP} href={`https://wa.me/?text=${encodedText}`} target='_blank' rel='noreferrer'>
            WhatsApp
          </a>
          <a
            className={CHIP}
            href={`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(message)}`}
            target='_blank'
            rel='noreferrer'
          >
            Telegram
          </a>
          <a
            className={CHIP}
            href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(queryLink)}`}
            target='_blank'
            rel='noreferrer'
          >
            Facebook
          </a>
          <button type='button' className={CHIP} onClick={() => void instagram()}>
            Instagram
          </button>
          <a className={CHIP} href={`mailto:?subject=${encodeURIComponent('Watch party tonight? 🍿')}&body=${encodedText}`}>
            Email
          </a>
          <a className={`${CHIP} pointer-fine:hidden`} href={`sms:?&body=${encodedText}`}>
            Text
          </a>
          <button type='button' className={CHIP} aria-expanded={showQr} onClick={() => setShowQr((value) => !value)}>
            {showQr ? 'Hide QR' : 'QR code'}
          </button>
        </div>
      )}
      {showQr && (
        <div className='flex items-center gap-4 rounded-2xl border border-[#e9d3a8]/15 bg-black/40 p-3'>
          <div
            className='h-36 w-36 shrink-0 overflow-hidden rounded-lg [&>svg]:h-full [&>svg]:w-full'
            role='img'
            aria-label={`QR code for the invite link to room ${code}`}
            // uqr's own SVG output for our own link — no outside markup.
            dangerouslySetInnerHTML={{ __html: qr }}
          />
          <p className='text-[13px] leading-relaxed text-[#d8c7a8]/80'>
            Point a phone camera here to open the invite. Handy for the person on the sofa next to you.
          </p>
        </div>
      )}
    </div>
  );
}

function ShareIcon() {
  return (
    <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.4' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
      <circle cx='18' cy='5' r='3' />
      <circle cx='6' cy='12' r='3' />
      <circle cx='18' cy='19' r='3' />
      <path d='M8.6 13.5l6.8 4M15.4 6.5l-6.8 4' />
    </svg>
  );
}

export { copyText, InviteShare, inviteMessage };
