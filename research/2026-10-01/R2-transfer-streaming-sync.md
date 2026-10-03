# R2 — P2P file transfer, local-video streaming, playback sync, Trystero internals, identity (2026-10-01)

Scope: a static GitHub Pages app (Vite + React 19 + TS). Peers connect with Trystero (default Nostr signaling, STUN only, full mesh, up to ~8 people). The sharer plays a local file (0.3–4 GB) from a folder linked with `showDirectoryPicker`. Viewers either (A) receive a live WebRTC stream or (B) play their own identical copy, kept in sync over data channels. A viewer may also (C) download the sharer's file peer-to-peer into their own linked folder.

**How to read the evidence tags**
- **[SRC]**: read directly in source code (the file and line are given) or in a primary document (URL given).
- **[MEASURED]**: measured this session on Deepak's Windows 11 machine with Playwright 1.59.1 driving bundled Chromium 147.0.7727.15, installed Chrome 154.0.8037.59, installed Edge 154.0.4258.48 and Firefox 148.0.2. The probe scripts were throwaway files in the session scratchpad. Loopback numbers are lower bounds for the browser, not internet numbers.
- **[CLAIM]**: a third-party statement that I cite but did not reproduce.
- **UNVERIFIED**: I could not confirm it. It is flagged in place and listed again in §7.

Trystero was read at `dmotz/trystero@main` (last push 2026-10-01). The npm packages are `trystero` and `@trystero-p2p/*`, all at 0.25.4, published 2026-08-30. Line numbers refer to `packages/core/src/*.ts` at that commit.

---

## Recommendations

| # | Topic | Recommendation | Confidence | Key evidence |
|---|---|---|---|---|
| R1 | File bytes transport | **Do not send file bytes through Trystero `makeAction`.** Open our own `pc.createDataChannel('wt-file', {negotiated: true, id: 1000})` on both sides after `onPeerJoin`, using `room.getPeers()[peerId]`. | High | `action-wire.ts:279-330` loads the whole Blob into RAM (`await data.arrayBuffer()`) and pre-builds every chunk. The receiver concatenates the whole file in RAM (`:431-438`). A negotiated channel does not fire `ondatachannel`, so it cannot clobber Trystero's own channel (`peer.ts:288-291`) [MEASURED] |
| R2 | Message size and backpressure | **64 KiB messages. Pause when `bufferedAmount > 4 MiB`; resume on `bufferedamountlow` with the threshold at 1 MiB.** Never queue more than 16 MiB. Never send a message larger than `pc.sctp.maxMessageSize`. | High | Chromium two-process loopback: 16 KiB messages ≈ 5–6 MB/s, 64 KiB ≈ 22 MB/s [MEASURED]. Chromium `maxMessageSize` = 262144, Firefox = 1073741823 [MEASURED]. In Chromium a 1 MiB send **closes the channel** [MEASURED]. A 16 MiB buffered window threw `OperationError: send queue is full` [MEASURED] |
| R3 | Writing to disk | **One `createWritable()` on `<name>.part` in the linked folder, with positional writes. Keep it open across peer blips. On completion, `close()` and then `handle.move(finalName)`.** For crash-safe resume, prefer **segment files** (for example 256 MiB `.partNNN` files) and concatenate once at the end. **Never** periodically `close()` and reopen with `keepExistingData` (quadratic copying). | High | MDN: writes go to a temporary swap file and only land on `close()`; `keepExistingData` copies the existing file first. A real 1 GiB download with 512 MiB checkpoints did 8.3 GiB of disk writes in 61 s, against 9.2 s without checkpoints. `move()` works on local (non-OPFS) files since Chrome 111 |
| R4 | Resume | Byte-offset protocol: `{fileId, offset, length}` requests. The receiver persists `{fileId, size, mtime, completed blocks}` in IndexedDB. After a reconnect (new connection, same or new peerId), re-request from the first missing block. | High | FilePizza's request carries an `offset` (`useUploaderConnections.ts:229-252`). Trystero closes the peer after 5 s "disconnected" or immediately on "failed", and never restarts ICE (`peer.ts:351-392`) |
| R5 | Integrity | **Per-block SHA-256 with WebCrypto** (4 MiB blocks; native `crypto.subtle.digest`, ≈0.9–1.2 GB/s in Chrome and ≈1.0 GB/s in Firefox [MEASURED]). The sender publishes a manifest of block hashes; file root = SHA-256(concat(block hashes)). No library needed. If a single streaming whole-file SHA-256 is required, use **hash-wasm** (MIT, ~426 MB/s, `save()`/`load()` for resumable state). | High | hash-wasm README benchmarks; noble-hashes ~110 MB/s (hash-wasm bench) or 297 MiB/s (noble's own M4 bench) |
| R6 | Transfer while streaming | **Throttle or pause transfers while mode A streaming is live** (SCTP and RTP congestion control compete on one 5-tuple). In mode B (no media), keep transfers small-message and rate-limited so sync messages aren't delayed: token bucket at ≤ 70% of `availableOutgoingBitrate`, and back off when `room.ping()` RTT doubles. | Medium | Coupled-CC literature (cited in §1.9); RFC 8260 head-of-line note; Pion blog: I-DATA interleaving is behind a flag in Chrome |
| R7 | Firefox/Safari download | They can't link a folder (no `showDirectoryPicker` [MEASURED]). v1: **downloads only in Chrome/Edge**. Later: OPFS staging (sync access handle in a worker) followed by `<a download>` from the disk-backed `File`, or StreamSaver.js (MIT) with a self-hosted mitm. | Medium | MDN `createSyncAccessHandle` (Baseline, workers, OPFS only); StreamSaver README |
| R8 | Audio routing for streaming | `<video>` → `MediaElementAudioSourceNode` → { `GainNode`(local) → speakers ; `MediaStreamAudioDestinationNode` → peers }. Video comes from `video.captureStream().getVideoTracks()[0]`. **Keep `element.volume = 1` and `muted = false` forever; local volume and mute = `GainNode.gain`.** | High | [MEASURED] in Chrome 154, Edge 154, Chromium 147 and Firefox 148: `element.volume` and `muted` **do scale** the MediaElementSource output (vol 0.5 → RMS ×0.5, vol 0 or muted → silence). In Chrome, captureStream audio ignores volume and muted; in Firefox 148 (mozCaptureStream) it follows them. ⚠ This conflicts with S2 T3; see §2.2 |
| R9 | Source change | On `src` change, take a new video track from `captureStream()` and `room.replaceTrack(old, new)`. | High | [MEASURED] In Chrome the old track stays `live` but delivers 0 frames, and new tracks are appended. In Firefox the old tracks end. Agrees with S2 T8 |
| R10 | Stream quality | Per sender: `contentHint='motion'`, `degradationPreference='maintain-framerate'` (or `'balanced'`), `maxBitrate` = min(cap, 0.8 × uplink ÷ (N−1)), `maxFramerate` 30, `scaleResolutionDownBy` to get 720p by default. Codec: keep the browser default (VP8). Optionally prefer an encoder that `mediaCapabilities.encodingInfo({type:'webrtc'})` reports as `powerEfficient`. | Medium | MDN setParameters, contentHint spec mapping, livekit bitrate table, MDN encodingInfo |
| R11 | Upload budget | Full mesh means the sharer encodes and uploads N−1 copies. Default **720p30 at about 2.5 Mbps per viewer** (7 viewers ≈ 17.5 Mbps up). Offer 1080p only for ≤ 3 viewers or when measured uplink allows. | High | livekit table (VP8 720p "gaming/sports" 2.5–3.0 Mbps; 1080p 5.5 Mbps) |
| R12 | Sync algorithm (mode B) | Leader-authoritative timeline `{playing, pos, rate, at: leaderClock, seq}`, heartbeat every 1 s. NTP-style 4-timestamp clock offset: keep 8 samples, **use the min-RTT sample**. Drift d = local − target: **|d| ≤ 0.10 s do nothing** (exit hysteresis at 0.04 s); **0.10–1.0 s nudge `playbackRate = 1 − clamp(d/4, ±0.05)`**; **> 1.0 s seek** (plus measured seek latency), then a 2 s cooldown. Schedule play/seek at `leaderNow + max(300 ms, 2 × maxRTT)`. | High (thresholds are tunable) | Syncplay constants, Jellyfin SyncPlay (min-delay sample, 2×highest-ping scheduling), movienight 150 ms / 1.5 s, watchparty median-leader nudge |
| R13 | Buffering | Ready-gate on explicit play/seek: wait for everyone's "ready", **timeout 8 s**, then start anyway, and the laggard seeks in when ready. During steady playback a stalled peer **does not pause the room** unless the stall exceeds 2 s (that rule is a room setting). | Medium | Jellyfin `WaitingGroupState` pauses everyone and has a 30 s group-wait timeout; watchparty/Syncplay let laggards catch up |
| R14 | Trystero handshake | `onPeerHandshake` runs **on both sides** concurrently. Set `handshakeTimeoutMs: 150_000` **on every client**. There is no upper limit beyond `Number.isFinite && > 0`. Members hold a joiner until they receive a **signed admission ticket**, not a bare "admitted" flag. | High | `handshake.ts:246-298`, `strategy.ts:205-210`; S1 spike already proved a 60 s hold |
| R15 | Kick | No API. Kick = signed `kick` broadcast, then `room.getPeers()[id].close()` on every honest peer. Trystero sees the local data-channel `close` and runs `onPeerLeave` [MEASURED that `close` fires locally in Chrome and Firefox]. Re-admission is denied in the handshake by **identity**, not peerId. | High | `peer.ts:240-242` (`channel.onclose = emitClose`), `room.ts:138-159` |
| R16 | Identity | `selfId` is `Math.random`, regenerated on every page load and self-asserted, so never authorize on it. Use **one Ed25519 keypair per browser profile** (`extractable:false`, stored in IndexedDB, `navigator.storage.persist()`), with ECDSA P-256 as fallback. Prove possession in the handshake by signing a transcript bound to both nonces, both peerIds and the roomId. Owner-signed ACL (versioned) and approver-signed admission tickets. | High | `utils.ts:12-15`; Ed25519 in Chrome 137, Firefox 129 and Safari 17; [MEASURED] Ed25519 + IndexedDB round-trip works in Chrome 147 and Firefox 148 |
| R17 | Signaling | Keep default Nostr, `redundancy` 5 (the default; all peers of the same `appId` pick the same 5 of 30 relays). Set a room `password` (random secret in the invite fragment) so SDP is AES-GCM encrypted with a key not derivable from the roomId alone. Show relay health from `getRelaySockets()`. | Medium | `utils.ts:85-97`, `nostr.ts:23,531-562`, `crypto.ts genKey`; [MEASURED] 28/30 default relays reachable 2026-10-01T17:09Z |

---

## 1. P2P download of a multi-GB file into the viewer's linked folder

### 1.1 What Trystero actions do with binary payloads [SRC]
From `packages/core/src/action-wire.ts`:
- **Chunking.** `chunkSize = 16 * 2**10 - payloadIndex` (line 23). That is 16 KiB per wire message minus a 36-byte header: 32 bytes of action type, 2 of nonce, 1 of tag, 1 of progress (lines 15–23).
- **Whole payload in RAM on send.** `isBlob ? await data.arrayBuffer() : data` (lines 279–285). Then `alloc(chunkTotal, …)` builds **every** chunk up front as new `Uint8Array`s with copies of the bytes (lines 292–330). A 4 GB Blob therefore needs about 4 GB for the ArrayBuffer plus about 4 GB of chunk copies. That is unusable.
- **Whole payload in RAM on receive.** Chunks pile up in `pendingTransmissions[id][type][nonce].chunks`. On the last chunk they are concatenated into one `new Uint8Array(total)` (lines 417–438), so the receiver holds about 2× the size.
- **Backpressure.** Before each 16 KiB chunk it waits while `bufferedAmount > bufferedAmountLowThreshold`. The threshold is hard-set to `0xffff` (64 KiB) in `peer.ts:230`. So at most about 64 KiB is in flight per channel. [MEASURED] This caps throughput at ≈6 MB/s on Chromium two-process loopback (§1.3).
- **Silent truncation bug.** `waitForBufferedAmountLow` gives up after `backpressureWaitTimeoutMs = 10_000` (line 29). On timeout the send loop just `break`s (lines 354–360) and `send()` **resolves successfully**. The receiver never gets `isLast`, and the partial transmission sits in `pendingTransmissions` until the peer leaves. A slow link that stalls for 10 s therefore yields a "successful" but truncated send.
- **Progress** is one byte (`/255`), and the nonce is 16 bits (wraps after 65536 sends per action).
- **A single shared ordered and reliable channel.** Every peer has exactly one channel, `'data'` (`peer.ts:285`). Default `createDataChannel` options are ordered and reliable. It carries all actions plus Trystero internals: ping, signal (renegotiation), stream/track metadata, handshake, leave (`room.ts:185-205`). A large action blocks sync commands and media renegotiation behind it.
- **Access to the RTCPeerConnection.** `room.getPeers()` returns `Record<peerId, RTCPeerConnection>` for **active** peers only (`room.ts:359-362`; README "getPeers()"). The `RTCDataChannel` itself is not exposed publicly. `PeerHandle.channel` is internal.
- **Caution about non-negotiated channels.** On the non-initiator side Trystero does `pc.ondatachannel = ({channel}) => { dataChannel = channel; setupDataChannel(channel) }` (`peer.ts:288-291`). If we open an in-band (non-negotiated) channel from one side, it **replaces Trystero's channel reference** on the other side. Hence R1: `negotiated: true` with a fixed id.
  - [MEASURED] Chromium and Firefox fire `ondatachannel` only for the in-band `'data'` channel and not for negotiated id 1000/1001 channels.
  - [SRC] Per MDN `createDataChannel`, only the *first* data channel triggers `negotiationneeded`, so adding ours needs no renegotiation: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel
- **Shared peers.** Trystero reuses one RTCPeerConnection across rooms of the same `appId` (`shared-peer.ts`, `SharedPeerManager`). Create our file channel once per `RTCPeerConnection` (`WeakMap<RTCPeerConnection, RTCDataChannel>`), not once per room. A second `createDataChannel` with the same id throws `ResourceInUse` (MDN, above).

### 1.2 Data-channel message size and send queue
| Browser | `pc.sctp.maxMessageSize` / SDP `a=max-message-size` | Oversize send | Evidence |
|---|---|---|---|
| Chromium 147 | 262144 / 262144 | `send(1 MiB)` is accepted, then **the channel closes** (other channels stay open) | [MEASURED] |
| Firefox 148 | 1073741823 / 1073741823 | 1 MiB accepted, channel stays open | [MEASURED] |
| Safari | UNVERIFIED | UNVERIFIED | Playwright WebKit on Windows has no `RTCPeerConnection` [MEASURED], so it is not representative |

- MDN: "most modern browsers support sending messages of at least 256 kilobytes". It warns that large messages cause head-of-line blocking without RFC 8260 interleaving, and that absent `max-message-size` means 64 KiB: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels
- Historical: Chrome 256 KiB, Firefox unlimited for reliable+ordered, "use 16384 to be safe, else 65536" (2016): https://lgrahl.de/articles/demystifying-webrtc-dc-size-limit.html. Firefox 57 could receive up to 1 GiB (2017): https://blog.mozilla.org/webrtc/large-data-channel-messages/
- Chromium send queue: with a 16 MiB high-water mark, `send()` threw `OperationError: RTCDataChannel send queue is full` [MEASURED]. Chromium tracker entry "RTCDataChannel Send() should not close the channel on full queue": https://issues.chromium.org/issues/40202004 (the page needs sign-in; the exact limit value is UNVERIFIED, but staying ≤ 8 MiB was safe in tests). simple-peer users hit the same error: https://github.com/feross/simple-peer/issues/895
- Interleaving (I-DATA, RFC 8260): "enabled by default in Firefox, and is behind a flag in Chrome" (Pion, 2026-05-17): https://pion.ly/blog/sctp-interleaving/. Without it, RFC 8260 notes the round-robin scheduler "keeps locked on that stream until all fragments are queued": https://www.rfc-editor.org/rfc/rfc8260.html. **So keep file messages small (64 KiB). A sync message on another channel then waits at most one file message.** Whether Chrome's dcSCTP scheduler round-robins between streams is UNVERIFIED.

### 1.3 Chunk size, backpressure, throughput: real numbers
[MEASURED] Two isolated browser contexts (separate renderer processes), signaled through Node, sending over localhost, negotiated channel:

| Config (message size, pause when `bufferedAmount >` X, resume at `bufferedAmountLowThreshold` Y) | Chromium 147 | Firefox 148 |
|---|---|---|
| Trystero-like: 16 KiB−36 B, X = Y = 64 KiB | **6 MB/s** | 1 MB/s |
| 16 KiB, X = 1 MiB, Y = 256 KiB | 5 MB/s | 3 MB/s |
| **64 KiB, X = 4 MiB, Y = 1 MiB** | **22 MB/s** | 1 MB/s |
| 256 KiB−64 B, X = 8 MiB, Y = 2 MiB | 21 MB/s | 1 MB/s |
| 256 KiB−64 B, X = 16 MiB | throws "send queue is full" | — |

Single-page loopback (one renderer) was 4–8 MB/s in both browsers. Firefox headless loopback was oddly slow in every configuration. I did not find the cause, so treat the Firefox numbers as UNVERIFIED for real links.
- Third-party numbers [CLAIM]: "up to 30.0 MB/s … from one browser process to another", CPU-bound, with 32 KiB chunks best in that test: https://dev.to/anirban00537/webrtc-data-channels-for-large-file-transfer-what-i-learned-the-hard-way-2ama. dcSCTP "+DTLS+UDP can easily handle >1Gbps on a normal computer" (Rust dcsctp README, no browser numbers): https://github.com/webrtc/dcsctp
- Chrome moved to dcSCTP starting M95: https://groups.google.com/g/discuss-webrtc/c/hY3VkIw2-20/m/Gd2O0Q4aCQAJ
- **Reality on the internet:** throughput is bounded by the **sender's uplink** and RTT, not by the browser. Example arithmetic: at 20 Mbps up (≈2.5 MB/s), 2 GB ≈ 13.5 min and 4 GB ≈ 27 min. With 64 KiB messages the browser is not the bottleneck.
- Pattern (all [SRC] MDN): set `ch.bufferedAmountLowThreshold = 1 MiB`. Loop: read the next 64 KiB from `file.slice(off, off+65536).arrayBuffer()`, `send`, and `await` a `bufferedamountlow` event when `bufferedAmount > 4 MiB`. https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmountLowThreshold. Read ahead with `Blob.slice` and never `file.arrayBuffer()` on the whole file.

### 1.4 Ordered vs unordered
- Use **ordered, reliable** for the file channel. Every message carries `offset`, and writes are positional, so unordered reliable would also work and slightly reduces receive-side HOL during loss. Not worth the complexity in v1.
- Sync and control can stay on Trystero actions (small JSON over the ordered `'data'` channel). Alternatively use a second negotiated channel (id 1001) with `{ordered:false, maxRetransmits:0}` for 1 Hz heartbeats, where stale samples are worthless. Option, not required.

### 1.5 Streaming the download to disk without holding it in RAM
Facts [SRC]:
- MDN `createWritable()`: "changes … won't be reflected … until the stream has been closed … typically implemented by writing data to a temporary file". `keepExistingData: true` means "the existing file is first copied to the temporary file". `mode: 'exclusive'|'siloed'` is Baseline 2025. https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable
- In Chrome the swap file is `<name>.crswap`. Safe Browsing checks run on close. Chromium explains why: https://groups.google.com/a/chromium.org/g/chromium-dev/c/UyU-U-V0Jo4
- A real-world measurement (Chrome 152, ext4, 1 GiB): with a close/reopen checkpoint every 512 MiB, **8,351 MiB of disk writes and 61 s**, against **1,044 MiB and 9.2 s** without checkpoints. Copying is quadratic, N²/(2C). https://github.com/NBISweden/sda-download-ui/issues/193
- In-place writes to user files are **not** available. The proposed `inPlace` mode is "blocked on … malware checks": https://github.com/whatwg/fs/issues/148, https://developer.chrome.com/blog/new-dev-trial-for-multiple-readers-and-writers
- `FileSystemFileHandle.move()` works for local (non-OPFS) files since **Chrome 111**. You cannot move between OPFS and the user's file system: https://groups.google.com/a/chromium.org/g/blink-dev/c/ogS8CeyZ3n8, https://developer.chrome.com/docs/capabilities/web-apis/file-system-access. [MEASURED] `FileSystemFileHandle.prototype.move` exists in Chromium 147.
- OPFS `createSyncAccessHandle()`: dedicated workers only, OPFS only, in-place, `flush()`, Baseline since March 2023: https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle. Quota: Chrome/Edge 60% of disk; Firefox best-effort min(10%, 10 GiB), persistent 50%; Safari ~60%: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria

Options:

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Single writable kept open** (recommended v1) | `dir.getFileHandle(name+'.part',{create:true})` → `createWritable({keepExistingData:false})` → `write({type:'write', position, data})` → `close()` → `move(name)` | Linear I/O. RAM stays at about one message. Survives peer blips if the tab stays open: just keep the writable open and continue at the missing offset | A tab crash or reload loses everything since the last close (the swap file is discarded). Needs free space for the swap file in the same volume |
| **B. Segment files** (recommended for "resume after reload") | Write `name.part/000…NNN` (for example 256 MiB each), each with its own writable closed when full. Record completed segments in IndexedDB. At the end, stream-concatenate into `name` with one writable and delete the segments | Crash-safe resume at segment granularity. No quadratic copies | One extra full local copy at the end (≈ seconds per GB on SSD). Temporary 2× disk use. More files |
| C. OPFS staging | Worker + `createSyncAccessHandle`, `write(buf,{at})`, `flush()`; finally `file.stream().pipeTo(linkedWritable)` | True in-place, crash-safe, fastest writes | 2× disk, quota pressure (Firefox best-effort 10 GiB cap), and the final copy cannot use `move()` across file systems |
| D. Periodic `close()` + reopen with `keepExistingData` | — | — | **Avoid**: quadratic (see NBISweden #193). If used at all, double the checkpoint interval each time (≈ 2× total copy), as #193 proposes |

### 1.6 Firefox / Safari fallback
- [MEASURED] Firefox 148: `showDirectoryPicker` and `showSaveFilePicker` are undefined. `navigator.storage.getDirectory` (OPFS), `createWritable` and `move` exist. Safari is UNVERIFIED (Playwright WebKit on Windows lacks most of these APIs).
- **StreamSaver.js** (MIT; 4,370★; last push 2026-07-30; npm `streamsaver` 2.0.6, 129,863 downloads/wk). It downloads a stream through a service worker. The default mitm iframe is hosted on the author's GitHub Pages, but it can be self-hosted (`streamSaver.mitm = …`). Workers idle after "30 sec in firefox, 5 minutes in blink" unless pinged, or transferable streams are used. https://github.com/jimmywarting/StreamSaver.js. **No resume.** FilePizza uses it with a self-hosted mitm (`src/utils/download.ts`).
- **native-file-system-adapter** (MIT; 599★; last push 2026-07-14; npm 3.0.1, 35,719/wk): a ponyfill of `showSaveFilePicker` that falls back to downloads. https://github.com/jimmywarting/native-file-system-adapter
- Recommendation (R7): v1 downloads are Chrome/Edge only, because the receiving side needs a linked folder anyway. Firefox/Safari users watch through mode A. For mode B they can pick their own copy with `<input type=file>` (works everywhere; no folder needed).

### 1.7 Resume after disconnect
- Trystero behavior [SRC] `peer.ts:351-392`:
  - ICE `disconnected` → wait `disconnectedCloseDelayMs = 5_000`, then close if still disconnected.
  - `failed` or `closed` → close immediately.
  - It never calls `restartIce()` on its own (`getOffer(true)` has no internal callers; grep of core).
  - After close the strategy re-announces with warm-up intervals 233/533/1333 ms (`strategy.ts:43,351-361`), so the same tab rejoins with the **same `selfId`**. A new tab gets a new `selfId` (§4.4).
- Protocol: `REQ {fileId, from: offset, blockSize}` → `DATA` messages `[header: fileId:u32, offset:u64][≤64 KiB payload]` → per-block `ACK {blockIndex, sha256}` (optional). `fileId` = the file root hash from §1.8, or for v1 `(name, size, lastModified)` from the sender.
- The receiver persists `{fileId, name, size, blockSize, doneBlocks: bitset, segmentFiles}` in IndexedDB after each block. On `onPeerJoin` of a peer whose verified identity matches the sender, it re-issues `REQ` from the first missing block.
- Prior art: FilePizza's uploader starts each request at a client-supplied `offset` (`validateOffset`, 256 KiB chunks): https://github.com/kern/filepizza/blob/main/src/hooks/useUploaderConnections.ts

### 1.8 Integrity
- WebCrypto has no streaming digest (only one-shot `digest(alg, data)`). The way around that is to hash per block.
- [MEASURED] `crypto.subtle.digest('SHA-256', 4 MiB)`: Chromium 147 ≈ 860–1,204 MB/s, Firefox 148 ≈ 1,004 MB/s, Playwright WebKit (Windows) ≈ 241 MB/s.
- **hash-wasm**: MIT (LICENSE file; GitHub API reports NOASSERTION), 1,159★, last push 2024-11-19 (quiet but stable), npm 4.12.0 with 2.1 M downloads/wk. SHA-256 at 1 MB inputs: **426 MB/s**, against noble-hashes 1.3.2 at 110 MB/s in the same table. It supports `.save()`/`.load()` of hasher state, which allows resumable whole-file hashing across reloads. https://github.com/Daninet/hash-wasm
- **@noble/hashes**: MIT, 927★, last push 2026-09-08, npm 2.4.0 with 105 M downloads/wk. Its own README: sha256 **297 MiB/s** at 1 MB on Apple M4; audited pure JS. https://github.com/paulmillr/noble-hashes
- Recommendation (R5): blocks of 4 MiB (64 messages), each hashed with WebCrypto on both ends. The manifest is sent before the data. `root = SHA-256(h0‖h1‖…)`.
  - A corrupted block is re-requested by offset.
  - The root doubles as the content ID for mode B ("do you have the same file?").
  - Cache roots in IndexedDB keyed by `(name, size, lastModified)`, since hashing 4 GB from disk takes 4 s (SSD) to about 30 s (HDD).
  - For an instant pre-check, compare `size` plus the hash of the first, middle and last 1 MiB.

### 1.9 Transferring while the same connection carries video
- [CLAIM] Media (RTP, Google Congestion Control, delay-based) and data (SCTP, loss-based, TCP-like) share one UDP 5-tuple, each with its own congestion control. That leads to "competition … undesirable spikes in queuing delay and packet loss". Coupled-CC research: https://www.researchgate.net/publication/363515562_Real-Life_Implementation_and_Evaluation_of_Coupled_Congestion_Control_for_WebRTC_Media_and_Data_Flows. RFC 8831 (WebRTC Data Channels): https://www.rfc-editor.org/info/rfc8831/. Recent discussion of uncoordinated SCTP vs RTP: https://arxiv.org/pdf/2607.22854
- Recommendation (R6):
  - In **mode A** the sharer's uplink is already carrying N−1 video encodes, so **pause file uploads by default** while the stream is live. Offer an "allow slow transfer" option capped at about 10–20% of uplink.
  - In **mode B** run a token bucket. The rate is from `RTCIceCandidatePairStats.availableOutgoingBitrate` (an RTP sender estimate; may be `undefined` when no RTP flows) or from a fixed user choice. Back off ×0.5 whenever `room.ping(peer)` RTT exceeds 2× its idle baseline (a crude LEDBAT). https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidatePairStats/availableOutgoingBitrate
  - Keep `bufferedAmount` ≤ 1–4 MiB so queued bytes cannot delay sync messages by seconds.

### 1.10 Prior art (licenses and activity verified via `gh api` on 2026-10-01; npm downloads for the week of 2026-09-23..29)
| Project | License | ★ | Last push | Transfer design | Lessons |
|---|---|---|---|---|---|
| FilePizza (kern/filepizza) | **BSD-3-Clause** (LICENSE file; GitHub API says NOASSERTION) | 10,220 | 2026-09-30 | PeerJS. `MAX_CHUNK_SIZE = 256 KB` with a `ChunkAck` message; starts at a requested `offset`; StreamSaver with a self-hosted mitm; multi-file as a zip stream | Offset-addressed requests make resume trivial. The SW download path has no resume |
| PairDrop | **GPL-3.0** (do not copy code) | 11,508 | 2026-04-22 | `_chunkSize = 64000`, `_maxPartitionSize = 1e6`: stop-and-wait acknowledgement per 1 MB partition (`public/scripts/network.js:1237-1249`) | Simple app-level flow control, but throughput ≤ 1 MB per RTT |
| ShareDrop (szimek/sharedrop) | MIT | 10,766 | 2025-02-10 | `CHUNK_MTU = 16000`, ack every 64 chunks; stores to the deprecated `webkitRequestFileSystem` (`app/services/web-rtc.js:50-51`, `file.js`) | Outdated storage; still 16 KB chunks |
| Snapdrop | GPL-3.0 | 19,734 | 2025-02-10 | (predecessor of PairDrop) | — |
| webtorrent | MIT | 31,426 | 2026-09-29 | BitTorrent wire over WebRTC, 16 KiB requests, piece hashes, many sources (npm 3.0.21, 28,576/wk) | Swarming would let viewers who already finished re-seed. Too heavy for v1 and needs trackers; borrow the per-piece hashing idea |
| simple-peer | MIT | 7,803 | 2024-06-26 (stale) | Raw channel wrapper; users hit "send queue is full" (#895) | Must do your own backpressure |
| PeerJS | MIT | 13,461 | 2026-02-27 | Built-in binary chunking (UNVERIFIED chunk size) | — |
| sagegallant/movienight | MIT | 0 | 2026-09-14 | P2P watch party (PeerJS, captureStream, sync engine) | Thresholds reused in §3; no adoption signal |

---

## 2. Streaming a local `<video>` to peers

### 2.1 `captureStream()` support
- [MEASURED] Chromium 147: `HTMLMediaElement.prototype.captureStream` is a function. Firefox 148: only `mozCaptureStream`. Playwright WebKit (Windows): neither (Safari UNVERIFIED).
- MDN: not Baseline; "Firefox: uses prefixed mozCaptureStream()": https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/captureStream
- Firefox: `mozCaptureStream` **mutes the element's own playback** (bug 1178751, now a duplicate of bug 2007596): https://bugzilla.mozilla.org/show_bug.cgi?id=1178751. Bug 2007596 "Implement captureStream for HTMLMediaElement" is **RESOLVED FIXED, target Firefox 149**, and keeps audio playout: https://bugzilla.mozilla.org/show_bug.cgi?id=2007596. Release timing and current-stable behavior are UNVERIFIED.
- Practical scope: **only Chrome/Edge can be sharers**, because the sharer needs a linked folder (`showDirectoryPicker`). That makes Firefox's capture quirks matter only if we later allow sharing a single picked file from Firefox.

### 2.2 Behavior on pause / seek / hide / source change / volume [MEASURED]
| Event | Chromium 147 (Chrome 154 for the volume test) | Firefox 148 (`mozCaptureStream`) |
|---|---|---|
| `pause()` | tracks stay `live`; audio RMS 0; the sink still counted ~30 fps (likely repeated last frame) | tracks `live`; audio 0; **0 video frames** |
| seek | tracks stay `live` | tracks stay `live` |
| `display:none` on the source video (page visible) | **61 frames / 2 s** (no throttling) | 53 frames / 2 s |
| `src` change | old tracks stay `live` but deliver **0 frames**; 2 new tracks are added to the same stream (`addtrack` ×2) | old tracks **`ended`**, new tracks added |
| captured audio vs `element.volume = 0.2` / `muted` | **unaffected** (RMS 0.707 / 0.707 / 0.705) | **follows** them (0.705 → 0.142 → 0) |
| `MediaElementAudioSourceNode` output vs `volume` | **scaled**: vol 0.5 → ×0.5, vol 0 → 0, muted → 0 (Chromium 147, **Chrome 154, Edge 154**, pure 440 Hz WAV) | same (scaled; 0 when muted) |
| captureStream taken *after* `createMediaElementSource` | still carries audio | still carries audio |

- ⚠ **Conflict with S2 T3** (`research/2026-10-01/S2-capture-spike.md` reports that `element.volume = 0` did not affect the WebAudio path). My controlled tests in four engines say volume *does* scale `MediaElementAudioSourceNode`. The safe rule (R8) holds either way: never touch `element.volume` or `muted`; use `GainNode`. S2's measurement method should be re-checked.
- Agrees with S2: `muted` silences the source node; tracks survive pause and seek; `src` change requires `replaceTrack`; `display:none` keeps streaming in a foreground tab.

### 2.3 Recommended audio and video graph
```
<video src=blob:…>  (volume=1, muted=false, never changed)
   ├─ captureStream().getVideoTracks()[0] ─────────────► room.addTrack(videoTrack, outStream)
   └─ ctx.createMediaElementSource(video)
          ├─► GainNode(localVolume) ─► ctx.destination           (sharer's ears)
          └─► MediaStreamAudioDestinationNode ─► .stream.getAudioTracks()[0] ─► room.addTrack
```
- No CORS issue: `blob:`/`File` URLs are same-origin. MES of a cross-origin resource without CORS outputs silence (MDN `MediaElementAudioSourceNode`: https://developer.mozilla.org/en-US/docs/Web/API/MediaElementAudioSourceNode).
- The `AudioContext` must be created or `resume()`d inside a user gesture (the Play click).
- The audio track from the destination node **survives `src` changes** (the graph persists), so only the video track needs `replaceTrack`.
- Web Audio adds output latency (`ctx.baseLatency + ctx.outputLatency`, typically tens of ms) to the sharer's *local* audio relative to the picture. Measure it, and if it is noticeable, delay the local picture or ignore it. UNVERIFIED magnitude on Deepak's hardware.
- Viewers: `onPeerStream` (or `onPeerTrack`) → `<video>.srcObject`. The viewer's volume is their own element's volume.

### 2.4 Hidden content and background tabs
- [MEASURED] `display:none` on the sharer's `<video>` in a visible tab keeps full frame rate (Chrome and Firefox).
- Chrome "background video track optimization": video tracks are disabled for **MSE** videos in non-visible tabs with keyframe distance < 5 s, and video-only media is paused (shipped Chrome 62). Our `blob:` file playback is not MSE: https://developer.chrome.com/blog/chrome-61-media-updates. **Whether captureStream frames continue when the sharer's whole tab is in the background is UNVERIFIED**: headless Playwright never reports `hidden`, and third-party reports of background frame stalls concern canvas capture (https://github.com/fbsamples/Canvas-Streaming-Example/issues/3, https://bugzilla.mozilla.org/show_bug.cgi?id=1344524). Mitigations: show a "keep this tab visible" banner (`visibilitychange`), offer Picture-in-Picture for the sharer, and watch `outbound-rtp.framesEncoded` in `getStats()` to detect stalls.
- Timers: Chrome's intensive throttling (1 wake-up per minute) **does not apply when "WebRTC is in use"** or audio played in the last 30 s. Hidden pages still get the 1 Hz regular throttling: https://developer.chrome.com/blog/timer-throttling-in-chrome-88. So design sync loops for ≥1 s granularity in background tabs.

### 2.5 Quality controls and reaching the RTCPeerConnection under Trystero
- Reaching it:
  ```ts
  await Promise.all(room.addTrack(videoTrack, outStream, {target: peerId}))
  const pc = room.getPeers()[peerId]
  const sender = pc.getSenders().find(s => s.track === videoTrack)!
  const p = sender.getParameters()
  p.encodings[0] = {...p.encodings[0], maxBitrate, maxFramerate: 30, scaleResolutionDownBy}
  p.degradationPreference = 'maintain-framerate'
  await sender.setParameters(p)
  ```
  [SRC] `media.ts:223-241`: Trystero first sends a metadata action, then calls `pc.addTrack`, so the sender exists once the returned promise resolves. Always pass back the object from `getParameters()`, because it carries the transaction ID.
- `setParameters` fields: `maxBitrate`, `maxFramerate`, `scaleResolutionDownBy` (Safari does not implement it; use `applyConstraints`), `priority`, and `degradationPreference` (`balanced` | `maintain-framerate` | `maintain-resolution` | `maintain-framerate-and-resolution`): https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters
- `contentHint`: `'motion'` is for "movies" and maps to `maintain-framerate`; `'detail'`/`'text'` map to `maintain-resolution`. https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/contentHint, https://w3c.github.io/mst-content-hint/. For film use `'motion'`. (movienight uses `'detail'` plus `maintain-resolution` and SDP munging up to 12 Mbps: https://github.com/sagegallant/movienight/blob/main/docs/wiki/WebRTC-%26-Sync-Engine-Architecture.md. SDP munging is not possible through Trystero without forking.)
- Codecs [MEASURED]: `RTCRtpSender.getCapabilities('video')` lists VP8, H264, AV1 and VP9 in Chromium 147, and VP8, VP9 and AV1 in Playwright's Firefox (no OpenH264 in that build). `setCodecPreferences` is Baseline 2024 and must be called before `createOffer`; it does not itself fire `negotiationneeded`: https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpTransceiver/setCodecPreferences.
  - Under Trystero, the only window is synchronously after `await room.addTrack(...)` resolves, before the queued `negotiationneeded` task runs `createOffer` (`peer.ts:328`). That should work, but it is **UNVERIFIED**.
  - Recommendation: v1 keeps the default (VP8). Experiment with VP9 or AV1 only for ≤ 3 viewers (lower bitrate, but the CPU cost is multiplied by N−1 software encoders).
  - `navigator.mediaCapabilities.encodingInfo({type:'webrtc', video:{contentType:'video/VP9', …}})` returns `powerEfficient` (hardware) hints: https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/encodingInfo
- S2 observed that output starts at 640×360 and ramps up, which is normal GCC ramp-up. `maxBitrate` caps the ceiling but does not raise the starting point; the start bitrate cannot be set without SDP munging (`x-google-start-bitrate`). Expect 5–20 s of ramp-up.

### 2.6 Upload budget (full mesh means N−1 encodes and uploads)
Per-viewer bitrate at 30 fps, VMAF 85 "gaming/sports", a reasonable stand-in for film (https://livekit.com/webrtc/bitrate-guide):

| | H.264 | VP8 | VP9 | AV1 |
|---|---|---|---|---|
| 720p | 3.5 Mbps | 2.5–3.0 | 1.8–2.3 | 1.7–2.3 |
| 1080p | 7.5–8.5 | 5.5 | 4.0–4.5 | 3.5–4.4 |

- 7 viewers × 720p VP8 2.5 Mbps ≈ **17.5 Mbps up**. 7 × 1080p VP8 5.5 ≈ **38.5 Mbps up**. Mesh "collapses past about 4–6 participants" for upload and CPU reasons [CLAIM]: https://www.freecodecamp.org/news/how-webrtc-scales-signaling-nat-traversal-and-the-mesh-sfu-mcu-tradeoff/
- Recommendation (R11): per-peer `maxBitrate = min(qualityCap, 0.8 × uplinkEstimate ÷ (N−1))`. The uplink estimate comes from `availableOutgoingBitrate` after ramp-up, or a user-entered value. Default 720p. **Mode B is the scalable mode** (no media upload), so steer bigger groups to it.

---

## 3. Playback sync (mode B)

### 3.1 What real projects do
| Project (license) | Clock | Small drift | Large drift | Buffering / stall |
|---|---|---|---|---|
| **Syncplay** (Apache-2.0, 2,687★, push 2026-09-13), `syncplay/constants.py` | ping moving average, weight 0.85 | `SLOWDOWN_RATE = 0.95` when ahead by more than `DEFAULT_SLOWDOWN_KICKIN_THRESHOLD = 1.5` s (min 1.3), reset at `SLOWDOWN_RESET_THRESHOLD = 0.1` s | `DEFAULT_REWIND_THRESHOLD = 4` s (rewind if ahead of others); optional fast-forward `DEFAULT_FASTFORWARD_THRESHOLD = 5` s; `SEEK_THRESHOLD = 1` | Laggards pull others back (rewind the ones ahead); manual "ready" states. Docs: https://syncplay.pl/guide/client/ |
| **Jellyfin SyncPlay** (GPL-2.0; jellyfin-web 3,890★) client `src/plugins/syncPlay/core/PlaybackCore.js`, `timeSync/TimeSync.js`; server `MediaBrowser.Controller/SyncPlay/GroupStates/WaitingGroupState.cs`, `Emby.Server.Implementations/SyncPlay/Group.cs` | NTP-style, last **8** measurements, **pick the min-delay one**. Pings 1 s ×3 ("greedy"), then every 60 s | SpeedToSync for 60 ms ≤ \|diff\| < 3000 ms: `speed = 1 + diff/1000` for 1 s (aggressive) | SkipToSync (seek) at ≥ 400 ms when SpeedToSync doesn't apply. Note: `enableSyncCorrection` **defaults to false** in current jellyfin-web | **Waiting state**: any member buffering → everyone pauses until all report Ready. Group-wait timeout `DefaultGroupWaitTimeout = 30000` ms. Resume scheduled at `now + 2 × highest ping` (min `DefaultPing = 500` ms). Clients >`MaxPlaybackOffset = 500` ms off are told to seek |
| **watchparty** (howardchung, MIT, 1,239★, push 2026-07-30), `src/components/App/App.tsx:756-790` | server timestamp map (`tsMap`) | leader = **median** position (max if ≤ 2 people). If behind by > 0.5 s: `pbr = 1 + delta/10`, capped at 1.1 (speed-up only) | — | Laggards speed up; no group pause. File share uses `captureStream` (`:1120-1123`) and skips rate sync for WebRTC sharing |
| **movienight** (sagegallant, MIT, 0★), `js/sync/syncEngine.js` | NTP-style, 8-sample **median** | ≤ 150 ms ok; ≤ 1.5 s → 0.95 / 1.05 | > 1.5 s → hard seek | host is the authority; 1 s heartbeat |
| MovieNight (zorchenhimer, MIT, 726★) | — | — | — | Server-side RTMP restream, no client sync (not comparable) |

### 3.2 Clock offset
- Use `performance.timeOrigin + performance.now()` (monotonic, high-res) rather than `Date.now()`.
- Four-timestamp exchange over a Trystero action:
  - `offset = ((t1−t0) + (t2−t3))/2`
  - `rtt = (t3−t0) − (t2−t1)`
  - Keep the last 8 samples and use the **lowest-RTT sample's offset** (Jellyfin; more robust than a median when Wi-Fi spikes are one-sided).
- Schedule: 5 pings at 1 s intervals on join, then every 15 s, plus a re-burst after `visibilitychange` to visible or after a reconnect. (`room.ping()` only returns RTT, not offset.)

### 3.3 Recommended algorithm and thresholds (R12, R13)
1. **Leader** = the sharer (or the current controller). On every change, and every 1 s, it broadcasts `{seq, playing, pos, rate:1, at: leaderNow}`. Viewers compute `target = pos + (toLeader(localNow) − at) × rate` when playing.
2. **Commands** (play, pause, seek) are proposals sent to the leader. The leader issues `{seq++, …, startAt: leaderNow + max(300 ms, 2 × maxRTT)}`, and everyone applies it at `startAt` in their local clock.
3. **Drift loop** every 500 ms (it degrades gracefully to 1 Hz in background tabs), with `d = video.currentTime − target`:
   - `|d| ≤ 0.10 s` → `playbackRate = 1`. Once correcting, keep going until `|d| < 0.04 s` (hysteresis).
   - `0.10 < |d| ≤ 1.0 s` → `playbackRate = 1 − clamp(d/4, −0.05, +0.05)`. Pitch is preserved because `preservesPitch` defaults to true (https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preservesPitch). Worst case about 20 s to close 1 s.
   - `|d| > 1.0 s` → `currentTime = target + seekCost`, where `seekCost` is an EWMA of measured seek→`seeked` durations, default 0.15 s. Then no corrections for 2 s.
4. **Ready-gate** on play and seek: each peer reports `ready` when `readyState ≥ HAVE_FUTURE_DATA` at the target. The leader waits for all, or **8 s**, then schedules the start. Late peers seek in when ready.
5. **Stalls during playback** (the `waiting` event): don't pause the room. If the stall lasts > 2 s and the room setting "pause for everyone when someone buffers" is on (the Jellyfin behavior), the leader pauses everyone, waits for ready (gate as above, 30 s max like Jellyfin), and resumes. Local files rarely stall, so default it **off**.
6. **Mode A (streaming):** no drift control. The viewer's picture *is* the leader's (glass-to-glass latency is typically a few hundred ms; UNVERIFIED on our links). Viewer controls become requests to the sharer.

---

## 4. Trystero specifics (from source)

### 4.1 Packages and versions
- `trystero` 0.25.4 (MIT; 15,737 downloads/wk). The root export is `export * from '@trystero-p2p/nostr'` (`packages/trystero/src/index.ts`). Strategy subpaths such as `trystero/mqtt` now **throw** "deprecated. Install and import from \"@trystero-p2p/…\"" (`deprecate.ts`).
- `@trystero-p2p/core`, `/nostr`, `/mqtt`, `/torrent`, `/supabase`, `/firebase`, `/ipfs` and `/ws-relay` are all at 0.25.4 (published 2026-08-30). `@trystero-p2p/nostr` has 17,769/wk and core 18,504/wk.
- Releases: 0.25.1 (2026-05-26), 0.25.2 (06-11), 0.25.3 (07-13), 0.25.4 (08-30). Repo: MIT, 2,768★, pushed 2026-10-01.
- Open issue #196: "Slower room joining on Nostr after announcement changes" (0.25.4): https://github.com/dmotz/trystero/issues/196

### 4.2 `onPeerHandshake`
[SRC] `handshake.ts`, `room.ts`, `strategy.ts`:
- **It runs on both sides.** Every new connection calls `handshakeManager.start(id, peer)` (`room.ts:261-296`), which invokes `onPeerHandshake(id, send, receive, isInitiator)` locally (`handshake.ts:289-297`). `isInitiator = selfId < id` (`:289`) is deterministic, so exactly one side is the initiator.
- A peer becomes active only when **both** the local handshake resolved (`didLocalHandshakePass`) **and** the remote's `hsready` arrived (`didReceiveRemoteReady`) (`:157-171`).
- **The room password runs first** (`createPasswordHandshake().compose`, `handshake.ts:89-95`; `strategy.ts:626-627`).
- **Timeout.** `handshakeTimeoutMs` defaults to `10_000` (`room.ts:25`). The only validation is `Number.isFinite(x) && x > 0` (`strategy.ts:205-210`), so **120–150 s is fine**. JS `setTimeout` caps at 2³¹−1 ms (≈24.8 days). The timer is local to each side (`handshake.ts:253-261`), so **every client must use the long timeout**, including the joiner, which is itself waiting on `receive()`. S1 proved a 60 s hold with 150 s timeouts.
- **While pending:**
  - The peer is not in `getPeers()`, and no `onPeerJoin`, actions, streams or tracks reach it (`canReceiveFromPeer`, `room.ts:116-117`; README "During handshake, the peer remains pending…").
  - Only the internal `@_hsdata`, `@_hsready` and `@_leave` actions flow (`sendToPending/receiveWhilePending`, `room.ts:194-205`).
  - Media renegotiation signals are dropped for non-active peers (`room.ts:233-239, 281-287`).
  - Relay announcing continues.
- **Deny.** Throwing or rejecting → `onHandshakeError` → `onJoinError({error, appId, roomId, peerId})` and `exitPeer` → `peer.destroy()` (`handshake.ts:173-188`, `room.ts:217`, `strategy.ts:634-640`). The other side's pending `receive()` rejects with "peer disconnected" (`handshake.ts:227-238`).
- **Retry loop.** After a denial the strategy re-announces (`reannounceAfterDisconnect`), so a denied peer **will reconnect and handshake again** (warm-up 233/533/1333 ms, then the 60 s steady interval, `nostr.ts:39`). Auto-deny known-denied identities immediately, and have a denied client `room.leave()` with a cooldown (S1's conclusion).
- Handler signature in 0.25: action receivers are `(data, {peerId, metadata})` (`actions.ts:317,367`), as S1 also noticed.

### 4.3 Kick after admission
There is no `kick` API. Room methods are `makeAction, ping, leave, isPassive, getPeers, add/remove Stream/Track, replaceTrack, onPeer*` (`types.ts:180-216`). A working recipe:
1. The owner or an approver broadcasts a **signed** `kick {identity, aclVersion}`.
2. Every honest peer calls `room.getPeers()[peerId]?.close()`. [MEASURED] In Chrome and Firefox a local `pc.close()` fires the local data-channel `close` event, and Trystero wires `channel.onclose = emitClose` (`peer.ts:241`) → `exitPeer` → `onPeerLeave`. The remote side sees its channel close too.
3. Because the kicked peer re-announces and reconnects, its next handshake must be denied by **identity** (§5).
4. Because of shared peers (`shared-peer.ts`), closing the RTCPeerConnection affects every room of the same `appId` in that tab. This is fine for a one-room app.

### 4.4 Peer IDs
- `export const selfId = genId(20)` at module load, where `genId` uses **`Math.random()`** over a 62-character set (`utils.ts:10-15`). It is **new on every page load**, shared across all rooms in the tab, and *self-asserted* in Nostr announcements (`{"peerId": …}`, `topic-strategy.ts:203-209`).
- The Nostr signing key is also per-load (`schnorr.keygen()`, `nostr.ts:26`).
- Therefore: never key permissions on `peerId`. Treat it as a per-connection handle, mapped to a verified identity only after the handshake (§5).

### 4.5 Reconnect behavior on network blips
- ICE `disconnected` → 5 s grace (`disconnectedCloseDelayMs`), and if it recovers in that window nothing happens. Otherwise, or immediately on `failed`, the peer closes → `onPeerLeave`. There is no ICE restart. The strategy re-announces with warm-up and reconnects with a fresh RTCPeerConnection, which means **a fresh handshake** and **re-adding streams** (`peer.ts:351-392`, `strategy.ts:351-361`).
- Relay sockets reconnect with jittered exponential backoff, from 3.333 s to a maximum of 60 s, and pause while the browser is `offline` (`utils.ts:114-215, 292-307`).
- Admission must therefore be **automatic for known identities** (ticket or allow-list) and never re-prompt a human. File transfers resume by offset (§1.7). Streams must be re-added in `onPeerJoin` (mode A).

### 4.6 Nostr relay reliability and `redundancy`
- Default: `defaultRedundancy = 5` (`nostr.ts:23`), taken from a 30-relay `defaultRelayUrls` list (`nostr.ts:531-562`). The list is **deterministically shuffled by `appId`** (`getRelays(..., deriveFromAppId=true)`, `utils.ts:85-97`), so all clients with the same `appId` and the same `redundancy` use the same relays. Changing `redundancy` across app versions still overlaps on the first min(N) relays.
- Incident (2026-08-28): a relay operator measured Trystero clients announcing every 5.333 s to 5 relays forever. Their relay received ~4,000 ephemeral events/s and fell over. **10 of 47** then-default relays were unreachable, and ~557 events/s were aggregated across the list: https://github.com/dmotz/trystero/issues/192. Fixed in 0.25.4: a 60 s steady announce interval, obeying rate-limit feedback, a pruned list. Side effect: slower joins (#196).
- [MEASURED] 2026-10-01T17:09Z, a WebSocket open plus `REQ` from this machine: **28 of 30** default relays reachable (`nostr.azzamo.net` timed out; `relay.froth.zone` errored). Open latency was 1.1–3.4 s.
- Maintainer's guidance: the list is pruned at each release; `npm run test-relays` checks it; pass custom `relayConfig.urls` if worried: https://github.com/dmotz/trystero/issues/88
- S1 observed 1–5 s discovery per pair.
- Recommendation (R17): keep the default `redundancy` of 5 and don't raise it (more relay load, little gain at ~93% reachability). Surface `getRelaySockets()` readiness in the UI. Pin Trystero updates to pick up pruned lists. Self-hosting `@trystero-p2p/ws-relay` needs a server, so it is out of scope for GitHub Pages.
- **Set `config.password`.** SDP is AES-GCM encrypted with `SHA-256("${password}:${appId}:${roomId}")` (`crypto.ts genKey`). With no password the key is derivable by anyone who knows the roomId. Put a random password in the invite URL fragment (never sent to servers).

### 4.7 Other gotchas
- The 10 s backpressure timeout silently truncates action sends (§1.1). Keep actions small (≤ a few KB) anyway.
- Calling `makeAction` twice with a different `kind` throws (`actions.ts:254-257`). Action names are limited to 32 bytes (`action-wire.ts:217-224`).
- `room.leave()` sends `@_leave` and waits 99 ms, and it is also registered for `beforeunload` (`room.ts:161-183, 298-302`).

---

## 5. Identity and permissions without a server (R16)

Goal: per-person allow/deny and approver delegation that survive reloads and reconnects, and cannot be claimed by replaying or reusing a `peerId`.

**Platform facts**
- Ed25519 in WebCrypto: Firefox 129 (Aug 2024), Safari 17.0, and **Chrome 137 (May 2025)**: https://blogs.igalia.com/jfernandez/2025/08/25/ed25519-support-lands-in-chrome-what-it-means-for-developers-and-the-web/, https://blog.ipfs.tech/2025-08-ed25519/, caniuse: https://caniuse.com/mdn-api_subtlecrypto_sign_ed25519
- [MEASURED] Chromium 147 and Firefox 148 both:
  - `generateKey({name:'Ed25519'}, false, ['sign','verify'])` works, giving 64-byte signatures and a 32-byte raw public key.
  - The non-extractable `CryptoKeyPair` **round-trips through IndexedDB** (structured clone) and comes back with `extractable=false`.
  - ECDSA P-256 also works.
  - The WebKit-on-Windows build lacks Ed25519, so it is not representative of Safari 17+.
- Storage durability:
  - Call `navigator.storage.persist()`, or the origin's IndexedDB (and with it the identity) can be evicted under storage pressure: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
  - Safari's ITP deletes script-writable storage, IndexedDB included, after 7 days without user interaction: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/. A Safari viewer may need re-approval after a week of absence.

**Design (simple but sound)**
1. **Identity.**
   - On first run, generate an Ed25519 keypair with `extractable:false`; fall back to ECDSA P-256 if `generateKey` throws.
   - Store it in IndexedDB as `{alg, keyPair, displayName, createdAt}`.
   - `identityId = base64url(SHA-256(rawPublicKey))[0..22]`.
   - Non-extractable means a malicious script can *use* the key while the page is running but cannot copy it out. If the key is lost, the person is "new" and must be re-approved.
2. **Room creation.** The owner's `identityId` and raw public key go into the invite link fragment: `#r=<roomId>&p=<password>&o=<ownerPubKeyB64url>`. Joiners therefore know the owner key out of band.
3. **Handshake transcript** (inside `onPeerHandshake`; both sides symmetric). The initiator sends first to avoid a deadlock; `isInitiator` is provided.
   - Each side sends `hello {pubKey, alg, nonce(32B), name}`.
   - Each side then sends `proof {sig = Sign(sk, "wt-hs-v1" ‖ roomId ‖ myPeerId ‖ theirPeerId ‖ myNonce ‖ theirNonce ‖ myPubKey)}`.
   - Verify with the received `pubKey`. Fresh nonces stop replay. Binding both `peerId`s stops reusing a captured proof on another connection.
   - Then map `peerId → identityId` **for this connection only** (clear it in `onPeerLeave`).
   - Residual risk: a full relay man-in-the-middle could forward proofs. Defeating that needs binding the DTLS fingerprints (`a=fingerprint` in the local and remote SDP), but the pending peer's RTCPeerConnection is not reachable during the handshake (README: pending peers are not in `getPeers()`). Option: re-prove after `onPeerJoin` with fingerprints included, and kick on mismatch. The room `password` (§4.6) already makes injecting signaling hard. Recommended as v2 hardening.
4. **Admission.**
   - If the joiner's identity is on the current ACL `allow` list, accept immediately (no human).
   - If it is on `deny`, throw immediately.
   - Otherwise the owner or approver's handshake asks the human (hold ≤ 150 s, R14). On accept, issue a **ticket** `T = Sign(approverSk, {roomId, subject: identityId, issuedBy, aclVersion, exp})` and send it to the joiner in the handshake.
   - Non-approver members hold the joiner's handshake until it presents a valid `T` (signer ∈ approvers of the ACL version the member knows), or until they time out.
   - The owner later folds tickets into the ACL.
5. **ACL document.** `ACL = {roomId, version:n, owner, approvers:[id…], allow:[id…], deny:[id…], perms:{id:{share, control, download}}}`, signed by the owner.
   - Gossip it through an action on join and on change. Peers accept the **highest version with a valid owner signature**. Use version numbers, not wall clocks.
   - Approver delegation = membership in `approvers`. Revocation = a new version, plus `kick`.
   - While the owner is offline, approvers can admit (tickets) but cannot change the ACL. That is an optional extension: an owner-signed `admin` certificate.
6. **Authorization checks happen on the receiver.**
   - Every privileged action (share start, play/seek control, download request, kick) is accepted only if `identityOf(peerId)` has the permission in the current ACL.
   - Kicks and ACL updates must carry owner or approver signatures, because they can be relayed.
7. **What this protects against.**
   - peerId reuse or spoofing: the proof is bound to the key.
   - Replay: nonces plus both peerIds.
   - A forged "I'm admitted" claim (the S1 spoof): tickets are signatures.
   - **Out of scope:** a malicious member with legitimate access recording the stream; anyone with the invite link and password learning that the room exists.

---

## 6. Proposed file-transfer wire format (sketch)
On the negotiated channel `wt-file` (id 1000, ordered, reliable, `binaryType='arraybuffer'`); control messages go over a Trystero action `ft`:
- `ft:offer {fileId, name, size, blockSize: 4 MiB, blockHashes?: hex[]}`. The sender may stream hashes as blocks are first read.
- `ft:req {fileId, fromBlock, toBlock?}` from the receiver, authorized by ACL `download` permission (or an ad-hoc grant).
- Binary frames on `wt-file`: `u32 fileTag | u64 offset | payload(≤ 65,520 B)`, so each frame is ≤ 64 KiB.
- `ft:ack {fileId, block, ok}`. On `ok:false`, re-request that block.
- `ft:pause` / `ft:resume` / `ft:cancel`. The sender applies the token bucket and pauses during mode-A streaming (R6).
- Receiver: segment writer (§1.5 option B) + IndexedDB progress + `move()` on completion. Verify the root hash before the final rename.

---

## 7. UNVERIFIED and open items
1. Safari (macOS/iOS): `maxMessageSize`, `captureStream` (Safari isn't a sharer in v1), WebRTC receive quirks, Ed25519 in 17+ (sourced but not run). Playwright WebKit on Windows lacks WebRTC.
2. Real-internet data-channel throughput (all numbers here are localhost). Firefox headless loopback was 1–3 MB/s for unknown reasons.
3. Chromium's exact send-queue cap (16 MiB failed, 8 MiB worked) and dcSCTP's cross-stream scheduling (round-robin assumed).
4. captureStream frame delivery when the **sharer's whole tab** is in the background or minimized (headless can't emulate it). Test headed with a real second window.
5. Firefox ≥ 149 unprefixed `captureStream` behavior (Bugzilla target only). Firefox stable version on the date of use.
6. `setCodecPreferences` timing under Trystero (call right after `await room.addTrack`).
7. Whether Chrome's paused-element capture repeats the last frame (the counter saw ~30 fps while paused in Chromium) or sends nothing (Firefox sent 0).
8. Web Audio local output latency on Deepak's hardware.
9. The **S2 T3 conflict** (`element.volume` vs MediaElementSource): re-run S2's T3 with a pure tone and an analyser directly on the source node. Regardless, follow R8.
