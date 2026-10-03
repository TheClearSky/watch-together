/**
 * Room codes and invite links.
 *
 *   code  "lunar-otter-4821" — easy to read out; names the room AND is its
 *         secret: relays only ever see a hash of it, and connection details are
 *         encrypted with a password derived from it.
 *   link  https://theclearsky.github.io/watch-together/#/room/lunar-otter-4821
 *
 * The code alone must be enough — people read codes out loud. (An earlier
 * design put an extra key in the link; a code TYPED without it then used a
 * different password and could never meet the room — caught by the session
 * tests.) Entry is gated by approval, and identities by signatures, so the
 * code being guessable is not what keeps strangers out.
 */

const ADJECTIVES = [
  'amber', 'azure', 'bold', 'brave', 'bright', 'calm', 'clever', 'cosmic', 'cozy', 'crisp', 'dapper', 'dawn',
  'eager', 'early', 'fancy', 'fluffy', 'gentle', 'glad', 'golden', 'happy', 'hazy', 'jolly', 'kind', 'lively',
  'lucky', 'lunar', 'mellow', 'merry', 'misty', 'neon', 'nimble', 'noble', 'pastel', 'plucky', 'polar', 'quick',
  'quiet', 'rapid', 'rosy', 'royal', 'rusty', 'sandy', 'shiny', 'silent', 'silver', 'snowy', 'solar', 'spicy',
  'starry', 'sunny', 'swift', 'teal', 'tidy', 'velvet', 'vivid', 'warm', 'wild', 'windy', 'witty', 'zesty',
];
const NOUNS = [
  'otter', 'panda', 'fox', 'owl', 'koala', 'lynx', 'heron', 'tiger', 'whale', 'falcon', 'badger', 'beaver',
  'comet', 'meteor', 'nebula', 'planet', 'rocket', 'galaxy', 'harbor', 'island', 'meadow', 'canyon', 'forest',
  'river', 'lotus', 'maple', 'cedar', 'willow', 'pepper', 'mango', 'peach', 'plum', 'cookie', 'muffin',
  'popcorn', 'nacho', 'pixel', 'banjo', 'violin', 'cello', 'drum', 'lantern', 'kite', 'compass', 'anchor',
  'beacon', 'bridge', 'castle', 'garden', 'temple', 'tower', 'voyage', 'zephyr', 'aurora', 'ember', 'echo',
  'quartz', 'jade', 'onyx', 'opal',
];

const CODE_PATTERN = /^[a-z]+-[a-z]+-\d{4}$/;

function newRoomCode(): string {
  const pick = <T,>(list: readonly T[]) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
  const digits = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10_000).padStart(4, '0');
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits}`;
}

/** Tolerant of what people type: case, spaces, underscores, a pasted link. */
function normalizeRoomCode(input: string): string | null {
  const fromLink = /#\/room\/([^?\s]+)/.exec(input)?.[1];
  const code = decodeURIComponent(fromLink ?? input)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return CODE_PATTERN.test(code) ? code : null;
}

function inviteLink(code: string, base = `${location.origin}${location.pathname}`): string {
  return `${base}#/room/${code}`;
}

/** Trystero room id: the code is not sent to relays in the clear. */
async function transportRoomId(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`watch-together-room:${code}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function transportPassword(code: string): string {
  return `watch-together-code:${code}`;
}

export { inviteLink, newRoomCode, normalizeRoomCode, transportPassword, transportRoomId };
