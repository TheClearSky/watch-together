import { useEffect, useState, useSyncExternalStore } from 'react';
import { useParams } from 'react-router';
import {
  canLinkFolders,
  childrenOf,
  isOpenableFile,
  parseTabId,
  pathOf,
  pickFolder,
} from '@theclearsky/easy-folder-management-ui';
import { useWorkspace } from '@theclearsky/easy-folder-management-ui/react';
import {
  createToaster,
  EmptyState,
  FileSidebar,
  PanelErrorBoundary,
  RecentList,
  TabStrip,
  Toaster,
  WelcomeAction,
  WelcomeLayout,
  WelcomeSection,
} from '@theclearsky/easy-folder-management-ui/ui';
import '@theclearsky/easy-folder-management-ui/styles.css';
import { createVideoWorkspace, videoPolicy } from './library/videoWorkspace';
import { parseSubtitleText, sidecarsFor } from './media/subtitleText';
import type { SubtitleTrackInput } from './player/VideoPlayer';
import { VideoPlayer } from './player/VideoPlayer';
import { isNumber, readPreference, writePreference } from './storage';

const TOOLBAR_BUTTON =
  'cursor-pointer rounded px-2 py-1 text-[13px] text-primary-white hover:bg-secondary-dark-gray aria-pressed:bg-primary-dark-gray disabled:cursor-default disabled:opacity-40';

const toaster = createToaster();

function App() {
  const { code } = useParams();
  // ONE library + workspace for the app's lifetime (useState, never useMemo).
  const [app] = useState(createVideoWorkspace);
  const { library, openVideo } = app;
  const { workspace, snapshot } = useWorkspace(() => app.workspace);
  const video = useSyncExternalStore(openVideo.subscribe, openVideo.getSnapshot);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [volume, setVolume] = useState(() => readPreference('volume', 0.8, isNumber));
  const [muted, setMuted] = useState(false);
  const [subtitles, setSubtitles] = useState<SubtitleTrackInput[]>([]);

  const tree = snapshot.library.tree;
  const active = snapshot.tabs.active ? parseTabId(snapshot.tabs.active) : null;

  // Sidecar subtitles next to the open video (ep01.srt, ep01.en.vtt…).
  useEffect(() => {
    setSubtitles([]);
    if (!video) return;
    const node = tree.nodes[video.fileId];
    if (!node) return;
    const siblings = childrenOf(tree, node.parentId ?? tree.rootId).map((id) => tree.nodes[id]);
    const names = sidecarsFor(node.name, siblings.map((sibling) => sibling.name));
    let cancelled = false;
    void Promise.all(
      siblings
        .filter((sibling) => names.includes(sibling.name))
        .map(async (sibling) => ({
          id: sibling.id,
          label: sibling.name,
          cues: parseSubtitleText(await (await library.getFile(sibling.id)).text()),
        })),
    ).then((tracks) => {
      if (!cancelled) setSubtitles(tracks.filter((track) => track.cues.length > 0));
    });
    return () => {
      cancelled = true;
    };
  }, [video, tree, library]);

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

  const linkFolder = async () => {
    // The picker FIRST, inside the click (E1: it needs the click's activation).
    const handle = await pickFolder({ access: 'read', id: 'watch-together-videos' }).catch((error: unknown) => {
      toaster.show({ message: String(error instanceof Error ? error.message : error) });
      return null;
    });
    if (handle) await workspace.link(handle).catch(() => {});
  };

  const changeVolume = (next: number, nextMuted: boolean) => {
    setVolume(next);
    setMuted(nextMuted);
    writePreference('volume', next);
  };

  const label = (id: string) => workspace.label(id);

  return (
    <Toaster store={toaster}>
      <div className='flex h-full flex-col'>
        <header className='flex flex-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-secondary-dark-gray bg-secondary-black px-3 py-1.5'>
          <button type='button' className={TOOLBAR_BUTTON} aria-pressed={sidebarOpen} onClick={() => setSidebarOpen((open) => !open)}>
            ☰ Library
          </button>
          <button
            type='button'
            className={TOOLBAR_BUTTON}
            aria-pressed={snapshot.tabs.active === 'welcome:'}
            onClick={() => workspace.openTab('welcome:')}
          >
            Welcome
          </button>
          <span className='max-w-[320px] truncate px-2 text-[13px] text-primary-light-gray'>
            {snapshot.activeFileName ?? 'watch-together'}
          </span>
          <span className='flex-1' />
          <button type='button' className={TOOLBAR_BUTTON} disabled title='Rooms arrive in the next phase'>
            ◎ Not in a room
          </button>
          {code !== undefined && <span className='text-[12px] text-primary-light-gray'>room link: {code}</span>}
        </header>

        <div className='flex min-h-0 flex-1'>
          {sidebarOpen && (
            <PanelErrorBoundary resetKey={snapshot.library.mode.kind}>
              <FileSidebar
                snapshot={snapshot.library}
                policy={videoPolicy}
                activeFileId={snapshot.activeFileId}
                readOnly={snapshot.readOnly}
                folderActionsDisabled={snapshot.folderActionsDisabled}
                canLinkFolders={canLinkFolders()}
                previewOnClick
                onOpen={(id, { preview }) => void workspace.openFile(id, { preview })}
                onLink={() => void linkFolder()}
                onUnlink={() => void workspace.unlink()}
                onReconnect={() => void workspace.reconnect()}
                onDismissError={() => library.dismissError()}
                onDismissNotice={() => library.dismissNotice()}
                strings={{
                  title: 'Videos',
                  linkFolder: 'Link video folder…',
                  linkFolderTitle: 'Choose a folder of videos (read-only: nothing in it is ever changed)',
                  unlinkTitle: 'Stop using this folder',
                  inert: 'Not a video',
                  empty: 'Link a folder of videos to start.',
                }}
              />
            </PanelErrorBoundary>
          )}

          <div className='flex min-w-0 flex-1 flex-col'>
            <TabStrip
              order={snapshot.tabs.order}
              active={snapshot.tabs.active}
              preview={snapshot.tabs.preview}
              label={label}
              status={(id) => (workspace.isTabMissing(id) ? 'missing' : 'ok')}
              onActivate={(id) => void workspace.activateTab(id)}
              onClose={(ids) => void workspace.closeTabs(ids)}
              onReorder={(id, toIndex) => workspace.reorderTab(id, toIndex)}
              onPromote={(id) => workspace.promoteTab(id)}
              onCloseOthers={(id) => void workspace.closeOtherTabs(id)}
              onCloseRight={(id) => void workspace.closeTabsToTheRight(id)}
              onCloseAll={() => void workspace.closeAllTabs()}
              onReopen={() => void workspace.reopenClosedTab()}
              panelId='content'
            />
            <div id='content' role='tabpanel' className='min-h-0 flex-1'>
              {active?.kind === 'welcome' ? (
                <WelcomeLayout title='▶ watch-together'>
                  <WelcomeSection title='Start'>
                    <WelcomeAction disabled={!canLinkFolders()} onClick={() => void linkFolder()}>
                      📁 Link a video folder…
                    </WelcomeAction>
                    {!canLinkFolders() && (
                      <p className='px-2 text-[12px] text-primary-light-gray'>
                        Linking a folder needs Chrome or Edge on desktop.
                      </p>
                    )}
                  </WelcomeSection>
                  <WelcomeSection title='Room'>
                    <WelcomeAction disabled onClick={() => {}}>＋ Create a room</WelcomeAction>
                    <WelcomeAction disabled hint='code or link' onClick={() => {}}>
                      → Join a room
                    </WelcomeAction>
                  </WelcomeSection>
                  <WelcomeSection title='Recent'>
                    <RecentList
                      entries={snapshot.recentFiles
                        .filter((id) => tree.nodes[id])
                        .map((id) => ({ id, name: tree.nodes[id].name, detail: pathOf(tree, id).slice(0, -1).join('/') }))}
                      empty='No videos opened yet.'
                      onOpen={(id) => void workspace.openFile(id)}
                    />
                  </WelcomeSection>
                  <WelcomeSection title='How it works'>
                    <p className='px-2 text-[13px] leading-relaxed text-primary-light-gray'>
                      1 Link your video folder · 2 Create or join a room · 3 Share a tab · 4 Everyone watches together,
                      each at their own volume.
                    </p>
                  </WelcomeSection>
                </WelcomeLayout>
              ) : video && active?.kind === 'file' ? (
                <VideoPlayer
                  key={video.fileId}
                  file={video.file}
                  resumeKey={video.path}
                  active
                  volume={volume}
                  muted={muted}
                  onVolumeChange={changeVolume}
                  subtitles={subtitles}
                  onNext={nextFileId ? () => void workspace.openFile(nextFileId) : undefined}
                />
              ) : snapshot.openFailure ? (
                <EmptyState icon='⚠' title={`${snapshot.openFailure.name}: ${snapshot.openFailure.detail}`} rows={[]} />
              ) : (
                <EmptyState
                  icon='▶'
                  rows={[
                    { label: 'Open a video', hint: 'click it in the library ←' },
                    { label: 'Open Welcome', hint: 'rooms, recent videos', onClick: () => workspace.openTab('welcome:') },
                  ]}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </Toaster>
  );
}

export { App };
