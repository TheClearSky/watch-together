/**
 * Rooms end to end on the in-memory network (same handshake rules as
 * Trystero: two-sided, held until both sides resolve). Identities are real
 * Ed25519 keys; every message is really signed and verified.
 */
import { describe, expect, it } from 'vitest';
import { canShare } from '../room/roomModel';
import { createEphemeralIdentity } from '../room/identity';
import { RoomSession } from '../room/session';
import type { StoredRoom } from '../room/session';
import { createMemoryNetwork } from '../room/transport';

async function until(check: () => boolean, label: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function memoryStorage() {
  let stored: StoredRoom | null = null;
  return { load: () => stored, save: (room: StoredRoom | null) => void (stored = room ? structuredClone(room) : null) };
}

async function person(network: ReturnType<typeof createMemoryNetwork>, name: string, options: { ownerGraceMs?: number } = {}) {
  const identity = await createEphemeralIdentity();
  const storage = memoryStorage();
  const session = new RoomSession({ identity, join: network.join, name, storage, handshakeTimeoutMs: 2000, ...options });
  return { session, identity, storage, id: identity.memberId };
}

/** Deepak creates; Asha asks and is approved. */
async function roomOfTwo() {
  const network = createMemoryNetwork();
  const deepak = await person(network, 'Deepak');
  const asha = await person(network, 'Asha');
  const code = await deepak.session.create();
  await asha.session.join(code);
  await until(() => deepak.session.getSnapshot().requests.length === 1, 'Deepak sees the request');
  await deepak.session.approve(asha.id);
  await until(() => asha.session.getSnapshot().status.kind === 'in-room', 'Asha is in');
  return { network, deepak, asha, code };
}

describe('rooms', () => {
  it('avatars travel: a chosen code, the request, the member list, and a later change', async () => {
    const network = createMemoryNetwork();
    const deepak = await person(network, 'Deepak');
    const asha = await person(network, 'Asha');
    await deepak.session.rename('Deepak', 4242);
    const code = await deepak.session.create('friday-movie-0001');
    expect(code).toBe('friday-movie-0001');
    await asha.session.rename('Asha', 7);
    await asha.session.join(code);
    await until(() => deepak.session.getSnapshot().requests.length === 1, 'request');
    expect(deepak.session.getSnapshot().requests[0].avatar).toBe(7);
    await deepak.session.approve(asha.id);
    await until(() => asha.session.getSnapshot().status.kind === 'in-room', 'Asha in');
    await until(() => asha.session.getSnapshot().room?.members[asha.id]?.avatar === 7, 'Asha sees her own avatar in the room');
    expect(asha.session.avatarOf(deepak.id)).toBe(4242);
    await asha.session.rename('Asha K', 99);
    await until(() => deepak.session.avatarOf(asha.id) === 99 && deepak.session.nameOf(asha.id) === 'Asha K', 'change replicated');
  });

  it('a new room has you as its owner', async () => {
    const network = createMemoryNetwork();
    const deepak = await person(network, 'Deepak');
    const code = await deepak.session.create();
    const snapshot = deepak.session.getSnapshot();
    expect(code).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
    expect(snapshot.status.kind).toBe('in-room');
    expect(snapshot.room?.owner).toBe(deepak.id);
    expect(snapshot.link?.endsWith(`#/room/${code}`)).toBe(true);
  });

  it('a joiner waits for the owner, then is in, and both see each other online', async () => {
    const { deepak, asha } = await roomOfTwo();
    expect(deepak.session.getSnapshot().room?.members[asha.id]?.name).toBe('Asha');
    await until(() => deepak.session.getSnapshot().online.has(asha.id), 'Deepak sees Asha online');
    await until(() => asha.session.getSnapshot().online.has(deepak.id), 'Asha sees Deepak online');
    expect(asha.session.getSnapshot().room?.owner).toBe(deepak.id);
    expect(deepak.session.getSnapshot().requests).toEqual([]);
  });

  it('a rejected joiner is told so', async () => {
    const network = createMemoryNetwork();
    const deepak = await person(network, 'Deepak');
    const ravi = await person(network, 'Ravi');
    const code = await deepak.session.create();
    await ravi.session.join(code);
    await until(() => deepak.session.getSnapshot().requests.length === 1, 'request shown');
    await deepak.session.reject(ravi.id);
    await until(() => ravi.session.getSnapshot().status.kind === 'rejected', 'Ravi rejected');
    expect(deepak.session.getSnapshot().room?.members[ravi.id]).toBeUndefined();
  });

  it('only approvers see requests; an appointed approver can let people in (Q6)', async () => {
    const { network, deepak, asha, code } = await roomOfTwo();
    deepak.session.setApprover(asha.id, true);
    await until(() => asha.session.getSnapshot().room?.approvers.includes(asha.id) === true, 'Asha is an approver');
    const ravi = await person(network, 'Ravi');
    await ravi.session.join(code);
    await until(() => asha.session.getSnapshot().requests.length === 1, 'Asha sees the request');
    await asha.session.approve(ravi.id);
    await until(() => ravi.session.getSnapshot().status.kind === 'in-room', 'Ravi is in');
    // The owner applied the approver's ticket; everyone ends up connected.
    await until(() => deepak.session.getSnapshot().room?.members[ravi.id] !== undefined, 'owner admitted Ravi');
    await until(() => deepak.session.getSnapshot().requests.length === 0, "owner's copy of the request cleared");
    await until(() => ravi.session.getSnapshot().online.size === 3, 'Ravi sees everyone');
  });

  it("a plain member never sees requests and follows the owner's decision", async () => {
    const { network, deepak, asha, code } = await roomOfTwo();
    const ravi = await person(network, 'Ravi');
    await ravi.session.join(code);
    await until(() => deepak.session.getSnapshot().requests.length === 1, 'owner sees request');
    expect(asha.session.getSnapshot().requests).toEqual([]);
    await deepak.session.approve(ravi.id);
    await until(() => asha.session.getSnapshot().online.has(ravi.id), 'Asha connects to Ravi');
  });

  it('share permissions set by the owner reach every member (Q5)', async () => {
    const { deepak, asha } = await roomOfTwo();
    deepak.session.setShareDefault('nobody');
    await until(() => asha.session.getSnapshot().room?.shareDefault === 'nobody', 'default replicated');
    expect(canShare(asha.session.getSnapshot().room!, asha.id)).toBe(false);
    deepak.session.setShareRule(asha.id, 'allow');
    await until(() => canShare(asha.session.getSnapshot().room!, asha.id), 'per-person allow replicated');
  });

  it('a kicked member is removed, and their next request is refused without asking', async () => {
    const { deepak, asha, code } = await roomOfTwo();
    await deepak.session.kick(asha.id);
    await until(() => asha.session.getSnapshot().status.kind === 'kicked', 'Asha kicked');
    await asha.session.join(code);
    await until(() => asha.session.getSnapshot().status.kind === 'rejected', 'refused');
    expect(deepak.session.getSnapshot().requests).toEqual([]);
  });

  it('a member reloading rejoins without asking again', async () => {
    const { network, deepak, asha } = await roomOfTwo();
    await until(() => asha.storage.load()?.envelope !== null, 'Asha stored the room');
    const stored = asha.storage.load();
    await asha.session.leave({ silent: true });
    // A "reload": a new session with the same identity and stored room.
    const reloaded = new RoomSession({
      identity: asha.identity,
      join: network.join,
      name: 'Asha',
      storage: { load: () => stored, save: () => {} },
      handshakeTimeoutMs: 2000,
    });
    expect(await reloaded.resume()).toBe(true);
    await until(() => reloaded.getSnapshot().online.has(deepak.id), 'reconnected');
    expect(deepak.session.getSnapshot().requests).toEqual([]);
  });

  it('the owner leaving hands the room to the next person', async () => {
    const { deepak, asha } = await roomOfTwo();
    await deepak.session.leave();
    await until(() => asha.session.getSnapshot().room?.owner === asha.id, 'Asha owns the room');
    expect(asha.session.getSnapshot().notice).toMatch(/now the room owner/);
    expect(asha.session.getSnapshot().room?.members[deepak.id]).toBeUndefined();
  });

  it('an owner who vanishes is replaced after the grace period, and can come back', async () => {
    const network = createMemoryNetwork();
    const deepak = await person(network, 'Deepak');
    const asha = await person(network, 'Asha', { ownerGraceMs: 60 });
    const code = await deepak.session.create();
    await asha.session.join(code);
    await until(() => deepak.session.getSnapshot().requests.length === 1, 'request');
    await deepak.session.approve(asha.id);
    await until(() => asha.session.getSnapshot().status.kind === 'in-room', 'Asha in');
    await until(() => deepak.storage.load()?.envelope !== null, 'Deepak stored the room');
    const stored = deepak.storage.load();
    await deepak.session.leave({ silent: true }); // a crash: no goodbye
    await until(() => asha.session.getSnapshot().room?.owner === asha.id, 'Asha claimed ownership');
    expect(asha.session.getSnapshot().room?.members[deepak.id]).toBeDefined(); // still a member
    const back = new RoomSession({
      identity: deepak.identity,
      join: network.join,
      name: 'Deepak',
      storage: { load: () => stored, save: () => {} },
      handshakeTimeoutMs: 2000,
    });
    await back.resume();
    await until(() => back.getSnapshot().room?.owner === asha.id, 'Deepak adopts the newer room');
  });

  it("a state signed by someone who is not the owner is ignored", async () => {
    const { deepak, asha } = await roomOfTwo();
    // Asha tries to make herself owner by publishing her own signed state.
    const forged = asha.session as unknown as { state: { owner: string; version: number }; publish(): Promise<void> };
    forged.state = { ...forged.state, owner: asha.id, version: forged.state.version + 5 };
    await forged.publish();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deepak.session.getSnapshot().room?.owner).toBe(deepak.id);
  });
});
