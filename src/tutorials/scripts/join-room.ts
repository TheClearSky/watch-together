import type { AppTutorial } from '../kit';

/** Data only: join with a code or link, wait to be let in. */
const joinRoom: AppTutorial = {
  format: 1,
  id: 'join-room',
  revision: 2,
  title: 'Join a room',
  summary: 'Use the code or link a friend sent you.',
  estimatedMinutes: 1,
  requires: ['rooms'],
  steps: [
    { id: 'already', type: 'branch', if: { pred: 'room.in' }, then: 'inside', else: 'go-welcome' },
    {
      id: 'go-welcome',
      type: 'point',
      target: { name: 'header.welcome' },
      skipIf: { pred: 'welcome.ticketShown' },
      lines: [{ say: 'Joining starts on the **🏠 Welcome** page.', mood: 'pointing' }],
      advance: [
        { when: { pred: 'room.in' }, goto: 'inside' },
        { when: { pred: 'room.joining' }, goto: 'waiting' },
        { when: { pred: 'welcome.ticketShown' }, goto: 'next' },
      ],
      assist: { name: 'openWelcome', label: 'Go to Welcome' },
    },
    {
      id: 'invited',
      type: 'branch',
      if: { pred: 'shown', args: { target: 'welcome.joinInvite' } },
      then: 'join-invite',
      else: 'code',
    },
    {
      id: 'join-invite',
      type: 'point',
      target: { name: 'welcome.joinInvite' },
      allow: [{ name: 'welcome.name' }, { name: 'welcome.ticket' }],
      lines: [
        { say: 'You opened an invite link — the room is already filled in. 🎟', mood: 'excited' },
        { say: 'Check your name, then one click: **Join the room**.' },
      ],
      advance: [
        { when: { pred: 'room.in' }, goto: 'inside' },
        { when: { pred: 'room.joining' }, goto: 'waiting' },
      ],
    },
    {
      id: 'code',
      type: 'point',
      target: { name: 'welcome.joinRoom' },
      allow: [{ name: 'welcome.joinSubmit' }, { name: 'welcome.name' }, { name: 'welcome.ticket' }],
      lines: [
        { say: 'Paste the **code** (like `lunar-otter-4821`) or the whole **invite link** here.', mood: 'pointing' },
      ],
      advance: [
        { when: { pred: 'room.in' }, goto: 'inside' },
        { when: { pred: 'room.joining' }, goto: 'waiting' },
        { when: { pred: 'welcome.codeValid' }, goto: 'submit' },
        { when: { not: { pred: 'welcome.ticketShown' } }, goto: 'go-welcome' },
      ],
      timeoutMs: 20000,
      hint: [{ say: 'A code looks like `word-word-1234`. A pasted link works too.', mood: 'thinking' }],
    },
    {
      id: 'submit',
      type: 'point',
      target: { name: 'welcome.joinSubmit' },
      allow: [{ name: 'welcome.joinRoom' }, { name: 'welcome.name' }],
      lines: [{ say: 'Looks right! Press **Join**. Your name and face are what the room sees.', mood: 'pointing' }],
      advance: [
        { when: { pred: 'room.in' }, goto: 'inside' },
        { when: { pred: 'room.joining' }, goto: 'waiting' },
        { when: { not: { pred: 'welcome.codeValid' } }, goto: 'code' },
      ],
    },
    {
      id: 'waiting',
      type: 'point',
      target: { name: 'header.room' },
      allow: [{ name: 'room.panel' }],
      lines: [
        { say: 'Asked! ⏳ Someone in the room has to let you in.', mood: 'happy' },
        { say: 'The room panel shows how it is going.' },
      ],
      advance: [{ when: { pred: 'room.in' }, goto: 'inside' }],
      timeoutMs: 30000,
      hint: [{ say: 'Nobody answering? They may be offline, or the code may be mistyped. The room panel can cancel.', mood: 'concerned' }],
      next: true,
    },
    {
      id: 'inside',
      type: 'point',
      target: { name: 'header.room' },
      lines: [
        { say: "You're in! 🎉 The number is how many people are here.", mood: 'celebrate' },
        { say: 'Open the room panel for people, chat, and what is being shared.' },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'header.room' } }, goto: 'next' }],
      next: true,
    },
    {
      id: 'done',
      type: 'end',
      lines: [
        { say: 'When someone shares a video, a toast offers **Watch**.', mood: 'happy' },
        { say: 'Try *Watch a share* next.' },
      ],
    },
  ],
};

export { joinRoom };
