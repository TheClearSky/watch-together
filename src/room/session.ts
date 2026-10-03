/**
 * A room, live: identity + transport + the room model, glued together.
 *
 * JOINING (spike S1 + research R2 R14–R16). Every pair of browsers runs a
 * handshake before Trystero lets them talk:
 *   1. both send `hello` {public key, name, nonce, inRoom}
 *   2. both send `proof`: a signature over THIS pair's transcript (room, both
 *      peer ids, both nonces) — so a hello cannot be replayed by someone else
 *      — plus, for a freshly admitted member, the approver's signed ticket
 *   3. a member answering a JOINER sends `verdict`: accept or reject.
 * A member lets in: known members (by key — a reload rejoins silently), and
 * people holding a valid ticket. A joiner nobody knows is shown to every
 * approver (the owner, plus whoever the owner appointed — Q6); the first
 * decision is signed and broadcast, and every member applies it.
 *
 * AUTHORITY. The owner's room state is the truth: signed, versioned
 * (`epoch` changes only with ownership), adopted only when newer and signed
 * by the owner it names (or by the old owner handing over, or by the next in
 * line after the owner vanished for OWNER_GRACE_MS).
 */
import { canonicalJson, randomToken, utf8 } from './encoding';
import type { Identity } from './identity';
import { memberIdOf, verifySignature } from './identity';
import type { DecisionPayload, Hello, MemberOpPayload, RoomStatePayload, TicketPayload } from './protocol';
import {
  decisionSchema,
  helloSchema,
  kickSchema,
  memberOpSchema,
  proofSchema,
  roomStateSchema,
  ticketSchema,
  verdictSchema,
} from './protocol';
import { inviteLink, newRoomCode, transportPassword, transportRoomId } from './roomCode';
import type { MemberId, RoomAction, RoomState, ShareRule } from './roomModel';
import { canApprove, createRoom, isMember, isNewer, roomReducer, successorOf } from './roomModel';
import type { Signed } from './signed';
import { openSigned, seal } from './signed';
import type { HandshakeReceive, HandshakeSend, JoinTransport, TransportRoom } from './transport';

const HANDSHAKE_TIMEOUT_MS = 150_000;
const OWNER_GRACE_MS = 15_000;

type RoomStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  /** Asked to join; `heard` = how many people in the room answered so far. */
  | { kind: 'waiting'; since: number; heard: number }
  | { kind: 'in-room' }
  | { kind: 'rejected'; reason: 'rejected' | 'banned' | 'timeout' }
  | { kind: 'kicked' }
  | { kind: 'error'; message: string };

type JoinRequest = { memberId: string; name: string; avatar?: number; since: number };

type RoomSnapshot = {
  status: RoomStatus;
  me: { memberId: string; name: string; avatar?: number };
  code: string | null;
  link: string | null;
  room: RoomState | null;
  /** Members connected right now (yourself included). */
  online: ReadonlySet<MemberId>;
  /** Joiners waiting for YOUR decision (approvers only). */
  requests: readonly JoinRequest[];
  /** Something worth telling the user (owner handoff, a decision…). */
  notice: string | null;
};

type StoredRoom = { code: string; envelope: Signed<RoomStatePayload> | null };

type SessionOptions = {
  identity: Identity;
  join: JoinTransport;
  name: string;
  avatar?: number;
  now?: () => number;
  /** Persist the current room across reloads (sessionStorage in the app). */
  storage?: { load(): StoredRoom | null; save(room: StoredRoom | null): void };
  handshakeTimeoutMs?: number;
  ownerGraceMs?: number;
};

type PeerInfo = { memberId: string; pub: string; name: string; avatar?: number };

/** An avatar field only when there is one (signed/sent payloads never carry `undefined`). */
const avatarField = (avatar: number | undefined): { avatar: number } | Record<string, never> =>
  avatar === undefined ? {} : { avatar };

/** For features riding on the room's connections (sharing, chat). */
type RoomEvents = {
  /** A transport is up (a room was entered); `null` when it went away. */
  transport?(room: TransportRoom | null): void;
  /** An ADMITTED peer became reachable. */
  peerActive?(peerId: string, memberId: string): void;
  peerGone?(peerId: string, memberId: string | undefined): void;
};

class RoomSession {
  private readonly identity: Identity;
  private readonly joinTransport: JoinTransport;
  private readonly now: () => number;
  private readonly storage: SessionOptions['storage'];
  private readonly handshakeTimeoutMs: number;
  private readonly ownerGraceMs: number;
  private name: string;
  private avatar: number | undefined;

  private transport: TransportRoom | null = null;
  private code: string | null = null;
  private roomId = '';
  private state: RoomState | null = null;
  private keys: Record<string, string> = {};
  private envelope: Signed<RoomStatePayload> | null = null;
  private status: RoomStatus = { kind: 'idle' };
  private notice: string | null = null;
  private generation = 0;

  private readonly peers = new Map<string, PeerInfo>();
  /** My ticket, once admitted by an approver (shown to members who have not
   *  yet heard about me). */
  private myTicket: Signed<TicketPayload> | null = null;
  /** Joiners held for a human decision (approvers) or a broadcast decision
   *  (everyone else). */
  private readonly held = new Map<
    string,
    { name: string; avatar?: number; pub: string; since: number; resolvers: ((accept: boolean) => void)[]; human: boolean }
  >();
  private readonly decided = new Map<string, boolean>();
  /** Tickets seen for admitted joiners (handed to them in the verdict). */
  private readonly tickets = new Map<string, Signed<TicketPayload>>();
  private readonly inRoomWaiters = new Set<() => void>();
  private rejections = 0;
  private ownerTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly listeners = new Set<() => void>();
  private readonly roomEvents = new Set<RoomEvents>();
  private snapshot: RoomSnapshot;

  constructor(options: SessionOptions) {
    this.identity = options.identity;
    this.joinTransport = options.join;
    this.now = options.now ?? Date.now;
    this.storage = options.storage;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.ownerGraceMs = options.ownerGraceMs ?? OWNER_GRACE_MS;
    this.name = options.name;
    this.avatar = options.avatar;
    this.snapshot = this.build();
  }

  // ── store plumbing ──────────────────────────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  private build(): RoomSnapshot {
    const online = new Set<MemberId>([this.identity.memberId]);
    for (const peer of this.peers.values()) if (this.state && isMember(this.state, peer.memberId)) online.add(peer.memberId);
    return {
      status: this.status,
      me: { memberId: this.identity.memberId, name: this.name, ...avatarField(this.avatar) },
      code: this.code,
      link: this.code ? inviteLink(this.code, typeof location === 'undefined' ? 'https://example.invalid/' : undefined) : null,
      room: this.state,
      online,
      requests: [...this.held.entries()]
        .filter(([, entry]) => entry.human)
        .map(([memberId, entry]) => ({ memberId, name: entry.name, ...avatarField(entry.avatar), since: entry.since })),
      notice: this.notice,
    };
  }

  private emit() {
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }

  private setStatus(status: RoomStatus) {
    this.status = status;
    if (status.kind === 'in-room') for (const waiter of [...this.inRoomWaiters]) waiter();
    this.emit();
  }

  get inRoom(): boolean {
    return this.status.kind === 'in-room';
  }

  get me(): MemberId {
    return this.identity.memberId;
  }

  /** The Trystero room (media for sharing), when connected. */
  get media(): unknown {
    return this.transport?.media ?? null;
  }

  get transportRoom(): TransportRoom | null {
    return this.transport;
  }

  /** Listen to transport and peer events; returns an unsubscribe. */
  listen(events: RoomEvents): () => void {
    this.roomEvents.add(events);
    if (this.transport) events.transport?.(this.transport);
    return () => this.roomEvents.delete(events);
  }

  /** The member a connected peer is (after its handshake). */
  memberOfPeer(peerId: string): string | undefined {
    return this.peers.get(peerId)?.memberId;
  }

  /** Connected peers of a member (a member may have several tabs open). */
  peersOfMember(memberId: string): string[] {
    return [...this.peers.entries()].filter(([, info]) => info.memberId === memberId).map(([peerId]) => peerId);
  }

  /** Display name of a member, from the room or their handshake. */
  nameOf(memberId: string): string {
    return (
      this.state?.members[memberId]?.name ??
      [...this.peers.values()].find((info) => info.memberId === memberId)?.name ??
      'Someone'
    );
  }

  dismissNotice() {
    this.notice = null;
    this.emit();
  }

  // ── entering a room ─────────────────────────────────────────────────────

  /** A brand-new room, with you as its owner. */
  async create(code: string = newRoomCode()): Promise<string> {
    await this.open(code, { create: true });
    return code;
  }

  /** Ask to join `code`. */
  async join(code: string): Promise<void> {
    await this.open(code, { create: false });
  }

  /** Nobody answered: become the owner of this code yourself. */
  async createInstead(): Promise<void> {
    if (!this.code || this.inRoom) return;
    this.becomeOwnerOfNewRoom();
  }

  /** Rejoin the room stored before a reload, if any. */
  async resume(): Promise<boolean> {
    const stored = this.storage?.load();
    if (!stored) return false;
    await this.open(stored.code, { create: false, envelope: stored.envelope });
    return true;
  }

  private async open(code: string, how: { create: boolean; envelope?: Signed<RoomStatePayload> | null }) {
    await this.leave({ silent: true });
    const generation = ++this.generation;
    this.code = code;
    this.roomId = await transportRoomId(code);
    this.rejections = 0;
    this.notice = null;
    if (how.create) {
      this.becomeOwnerOfNewRoom();
    } else if (how.envelope && (await this.adoptStored(how.envelope))) {
      this.setStatus({ kind: 'in-room' });
    } else {
      this.setStatus({ kind: 'waiting', since: this.now(), heard: 0 });
    }
    const transport = await this.joinTransport(
      this.roomId,
      transportPassword(code),
      {
        onPeerHandshake: (peerId, send, receive) => this.handshake(peerId, send, receive),
        onJoinError: ({ peerId }) => this.onHandshakeFailed(peerId),
      },
      { handshakeTimeoutMs: this.handshakeTimeoutMs },
    );
    if (generation !== this.generation) {
      void transport.leave();
      return;
    }
    this.transport = transport;
    for (const events of this.roomEvents) events.transport?.(transport);
    transport.onPeerJoin((peerId) => this.onPeerJoin(peerId));
    transport.onPeerLeave((peerId) => this.onPeerLeave(peerId));
    transport.on('room-state', (data) => void this.onRoomState(data));
    transport.on('decision', (data) => void this.onDecision(data));
    transport.on('member-op', (data, peerId) => void this.onMemberOp(data, peerId));
    transport.on('kick', (data) => void this.onKick(data));
    this.persist();
  }

  private becomeOwnerOfNewRoom() {
    this.state = createRoom(this.code!, { id: this.me, name: this.name, avatar: this.avatar }, this.now());
    this.keys = { [this.me]: this.identity.publicKey };
    this.setStatus({ kind: 'in-room' });
    void this.publish();
  }

  private async adoptStored(envelope: Signed<RoomStatePayload>): Promise<boolean> {
    const parsed = roomStateSchema.safeParse(envelope);
    if (!parsed.success) return false;
    const payload = await openSigned('wt-room-state', parsed.data);
    if (!payload || payload.state.code !== this.code || payload.keys[parsed.data.by] !== parsed.data.pub) return false;
    if (!payload.state.members[this.me]) return false;
    this.state = payload.state as RoomState;
    this.keys = payload.keys;
    this.envelope = parsed.data;
    return true;
  }

  // ── the handshake ───────────────────────────────────────────────────────

  private transcript(from: string, to: string, fromNonce: string, toNonce: string) {
    return utf8(`wt-proof\n${canonicalJson({ room: this.roomId, from, to, fromNonce, toNonce })}`);
  }

  private async handshake(peerId: string, send: HandshakeSend, receive: HandshakeReceive): Promise<void> {
    const selfId = this.transport?.selfId ?? (await this.selfIdSoon());
    const nonce = randomToken(16);
    await send({
      t: 'hello',
      v: 1,
      pub: this.identity.publicKey,
      name: this.name,
      ...avatarField(this.avatar),
      nonce,
      inRoom: this.inRoom,
    });
    const hello: Hello = helloSchema.parse((await receive()).data);
    const theirId = await memberIdOf(hello.pub);
    const sig = await this.identity.sign(this.transcript(selfId, peerId, nonce, hello.nonce));
    await send({ t: 'proof', sig, ...(this.myTicket ? { ticket: this.myTicket } : {}) });
    const proof = proofSchema.parse((await receive()).data);
    if (!(await verifySignature(hello.pub, proof.sig, this.transcript(peerId, selfId, hello.nonce, nonce)))) {
      throw new Error('bad proof');
    }
    this.peers.set(peerId, { memberId: theirId, pub: hello.pub, name: hello.name, ...avatarField(hello.avatar) });

    let theyInRoom = hello.inRoom;
    let pendingReceive: Promise<{ data: unknown }> | null = null;
    if (!this.inRoom && !theyInRoom) {
      // Neither of us is in yet: wait for whichever gets in first.
      pendingReceive = receive();
      const first = await Promise.race([
        this.whenInRoom().then(() => 'me' as const),
        pendingReceive.then(() => 'them' as const),
      ]);
      if (first === 'me') {
        await send({ t: 'status', inRoom: true, ...(this.myTicket ? { ticket: this.myTicket } : {}) });
      } else {
        const status = (await pendingReceive).data as { t?: string; inRoom?: boolean; ticket?: unknown };
        pendingReceive = null;
        if (status?.t !== 'status' || status.inRoom !== true) throw new Error('bad status');
        theyInRoom = true;
        if (status.ticket) proof.ticket = ticketSchema.parse(status.ticket);
        if (this.inRoom) await send({ t: 'status', inRoom: true, ...(this.myTicket ? { ticket: this.myTicket } : {}) });
      }
    }

    if (this.inRoom && theyInRoom) {
      if (this.state && isMember(this.state, theirId)) return;
      if (proof.ticket && (await this.acceptTicket(proof.ticket, theirId))) return;
      throw new Error('not a member of this room');
    }
    if (!this.inRoom && theyInRoom) {
      const verdict = verdictSchema.parse((await (pendingReceive ?? receive())).data);
      if (this.status.kind === 'waiting') this.setStatus({ ...this.status, heard: this.status.heard + 1 });
      if (!verdict.accept) {
        this.noteRejection(verdict.reason === 'banned' ? 'banned' : 'rejected');
        throw new Error('rejected');
      }
      if (verdict.ticket && !this.myTicket) {
        const mine = await openSigned('wt-ticket', verdict.ticket);
        if (mine?.member === this.me && mine.room === this.roomId) this.myTicket = verdict.ticket;
      }
      return; // the room state follows as a message
    }
    // I am in the room; they are asking to join.
    const accept = await this.decideJoiner(theirId, hello.name, hello.pub, hello.avatar);
    const banned = this.state?.banned.includes(theirId) ?? false;
    const ticket = accept ? this.tickets.get(theirId) : undefined;
    await send({
      t: 'verdict',
      accept,
      ...(accept ? {} : { reason: banned ? 'banned' : 'rejected' }),
      ...(ticket ? { ticket } : {}),
    });
    if (!accept) throw new Error('denied');
  }

  private selfIdSoon(): Promise<string> {
    return new Promise((resolve) => {
      const check = () => (this.transport ? resolve(this.transport.selfId) : setTimeout(check, 10));
      check();
    });
  }

  private whenInRoom(): Promise<void> {
    if (this.inRoom) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = () => {
        this.inRoomWaiters.delete(waiter);
        resolve();
      };
      this.inRoomWaiters.add(waiter);
    });
  }

  private decideJoiner(memberId: string, name: string, pub: string, avatar?: number): Promise<boolean> {
    const state = this.state!;
    if (state.banned.includes(memberId)) return Promise.resolve(false);
    if (isMember(state, memberId)) return Promise.resolve(true);
    const known = this.decided.get(memberId);
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => {
      const entry = this.held.get(memberId) ?? {
        name,
        ...avatarField(avatar),
        pub,
        since: this.now(),
        resolvers: [],
        human: canApprove(state, this.me),
      };
      entry.resolvers.push(resolve);
      this.held.set(memberId, entry);
      this.emit();
    });
  }

  private settle(memberId: string, accept: boolean) {
    this.decided.set(memberId, accept);
    const entry = this.held.get(memberId);
    this.held.delete(memberId);
    entry?.resolvers.forEach((resolve) => resolve(accept));
    this.emit();
  }

  private onHandshakeFailed(peerId: string) {
    const info = this.peers.get(peerId);
    this.peers.delete(peerId);
    if (info && this.held.has(info.memberId)) {
      // The joiner gave up or timed out; drop the request if no other
      // connection of theirs is still asking.
      const stillAsking = [...this.peers.values()].some((peer) => peer.memberId === info.memberId);
      if (!stillAsking) {
        this.held.delete(info.memberId);
        this.emit();
      }
    }
  }

  private noteRejection(reason: 'rejected' | 'banned') {
    this.rejections += 1;
    this.setStatus({ kind: 'rejected', reason });
    void this.transport?.leave();
    this.transport = null;
    this.storage?.save(null);
  }

  // ── approvals ───────────────────────────────────────────────────────────

  async approve(memberId: string): Promise<void> {
    const entry = this.held.get(memberId);
    if (!entry || !this.state || !canApprove(this.state, this.me)) return;
    const ticket = await seal<TicketPayload>(this.identity, 'wt-ticket', {
      kind: 'ticket',
      room: this.roomId,
      member: memberId,
      pub: entry.pub,
      name: entry.name,
      ...avatarField(entry.avatar),
      at: this.now(),
    });
    const decision = await seal<DecisionPayload>(this.identity, 'wt-decision', {
      kind: 'admitted',
      room: this.roomId,
      member: memberId,
      ticket,
    });
    this.tickets.set(memberId, ticket);
    if (this.isOwner) this.admitWithTicket(ticket.payload);
    this.settle(memberId, true);
    await this.transport?.send('decision', decision);
  }

  async reject(memberId: string): Promise<void> {
    if (!this.held.has(memberId) || !this.state || !canApprove(this.state, this.me)) return;
    const decision = await seal<DecisionPayload>(this.identity, 'wt-decision', {
      kind: 'rejected',
      room: this.roomId,
      member: memberId,
    });
    this.settle(memberId, false);
    await this.transport?.send('decision', decision);
  }

  /** A ticket signed by someone who may approve in OUR view of the room. */
  private async acceptTicket(ticket: Signed<TicketPayload>, expectedMember?: string): Promise<boolean> {
    const parsed = ticketSchema.safeParse(ticket);
    if (!parsed.success || !this.state) return false;
    const payload = await openSigned('wt-ticket', parsed.data);
    if (!payload || payload.room !== this.roomId) return false;
    if (expectedMember && payload.member !== expectedMember) return false;
    if ((await memberIdOf(payload.pub)) !== payload.member) return false;
    if (!canApprove(this.state, parsed.data.by) || this.keys[parsed.data.by] !== parsed.data.pub) return false;
    if (this.state.banned.includes(payload.member)) return false;
    if (this.isOwner) this.admitWithTicket(payload);
    return true;
  }

  private admitWithTicket(ticket: TicketPayload) {
    if (!this.state || isMember(this.state, ticket.member)) return;
    this.keys = { ...this.keys, [ticket.member]: ticket.pub };
    this.applyAsOwner({ type: 'request', id: ticket.member, name: ticket.name, avatar: ticket.avatar, at: ticket.at });
    this.applyAsOwner({ type: 'admit', by: this.state.owner, id: ticket.member, at: this.now() });
  }

  private async onDecision(data: unknown) {
    const parsed = decisionSchema.safeParse(data);
    if (!parsed.success || !this.state) return;
    const payload = await openSigned('wt-decision', parsed.data);
    if (!payload || payload.room !== this.roomId) return;
    if (!canApprove(this.state, parsed.data.by) || this.keys[parsed.data.by] !== parsed.data.pub) return;
    if (payload.kind === 'admitted') {
      if (!payload.ticket || !(await this.acceptTicket(payload.ticket, payload.member))) return;
      if (payload.member === this.me) return;
      this.tickets.set(payload.member, payload.ticket);
      this.settle(payload.member, true);
    } else {
      this.settle(payload.member, false);
    }
  }

  // ── room state ──────────────────────────────────────────────────────────

  get isOwner(): boolean {
    return this.state?.owner === this.me;
  }

  private applyAsOwner(action: RoomAction) {
    if (!this.state || !this.isOwner) return;
    this.state = roomReducer(this.state, action);
    // Keys of people no longer in the room are dropped with them. (Pending
    // joiners keep theirs: admitting is request → admit, and dropping the
    // key in between made every later signature of theirs unverifiable.)
    this.keys = Object.fromEntries(
      Object.entries(this.keys).filter(([id]) => this.state!.members[id] || this.state!.pending[id]),
    );
    // Published even when this action handed ownership AWAY (leave,
    // transfer): the old owner's signature is what makes the handover valid.
    void this.publish({ handover: true });
    this.emit();
  }

  /**
   * Sign and broadcast the current state. Only the owner signs — or the
   * previous owner, once, for the state that hands the room over.
   */
  private async publish(options: { target?: string; handover?: boolean } = {}) {
    if (!this.state || (!this.isOwner && !options.handover)) return;
    this.envelope = await seal<RoomStatePayload>(this.identity, 'wt-room-state', {
      kind: 'room-state',
      state: this.state,
      // The signer's key always travels, so receivers can verify it — even
      // when the signer just left the room.
      keys: { ...this.keys, [this.me]: this.identity.publicKey },
    } as RoomStatePayload);
    this.persist();
    await this.transport?.send('room-state', this.envelope, options.target);
  }

  private async onRoomState(data: unknown) {
    const parsed = roomStateSchema.safeParse(data);
    if (!parsed.success) return;
    const envelope = parsed.data;
    const payload = await openSigned('wt-room-state', envelope);
    if (!payload || payload.state.code !== this.code) return;
    if (payload.keys[envelope.by] !== envelope.pub) return;
    const incoming = payload.state as RoomState;
    const current = this.state;
    const signer = envelope.by;
    if (current) {
      if (!isNewer(incoming, current)) return;
      const sameEpoch = incoming.epoch === current.epoch;
      const byOwner = signer === current.owner;
      // A claim: the next in line took over an owner who vanished. Valid when
      // that owner is not here — or IS here because it is me, back after
      // dropping out (then my own presence must not count against it).
      const ownerAway = current.owner === this.me || !this.snapshot.online.has(current.owner);
      const byClaimant =
        !sameEpoch &&
        signer === incoming.owner &&
        ownerAway &&
        successorOf(current, (id) => this.snapshot.online.has(id) || id === signer) === signer;
      if (sameEpoch ? !(byOwner && incoming.owner === current.owner) : !(byOwner || byClaimant)) return;
    } else if (signer !== incoming.owner) {
      return;
    }
    const wasOwner = this.isOwner;
    this.state = incoming;
    this.keys = payload.keys;
    this.envelope = envelope;
    if (current && current.owner !== incoming.owner) {
      const name = incoming.members[incoming.owner]?.name ?? 'Someone';
      this.notice = incoming.owner === this.me ? 'You are now the room owner.' : `${name} is now the room owner.`;
    }
    if (incoming.banned.includes(this.me)) {
      this.setStatus({ kind: 'kicked' });
      void this.leave({ silent: true, keepStatus: true });
      return;
    }
    if (isMember(incoming, this.me) && !this.inRoom) this.setStatus({ kind: 'in-room' });
    if (!wasOwner && this.isOwner) void this.publish();
    if (wasOwner && !this.isOwner) this.notice ??= 'You are no longer the room owner.';
    // Joiners I was holding may have been decided meanwhile.
    for (const memberId of [...this.held.keys()]) if (isMember(incoming, memberId)) this.settle(memberId, true);
    this.persist();
    this.emit();
  }

  private onPeerJoin(peerId: string) {
    const info = this.peers.get(peerId);
    if (info && this.ownerTimer && info.memberId === this.state?.owner) {
      clearTimeout(this.ownerTimer);
      this.ownerTimer = undefined;
    }
    // The owner signs the CURRENT state for a newcomer (an envelope taken
    // mid-update could be stale); others forward the owner's latest.
    if (this.isOwner) void this.publish({ target: peerId });
    else if (this.envelope) void this.transport?.send('room-state', this.envelope, peerId);
    this.emit();
    if (info) for (const events of this.roomEvents) events.peerActive?.(peerId, info.memberId);
  }

  private onPeerLeave(peerId: string) {
    const info = this.peers.get(peerId);
    this.peers.delete(peerId);
    this.emit();
    for (const events of this.roomEvents) events.peerGone?.(peerId, info?.memberId);
    if (!info || !this.state || info.memberId !== this.state.owner || this.isOwner) return;
    clearTimeout(this.ownerTimer);
    this.ownerTimer = setTimeout(() => this.claimIfNext(info.memberId), this.ownerGraceMs);
  }

  private claimIfNext(absentOwner: string) {
    this.ownerTimer = undefined;
    const state = this.state;
    if (!state || state.owner !== absentOwner || this.snapshot.online.has(absentOwner)) return;
    const present = (id: string) => this.snapshot.online.has(id);
    if (successorOf(state, present) !== this.me) return;
    this.state = roomReducer(state, { type: 'claimOwnership', by: this.me, absentOwner, present });
    this.notice = 'The owner left, so you are now the room owner.';
    void this.publish();
    this.emit();
  }

  // ── owner controls (Q5, Q6) ─────────────────────────────────────────────

  setShareDefault(value: 'everyone' | 'nobody') {
    if (this.isOwner) this.applyAsOwner({ type: 'setShareDefault', by: this.me, value });
  }

  setShareRule(memberId: string, rule: ShareRule | 'inherit') {
    if (this.isOwner) this.applyAsOwner({ type: 'setShareRule', by: this.me, id: memberId, rule });
  }

  setApprover(memberId: string, approver: boolean) {
    if (this.isOwner) this.applyAsOwner({ type: 'setApprover', by: this.me, id: memberId, approver });
  }

  transferOwnership(to: string) {
    if (this.isOwner) this.applyAsOwner({ type: 'transferOwnership', by: this.me, to });
  }

  async kick(memberId: string) {
    if (!this.isOwner) return;
    this.applyAsOwner({ type: 'kick', by: this.me, id: memberId });
    const message = await seal(this.identity, 'wt-kick', { kind: 'kick' as const, room: this.roomId, member: memberId });
    await this.transport?.send('kick', message);
    this.dropMember(memberId);
  }

  private async onKick(data: unknown) {
    const parsed = kickSchema.safeParse(data);
    if (!parsed.success || !this.state) return;
    const payload = await openSigned('wt-kick', parsed.data);
    if (!payload || payload.room !== this.roomId || parsed.data.by !== this.state.owner) return;
    if (payload.member === this.me) {
      this.setStatus({ kind: 'kicked' });
      void this.leave({ silent: true, keepStatus: true });
      return;
    }
    this.dropMember(payload.member);
  }

  private dropMember(memberId: string) {
    for (const [peerId, info] of this.peers) if (info.memberId === memberId) this.transport?.closePeer(peerId);
  }

  // ── member requests to the owner ────────────────────────────────────────

  /** Change my name (and avatar). Before joining, this is what the room will see. */
  async rename(name: string, avatar?: number) {
    const clean = name.trim().slice(0, 40);
    if (!clean) return;
    this.name = clean;
    if (avatar !== undefined) this.avatar = avatar;
    if (this.isOwner) this.applyAsOwner({ type: 'rename', id: this.me, name: clean, avatar: this.avatar });
    else if (this.inRoom) {
      await this.sendToOwner({ kind: 'member-op', room: this.roomId, op: 'rename', name: clean, ...avatarField(this.avatar) });
    }
    this.emit();
  }

  /** A member's avatar seed, from the room or their handshake (undefined: derive from the id). */
  avatarOf(memberId: string): number | undefined {
    if (memberId === this.me) return this.avatar;
    return (
      this.state?.members[memberId]?.avatar ??
      this.state?.pending[memberId]?.avatar ??
      [...this.peers.values()].find((info) => info.memberId === memberId)?.avatar ??
      this.held.get(memberId)?.avatar
    );
  }

  private async sendToOwner(payload: MemberOpPayload) {
    const owner = this.state?.owner;
    const peerId = [...this.peers.entries()].find(([, info]) => info.memberId === owner)?.[0];
    if (!peerId) return;
    await this.transport?.send('member-op', await seal(this.identity, 'wt-member-op', payload), peerId);
  }

  private async onMemberOp(data: unknown, peerId: string) {
    if (!this.isOwner) return;
    const parsed = memberOpSchema.safeParse(data);
    if (!parsed.success) return;
    const payload = await openSigned('wt-member-op', parsed.data);
    const by = parsed.data.by;
    if (!payload || payload.room !== this.roomId || this.peers.get(peerId)?.memberId !== by) return;
    if (payload.op === 'leave') this.applyAsOwner({ type: 'leave', id: by });
    else this.applyAsOwner({ type: 'rename', id: by, name: payload.name, avatar: payload.avatar });
  }

  // ── leaving ─────────────────────────────────────────────────────────────

  async leave(options: { silent?: boolean; keepStatus?: boolean } = {}) {
    this.generation += 1;
    clearTimeout(this.ownerTimer);
    if (!options.silent && this.inRoom && this.state) {
      if (this.isOwner) this.applyAsOwner({ type: 'leave', id: this.me });
      else await this.sendToOwner({ kind: 'member-op', room: this.roomId, op: 'leave' });
      // Give the goodbye a moment to go out before the connections close.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const transport = this.transport;
    this.transport = null;
    if (transport) for (const events of this.roomEvents) events.transport?.(null);
    await transport?.leave();
    for (const entry of this.held.values()) entry.resolvers.forEach((resolve) => resolve(false));
    this.held.clear();
    this.decided.clear();
    this.tickets.clear();
    this.peers.clear();
    this.myTicket = null;
    if (!options.keepStatus) {
      this.state = null;
      this.keys = {};
      this.envelope = null;
      this.code = null;
      this.storage?.save(null);
      this.status = { kind: 'idle' };
    }
    this.emit();
  }

  private persist() {
    if (!this.code) return;
    this.storage?.save({ code: this.code, envelope: this.inRoom ? this.envelope : null });
  }
}

export { HANDSHAKE_TIMEOUT_MS, OWNER_GRACE_MS, RoomSession };
export type { JoinRequest, RoomEvents, RoomSnapshot, RoomStatus, StoredRoom };
