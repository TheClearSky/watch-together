# R1 — Extracting Nodestra's file library + tabs into `@theclearsky/easy-folder-management-ui`

Date: 2026-10-01. Research only: nothing in any repo was changed except this file.
Sources read in full: every module listed in the brief, plus `src/components/EmptyEditor.tsx`,
`src/components/AutoSaveControl.tsx` (head), the five library/tabs test files (headers and test
names), `.claude/HANDOFF.md` (status, Tailwind, Graph Library, Tabs sections),
`.claude/plans/file-library.md`, `.claude/plans/tabs-welcome-tutorials.md`,
`review/2026-09-20-css-isolation/OUTCOME.md`, the host's `src/index.css` + `src/utils/cnHelper.ts`,
the timeline plugin's `package.json` / `vite.config.ts` / `src/style.css`, and the whole
`easy-tutorial-builder` scaffold.

Paths: **N** = `C:\Users\deepa\Repos\react-blender-nodes-sound` (the HANDOFF says it was renamed to
`nodestra`, but on disk it is still `react-blender-nodes-sound`). **ETB** = `C:\Users\deepa\Repos\easy-tutorial-builder`.
**Host** = `C:\Users\deepa\Repos\react-blender-nodes`. **TL** = `C:\Users\deepa\Repos\react-blender-nodes-timeline`.
`watch-together` holds only `.claude/` today. Every `file:line` below refers to N unless prefixed.

> **Two corrections to the brief, up front**
> 1. **Nodestra has NO preview tabs.** Ruling Q4 was "no" (`.claude/plans/tabs-welcome-tutorials.md:364`),
>    and `src/tabs/tabsModel.ts:11` says "no preview tabs (Q4 "no") — every open is a permanent tab."
>    Preview tabs would be NEW library work, opt-in.
> 2. **OPFS is not a backend in Nodestra.** OPFS appears only as a stand-in folder handle used during live
>    verification, because the native picker cannot be automated (`.claude/plans/file-library.md:144-146`).
>    `FolderBackend` works unchanged over an OPFS root (`navigator.storage.getDirectory()` returns a
>    `FileSystemDirectoryHandle`), so an "OPFS backend" is cheap to add. It does not exist today.

---

## 1. Inventory

### 1.1 Module table

| module | LOC | role | exports | verdict |
|---|---:|---|---|---|
| `src/library/names.ts` | 166 | name rules: Windows-safe everywhere, case-insensitive collisions, `Untitled 2.json` | `GRAPH_EXTENSION, isGraphFileName, isHiddenEntry, nameKey, sameName, splitExtension, toGraphFileName, uniqueName, validateName` | ~90% generic |
| `src/library/libraryTree.ts` | 349 | pure immutable tree, stable ids (never paths) | `addNode, childNamed, childrenOf, countContents, createEmptyTree, deserializeTree, findByPath, getNode, isGraphFile, LibraryError, moveNode, newNodeId, pathOf, removeNode, renameNode, serializeTree, subtreeIds, topmostOnly, treeFromNodes`; types `LibraryNode, LibraryNodeKind, LibraryTree` | ~95% generic |
| `src/library/keyValueStore.ts` | 103 | raw IndexedDB KV (+ Map fallback) | `createIndexedDbStore, createMemoryStore`; type `KeyValueStore` | generic (one default-name import) |
| `src/library/backends.ts` | 656 | `MemoryBackend` (IDB) / `FolderBackend` (FSA), scan, copy-then-drain folder moves, conflict check | `canLinkFolders, ConflictError, FolderBackend, folderPermission, MemoryBackend, scanFolder`; types `BackendKind, LibraryBackend, ScanResult` | generic, but **TEXT-ONLY I/O** |
| `src/library/fileSystemAccess.d.ts` | 45 | ambient global augmentation: `queryPermission/requestPermission/move/showDirectoryPicker` | (ambient) | generic; must NOT ship as a global augmentation (see §6) |
| `src/library/graphLibrary.ts` | 740 | THE store: serial queue, mutation guard, link/unlink/reconnect/rescan, session undo, tab-record persistence | `GraphLibrary`; types `LibraryMode, LibrarySnapshot` | ~85% generic; "graph file" predicate in 5 places |
| `src/library/saveController.ts` | 298 | saves the OPEN file by id; generation counter; buffers; auto-save on/off + delay | `MINIMUM_SAVE_DELAY_MS, SaveController`; type `SaveSettings` | **100% generic already** (text payload) |
| `src/library/useLibrarySession.ts` | 1240 | app orchestration: open/switch/close tabs, snapshots, journal, boot, link/unlink flows, conflicts, borrow/probe | `useLibrarySession`; types `OpenFailure, SaveConflict` | **mixed: ~55% generic logic tangled with Nodestra types** |
| `src/tabs/tabsModel.ts` | 159 | pure tabs reducer (order / active / MRU / closed) | `activeAfterClose, emptyTabs, othersOf, rightOf, sanitizeTabs, tabsReducer, WELCOME_TAB`; types `TabsAction, TabsState` | generic; `'@'` page convention |
| `src/components/FileSidebar.tsx` | 687 | headless-tree sidebar: toolbar, storage strip, tree, rename, DnD, notices | `FileSidebar`; type `FileSidebarProps` | generic behaviour, Nodestra strings + host imports |
| `src/components/TabStrip.tsx` | 319 | from-scratch APG tablist, drag/keyboard reorder, overflow list, Radix context menu | `TabStrip` | ~95% generic |
| `src/components/WelcomePage.tsx` | 229 | Welcome tab content | `WelcomePage`; types `WelcomeDemo, WelcomeTutorial` | ~20% generic (layout only) |
| `src/components/UnsavedChangesDialog.tsx` | 94 | Save / Don't save / Cancel, native `<dialog>` | `useUnsavedChangesDialog` | generic |
| `src/components/SidebarErrorBoundary.tsx` | 52 | keeps a sidebar crash inside the sidebar | `SidebarErrorBoundary` | generic |
| `src/components/Toaster.tsx` | 87 | module-global toast store + `<Toaster paused>` | `dismissToast, showToast, Toaster` | generic |
| `src/components/EmptyEditor.tsx` | 59 | "Nothing is open" watermark | `EmptyEditor` | layout generic, text Nodestra |
| `src/components/AutoSaveControl.tsx` | 174 | Auto-run-style split button (ruling F3) | `AutoSaveControl`; type `SaveStatus` | generic idea, built from HOST widgets |
| `src/storageNamespace.ts` | 10 | `STORAGE_NAMESPACE = 'react-blender-nodes-sound'` | `STORAGE_NAMESPACE` | app constant |
| `src/appPersistence.ts` | 451 | project file format, journal, signature, legacy autosave | 17 functions (`serializeProject`, `deserializeProject`, `projectSignature`, `saveJournal`, …) | ~15% generic (journal pattern, `downloadBlob`) |
| `src/App.tsx` | 1285 | wiring | — | app |

Tests (all node environment, no DOM): `libraryTree.test.ts` 161, `libraryBackends.test.ts` 329 (memfs),
`graphLibrary.test.ts` 259 (memfs), `saveController.test.ts` 225, `tabsModel.test.ts` 93: **1,067 LOC, 68 test
cases** in 10 `describe` blocks (16 tree+names, 15 backends, 14 library, 13 save controller, 10 tabs). **`useLibrarySession` and every UI component have NO unit tests.** They were
live-verified in Chrome (`.claude/plans/file-library.md:144-159`, HANDOFF "P1 TABS — BUILT + live-verified").

### 1.2 Coupling points (Nodestra-specific), with file:line

**names.ts**
- `:43` `GRAPH_EXTENSION = '.json'`; `:93-95` `isGraphFileName` = ends with `.json`; `:144-154` `toGraphFileName` appends `.json`.
- `:103-109` `isHiddenEntry` hard-codes the scan-skip policy (dot-entries, `node_modules`, `*.crswap`). That is a sensible default, but it should be configurable.
- Everything else (`validateName :46-80`, `nameKey :84`, `uniqueName :123-137`) is generic and battle-tested (`~` names, invisible chars, `.lnk/.url/.scf/.local`, reserved stems).

**libraryTree.ts**
- `:139-141` `isGraphFile`; `:311-326` `countContents()` returns `{folders, graphs, otherFiles}`.
- `LibraryNode` (`:20-26`) has no metadata (size, lastModified, MIME). watch-together will want size, and maybe duration.

**keyValueStore.ts**
- `:15,24` default DB name `${STORAGE_NAMESPACE}.library`. It is already a parameter of `createIndexedDbStore(databaseName)` (`:34`), so only the default import must go.

**backends.ts** (generic in logic; the coupling is to *text*)
- `LibraryBackend.readText/writeText` (`:30-42`) carry strings only. `MemoryBackend` stores strings under `file:<id>` (`:69, :76-86`).
- `copyFile` (`:185-193`) does `await (await source.getFile()).arrayBuffer()`, so a **folder move/rename buffers every file fully in RAM**. That is harmless for 0.8 MB JSON and fatal for a 4 GB video.
- `folderPermission` (`:629-642`) always asks `{ mode: 'readwrite' }` (`:633`). There is no read-only link.
- `scanFolder` (`:575-626`) records only `{id, kind, name, parentId}`. It does NOT read contents (good for video), but it also skips size and mtime.

**graphLibrary.ts**
- `isGraphFile` at `:388` (unlink drops non-graph files), `:395` (unlink copies only graphs), `:553` (undo keeps only graph text), `:641` and `:679` (recalled tabs/active file must be graphs).
- `:84-89, :648-694`: tab-record persistence lives inside the store and knows the `'@'` page-tab convention (`:655`, `:676`, `:690`). This couples the store to the tabs model.
- `:350-352` link deletes the memory library (ruling "Linking back discards in memory tree"). `:372-416` unlink reads every graph into memory with `readText` (text-only, whole files).
- Key names `:82-86` (`folderHandle`, `activeFile`, `openTabs`, `initialized`) plus `tree` / `file:<id>` in backends.ts. Nodestra's existing browser data uses these, so they must stay the defaults (§6 R6).
- Class name `GraphLibrary`; user-facing strings in `describe()` (`:713-737`) are generic.

**saveController.ts**: no coupling. `serialize(): string` (`:30`) and the `MINIMUM_SAVE_DELAY_MS` rationale (`:36`, "0.6-0.86 MB file") are the only graph-flavoured bits. Default settings `{enabled: true, delaySeconds: 0.8}` (`:46`).

**tabsModel.ts**: `WELCOME_TAB = '@welcome'` (`:15`) plus the "ids starting with `@` are pages" convention (`:14`). It has no kinds, no preview, no pin, and no per-tab metadata.

**useLibrarySession.ts**: the tangle. Nodestra-specific points:
- `:24-25` `TimelineDocument`, `createEmptyTimelineDocument` (timeline plugin); `:45` `getTimelineStore`; `:46,50` `SoundState`.
- `:34-44` appPersistence: `deserializeProject, serializeProject, projectSignature, saveJournal/loadJournal/clearJournal, getBootJournalPath, markLibraryInitializedSync, persistenceDisabled`.
- `:52-56` `InstallProject` signature; `:91-99` `TabSnapshot = {state: SoundState, timeline, fileSignature}`; `:386-405` the history cap reaches into the host `State.history.undoStack/redoStack`.
- `:326-332` change detection subscribes to the timeline store; `:320-324` watches React `state`.
- `:201-221` "(original).json" backup on the first save of a file that opened with warnings.
- `:442` `deserializeProject`; `:521` `toGraphFileName`; `:799` picker id `'sound-library'`.
- `:747-761, :801-816, :838-844` `window.confirm` / `window.alert` with graph wording.
- `:1069-1112` `borrowCanvas` / `returnCanvas` (landing piano) and `detachForProbe` (`__probe`).
- `:944-1002` boot: legacy-autosave migration, journal adoption, Q7 (startup restores → `onStartupOpened`), Q14 (`onFirstVisit`).
- Generic logic worth extracting (detail in §5): tabs dispatcher plus ref mirror (`:157-164`), recent list (`:176-182`), open-token race guard (`:378, :416, :427, :437`), snapshot capture/reuse by file signature (`:386-405, :456-474`), close-with-confirm (`:618-647`), close family (`:649-655`), reopen (`:662-670`), dropTabs (`:674-686`), link/unlink/reconnect flows (`:793-940`), debounced tab record (`:1016-1025`), labels following renames (`:1027-1031`), focus rescan (`:1033-1041`), Ctrl+S (`:1043-1055`), beforeunload (`:1057-1067`), conflict overwrite/reload (`:1116-1139`), saveStatus (`:1157-1162`).

**FileSidebar.tsx**
- `:12-13` imports `cn`, `FullGraphContextMenu`, `ContextMenuItem` from the HOST package. The host context menu has no ARIA and no keyboard support (`.claude/plans/tabs-welcome-tutorials.md:130`).
- `:69-73` `isInert` = non-`.json`; `:93-95, :170` force `.json` on rename.
- `:365` class `nokey`: Nodestra's keyboard-bus opt-out (letters play notes). `:365` fixed `w-[260px]`.
- Strings `:366` "Graph library", `:385-386` "Library", `:392-396` "＋ Graph"/"New graph", `:649` "No graphs yet… Demos menu", `:422-432, :447, :461` link tooltips; icons `:584-587` (▾▸, 🗀, ·, ◇).

**TabStrip.tsx**
- `:4` host `cn`; `:160` aria-label "Open files"; shortcut hints hard-coded `:217` "Alt+W", `:243`, `:263` "Alt+Shift+T". Nothing else.

**WelcomePage.tsx**
- `:2` `KEY_ORDER, KEY_TO_SEMITONE` (audio keymap); `:3` `NodestraMark`; demos, tutorials, piano key map, shortcut list, colours `#b444d8 #7b5cff #efe9dc #141414` (`:132, :163, :172`). Only `Section` (`:63-70`), `ACTION` (`:72-73`), Recent (`:109-121`) and the startup checkbox (`:215-222`) are generic.

**UnsavedChangesDialog.tsx**: fixed `id='unsaved-title'` (`:48, :55`) → should be `useId()`.
**SidebarErrorBoundary.tsx**: `:31` log tag `[library]`; `:37` fallback width 260.
**Toaster.tsx**: module-level singleton store (`:14-16`).
**AutoSaveControl.tsx**: `:2-6` host `Button`, `cn`, `SliderNumberInput`.
**EmptyEditor.tsx**: "♪", "Open a graph" wording.

**App.tsx** wiring (stays app-side but shows the integration surface):
- `:257-284` boot state: journal → legacy autosave → empty (sync, before IDB answers).
- `:391-395` `silenceForLibrary` = `disposeBuild()` + transport stop. `:396` `useUnsavedChangesDialog()`. `:429-439` `onStartupOpened` (auto-run OFF + toast). `:440-453` `useLibrarySession({...10 options})`.
- `:455-477` Alt+W / Alt+Shift+T / Alt+PgUp/PgDn. `:478` sidebar toggle.
- `:498, :529` `session.detachForProbe()`. `:726-747` `loadDemo` → `session.createAndOpen` (ruling F5). `:762-775` borrow/return.
- `:816-829` header Welcome button and file name. `:960-985` sidebar inside the error boundary. `:988-1003` TabStrip.
- `:1004-1030` "not saved in the library" banner + Save to library. `:1031-1057` conflict banner (Overwrite / Reload).
- `:1058-1100` panel switch: Welcome / EmptyEditor / `FullGraph`. `:1202-1221` "Unsupported file" overlay. `:1224` `<Toaster paused={appHidden}/>`.
- `vite.config.ts:23,61` `reloadOnLinkedLibraryBuild()`. A new `file:`-linked library MUST be added to its list (HANDOFF: a hot swap of a linked lib once emptied a timeline).

---

## 2. Backend abstraction as it exists

```
            GraphLibrary  (one tree, one backend at a time, one serial queue)
                 │  run(work, {write})  ── errors → snapshot.error, rethrown
     ┌───────────┴────────────┐
 MemoryBackend(store)     FolderBackend(rootHandle)
  IDB keys:                 disk; ids never touch disk
   'tree'  (serializeTree)   seen: Map<id,{lastModified,size}>  ← conflict check
   'file:<id>' (string)      relocate = file.move() | copy+delete;
                             folders  = copy, then DRAIN (never recursive delete)
 shared KeyValueStore ('<ns>.library' DB, store 'kv'):
   'folderHandle' (FileSystemDirectoryHandle — survives reload ONLY in IDB)
   'activeFile'  (legacy, path[])   'openTabs' (StoredTabs)   'initialized' (bool)
```

**Interfaces, quoted:**

```ts
// keyValueStore.ts:17-22
interface KeyValueStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
function createIndexedDbStore(databaseName: string = DATABASE_NAME): KeyValueStore; // :34 — resolves only after tx COMPLETE (durable)
function createMemoryStore(): KeyValueStore;                                        // :88

// backends.ts:26-56
type BackendKind = 'memory' | 'folder';
interface LibraryBackend {
  readonly kind: BackendKind;
  readText(tree: LibraryTree, id: string): Promise<string>;
  writeText(tree: LibraryTree, id: string, text: string,
            options?: { force?: boolean; create?: boolean }): Promise<void>;
  createFolder(tree: LibraryTree, id: string): Promise<void>;
  relocate(before: LibraryTree, after: LibraryTree, id: string): Promise<string | null>;
  remove(before: LibraryTree, id: string): Promise<string | null>;
  saveStructure(tree: LibraryTree): Promise<void>;
  namesIn(tree: LibraryTree, parentId: string): Promise<string[]>;
}
class ConflictError extends Error { constructor(readonly fileName: string) }        // :59-64
class MemoryBackend { loadStructure(): Promise<string|undefined>; clear(): Promise<void> } // extra :116-125
class FolderBackend { constructor(readonly root: FileSystemDirectoryHandle); get folderName(): string;
                      countHiddenEntries(tree, id): Promise<number> }                // :313-552
type ScanResult = { tree: LibraryTree; unreadable: number };
function scanFolder(root: FileSystemDirectoryHandle, previous?: LibraryTree): Promise<ScanResult>; // :575
function folderPermission(handle: FileSystemDirectoryHandle, request: boolean): Promise<PermissionState>; // :629
function canLinkFolders(): boolean;   // :644 — typeof window.showDirectoryPicker === 'function'

// graphLibrary.ts:52-74, 94-99
type LibraryMode =
  | { kind: 'loading' } | { kind: 'memory' }
  | { kind: 'folder'; folderName: string }
  | { kind: 'reconnect'; folderName: string };
type LibrarySnapshot = { mode: LibraryMode; tree: LibraryTree; unsupported: ReadonlySet<string>;
  error: string | null; notice: string | null; busy: boolean; undoableDelete: string | null;
  storageUnavailable: boolean };
type GraphLibraryOptions = { store: KeyValueStore;
  beforeMutate?: (affectedIds: readonly string[]) => Promise<void> };
```

`GraphLibrary` public surface: `subscribe`, `getSnapshot` (useSyncExternalStore), `tree`, `mode`, `writable`,
`dismissError()`, `dismissNotice()`, `init()` (idempotent, `:223`), `isInitialized()`, `markInitialized()`,
`reconnect()`, `rescan({force?})`, `link(handle)`, `unlinkSummary()`, `unlink()`, `readText(id)`,
`writeText(id, text, {force?})`, `markUnsupported(id, bool)`, `createFile(parentId, desiredName, text): Promise<id>`,
`createFolder(parentId, desiredName): Promise<id>`, `rename(id, name)`, `move(ids, targetParentId)`,
`hiddenEntriesIn(ids)`, `remove(ids)`, `undoDelete(): Promise<string[]>`, `rememberActiveFile`, `recallActiveFile`,
`rememberTabs(record)`, `recallTabs()`, and the mutable `beforeMutate`.

**Capability checklist**

| capability | status | where |
|---|---|---|
| In-browser store (IndexedDB) | yes. Text files + structure; Map fallback when IDB refuses on first use (private modes) → `storageUnavailable: true`, "This tab only" | `keyValueStore.ts:34-100`, `graphLibrary.ts:229-238`, `FileSidebar.tsx:415` |
| Linked local folder (FSA) | yes, Chromium desktop only; Link hidden elsewhere with an explanation | `backends.ts:313-552`, `FileSidebar.tsx:417-434` |
| OPFS | **no** (only a verification stand-in) | `.claude/plans/file-library.md:144` |
| Handle persisted in IDB | yes. Saved BEFORE the mode switches, so a failure part-way can't leave a linked-looking library that forgets its folder | `graphLibrary.ts:341-356` |
| Permission re-request "Reconnect" | yes. Boot queries (`request=false`); not granted → `mode: reconnect`. `reconnect()` calls `requestPermission` **synchronously inside the click, before any queue hop or IDB read** (FB-28) | `graphLibrary.ts:239-257, :296-306`; session `:925-940` |
| Access loss mid-session | `NotAllowedError`/`SecurityError`, or a vanished ROOT (`NotFoundError` + root probe) → `reconnect` | `graphLibrary.ts:192-209` |
| Read-only modes | `writable` = mode is memory or folder; `?nosave` → `persistenceDisabled()`; probe → read-only; reconnect → read-only. **No read-only LINK** (always readwrite) | `graphLibrary.ts:158-160, :703-710`; `useLibrarySession.ts:1173-1175` |
| External changes | re-scan on window `focus`, throttled 2 s, never concurrent, keeps ids by `kind:path`, keeps the SAME tree object when unchanged; write-time conflict check by `lastModified`+`size` → `ConflictError` → banner (Overwrite / Reload) | `graphLibrary.ts:91-92, :314-330`; `backends.ts:376-382`; session `:1033-1041, :1116-1139`. **`FileSystemObserver` unused** (`.claude/plans/file-library.md:166-167`) |
| Folder rename/move | copy, then drain only what the copy verifiably holds; Chrome-hidden entries (`.lnk`, `.url`, `~x`) are left in place with a note | `backends.ts:197-266, :435-483` |
| Case-only rename | via a temporary name | `backends.ts:306-309, :420-428` |
| Delete | file: `removeEntry`; folder: bottom-up drain, never `recursive: true`; session undo restores graphs + folders | `backends.ts:513-528`; `graphLibrary.ts:532-628` |
| Write atomicity | `createWritable` → write → close; `abort()` on failure (no stuck `.crswap`) | `backends.ts:173-183` |
| Serial queue + mutation guard | every storage op is serial; the tree changes only after storage succeeds; `beforeMutate` runs OUTSIDE the queue (a deadlock fix, A1) | `graphLibrary.ts:8-18, :166-187, :482-512` |

---

## 3. Tabs model

**State, exact (`tabsModel.ts:17-27`):**

```ts
type TabsState = {
  order: readonly string[];   // left-to-right
  active: string | null;      // null = nothing open
  mru: readonly string[];     // most-recently-used first → who becomes active on close
  closed: readonly string[];  // most recent first, capped MAX_CLOSED = 20 (:45)
};
```

**Actions (`:29-43`):** `open {id, activate?=true}` (new tabs go right AFTER the active one, `:66`; a background open appends to the MRU tail),
`activate {id}`, `close {ids}` (remembers in strip order, rightmost first, `:84`), `reorder {id, toIndex}`,
`reopen {canReopen(id)}`, `retain {keep(id)}` (closes and forgets gone ids), `restore {state}` (→ `sanitizeTabs`).
Helpers: `activeAfterClose(state, ids)`, `othersOf`, `rightOf`, `sanitizeTabs` (dedupe, active ∈ order, MRU repaired).

**Semantics where they actually live:**

| concept | where | how |
|---|---|---|
| Preview tab | — | **not implemented** (ruling Q4 "no") |
| MRU | reducer | `touch()` on open/activate; `nextActive` = first MRU survivor (`:54-57`) |
| Dirty | `SaveController.isDirty(id)` (open file dirty OR buffered) | session `:1176`, passed to TabStrip as a callback |
| Missing | session: `!isPageTab(id) && !tree.nodes[id]` | `useLibrarySession.ts:1193`. The strip strikes the label through; activating it shows the last in-memory snapshot, detached (`:597-606`) |
| Page tabs | ids beginning `@` (`'@welcome'`) | `tabsModel.ts:14-15`, `useLibrarySession.ts:104` |
| Labels | `snapshot.tree.nodes[id].name`, else the last known name (`tabNamesRef`) | `:1027-1031, :1188-1189` |
| Snapshots | `Map<fileId, {state, timeline, fileSignature}>` in memory; reused only while the FILE's signature equals the one captured | `:91-99, :386-405, :456-474` |
| Persistence | `{order, active, closed, recent}` by PATH (`{path}`) or `{page}`, debounced 300 ms, in IDB key `openTabs` | `graphLibrary.ts:84-89, :648-694`; session `:1016-1025` |
| Unsaved on close | `confirmUnsaved(names)` → save / discard / cancel; closing ids are `forget`-ed BEFORE the switch so "Don't save" sticks | `:618-647` |
| Race guard | `openTokenRef` increments; a superseded open gives its taken buffer back (C2) | `:378, :416-441` |

**What must be generalized for `share` tabs and app-defined kinds**

1. **Kinds instead of the `'@'` prefix.** Today "is it a file?" = `tree.nodes[id]`, and "is it a page?" = `startsWith('@')`. A `share` tab is neither. Proposal: canonical ids `"<kind>:<key>"` (`file:<nodeId>`, `welcome:`, `share:<peerId>`), plus a kind registry. The reducer stays string-only and kind-agnostic, so its 10 tests keep passing.
2. **Per-kind persistence.** `file` → by path (as now); `welcome` → by key (as `{page}` now); `share` → not persisted, or restored as an "ended" placeholder. Move `rememberTabs/recallTabs` OUT of `GraphLibrary` (`:632-694`) into a `TabRecordStore` that asks each kind to `encode`/`decode`. Keep reading the legacy `{page:'@welcome'}` and `{path}` shapes.
3. **Per-kind status** (`ok | missing | loading | ended | error`) replaces the file-only `isTabMissing`. A share tab whose stream ended is "ended", not "deleted".
4. **Dirty only for kinds that save.** `share` and video `file` tabs are never dirty. Move dirtiness behind an optional per-kind `isDirty`.
5. **Close policy per kind.** `confirmUnsaved` only applies to dirty kinds. A `share` tab may want "Leave the watch party?" instead, so add a per-kind async `beforeClose`.
6. **Optional preview (VS Code italic)**, opt-in per kind: `open {preview: true}` replaces the current preview tab; edit/double-click → `promote`. Default off, which preserves Nodestra's Q4 ruling. Useful for browsing a video folder.
7. **Optional pinned** (later; the plan lists it as "later", `tabs-welcome-tutorials.md:120`).
8. **Editor model.** Nodestra = ONE editor swapped through snapshots (plan §B; singleton timeline/audio). watch-together may prefer a mounted panel per tab (paused `<video>` elements are cheap) or a single player with `{currentTime, paused}` snapshots. The library should offer both: a `single` swap protocol (capture → switch → restore/load) and a `<TabPanels keepMounted>` renderer.

---

## 4. UI components

| component | props (exact) | styling | a11y | deps |
|---|---|---|---|---|
| `FileSidebar` | `snapshot, activeFileId, isDirty(id), readOnly, folderActionsDisabled, canLinkFolders, onOpen, onNewFile(parentId), onNewFolder(parentId), onRename(id,name), onMove(ids,target), onDelete(ids), onUndoDelete, onLink, onUnlink, onReconnect, onDismissError, onDismissNotice, renameRequest, onRenameRequestHandled` (`:18-43`) | Tailwind utilities, unprefixed, compiled by the APP's sheet (`source('.')` scans app src) | `aside aria-label`; headless-tree `getContainerProps`/`getProps` (tree/treeitem roles, selection, expansion); keys ↑↓←→ Home End Enter F2 Delete Backspace Ctrl+A, isolated from the app (`:56-67, :367-382`); rename input `aria-label`; dirty dot `aria-label='unsaved'`; notice `role=status`, error `role=alert`; Menu key opens the menu at the row (`:558-563`). **Gap:** the right-click menu is the host's `FullGraphContextMenu`, which has no ARIA | `@headless-tree/core` + `/react` 1.7.0 (MIT), host `cn`, `FullGraphContextMenu` |
| `TabStrip` | `order, active, label(id), isDirty(id), isMissing(id), onActivate, onClose(ids), onCloseOthers, onCloseRight, onCloseSaved, onCloseAll, onReorder(id,toIndex), onReopen, panelId` (`:17-34`) | Tailwind | `role=tablist/tab`, `aria-selected`, `aria-controls`, roving tabindex, MANUAL activation, ←→ Home End, Enter/Space, Delete closes, Ctrl+Shift+←→ reorders, middle-click closes, Radix menu (Shift+F10, typeahead). **Gaps:** close `<button>` nested inside `role=tab` (`:213-237`); the overflow `listbox` holds `<button>`s, has no arrow-key navigation and no outside-click close (`:285-313`) | `@radix-ui/react-context-menu` 2.3.7 (MIT), host `cn` |
| `WelcomePage` | `recentFiles, demos, tutorials, canCreate, canLinkFolders, showOnStartup, onShowOnStartupChange, onNewGraph, onImport, onLinkFolder, onOpenFile, onOpenDemo, onStartTutorial` (`:17-32`) | Tailwind + hex literals | h1/h2 structure, all actions are buttons, labelled checkbox | app keymap, `NodestraMark` |
| `useUnsavedChangesDialog` | returns `{ ask(names): Promise<'save'|'discard'|'cancel'>, element }` | Tailwind; `backdrop:bg-black/60` | native `<dialog>.showModal()` (focus trap, inert page), Esc → Cancel, `autoFocus` on Save. **Gap:** fixed id | none |
| `SidebarErrorBoundary` | `children, resetKey?` | Tailwind | plain text + "Try again" button | React class |
| `Toaster` / `showToast` | `Toaster({paused})`; `showToast({message, action?:{label,run}, timeoutMs?=8000}): number`; `dismissToast(id)` | Tailwind | container `aria-live=polite` AND per-item `role=status` (may double-announce); countdown paused while hidden | none |
| `EmptyEditor` | `canCreate, canReopen, onNewGraph, onReopen, onOpenWelcome` | Tailwind | — | none |
| `AutoSaveControl` | `enabled, onEnabledChange, delaySeconds, onDelaySecondsChange, status:'saved'|'unsaved'|'unavailable', pending, onSaveNow` | host widgets | split button + popover (same pattern as AutoRun) | host `Button`, `SliderNumberInput`, `cn` |

**Theme tokens actually used** (all from the host palette, re-declared in N `src/index.css` `@theme static`):
`primary-white #e6e6e6`, `primary-black #1d1d1d`, `secondary-black #282828` (sidebar/strip bg), `primary-dark-gray #303030`
(active tab, menus, dialog), `secondary-dark-gray #444444` (borders, hover), `primary-gray #545454`, `secondary-light-gray #656565`,
`primary-light-gray #797979` (muted text), `primary-blue #4772b3` (active row tint `/25`, drag target `/40`, focus ring, active tab top bar),
`status-warning #ffa500` (dirty dot, notice, Reconnect), `status-errored #ff4444` (error strip), `status-completed #4caf50` (saved dot).
Welcome literals: `#b444d8`, `#7b5cff`, `#efe9dc`, `#141414`. Font comes from the app. Sizes: row `h-[26px]`, indent 14 px,
sidebar 260 px, strip 34 px, tab max 220 px, `text-[12px]/[13px]`, z-index `z-1100` (menus), `z-900` (toasts).

---

## 5. Proposed library architecture

### 5.1 Shape

```
 @theclearsky/easy-folder-management-ui   (MIT, ESM+CJS, sideEffects: ["**/*.css"])
 ┌────────────────────────────────────────────────────────────────────────────────────┐
 │ "."  CORE — framework-free, no DOM at import (check-dist loads it in plain Node)    │
 │   names · tree · KeyValueStore(IDB|Map) · backends(Memory|Folder|Opfs) · scan       │
 │   FileLibrary (ex-GraphLibrary, + FilePolicy, + binary I/O, + access:'read')        │
 │   tabs reducer (kinds, opt-in preview) · TabRecordStore · SaveController<string>    │
 │   Workspace (ex-generic half of useLibrarySession: open/switch/close/race/snapshot) │
 │   journal(sessionStorage) · describeError · ConflictError · LibraryError            │
 ├───────────────────────────────┬────────────────────────────────────────────────────┤
 │ "./react"  hooks (react peer) │ "./ui"  components (react + react-dom peers)        │
 │  useLibrary(lib)              │  <FileSidebar> <FileTree> <TabStrip> <TabPanels>    │
 │  useWorkspace(opts)           │  <WelcomeLayout>/<WelcomeSection>/<RecentList>      │
 │  useSaveController(sc)        │  <EmptyState> <UnsavedChangesDialog> <ErrorBoundary>│
 │  useUnsavedChangesDialog()    │  <Toaster> (createToaster) <AutoSaveControl>         │
 │  useTabShortcuts / useSaveKey │  <ConflictBanner> <ReconnectBanner>                 │
 ├───────────────────────────────┴────────────────────────────────────────────────────┤
 │ "./styles.css"  Tailwind 4, prefix(efm), NO preflight, scoped resets,               │
 │                 public tokens --efm-* in plain @layer theme (rename-proof)          │
 └────────────────────────────────────────────────────────────────────────────────────┘
        ▲ app supplies: FilePolicy · TabKinds · DocumentAdapter · labels · icons
        │
   watch-together (videos, read, OPFS downloads, share tabs)     Nodestra (JSON graphs, SaveController, snapshots)
```

Optional later: `"./testing"` (a memfs-backed `makeFolder()` that strips `move` the way stable Chrome lacks it). memfs is Apache-2.0, so it would become an optional peer of that subpath only.

### 5.2 Generic types (proposed signatures)

```ts
// ── policy: replaces isGraphFile / isGraphFileName / isHiddenEntry / GRAPH_EXTENSION ──
interface FilePolicy {
  /** Files the app opens; everything else is shown greyed ("inert"). */
  isOpenable(name: string): boolean;
  /** Skipped by scans entirely. Default: dot-entries, node_modules, *.crswap. */
  isHidden?(name: string): boolean;
  /** Appended on create / kept on rename for openable files (".json"); undefined = free names. */
  defaultExtension?: string;
  /** How content is read for open/unlink/undo. 'text' = today; 'binary' = never .text() it. */
  content: 'text' | 'binary';
  /** UNLINK copies these into the browser store. Default: openable && content === 'text'. */
  copyOnUnlink?(node: LibraryNode, size: number): boolean;
  /** A delete keeps these in memory for session undo. Default: openable && size <= 8 MB. */
  keepForUndo?(node: LibraryNode, size: number): boolean;
}
function extensionPolicy(o: { openable: readonly string[]; content: 'text' | 'binary';
  defaultExtension?: string; hidden?: (name: string) => boolean }): FilePolicy;

// ── tree: unchanged, plus optional metadata filled lazily ─────────────────────
type LibraryNode = { id: string; kind: 'folder' | 'file'; name: string; parentId: string | null;
  meta?: { size?: number; lastModified?: number; type?: string } };

// ── backend: binary-capable, streaming copies ────────────────────────────────
type WriteData = string | Blob | ArrayBuffer | ReadableStream<Uint8Array>;
interface StorageBackend {
  readonly kind: 'memory' | 'folder' | 'opfs';
  readonly access: 'read' | 'readwrite';
  /** Disk-backed lazy Blob: URL.createObjectURL(file) streams a 4 GB video without reading it. */
  getFile(tree: LibraryTree, id: string): Promise<File>;
  readText(tree: LibraryTree, id: string): Promise<string>;          // = getFile().text()
  write(tree: LibraryTree, id: string, data: WriteData,
        options?: { force?: boolean; create?: boolean }): Promise<void>;
  createFolder(tree: LibraryTree, id: string): Promise<void>;
  relocate(before: LibraryTree, after: LibraryTree, id: string): Promise<string | null>;
  remove(before: LibraryTree, id: string): Promise<string | null>;
  saveStructure(tree: LibraryTree): Promise<void>;
  namesIn(tree: LibraryTree, parentId: string): Promise<string[]>;
  stat?(tree: LibraryTree, id: string): Promise<{ size: number; lastModified: number; type: string }>;
}
// copyFile becomes: (await src.getFile()).stream().pipeTo(await dst.createWritable())

// ── library ──────────────────────────────────────────────────────────────────
type LibraryMode = { kind: 'loading' } | { kind: 'memory' }
  | { kind: 'folder'; folderName: string; access: 'read' | 'readwrite' }
  | { kind: 'reconnect'; folderName: string };
interface FileLibraryOptions {
  store: KeyValueStore;                          // keys stay 'tree' | 'file:<id>' | 'folderHandle' | ...
  policy: FilePolicy;
  access?: 'readwrite' | 'read';                 // link + reconnect ask this mode; 'read' ⇒ tree ops refused
  browserStore?: 'kv' | 'opfs';                  // where in-browser (unlinked) files live; OPFS for big blobs
  watch?: 'focus' | 'observer' | 'none';         // 'observer' = FileSystemObserver, focus re-scan fallback
  beforeMutate?(affectedIds: readonly string[]): Promise<void>;
  confirm?(request: ConfirmRequest): Promise<boolean>; // replaces window.confirm (default: window.confirm)
}
declare class FileLibrary { /* GraphLibrary's surface, renamed: */
  getFile(id: string): Promise<File>; write(id: string, data: WriteData, o?: { force?: boolean }): Promise<void>;
  createFile(parentId: string, desiredName: string, data: WriteData): Promise<string>;
  markStatus(id: string, status: 'ok' | 'unsupported'): void; /* …rest as in §2 */ }

// ── tabs ─────────────────────────────────────────────────────────────────────
type TabId = `${string}:${string}`;              // "file:<nodeId>" | "welcome:" | "share:<peerId>"
interface TabsState { order: readonly TabId[]; active: TabId | null; mru: readonly TabId[];
  closed: readonly TabId[]; preview?: TabId | null }
type TabsAction = /* the 7 existing */ | { type: 'open'; id: TabId; activate?: boolean; preview?: boolean }
  | { type: 'promote'; id: TabId };
interface TabKind<Ctx = unknown> {
  singleton?: boolean;                                       // welcome
  persist: 'path' | 'key' | false;                           // file | welcome | share
  label(key: string, ctx: Ctx): string;
  status?(key: string, ctx: Ctx): 'ok' | 'missing' | 'loading' | 'ended' | 'error';
  isDirty?(key: string, ctx: Ctx): boolean;
  beforeClose?(keys: readonly string[], ctx: Ctx): Promise<boolean>;
  previewOnSingleClick?: boolean;
  /** Stored ids from before kinds existed (Nodestra: '@welcome') that decode to this kind. */
  legacyIds?: readonly string[];
}
function defineTabKinds<K extends string>(kinds: Record<K, TabKind>): TabKinds<K>;

// ── documents: the plug point for Nodestra's SaveController / snapshots ─────
interface DocumentAdapter<Content, Snapshot = never> {
  /** Parse an opened file. A refusal shows "Unsupported file" in place of the editor, and blocks nothing else. */
  load(file: { id: string; name: string; getFile(): Promise<File>; readText(): Promise<string> }):
    Promise<{ ok: true; content: Content; warnings?: string[] } | { ok: false; detail: string }>;
  install(content: Content, how: { fromSnapshot: boolean }): void;
  closeEditor(): void;                                       // nothing open
  silence?(): void;                                          // before showing "unsupported"
  // Saving (omit all three for read-only apps like watch-together):
  serialize?(): string;
  signature?(text: string): string | null;                   // content-equality, ignores transient keys
  onFirstSaveOfWarnedFile?(original: string, file: LibraryNode): Promise<void>; // Nodestra's "(original).json"
  // Tab switching in a single editor:
  capture?(): Snapshot; snapshotHistoryCap?: number;
}
interface WorkspaceOptions<Content, Snapshot> {
  library: FileLibrary; kinds: TabKinds<string>; documents: DocumentAdapter<Content, Snapshot>;
  save?: { defaults: SaveSettings };                         // present ⇒ a SaveController is created
  journal?: Journal;                                         // sessionStorage crash copy (Nodestra B2–B7)
  confirmUnsaved?(names: readonly string[]): Promise<'save' | 'discard' | 'cancel'>;
  onStartupOpened?(count: number): void; onFirstVisit?(): void; showWelcomeOnStartup?(): boolean;
  maxRecent?: number;                                        // 8 today
}
```

`Workspace` is a framework-free class (subscribe/getSnapshot like `GraphLibrary` and `SaveController`). That makes the
logic now buried in hooks testable in node. `useWorkspace` only wraps it, creating it with `useState(() => …)`, never
`useMemo` (the Fast Refresh rule recorded in the HANDOFF).

### 5.3 Extension points (summary)

- **Custom tab kinds**: `defineTabKinds` (label, status, dirty, persist, beforeClose, preview); UI `renderTabIcon(kind, key)`.
- **File icons/filters**: `FilePolicy.isOpenable` ("videos only"), `isHidden`; UI `renderIcon(node, {inert, expanded})`, `rowExtras(node)` (e.g. size or duration). Optional `filter(node)` to hide inert files instead of greying them.
- **Open behaviour**: `onOpen(node, {preview})` override, or the default (open a `file:` tab through the DocumentAdapter).
- **Binary vs text**: `FilePolicy.content` plus `getFile()`. The adapter decides whether it ever calls `readText()`.
- **Save hooks**: `DocumentAdapter.serialize/signature/onFirstSaveOfWarnedFile`, `SaveController` settings, and `journal`.
- **Prompts**: `confirm`, `confirmUnsaved`, `alert` are injectable (no hard-coded `window.confirm`), with defaults.
- **Strings**: `labels` objects with English defaults ("File", not "Graph").
- **Keyboard**: `className` pass-through (Nodestra passes `nokey`); configurable shortcut maps (Alt+W etc. are app choices).

### 5.4 CSS isolation strategy (mirror host/TL exactly)

Why: the host and the plugin were each measured breaking consumers (three cross-sheet ordering inversions, e.g. a
`border-b-0` losing to `border-b`) and spilling preflight into consumer pages (`OUTCOME.md §1, §5`). Do the same here:

1. `src/styles.css`: `@layer theme, base, components, utilities; @import 'tailwindcss/theme.css' layer(theme) source('.'); @import 'tailwindcss/utilities.css' layer(utilities) source('.');`. That is the SPLIT import, so **no preflight**.
2. `@theme prefix(efm) {}`. Every class becomes `efm:flex`. `efm` is disjoint from `rbn`/`rbnt` (`[class*='efm:']` can't match them), so Nodestra can load all three sheets.
3. A scoped `@layer base` block copied from TL `src/style.css` with `rbnt` → `efm`, INCLUDING the four resets the host audit found missing (`font-family`, `line-height: 1.5` placed AFTER `font: inherit`, the heading reset, the `:where()` border-box rule).
4. Public tokens go in a plain `@layer theme { :root, :host { --efm-surface: #282828; … } }` OUTSIDE `@theme`, with `@theme inline { --color-surface: var(--efm-surface); … }`, because `prefix()` renames `@theme` variables (`OUTCOME.md §4`; host `src/index.css:258-265`). Proposed set with Nodestra defaults (a byte-identical look after migration): `--efm-font`, `--efm-surface` #282828, `--efm-surface-raised` #303030, `--efm-surface-sunken` #1d1d1d, `--efm-border` #444444, `--efm-hover` #444444, `--efm-text` #e6e6e6, `--efm-text-muted` #797979, `--efm-text-disabled` #656565, `--efm-accent` #4772b3, `--efm-warning` #ffa500, `--efm-danger` #ff4444, `--efm-success` #4caf50, `--efm-row-height` 26px, `--efm-sidebar-width` 260px.
5. An own `cn` (clsx + tailwind-merge, both MIT) that strips `efm:` before merging and restores it, the same algorithm as the host's `cnHelper.ts:20-60`. Then a consumer's unprefixed `className` wins over the library's default. Note: the host `cn` knows only `['rbnt','rbn']`. If Nodestra ever merges classes ONTO efm components with the host `cn`, `efm` must be added to the host's `FIRST_PARTY_PREFIXES`.
6. A verification oracle: port the host's `scripts/audit-preflight-dependency.ts` idea to a library playground page. **Verify in the playground, never in Nodestra**, because Nodestra ships its own preflight and masks exactly this class of bug (`OUTCOME.md §8`).
7. Identity hooks stay plain marker classes or data attributes (`data-efm="sidebar"`), never styled, as TL did with `.rbnt-timeline`.

### 5.5 Dependencies

- `dependencies`: `@headless-tree/core`, `@headless-tree/react` (^1.7.0, MIT, 0 deps, ~12.6 kB gz per the file-library plan), `@radix-ui/react-context-menu` (^2.3.7, MIT, ~29 KB gz per the tabs plan), `clsx`, `tailwind-merge`. All are imported only by `./ui`, and `sideEffects` lets core consumers tree-shake them.
- `peerDependencies` (optional, ETB pattern): `react >=18`, `react-dom >=18`.
- `devDependencies`: `memfs` (tests), `jsdom` only if UI tests are added, `tailwindcss` + `@tailwindcss/vite` + `@vitejs/plugin-react` (TL pattern), `vite-plugin-dts`, `vitest`, `typescript ~5.9`, `prettier`.
- tsconfig `lib` must add `"DOM.AsyncIterable"` (N's tsconfig has it; ETB's does not), needed by `for await (… of dir.entries())`.

### 5.6 What stays app-side

Nodestra: project format (`appPersistence.ts` minus the journal helper), `projectSignature`'s transient-key list, the
timeline/host-state snapshot capture and history cap, `borrowCanvas/returnCanvas/detachForProbe` (built on a generic
`workspace.detach()` / `workspace.showTab(active)`), legacy-autosave migration, Q7/Q14 policies (via callbacks), Welcome
content (demos, tutorials, keymap), `AutoSaveControl` look (or adopt the library's), `nokey`, and the `STORAGE_NAMESPACE`.
watch-together: player, P2P/share session, `share` tab content, OPFS download job.

### 5.7 watch-together configuration (real example)

```tsx
import { createIndexedDbStore, createFileLibrary, extensionPolicy, defineTabKinds }
  from '@theclearsky/easy-folder-management-ui';
import { useWorkspace } from '@theclearsky/easy-folder-management-ui/react';
import { FileSidebar, TabStrip, TabPanels, WelcomeLayout, RecentList }
  from '@theclearsky/easy-folder-management-ui/ui';
import '@theclearsky/easy-folder-management-ui/styles.css';

const library = createFileLibrary({
  store: createIndexedDbStore('watch-together.library'),
  policy: extensionPolicy({
    openable: ['.mp4', '.webm', '.mkv', '.mov', '.m4v'],
    content: 'binary',                 // never .text() a video; unlink/undo skip big blobs
  }),
  access: 'read',                      // the picker asks READ only; no rename/move/delete UI
  browserStore: 'opfs',                // "Save a copy" of a received stream lands in OPFS
  watch: 'observer',                   // FileSystemObserver where present, focus re-scan otherwise
});

const kinds = defineTabKinds({
  welcome: { singleton: true, persist: 'key', label: () => 'Welcome' },
  file:    { persist: 'path', label: (id, { library }) => library.tree.nodes[id]?.name ?? 'Missing video',
             previewOnSingleClick: true },
  share:   { persist: false, label: (peer, { room }) => `${room.nameOf(peer)}'s screen`,
             status: (peer, { room }) => (room.isLive(peer) ? 'ok' : 'ended'),
             beforeClose: async () => window.confirm('Stop watching this stream?') },
});

function Shell() {
  const ws = useWorkspace({ library, kinds, documents: playerAdapter /* load: getFile → objectURL */ });
  return (
    <div className="flex h-screen">
      <FileSidebar workspace={ws} labels={{ title: 'Videos', empty: 'Link a folder of videos' }} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TabStrip workspace={ws} panelId="player" />
        <TabPanels workspace={ws} keepMounted={3} render={(tab) =>
          tab.kind === 'welcome' ? <Welcome ws={ws} /> :
          tab.kind === 'file'    ? <VideoPlayer file={tab.key} /> :
                                   <RemoteStream peer={tab.key} />} />
      </div>
    </div>
  );
}
// Playing a 4 GB file: const f = await library.getFile(id); video.src = URL.createObjectURL(f);  // revoke on close
// Saving a received copy: await library.createFile(rootId, 'movie.mp4', incomingReadableStream);
```

### 5.8 Nodestra migration (before → after)

```tsx
// BEFORE (App.tsx:440-453, 960-1003)
const session = useLibrarySession({ state, stateRef, installProject, silence: silenceForLibrary,
  newGraphState, bootShowedLegacyAutosave: bootLegacyAutosaveRef.current,
  confirmUnsaved: unsavedDialog.ask, onStartupOpened, showWelcomeOnStartup: readShowWelcome,
  onFirstVisit: () => { if (!readOffered()) setTutorialOffer(true); } });
<SidebarErrorBoundary resetKey={session.snapshot.mode.kind}>
  <FileSidebar snapshot={session.snapshot} activeFileId={session.activeFileId} /* …18 more */ />
</SidebarErrorBoundary>
<TabStrip order={session.tabs.order} active={session.tabs.active} label={session.tabName} /* …11 more */ />

// AFTER
const [library] = useState(() => createFileLibrary({
  store: createIndexedDbStore(`${STORAGE_NAMESPACE}.library`),   // SAME DB name ⇒ users keep their files
  policy: extensionPolicy({ openable: ['.json'], content: 'text', defaultExtension: '.json' }),
}));
const ws = useWorkspace({
  library,
  kinds: defineTabKinds({
    welcome: { singleton: true, persist: 'key', legacyIds: ['@welcome'], label: () => 'Welcome' },
    file: { persist: 'path', label: fileLabel },
  }),
  documents: nodestraDocuments({ stateRef, installProject, silence: silenceForLibrary, newGraphState }),
  //   load → deserializeProject; serialize → serializeProject(stateRef.current); signature → projectSignature;
  //   capture → {state (history capped 50), timeline: getTimelineStore().getDocument()};
  //   onFirstSaveOfWarnedFile → library.createFile(parent, `${stem} (original).json`, original)
  save: { defaults: { enabled: true, delaySeconds: 0.8 } },
  journal: sessionJournal(`${STORAGE_NAMESPACE}.journal.v2`),     // SAME key
  confirmUnsaved: unsavedDialog.ask, onStartupOpened, onFirstVisit, showWelcomeOnStartup: readShowWelcome,
});
const canvas = useCanvasLoan(ws);   // app-side: borrowCanvas / returnCanvas / detachForProbe on ws.detach()
<ErrorBoundary resetKey={ws.mode.kind}><FileSidebar workspace={ws} className="nokey"
  labels={{ title: 'Library', newFile: '＋ Graph', empty: 'No graphs yet. Create one with ＋ Graph, or pick a demo from the Demos menu.' }} /></ErrorBoundary>
<TabStrip workspace={ws} panelId="editor-panel" />
```

`useLibrarySession.ts` shrinks from 1,240 lines to roughly 250 (adapter + loan + legacy migration). `FileSidebar`,
`TabStrip`, `UnsavedChangesDialog`, `SidebarErrorBoundary`, `Toaster`, `EmptyEditor`, the tree, names, backends, store,
saveController and tabsModel all leave the app.

---

## 6. Risks and hard parts

| # | risk | why it is hard | mitigation |
|---|---|---|---|
| R1 | **The orchestration has no unit tests.** `useLibrarySession` (1,240 LOC) encodes about 20 data-loss fixes (A1 queue deadlock, C1 signature baseline, C2 buffer restore, B2/B3/B4/B6/B7 journal, D2 conflict, E1 picker-before-confirm, E3 buffers on link, E6 unsupported stays unwritable, FB-28 permission inside the click, L6/L16/L23 boot) that were verified only live in Chrome | moving it into a library without tests is how these regress silently | make `Workspace` a framework-free class FIRST (in Nodestra) and port each live-verified scenario (`file-library.md:144-159`) to a node test with a fake adapter + memfs: THE RACE (edit A, switch < 150 ms), superseded open, close→Don't save, link discards buffers, reconnect permission ordering, reload-in-save-window journal |
| R2 | **Text-only I/O** (`readText/writeText`, `arrayBuffer` copy `backends.ts:190`, unlink → IDB strings `graphLibrary.ts:392-405`, undo keeps text `:554`) | videos would be loaded into RAM or IDB | binary `getFile/write(WriteData)`, streaming `pipeTo` copies, policy-gated unlink/undo (§5.2). Add memfs tests of a large streamed copy |
| R3 | **Host imports in UI** (`cn`, `FullGraphContextMenu`, `Button`, `SliderNumberInput`) | the library must not depend on `@theclearsky/react-blender-nodes` | own `cn`; the sidebar menu moves to Radix (which also fixes its missing a11y); `AutoSaveControl` gets its own slider/popover or stays app-side |
| R4 | **CSS moves from "app compiles our classes" to "library ships a sheet"** | today the unprefixed utilities only exist because N's `source('.')` scans `src/`. From `node_modules` they would vanish | prefixed shipped sheet (§5.4); verify in a standalone playground with a preflight oracle, not in Nodestra |
| R5 | **Global type augmentation** (`fileSystemAccess.d.ts`) | shipped in `.d.ts` it merges into every consumer's DOM types and can clash when TS adds the real declarations ("Subsequent property declarations must have the same type") | keep it internal: local `type PermissionCapable = FileSystemHandle & {…}` casts, so the public types reference only standard DOM |
| R6 | **Existing user data** | browsers hold DB `react-blender-nodes-sound.library` with keys `tree` (`{version:1,rootId,nodes}`), `file:<id>`, `folderHandle`, `activeFile`, `openTabs` (`{order:[{path}|{page:'@welcome'}],…}`), `initialized`; sessionStorage `…journal.v2`; localStorage `…library-initialized` | library defaults = these exact keys/formats; the tab codec reads legacy `{page:'@welcome'}`; add a fixture test with a captured real record |
| R7 | **Tab id scheme change** (`'@welcome'`/bare uuid → `kind:key`) | snapshots, buffers, SaveController ids and tab ids are the same strings today | keep SaveController keyed by NODE id and tabs by TabId; map with `file:` + nodeId inside the Workspace only |
| R8 | **Fast Refresh / hot swap** | `useMemo`-created stores were re-minted on hot updates ("Loading…" forever, timeline emptied) | library hooks create instances with `useState(() => …)`; Nodestra adds the new `dist/` to `reloadOnLinkedLibraryBuild` (`vite.config.ts:23`) |
| R9 | **Toaster singleton** (`Toaster.tsx:14-16`) | duplicate installs (ESM+CJS, or two versions) split the store | `createToaster()` instance + context; keep `showToast` as the app's own wrapper |
| R10 | **Test portability** | tests mutate memfs PROTOTYPES globally (`stripMove` deletes `move`, `withHiddenUrlFiles` patches `entries/keys`), deep-import `memfs/lib/fsa`, and rely on Node's global `DOMException` (`isNotFound`, `backends.ts:169-171`) | keep `environment: 'node'`, pin memfs ^4.79, keep the strip-to-stable-Chrome rule ("a test that passes only because the fake is more capable than the browser would be worse than no test", `libraryBackends.test.ts:5-8`) |
| R11 | **headless-tree stale ids** | it asks for ids from the previous structure and throws on `undefined` (crashed the whole app once) | keep `missingNode` placeholder (`FileSidebar.tsx:75-78, :182`), `pruneTreeState` (`:105-123`), the layout-effect rebuild (`:276-279`), and ship the error boundary |
| R12 | **Blocking `window.confirm/alert` in flows** (`useLibrarySession.ts:761, 802, 812, 844`) | not themable; UA-dependent | injectable `confirm`; IMPORTANT: Link must still open the picker BEFORE any confirm (E1, `:787-799`), and Reconnect must call `requestPermission` before any await (FB-28). Both are user-activation constraints, so document them as API contracts |
| R13 | **Read-only mode is new** | `link`/`folderPermission` hard-code readwrite (`graphLibrary.ts:345-348`, `backends.ts:633`) | `access` option threaded through picker `mode`, permission descriptor, `writable`, and UI disabling |
| R14 | **OPFS specifics** | `createWritable` on OPFS is not equally available everywhere (Safari historically only offered sync access handles in workers; verify current support); OPFS grants permission implicitly; no picker | `OpfsBackend` = `FolderBackend(await navigator.storage.getDirectory())` with capability detection; also `navigator.storage.persist()` + quota estimate for downloads |
| R15 | **Licensing** | the code lives in an AGPL-3.0-only app; MIT release requires that its author owns it all | the brief says Deepak is sole author. Confirm that no third-party contribution touched these files before the first public publish |
| R16 | Template drift | ETB's workflow comments still describe TL's `tsc -b` + `check-dist-types`/`check-dist-loads` while ETB runs one `check-dist.ts` (§7) | fix the comments in the new repo; add a CSS-exists check to check-dist |

### Extraction order (keeps Nodestra's 68 library/tabs tests meaningful at every step)

```
 step  where        what                                                        gate
 0     Nodestra     record baseline: the 5 test files, 68 cases green           test:unit
 1     Nodestra     FilePolicy param (default = today's JSON policy) through      same 68 green, unchanged files
                    names/tree/backends/graphLibrary; DB-name import removed
 2     Nodestra     binary I/O beside text (getFile, write(WriteData), stream     + new memfs tests
                    copy); policy-gated unlink/undo
 3     Nodestra     move rememberTabs/recallTabs → TabRecordStore; kind ids       graphLibrary tab tests adapted
                    internal to the session; legacy record fixture test           + fixture
 4     Nodestra     split useLibrarySession → framework-free Workspace +          NEW workspace tests for R1 list;
                    NodestraDocumentAdapter; hook becomes a thin wrapper          live re-verify plan §Outcome list
 5     new repo     scaffold from ETB (§7); BYTE-COPY core modules + their tests  library tests green, check-dist
                    (Deepak's "canonical texts byte-copied" rule), then rename
 6     new repo     UI: own cn, Radix sidebar menu, labels/icons props, efm:      playground + preflight oracle
                    prefix, styles.css, tokens; Welcome primitives
 7     Nodestra     consume via file:../easy-folder-management-ui; replace       the SAME 5 test files now run
                    src/library/*.ts + tabs/tabsModel.ts with RE-EXPORT SHIMS     against the package (contract tests)
                    (export * from the package); add dist to the reload plugin
 8     Nodestra     swap UI one at a time: Toaster → UnsavedChangesDialog →       live check per component
                    ErrorBoundary → TabStrip → FileSidebar → Welcome layout
 9     Nodestra     delete shims; keep adapter + legacy-data tests in-app         test:unit, build
 10    watch-together  consume; then Deepak hand-publishes 0.0.1 (the one         npm view
                    sanctioned bootstrap), all later versions via CI OIDC
```

Steps 1–4 happen in Nodestra so every refactor is checked by the existing tests and the live app BEFORE any code
crosses a package boundary. Step 7's shims make the untouched Nodestra test files prove the published code behaves like
the code they were written for.

---

## 7. Template facts — `easy-tutorial-builder`

**package.json (ETB):** `"name": "@theclearsky/easy-tutorial-builder"`, `"version": "0.0.1"`, `"license": "MIT"`,
`"author": "Deepak Prasad <TheClearSky@github.com>"`, `repository.url git+https://github.com/TheClearSky/easy-tutorial-builder.git`,
`keywords`, `"type": "module"`, `"sideEffects": false` (**the new lib must use `["**/*.css"]` like TL**), `exports` per subpath
`{ types: ./dist/<entry>/index.d.ts, import: ./dist/<entry>.js, require: ./dist/<entry>.cjs }` + `"./package.json"`,
`main/module/types` for `.`, `"files": ["dist", "CHANGELOG.md"]`, scripts
`build: "tsc -p tsconfig.json && vite build && node --experimental-strip-types scripts/check-dist.ts"`, `type-check`,
`test:unit: vitest run`, `test:unit:watch`, `pretty`, `pretty:check`; optional peers `react >=18`, `zod ^4.1.5` via
`peerDependenciesMeta`; `publishConfig { registry: https://registry.npmjs.org/, access: public }`; devDeps `@types/*`,
`jsdom`, `prettier`, `react`, `react-dom`, `typescript ~5.9.2`, `vite ^7.3.6`, `vite-plugin-dts ^4.5.4`, `vitest ^3.2.7`, `zod`.

**vite.config.ts (ETB):** `defineConfig` from `vitest/config`; `dts({ tsconfigPath, exclude: tests })`, per-file
declarations (not rolled); `build.lib.entry = { index, react, schema, remote }`, `formats: ['es','cjs']`,
`fileName: (format, entry) => `${entry}.${format === 'es' ? 'js' : 'cjs'}``; externals `react, react-dom,
react/jsx-runtime, zod`; `sourcemap: false`, `emptyOutDir: true`; `test.environment: 'node'`. No CSS, no React plugin.
**For the new lib add** (from TL `vite.config.ts`): `@vitejs/plugin-react`, `@tailwindcss/vite`,
`build.lib.cssFileName: 'styles'`, `resolve.dedupe: ['react','react-dom']`, externals for `@headless-tree/*`,
`@radix-ui/*`, `clsx`, `tailwind-merge`, and an `exports["./styles.css"]: "./dist/styles.css"` entry.

**tsconfig (ETB):** ES2022, `lib: ["ES2022","DOM","DOM.Iterable"]` (**add `DOM.AsyncIterable`**), bundler resolution,
`jsx: react-jsx`, strict, `noUnusedLocals/Parameters`, `isolatedModules`, `noEmit`, `types: ["node"]`.

**scripts/check-dist.ts:** for every `exports` entry, every condition's file must exist. Every `import` target is
dynamically imported in PLAIN NODE and must expose ≥1 export, so a module touching `window`/`document` at import time
fails (the SSR guard). It exits 1 on any failure. For the new lib: string targets (`./styles.css`) are already
existence-checked by the same loop. `./ui` must stay import-safe in Node (Radix and headless-tree are).

**.github/workflows/library-deploy.yml:** on push/PR to `main`. Job `build-library` (ubuntu-22.04,
`permissions: contents: read`, concurrency `ci-build-${{ github.ref }}` cancel-in-progress): checkout@v6 →
setup-node@v6 (24.x, npm cache) → `npm ci` → `npm run test:unit` → `npm run build`. Job `deploy-library`
(push to main only, `needs: build-library`, `environment: npm`, `permissions: contents: read, id-token: write`,
concurrency `deploy-npm-…` NOT cancelled): checkout → setup-node with `registry-url` → `npm ci` → build → "already
published?" step (`npm view "$NAME@$VERSION" version` → `exists=true` skips) → `npm publish --provenance --access public`
(OIDC trusted publishing, no token; the comments record that 0.0.1 is hand-published once because npm cannot register
a trusted publisher for a name that does not exist yet). **Stale comments**: the build step's comment mentions `tsc -b`,
`check-dist-types` and `check-dist-loads`, which are TL's scripts, not ETB's single `check-dist.ts`.

**README convention (ETB):** `# @theclearsky/<name>`, a one-line pitch, bold-lead bullet list of what is different,
"The inspiration:" credits, then "MIT. Core ~N KB gzip, with no dependencies. `react` and `zod` are optional peers.",
numbered usage sections (`## 1. Describe your app: a kit`, `## 2. …`, `## 3. Run it`, `## 4. …`), `## License` →
"MIT © 2026 Deepak Prasad". LICENSE is the MIT text, "Copyright (c) 2026 Deepak Prasad".

**CHANGELOG convention:** `# Changelog` → `## 0.0.1 — unreleased` → "First release." → feature bullets naming
exported APIs in backticks. TL/host CHANGELOGs also carry explicit **BREAKING** call-outs for CSS-surface changes,
the convention to follow when `efm:` classes or tokens change.

**.gitignore (ETB):** node_modules, dist, logs, `*.local`, `tsconfig.tsbuildinfo`, editor dirs, and working
artifacts not shipped: `test-results/`, `playwright-report/`, `.playwright-mcp/`, `.claude/`, `review/`, `verification/`.

**Repo state note:** the HANDOFF says ETB was "NOT published, no git", consumed by Nodestra via
`file:../easy-tutorial-builder`. Its `dist/` must be rebuilt after edits. The new lib will have the same workflow
until its 0.0.1 bootstrap publish.
