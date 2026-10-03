import type { AppTutorial } from '../kit';

/** Data only: the tour of the header — works on any page, needs nothing. */
const welcomeTour: AppTutorial = {
  format: 1,
  id: 'welcome-tour',
  revision: 1,
  title: 'What is watch-together?',
  summary: 'A quick look around: open a video, the library, rooms, and where help lives.',
  estimatedMinutes: 1,
  steps: [
    {
      id: 'hello',
      type: 'say',
      lines: [
        { say: "Hi, I'm **Pop** 🍿 — let me show you around.", mood: 'excited' },
        { say: 'watch-together lets friends watch the same video *together*, each on their own device.' },
        { say: 'Videos play from your own device; a room connects you straight to your friends.' },
      ],
    },
    {
      id: 'open',
      type: 'point',
      target: { name: 'header.open' },
      lines: [{ say: '**🎞 Open** plays any video file on this device — phones too.', mood: 'pointing' }],
      advance: [{ on: { event: 'clicked', args: { target: 'header.open' } }, goto: 'next' }],
      next: true,
    },
    {
      id: 'library',
      type: 'point',
      target: { name: 'header.library' },
      lines: [
        { say: '**☰ Library** lists the videos of a folder you link — optional, and it needs Chrome or Edge on a computer.', mood: 'pointing' },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'header.library' } }, goto: 'next' }],
      next: true,
    },
    {
      id: 'room',
      type: 'point',
      target: { name: 'header.room' },
      lines: [
        { say: "**◎ Room** shows who's here once you're in a room. Rooms start on the Welcome page — one click.", mood: 'pointing' },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'header.room' } }, goto: 'next' }],
      next: true,
    },
    {
      id: 'welcome',
      type: 'point',
      target: { name: 'header.welcome' },
      lines: [{ say: '**🏠 Welcome** brings you back to the start page — rooms and recent videos.', mood: 'pointing' }],
      advance: [{ on: { event: 'clicked', args: { target: 'header.welcome' } }, goto: 'next' }],
      next: true,
    },
    {
      id: 'tutorials',
      type: 'point',
      target: { name: 'header.tutorials' },
      lines: [
        { say: "And that's where I live. **❔ Tutorials** lists the ones for the page you're on first.", mood: 'happy' },
        { say: 'Nothing starts by itself — I only come when you call.' },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'header.tutorials' } }, goto: 'next' }],
      next: true,
    },
    {
      id: 'done',
      type: 'end',
      lines: [
        { say: "That's the tour! 🎉", mood: 'celebrate' },
        { say: 'Next, try *Open or link a video* or *Create a room and invite*.' },
      ],
    },
  ],
};

export { welcomeTour };
