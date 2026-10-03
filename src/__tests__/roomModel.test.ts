import { describe, expect, it } from 'vitest';
import {
  canApprove,
  canShare,
  createRoom,
  isNewer,
  roomReducer,
  RoomRuleError,
  shareRuleOf,
  successorOf,
} from '../room/roomModel';
import type { RoomAction, RoomState } from '../room/roomModel';

const run = (state: RoomState, ...actions: RoomAction[]) => actions.reduce(roomReducer, state);

/** Deepak creates; Asha (t=200) and Ravi (t=300) are admitted. */
function room() {
  return run(
    createRoom('lunar-otter-4821', { id: 'deepak', name: 'Deepak' }, 100),
    { type: 'request', id: 'asha', name: 'Asha', at: 150 },
    { type: 'admit', by: 'deepak', id: 'asha', at: 200 },
    { type: 'request', id: 'ravi', name: 'Ravi', at: 250 },
    { type: 'admit', by: 'deepak', id: 'ravi', at: 300 },
  );
}

describe('joining (Q6: only the owner approves by default)', () => {
  it('a request waits; the owner admits it', () => {
    let state = createRoom('c', { id: 'deepak', name: 'Deepak' }, 0);
    state = roomReducer(state, { type: 'request', id: 'ravi', name: 'Ravi', at: 5 });
    expect(state.pending.ravi).toEqual({ id: 'ravi', name: 'Ravi', requestedAt: 5 });
    state = roomReducer(state, { type: 'admit', by: 'deepak', id: 'ravi', at: 9 });
    expect(state.members.ravi).toEqual({ id: 'ravi', name: 'Ravi', admittedAt: 9 });
    expect(state.pending).toEqual({});
  });

  it('a member cannot approve until the owner makes them an approver', () => {
    let state = run(room(), { type: 'request', id: 'meera', name: 'Meera', at: 400 });
    expect(canApprove(state, 'asha')).toBe(false);
    expect(() => roomReducer(state, { type: 'admit', by: 'asha', id: 'meera', at: 401 })).toThrow(RoomRuleError);
    state = roomReducer(state, { type: 'setApprover', by: 'deepak', id: 'asha', approver: true });
    expect(canApprove(state, 'asha')).toBe(true);
    state = roomReducer(state, { type: 'admit', by: 'asha', id: 'meera', at: 402 });
    expect(state.members.meera).toBeDefined();
  });

  it('only the owner can appoint approvers', () => {
    expect(() =>
      roomReducer(room(), { type: 'setApprover', by: 'asha', id: 'ravi', approver: true }),
    ).toThrow('Only the room owner');
  });

  it('a kicked member is banned: their next request is refused without asking', () => {
    const state = run(room(), { type: 'kick', by: 'deepak', id: 'ravi' });
    expect(state.members.ravi).toBeUndefined();
    expect(() => roomReducer(state, { type: 'request', id: 'ravi', name: 'Ravi', at: 1 })).toThrow('removed');
  });
});

describe('sharing (Q5: global default + per-person allow / deny / none)', () => {
  it('by default everyone may share', () => {
    const state = room();
    expect(state.shareDefault).toBe('everyone');
    expect(['deepak', 'asha', 'ravi'].map((id) => canShare(state, id))).toEqual([true, true, true]);
  });

  it('a per-person rule beats the global default, both ways', () => {
    let state = run(
      room(),
      { type: 'setShareRule', by: 'deepak', id: 'ravi', rule: 'deny' },
      { type: 'setShareDefault', by: 'deepak', value: 'nobody' },
      { type: 'setShareRule', by: 'deepak', id: 'asha', rule: 'allow' },
    );
    expect(canShare(state, 'asha')).toBe(true); // allow beats "nobody"
    expect(canShare(state, 'ravi')).toBe(false); // deny
    state = roomReducer(state, { type: 'setShareDefault', by: 'deepak', value: 'everyone' });
    expect(canShare(state, 'ravi')).toBe(false); // deny beats "everyone"
  });

  it('"none" (inherit) removes the rule and follows the global setting again', () => {
    let state = run(room(), { type: 'setShareRule', by: 'deepak', id: 'ravi', rule: 'deny' });
    expect(shareRuleOf(state, 'ravi')).toBe('deny');
    state = roomReducer(state, { type: 'setShareRule', by: 'deepak', id: 'ravi', rule: 'inherit' });
    expect(shareRuleOf(state, 'ravi')).toBe('inherit');
    expect(state.shareRules).toEqual({});
    expect(canShare(state, 'ravi')).toBe(true);
  });

  it('the owner can always share; only the owner sets rules', () => {
    const state = run(room(), { type: 'setShareDefault', by: 'deepak', value: 'nobody' });
    expect(canShare(state, 'deepak')).toBe(true);
    expect(() => roomReducer(state, { type: 'setShareDefault', by: 'asha', value: 'everyone' })).toThrow();
    expect(() => roomReducer(state, { type: 'setShareRule', by: 'ravi', id: 'ravi', rule: 'allow' })).toThrow();
  });

  it('a non-member can never share', () => {
    expect(canShare(room(), 'stranger')).toBe(false);
  });
});

describe('ownership', () => {
  it('the successor is an approver first, else the earliest admitted', () => {
    const state = room();
    expect(successorOf(state)).toBe('asha');
    expect(successorOf(roomReducer(state, { type: 'setApprover', by: 'deepak', id: 'ravi', approver: true }))).toBe('ravi');
    expect(successorOf(state, (id) => id !== 'asha')).toBe('ravi'); // Asha offline
  });

  it('the owner leaving hands the room on with a new epoch', () => {
    const state = run(room(), { type: 'setShareRule', by: 'deepak', id: 'ravi', rule: 'deny' });
    const after = roomReducer(state, { type: 'leave', id: 'deepak' });
    expect(after.owner).toBe('asha');
    expect(after.epoch).toBe(state.epoch + 1);
    expect(after.members.deepak).toBeUndefined();
    expect(after.shareRules).toEqual({ ravi: 'deny' }); // rules survive the handoff
  });

  it('only the successor can claim a vanished owner, and only once', () => {
    const state = room();
    expect(() => roomReducer(state, { type: 'claimOwnership', by: 'ravi', absentOwner: 'deepak' })).toThrow('next in line');
    const claimed = roomReducer(state, { type: 'claimOwnership', by: 'asha', absentOwner: 'deepak' });
    expect(claimed.owner).toBe('asha');
    // A dropped connection is not leaving: the old owner is still a member.
    expect(claimed.members.deepak).toBeDefined();
    // With Asha offline, Ravi is next in line.
    expect(roomReducer(state, { type: 'claimOwnership', by: 'ravi', absentOwner: 'deepak', present: (id) => id !== 'asha' }).owner).toBe('ravi');
    // A late duplicate claim against the OLD owner changes nothing.
    expect(roomReducer(claimed, { type: 'claimOwnership', by: 'ravi', absentOwner: 'deepak' })).toBe(claimed);
  });

  it('a stale owner coming back cannot overwrite the room (epoch wins)', () => {
    const before = room();
    const staleOwnersEdit = roomReducer(before, { type: 'setShareDefault', by: 'deepak', value: 'nobody' });
    const handedOn = roomReducer(before, { type: 'claimOwnership', by: 'asha', absentOwner: 'deepak' });
    expect(staleOwnersEdit.version).toBeGreaterThan(handedOn.version);
    expect(isNewer(staleOwnersEdit, handedOn)).toBe(false);
    expect(isNewer(handedOn, staleOwnersEdit)).toBe(true);
  });

  it('explicit transfer', () => {
    const state = roomReducer(room(), { type: 'transferOwnership', by: 'deepak', to: 'ravi' });
    expect(state.owner).toBe('ravi');
    expect(canShare(state, 'deepak')).toBe(true); // still a member under the default
  });
});
