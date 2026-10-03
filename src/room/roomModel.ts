/**
 * Who is in the room and what each person may do — plain data and a pure
 * reducer, no networking.
 *
 * IDENTITY. A member is keyed by a STABLE id (derived from a per-browser key,
 * see identity.ts), never by the transport's peer id, which changes on every
 * reload. That is what lets the owner's per-person rules survive a reconnect.
 *
 * AUTHORITY. The owner's copy is the truth. Every change is applied by the
 * owner (or, for admissions, an approver) and the whole state is broadcast;
 * members adopt a broadcast only if it is newer (`epoch`, then `version`).
 * `epoch` changes only when ownership changes hands, so a stale owner coming
 * back after a handoff can never overwrite the room.
 *
 * Rulings (Deepak, 2026-10-01):
 *  - Q5 "owner controls who can share, by default it is set to everyone, but
 *    owner has 2 controls- global setting and per person allow, deny or none
 *    (determined by global)".
 *  - Q6 "owner can decide, by default set to just owner" — who may approve
 *    join requests.
 */

type MemberId = string;

type Member = {
  id: MemberId;
  name: string;
  /** Picked avatar (a seed for the procedural face); absent = derived from the id. */
  avatar?: number;
  /** When the member was admitted (owner's clock, ms). Orders the handoff. */
  admittedAt: number;
};

type PendingRequest = { id: MemberId; name: string; avatar?: number; requestedAt: number };

/** Per-person share rule; no entry = follow the global default ("none"). */
type ShareRule = 'allow' | 'deny';

type RoomState = {
  code: string;
  owner: MemberId;
  /** Bumped on every ownership change. */
  epoch: number;
  /** Bumped on every other change within an epoch. */
  version: number;
  members: Readonly<Record<MemberId, Member>>;
  /** Who may approve join requests besides the owner (Q6: none by default). */
  approvers: readonly MemberId[];
  /** Q5 global: may members share unless a per-person rule says otherwise. */
  shareDefault: 'everyone' | 'nobody';
  /** Q5 per person. */
  shareRules: Readonly<Record<MemberId, ShareRule>>;
  pending: Readonly<Record<MemberId, PendingRequest>>;
  /** Removed by the owner; their join requests are refused without asking. */
  banned: readonly MemberId[];
};

type RoomAction =
  | { type: 'request'; id: MemberId; name: string; avatar?: number; at: number }
  | { type: 'cancelRequest'; id: MemberId }
  | { type: 'admit'; by: MemberId; id: MemberId; at: number }
  | { type: 'reject'; by: MemberId; id: MemberId }
  | { type: 'kick'; by: MemberId; id: MemberId }
  | { type: 'leave'; id: MemberId }
  | { type: 'rename'; id: MemberId; name: string; avatar?: number }
  | { type: 'setShareDefault'; by: MemberId; value: 'everyone' | 'nobody' }
  | { type: 'setShareRule'; by: MemberId; id: MemberId; rule: ShareRule | 'inherit' }
  | { type: 'setApprover'; by: MemberId; id: MemberId; approver: boolean }
  | { type: 'transferOwnership'; by: MemberId; to: MemberId }
  /** The owner vanished (disconnected, no goodbye): the successor (see
   *  `successorOf`) takes over. The old owner STAYS a member — a dropped
   *  connection is not leaving — and rejoins without approval. */
  | { type: 'claimOwnership'; by: MemberId; absentOwner: MemberId; present?: (id: MemberId) => boolean };

class RoomRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomRuleError';
  }
}

/** An avatar field only when there is one (signed payloads never carry `undefined`). */
const avatarField = (avatar: number | undefined) => (avatar === undefined ? {} : { avatar });

function createRoom(code: string, owner: { id: MemberId; name: string; avatar?: number }, at: number): RoomState {
  return {
    code,
    owner: owner.id,
    epoch: 1,
    version: 0,
    members: { [owner.id]: { id: owner.id, name: owner.name, ...avatarField(owner.avatar), admittedAt: at } },
    approvers: [],
    shareDefault: 'everyone',
    shareRules: {},
    pending: {},
    banned: [],
  };
}

// ── questions ─────────────────────────────────────────────────────────────

function isMember(state: RoomState, id: MemberId): boolean {
  return state.members[id] !== undefined;
}

function canApprove(state: RoomState, id: MemberId): boolean {
  return id === state.owner || (isMember(state, id) && state.approvers.includes(id));
}

/** Q5: the owner always may; otherwise a per-person rule, else the default. */
function canShare(state: RoomState, id: MemberId): boolean {
  if (!isMember(state, id)) return false;
  if (id === state.owner) return true;
  const rule = state.shareRules[id];
  if (rule !== undefined) return rule === 'allow';
  return state.shareDefault === 'everyone';
}

/** What the owner's per-person control shows: a rule, or "none" (inherit). */
function shareRuleOf(state: RoomState, id: MemberId): ShareRule | 'inherit' {
  return state.shareRules[id] ?? 'inherit';
}

/**
 * Who takes over when the owner is gone: an approver first (the owner
 * already trusted them with the door), earliest admitted; else the
 * earliest-admitted member. Ties break on id, so every member computes the
 * same answer with no vote.
 */
function successorOf(state: RoomState, present: (id: MemberId) => boolean = () => true): MemberId | null {
  const candidates = Object.values(state.members).filter(
    (member) => member.id !== state.owner && present(member.id),
  );
  if (candidates.length === 0) return null;
  const order = (a: Member, b: Member) =>
    a.admittedAt - b.admittedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const approvers = candidates.filter((member) => state.approvers.includes(member.id)).sort(order);
  return (approvers[0] ?? candidates.sort(order)[0]).id;
}

/** Should a received broadcast replace ours? Newer epoch, then newer version. */
function isNewer(incoming: RoomState, current: RoomState): boolean {
  if (incoming.code !== current.code) return false;
  if (incoming.epoch !== current.epoch) return incoming.epoch > current.epoch;
  return incoming.version > current.version;
}

// ── the reducer ───────────────────────────────────────────────────────────

function bump(state: RoomState, patch: Partial<RoomState>): RoomState {
  return { ...state, ...patch, version: state.version + 1 };
}

function without<T>(record: Readonly<Record<string, T>>, id: string): Record<string, T> {
  const { [id]: _removed, ...rest } = record;
  return rest;
}

function requireOwner(state: RoomState, by: MemberId) {
  if (by !== state.owner) throw new RoomRuleError('Only the room owner can do that.');
}

/** Drop every per-person trace of a member who is no longer in the room. */
function forget(state: RoomState, id: MemberId): Partial<RoomState> {
  return {
    members: without(state.members, id),
    approvers: state.approvers.filter((other) => other !== id),
    shareRules: without(state.shareRules, id),
  };
}

/**
 * Apply `action`. Throws `RoomRuleError` when the actor is not allowed —
 * callers on the owner's side report it back; a broadcast is never built
 * from a refused action.
 */
function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case 'request': {
      if (isMember(state, action.id)) return state;
      if (state.banned.includes(action.id)) throw new RoomRuleError('You were removed from this room.');
      return bump(state, {
        pending: {
          ...state.pending,
          [action.id]: { id: action.id, name: action.name, ...avatarField(action.avatar), requestedAt: action.at },
        },
      });
    }
    case 'cancelRequest': {
      if (!state.pending[action.id]) return state;
      return bump(state, { pending: without(state.pending, action.id) });
    }
    case 'admit': {
      if (!canApprove(state, action.by)) throw new RoomRuleError('You cannot approve join requests.');
      const request = state.pending[action.id];
      if (!request) return state;
      return bump(state, {
        pending: without(state.pending, action.id),
        members: {
          ...state.members,
          [action.id]: { id: action.id, name: request.name, ...avatarField(request.avatar), admittedAt: action.at },
        },
      });
    }
    case 'reject': {
      if (!canApprove(state, action.by)) throw new RoomRuleError('You cannot approve join requests.');
      if (!state.pending[action.id]) return state;
      return bump(state, { pending: without(state.pending, action.id) });
    }
    case 'kick': {
      requireOwner(state, action.by);
      if (action.id === state.owner) throw new RoomRuleError('The owner cannot remove themselves.');
      if (!isMember(state, action.id) && !state.pending[action.id]) return state;
      return bump(state, {
        ...forget(state, action.id),
        pending: without(state.pending, action.id),
        banned: [...state.banned.filter((id) => id !== action.id), action.id],
      });
    }
    case 'leave': {
      if (!isMember(state, action.id)) return state;
      if (action.id === state.owner) {
        // The owner leaving hands the room on, like a claim by the successor.
        const next = successorOf(state);
        if (next === null) return bump(state, forget(state, action.id));
        return { ...state, ...forget(state, action.id), owner: next, epoch: state.epoch + 1, version: 0 };
      }
      return bump(state, forget(state, action.id));
    }
    case 'rename': {
      const member = state.members[action.id];
      const name = action.name.trim().slice(0, 40);
      const avatar = action.avatar ?? member?.avatar;
      if (!member || name.length === 0 || (name === member.name && avatar === member.avatar)) return state;
      return bump(state, { members: { ...state.members, [action.id]: { ...member, name, ...avatarField(avatar) } } });
    }
    case 'setShareDefault': {
      requireOwner(state, action.by);
      if (state.shareDefault === action.value) return state;
      return bump(state, { shareDefault: action.value });
    }
    case 'setShareRule': {
      requireOwner(state, action.by);
      if (!isMember(state, action.id) || action.id === state.owner) return state;
      if (shareRuleOf(state, action.id) === action.rule) return state;
      return bump(state, {
        shareRules:
          action.rule === 'inherit'
            ? without(state.shareRules, action.id)
            : { ...state.shareRules, [action.id]: action.rule },
      });
    }
    case 'setApprover': {
      requireOwner(state, action.by);
      if (!isMember(state, action.id) || action.id === state.owner) return state;
      const has = state.approvers.includes(action.id);
      if (has === action.approver) return state;
      return bump(state, {
        approvers: action.approver
          ? [...state.approvers, action.id]
          : state.approvers.filter((id) => id !== action.id),
      });
    }
    case 'transferOwnership': {
      requireOwner(state, action.by);
      if (!isMember(state, action.to) || action.to === state.owner) return state;
      return { ...state, owner: action.to, epoch: state.epoch + 1, version: 0 };
    }
    case 'claimOwnership': {
      if (action.absentOwner !== state.owner) return state; // someone already took over
      if (!action.present && successorOf(state) !== action.by) throw new RoomRuleError('You are not next in line.');
      if (action.present && successorOf(state, action.present) !== action.by) {
        throw new RoomRuleError('You are not next in line.');
      }
      return { ...state, owner: action.by, epoch: state.epoch + 1, version: 0 };
    }
  }
}

export {
  canApprove,
  canShare,
  createRoom,
  isMember,
  isNewer,
  roomReducer,
  RoomRuleError,
  shareRuleOf,
  successorOf,
};
export type { Member, MemberId, PendingRequest, RoomAction, RoomState, ShareRule };
