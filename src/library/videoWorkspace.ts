/**
 * The app's file library and workspace (easy-folder-management-ui):
 *
 *  - a READ-ONLY linked folder of videos (the browser asks for read access
 *    only; nothing here ever writes, renames or deletes the user's files);
 *  - tabs: `file:<id>` videos from the linked folder (preview on single
 *    click, like VS Code), `opened:<id>` videos opened one at a time without
 *    any folder (openedFiles.ts), `welcome:`, and `share:<id>` — someone
 *    else's shared tab, never persisted (the share ends with the session);
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
import type { ConfirmRequest, DocumentAdapter, UnlinkChoice, UnlinkPlan } from '@theclearsky/easy-folder-management-ui';
import { OpenedFiles } from './openedFiles';

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
  opened: { persist: 'key' },
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

/** The workspace asks through these; the app points them at its dialog. */
type WorkspacePrompts = {
  chooseUnlink(plan: UnlinkPlan): Promise<UnlinkChoice>;
  confirm(request: ConfirmRequest): Promise<boolean>;
};

function createVideoWorkspace() {
  const prompts: WorkspacePrompts = {
    chooseUnlink: async () => 'cancel',
    confirm: async () => false,
  };
  const library = new FileLibrary({
    store: createIndexedDbStore('watch-together.library'),
    policy: videoPolicy,
    access: 'read',
  });
  const openVideo = new OpenVideo();
  const openedFiles = new OpenedFiles();
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
    chooseUnlink: (plan) => prompts.chooseUnlink(plan),
    confirm: (request) => prompts.confirm(request),
    label: ({ kind, key }) =>
      kind === 'welcome' ? 'Welcome' : kind === 'opened' ? (openedFiles.get(key)?.name ?? 'Video') : undefined,
    // Opened files reopen while remembered (from their handle, or by picking
    // the file again); a share is gone once it ends.
    canReopen: (id) => {
      const parsed = id.split(':');
      if (parsed[0] === 'share') return false;
      if (parsed[0] === 'opened') return openedFiles.get(parsed.slice(1).join(':')) !== undefined;
      return true;
    },
  });
  return { library, workspace, openVideo, openedFiles, prompts };
}

export { createVideoWorkspace, tabKinds, VIDEO_EXTENSIONS, videoPolicy };
export type { VideoDocument };
