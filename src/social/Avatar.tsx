/**
 * Procedural avatars: a seed (0–65535) → a little snack-bar character.
 * No images, no network — the same seed draws the same face for everyone in
 * the room (the seed travels with the name, see room/protocol.ts). People who
 * never pick one get a face derived from their member id.
 *
 *   seed bits:  0–3 colour · 4–6 eyes · 7–9 mouth · 10–12 hat · 13–15 shape
 */

const COLORS = [
  ['#f6b93b', '#e58e26'], // butter
  ['#ff7a7a', '#e05656'], // cherry
  ['#7bd389', '#4fae62'], // mint
  ['#6cb6ff', '#3d8fe0'], // sky
  ['#c38bff', '#9a5ee8'], // grape
  ['#ffb3d1', '#f27fae'], // bubblegum
  ['#ffd36e', '#f0b532'], // lemon
  ['#5fd4c9', '#2fb0a4'], // teal
  ['#ff9f5a', '#ef7a2b'], // tangerine
  ['#a7b4ff', '#7d8cf0'], // periwinkle
  ['#9be15d', '#6fc12f'], // lime
  ['#f7a8a8', '#e57d7d'], // peach
  ['#d9a066', '#b97d41'], // caramel
  ['#8fd3ff', '#58b6f0'], // ice
  ['#ff8fd8', '#ec5fbe'], // flamingo
  ['#b8e986', '#8fcb52'], // pistachio
] as const;

const INK = '#2a1d16';

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 65536;
}

/** The seed to draw: the picked one, else one derived from the member id. */
function avatarSeed(avatar: number | undefined, memberId: string): number {
  return avatar ?? hashSeed(memberId);
}

function randomAvatar(): number {
  return crypto.getRandomValues(new Uint16Array(1))[0];
}

function Eyes({ kind }: { kind: number }) {
  switch (kind) {
    case 0: // dots
      return (
        <g fill={INK}>
          <circle cx='38' cy='50' r='4.5' />
          <circle cx='62' cy='50' r='4.5' />
        </g>
      );
    case 1: // happy arcs
      return (
        <g fill='none' stroke={INK} strokeWidth='4' strokeLinecap='round'>
          <path d='M32 52 Q38 44 44 52' />
          <path d='M56 52 Q62 44 68 52' />
        </g>
      );
    case 2: // big shiny
      return (
        <g>
          <circle cx='38' cy='50' r='7.5' fill={INK} />
          <circle cx='62' cy='50' r='7.5' fill={INK} />
          <circle cx='40.5' cy='47' r='2.6' fill='#fff' />
          <circle cx='64.5' cy='47' r='2.6' fill='#fff' />
        </g>
      );
    case 3: // wink
      return (
        <g>
          <circle cx='38' cy='50' r='4.5' fill={INK} />
          <path d='M56 50 L68 50' stroke={INK} strokeWidth='4' strokeLinecap='round' />
        </g>
      );
    case 4: // sleepy
      return (
        <g fill='none' stroke={INK} strokeWidth='4' strokeLinecap='round'>
          <path d='M32 49 Q38 55 44 49' />
          <path d='M56 49 Q62 55 68 49' />
        </g>
      );
    case 5: // sunglasses
      return (
        <g fill={INK}>
          <rect x='27' y='44' width='19' height='11' rx='4' />
          <rect x='54' y='44' width='19' height='11' rx='4' />
          <rect x='45' y='46' width='10' height='3' />
          <rect x='30' y='46' width='6' height='2.5' fill='#ffffff55' />
        </g>
      );
    case 6: // star eyes
      return (
        <g fill={INK}>
          <path d='M38 43 l2.2 4.6 5 .7 -3.6 3.5 .9 5 -4.5 -2.4 -4.5 2.4 .9 -5 -3.6 -3.5 5 -.7z' />
          <path d='M62 43 l2.2 4.6 5 .7 -3.6 3.5 .9 5 -4.5 -2.4 -4.5 2.4 .9 -5 -3.6 -3.5 5 -.7z' />
        </g>
      );
    default: // round glasses
      return (
        <g>
          <circle cx='38' cy='50' r='3.6' fill={INK} />
          <circle cx='62' cy='50' r='3.6' fill={INK} />
          <g fill='none' stroke={INK} strokeWidth='2.6'>
            <circle cx='38' cy='50' r='9' />
            <circle cx='62' cy='50' r='9' />
            <path d='M47 50 L53 50' />
          </g>
        </g>
      );
  }
}

function Mouth({ kind }: { kind: number }) {
  const stroke = { fill: 'none', stroke: INK, strokeWidth: 4, strokeLinecap: 'round' as const };
  switch (kind) {
    case 0:
      return <path d='M40 64 Q50 73 60 64' {...stroke} />;
    case 1: // open laugh
      return (
        <g>
          <path d='M38 62 Q50 80 62 62 Z' fill={INK} />
          <path d='M44 70 Q50 75 56 70' fill='#ff7f8f' />
        </g>
      );
    case 2: // little o
      return <ellipse cx='50' cy='67' rx='4.5' ry='5.5' fill={INK} />;
    case 3: // cat
      return <path d='M40 64 Q45 69 50 64 Q55 69 60 64' {...stroke} strokeWidth={3.5} />;
    case 4: // tongue
      return (
        <g>
          <path d='M40 63 Q50 71 60 63' {...stroke} />
          <path d='M50 67 q6 0 6 6 q0 5 -6 5 q-6 0 -6 -5 q0 -6 6 -6z' fill='#ff7f8f' stroke={INK} strokeWidth='2' />
        </g>
      );
    case 5: // grin
      return (
        <g>
          <rect x='38' y='61' width='24' height='10' rx='5' fill='#fff' stroke={INK} strokeWidth='3' />
          <path d='M50 61 L50 71' stroke={INK} strokeWidth='2' />
        </g>
      );
    case 6: // smirk
      return <path d='M42 66 Q53 70 60 61' {...stroke} />;
    default: // flat
      return <path d='M42 66 L58 66' {...stroke} />;
  }
}

function Hat({ kind, color }: { kind: number; color: string }) {
  switch (kind) {
    case 1: // popcorn kernels
      return (
        <g fill='#fff8e1' stroke='#e8c66a' strokeWidth='1.5'>
          <circle cx='38' cy='17' r='8' />
          <circle cx='50' cy='12' r='9' />
          <circle cx='62' cy='17' r='8' />
        </g>
      );
    case 2: // party hat
      return (
        <g>
          <path d='M50 0 L62 24 L38 24 Z' fill='#ff6b9a' stroke={INK} strokeWidth='2.5' strokeLinejoin='round' />
          <circle cx='50' cy='2' r='4' fill='#ffd36e' stroke={INK} strokeWidth='2' />
        </g>
      );
    case 3: // headphones
      return (
        <g fill='none' stroke={INK} strokeWidth='4'>
          <path d='M18 52 Q18 14 50 14 Q82 14 82 52' />
          <rect x='12' y='46' width='10' height='18' rx='4' fill={INK} />
          <rect x='78' y='46' width='10' height='18' rx='4' fill={INK} />
        </g>
      );
    case 4: // antenna
      return (
        <g>
          <path d='M50 20 L50 6' stroke={INK} strokeWidth='3' />
          <circle cx='50' cy='5' r='4.5' fill={color} stroke={INK} strokeWidth='2.5' />
        </g>
      );
    case 5: // bow
      return (
        <g fill='#ff6b9a' stroke={INK} strokeWidth='2.5' strokeLinejoin='round'>
          <path d='M50 20 L36 12 L36 28 Z' />
          <path d='M50 20 L64 12 L64 28 Z' />
          <circle cx='50' cy='20' r='4' />
        </g>
      );
    case 6: // beanie
      return (
        <g>
          <path d='M24 32 Q24 8 50 8 Q76 8 76 32 Z' fill='#4772b3' stroke={INK} strokeWidth='2.5' />
          <rect x='22' y='28' width='56' height='8' rx='4' fill='#5d8ad0' stroke={INK} strokeWidth='2.5' />
          <circle cx='50' cy='7' r='5' fill='#fff' stroke={INK} strokeWidth='2' />
        </g>
      );
    case 7: // sprout
      return (
        <g stroke={INK} strokeWidth='2.5' strokeLinejoin='round'>
          <path d='M50 22 L50 10' fill='none' />
          <path d='M50 12 Q40 2 32 8 Q40 16 50 12Z' fill='#7bd389' />
          <path d='M50 12 Q60 2 68 8 Q60 16 50 12Z' fill='#7bd389' />
        </g>
      );
    default:
      return null;
  }
}

function headPath(shape: number): string {
  switch (shape % 4) {
    case 0: // round
      return 'M50 20 C74 20 84 36 84 56 C84 76 70 88 50 88 C30 88 16 76 16 56 C16 36 26 20 50 20Z';
    case 1: // squircle
      return 'M30 22 H70 Q84 22 84 36 V74 Q84 88 70 88 H30 Q16 88 16 74 V36 Q16 22 30 22Z';
    case 2: // bucket (wider at the top, like Pop)
      return 'M14 24 H86 L78 84 Q77 88 72 88 H28 Q23 88 22 84 Z';
    default: // blob
      return 'M50 18 C70 18 86 30 85 52 C84 74 74 88 52 89 C28 90 15 76 15 54 C15 34 30 18 50 18Z';
  }
}

function Avatar({ seed, size = 40, title, className }: { seed: number; size?: number; title?: string; className?: string }) {
  const [fill, shade] = COLORS[seed & 15];
  const eyes = (seed >> 4) & 7;
  const mouth = (seed >> 7) & 7;
  const hat = (seed >> 10) & 7;
  const shape = (seed >> 13) & 7;
  const stripes = shape % 4 === 2;
  return (
    <svg
      viewBox='0 0 100 100'
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={className}
    >
      {title && <title>{title}</title>}
      <path d={headPath(shape)} fill={fill} stroke={INK} strokeWidth='3' strokeLinejoin='round' />
      {stripes && (
        <g fill={shade} opacity='0.55'>
          <path d='M30 24 H40 L38 88 H30 Z' />
          <path d='M60 24 H70 L70 88 H62 Z' />
        </g>
      )}
      {!stripes && <ellipse cx='50' cy='80' rx='24' ry='6' fill={shade} opacity='0.35' />}
      <g fill='#ff8fa3' opacity='0.55'>
        <ellipse cx='28' cy='62' rx='6' ry='3.5' />
        <ellipse cx='72' cy='62' rx='6' ry='3.5' />
      </g>
      <Eyes kind={eyes} />
      <Mouth kind={mouth} />
      <Hat kind={hat} color={fill} />
    </svg>
  );
}

/** Overlapping faces of the people in a room. */
function AvatarStack({ people, max = 5, size = 28 }: { people: { id: string; name: string; seed: number }[]; max?: number; size?: number }) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span className='flex items-center'>
      {shown.map((person, index) => (
        <span
          key={person.id}
          className='rounded-full bg-[#2a2320] ring-2 ring-[#1b1613]'
          style={{ marginLeft: index === 0 ? 0 : -size / 3 }}
          title={person.name}
        >
          <Avatar seed={person.seed} size={size} />
        </span>
      ))}
      {extra > 0 && (
        <span
          className='flex items-center justify-center rounded-full bg-[#3a302a] text-[11px] font-semibold text-[#f3e6d3] ring-2 ring-[#1b1613]'
          style={{ width: size, height: size, marginLeft: -size / 3 }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}

export { Avatar, AvatarStack, avatarSeed, hashSeed, randomAvatar };
