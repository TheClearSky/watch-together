import { describe, expect, it } from 'vitest';
import type { SubtitleEvent } from '../media/matroskaSubtitles';
import { activeCues, assTime, buildAssScript, eventsReadyHeader, eventsToCues, parseAssDialogues, settleEvents, stripAssTags } from '../subtitles/assScript';

const HEADER = [
  '[Script Info]',
  'Title: Slime',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Default,Arial,48',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  '',
].join('\r\n');

/** `duration: null` = an open-ended block (no BlockDuration). */
const ev = (start: number, text: string, duration: number | null = 2000, track = 3): SubtitleEvent => ({ track, start, duration: duration ?? undefined, text });

describe('ASS script assembly', () => {
  it('header + Format + Dialogue lines, sorted by start then ReadOrder, commas in text kept', () => {
    const script = buildAssScript({ codec: 'ass', header: HEADER }, [
      ev(5000, '2,0,Default,,0,0,0,,Second, with, commas'),
      ev(1000, '1,0,Default,,0,0,0,,{\\an8}Same start, later order'),
      ev(1000, '0,1,Default,Bob,0,0,0,,First'),
    ]);
    const lines = script.split('\n');
    expect(lines.filter((line) => line === '[Events]')).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('Format: Layer'))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('Dialogue:'))).toEqual([
      'Dialogue: 1,0:00:01.00,0:00:03.00,Default,Bob,0,0,0,,First',
      'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}Same start, later order',
      'Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Second, with, commas',
    ]);
    expect(script.includes('\r')).toBe(false);
    expect(script.endsWith('\n')).toBe(true);
    // The Format line is the last header line before the Dialogues.
    const formatAt = lines.findIndex((line) => line.startsWith('Format: Layer'));
    expect(lines[formatAt + 1]).toMatch(/^Dialogue:/);
  });

  it('adds an [Events] section + Format when CodecPrivate stops at the styles', () => {
    const header = '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nStyle: Default,Arial,20';
    const script = buildAssScript({ codec: 'ass', header }, [ev(0, '0,0,Default,,0,0,0,,Hi')]);
    expect(script).toContain('Style: Default,Arial,20\n\n[Events]\nFormat: Layer, Start, End,');
    expect(script.trimEnd().split('\n').at(-1)).toBe('Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,Hi');
  });

  it('inserts a missing Format line, drops Dialogue lines a muxer left in CodecPrivate, SSA gets Marked', () => {
    expect(eventsReadyHeader('[Script Info]\n[Events]\nDialogue: 0,0:00:00.00,0:00:01.00,x', 'ssa')).toBe(
      '[Script Info]\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    );
  });

  it('a track without CodecPrivate gets a default header that libass accepts', () => {
    const script = buildAssScript({ codec: 'ass', header: undefined }, []);
    expect(script).toMatch(/^\[Script Info\]/);
    expect(script).toContain('[V4+ Styles]');
    expect(script).toContain('[Events]\nFormat: Layer');
  });

  it('open-ended events last until the next one (capped at 5 s)', () => {
    const settled = settleEvents([ev(0, 'a', null), ev(1500, 'b', null), ev(60_000, 'c', null)]);
    expect(settled.map((event) => event.duration)).toEqual([1500, 5000, 5000]);
  });

  it('text tracks become cues in seconds', () => {
    expect(eventsToCues([ev(2500, ' <i>Hi</i>\r\nthere ', 1000), ev(500, 'first', null), ev(9000, '   ', 1000)])).toEqual([
      { start: 0.5, end: 2.5, text: 'first' },
      { start: 2.5, end: 3.5, text: '<i>Hi</i>\nthere' },
    ]);
  });
});

describe('plain-text fallback', () => {
  it('strips override tags and maps \\N / \\h', () => {
    expect(stripAssTags('{\\an8\\fs20}Hello{\\i1}\\Nworld\\hagain')).toBe('Hello\nworld again');
  });

  it('parses Dialogue lines by the Format line, skipping drawings and empties', () => {
    const script = buildAssScript({ codec: 'ass', header: HEADER }, [
      ev(1000, '0,0,Default,,0,0,0,,Hello, world'),
      ev(1500, '1,0,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}'),
      ev(3000, '2,0,Default,,0,0,0,,{\\pos(10,10)}'),
    ]);
    const cues = parseAssDialogues(script);
    expect(cues).toEqual([{ start: 1, end: 3, text: 'Hello, world' }]);
    expect(activeCues(cues, 2).map((cue) => cue.text)).toEqual(['Hello, world']);
    expect(activeCues(cues, 3)).toEqual([]);
  });

  it('reads ASS timestamps', () => {
    expect(assTime('1:02:03.45')).toBeCloseTo(3723.45);
    expect(Number.isNaN(assTime('nope'))).toBe(true);
  });
});
