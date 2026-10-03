/**
 * Every message the room sends, validated with zod on arrival — a peer is
 * another person's browser running who-knows-what, so nothing is trusted
 * because it parsed as JSON.
 *
 * Handshake (Trystero `onPeerHandshake`, both sides, before a peer is active):
 *   1. hello   {pub, name, nonce, inRoom}
 *   2. proof   {sig over the pair transcript, ticket?}   — proves the key
 *   3. verdict {accept, reason?}  — from an established member to a joiner
 *
 * Room actions (after admission): `room-state` (owner-signed), `admitted` /
 * `rejected` (an approver's decision about a pending joiner), `member-op`
 * (a member asks the owner: leave, rename), `kick` (owner-signed).
 */
import { z } from 'zod';

const memberId = z.string().regex(/^[a-z2-7]{16}$/);
const publicKey = z.string().regex(/^(ed25519|p256):[A-Za-z0-9_-]{40,140}$/);
const signature = z.string().regex(/^[A-Za-z0-9_-]{40,200}$/);
const name = z.string().trim().min(1).max(40);
/** A procedural-avatar seed (see src/social/Avatar.tsx). */
const avatar = z.number().int().min(0).max(65535).optional();

const signed = <T extends z.ZodType>(payload: T) =>
  z.object({ payload, by: memberId, pub: publicKey, sig: signature });

const helloSchema = z.object({
  t: z.literal('hello'),
  v: z.literal(1),
  pub: publicKey,
  name,
  avatar,
  nonce: z.string().min(16).max(64),
  inRoom: z.boolean(),
});

/** What an approver signs when letting someone in. */
const ticketPayload = z.object({
  kind: z.literal('ticket'),
  room: z.string(),
  member: memberId,
  pub: publicKey,
  name,
  avatar,
  at: z.number(),
});
const ticketSchema = signed(ticketPayload);

const proofSchema = z.object({
  t: z.literal('proof'),
  sig: signature,
  ticket: ticketSchema.optional(),
});

const verdictSchema = z.object({
  t: z.literal('verdict'),
  accept: z.boolean(),
  reason: z.enum(['rejected', 'banned', 'timeout', 'other-room']).optional(),
  /** The approver's ticket for a newly admitted joiner, so the joiner can
   *  show it to members who have not heard the decision yet. */
  ticket: ticketSchema.optional(),
});

const memberSchema = z.object({ id: memberId, name, avatar, admittedAt: z.number() });

const roomStatePayload = z.object({
  kind: z.literal('room-state'),
  state: z.object({
    code: z.string(),
    owner: memberId,
    epoch: z.number().int().positive(),
    version: z.number().int().nonnegative(),
    members: z.record(z.string(), memberSchema),
    approvers: z.array(memberId),
    shareDefault: z.enum(['everyone', 'nobody']),
    shareRules: z.record(z.string(), z.enum(['allow', 'deny'])),
    pending: z.record(z.string(), z.object({ id: memberId, name, avatar, requestedAt: z.number() })),
    banned: z.array(memberId),
  }),
  /** Public key of every member, so any member's signature can be checked. */
  keys: z.record(z.string(), publicKey),
});
const roomStateSchema = signed(roomStatePayload);

const decisionPayload = z.object({
  kind: z.enum(['admitted', 'rejected']),
  room: z.string(),
  member: memberId,
  ticket: ticketSchema.optional(),
});
const decisionSchema = signed(decisionPayload);

const memberOpPayload = z.discriminatedUnion('op', [
  z.object({ kind: z.literal('member-op'), room: z.string(), op: z.literal('leave') }),
  z.object({ kind: z.literal('member-op'), room: z.string(), op: z.literal('rename'), name, avatar }),
]);
const memberOpSchema = signed(memberOpPayload);

const kickPayload = z.object({ kind: z.literal('kick'), room: z.string(), member: memberId });
const kickSchema = signed(kickPayload);

type Hello = z.infer<typeof helloSchema>;
type Proof = z.infer<typeof proofSchema>;
type Verdict = z.infer<typeof verdictSchema>;
type TicketPayload = z.infer<typeof ticketPayload>;
type RoomStatePayload = z.infer<typeof roomStatePayload>;
type DecisionPayload = z.infer<typeof decisionPayload>;
type MemberOpPayload = z.infer<typeof memberOpPayload>;
type KickPayload = z.infer<typeof kickPayload>;

export {
  decisionSchema,
  helloSchema,
  kickSchema,
  memberOpSchema,
  proofSchema,
  roomStateSchema,
  ticketSchema,
  verdictSchema,
};
export type { DecisionPayload, Hello, KickPayload, MemberOpPayload, Proof, RoomStatePayload, TicketPayload, Verdict };
