/**
 * Videos opened ONE AT A TIME, without linking a folder (2026-10-03: "i
 * should be able to open a file in browser, linking a folder shouldn't be
 * necessary").
 *
 * Two ways in, by browser:
 *  - `showOpenFilePicker` (Chrome/Edge desktop): we get a FileSystemFileHandle,
 *    keep it in IndexedDB, and after a reload the tab comes back — one click
 *    re-grants access.
 *  - a plain `<input type=file>` (Firefox, Safari, every phone): we get a
 *    File for this session only; after a reload the tab asks to pick the
 *    file again. Drag-and-drop works the same way (with a handle where the
 *    browser offers one).
 *
 * The video itself is never read into memory: a File from either source is
 * disk-backed and an object URL streams it.
 */
import { createIndexedDbStore } from '@theclearsky/easy-folder-management-ui';
import type { KeyValueStore } from '@theclearsky/easy-folder-management-ui';

type OpenedEntry = {
  id: string;
  name: string;
  size: number;
  /** Present while we hold readable access this session. */
  file: File | null;
  /** Present when the browser gave us a re-openable handle. */
  handle: FileSystemFileHandle | null;
};

type StoredEntry = { id: string; name: string; size: number; handle: FileSystemFileHandle | null };

type HandleWithPermission = FileSystemFileHandle & {
  queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
};

type PickerWindow = Window & {
  showOpenFilePicker?(options: {
    multiple?: boolean;
    id?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileSystemFileHandle[]>;
};

const ACCEPT_ATTRIBUTE = 'video/*,.mkv,.webm,.mp4,.m4v,.mov,.ogv';
const PICKER_TYPES = [
  {
    description: 'Videos',
    accept: { 'video/*': ['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.ogv'] },
  },
];

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

class OpenedFiles {
  private entries = new Map<string, OpenedEntry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private readonly ready: Promise<void>;

  constructor(private readonly store: KeyValueStore = createIndexedDbStore('watch-together.opened')) {
    this.ready = this.restore();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Changes whenever any entry changes (for useSyncExternalStore). */
  getVersion = () => this.version;

  private emit() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  get(id: string): OpenedEntry | undefined {
    return this.entries.get(id);
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Entries from earlier sessions come back without a File until reopened. */
  private async restore() {
    const ids = (await this.store.get<string[]>('ids').catch(() => undefined)) ?? [];
    for (const id of ids) {
      const stored = await this.store.get<StoredEntry>(`entry:${id}`).catch(() => undefined);
      if (!stored) continue;
      let file: File | null = null;
      const handle = stored.handle as HandleWithPermission | null;
      // Chrome often keeps the grant; then the tab plays without a click.
      if (handle && (await handle.queryPermission?.({ mode: 'read' }).catch(() => 'denied')) === 'granted') {
        file = await handle.getFile().catch(() => null);
      }
      this.entries.set(id, { ...stored, file });
    }
    this.emit();
  }

  private async persist() {
    const ids = [...this.entries.keys()];
    await this.store.set('ids', ids).catch(() => {});
    for (const entry of this.entries.values()) {
      const stored: StoredEntry = { id: entry.id, name: entry.name, size: entry.size, handle: entry.handle };
      await this.store.set(`entry:${entry.id}`, stored).catch(() => {});
    }
  }

  /** Add Files (and their handles, when known). Returns the new ids. */
  async add(items: { file: File; handle?: FileSystemFileHandle | null }[]): Promise<string[]> {
    await this.ready;
    const added: string[] = [];
    for (const { file, handle } of items) {
      // The same file opened twice reuses its tab.
      const existing = [...this.entries.values()].find((entry) => entry.name === file.name && entry.size === file.size);
      if (existing) {
        existing.file = file;
        existing.handle = handle ?? existing.handle;
        added.push(existing.id);
        continue;
      }
      const id = newId();
      this.entries.set(id, { id, name: file.name, size: file.size, file, handle: handle ?? null });
      added.push(id);
    }
    this.emit();
    await this.persist();
    return added;
  }

  /**
   * Ask the user for video files. MUST run straight from a click (both the
   * picker and the input need the user gesture). Resolves to the new ids, or
   * [] when cancelled.
   */
  async pick(): Promise<string[]> {
    const picker = (window as PickerWindow).showOpenFilePicker;
    if (picker) {
      try {
        const handles = await picker.call(window, { multiple: true, id: 'watch-together-open', types: PICKER_TYPES });
        const items = await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
        return this.add(items);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return [];
        // Some browsers expose the picker but refuse it (policy): fall back.
      }
    }
    const files = await pickWithInput();
    return files.length > 0 ? this.add(files.map((file) => ({ file }))) : [];
  }

  /** Re-grant a remembered handle (from a click), or pick the file again. */
  async reopen(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const handle = entry.handle as HandleWithPermission | null;
    if (handle?.requestPermission) {
      const state = await handle.requestPermission({ mode: 'read' }).catch(() => 'denied' as PermissionState);
      if (state === 'granted') {
        entry.file = await handle.getFile().catch(() => null);
        this.emit();
        return entry.file !== null;
      }
      return false;
    }
    const [file] = await pickWithInput(false);
    if (!file) return false;
    entry.file = file;
    entry.name = file.name;
    entry.size = file.size;
    this.emit();
    await this.persist();
    return true;
  }

  async forget(id: string): Promise<void> {
    if (!this.entries.delete(id)) return;
    this.emit();
    await this.store.delete(`entry:${id}`).catch(() => {});
    await this.persist();
  }
}

/** A hidden `<input type=file>`, resolved with the chosen files ([] on cancel). */
function pickWithInput(multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT_ATTRIBUTE;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/**
 * Pick ONE video with the SAME picker as "Open a video file" (File System
 * Access where available, else the file input) — so "My copy" and "Open" show
 * an identical dialog. Returns the File (null on cancel); it is NOT added to
 * the library (the caller just needs the bytes).
 */
async function pickOneVideo(): Promise<File | null> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker.call(window, { multiple: false, id: 'watch-together-open', types: PICKER_TYPES });
      return handle ? await handle.getFile() : null;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      // policy-refused: fall through to the input
    }
  }
  const [file] = await pickWithInput(false);
  return file ?? null;
}

/** Files dropped onto the page, with handles where the browser offers them. */
async function droppedVideos(dataTransfer: DataTransfer): Promise<{ file: File; handle: FileSystemFileHandle | null }[]> {
  // Everything is taken SYNCHRONOUSLY: the browser invalidates the dropped
  // items as soon as the drop handler yields (the first await).
  const pending = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => {
      const withHandle = item as DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> };
      return { file: item.getAsFile(), handle: withHandle.getAsFileSystemHandle?.().catch(() => null) ?? null };
    });
  const out: { file: File; handle: FileSystemFileHandle | null }[] = [];
  for (const { file, handle: handlePromise } of pending) {
    const handle = await handlePromise;
    if (!file || !isVideoName(file.name, file.type)) continue;
    out.push({ file, handle: handle && handle.kind === 'file' ? (handle as FileSystemFileHandle) : null });
  }
  return out;
}

function isVideoName(name: string, type = ''): boolean {
  return type.startsWith('video/') || /\.(mp4|m4v|mkv|webm|mov|ogv)$/i.test(name);
}

export { droppedVideos, isVideoName, OpenedFiles, pickOneVideo };
export type { OpenedEntry };
