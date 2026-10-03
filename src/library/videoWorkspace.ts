/**
 * The app's file library and workspace (easy-folder-management-ui):
 *
 *  - a READ-ONLY linked folder of videos (the browser asks for read access
 *    only; nothing here ever writes, renames or deletes the user's files);
 *  - tabs: `file:<id>` videos (preview on single click, like VS Code),
 *    `welcome:`, and `share:<id>` — someone else's shared tab, never
 *    persisted (the share ends with the session);
 *  - a document adapter that hands the player a disk-backed `File` and
 *    never reads the video itself.
 */
import {
  createIndexedDbStore,
  defineTabKinds,
  extensionPolicy,
  FileLibrary,
  pathOf,
  Workspace,
} from '@theclearsky/easy-folder-management-ui';
import type { DocumentAdapter } from '@theclearsky/easy-folder-management-ui';

const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.ogv'];

const videoPolicy = extensionPolicy({
  openable: VIDEO_EXTENSIONS,
  content: 'binary',
  // Downloads in progress are written as `<name>.part` and stay out of the
  // tree until complete (G12), next to the usual dot-files and swap files.
  isHidden: (name) =>
    name.startsWith('.') || name === 'node_modules' || /\.(crswap|part)$/i.test(name),
});

const tabKinds = defineTabKinds({
  file: { persist: 'file' },
  welcome: { persist: 'key' },
  share: { persist: false },
});

/** What the player shows for the open file tab. */
type VideoDocument = { fileId: string; file: File; path: string };

/** The adapter writes here; React reads it with useSyncExternalStore. */
class OpenVideo {
  private current: VideoDocument | null = null;
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.current;
  set(next: VideoDocument | null) {
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}

function createVideoWorkspace() {
  const library = new FileLibrary({
    store: createIndexedDbStore('watch-together.library'),
    policy: videoPolicy,
    access: 'read',
  });
  const openVideo = new OpenVideo();
  const documents: DocumentAdapter<VideoDocument> = {
    async load(file) {
      const disk = await file.getFile();
      return {
        ok: true,
        content: { fileId: file.id, file: disk, path: pathOf(library.tree, file.id).join('/') },
        // A video never changes under us in a way snapshots care about; the
        // file's own identity is enough.
        signature: `${disk.lastModified}:${disk.size}`,
      };
    },
    install: (content) => openVideo.set(content),
    closeEditor: () => openVideo.set(null),
  };
  const workspace = new Workspace<VideoDocument>({
    library,
    kinds: tabKinds,
    documents,
    save: false,
    welcomeTab: 'welcome:',
    label: ({ kind }) => (kind === 'welcome' ? 'Welcome' : undefined),
  });
  return { library, workspace, openVideo };
}

export { createVideoWorkspace, tabKinds, VIDEO_EXTENSIONS, videoPolicy };
export type { VideoDocument };
