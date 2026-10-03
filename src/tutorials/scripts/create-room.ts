import type { AppTutorial } from '../kit';

/** Data only: create a room, invite people, let them in. */
const createRoom: AppTutorial = {
  format: 1,
  id: 'create-room',
  revision: 2,
  title: 'Create a room and invite',
  summary: 'Start a room, send the link, and decide who gets in.',
  estimatedMinutes: 2,
  requires: ['rooms'],
  steps: [
    { id: 'already', type: 'branch', if: { pred: 'room.in' }, then: 'invite', else: 'go-welcome' },
    {
      id: 'go-welcome',
      type: 'point',
      target: { name: 'header.welcome' },
      skipIf: { pred: 'welcome.ticketShown' },
      lines: [{ say: 'Rooms start on the **🏠 Welcome** page.', mood: 'pointing' }],
      advance: [
        { when: { pred: 'room.in' }, goto: 'invite' },
        { when: { pred: 'welcome.ticketShown' }, goto: 'next' },
      ],
      assist: { name: 'openWelcome', label: 'Go to Welcome' },
    },
    {
      id: 'name',
      type: 'point',
      target: { name: 'welcome.name' },
      allow: [{ name: 'welcome.createRoom' }, { name: 'welcome.ticket' }],
      lines: [
        { say: 'This is your ticket. Your **name** and **face** are already filled in — tap either to change them.', mood: 'pointing' },
        { say: 'The room name is picked for you too (🎲 for another one).' },
      ],
      advance: [{ when: { pred: 'room.in' }, goto: 'invite' }],
      next: true,
    },
    {
      id: 'start',
      type: 'point',
      target: { name: 'welcome.createRoom' },
      allow: [{ name: 'welcome.ticket' }],
      lines: [{ say: 'Now one click: **Start a room**. No video needed yet.', mood: 'pointing' }],
      advance: [
        { when: { pred: 'room.in' }, goto: 'invite' },
        { when: { not: { pred: 'welcome.ticketShown' } }, goto: 'go-welcome' },
      ],
    },
    {
      id: 'invite',
      type: 'point',
      target: { name: 'welcome.shareInvite' },
      allow: [{ name: 'welcome.inRoom' }, { name: 'header.room' }],
      checkpoint: true,
      lines: [
        { say: 'Your room is ready! 🎉', mood: 'excited' },
        { say: '**Share invite** sends the link with your phone’s share sheet — or copies it. WhatsApp, Telegram, email and a QR code are right below.' },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'welcome.shareInvite' } }, goto: 'next' }],
      assist: { name: 'openWelcome', label: 'Go to Welcome' },
      next: true,
    },
    {
      id: 'requests',
      type: 'point',
      target: { name: 'room.section', args: { title: 'People' } },
      allow: [{ name: 'header.room' }],
      lines: [
        { say: 'When a friend opens the link, they **ask to join**.', mood: 'pointing' },
        { say: 'A 🔔 appears on the Room button and here under **Wants to join** — you press **Let in**.' },
      ],
      advance: [{ when: { pred: 'room.hasRequests' }, goto: 'let-in' }],
      assist: { name: 'openRoomPanel', label: 'Open the room panel' },
      next: true,
    },
    {
      id: 'let-in',
      type: 'point',
      target: { name: 'room.letIn' },
      allow: [{ name: 'header.room' }],
      skipIf: { not: { pred: 'room.hasRequests' } },
      lines: [{ say: 'Someone is knocking! Press **Let in** — or **Decline**.', mood: 'surprised' }],
      advance: [{ when: { not: { pred: 'room.hasRequests' } }, goto: 'done' }],
      assist: { name: 'openRoomPanel', label: 'Open the room panel' },
    },
    {
      id: 'done',
      type: 'end',
      lines: [
        { say: 'You run the room now. 🎉', mood: 'celebrate' },
        { say: 'Open a video and press **📡 Share** to watch it together.' },
      ],
    },
  ],
};

export { createRoom };
