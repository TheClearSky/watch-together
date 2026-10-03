/**
 * The slice of Trystero the room uses, as an interface — so the session can
 * run on real WebRTC (`trysteroTransport`) or on an in-memory network in
 * unit tests (`createMemoryNetwork`), which reproduces the semantics that
 * matter: a held, two-sided handshake before a peer becomes active
 * (spike S1), denial on either side, per-peer targeting, and leave/close.
 */
import type { JsonValue, MessageAction } from '@trystero-p2p/core';

type HandshakeSend = (data: JsonValue) => Promise<void>;
type HandshakeReceive = () => Promise<{ data: unknown }>;

type TransportCallbacks = {
  /** Resolve to admit the peer, throw to deny it. Runs on BOTH sides. */
  onPeerHandshake(peerId: string, send: HandshakeSend, receive: HandshakeReceive, isInitiator: boolean): Promise<void>;
  onJoinError?(details: { peerId: string; error: string }): void;
};

interface TransportRoom {
  readonly selfId: string;
  /** Send a JSON message on `action` to everyone, or only to `target`. */
  send(action: string, data: JsonValue, target?: string | string[]): Promise<void>;
  on(action: string, handler: (data: unknown, peerId: string) => void): void;
  onPeerJoin(handler: (peerId: string) => void): void;
  onPeerLeave(handler: (peerId: string) => void): void;
  /** Active (admitted) peers. */
  peers(): string[];
  /** Drop a peer (a kick). */
  closePeer(peerId: string): void;
  leave(): Promise<void>;
  /** The underlying Trystero room, for media (P3). `null` in memory tests. */
  readonly media: unknown;
}

type JoinTransport = (
  roomId: string,
  password: string,
  callbacks: TransportCallbacks,
  options: { handshakeTimeoutMs: number },
) => Promise<TransportRoom>;

// ── Trystero (real WebRTC over Nostr discovery) ────────────────────────────

const APP_ID = 'watch-together-v1';

const trysteroTransport: JoinTransport = async (roomId, password, callbacks, options) => {
  const { joinRoom, selfId } = await import('trystero');
  const handlers = new Map<string, (data: unknown, peerId: string) => void>();
  const joins: ((peerId: string) => void)[] = [];
  const leaves: ((peerId: string) => void)[] = [];
  // More relays than Trystero's default 5: public Nostr relays come and go
  // (two of the default picks for this app id were down on 2026-10-03), and
  // discovery only needs one shared relay to work.
  const room = joinRoom({ appId: APP_ID, password, relayConfig: { redundancy: 8 } }, roomId, {
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    onPeerHandshake: (peerId, send, receive, isInitiator) =>
      callbacks.onPeerHandshake(peerId, (data) => send(data), () => receive(), isInitiator),
    onJoinError: (details) => callbacks.onJoinError?.({ peerId: details.peerId, error: String(details.error) }),
  });
  const actions = new Map<string, MessageAction<JsonValue>>();
  const action = (name: string): MessageAction<JsonValue> => {
    let existing = actions.get(name);
    if (!existing) {
      existing = room.makeAction<JsonValue>(name) as MessageAction<JsonValue>;
      existing.onMessage = (data, context) => handlers.get(name)?.(data, context.peerId);
      actions.set(name, existing);
    }
    return existing;
  };
  room.onPeerJoin = (peerId) => joins.forEach((handler) => handler(peerId));
  room.onPeerLeave = (peerId) => leaves.forEach((handler) => handler(peerId));
  return {
    selfId,
    send: (name, data, target) => action(name).send(data, target === undefined ? undefined : { target }),
    on: (name, handler) => {
      handlers.set(name, handler);
      action(name);
    },
    onPeerJoin: (handler) => joins.push(handler),
    onPeerLeave: (handler) => leaves.push(handler),
    peers: () => Object.keys(room.getPeers()),
    closePeer: (peerId) => room.getPeers()[peerId]?.close(),
    leave: () => room.leave(),
    media: room,
  };
};

// ── In-memory network (unit tests) ─────────────────────────────────────────

type MemoryPeer = {
  id: string;
  roomKey: string;
  callbacks: TransportCallbacks;
  timeoutMs: number;
  handlers: Map<string, (data: unknown, peerId: string) => void>;
  joins: ((peerId: string) => void)[];
  leaves: ((peerId: string) => void)[];
  active: Set<string>;
  left: boolean;
};

/** A queue of handshake messages from one side to the other. */
function channel() {
  const queue: unknown[] = [];
  const waiting: ((value: { data: unknown }) => void)[] = [];
  return {
    push(data: unknown) {
      const next = waiting.shift();
      if (next) next({ data: structuredClone(data) });
      else queue.push(structuredClone(data));
    },
    pull(): Promise<{ data: unknown }> {
      if (queue.length > 0) return Promise.resolve({ data: queue.shift() });
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handshake timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createMemoryNetwork() {
  const peers: MemoryPeer[] = [];
  let counter = 0;

  const connect = async (a: MemoryPeer, b: MemoryPeer) => {
    const aToB = channel();
    const bToA = channel();
    const run = (self: MemoryPeer, other: MemoryPeer, out: ReturnType<typeof channel>, inbox: ReturnType<typeof channel>, initiator: boolean) =>
      withTimeout(
        self.callbacks.onPeerHandshake(
          other.id,
          async (data) => out.push(data),
          () => inbox.pull(),
          initiator,
        ),
        self.timeoutMs,
      );
    const results = await Promise.allSettled([run(a, b, aToB, bToA, true), run(b, a, bToA, aToB, false)]);
    if (a.left || b.left) return;
    if (results.every((result) => result.status === 'fulfilled')) {
      a.active.add(b.id);
      b.active.add(a.id);
      a.joins.forEach((handler) => handler(b.id));
      b.joins.forEach((handler) => handler(a.id));
    } else {
      const error = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      a.callbacks.onJoinError?.({ peerId: b.id, error: String(error.reason) });
      b.callbacks.onJoinError?.({ peerId: a.id, error: String(error.reason) });
    }
  };

  const disconnect = (a: MemoryPeer, b: MemoryPeer) => {
    if (!a.active.delete(b.id)) return;
    b.active.delete(a.id);
    a.leaves.forEach((handler) => handler(b.id));
    b.leaves.forEach((handler) => handler(a.id));
  };

  const join: JoinTransport = async (roomId, password, callbacks, options) => {
    const self: MemoryPeer = {
      id: `peer${++counter}`,
      roomKey: `${roomId}|${password}`,
      callbacks,
      timeoutMs: options.handshakeTimeoutMs,
      handlers: new Map(),
      joins: [],
      leaves: [],
      active: new Set(),
      left: false,
    };
    const others = peers.filter((peer) => peer.roomKey === self.roomKey && !peer.left);
    peers.push(self);
    // Connect asynchronously, like real discovery.
    queueMicrotask(() => others.forEach((other) => void connect(other, self)));
    const find = (id: string) => peers.find((peer) => peer.id === id);
    return {
      selfId: self.id,
      async send(action, data, target) {
        const targets = target === undefined ? [...self.active] : ([] as string[]).concat(target);
        for (const id of targets) {
          const other = find(id);
          if (!other || !self.active.has(id) || other.left) continue;
          const payload = structuredClone(data);
          queueMicrotask(() => other.handlers.get(action)?.(payload, self.id));
        }
      },
      on: (action, handler) => self.handlers.set(action, handler),
      onPeerJoin: (handler) => self.joins.push(handler),
      onPeerLeave: (handler) => self.leaves.push(handler),
      peers: () => [...self.active],
      closePeer(peerId) {
        const other = find(peerId);
        if (other) disconnect(self, other);
      },
      async leave() {
        self.left = true;
        for (const id of [...self.active]) {
          const other = find(id);
          if (other) disconnect(self, other);
        }
      },
      media: null,
    };
  };

  return { join };
}

export { createMemoryNetwork, trysteroTransport };
export type { HandshakeReceive, HandshakeSend, JoinTransport, TransportCallbacks, TransportRoom };
