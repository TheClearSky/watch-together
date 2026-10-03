import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { placeGuide } from './placement';
import type { PlacementPreference, Rect } from './placement';
import { snapSpring, spring, stepSpring } from './spring';
import type { Spring } from './spring';

/**
 * Pop — watch-together's guide (D5, 2026-10-03: "yes Pop seems fine").
 *
 * A popcorn bucket drawn as plain SVG (no three.js), animated with springs
 * on one requestAnimationFrame loop that writes attributes straight to the
 * DOM (React renders only when the mood or the words change):
 *
 *   - glides (spring) to a spot beside what it points at, never over it
 *   - idle bob + blink; kernels pop out of the bucket when it starts talking
 *   - the arm on the target's side swings to point at the target
 *   - `prefers-reduced-motion`: no bob, blink, kernels or gliding — Pop just
 *     stands in the right place and points.
 *
 * The bubble (children) sits beside the character and moves with it.
 */

type PopMood = 'neutral' | 'happy' | 'excited' | 'thinking' | 'pointing' | 'surprised' | 'concerned' | 'celebrate';

type PopProps = {
  mood: PopMood;
  /** Changes whenever Pop says something new: kernels pop, the mouth talks. */
  speechKey: string;
  /** Characters of the new words (how long the mouth moves). */
  speechLength: number;
  /** What the spotlight shows (viewport px); Pop stands beside it and points. */
  target: Rect | null;
  placement?: PlacementPreference;
  /** Accessible name of the bubble. */
  label: string;
  children: ReactNode;
};

const VIEW = { x: -24, y: -40, width: 168, height: 190 };
const SHOULDER = { left: { x: 24, y: 94 }, right: { x: 96, y: 94 } };
const ARM_LENGTH = 22;
const KERNELS = 7;
const RED = '#e23b3b';
const RED_DARK = '#b82a2a';
const CREAM = '#fff6dc';
const BUTTER = '#f2c14e';
const INK = '#2b1d14';

function subscribeMedia(query: string) {
  return (listener: () => void) => {
    if (typeof matchMedia !== 'function') return () => {};
    const list = matchMedia(query);
    list.addEventListener('change', listener);
    return () => list.removeEventListener('change', listener);
  };
}

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    subscribeMedia(query),
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
    () => false,
  );
}

function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return size;
}

/** The mouth for a mood (the talking mouth is drawn separately). */
function Mouth({ mood }: { mood: PopMood }) {
  switch (mood) {
    case 'excited':
    case 'celebrate':
      return (
        <g>
          <path d='M50 102 Q60 119 70 102 Z' fill={INK} />
          <path d='M54 109 Q60 114 66 109 Q60 116 54 109 Z' fill='#ff7b8a' />
        </g>
      );
    case 'surprised':
      return <ellipse cx='60' cy='107' rx='4.5' ry='5.5' fill={INK} />;
    case 'thinking':
      return <path d='M55 107 Q61 104 67 106' stroke={INK} strokeWidth='2.4' fill='none' strokeLinecap='round' />;
    case 'concerned':
      return <path d='M52 109 Q60 102 68 109' stroke={INK} strokeWidth='2.4' fill='none' strokeLinecap='round' />;
    case 'happy':
    case 'pointing':
      return <path d='M50 102 Q60 113 70 102' stroke={INK} strokeWidth='2.6' fill='none' strokeLinecap='round' />;
    default:
      return <path d='M53 104 Q60 109 67 104' stroke={INK} strokeWidth='2.4' fill='none' strokeLinecap='round' />;
  }
}

function Brows({ mood }: { mood: PopMood }) {
  if (mood === 'concerned')
    return (
      <g stroke={INK} strokeWidth='2' strokeLinecap='round'>
        <path d='M44 82 L52 85' />
        <path d='M76 82 L68 85' />
      </g>
    );
  if (mood === 'surprised' || mood === 'thinking')
    return (
      <g stroke={INK} strokeWidth='2' strokeLinecap='round' fill='none'>
        <path d={mood === 'thinking' ? 'M44 83 Q49 81 53 83' : 'M44 81 Q49 77 53 81'} />
        <path d={mood === 'thinking' ? 'M67 80 Q71 77 76 79' : 'M67 81 Q71 77 76 81'} />
      </g>
    );
  return null;
}

function Eyes({ mood }: { mood: PopMood }) {
  if (mood === 'celebrate' || mood === 'happy')
    return (
      <g stroke={INK} strokeWidth='2.6' strokeLinecap='round' fill='none'>
        <path d='M45 93 Q49 87 53 93' />
        <path d='M67 93 Q71 87 75 93' />
      </g>
    );
  const look = mood === 'thinking' ? { x: 1.5, y: -2 } : { x: 0, y: 0 };
  const big = mood === 'surprised' ? 1.25 : 1;
  return (
    <g>
      {[49, 71].map((cx) => (
        <g key={cx}>
          <ellipse cx={cx + look.x} cy={91 + look.y} rx={4.2 * big} ry={5.6 * big} fill={INK} />
          <circle cx={cx + look.x + 1.4} cy={89 + look.y} r={1.4} fill='#fff' />
        </g>
      ))}
    </g>
  );
}

/** The popcorn heap: puffs, back to front. */
const PUFFS: readonly [number, number, number][] = [
  [34, 36, 9],
  [58, 27, 10],
  [81, 33, 9],
  [26, 52, 10],
  [44, 44, 12],
  [62, 40, 13],
  [78, 45, 12],
  [94, 52, 10],
  [50, 54, 10],
  [70, 54, 10],
];

function Bucket() {
  // Stripes converge with the bucket's taper.
  const top = [20, 36, 52, 68, 84, 100];
  const bottom = [32, 43.2, 54.4, 65.6, 76.8, 88];
  return (
    <g>
      <defs>
        <clipPath id='pop-bucket'>
          <path d='M20 60 H100 L89 132 Q88 138 82 138 H38 Q32 138 31 132 Z' />
        </clipPath>
      </defs>
      {PUFFS.map(([cx, cy, r], index) => (
        <g key={index}>
          <circle cx={cx} cy={cy} r={r} fill={CREAM} stroke={BUTTER} strokeWidth='1.4' />
          <circle cx={cx + r * 0.3} cy={cy + r * 0.3} r={r * 0.35} fill={BUTTER} opacity='0.45' />
        </g>
      ))}
      <g clipPath='url(#pop-bucket)'>
        <rect x='18' y='58' width='86' height='84' fill='#fff4e6' />
        {[0, 2, 4].map((i) => (
          <path key={i} d={`M${top[i]} 58 H${top[i + 1]} L${bottom[i + 1]} 140 H${bottom[i]} Z`} fill={RED} />
        ))}
      </g>
      <rect x='15' y='54' width='90' height='11' rx='5.5' fill={RED_DARK} />
      <ellipse cx='60' cy='97' rx='27' ry='23' fill='#fff8ec' stroke='#f0d9b5' strokeWidth='1.2' />
      <circle cx='41' cy='102' r='3.6' fill='#ff9aa2' opacity='0.65' />
      <circle cx='79' cy='102' r='3.6' fill='#ff9aa2' opacity='0.65' />
      <ellipse cx='46' cy='141' rx='7' ry='3.5' fill={RED_DARK} />
      <ellipse cx='74' cy='141' rx='7' ry='3.5' fill={RED_DARK} />
    </g>
  );
}

type Kernel = { active: boolean; x: number; y: number; vx: number; vy: number; rotation: number; spin: number; age: number };

function Pop({ mood, speechKey, speechLength, target, placement = 'auto', label, children }: PopProps) {
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)');
  const compact = useMedia('(max-width: 639px)');
  const viewport = useViewport();
  const [characterOnRight, setCharacterOnRight] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const moodMouthRef = useRef<SVGGElement>(null);
  const talkMouthRef = useRef<SVGEllipseElement>(null);
  const armRefs = useRef<{ left: SVGGElement | null; right: SVGGElement | null }>({ left: null, right: null });
  const kernelRefs = useRef<(SVGGElement | null)[]>([]);

  // Animation state lives in refs: the loop reads the latest props from here.
  const live = useRef({
    x: spring(0),
    y: spring(0),
    armLeft: spring(115),
    armRight: spring(65),
    placed: false,
    target: target as Rect | null,
    mood,
    reducedMotion,
    talkUntil: 0,
    nextBlink: 2,
    kernels: Array.from({ length: KERNELS }, (): Kernel => ({ active: false, x: 0, y: 0, vx: 0, vy: 0, rotation: 0, spin: 0, age: 0 })),
  });
  live.current.target = target;
  live.current.mood = mood;
  live.current.reducedMotion = reducedMotion;

  // ── where to stand (every render: the target moves, the bubble resizes) ──
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const size = { width: box.offsetWidth, height: box.offsetHeight };
    const placed = placeGuide(viewport, size, target, placement, { margin: compact ? 8 : 12 });
    const state = live.current;
    state.x.target = placed.x;
    state.y.target = placed.y;
    if (!state.placed || state.reducedMotion) {
      snapSpring(state.x);
      snapSpring(state.y);
      box.style.transform = `translate3d(${placed.x}px, ${placed.y}px, 0)`;
      state.placed = true;
    }
    // Stand on the side nearer the target, so the arm reaches toward it.
    const wantRight = placed.side === 'left';
    if (wantRight !== characterOnRight) setCharacterOnRight(wantRight);
  });

  // ── new words: talk + pop kernels ──
  useEffect(() => {
    const state = live.current;
    const now = performance.now() / 1000;
    state.talkUntil = now + Math.min(2.6, 0.5 + speechLength * 0.03);
    if (state.reducedMotion) return;
    state.kernels.forEach((kernel, index) => {
      if (index >= 3 + Math.floor(Math.random() * (KERNELS - 2))) return;
      kernel.active = true;
      kernel.age = -index * 0.06;
      kernel.x = 44 + Math.random() * 32;
      kernel.y = 34;
      kernel.vx = (Math.random() - 0.5) * 150;
      kernel.vy = -120 - Math.random() * 70;
      kernel.rotation = Math.random() * 360;
      kernel.spin = (Math.random() - 0.5) * 540;
    });
  }, [speechKey, speechLength]);

  // ── the loop ──
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = (nowMs: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (nowMs - last) / 1000);
      last = nowMs;
      const t = nowMs / 1000;
      const state = live.current;
      const still = state.reducedMotion;

      // Position.
      if (still) {
        snapSpring(state.x);
        snapSpring(state.y);
      } else {
        stepSpring(state.x, dt, 140, 20);
        stepSpring(state.y, dt, 140, 20);
      }
      if (boxRef.current) boxRef.current.style.transform = `translate3d(${state.x.value}px, ${state.y.value}px, 0)`;

      // Body: bob, and lean into the glide.
      const lean = still ? 0 : Math.max(-8, Math.min(8, state.x.velocity * 0.012));
      const bob = still ? 0 : Math.sin(t * 2.6) * 2.4;
      const squash = still ? 1 : 1 + Math.sin(t * 2.6 + Math.PI / 2) * 0.012;
      bodyRef.current?.setAttribute(
        'transform',
        `translate(0 ${bob.toFixed(2)}) rotate(${lean.toFixed(2)} 60 138) translate(60 138) scale(${(2 - squash).toFixed(4)} ${squash.toFixed(4)}) translate(-60 -138)`,
      );

      // Blink.
      if (!still && t > state.nextBlink + 0.13) state.nextBlink = t + 2.2 + Math.random() * 3;
      const blinking = !still && t >= state.nextBlink && t < state.nextBlink + 0.13;
      eyesRef.current?.setAttribute('transform', blinking ? 'translate(0 91) scale(1 0.12) translate(0 -91)' : '');

      // Talking mouth.
      const talking = !still && t < state.talkUntil && Math.floor(t / 0.12) % 2 === 0;
      if (moodMouthRef.current) moodMouthRef.current.style.display = talking ? 'none' : '';
      if (talkMouthRef.current) talkMouthRef.current.style.display = talking ? '' : 'none';

      // Arms: the one on the target's side points at it.
      const svg = svgRef.current;
      let pointLeft: number | null = null;
      let pointRight: number | null = null;
      if (svg && state.target) {
        const rect = svg.getBoundingClientRect();
        const scale = rect.width / VIEW.width;
        const toScreen = (p: { x: number; y: number }) => ({
          x: rect.x + (p.x - VIEW.x) * scale,
          y: rect.y + (p.y - VIEW.y) * scale,
        });
        const goal = { x: state.target.x + state.target.width / 2, y: state.target.y + state.target.height / 2 };
        const centre = toScreen({ x: 60, y: 94 });
        const side = goal.x >= centre.x ? 'right' : 'left';
        const shoulder = toScreen(SHOULDER[side]);
        const angle = (Math.atan2(goal.y - shoulder.y, goal.x - shoulder.x) * 180) / Math.PI;
        if (side === 'right') pointRight = angle;
        else pointLeft = angle;
      }
      const cheer = state.mood === 'celebrate';
      const wave = still ? 0 : Math.sin(t * 9) * 14;
      const idleSwing = still ? 0 : Math.sin(t * 2.6) * 4;
      const leftGoal = pointLeft ?? (cheer ? -130 + wave : 112 - idleSwing);
      const rightGoal = pointRight ?? (cheer ? -50 - wave : 68 + idleSwing);
      for (const [arm, goal] of [
        [state.armLeft, leftGoal],
        [state.armRight, rightGoal],
      ] as [Spring, number][]) {
        let wanted = goal;
        while (wanted - arm.value > 180) wanted -= 360;
        while (wanted - arm.value < -180) wanted += 360;
        arm.target = wanted;
        if (still) snapSpring(arm);
        else stepSpring(arm, dt, 120, 16);
      }
      armRefs.current.left?.setAttribute('transform', `rotate(${state.armLeft.value.toFixed(2)} ${SHOULDER.left.x} ${SHOULDER.left.y})`);
      armRefs.current.right?.setAttribute('transform', `rotate(${state.armRight.value.toFixed(2)} ${SHOULDER.right.x} ${SHOULDER.right.y})`);

      // Kernels: up, over, down, fade.
      state.kernels.forEach((kernel, index) => {
        const element = kernelRefs.current[index];
        if (!element) return;
        if (!kernel.active || still) {
          element.style.display = 'none';
          return;
        }
        kernel.age += dt;
        if (kernel.age < 0) {
          element.style.display = 'none';
          return;
        }
        kernel.vy += 380 * dt;
        kernel.x += kernel.vx * dt;
        kernel.y += kernel.vy * dt;
        kernel.rotation += kernel.spin * dt;
        const life = 1.3;
        if (kernel.age > life) {
          kernel.active = false;
          element.style.display = 'none';
          return;
        }
        element.style.display = '';
        element.setAttribute('transform', `translate(${kernel.x.toFixed(1)} ${kernel.y.toFixed(1)}) rotate(${kernel.rotation.toFixed(0)})`);
        element.setAttribute('opacity', String(Math.min(1, (life - kernel.age) / 0.4).toFixed(2)));
      });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const characterWidth = compact ? 68 : 100;
  const bubbleWidth = compact ? `min(300px, calc(100vw - ${characterWidth + 24}px))` : '320px';

  const arm = (side: 'left' | 'right') => (
    <g
      ref={(element) => {
        armRefs.current[side] = element;
      }}
    >
      <path
        d={`M${SHOULDER[side].x} ${SHOULDER[side].y} h${ARM_LENGTH}`}
        stroke={RED_DARK}
        strokeWidth='4.5'
        strokeLinecap='round'
      />
      <circle cx={SHOULDER[side].x + ARM_LENGTH + 2} cy={SHOULDER[side].y} r='5.5' fill='#fff4e6' stroke={RED_DARK} strokeWidth='1.6' />
    </g>
  );

  const character = (
    <svg
      ref={svgRef}
      aria-hidden='true'
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}
      width={characterWidth}
      height={(characterWidth * VIEW.height) / VIEW.width}
      className='flex-none overflow-visible drop-shadow-[0_6px_12px_rgba(0,0,0,0.5)]'
      style={{ overflow: 'visible' }}
    >
      <g ref={bodyRef}>
        <Bucket />
        {arm('left')}
        {arm('right')}
        <g ref={eyesRef}>
          <Eyes mood={mood} />
        </g>
        <Brows mood={mood} />
        <g ref={moodMouthRef}>
          <Mouth mood={mood} />
        </g>
        <ellipse ref={talkMouthRef} cx='60' cy='106' rx='5.5' ry='4.5' fill={INK} style={{ display: 'none' }} />
      </g>
      {Array.from({ length: KERNELS }, (_, index) => (
        <g
          key={index}
          ref={(element) => {
            kernelRefs.current[index] = element;
          }}
          style={{ display: 'none' }}
        >
          <circle cx='-3' cy='0' r='4.2' fill={CREAM} stroke={BUTTER} strokeWidth='1' />
          <circle cx='3' cy='-1' r='4.6' fill={CREAM} stroke={BUTTER} strokeWidth='1' />
          <circle cx='0' cy='3.5' r='3.8' fill={CREAM} stroke={BUTTER} strokeWidth='1' />
        </g>
      ))}
    </svg>
  );

  return (
    <div
      ref={boxRef}
      data-pop-guide=''
      className={`pointer-events-none fixed top-0 left-0 z-[10002] flex items-end gap-1 ${characterOnRight ? 'flex-row-reverse' : 'flex-row'}`}
      style={{ transform: 'translate3d(-9999px, -9999px, 0)' }}
    >
      {character}
      <div
        role='dialog'
        aria-modal='false'
        aria-label={label}
        className='pointer-events-auto relative mb-4 flex flex-col gap-2 rounded-2xl border-2 border-[#f2c14e] bg-primary-dark-gray p-3 text-[13px] leading-relaxed text-primary-white shadow-[0_12px_40px_rgba(0,0,0,0.6)] pointer-coarse:text-[15px]'
        style={{ width: bubbleWidth }}
      >
        <span
          aria-hidden='true'
          className={`absolute bottom-5 h-3 w-3 rotate-45 bg-primary-dark-gray ${
            characterOnRight ? '-right-[8px] border-t-2 border-r-2' : '-left-[8px] border-b-2 border-l-2'
          } border-[#f2c14e]`}
        />
        {children}
      </div>
    </div>
  );
}

export { Pop };
export type { PopMood, PopProps };
