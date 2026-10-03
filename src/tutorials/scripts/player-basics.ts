import type { AppTutorial } from '../kit';

/** Data only: play/pause, YOUR volume, subtitles, settings, fullscreen/rotate. */
const playerBasics: AppTutorial = {
  format: 1,
  id: 'player-basics',
  revision: 1,
  title: 'Player basics',
  summary: 'Your own volume, subtitles, speed and fullscreen.',
  estimatedMinutes: 2,
  requires: ['player'],
  steps: [
    {
      id: 'need-video',
      type: 'point',
      target: { name: 'header.open' },
      allow: [{ name: 'welcome.openFile' }, { name: 'library.tree' }, { name: 'tabs.strip' }],
      skipIf: { pred: 'video.open' },
      lines: [{ say: 'First, open a video: press **🎞 Open** and pick one — or click one in your Library.', mood: 'pointing' }],
      advance: [{ when: { pred: 'video.open' }, goto: 'next' }],
    },
    {
      id: 'controls',
      type: 'point',
      target: { name: 'player.playPause' },
      lines: [
        { say: 'These are the controls. They fade away while the video plays — move the mouse or tap the video to bring them back.', mood: 'pointing' },
        { say: '**▶** plays and pauses (so does [[Space]]).' },
      ],
      advance: [
        { on: { event: 'video.play' }, goto: 'next' },
        { on: { event: 'video.pause' }, goto: 'next' },
      ],
      assist: { name: 'showControls', label: 'Show the controls' },
      next: true,
    },
    {
      id: 'volume',
      type: 'point',
      target: { name: 'player.volume' },
      skipIf: { pred: 'layout.narrow' },
      lines: [
        { say: 'This volume is **yours only** — turning it down never changes anyone else’s sound.', mood: 'pointing' },
      ],
      advance: [{ on: { event: 'video.volume' }, goto: 'next' }],
      assist: { name: 'showControls', label: 'Show the controls' },
      next: true,
    },
    {
      id: 'volume-phone',
      type: 'point',
      target: { name: 'player.settings' },
      allow: [{ name: 'player.settingsPanel' }],
      skipIf: { not: { pred: 'layout.narrow' } },
      lines: [
        { say: 'On a phone, your volume is in **⚙ Settings** — and it is **yours only**: nobody else’s sound changes.', mood: 'pointing' },
      ],
      advance: [{ on: { event: 'video.volume' }, goto: 'next' }],
      assist: { name: 'openSettings', label: 'Open Settings' },
      next: true,
    },
    {
      id: 'subtitles',
      type: 'point',
      target: { name: 'player.subtitles' },
      skipIf: { not: { pred: 'player.hasSubtitles' } },
      lines: [
        { say: '**CC** turns subtitles on and off. Subtitles inside the file, and `.srt` files next to it, are found by themselves.', mood: 'pointing' },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'player.subtitles' } }, goto: 'next' }],
      assist: { name: 'showControls', label: 'Show the controls' },
      next: true,
    },
    {
      id: 'settings',
      type: 'point',
      target: { name: 'player.settings' },
      allow: [{ name: 'player.settingsPanel' }],
      skipIf: { pred: 'player.settingsOpen' },
      lines: [{ say: 'Open **⚙ Settings**.', mood: 'pointing' }],
      advance: [{ when: { pred: 'player.settingsOpen' }, goto: 'next' }],
      assist: { name: 'openSettings', label: 'Open it for me' },
      next: true,
    },
    {
      id: 'settings-panel',
      type: 'point',
      target: { name: 'player.settingsPanel' },
      skipIf: { not: { pred: 'player.settingsOpen' } },
      lines: [
        { say: 'Pick a subtitle track, **load your own** (.srt, .vtt), or change the speed.', mood: 'happy' },
        { say: '**Fullscreen when rotated**: turn your phone sideways and the video fills the screen.' },
      ],
      advance: [{ when: { not: { pred: 'player.settingsOpen' } }, goto: 'next' }],
      next: true,
    },
    {
      id: 'fullscreen',
      type: 'point',
      target: { name: 'player.fullscreen' },
      lines: [
        { say: '**⛶** fills the screen (a double-click on the video does too).', mood: 'pointing' },
        { say: '[[Esc]] or the same button brings you back.' },
      ],
      advance: [{ when: { pred: 'video.fullscreen' }, goto: 'in-fullscreen' }],
      assist: { name: 'showControls', label: 'Show the controls' },
      next: true,
    },
    {
      id: 'in-fullscreen',
      type: 'point',
      target: { name: 'player.fullscreen' },
      skipIf: { not: { pred: 'video.fullscreen' } },
      lines: [{ say: 'Fullscreen! Press [[Esc]] or the button to come back.', mood: 'excited' }],
      advance: [{ when: { not: { pred: 'video.fullscreen' } }, goto: 'next' }],
      assist: { name: 'showControls', label: 'Show the controls' },
      next: true,
    },
    {
      id: 'resume',
      type: 'say',
      lines: [{ say: 'One more: reopening a video carries on **where you stopped**.', mood: 'happy' }],
    },
    {
      id: 'done',
      type: 'end',
      lines: [{ say: "That's the player! 🍿", mood: 'celebrate' }],
    },
  ],
};

export { playerBasics };
