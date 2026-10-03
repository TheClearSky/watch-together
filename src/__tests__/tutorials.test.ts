import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTutorial } from '@theclearsky/easy-tutorial-builder/schema';
import type { Condition, Step, Tutorial } from '@theclearsky/easy-tutorial-builder';
import { overlapArea, placeGuide } from '../guide/placement';
import { isSettled, spring, stepSpring } from '../guide/spring';
import { TUTORIAL_IDS, TUTORIAL_META } from '../tutorials/catalog';
import { tutorialsForContext } from '../tutorials/context';
import type { TutorialContext } from '../tutorials/context';
import { SELECTORS } from '../tutorials/dom';
import { isPlainTarget, plainTargets, tutorialKit } from '../tutorials/kit';
import { plainText } from '../tutorials/markup';
import { SCRIPTS } from '../tutorials/scripts';

const base: TutorialContext = { page: 'welcome', inRoom: false, isOwner: false, canShare: false, hasFolder: false, narrow: false };
const ctx = (patch: Partial<TutorialContext>): TutorialContext => ({ ...base, ...patch });

describe('tutorialsForContext', () => {
  it.each<[string, Partial<TutorialContext>, string[]]>([
    ['welcome, nothing yet', {}, ['welcome-tour', 'open-video', 'create-room', 'join-room']],
    ['welcome, folder linked', { hasFolder: true }, ['create-room', 'join-room', 'welcome-tour']],
    ['welcome, in a room', { inRoom: true }, ['watch-share', 'welcome-tour']],
    ['welcome, owner', { inRoom: true, isOwner: true, canShare: true }, ['owner-controls', 'watch-share', 'welcome-tour']],
    ['video, solo', { page: 'video' }, ['player-basics', 'create-room', 'join-room']],
    ['video, in room, may share', { page: 'video', inRoom: true, canShare: true }, ['share-tab', 'player-basics']],
    ['video, in room, may not share', { page: 'video', inRoom: true }, ['player-basics', 'watch-share']],
    ['video, owner', { page: 'video', inRoom: true, isOwner: true, canShare: true }, ['share-tab', 'player-basics', 'owner-controls']],
    ['share tab', { page: 'share', inRoom: true }, ['watch-share', 'player-basics']],
    ['empty, solo', { page: 'empty' }, ['open-video', 'welcome-tour', 'create-room', 'join-room']],
    ['empty, in room', { page: 'empty', inRoom: true }, ['open-video', 'welcome-tour']],
  ])('%s', (_name, patch, expected) => {
    expect(tutorialsForContext(ctx(patch)).forThisPage).toEqual(expected);
  });

  it('always lists every tutorial once under all, and never duplicates', () => {
    const pages = ['welcome', 'video', 'share', 'empty'] as const;
    for (const page of pages)
      for (const inRoom of [false, true])
        for (const isOwner of [false, true])
          for (const canShare of [false, true])
            for (const hasFolder of [false, true])
              for (const narrow of [false, true]) {
                const choice = tutorialsForContext({ page, inRoom, isOwner, canShare, hasFolder, narrow });
                expect(choice.all).toEqual([...TUTORIAL_IDS]);
                expect(new Set(choice.forThisPage).size).toBe(choice.forThisPage.length);
                expect(choice.forThisPage.length).toBeGreaterThan(0);
                for (const id of choice.forThisPage) expect(TUTORIAL_IDS).toContain(id);
              }
  });

  it('narrow changes nothing (scripts adapt at run time)', () => {
    expect(tutorialsForContext(ctx({ page: 'video', narrow: true }))).toEqual(tutorialsForContext(ctx({ page: 'video' })));
  });

  it('is pure: same input, same output, input untouched', () => {
    const input = Object.freeze(ctx({ page: 'video', inRoom: true, canShare: true }));
    expect(tutorialsForContext(input)).toEqual(tutorialsForContext(input));
  });
});

// ── scripts ─────────────────────────────────────────────────────────────

function conditionsOf(step: Step): Condition[] {
  const found: Condition[] = [];
  const walk = (condition: Condition) => {
    found.push(condition);
    if ('not' in condition) walk(condition.not);
    if ('all' in condition) condition.all.forEach(walk);
    if ('any' in condition) condition.any.forEach(walk);
  };
  if (step.skipIf) walk(step.skipIf);
  if (step.type === 'branch') walk(step.if);
  if (step.type === 'point') for (const transition of step.advance) if ('when' in transition) walk(transition.when);
  return found;
}

const ROOM_SECTIONS = ['Invite', 'Wants to join', 'People', 'Who can share a tab', 'Shared in the room', 'You are sharing', 'Chat'];
const PAGES = ['welcome', 'video', 'share', 'empty'];

describe('bundled scripts', () => {
  it('has one script per catalogue entry', () => {
    expect(Object.keys(SCRIPTS).sort()).toEqual([...TUTORIAL_IDS].sort());
  });

  it.each(TUTORIAL_IDS.map((id) => [id]))('%s validates against the kit schema', (id) => {
    const parsed = parseTutorial(tutorialKit, SCRIPTS[id]);
    if (!parsed.ok) throw new Error(parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
    // …and survives the JSON round trip a script from a docs link would take.
    const fromJson = parseTutorial(tutorialKit, JSON.stringify(SCRIPTS[id]), { maxBytes: 512_000 });
    expect(fromJson.ok).toBe(true);
  });

  it.each(TUTORIAL_IDS.map((id) => [id]))('%s matches its catalogue entry', (id) => {
    const script = SCRIPTS[id];
    const meta = TUTORIAL_META[id];
    expect(script.id).toBe(id);
    expect(script.title).toBe(meta.title);
    expect(script.estimatedMinutes).toBe(meta.minutes);
    expect(script.revision).toBe(meta.revision);
    for (const capability of script.requires ?? []) expect(tutorialKit.capabilities).toContain(capability);
  });

  it.each(TUTORIAL_IDS.map((id) => [id]))('%s names only real things in its arguments', (id) => {
    const script: Tutorial = SCRIPTS[id];
    for (const step of script.steps) {
      for (const condition of conditionsOf(step)) {
        if (!('pred' in condition)) continue;
        if (condition.pred === 'shown') expect(isPlainTarget(condition.args?.target), `${step.id}: shown`).toBe(true);
        if (condition.pred === 'page.is') expect(PAGES).toContain(condition.args?.page);
        if (condition.pred === 'share.mode') expect(['stream', 'local']).toContain(condition.args?.mode);
        if (condition.pred === 'dialog.open' && condition.args?.mode !== undefined)
          expect(['create', 'join']).toContain(condition.args.mode);
      }
      if (step.type !== 'point') continue;
      for (const ref of [step.target, ...(step.allow ?? [])]) {
        if (ref.name === 'room.section') expect(ROOM_SECTIONS).toContain(ref.args?.title);
        else expect(ref.args, `${step.id}: ${ref.name} takes no args`).toBeUndefined();
      }
      for (const transition of step.advance) {
        if ('on' in transition && transition.on.event === 'clicked') {
          expect(isPlainTarget(transition.on.args?.target), `${step.id}: clicked target`).toBe(true);
        }
      }
    }
  });

  it.each(TUTORIAL_IDS.map((id) => [id]))('%s can always be left: every path reaches an end step', (id) => {
    const script: Tutorial = SCRIPTS[id];
    expect(script.steps.some((step) => step.type === 'end')).toBe(true);
    // A pointing step with no Next button must have a way forward the user can cause.
    for (const step of script.steps) if (step.type === 'point') expect(step.advance.length).toBeGreaterThan(0);
  });
});

// ── kit targets ─────────────────────────────────────────────────────────

/** A strict check of the selector subset the kit uses: type, #id, .class,
 *  [attr], [attr="v"], [attr^="v"], descendant / child combinators, lists. */
function isWellFormedSelector(selector: string): boolean {
  const compound = /^(?:[a-z][a-z0-9-]*|\*)?(?:#[A-Za-z][\w-]*|\.[A-Za-z][\w-]*|\[[a-z][a-z0-9-]*(?:[~|^$*]?="[^"\\]*")?\]|:[a-z-]+)*$/;
  // Split into selector lists and tokens OUTSIDE quotes and brackets.
  const lists: string[][] = [[]];
  let token = '';
  let quoted = false;
  let depth = 0;
  const flush = () => {
    if (token !== '') lists[lists.length - 1].push(token);
    token = '';
  };
  for (const char of selector) {
    if (quoted) {
      token += char;
      if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      token += char;
    } else if (char === '[') {
      depth += 1;
      token += char;
    } else if (char === ']') {
      depth -= 1;
      if (depth < 0) return false;
      token += char;
    } else if (depth > 0) token += char;
    else if (/\s/.test(char)) flush();
    else if (char === '>') {
      flush();
      lists[lists.length - 1].push('>');
    } else if (char === ',') {
      flush();
      lists.push([]);
    } else token += char;
  }
  flush();
  if (quoted || depth !== 0) return false;
  return lists.every(
    (tokens) =>
      tokens.length > 0 &&
      tokens[0] !== '>' &&
      tokens[tokens.length - 1] !== '>' &&
      tokens.every((part, index) => (part === '>' ? tokens[index - 1] !== '>' : compound.test(part))),
  );
}

describe('kit targets', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the selector checker itself rejects broken selectors', () => {
    expect(isWellFormedSelector('header button[aria-label="Library"]')).toBe(true);
    expect(isWellFormedSelector('[role="tab"][id^="content-tab-share:"]')).toBe(true);
    expect(isWellFormedSelector('header button[aria-label="Library"')).toBe(false);
    expect(isWellFormedSelector('button[aria-label=Library]')).toBe(false);
    expect(isWellFormedSelector('a,,b')).toBe(false);
    expect(isWellFormedSelector('> a')).toBe(false);
  });

  it.each(Object.entries(SELECTORS))('%s is a well-formed selector', (_name, selector) => {
    expect(isWellFormedSelector(selector), selector).toBe(true);
  });

  it('every target, predicate and assist is safe when nothing is on screen (and uses only known selectors)', async () => {
    const asked = new Set<string>();
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) => {
        asked.add(selector);
        return [];
      },
      querySelector: (selector: string) => {
        asked.add(selector);
        return null;
      },
      fullscreenElement: null,
    });
    for (const name of tutorialKit.targetNames) {
      const resolve = tutorialKit.targets[name] as (args: object) => unknown;
      expect(resolve({ title: 'Invite' }), name).toBeNull();
    }
    for (const name of tutorialKit.predicateNames) {
      const predicate = tutorialKit.predicates![name] as (args: object) => boolean;
      expect(typeof predicate({ page: 'welcome', target: 'header.room', mode: 'stream', n: 1 }), name).toBe('boolean');
      expect(typeof predicate({}), name).toBe('boolean');
    }
    // Nothing on screen: not in a room, no video, no ticket, no share.
    for (const name of ['room.in', 'video.open', 'video.playing', 'welcome.ticketShown', 'welcome.codeValid', 'share.open', 'room.isOwner'] as const) {
      expect(tutorialKit.predicates![name]({}), name).toBe(false);
    }
    for (const name of tutorialKit.assistNames) {
      const assist = tutorialKit.assists![name] as (args: object) => unknown;
      await expect(Promise.resolve(assist({})), name).resolves.toBeUndefined();
    }
    const known = new Set<string>(Object.values(SELECTORS));
    for (const selector of asked) expect(known.has(selector), selector).toBe(true);
    expect(asked.size).toBeGreaterThan(10);
  });

  it('every plain target can report clicks', () => {
    for (const name of Object.keys(plainTargets)) expect(tutorialKit.targetNames).toContain(name);
    expect(tutorialKit.events).toContain('clicked');
  });
});

// ── Pop's placement ─────────────────────────────────────────────────────

describe('placeGuide', () => {
  const desktop = { width: 1280, height: 760 };
  const phone = { width: 412, height: 839 }; // Pixel 7, CSS px
  const guideDesktop = { width: 430, height: 170 };
  const guidePhone = { width: 396, height: 200 };

  const targets = (viewport: { width: number; height: number }) => [
    { x: 8, y: 6, width: 90, height: 30 }, // header, left
    { x: viewport.width - 120, y: 6, width: 110, height: 30 }, // header, right (Room)
    { x: viewport.width / 2 - 20, y: viewport.height - 50, width: 40, height: 36 }, // player control
    { x: viewport.width - 340, y: 120, width: 330, height: 120 }, // room-panel section
    { x: 0, y: 40, width: 280, height: 500 }, // sidebar
    { x: viewport.width / 2 - 100, y: viewport.height / 2 - 30, width: 200, height: 60 }, // dialog field
  ];

  it.each([
    ['desktop', desktop, guideDesktop],
    ['phone', phone, guidePhone],
  ] as const)('%s: inside the viewport and never over the target', (_name, viewport, box) => {
    for (const target of targets(viewport)) {
      const placed = placeGuide(viewport, box, target);
      expect(placed.x).toBeGreaterThanOrEqual(0);
      expect(placed.y).toBeGreaterThanOrEqual(0);
      expect(placed.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(placed.y + box.height).toBeLessThanOrEqual(viewport.height);
      const rect = { x: placed.x, y: placed.y, width: box.width, height: box.height };
      expect(overlapArea(rect, target), JSON.stringify({ target, placed })).toBe(0);
    }
  });

  it('honours a preferred side when it fits', () => {
    const target = { x: 500, y: 300, width: 100, height: 40 };
    expect(placeGuide(desktop, guideDesktop, target, 'top').side).toBe('top');
    expect(placeGuide(desktop, guideDesktop, target, 'bottom').side).toBe('bottom');
  });

  it('talking (no target): bottom-right on a computer, bottom-centre on a phone', () => {
    expect(placeGuide(desktop, guideDesktop, null)).toEqual({ x: 1280 - 430 - 12, y: 760 - 170 - 12, side: 'corner' });
    const onPhone = placeGuide(phone, { width: 300, height: 180 }, null);
    expect(onPhone.x).toBe((412 - 300) / 2);
  });

  it('a target covering the screen: the corner that hides the least of it', () => {
    const placed = placeGuide(phone, guidePhone, { x: 0, y: 0, width: 412, height: 839 });
    expect(placed.side).toBe('corner');
  });
});

describe('spring and text', () => {
  it('the spring settles on its target, even with a huge frame gap', () => {
    const s = spring(0);
    s.target = 100;
    stepSpring(s, 5);
    expect(isSettled(s, 0.5)).toBe(true);
    expect(s.value).toBeCloseTo(100, 0);
  });

  it('plain text drops the markup', () => {
    expect(plainText([{ say: 'Press **Play** or [[Space]] — *really* `now`' }])).toBe('Press Play or Space — really now');
  });
});
