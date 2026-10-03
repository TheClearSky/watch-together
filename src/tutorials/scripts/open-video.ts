import type { AppTutorial } from '../kit';

/** Data only: open a single file (every browser), or link a folder. */
const openVideo: AppTutorial = {
  format: 1,
  id: 'open-video',
  revision: 1,
  title: 'Open or link a video',
  summary: 'Open any video file, or link a whole folder of them.',
  estimatedMinutes: 1,
  steps: [
    {
      id: 'go-welcome',
      type: 'point',
      target: { name: 'header.welcome' },
      skipIf: { any: [{ pred: 'page.is', args: { page: 'welcome' } }, { pred: 'video.open' }] },
      lines: [{ say: "Let's start on the **🏠 Welcome** page.", mood: 'pointing' }],
      advance: [
        { when: { pred: 'page.is', args: { page: 'welcome' } }, goto: 'next' },
        { when: { pred: 'video.open' }, goto: 'playing' },
      ],
    },
    {
      id: 'pick',
      type: 'point',
      target: { name: 'welcome.openFile' },
      allow: [{ name: 'welcome.linkFolder' }],
      skipIf: { pred: 'video.open' },
      lines: [
        { say: 'Press **🎞 Open a video file…** and pick any video on this device. Every browser, phones too.', mood: 'pointing' },
        { say: 'You can also drop video files onto the page.' },
      ],
      advance: [
        { when: { pred: 'video.open' }, goto: 'playing' },
        { when: { pred: 'library.hasVideos' }, goto: 'library' },
      ],
      timeoutMs: 20000,
      hint: [{ say: 'The picker opens in its own window — choose a video there. Nothing is uploaded.', mood: 'thinking' }],
    },
    {
      id: 'playing',
      type: 'point',
      target: { name: 'player.playPause' },
      skipIf: { pred: 'video.playing' },
      lines: [{ say: 'Your video is open in its own tab. Press **▶** to play it.', mood: 'happy' }],
      advance: [
        { on: { event: 'video.play' }, goto: 'next' },
        { when: { pred: 'video.playing' }, goto: 'next' },
      ],
      assist: { name: 'showControls', label: 'Show the controls' },
      next: true,
    },
    {
      id: 'folder-offer',
      type: 'branch',
      if: { all: [{ pred: 'folders.supported' }, { not: { pred: 'library.hasVideos' } }] },
      then: 'folder-choice',
      else: 'done',
    },
    {
      id: 'folder-choice',
      type: 'choice',
      lines: [
        { say: 'One more thing: you can **link a whole folder**. Its videos show in the Library and are remembered.', mood: 'thinking' },
      ],
      options: [
        { label: 'Show me', goto: 'folder' },
        { label: 'No thanks', goto: 'done' },
      ],
    },
    {
      id: 'folder',
      type: 'point',
      target: { name: 'library.linkFolder' },
      allow: [{ name: 'header.library' }],
      lines: [
        { say: 'Press **Link folder…** and choose a folder of videos. It is read-only — nothing in it is ever changed.', mood: 'pointing' },
      ],
      advance: [{ when: { pred: 'library.hasVideos' }, goto: 'library' }],
      assist: { name: 'openLibrary', label: 'Open the library' },
      next: true,
    },
    {
      id: 'library',
      type: 'point',
      target: { name: 'library.tree' },
      skipIf: { not: { pred: 'library.hasVideos' } },
      lines: [
        { say: 'Here is your folder. Click a video to open it; subtitle files next to it (`ep01.srt`) load by themselves.', mood: 'happy' },
      ],
      advance: [{ on: { event: 'clicked', args: { target: 'library.tree' } }, goto: 'next' }],
      next: true,
    },
    {
      id: 'done',
      type: 'end',
      lines: [
        { say: "You're set! 🎉", mood: 'celebrate' },
        { say: 'Want company? Try *Create a room and invite*.' },
      ],
    },
  ],
};

export { openVideo };
