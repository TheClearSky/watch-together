import type { AppTutorial } from '../kit';

/** Data only: share the video tab with the room. */
const shareTab: AppTutorial = {
  format: 1,
  id: 'share-tab',
  revision: 1,
  title: 'Share a tab with the room',
  summary: 'Everyone in the room watches your video, in sync.',
  estimatedMinutes: 1,
  requires: ['rooms', 'sharing'],
  steps: [
    {
      id: 'need-room',
      type: 'point',
      target: { name: 'header.room' },
      allow: [{ name: 'welcome.createRoom' }, { name: 'welcome.joinRoom' }],
      skipIf: { pred: 'room.in' },
      lines: [
        { say: "Sharing happens inside a room. Start one with **◎ Room** — or join a friend's.", mood: 'pointing' },
      ],
      advance: [{ when: { pred: 'room.in' }, goto: 'next' }],
      timeoutMs: 30000,
      hint: [{ say: 'The *Create a room and invite* tutorial walks you through it.', mood: 'thinking' }],
    },
    {
      id: 'need-video',
      type: 'point',
      target: { name: 'header.open' },
      allow: [{ name: 'welcome.openFile' }, { name: 'library.tree' }, { name: 'tabs.strip' }],
      skipIf: { pred: 'video.open' },
      lines: [{ say: 'Now open the video you want to watch together.', mood: 'pointing' }],
      advance: [{ when: { pred: 'video.open' }, goto: 'next' }],
    },
    {
      id: 'share',
      type: 'point',
      target: { name: 'player.share' },
      skipIf: { pred: 'player.sharing' },
      lines: [
        { say: 'Press **📡 Share**.', mood: 'pointing' },
        { say: 'Everyone in the room gets a toast and finds it under *Shared in the room*.' },
      ],
      advance: [{ when: { pred: 'player.sharing' }, goto: 'next' }],
      timeoutMs: 15000,
      hint: [
        { say: "Nothing happened? The room's owner decides who may share — ask them, or check *Who can share a tab* in your own room.", mood: 'concerned' },
      ],
      assist: { name: 'showControls', label: 'Show the controls' },
    },
    {
      id: 'sharing',
      type: 'point',
      target: { name: 'player.sharing' },
      lines: [
        { say: "You're sharing! 📡 The number shows how many people stream it.", mood: 'excited' },
        { say: '**■** stops sharing; closing the tab stops it too.' },
      ],
      advance: [{ when: { not: { pred: 'player.sharing' } }, goto: 'next' }],
      assist: { name: 'showControls', label: 'Show the controls' },
      next: true,
    },
    {
      id: 'viewers',
      type: 'say',
      lines: [
        { say: 'Friends choose how to watch: **stream** your video live, or play **their own copy**, kept in sync.', mood: 'happy' },
        { say: 'You can switch tabs — a shared tab keeps playing for everyone.' },
      ],
    },
    {
      id: 'done',
      type: 'end',
      lines: [{ say: 'Enjoy the show! 🍿', mood: 'celebrate' }],
    },
  ],
};

export { shareTab };
