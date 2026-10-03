/**
 * Embedded subtitle events → something a renderer can show.
 *
 *  - ASS/SSA tracks: a full script = the track's header (CodecPrivate: Script
 *    Info + Styles, usually ending in `[Events]` + `Format:`) followed by one
 *    `Dialogue:` line per Matroska block, sorted by start time (then ReadOrder,
 *    the muxer's original line order). libass (JASSUB) parses this directly.
 *  - Text tracks (S_TEXT/UTF8, WebVTT): `Cue[]` in seconds, like the sidecar
 *    parser produces, for native `VTTCue`s.
 *
 * Also the plain-text fallback for ASS (`parseAssDialogues`): if the libass
 * renderer cannot load, subtitles are still shown — as text, override tags
 * stripped — never silently dropped.
 */
import type { SubtitleEvent, SubtitleTrack } from '../media/matroskaSubtitles';
import { toAssDialogue } from '../media/matroskaSubtitles';
import type { Cue } from '../media/subtitleText';

const ASS_EVENT_FORMAT = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';
const SSA_EVENT_FORMAT = 'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

/** Used when a track carries no CodecPrivate (rare, but valid Matroska). */
const DEFAULT_ASS_HEADER = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 384',
  'PlayResY: 288',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,1,2,10,10,10,1',
].join('\n');

/** Without an end, a cue lasts until the next one starts, at most this long. */
const OPEN_ENDED_MS = 5000;

/** Events of one track with every `duration` filled in (open-ended blocks
 *  run until the next event, capped), sorted by start then ReadOrder. */
function settleEvents(events: readonly SubtitleEvent[]): SubtitleEvent[] {
  const sorted = [...events].sort((a, b) => a.start - b.start || readOrder(a) - readOrder(b));
  return sorted.map((event, index) => {
    if (event.duration !== undefined) return event;
    const next = sorted.slice(index + 1).find((later) => later.start > event.start);
    const duration = next ? Math.min(next.start - event.start, OPEN_ENDED_MS) : OPEN_ENDED_MS;
    return { ...event, duration };
  });
}

/** The ReadOrder field of a Matroska ASS block (its first field). */
function readOrder(event: SubtitleEvent): number {
  const comma = event.text.indexOf(',');
  const value = Number(comma < 0 ? NaN : event.text.slice(0, comma));
  return Number.isFinite(value) ? value : 0;
}

/** The header with a guaranteed `[Events]` section and `Format:` line at its end. */
function eventsReadyHeader(header: string | undefined, codec: 'ass' | 'ssa'): string {
  const text = (header ?? DEFAULT_ASS_HEADER).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd();
  const eventsAt = text.search(/^\[Events\][ \t]*$/im);
  const format = codec === 'ssa' ? SSA_EVENT_FORMAT : ASS_EVENT_FORMAT;
  if (eventsAt < 0) return `${text}\n\n[Events]\n${format}`;
  // Keep the header's own Events section (its Format line decides the field
  // order) but drop any Dialogue lines a muxer left in CodecPrivate.
  const before = text.slice(0, eventsAt);
  const section = text
    .slice(eventsAt)
    .split('\n')
    .filter((line) => !/^(Dialogue|Comment):/i.test(line.trim()));
  const hasFormat = section.some((line) => /^Format:/i.test(line.trim()));
  if (!hasFormat) section.splice(1, 0, format);
  return `${before}${section.join('\n').trimEnd()}`;
}

/** A complete ASS/SSA script for one track. */
function buildAssScript(track: Pick<SubtitleTrack, 'header' | 'codec'>, events: readonly SubtitleEvent[]): string {
  const codec = track.codec === 'ssa' ? 'ssa' : 'ass';
  const lines = settleEvents(events).map(toAssDialogue);
  return `${eventsReadyHeader(track.header, codec)}\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}

/** A text track's events (S_TEXT/UTF8, WebVTT) as cues in seconds. */
function eventsToCues(events: readonly SubtitleEvent[]): Cue[] {
  return settleEvents(events)
    .map((event) => ({
      start: event.start / 1000,
      end: (event.start + (event.duration ?? 0)) / 1000,
      text: event.text.replace(/\r\n?/g, '\n').trim(),
    }))
    .filter((cue) => cue.text.length > 0 && cue.end > cue.start);
}

/** ASS override blocks `{…}` removed, `\N`/`\n` → newline, `\h` → space. */
function stripAssTags(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** `H:MM:SS.cc` → seconds; NaN when malformed. */
function assTime(stamp: string): number {
  const match = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(stamp);
  if (!match) return Number.NaN;
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fraction;
}

/**
 * Dialogue lines of a script as plain-text cues (the fallback renderer).
 * Field order comes from the `[Events]` Format line. Vector drawings (`\p1`)
 * and empty lines are skipped; simultaneous lines stay separate cues.
 */
function parseAssDialogues(script: string): Cue[] {
  const lines = script.replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false;
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const cues: Cue[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[Events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) {
      fields = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((field) => field.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;
    const values = line.slice(line.indexOf(':') + 1).split(',');
    const textIndex = fields.indexOf('text');
    if (textIndex < 0 || values.length < fields.length) continue;
    const value = (name: string) => values[fields.indexOf(name)] ?? '';
    const body = values.slice(textIndex).join(',');
    if (/\\p[1-9]/.test(body)) continue; // vector drawing, not text
    const text = stripAssTags(body);
    const start = assTime(value('start'));
    const end = assTime(value('end'));
    if (text.length === 0 || !(end > start)) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Cues showing at `time` (seconds), in script order. */
function activeCues(cues: readonly Cue[], time: number): Cue[] {
  return cues.filter((cue) => cue.start <= time && time < cue.end);
}

export { activeCues, assTime, buildAssScript, eventsReadyHeader, eventsToCues, parseAssDialogues, settleEvents, stripAssTags };
