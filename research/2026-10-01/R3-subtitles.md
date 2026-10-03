# R3 — Subtitles (sidecar, embedded MKV, delivery to stream viewers)

Researched 2026-10-01 (main thread). Every package checked with `npm view` + `gh api` on that date.

## Recommendations

| Need | Pick | License | Why | Alternative |
|---|---|---|---|---|
| Sidecar `.srt` / `.vtt` | Own tiny parser → `VTTCue` on a `<track>`-less `TextTrack` (`video.addTextTrack`) | — | SRT/VTT are ~60 lines to parse; native cue rendering, zero deps | `srt-parser-2` (MIT, ~197k/wk) |
| Embedded MKV subtitle **extraction** | **Own lazy EBML scanner in a Web Worker** (reads the `File` in 8 MiB slices, decodes only Tracks, Attachments and subtitle-track blocks, skips video/audio payloads by size) | ours (MIT) | Measured: `matroska-subtitles` took **62 s** for a 1.47 GB file (it decodes every element via Node streams). A size-skipping scanner reads at disk speed. | `matroska-subtitles` 3.3.2 (MIT, ~950/wk, last push 2023-01) as a correctness oracle in tests |
| ASS/SSA **rendering** | **JASSUB** (libass → WASM, worker + OffscreenCanvas, full ASS incl. embedded fonts) | npm license string: `LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND …` (bundled libass deps: fribidi LGPL, FreeType FTL) | Anime fansub/CR ASS uses karaoke, positioning, custom fonts — only libass renders them faithfully | **ASS.js** `assjs` (MIT, 665★, pushed 2026-08, DOM renderer, lighter, fewer features) |
| Subtitles for **stream-mode** viewers | Not in `captureStream()` — send the ASS header + events + fonts over the data channel; viewer renders locally with the same renderer, timed to the sharer's `share-state` clock | — | Viewer keeps their own subtitle on/off + track choice; text stays crisp (not burned into video) | Burn-in via canvas compositing (rejected: blurry at stream bitrate, everyone forced to the same track) |

**Decision needed (license):** JASSUB is a dependency, not our code, so watch-together stays MIT — but the deployed bundle then ships LGPL/FTL components and must carry their notices + source links. ASS.js keeps everything permissive at lower fidelity. Recommendation: JASSUB, lazy-loaded only when an ASS track is enabled, with a `THIRD_PARTY_NOTICES` file; ASS.js as fallback if Deepak wants zero copyleft in the bundle.

## Evidence — the real file in `Repos/`

`[Erai-raws] Tensei Shitara Slime Datta Ken 4th Season - 02 [1080p CR WEB-DL AVC AAC][MultiSub][9248583D].mkv` (1 475 686 557 bytes), probed with `matroska-subtitles@3.3.2` in Node:

```
tracks: #3 ass "CR" (no language tag → treat as eng)   #4 por   #5 spa(LatAm)  #6 spa
        #7 ara   #8 fre   #9 ger   #10 ita   #11 rus          (ASS headers 1.1–1.8 KB each)
events per track: 329–390
attachments: 15 fonts (arialbd_3.ttf 286 620 B, Arial_2.ttf 275 572 B, georgiab_0.ttf 207 476 B, …)
full parse time: 62 114 ms
```

Implications:
- Track picker must show `name` + `language` (`"CR"` with no language is common).
- Fonts are ~3 MB total — fine to send to stream viewers once per share (via the file-transfer channel, not chat-sized messages).
- Events are tiny (≈340 × ~150 B ≈ 50 KB per track) — whole track can be sent up front.

## Lazy scanner design (sketch)

```
 File ──slice(8 MiB)──► EBML reader (worker)
   Segment
   ├─ Tracks        → decode fully   (codec S_TEXT/ASS | S_TEXT/UTF8 | S_TEXT/SSA | S_TEXT/WEBVTT)
   ├─ Attachments   → decode fully   (fonts → Blob)
   ├─ Cues          → skip
   └─ Cluster*      → read Timecode; for each SimpleBlock/BlockGroup:
                       read track varint (1–2 bytes) → subtitle track? decode : skip(size)
 emits: tracks, attachment, event{track, startMs, durationMs, text} — progressively
```
Unknown-size clusters (live-muxed files) must fall back to element-by-element scanning; test with the sample file + a synthetic file. `matroska-subtitles` output is the oracle in unit tests (same events, same order).

## Built: `src/media/matroskaSubtitles.ts` (2026-10-01)

Correctness vs the reference parser on the real file (`src/__tests__/matroska.local.test.ts`, opt-in via
`WT_LOCAL_MKV=<path>`): identical track list (#3–#11, all ASS), identical per-track event counts
(339/345/329/329/339/332/367/390/332), same 15 fonts (`arialbd_3.ttf` 286 620 B first). Unit tests use a
synthetic file with 64-byte read windows (values straddling windows) and an unknown-size cluster.

Speed — this machine's disk is noisy (same file, same code: 8.3 s / 23.7 s / 28.6 s wall across runs), so
wall clock alone misleads. The instrumented run separates the parts: **10.9 s wall, of which 10.3 s inside
`read()` (176 × 8 MiB)** → the scanner's own parsing ≈ 0.3–0.6 s; it is I/O-bound. Reference parser, warm,
same session: 19.7 s and 28.7 s wall (62 s cold). Raw `readSync` of the file: 2.0 s (best case).
Practical consequence: in the browser, tracks + fonts arrive within the first window (they precede the
clusters); events stream in progressively over a full-file read, so the UI must show subtitles as they
arrive, not wait for the scan to end.
