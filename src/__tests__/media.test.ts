import { describe, expect, it } from 'vitest';
import { fingerprintOf, rankCandidates, sameFile, sampleRanges, SAMPLE_BYTES } from '../media/fingerprint';
import { parseSubtitleText, sidecarsFor } from '../media/subtitleText';

const fileOf = (bytes: Uint8Array<ArrayBuffer>, name = 'ep02.mkv') => new File([bytes], name);

describe('fingerprint', () => {
  it('samples start, middle and end of a large file; a small one whole', () => {
    expect(sampleRanges(10)).toEqual([[0, 10]]);
    const size = 1_475_686_557; // the real Slime S4 ep02 .mkv
    const [first, middle, last] = sampleRanges(size);
    expect(first).toEqual([0, SAMPLE_BYTES]);
    expect(middle[1] - middle[0]).toBe(SAMPLE_BYTES);
    expect(last).toEqual([size - SAMPLE_BYTES, size]);
  });

  it('identical bytes → same fingerprint, regardless of name', async () => {
    const bytes = new Uint8Array(5 * SAMPLE_BYTES).map((_, index) => index % 251);
    const a = await fingerprintOf(fileOf(bytes, 'ep02.mkv'));
    const b = await fingerprintOf(fileOf(bytes, 'Slime - 02.mkv'));
    expect(a.sampleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sameFile(a, b)).toBe(true);
  });

  it('a change inside a sample, or a different length, differs', async () => {
    const bytes = new Uint8Array(5 * SAMPLE_BYTES).map((_, index) => index % 251);
    const original = await fingerprintOf(fileOf(bytes));
    const edited = bytes.slice();
    edited[edited.length - 10] ^= 0xff; // inside the END sample
    expect(sameFile(original, await fingerprintOf(fileOf(edited)))).toBe(false);
    expect(sameFile(original, await fingerprintOf(fileOf(bytes.slice(0, bytes.length - 1))))).toBe(false);
  });

  it('candidates: exact size only, same name first', () => {
    const target = { name: 'ep02.mkv', size: 100, sampleHash: 'x' };
    const ranked = rankCandidates(target, [
      { name: 'other.mkv', size: 100 },
      { name: 'EP02.mkv', size: 100 },
      { name: 'ep02.mkv', size: 99 },
    ]);
    expect(ranked.map((file) => file.name)).toEqual(['EP02.mkv', 'other.mkv']);
  });
});

describe('sidecar subtitles', () => {
  it('parses SRT with CRLF, BOM, comma millis and multi-line text', () => {
    const srt = '﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\nthere\r\n\r\n2\r\n00:01:02,05 --> 00:01:04,250\r\nSecond\r\n';
    expect(parseSubtitleText(srt)).toEqual([
      { start: 1.5, end: 3, text: 'Hello\nthere' },
      { start: 62.05, end: 64.25, text: 'Second' },
    ]);
  });

  it('parses VTT: header, NOTE, settings, hours omitted', () => {
    const vtt = 'WEBVTT\n\nNOTE made by hand\n\ncue-1\n01:02.000 --> 01:03.500 align:start\nA\n\n00:00:00.000 --> 00:00:00.000\nzero-length (skipped)\n';
    expect(parseSubtitleText(vtt)).toEqual([{ start: 62, end: 63.5, text: 'A' }]);
  });

  it('finds sidecars by stem, with language suffixes', () => {
    expect(sidecarsFor('ep01.mkv', ['ep01.srt', 'ep01.en.srt', 'EP01.English.vtt', 'ep010.srt', 'ep01.mkv'])).toEqual([
      'ep01.srt',
      'ep01.en.srt',
      'EP01.English.vtt',
    ]);
  });
});
