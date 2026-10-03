import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useParams } from "react-router";
import {
  canLinkFolders,
  childrenOf,
  isOpenableFile,
  parseTabId,
  pathOf,
  pickFolder,
  tabId,
} from "@theclearsky/easy-folder-management-ui";
import { useWorkspace } from "@theclearsky/easy-folder-management-ui/react";
import {
  accessChoice,
  confirmChoice,
  createToaster,
  EmptyState,
  FolderThemeProvider,
  FileSidebar,
  PanelErrorBoundary,
  TabStrip,
  Toaster,
  unlinkChoice,
  unlinkProgressView,
  useChoiceDialog,
} from "@theclearsky/easy-folder-management-ui/ui";
import "@theclearsky/easy-folder-management-ui/styles.css";
import { droppedVideos } from "./library/openedFiles";
import { createVideoWorkspace, videoPolicy } from "./library/videoWorkspace";
import { parseSubtitleText, sidecarsFor } from "./media/subtitleText";
import type { SubtitleTrackInput } from "./player/VideoPlayer";
import { VideoPlayer } from "./player/VideoPlayer";
import { RoomChat } from "./room/chat";
import { rememberAvatar, rememberName } from "./room/useRoom";
import { avatarSeed } from "./social/Avatar";
import { stageTheme } from "./theme/stageTheme";
import { Welcome } from "./welcome/Welcome";
import { ConnectionSettings } from "./room/ConnectionSettings";
import { RoomPanel } from "./room/RoomPanel";
import { ChatSection, SharesSection } from "./room/RoomSections";
import { ShareController } from "./share/shareController";
import type { ShareSnapshot } from "./share/shareController";
import { ShareTab } from "./share/ShareTab";
import { SubtitleRelay } from "./share/subtitleRelay";
import { Downloads } from "./transfer/downloads";
import type { TransferView } from "./transfer/downloads";
import { TransferRow } from "./transfer/TransferRow";
import { normalizeRoomCode } from "./room/roomCode";
import { canShare } from "./room/roomModel";
import { useWakeLock } from "./room/useWakeLock";
import { isTouchDevice } from "./player/fullscreen";
import { TutorialsButton } from "./tutorials/TutorialsButton";
import { useRoom } from "./room/useRoom";
import { isNumber, readPreference, writePreference } from "./storage";

const TOOLBAR_BUTTON =
  "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[13px] whitespace-nowrap text-primary-white hover:bg-secondary-dark-gray aria-pressed:bg-primary-dark-gray disabled:cursor-default disabled:opacity-40 pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-[15px]";

/** Below this width the library is a drawer over the content. */
const NARROW_QUERY = "(max-width: 767px)";

const toaster = createToaster();

const EMPTY_SHARES: ShareSnapshot = {
  shares: [],
  mine: [],
  streams: new Map(),
  controlPending: new Set(),
};
const EMPTY_CHAT = { lines: [], unread: 0 };
const EMPTY_TRANSFERS: readonly TransferView[] = [];
const noopSubscribe = () => () => {};

/** A player tab's source: what it plays, how it resumes, what it is called. */
type PlayerSource = {
  tabId: string;
  file: File;
  resumeKey: string;
  title: string;
  onNext?: () => void;
  subtitles?: SubtitleTrackInput[];
};

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function useMediaQuery(query: string): boolean {
  const subscribe = (listener: () => void) => {
    const list = matchMedia(query);
    list.addEventListener("change", listener);
    return () => list.removeEventListener("change", listener);
  };
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => false,
  );
}

function App() {
  const { code: linkCode } = useParams();
  const { session: room, snapshot: roomSnapshot } = useRoom();
  // An invite link's code, shown on the Welcome ticket as "You're invited".
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [roomPanelOpen, setRoomPanelOpen] = useState(false);
  // ONE library + workspace for the app's lifetime (useState, never useMemo).
  const [app] = useState(createVideoWorkspace);
  const { library, openVideo, openedFiles, prompts } = app;
  // Every library question (unlink keep/remove, deletes, link mode) goes
  // through one accessible dialog — never window.confirm.
  const dialog = useChoiceDialog();
  prompts.chooseUnlink = (plan) => dialog.ask(unlinkChoice(plan));
  prompts.confirm = async (request) =>
    (await dialog.ask(confirmChoice(request))) === "confirm";
  const [renameRequest, setRenameRequest] = useState<string | null>(null);
  const { workspace, snapshot } = useWorkspace(() => app.workspace);
  const video = useSyncExternalStore(
    openVideo.subscribe,
    openVideo.getSnapshot,
  );
  useSyncExternalStore(openedFiles.subscribe, openedFiles.getVersion);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [sidebarWanted, setSidebarWanted] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [volume, setVolume] = useState(() =>
    readPreference("volume", 0.8, isNumber),
  );
  const [muted, setMuted] = useState(false);
  const [subtitles, setSubtitles] = useState<SubtitleTrackInput[]>([]);
  const [dragging, setDragging] = useState(false);

  // Watching together rides on the room session: one share controller and
  // one chat per session.
  const [features, setFeatures] = useState<{
    shares: ShareController;
    chat: RoomChat;
    downloads: Downloads;
    subtitles: SubtitleRelay;
  } | null>(null);
  useEffect(() => {
    if (!room || features) return;
    const shareController = new ShareController(room);
    setFeatures({
      shares: shareController,
      chat: new RoomChat(room),
      downloads: new Downloads(room, shareController, library, app.workspace),
      subtitles: new SubtitleRelay(room, shareController),
    });
  }, [room, features, library, app.workspace]);
  const shares = features?.shares ?? null;
  const chat = features?.chat ?? null;
  const downloads = features?.downloads ?? null;
  const subtitleRelay = features?.subtitles ?? null;
  useSyncExternalStore(
    subtitleRelay?.subscribe ?? noopSubscribe,
    subtitleRelay?.getVersion ?? (() => 0),
  );
  const transfers = useSyncExternalStore(
    downloads?.subscribe ?? noopSubscribe,
    downloads?.getSnapshot ?? (() => EMPTY_TRANSFERS),
  );
  const shareSnapshot = useSyncExternalStore(
    shares?.subscribe ?? noopSubscribe,
    shares?.getSnapshot ?? (() => EMPTY_SHARES),
  );
  const chatSnapshot = useSyncExternalStore(
    chat?.subscribe ?? noopSubscribe,
    chat?.getSnapshot ?? (() => EMPTY_CHAT),
  );
  /** Players' elements by tab (sharing captures them). */
  const elements = useRef(new Map<string, HTMLVideoElement | null>());
  /** What a SHARED tab plays — kept even while another tab is shown (Q8). */
  const [sharedSources, setSharedSources] = useState<
    ReadonlyMap<string, PlayerSource>
  >(new Map());

  const tree = snapshot.library.tree;
  const active = snapshot.tabs.active ? parseTabId(snapshot.tabs.active) : null;
  const linked =
    snapshot.library.mode.kind === "folder" ||
    snapshot.library.mode.kind === "reconnect";
  const roomStatus = roomSnapshot?.status.kind ?? "idle";
  // Phones: keep the screen on while in (or joining) a room — a locked
  // screen suspends the page and the room disappears for everyone else.
  useWakeLock(
    (roomStatus === "in-room" || roomStatus === "waiting") && isTouchDevice(),
  );
  const requestCount = roomSnapshot?.requests.length ?? 0;
  // Leaving a room (status back to idle) closes the room panel/drawer.
  useEffect(() => {
    if (roomStatus === "idle") setRoomPanelOpen(false);
  }, [roomStatus]);

  // An invite link (#/room/<code>) opens the Join dialog with the code filled
  // in — unless you are already in that room (a reload resumes it).
  useEffect(() => {
    const code = linkCode ? normalizeRoomCode(linkCode) : null;
    if (!code || !roomSnapshot) return;
    if (roomSnapshot.code === code && roomSnapshot.status.kind !== "idle")
      return;
    setInviteCode(code);
    void workspace.openTab("welcome:");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per link, when the session is ready
  }, [linkCode, roomSnapshot === null]);

  // Someone asks to join: tell approvers wherever they are in the app — and
  // take the toast away the moment the request is decided (by anyone) or
  // withdrawn, so a stale toast never sits over the room panel.
  const [requestToasts] = useState(() => new Map<string, number>());
  useEffect(() => {
    const pending = new Set(
      (roomSnapshot?.requests ?? []).map((request) => request.memberId),
    );
    for (const request of roomSnapshot?.requests ?? []) {
      if (requestToasts.has(request.memberId)) continue;
      const id = toaster.show({
        message: `🔔 ${request.name} wants to join the room`,
        action: { label: "Review", run: () => setRoomPanelOpen(true) },
        timeoutMs: 60_000,
      });
      requestToasts.set(request.memberId, id);
    }
    for (const [memberId, id] of requestToasts) {
      if (pending.has(memberId)) continue;
      toaster.dismiss(id);
      requestToasts.delete(memberId);
    }
  }, [roomSnapshot?.requests, requestToasts]);

  // One click each: the Welcome ticket hands over the (prefilled, editable)
  // name, face and room code.
  const createRoom = async (
    profile: { name: string; avatar: number },
    code: string,
  ) => {
    if (!room) return;
    rememberName(profile.name);
    rememberAvatar(profile.avatar);
    await room.rename(profile.name, profile.avatar);
    await room.create(code);
  };
  const joinRoom = async (
    profile: { name: string; avatar: number },
    code: string,
  ) => {
    if (!room) return;
    rememberName(profile.name);
    rememberAvatar(profile.avatar);
    setInviteCode(null);
    await room.rename(profile.name, profile.avatar);
    await room.join(code);
  };
  /** Rooms start on the Welcome page's ticket. */
  const goToTicket = () => {
    void workspace.openTab("welcome:");
    if (narrow) setDrawerOpen(false);
  };
  const sidebarVisible = narrow ? drawerOpen : sidebarWanted;

  // Sidecar subtitles next to a folder video (ep01.srt, ep01.en.vtt…).
  useEffect(() => {
    setSubtitles([]);
    if (!video) return;
    const node = tree.nodes[video.fileId];
    if (!node) return;
    const siblings = childrenOf(tree, node.parentId ?? tree.rootId).map(
      (id) => tree.nodes[id],
    );
    const names = sidecarsFor(
      node.name,
      siblings.map((sibling) => sibling.name),
    );
    let cancelled = false;
    void Promise.all(
      siblings
        .filter((sibling) => names.includes(sibling.name))
        .map(async (sibling) => ({
          id: sibling.id,
          label: sibling.name,
          cues: parseSubtitleText(
            await (await library.getFile(sibling.id)).text(),
          ),
        })),
    ).then((tracks) => {
      if (!cancelled)
        setSubtitles(tracks.filter((track) => track.cues.length > 0));
    });
    return () => {
      cancelled = true;
    };
  }, [video, tree, library]);

  // A remembered opened file lives while its tab is open or reopenable;
  // anything else is forgotten once both stores have loaded.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([workspace.boot(), openedFiles.whenReady()]).then(() => {
      if (cancelled) return;
      const { order, closed } = workspace.getSnapshot().tabs;
      const keep = new Set(
        [...order, ...closed]
          .map((id) => parseTabId(id))
          .filter((p) => p?.kind === "opened")
          .map((p) => p!.key),
      );
      for (const id of openedFiles.ids())
        if (!keep.has(id)) void openedFiles.forget(id);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, openedFiles]);

  /** The next openable file in the same folder, by name. */
  const nextFileId = (() => {
    if (!video) return null;
    const node = tree.nodes[video.fileId];
    if (!node) return null;
    const siblings = childrenOf(tree, node.parentId ?? tree.rootId)
      .map((id) => tree.nodes[id])
      .filter((sibling) => isOpenableFile(sibling, videoPolicy));
    const index = siblings.findIndex((sibling) => sibling.id === node.id);
    return siblings[index + 1]?.id ?? null;
  })();

  const openIds = async (ids: string[]) => {
    for (const id of ids) await workspace.openTab(tabId("opened", id));
    if (narrow) setDrawerOpen(false);
  };

  // Both pickers need the click's user activation: call them FIRST.
  const openVideoFile = () => void openedFiles.pick().then(openIds);
  const linkFolder = async () => {
    // Read-only or read & write? (The owner: "even that should ask, when
    // clicking link folder".) The picker then runs from the dialog button's
    // click, which still counts as the user's gesture.
    const access = await dialog.ask(accessChoice());
    if (access === "cancel") return;
    try {
      const handle = await pickFolder({ access, id: "watch-together-videos" });
      if (!handle) return;
      await workspace.link(handle, { access });
      if (narrow) setDrawerOpen(true);
    } catch (error) {
      toaster.show({
        message: String(error instanceof Error ? error.message : error),
      });
    }
  };

  const unlinkFolder = () => {
    void workspace
      .unlink({
        onProgress: (progress) =>
          dialog.showProgress(
            unlinkProgressView(progress, () => workspace.cancelUnlink()),
          ),
      })
      .finally(() => dialog.showProgress(null));
  };

  /** A file from the in-browser library, handed to the browser's downloads. */
  const saveToDevice = async (fileId: string) => {
    const file = await library.getFile(fileId);
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const changeVolume = (next: number, nextMuted: boolean) => {
    setVolume(next);
    setMuted(nextMuted);
    writePreference("volume", next);
  };

  const openedEntry =
    active?.kind === "opened" ? openedFiles.get(active.key) : undefined;

  // ── sharing ───────────────────────────────────────────────────────────
  const shareOf = (tabIdValue: string) =>
    shareSnapshot.mine.find((share) => share.tabId === tabIdValue) ?? null;

  // My shares' sources follow the tabs they live in; a share that ended
  // releases its source.
  useEffect(() => {
    setSharedSources((current) => {
      const live = new Set(shareSnapshot.mine.map((share) => share.tabId));
      if ([...current.keys()].every((key) => live.has(key))) return current;
      return new Map([...current].filter(([key]) => live.has(key)));
    });
  }, [shareSnapshot.mine]);

  const startSharing = (source: PlayerSource) => {
    if (!shares) return;
    if (roomStatus !== "in-room") {
      toaster.show({
        message: "Create or join a room first, then share.",
        action: { label: "Start a room", run: goToTicket },
      });
      return;
    }
    const shareId = shares.startShare({
      tabId: source.tabId,
      title: source.title,
      element: elements.current.get(source.tabId) ?? null,
      file: source.file,
    });
    if (!shareId) {
      toaster.show({ message: "The room owner has not allowed you to share." });
      return;
    }
    setSharedSources((current) => new Map(current).set(source.tabId, source));
  };

  /** Next file in a SHARED tab: the share moves with it (same viewers). */
  const goNext = (fromTabId: string, nextId: string) => {
    const share = shareOf(fromTabId);
    void workspace.openFile(nextId).then(() => {
      if (!share || !shares) return;
      const nextTab = tabId("file", nextId);
      shares.retargetShare(share.shareId, nextTab);
      setSharedSources((current) => {
        const next = new Map(current);
        next.delete(fromTabId);
        return next;
      });
    });
  };

  // Toasts: a new share in the room; someone asking me for control. A share's
  // toast goes away once you are watching it (from anywhere — the toast, the
  // room panel, the Welcome page) or the share ends.
  const [shareToasts] = useState(() => new Map<string, number>());
  const watchingShare = active?.kind === "share" ? active.key : null;
  useEffect(() => {
    for (const view of shareSnapshot.shares) {
      if (
        shareToasts.has(view.shareId) ||
        view.ended ||
        view.shareId === watchingShare
      )
        continue;
      const id = toaster.show({
        message: `📡 ${view.sharerName} is sharing “${view.title}”`,
        action: {
          label: "Watch",
          run: () => void workspace.openTab(tabId("share", view.shareId)),
        },
        timeoutMs: 15_000,
      });
      shareToasts.set(view.shareId, id);
    }
    for (const [shareId, id] of shareToasts) {
      const view = shareSnapshot.shares.find(
        (share) => share.shareId === shareId,
      );
      if (shareId === watchingShare || !view || view.ended) toaster.dismiss(id);
    }
  }, [shareSnapshot.shares, shareToasts, workspace, watchingShare]);
  useEffect(() => {
    if (!downloads) return;
    downloads.onRequest = (transfer) =>
      toaster.show({
        message: `⬇ ${transfer.peerName} wants a copy of “${transfer.name}” (${formatSize(transfer.size)})`,
        action: { label: "Allow", run: () => downloads.accept(transfer.id) },
        timeoutMs: 60_000,
      });
    downloads.onSaved = (transfer) =>
      toaster.show({
        message: `Saved “${transfer.name}” to your library`,
        action: transfer.fileId
          ? {
              label: "Open",
              run: () => void workspace.openFile(transfer.fileId!),
            }
          : undefined,
      });
    return () => {
      downloads.onRequest = null;
      downloads.onSaved = null;
    };
  }, [downloads, workspace]);
  useEffect(() => {
    if (!shares) return;
    shares.onControlRequest = (shareId, memberId, name) =>
      toaster.show({
        message: `✋ ${name} asks to control your shared video`,
        action: {
          label: "Allow",
          run: () => shares.grantControl(shareId, memberId),
        },
        timeoutMs: 30_000,
      });
    return () => {
      shares.onControlRequest = null;
    };
  }, [shares]);

  // The active tab's player source.
  const activeTabId = snapshot.tabs.active;
  let activeSource: PlayerSource | null = null;
  if (activeTabId && active?.kind === "file" && video) {
    activeSource = {
      tabId: activeTabId,
      file: video.file,
      resumeKey: video.path,
      title: tree.nodes[video.fileId]?.name ?? "Video",
      onNext: nextFileId ? () => goNext(activeTabId, nextFileId) : undefined,
      subtitles,
    };
  } else if (activeTabId && active?.kind === "opened" && openedEntry?.file) {
    activeSource = {
      tabId: activeTabId,
      file: openedEntry.file,
      resumeKey: `opened:${openedEntry.name}:${openedEntry.size}`,
      title: openedEntry.name,
    };
  }
  // Every player that must exist: the active one, plus every tab I share —
  // a shared tab keeps playing for everyone while I look at another (Q8).
  const playerSources: PlayerSource[] = [];
  if (activeSource) {
    // Coming back to a tab I share: keep ITS File object — a freshly loaded
    // one would reload the video (and restart it for everyone watching).
    const shared = sharedSources.get(activeSource.tabId);
    playerSources.push(
      shared
        ? { ...activeSource, file: shared.file, resumeKey: shared.resumeKey }
        : activeSource,
    );
  }
  for (const [key, source] of sharedSources)
    if (key !== activeSource?.tabId) playerSources.push(source);

  const shareControls = (source: PlayerSource) => {
    const share = shareOf(source.tabId);
    if (share) {
      return (
        <span className="flex items-center gap-1">
          <span className="rounded bg-status-errored/80 px-1.5 py-0.5 text-[11px] text-white pointer-coarse:text-[13px]">
            📡 Sharing
            {share.streamViewers > 0 ? ` · ${share.streamViewers}` : ""}
          </span>
          <button
            type="button"
            aria-label="Stop sharing"
            className="h-9 cursor-pointer rounded px-2 text-[13px] hover:bg-white/10 pointer-coarse:h-11"
            onClick={() => shares?.stopShare(share.shareId)}
          >
            ■
          </button>
        </span>
      );
    }
    return (
      <button
        type="button"
        aria-label="Share with the room"
        title={
          roomStatus === "in-room"
            ? "Share this video with the room"
            : "Create or join a room to share"
        }
        className="h-9 cursor-pointer rounded px-2 text-[13px] whitespace-nowrap hover:bg-white/10 pointer-coarse:h-11 pointer-coarse:text-[15px]"
        onClick={() => startSharing(source)}
      >
        📡<span className="max-sm:hidden"> Share</span>
      </button>
    );
  };

  const renderPlayer = (source: PlayerSource) => (
    <VideoPlayer
      key={source.tabId}
      file={source.file}
      resumeKey={source.resumeKey}
      active={source.tabId === activeTabId}
      volume={volume}
      muted={muted}
      onVolumeChange={changeVolume}
      subtitles={source.subtitles}
      onNext={source.onNext}
      extraControls={shareControls(source)}
      onElement={(element) => {
        elements.current.set(source.tabId, element);
        const share = shareOf(source.tabId);
        if (share && element)
          shares?.updateSource(
            share.shareId,
            element,
            source.file,
            source.title,
          );
      }}
      onSubtitles={(payload) =>
        subtitleRelay?.setTabSubtitles(source.tabId, payload)
      }
    />
  );

  const welcome = (
    <Welcome
      session={room}
      snapshot={roomSnapshot}
      inviteCode={roomStatus === "idle" ? inviteCode : null}
      onDismissInvite={() => setInviteCode(null)}
      onCreate={(profile, code) => void createRoom(profile, code)}
      onJoin={(profile, code) => void joinRoom(profile, code)}
      onOpenRoom={() => setRoomPanelOpen(true)}
      onOpenConnection={() => setConnectionOpen(true)}
      shares={shareSnapshot.shares
        .filter((share) => !share.ended)
        .map((share) => ({
          shareId: share.shareId,
          title: share.title,
          sharerName: share.sharerName,
          sharerSeed: avatarSeed(room?.avatarOf(share.sharer), share.sharer),
        }))}
      onWatch={(shareId) => void workspace.openTab(tabId("share", shareId))}
      onOpenVideo={openVideoFile}
      onLinkFolder={() => void linkFolder()}
      canLinkFolders={canLinkFolders()}
      recent={snapshot.recentFiles
        .filter((id) => tree.nodes[id])
        .map((id) => ({
          id,
          name: tree.nodes[id].name,
          detail: pathOf(tree, id).slice(0, -1).join("/"),
        }))}
      onOpenRecent={(id) => void workspace.openFile(id)}
      onNotice={(message) => toaster.show({ message })}
    />
  );

  // Tutorials offered for where you are (never started on their own — D4).
  const tutorialContext = {
    page:
      active?.kind === "welcome"
        ? "welcome"
        : activeSource
          ? "video"
          : active?.kind === "share"
            ? "share"
            : "empty",
    inRoom: roomStatus === "in-room",
    isOwner:
      !!roomSnapshot?.room &&
      roomSnapshot.room.owner === roomSnapshot.me.memberId,
    canShare:
      !!roomSnapshot?.room &&
      canShare(roomSnapshot.room, roomSnapshot.me.memberId),
    hasFolder: linked,
    narrow,
  } as const;

  let content;
  if (active?.kind === "welcome") content = welcome;
  else if (activeSource)
    content = null; // rendered by the player list below
  else if (active?.kind === "share" && shares) {
    content = (
      <ShareTab
        key={active.key}
        shareId={active.key}
        shares={shares}
        library={library}
        openedFiles={openedFiles}
        volume={volume}
        muted={muted}
        onVolumeChange={changeVolume}
        remoteSubtitles={subtitleRelay?.subtitlesFor(active.key) ?? null}
        onRequestSubtitles={() => subtitleRelay?.request(active.key)}
        extraControls={
          downloads && (
            <span className="flex items-center gap-1">
              {transfers
                .filter(
                  (transfer) =>
                    transfer.direction === "in" &&
                    transfer.shareId === active.key,
                )
                .slice(-1)
                .map((transfer) => (
                  <TransferRow
                    key={transfer.id}
                    transfer={transfer}
                    downloads={downloads}
                    compact
                  />
                ))}
              <button
                type="button"
                aria-label="Save a copy"
                title={
                  downloads.canSave()
                    ? linked
                      ? "Save a copy of this video into your linked folder"
                      : "Save a copy of this video in this browser (then on to your device if you like)"
                    : "Your library is not available right now"
                }
                disabled={
                  !downloads.canSave() ||
                  transfers.some(
                    (transfer) =>
                      transfer.direction === "in" &&
                      transfer.shareId === active.key &&
                      (transfer.status === "asking" ||
                        transfer.status === "transferring"),
                  )
                }
                className="cursor-pointer rounded px-3 py-1.5 text-[13px] whitespace-nowrap hover:bg-white/10 disabled:cursor-default disabled:opacity-40 pointer-coarse:py-2.5 pointer-coarse:text-[15px]"
                onClick={() => void downloads.request(active.key)}
              >
                ⬇<span className="max-sm:hidden"> Save a copy</span>
              </button>
            </span>
          )
        }
      />
    );
  } else if (active?.kind === "opened") {
    content = (
      <EmptyState
        icon="🎞"
        title={
          openedEntry
            ? `“${openedEntry.name}” needs to be opened again`
            : "This video is gone"
        }
        rows={
          openedEntry
            ? [
                {
                  label: "Open it again",
                  hint: openedEntry.handle ? "one click" : "pick the file",
                  onClick: () => void openedFiles.reopen(openedEntry.id),
                },
              ]
            : []
        }
      />
    );
  } else if (snapshot.openFailure) {
    content = (
      <EmptyState
        icon="⚠"
        title={`${snapshot.openFailure.name}: ${snapshot.openFailure.detail}`}
        rows={[]}
      />
    );
  } else {
    content = (
      <EmptyState
        icon="▶"
        rows={[
          {
            label: "Open a video file",
            hint: "any browser",
            onClick: openVideoFile,
          },
          {
            label: "Open Welcome",
            hint: "rooms, recent videos",
            onClick: () => void workspace.openTab("welcome:"),
          },
        ]}
      />
    );
  }

  const sidebar = (
    <PanelErrorBoundary resetKey={snapshot.library.mode.kind}>
      <div
        className={`flex min-h-0 flex-col bg-secondary-black ${narrow ? "h-full w-[min(320px,86vw)] shadow-2xl" : "h-full"}`}
      >
        <button
          type="button"
          onClick={openVideoFile}
          className="flex flex-none cursor-pointer items-center gap-2 border-b border-secondary-dark-gray px-3 py-2.5 text-left text-[13px] text-accent transition-colors hover:bg-white/[0.04] pointer-coarse:py-3.5 pointer-coarse:text-[15px]"
        >
          🎞 Open a video file…
        </button>
        <FileSidebar
          className="h-full min-h-0 flex-1"
        snapshot={snapshot.library}
        policy={videoPolicy}
        activeFileId={snapshot.activeFileId}
        readOnly={snapshot.readOnly}
        folderActionsDisabled={snapshot.folderActionsDisabled}
        canLinkFolders={canLinkFolders()}
        previewOnClick={!narrow}
        onOpen={(id, { preview }) => {
          void workspace.openFile(id, { preview });
          if (narrow) setDrawerOpen(false);
        }}
        onLink={() => void linkFolder()}
        onUnlink={unlinkFolder}
        onReconnect={(access) =>
          void workspace.reconnect(access ? { access } : undefined)
        }
        access={snapshot.library.folderAccess}
        showAccessTag
        onChangeAccess={(access) => void workspace.setFolderAccess(access)}
        onNewFolder={(parentId) =>
          void library
            .createFolder(parentId, "New folder")
            .then((id) => setRenameRequest(id))
            .catch((error: unknown) =>
              toaster.show({
                message: String(error instanceof Error ? error.message : error),
              }),
            )
        }
        onRename={(id, name) => void workspace.rename(id, name)}
        onMove={(ids, target) => void workspace.move(ids, target)}
        onDelete={(ids) => void workspace.remove(ids)}
        onUndoDelete={() => void workspace.undoDelete()}
        renameRequest={renameRequest}
        onRenameRequestHandled={() => setRenameRequest(null)}
        contextActions={(ids) =>
          snapshot.library.mode.kind === "memory" &&
          ids.length === 1 &&
          tree.nodes[ids[0]]?.kind === "file"
            ? [
                {
                  id: "save",
                  label: "Save to device…",
                  onSelect: () => void saveToDevice(ids[0]),
                },
              ]
            : []
        }
        onDismissError={() => library.dismissError()}
        onDismissNotice={() => library.dismissNotice()}
        strings={{
          title: "Videos",
          inBrowser: "In this browser",
          inBrowserTitle:
            "Videos kept in this browser (saved copies, or kept after unlinking). Linking a folder is optional.",
          linkFolder: "Link folder…",
          linkFolderTitle:
            "Optional: use a folder of videos on this computer (you choose read-only or read & write)",
          unlinkTitle: "Stop using this folder",
          inert: "Not a video",
          empty: canLinkFolders()
            ? "Nothing here yet. Use “Open a video file” above, or link a folder to browse all its videos. Copies you save from a share also land here."
            : "Nothing here yet. Use “Open a video file” above. Copies you save from a share also land here. (Linking a whole folder needs Chrome or Edge on a computer.)",
        }}
        />
      </div>
    </PanelErrorBoundary>
  );

  return (
    <FolderThemeProvider theme={stageTheme}>
      <Toaster store={toaster}>
        <div
          className="flex h-dvh flex-col"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragging(false);
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDragging(false);
            void droppedVideos(event.dataTransfer).then(async (items) => {
              if (items.length === 0) {
                toaster.show({ message: "Only video files can be opened." });
                return;
              }
              await openIds(await openedFiles.add(items));
            });
          }}
        >
          <header className="flex flex-none items-center gap-1 border-b border-secondary-dark-gray bg-secondary-black px-2 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] sm:gap-2 sm:px-3">
            <button
              type="button"
              className={TOOLBAR_BUTTON}
              aria-pressed={sidebarVisible}
              aria-label="Library"
              onClick={() =>
                narrow
                  ? setDrawerOpen((open) => !open)
                  : setSidebarWanted((open) => !open)
              }
            >
              ☰<span className="max-sm:hidden">Library</span>
            </button>
            <button
              type="button"
              className={TOOLBAR_BUTTON}
              aria-pressed={snapshot.tabs.active === "welcome:"}
              aria-label="Welcome"
              onClick={() => void workspace.openTab("welcome:")}
            >
              🏠<span className="max-sm:hidden">Welcome</span>
            </button>
            <button
              type="button"
              className={TOOLBAR_BUTTON}
              aria-label="Open a video file"
              onClick={openVideoFile}
            >
              🎞<span className="max-sm:hidden">Open</span>
            </button>
            <span className="min-w-0 flex-1 truncate px-1 text-[13px] text-primary-light-gray max-sm:hidden">
              {snapshot.activeFileName ?? openedEntry?.name ?? ""}
            </span>
            <span className="flex-1 sm:hidden" />
            <button
              type="button"
              className={`${TOOLBAR_BUTTON} relative`}
              aria-pressed={roomPanelOpen}
              aria-label={
                roomStatus === "in-room"
                  ? `Room ${roomSnapshot?.code}, ${roomSnapshot?.online.size} here`
                  : "Room"
              }
              disabled={!room}
              onClick={() => {
                if (roomStatus === "idle") goToTicket();
                else setRoomPanelOpen((open) => !open);
              }}
            >
              {roomStatus === "in-room" ? (
                <>
                  <span className="text-status-completed">●</span>
                  <span className="max-w-36 truncate max-sm:hidden">
                    {roomSnapshot?.code}
                  </span>
                  <span className="text-primary-light-gray">
                    · {roomSnapshot?.online.size}
                  </span>
                </>
              ) : roomStatus === "waiting" || roomStatus === "connecting" ? (
                <>
                  ⏳<span className="max-sm:hidden">Joining…</span>
                </>
              ) : (
                <>
                  ◎<span className="max-sm:hidden">Room</span>
                </>
              )}
              {requestCount > 0 ? (
                <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-status-warning px-1 text-[11px] font-bold text-black">
                  {requestCount}
                </span>
              ) : (
                chatSnapshot.unread > 0 &&
                !roomPanelOpen && (
                  <span
                    aria-label={`${chatSnapshot.unread} unread messages`}
                    className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-primary-black"
                  >
                    {chatSnapshot.unread}
                  </span>
                )
              )}
            </button>
            <TutorialsButton context={tutorialContext} />
          </header>

          <div className="relative flex min-h-0 flex-1">
            {!narrow && sidebarVisible && sidebar}
            {narrow && drawerOpen && (
              <div
                className="absolute inset-0 z-50 flex"
                role="dialog"
                aria-label="Library"
              >
                {sidebar}
                <button
                  type="button"
                  aria-label="Close library"
                  className="flex-1 cursor-default bg-black/50"
                  onClick={() => setDrawerOpen(false)}
                />
              </div>
            )}

            <div className="flex min-w-0 flex-1 flex-col">
              <TabStrip
                order={snapshot.tabs.order}
                active={snapshot.tabs.active}
                preview={snapshot.tabs.preview}
                label={(id) => {
                  const parsed = parseTabId(id);
                  if (parsed?.kind === "share") {
                    const view = shares?.view(parsed.key);
                    return view
                      ? `${view.title} — ${view.sharerName}`
                      : "Shared video";
                  }
                  return workspace.label(id);
                }}
                status={(id) => {
                  if (workspace.isTabMissing(id)) return "missing";
                  const parsed = parseTabId(id);
                  if (parsed?.kind === "share") {
                    const view = shares?.view(parsed.key);
                    return !view || view.ended
                      ? "ended"
                      : view.lost
                        ? "loading"
                        : "ok";
                  }
                  return parsed?.kind === "opened" &&
                    !openedFiles.get(parsed.key)?.file
                    ? "ended"
                    : "ok";
                }}
                renderIcon={(id) => {
                  const kind = parseTabId(id)?.kind;
                  if (shareOf(id)) return "📡";
                  return kind === "opened"
                    ? "🎞"
                    : kind === "share"
                      ? "🔗"
                      : null;
                }}
                onActivate={(id) => void workspace.activateTab(id)}
                onClose={(ids) => {
                  // Closing a tab I share stops the share.
                  for (const id of ids) {
                    const share = shareOf(id);
                    if (share) shares?.stopShare(share.shareId);
                  }
                  void workspace.closeTabs(ids);
                }}
                onReorder={(id, toIndex) => workspace.reorderTab(id, toIndex)}
                onPromote={(id) => workspace.promoteTab(id)}
                onCloseOthers={(id) => void workspace.closeOtherTabs(id)}
                onCloseRight={(id) => void workspace.closeTabsToTheRight(id)}
                onCloseAll={() => void workspace.closeAllTabs()}
                onReopen={() => void workspace.reopenClosedTab()}
                panelId="content"
              />
              <div
                id="content"
                role="tabpanel"
                className="relative min-h-0 flex-1"
              >
                {content}
                {playerSources.map((source) => (
                  <div
                    key={source.tabId}
                    className="absolute inset-0"
                    hidden={source.tabId !== activeTabId}
                  >
                    {renderPlayer(source)}
                  </div>
                ))}
              </div>
            </div>

            {roomPanelOpen && room && roomSnapshot && (
              <div className={narrow ? "absolute inset-0 z-50 flex" : "flex"}>
                <RoomPanel
                  session={room}
                  snapshot={roomSnapshot}
                  onClose={() => setRoomPanelOpen(false)}
                  sharing={
                    shares && (
                      <SharesSection
                        shares={shares}
                        downloads={downloads}
                        nameOf={(memberId) => room.nameOf(memberId)}
                        onWatch={(shareId) => {
                          void workspace.openTab(tabId("share", shareId));
                          if (narrow) setRoomPanelOpen(false);
                        }}
                        onGoToTab={(tabIdValue) => {
                          void workspace.activateTab(tabIdValue);
                          if (narrow) setRoomPanelOpen(false);
                        }}
                      />
                    )
                  }
                  chat={
                    chat && (
                      <ChatSection
                        chat={chat}
                        seedOf={(id) => avatarSeed(room?.avatarOf(id), id)}
                      />
                    )
                  }
                  onOpenConnection={() => setConnectionOpen(true)}
                  confirmRemove={async (name) =>
                    (await dialog.ask({
                      title: `Remove ${name} from the room?`,
                      body: "They are disconnected and can’t ask to join this room again.",
                      choices: [
                        { id: "confirm", label: "Remove", tone: "danger" },
                        { id: "cancel", label: "Cancel", tone: "neutral" },
                      ],
                    })) === "confirm"
                  }
                />
              </div>
            )}

            {dragging && (
              <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/15 text-[18px]">
                Drop videos to open them
              </div>
            )}
          </div>
        </div>
        {dialog.element}
        {connectionOpen && (
          <ConnectionSettings
            inRoom={roomStatus === "in-room"}
            onClose={() => setConnectionOpen(false)}
          />
        )}
      </Toaster>
    </FolderThemeProvider>
  );
}

export { App };
