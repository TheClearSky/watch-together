import { Component, lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { TUTORIAL_META } from './catalog';
import type { TutorialId } from './catalog';
import { tutorialsForContext } from './context';
import type { TutorialContext } from './context';
import { isTutorialDone } from './progress';

/**
 * The header's ❔ Tutorials button (D4): a menu with the tutorials for the
 * page you are on first, then the rest. NOTHING starts on its own — a
 * tutorial runs only when picked here.
 *
 * Only this button, the catalogue (titles) and the context mapping are in
 * the main chunk. Picking a tutorial loads the overlay — the library's
 * controller, the kit, the scripts and Pop — as a separate chunk.
 */

const loadOverlay = () => import('./TutorialOverlay');
const TutorialOverlay = lazy(loadOverlay);

type TutorialsButtonProps = { context: TutorialContext };

// The same look as the app's other header buttons.
const TOOLBAR_BUTTON =
  'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[13px] whitespace-nowrap text-primary-white hover:bg-secondary-dark-gray aria-expanded:bg-primary-dark-gray disabled:cursor-default disabled:opacity-40 pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-[15px]';
const ITEM =
  'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-primary-white outline-none hover:bg-secondary-dark-gray focus-visible:bg-secondary-dark-gray pointer-coarse:py-2.5 pointer-coarse:text-[15px]';
const HEADING = 'px-2 pt-2 pb-1 text-[11px] font-semibold tracking-[0.12em] text-primary-light-gray uppercase';

/** A failed chunk load (offline after a deploy) must not take the app down. */
class OverlayBoundary extends Component<{ onError(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[tutorials] the tutorial could not start', error);
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function TutorialsButton({ context }: TutorialsButtonProps) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<{ id: TutorialId; run: number } | null>(null);
  const [, setProgressVersion] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const { forThisPage, all } = tutorialsForContext(context);
  const rest = all.filter((id) => !forThisPage.includes(id));

  // Close on a click elsewhere; warm the overlay chunk while the menu is open.
  useEffect(() => {
    if (!open) return;
    void loadOverlay().catch(() => {});
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // Opening moves focus into the menu (first item).
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const start = (id: TutorialId) => {
    setOpen(false);
    setRunning((current) => ({ id, run: (current?.run ?? 0) + 1 }));
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus();
    if (event.key === 'ArrowDown') focusAt(index + 1);
    else if (event.key === 'ArrowUp') focusAt(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(items.length - 1);
    else if (event.key === 'Escape') close(true);
    else if (event.key === 'Tab') close(false);
    else return;
    if (event.key !== 'Tab') event.preventDefault();
  };

  const item = (id: TutorialId) => {
    const meta = TUTORIAL_META[id];
    const done = isTutorialDone(id);
    return (
      <button
        key={id}
        type='button'
        role='menuitem'
        tabIndex={-1}
        className={ITEM}
        aria-label={`${meta.title}, about ${meta.minutes} minute${meta.minutes === 1 ? '' : 's'}${done ? ', done' : ''}`}
        onClick={() => start(id)}
      >
        <span aria-hidden='true' className='w-4 flex-none text-center text-status-completed'>
          {done ? '✓' : ''}
        </span>
        <span className='min-w-0 flex-1 truncate'>{meta.title}</span>
        <span aria-hidden='true' className='flex-none text-[12px] text-primary-light-gray'>
          ~{meta.minutes} min
        </span>
      </button>
    );
  };

  return (
    <div ref={rootRef} className='relative flex flex-none'>
      <button
        ref={buttonRef}
        type='button'
        data-tour='tutorials'
        className={TOOLBAR_BUTTON}
        aria-label='Tutorials'
        aria-haspopup='menu'
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title='Tutorials — a guided tour for what you are doing'
        onClick={() => setOpen((value) => !value)}
      >
        ❔<span className='max-sm:hidden'>Tutorials</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role='menu'
          aria-label='Tutorials'
          onKeyDown={onMenuKeyDown}
          className='absolute top-full right-0 z-[70] mt-1 flex max-h-[min(70vh,520px)] w-[min(20rem,calc(100vw-1rem))] flex-col overflow-y-auto rounded-md border border-secondary-dark-gray bg-primary-dark-gray p-1 shadow-2xl'
        >
          {running && (
            <>
              <button
                type='button'
                role='menuitem'
                tabIndex={-1}
                className={`${ITEM} text-status-errored`}
                onClick={() => {
                  setRunning(null);
                  close(true);
                }}
              >
                <span aria-hidden='true' className='w-4 flex-none text-center'>
                  ■
                </span>
                Stop “{TUTORIAL_META[running.id].title}”
              </button>
              <div role='separator' className='my-1 border-t border-secondary-dark-gray' />
            </>
          )}
          {forThisPage.length > 0 && (
            <div role='group' aria-label='For this page' className='flex flex-col'>
              <div aria-hidden='true' className={HEADING}>
                For this page
              </div>
              {forThisPage.map(item)}
            </div>
          )}
          {rest.length > 0 && (
            <div role='group' aria-label='All tutorials' className='flex flex-col'>
              <div aria-hidden='true' className={HEADING}>
                All tutorials
              </div>
              {rest.map(item)}
            </div>
          )}
        </div>
      )}
      {running && (
        <OverlayBoundary key={running.run} onError={() => setRunning(null)}>
          <Suspense fallback={null}>
            <TutorialOverlay
              tutorialId={running.id}
              onFinish={() => {
                setRunning(null);
                setProgressVersion((version) => version + 1);
              }}
            />
          </Suspense>
        </OverlayBoundary>
      )}
    </div>
  );
}

export { TutorialsButton };
export type { TutorialsButtonProps };
