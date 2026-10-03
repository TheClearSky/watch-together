import { useEffect, useRef, useState } from 'react';

/**
 * The Welcome page's stage effects, in Nodestra's visual language (its
 * landing page: embers over a dark stage, gold-rimmed cards, ember cards,
 * curtains that part) — written fresh for this MIT app.
 */

const GOLD = '#e9d3a8';
const IVORY = '#f4ead8';
const SAND = '#d8c7a8';
const EMBER = ['#bc2231', '#bc2231', '#bc2231', '#bc2231', '#bc2231', '#b91871', '#b91871', '#ca4928'];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** Soft glowing embers drifting up (additive canvas). */
function Embers({ count = 26, className = '' }: { count?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || reduced) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let width = 0;
    let height = 0;
    let frame = 0;
    let visible = true;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const observer = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    });
    observer.observe(canvas);
    const seen = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting));
    seen.observe(canvas);
    const sprites = EMBER.map((color) => {
      const sprite = document.createElement('canvas');
      sprite.width = sprite.height = 64;
      const paint = sprite.getContext('2d')!;
      const gradient = paint.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.28, `${color}ee`);
      gradient.addColorStop(0.6, `${color}55`);
      gradient.addColorStop(1, `${color}00`);
      paint.fillStyle = gradient;
      paint.fillRect(0, 0, 64, 64);
      return sprite;
    });
    type Mote = { x: number; y: number; depth: number; sprite: number; phase: number; born: number };
    const motes: Mote[] = Array.from({ length: count }, () => ({ x: 0, y: -999, depth: 0, sprite: 0, phase: 0, born: -1 }));
    const start = performance.now();
    const respawn = (mote: Mote, t: number, anywhere: boolean) => {
      mote.x = Math.random() * width;
      mote.y = anywhere ? Math.random() * height : height + 20 + Math.random() * height * 0.3;
      mote.depth = Math.random();
      mote.sprite = Math.floor(Math.random() * sprites.length);
      mote.phase = Math.random() * Math.PI * 2;
      mote.born = t;
    };
    let last = start;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (!visible || width === 0) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - start) / 1000;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = 'lighter';
      for (const mote of motes) {
        if (mote.born < 0) respawn(mote, t, true);
        else if (mote.y < -40) respawn(mote, t, false);
        mote.y -= (14 + 26 * mote.depth) * dt;
        mote.x += Math.sin(t * 0.9 + mote.phase) * 8 * dt + 3 * dt;
        const radius = 3 + mote.depth * 9;
        const fadeIn = Math.min(1, (t - mote.born) * 0.8);
        const fadeTop = Math.min(1, Math.max(0, mote.y / (height * 0.35)));
        context.globalAlpha = fadeIn * fadeTop * (0.25 + 0.55 * mote.depth) * (0.75 + 0.25 * Math.sin(t * 3 + mote.phase));
        context.drawImage(sprites[mote.sprite], mote.x - radius, mote.y - radius, radius * 2, radius * 2);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      seen.disconnect();
    };
  }, [count, reduced]);
  return <canvas ref={ref} aria-hidden className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />;
}

/** A thin gold-rimmed card with a slow sheen (the ticket booth). */
function GoldCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`wt-goldcard relative rounded-[22px] p-[1.5px] ${className}`}>
      <div className='relative overflow-hidden rounded-[20.5px] bg-[#120b09]/95 backdrop-blur-md'>
        {children}
        <span aria-hidden className='wt-sheen pointer-events-none absolute inset-0' />
        <span
          aria-hidden
          className='pointer-events-none absolute inset-0 rounded-[20.5px]'
          style={{ boxShadow: 'inset 0 1px 0 rgba(255,244,220,0.28), inset 0 0 0 1px rgba(255,236,190,0.06)' }}
        />
      </div>
    </div>
  );
}

/** A dark card whose rim catches fire on hover, embers rising from it. */
function EmberCard({ children, className = '', as = 'div', ...rest }: React.HTMLAttributes<HTMLElement> & { as?: 'div' | 'button' | 'li'; disabled?: boolean; type?: string }) {
  const Tag = as as 'div';
  return (
    <Tag
      {...(rest as React.HTMLAttributes<HTMLDivElement>)}
      className={`group relative overflow-hidden rounded-2xl p-[1.5px] text-left ${className}`}
      style={{ background: 'linear-gradient(140deg, rgba(233,211,168,0.2), rgba(255,255,255,0.04))' }}
    >
      <span
        aria-hidden
        className='wt-spin absolute inset-[-60%] opacity-0 transition-opacity duration-500 group-hover:opacity-100 group-focus-visible:opacity-100'
      />
      <span className='relative flex h-full flex-col gap-2 rounded-[14.5px] bg-[#140c0b] p-5'>
        {children}
        {Array.from({ length: 6 }, (_, index) => (
          <span
            key={index}
            aria-hidden
            className='wt-rise pointer-events-none absolute bottom-0 h-1.5 w-1.5 rounded-full opacity-0'
            style={{
              left: `${12 + index * 15}%`,
              background: EMBER[(index * 3) % EMBER.length],
              boxShadow: `0 0 10px ${EMBER[(index * 3) % EMBER.length]}`,
              animationDelay: `${index * 0.27}s`,
            }}
          />
        ))}
      </span>
    </Tag>
  );
}

/**
 * Velvet curtains that part as their section scrolls into view (inside the
 * Welcome page's own scroll container).
 */
function CurtainCall({ scroller, children }: { scroller: React.RefObject<HTMLElement | null>; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(reduced ? 1 : 0);
  useEffect(() => {
    const container = scroller.current;
    if (reduced || !container) {
      setOpen(1);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const section = ref.current;
      if (!section) return;
      const box = section.getBoundingClientRect();
      const view = container.getBoundingClientRect();
      setOpen(Math.min(1, Math.max(0, (view.bottom - box.top) / (box.height * 0.95))));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scroller, reduced]);
  const eased = open * open * (3 - 2 * open);
  const drape = (side: 'left' | 'right') => (
    <svg
      viewBox='0 0 400 600'
      preserveAspectRatio='none'
      aria-hidden
      className='pointer-events-none absolute top-0 h-full w-[52%]'
      style={{
        [side]: 0,
        transform: `translateX(${(side === 'left' ? -1 : 1) * eased * 90}%) scaleX(${1 - eased * 0.3})`,
        transformOrigin: side,
      }}
    >
      <defs>
        <linearGradient id={`wt-pleats-${side}`} x1='0' x2='1'>
          {Array.from({ length: 11 }, (_, index) => (
            <stop key={index} offset={index / 10} stopColor={index % 2 ? '#34060a' : '#9b1420'} />
          ))}
        </linearGradient>
        <linearGradient id={`wt-drape-shade-${side}`} x1='0' y1='0' x2='0' y2='1'>
          <stop offset='0' stopColor='#000' stopOpacity='.5' />
          <stop offset='.35' stopColor='#000' stopOpacity='0' />
          <stop offset='1' stopColor='#000' stopOpacity='.55' />
        </linearGradient>
      </defs>
      <path
        d={side === 'left' ? 'M0 0 H400 C384 210 404 430 352 600 H0 Z' : 'M0 0 H400 V600 H48 C-4 430 16 210 0 0 Z'}
        fill={`url(#wt-pleats-${side})`}
      />
      <path
        d={side === 'left' ? 'M0 0 H400 C384 210 404 430 352 600 H0 Z' : 'M0 0 H400 V600 H48 C-4 430 16 210 0 0 Z'}
        fill={`url(#wt-drape-shade-${side})`}
      />
      <path d='M0 3 H400' stroke='#c9973f' strokeWidth='6' />
    </svg>
  );
  return (
    <section ref={ref} className='relative overflow-hidden border-t border-[#e9d3a8]/10 bg-black'>
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0'
        style={{
          background:
            'conic-gradient(from 180deg at 50% -12%, transparent 158deg, rgba(255,220,160,0.14) 172deg, rgba(255,220,160,0.22) 180deg, rgba(255,220,160,0.14) 188deg, transparent 202deg)',
        }}
      />
      <div className='relative'>{children}</div>
      {drape('left')}
      {drape('right')}
    </section>
  );
}

/** Keyframes + the gold rim/sheen/ember styles used above. */
const EFFECTS_CSS = `
.wt-goldcard {
  background: linear-gradient(135deg, rgba(255,240,205,0.9), rgba(201,151,63,0.42) 28%, rgba(255,232,180,0.18) 55%, rgba(214,170,90,0.7) 82%, rgba(255,240,205,0.85));
  box-shadow: 0 0 0 1px rgba(255,224,160,0.16), 0 0 26px rgba(255,206,130,0.18), 0 0 70px rgba(255,190,110,0.08), 0 30px 60px rgba(0,0,0,0.6);
}
.wt-sheen {
  background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.08) 47%, rgba(255,248,230,0.03) 53%, transparent 62%);
  background-size: 260% 100%;
  animation: wtSheen 7s ease-in-out infinite;
}
@keyframes wtSheen { 0%,55% { background-position: 130% 0 } 85%,100% { background-position: -40% 0 } }
.wt-spin { background: conic-gradient(from 0deg, #bc2231, #ca4928, #f3cf8a, #b91871, #bc2231); animation: wtSpin 3s linear infinite; }
@keyframes wtSpin { to { transform: rotate(360deg) } }
.group:hover .wt-rise, .group:focus-visible .wt-rise { animation: wtRise 1.8s ease-out infinite; }
@keyframes wtRise { 0% { opacity: 0; transform: translateY(0) scale(.6) } 20% { opacity: 1 } 100% { opacity: 0; transform: translateY(-110px) scale(1.2) } }
.wt-ping { animation: wtPing 2.6s ease-out infinite; }
@keyframes wtPing { from { transform: scale(1); opacity: .7 } to { transform: scale(1.18, 1.5); opacity: 0 } }
@media (prefers-reduced-motion: reduce) { .wt-sheen, .wt-spin, .wt-ping, .group:hover .wt-rise { animation: none } }
`;

export { CurtainCall, EFFECTS_CSS, EmberCard, Embers, GOLD, GoldCard, IVORY, SAND, useReducedMotion };
