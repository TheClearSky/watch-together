/**
 * Sidecar subtitle files (`.srt`, `.vtt`) → cues. Small on purpose: both
 * formats are "index? / timing line / text lines / blank line"; the browser
 * renders the cues natively once they are added to a `TextTrack`.
 *
 * Tolerant like real players: BOMs, CRLF, missing indices, `,` or `.` as the
 * millisecond separator, hours omitted, cue settings after the timing, and
 * blocks that fail to parse are skipped rather than failing the file.
 */

type Cue = { start: number; end: number; text: string };

const TIMING =
  /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function seconds(h: string | undefined, m: string, s: string, ms: string): number {
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

function parseSubtitleText(source: string): Cue[] {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues: Cue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    if (timingIndex < 0) continue; // WEBVTT header, NOTE, STYLE, or junk
    const match = TIMING.exec(lines[timingIndex])!;
    const start = seconds(match[1], match[2], match[3], match[4]);
    const end = seconds(match[5], match[6], match[7], match[8]);
    if (!(end > start)) continue;
    const body = lines
      .slice(timingIndex + 1)
      .join('\n')
      .trim();
    if (body.length > 0) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Sidecar files for `videoName` among `siblingNames`: same stem, any
 *  language suffix (`ep01.srt`, `ep01.en.srt`, `ep01.English.vtt`). */
function sidecarsFor(videoName: string, siblingNames: readonly string[]): string[] {
  const dot = videoName.lastIndexOf('.');
  const stem = (dot > 0 ? videoName.slice(0, dot) : videoName).toLowerCase();
  return siblingNames.filter((name) => {
    const lower = name.toLowerCase();
    return (lower.endsWith('.srt') || lower.endsWith('.vtt')) && (lower.startsWith(`${stem}.`));
  });
}

export { parseSubtitleText, sidecarsFor };
export type { Cue };
