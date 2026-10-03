import type { AppTutorial } from '../kit';

/** Data only: watch someone's share — stream or my copy, ask for control, save a copy. */
const watchShare: AppTutorial = {
  format: 1,
  id: 'watch-share',
  revision: 1,
  title: 'Watch a share: stream or your copy',
  summary: 'Stream or play your own copy, ask for control, save a copy.',
  estimatedMinutes: 2,
  requires: ['rooms', 'sharing'],
  steps: [
    { id: 'start', type: 'branch', if: { pred: 'share.open' }, then: 'source', else: 'need-room' },
    { id: 'need-room', type: 'branch', if: { pred: 'room.in' }, then: 'find', else: 'no-room' },
    {
      id: 'no-room',
      type: 'end',
      outcome: 'aborted',
      lines: [
        { say: 'Shares live in rooms.', mood: 'concerned' },
        { say: "Join a friend's room first — *Join a room* shows how." },
      ],
    },
    {
      id: 'find',
      type: 'point',
      target: { name: 'room.section', args: { title: 'Shared in the room' } },
      allow: [{ name: 'header.room' }, { name: 'tabs.share' }],
      lines: [
        { say: 'When someone shares, it is listed here — press **Watch**.', mood: 'pointing' },
        { say: 'A toast with **Watch** pops up too.' },
      ],
      advance: [{ when: { pred: 'share.open' }, goto: 'source' }],
      timeoutMs: 20000,
      hint: [{ say: 'Nothing listed yet? Ask a friend to press **📡 Share** in their player.', mood: 'thinking' }],
      assist: { name: 'openRoomPanel', label: 'Open the room panel' },
    },
    {
      id: 'source',
      type: 'point',
      target: { name: 'share.source' },
      checkpoint: true,
      lines: [
        { say: "**Stream** plays the sharer's video live — nothing needed on your side.", mood: 'pointing' },
        { say: '**My copy** plays your own copy of the same file in full quality, kept in sync.' },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'share.myCopy' } }, goto: 'next' }],
      next: true,
    },
    {
      id: 'control',
      type: 'point',
      target: { name: 'share.askControl' },
      skipIf: { not: { pred: 'shown', args: { target: 'share.askControl' } } },
      lines: [
        { say: '**✋ Ask for control** — once the sharer allows it, you can pause and seek for everyone.', mood: 'pointing' },
      ],
      advance: [{ when: { pred: 'share.controlAsked' }, goto: 'next' }],
      next: true,
    },
    {
      id: 'save',
      type: 'point',
      target: { name: 'share.saveCopy' },
      skipIf: { not: { pred: 'shown', args: { target: 'share.saveCopy' } } },
      lines: [
        { say: '**Save a copy** downloads the video from the sharer — next time, choose **My copy**.', mood: 'pointing' },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'share.saveCopy' } }, goto: 'next' }],
      next: true,
    },
    {
      id: 'volume',
      type: 'point',
      target: { name: 'player.volume' },
      skipIf: { not: { pred: 'shown', args: { target: 'player.volume' } } },
      lines: [{ say: 'And your volume is still **yours only**.', mood: 'happy' }],
      advance: [{ on: { event: 'video.volume' }, goto: 'next' }],
      next: true,
    },
    {
      id: 'done',
      type: 'end',
      lines: [{ say: 'Grab some popcorn! 🍿', mood: 'celebrate' }],
    },
  ],
};

export { watchShare };
