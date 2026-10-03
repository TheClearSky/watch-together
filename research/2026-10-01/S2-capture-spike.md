# S2 spike — captureStream + WebAudio audio split (2026-10-01)

Page: `verification/spikes/s2-capture.html` (served by `npx http-server@14` from `Repos/` for Range support),
driven by Playwright with **installed Chrome** (`channel: 'chrome'`), loopback through two real `RTCPeerConnection`s.
Audio path under test: `<video>` → `MediaElementAudioSourceNode` → [`GainNode` (sharer's ears) → speakers] + [`MediaStreamAudioDestinationNode` → peers]; video = `video.captureStream().getVideoTracks()[0]`.

| Test | Slime S4 ep02 .mkv (1080p H.264/AAC) | Nostalgia .mp4 (720p) | Verdict |
|---|---|---|---|
| `canPlayType` matroska h264/aac | "probably" | "probably" | MKV H.264/AAC plays natively in Chrome |
| T1 peers' audio peak, sharer gain 1 | 0.0965 | 0.0437 | audio arrives |
| **T2 sharer gain 0** | **0.0906** | **0.0336** | ✅ sharer's volume does NOT reach peers |
| T3 `element.volume = 0` | 0.0941 | 0.0227 | ✅ element volume doesn't affect the WebAudio path |
| **T4 `element.muted = true`** | **0** | **0** | ⚠ `muted` silences the source node → sharer "mute" must be `gain = 0`, never `element.muted` |
| T5 pause | track `live`, audio 0 | same | track survives pause |
| T6 seek to 300 s | track `live`, audio 0.0483 | 0.2019 | track survives seek |
| T7 sharer `<video>` `display:none` | remote advanced 2.0 s in 2 s, audio 0.0831 | 2.0 s, 0.1967 | ✅ hidden shared tab keeps streaming (Q8) — foreground browser tab only; background-tab throttling NOT tested |
| T8 `src` change | old track still `live`; a fresh `captureStream()` returns a DIFFERENT track | same | → on source change call `replaceTrack(old, fresh)` (Trystero `room.replaceTrack`) |
| outbound video after ~10 s | 640×360 (remote decoded 480×270 at 3 s) | 960×540 | ⚠ starts low-res: WebRTC bandwidth ramp-up / degradation. Quality tuning (maxBitrate, `contentHint`, `degradationPreference`) is a P3 task — measure over 60 s |

Conclusion: stream mode (A) and independent volume are feasible in Chrome as designed. Two rules:
- the sharer's volume is a `GainNode` and never `element.muted`;
- a source change swaps the captured video track (`replaceTrack`).

## Discrepancy with R2 (recorded 2026-10-01)

R2 (`R2-transfer-streaming-sync.md` R8, §2.2) measured in Chrome 154, Edge 154, Chromium 147 and Firefox 148 that
`element.volume` and `element.muted` DO scale the `MediaElementAudioSourceNode` output (volume 0.5 → RMS ×0.5),
which contradicts T3 above (volume 0 → peers still at 0.0941). The two probes differ in setup (here the source node
was created while the element was already playing and the measurement was on the far side of a loopback
RTCPeerConnection), and neither was re-run to isolate the cause. **It does not matter for the design**: both agree
on the rule the code follows — `element.volume` stays 1 and `element.muted` stays false forever; a person's own
volume and mute are the `GainNode` (`src/player/audioRouting.ts`).
