import type { AppTutorial } from '../kit';

/** Data only: the owner's controls — join requests, who may share, approvers. */
const ownerControls: AppTutorial = {
  format: 1,
  id: 'owner-controls',
  revision: 1,
  title: 'Approve people & who may share',
  summary: "Let people in, and decide who can share — your room's rules.",
  estimatedMinutes: 2,
  requires: ['rooms'],
  steps: [
    { id: 'need-room', type: 'branch', if: { pred: 'room.in' }, then: 'panel', else: 'no-room' },
    {
      id: 'no-room',
      type: 'end',
      outcome: 'aborted',
      lines: [
        { say: "These controls belong to a room's owner.", mood: 'concerned' },
        { say: 'Create a room first — *Create a room and invite* shows how.' },
      ],
    },
    {
      id: 'panel',
      type: 'point',
      target: { name: 'header.room' },
      skipIf: { pred: 'room.panelOpen' },
      lines: [{ say: 'Open the room panel with the **◎ Room** button.', mood: 'pointing' }],
      advance: [{ when: { pred: 'room.panelOpen' }, goto: 'next' }],
      assist: { name: 'openRoomPanel', label: 'Open it for me' },
    },
    { id: 'owner-check', type: 'branch', if: { pred: 'room.isOwner' }, then: 'requests', else: 'not-owner' },
    {
      id: 'not-owner',
      type: 'end',
      outcome: 'aborted',
      lines: [
        { say: "Only the room's owner (👑) has these controls.", mood: 'concerned' },
        { say: 'In a room you create, you will.' },
      ],
    },
    { id: 'requests', type: 'branch', if: { pred: 'room.hasRequests' }, then: 'let-in', else: 'invite' },
    {
      id: 'let-in',
      type: 'point',
      target: { name: 'room.section', args: { title: 'Wants to join' } },
      allow: [{ name: 'header.room' }],
      lines: [
        { say: 'Someone is waiting to get in!', mood: 'surprised' },
        { say: '**Let in** admits them; **Decline** says no.' },
      ],
      advance: [{ when: { not: { pred: 'room.hasRequests' } }, goto: 'people' }],
      assist: { name: 'openRoomPanel', label: 'Open the room panel' },
      next: true,
    },
    {
      id: 'invite',
      type: 'point',
      target: { name: 'room.section', args: { title: 'Invite' } },
      allow: [{ name: 'header.room' }],
      lines: [
        { say: 'When someone uses your code or link, they show up under **Wants to join**.', mood: 'pointing' },
        { say: 'A 🔔 lands on the Room button too, wherever you are in the app.' },
      ],
      advance: [{ when: { pred: 'room.hasRequests' }, goto: 'let-in' }],
      assist: { name: 'openRoomPanel', label: 'Open the room panel' },
      next: true,
    },
    {
      id: 'people',
      type: 'point',
      target: { name: 'room.section', args: { title: 'People' } },
      allow: [{ name: 'header.room' }],
      lines: [
        { say: 'Everyone who joins gets these, under their name:', mood: 'pointing' },
        { say: '**Share** — Default, Allow or Deny. **Can let people in** makes them an approver 🛡. **Make owner** hands the room over.' },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'header.room' } }, goto: 'next' }],
      assist: { name: 'openRoomPanel', label: 'Open the room panel' },
      next: true,
    },
    {
      id: 'who-shares',
      type: 'point',
      target: { name: 'room.section', args: { title: 'Who can share a tab' } },
      allow: [{ name: 'header.room' }],
      lines: [
        { say: 'The rule for everyone: **Everyone**, or **Only people I allow**.', mood: 'pointing' },
        { say: "A person's own Allow / Deny wins over it. You can always share." },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'header.room' } }, goto: 'next' }],
      assist: { name: 'openRoomPanel', label: 'Open the room panel' },
      next: true,
    },
    {
      id: 'done',
      type: 'end',
      lines: [{ say: 'Your room, your rules. 👑', mood: 'celebrate' }],
    },
  ],
};

export { ownerControls };
