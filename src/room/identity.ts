/**
 * Who you are in a room, without a server: ONE signing key per browser
 * profile, created on first use, kept non-extractable in IndexedDB.
 *
 * Trystero's peer id is random on every page load and self-asserted, so it
 * can never carry permissions (research R2 R16). The member id is derived
 * from the PUBLIC key — `memberId = base32(SHA-256(publicKey))[0..16]` — so
 * anyone can check that a signed message really comes from the member it
 * names, and the owner's per-person rules (Q5/Q6) survive reloads.
 *
 * Ed25519 where the browser has it (Chrome 137+, Firefox 129+, Safari 17+),
 * ECDSA P-256 otherwise. A public key is written `"<alg>:<base64url>"`.
 */
import { createIndexedDbStore } from '@theclearsky/easy-folder-management-ui';
import type { KeyValueStore } from '@theclearsky/easy-folder-management-ui';
import { fromBase64Url, toBase64Url } from './encoding';

type Algorithm = 'ed25519' | 'p256';

type Identity = {
  memberId: string;
  /** `"<alg>:<base64url raw public key>"` */
  publicKey: string;
  sign(data: Uint8Array): Promise<string>;
};

const PARAMS: Record<Algorithm, { generate: EcKeyGenParams | Algorithm_; sign: AlgorithmIdentifier | EcdsaParams; import: EcKeyImportParams | Algorithm_ }> = {
  ed25519: { generate: { name: 'Ed25519' }, sign: { name: 'Ed25519' }, import: { name: 'Ed25519' } },
  p256: {
    generate: { name: 'ECDSA', namedCurve: 'P-256' },
    sign: { name: 'ECDSA', hash: 'SHA-256' },
    import: { name: 'ECDSA', namedCurve: 'P-256' },
  },
};
type Algorithm_ = { name: string };

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The member id a public key stands for. */
async function memberIdOf(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicKey));
  return base32(new Uint8Array(digest)).slice(0, 16);
}

function splitKey(publicKey: string): { alg: Algorithm; raw: Uint8Array<ArrayBuffer> } | null {
  const at = publicKey.indexOf(':');
  const alg = publicKey.slice(0, at);
  if (alg !== 'ed25519' && alg !== 'p256') return null;
  try {
    return { alg, raw: fromBase64Url(publicKey.slice(at + 1)) };
  } catch {
    return null;
  }
}

const importedKeys = new Map<string, Promise<CryptoKey | null>>();

/** Verify `signature` (base64url) over `data` by `publicKey`. Never throws. */
async function verifySignature(publicKey: string, signature: string, data: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const parts = splitKey(publicKey);
  if (!parts) return false;
  let key = importedKeys.get(publicKey);
  if (!key) {
    key = crypto.subtle
      .importKey('raw', parts.raw, PARAMS[parts.alg].import, true, ['verify'])
      .catch(() => null);
    importedKeys.set(publicKey, key);
  }
  const imported = await key;
  if (!imported) return false;
  try {
    return await crypto.subtle.verify(PARAMS[parts.alg].sign, imported, fromBase64Url(signature), data);
  } catch {
    return false;
  }
}

async function generate(): Promise<{ alg: Algorithm; pair: CryptoKeyPair }> {
  for (const alg of ['ed25519', 'p256'] as const) {
    try {
      const pair = (await crypto.subtle.generateKey(PARAMS[alg].generate, false, ['sign', 'verify'])) as CryptoKeyPair;
      return { alg, pair };
    } catch {
      // Not supported here: try the next algorithm.
    }
  }
  throw new Error('This browser cannot create signing keys (WebCrypto unavailable).');
}

function identityFrom(alg: Algorithm, pair: CryptoKeyPair, publicKey: string, memberId: string): Identity {
  return {
    memberId,
    publicKey,
    async sign(data) {
      const signature = await crypto.subtle.sign(PARAMS[alg].sign, pair.privateKey, data as Uint8Array<ArrayBuffer>);
      return toBase64Url(new Uint8Array(signature));
    },
  };
}

/** Create an identity that is NOT stored (tests, private windows). */
async function createEphemeralIdentity(): Promise<Identity> {
  const { alg, pair } = await generate();
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const publicKey = `${alg}:${toBase64Url(raw)}`;
  return identityFrom(alg, pair, publicKey, await memberIdOf(publicKey));
}

/**
 * This browser's identity: loaded from IndexedDB, or created and stored on
 * first use. Asks the browser to keep the storage (so the key — and with it
 * every per-person rule that names you — is not evicted).
 */
async function loadIdentity(store: KeyValueStore = createIndexedDbStore('watch-together.identity')): Promise<Identity> {
  const stored = await store
    .get<{ alg: Algorithm; pair: CryptoKeyPair; publicKey: string }>('identity')
    .catch(() => undefined);
  if (stored?.pair?.privateKey && stored.publicKey) {
    return identityFrom(stored.alg, stored.pair, stored.publicKey, await memberIdOf(stored.publicKey));
  }
  const { alg, pair } = await generate();
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const publicKey = `${alg}:${toBase64Url(raw)}`;
  await store.set('identity', { alg, pair, publicKey }).catch(() => {});
  void navigator.storage?.persist?.().catch(() => false);
  return identityFrom(alg, pair, publicKey, await memberIdOf(publicKey));
}

export { createEphemeralIdentity, loadIdentity, memberIdOf, verifySignature };
export type { Identity };
