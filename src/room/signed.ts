/**
 * Signed messages: `{ payload, by, pub, sig }` where `sig` covers the
 * canonical JSON of `payload` (plus a purpose tag, so a signature made for
 * one kind of message can never be replayed as another), and `by` must be
 * the member id OF `pub`. `openSigned` checks both; anything else is dropped.
 */
import { canonicalJson, utf8 } from './encoding';
import type { Identity } from './identity';
import { memberIdOf, verifySignature } from './identity';

type Signed<T> = { payload: T; by: string; pub: string; sig: string };

async function seal<T>(identity: Identity, purpose: string, payload: T): Promise<Signed<T>> {
  const sig = await identity.sign(utf8(`${purpose}\n${canonicalJson(payload)}`));
  return { payload, by: identity.memberId, pub: identity.publicKey, sig };
}

/** The payload, when the signature is valid and `by` matches `pub`. */
async function openSigned<T>(purpose: string, message: Signed<T>): Promise<T | null> {
  if ((await memberIdOf(message.pub)) !== message.by) return null;
  const ok = await verifySignature(message.pub, message.sig, utf8(`${purpose}\n${canonicalJson(message.payload)}`));
  return ok ? message.payload : null;
}

export { openSigned, seal };
export type { Signed };
