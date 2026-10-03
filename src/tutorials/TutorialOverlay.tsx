import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createTutorial } from '@theclearsky/easy-tutorial-builder';
import type { Failure, Mood, Outcome, TutorialController } from '@theclearsky/easy-tutorial-builder';
import { useTutorialView } from '@theclearsky/easy-tutorial-builder/react';
import { parseTutorial } from '@theclearsky/easy-tutorial-builder/schema';
import { Pop } from '../guide/Pop';
import type { TutorialId } from './catalog';
import { revealPlayerControls } from './dom';
import { observeApp, tutorialKit } from './kit';
import { inline, plainText } from './markup';
import { tutorialProgress } from './progress';
import { SCRIPTS } from './scripts';

/**
 * A running tutorial: the library's controller (steps, spotlight, target
 * tracking) + Pop and the bubble. Loaded lazily — this module, the kit, the
 * scripts and Pop are not in the app's main chunk.
 *
 * Where it renders: normally over the page (document.body). A modal
 * `<dialog>` (the room dialog) and a fullscreen player sit in the browser's
 * top layer, above everything else and making the rest inert — so Pop moves
 * INTO them while they are open, and draws its own ring there (the
 * library's spotlight stays below the top layer).
 */

type TutorialOverlayProps = {
  tutorialId: TutorialId;
  /** The tutorial ended (completed / skipped / aborted), or could not run. */
  onFinish(outcome: Outcome | 'error'): void;
};

const RING = '#f2c14e';
const BUTTON =
  'cursor-pointer rounded px-2.5 py-1 text-[12px] text-primary-white hover:bg-secondary-dark-gray focus-visible:outline-2 focus-visible:outline-[#f2c14e] pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-[14px]';
const PRIMARY =
  'cursor-pointer rounded bg-[#e23b3b] px-3 py-1 text-[12px] font-semibold text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white pointer-coarse:px-4 pointer-coarse:py-2 pointer-coarse:text-[14px]';

/** The top-layer element Pop must live in, if any. */
function topLayerHost(): HTMLElement {
  const fullscreen = document.fullscreenElement;
  if (fullscreen instanceof HTMLElement && !(fullscreen instanceof HTMLMediaElement)) return fullscreen;
  const modal = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter((dialog) => {
    try {
      return dialog.matches(':modal');
    } catch {
      return false;
    }
  });
  return modal[modal.length - 1] ?? document.body;
}

function useTopLayerHost(active: boolean): HTMLElement {
  const [host, setHost] = useState<HTMLElement>(() => topLayerHost());
  useEffect(() => {
    if (!active) return;
    const update = () => setHost((current) => {
      const next = topLayerHost();
      return next === current ? current : next;
    });
    const timer = window.setInterval(update, 200);
    document.addEventListener('fullscreenchange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('fullscreenchange', update);
    };
  }, [active]);
  return host;
}

export default function TutorialOverlay({ tutorialId, onFinish }: TutorialOverlayProps) {
  const [controller, setController] = useState<TutorialController | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The same validation a script from outside the app would get.
    const parsed = parseTutorial(tutorialKit, SCRIPTS[tutorialId]);
    if (!parsed.ok) {
      console.error('[tutorials] invalid script', tutorialId, parsed.issues);
      onFinishRef.current('error');
      return;
    }
    const stopObserving = observeApp(tutorialKit);
    const next = createTutorial({
      kit: tutorialKit,
      tutorial: parsed.tutorial,
      progress: tutorialProgress,
      spotlight: { ringColor: RING, dimColor: 'rgba(0, 0, 0, 0.5)', zIndex: 10000 },
      targetWaitMs: 4000,
    });
    next.on('failure', (reported) => {
      console.warn('[tutorials]', reported);
      setFailure(reported);
    });
    next.on('finish', (outcome) => onFinishRef.current(outcome));
    setController(next);
    next.start();
    return () => {
      next.destroy();
      stopObserving();
    };
  }, [tutorialId]);

  const view = useTutorialView(controller);
  const running = view?.status === 'running' && controller !== null && view.step !== null;
  const host = useTopLayerHost(running);
  const stepId = view?.step?.id ?? null;
  const stepType = view?.step?.type ?? null;
  const targetName = view?.step?.type === 'point' ? view.step.target.name : null;

  useEffect(() => setConfirmSkip(false), [stepId]);

  // Talking steps: move focus to the main button (keyboard users continue
  // with Enter). Pointing steps leave focus where the user is working.
  useEffect(() => {
    if (stepType === 'say' || stepType === 'end' || stepType === 'choice') primaryRef.current?.focus({ preventScroll: true });
  }, [stepId, stepType]);

  // The player hides its controls while playing; keep them up while a step
  // points at one of them (presentational only).
  useEffect(() => {
    if (!targetName?.startsWith('player.')) return;
    revealPlayerControls();
    const timer = window.setInterval(revealPlayerControls, 1500);
    return () => window.clearInterval(timer);
  }, [targetName]);

  if (!running || !view || !view.step || !controller) return null;

  const speaking = view.hint ?? view.lines;
  const lost = failure?.reason === 'target_not_found' && failure.stepId === view.step.id && view.waitingForTarget;
  let mood: Mood = speaking[0]?.mood ?? (view.step.type === 'point' ? 'pointing' : 'neutral');
  if (view.hint) mood = view.hint[0]?.mood ?? 'thinking';
  if (lost) mood = 'thinking';
  if (confirmSkip) mood = 'concerned';
  const stepNumber = Math.max(1, view.stepIndex + 1);
  const speech = plainText(speaking);
  const ownRing = host !== document.body && view.target !== null;

  const bubble = (
    <div
      className='flex flex-col gap-2'
      onKeyDown={(event) => {
        // Keys pressed in the bubble are for the bubble — not the player's
        // Space / arrow shortcuts underneath.
        event.stopPropagation();
        if (event.key === 'Escape') setConfirmSkip(true);
      }}
    >
      <div className='flex items-center gap-2'>
        <span className='text-[11px] font-semibold tracking-wide text-[#f2c14e] uppercase'>🍿 Pop</span>
        <span className='mr-auto min-w-0 truncate text-[11px] text-primary-light-gray'>
          {view.tutorial.title} · {stepNumber}/{view.stepCount}
        </span>
        <button
          type='button'
          aria-label='Skip tutorial'
          title='Skip tutorial (Esc)'
          className='cursor-pointer rounded px-1.5 text-primary-light-gray hover:bg-secondary-dark-gray hover:text-primary-white focus-visible:outline-2 focus-visible:outline-[#f2c14e] pointer-coarse:px-2.5 pointer-coarse:py-1'
          onClick={() => setConfirmSkip(true)}
        >
          ✕
        </button>
      </div>
      <div aria-live='polite' aria-atomic='true' className='sr-only'>
        {speech}
        {lost ? ' I can’t find it on screen.' : ''}
      </div>
      <div aria-hidden='true' className='flex flex-col gap-1'>
        {view.lines.map((line, index) => (
          <p key={index}>{inline(line.say)}</p>
        ))}
      </div>
      {view.hint && (
        <div aria-hidden='true' className='rounded-md bg-secondary-black/70 px-2 py-1.5 text-[12px] pointer-coarse:text-[14px]'>
          {view.hint.map((line, index) => (
            <p key={index}>💡 {inline(line.say)}</p>
          ))}
        </div>
      )}
      {lost && (
        <p aria-hidden='true' className='text-[12px] text-primary-light-gray pointer-coarse:text-[14px]'>
          I can’t find it on screen. Use the button below, or skip this step.
        </p>
      )}
      {confirmSkip ? (
        <div className='flex flex-wrap items-center justify-end gap-1.5'>
          <span className='mr-auto text-[12px] pointer-coarse:text-[14px]'>Stop this tutorial?</span>
          <button type='button' className={BUTTON} onClick={() => setConfirmSkip(false)}>
            Keep going
          </button>
          <button type='button' className={PRIMARY} autoFocus onClick={() => controller.skip()}>
            Stop
          </button>
        </div>
      ) : (
        <div className='flex flex-wrap items-center justify-end gap-1.5'>
          {view.waitingForAction && !view.canNext && !lost && (
            <span className='mr-auto flex items-center gap-1.5 text-[11px] text-primary-light-gray pointer-coarse:text-[13px]'>
              <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-[#f2c14e] motion-reduce:animate-none' />
              your turn…
            </span>
          )}
          {view.canPrev && (
            <button type='button' className={BUTTON} onClick={() => controller.prev()}>
              Back
            </button>
          )}
          {view.assist && (view.waitingForTarget || view.hint !== null || targetName?.startsWith('player.')) && (
            <button type='button' className={BUTTON} onClick={() => void controller.runAssist()}>
              {view.assist.label ?? 'Show me'}
            </button>
          )}
          {lost && !view.canNext && (
            <button type='button' className={BUTTON} onClick={() => controller.next()}>
              Skip this step
            </button>
          )}
          {view.options.map((option, index) => (
            <button
              key={option.label}
              ref={index === 0 ? primaryRef : undefined}
              type='button'
              className={index === 0 ? PRIMARY : BUTTON}
              onClick={() => controller.choose(index)}
            >
              {option.label}
            </button>
          ))}
          {view.canNext && (
            <button ref={primaryRef} type='button' className={PRIMARY} onClick={() => controller.next()}>
              {view.step.type === 'end' ? 'Done' : 'Next'}
            </button>
          )}
        </div>
      )}
    </div>
  );

  return createPortal(
    <>
      {ownRing && view.target && (
        <div
          aria-hidden='true'
          className='pointer-events-none fixed z-[10001] rounded-lg border-2 shadow-[0_0_0_4px_rgba(242,193,78,0.25)]'
          style={{
            left: view.target.x - 6,
            top: view.target.y - 6,
            width: view.target.width + 12,
            height: view.target.height + 12,
            borderColor: RING,
          }}
        />
      )}
      <Pop
        mood={mood}
        speechKey={`${view.step.id}:${view.hint ? 'hint' : ''}:${view.nudges}`}
        speechLength={speech.length}
        target={view.target}
        placement={view.placement}
        label={`Tutorial: ${view.tutorial.title}`}
      >
        {bubble}
      </Pop>
    </>,
    host,
  );
}
