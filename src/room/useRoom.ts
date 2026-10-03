/**
 * The app's one room session: identity loaded once, the current room kept
 * across reloads (per browser tab, sessionStorage), the display name kept
 * across visits (localStorage).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { randomAvatar } from '../social/Avatar';
import { friendlyName } from '../social/names';
import { isString, readPreference, writePreference } from '../storage';
import { loadIdentity } from './identity';
import { relayServers } from './relaySettings';
import { RoomSession } from './session';
import type { RoomSnapshot, StoredRoom } from './session';
import { trysteroTransport } from './transport';

const ROOM_KEY = 'watch-together.room';

const tabStorage = {
  load(): StoredRoom | null {
    try {
      const raw = sessionStorage.getItem(ROOM_KEY);
      return raw ? (JSON.parse(raw) as StoredRoom) : null;
    } catch {
      return null;
    }
  },
  save(room: StoredRoom | null) {
    try {
      if (room) sessionStorage.setItem(ROOM_KEY, JSON.stringify(room));
      else sessionStorage.removeItem(ROOM_KEY);
    } catch {
      // Not persisted; the room still works for this page.
    }
  },
};

const isAvatar = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65535;

/** My name: remembered; on a first visit a friendly one is picked (and kept). */
function savedName(): string {
  const name = readPreference('displayName', '', isString);
  if (name.trim()) return name;
  const fresh = friendlyName();
  writePreference('displayName', fresh);
  return fresh;
}

function rememberName(name: string) {
  writePreference('displayName', name.trim().slice(0, 40));
}

/** My avatar seed: remembered; a random face on a first visit (and kept). */
function savedAvatar(): number {
  const avatar = readPreference<number | null>('avatar', null, (value): value is number | null => value === null || isAvatar(value));
  if (avatar !== null) return avatar;
  const fresh = randomAvatar();
  writePreference('avatar', fresh);
  return fresh;
}

function rememberAvatar(avatar: number) {
  if (isAvatar(avatar)) writePreference('avatar', avatar);
}

let sessionPromise: Promise<RoomSession> | null = null;

/** The session, created on first use (the identity load is async). */
function getRoomSession(): Promise<RoomSession> {
  sessionPromise ??= loadIdentity().then((identity) => {
    const session = new RoomSession({
      identity,
      join: trysteroTransport,
      name: savedName(),
      avatar: savedAvatar(),
      storage: tabStorage,
      relays: relayServers,
    });
    void session.resume();
    return session;
  });
  return sessionPromise;
}

const EMPTY: RoomSnapshot | null = null;

function useRoom(): { session: RoomSession | null; snapshot: RoomSnapshot | null } {
  const [session, setSession] = useState<RoomSession | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getRoomSession().then((created) => {
      if (!cancelled) setSession(created);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getSnapshot ?? (() => EMPTY),
    () => EMPTY,
  );
  return { session, snapshot };
}

const noopSubscribe = () => () => {};

export { rememberAvatar, rememberName, savedAvatar, savedName, useRoom };
