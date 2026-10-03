/**
 * Watching together: sharing a tab, watching someone's share, keeping time.
 * Framework-free (subscribe / getSnapshot); rides on the room session's
 * connections.
 *
 * SHARER. `startShare` announces the tab to the room and broadcasts its
 * playback state on every change plus a 1 s heartbeat. Media goes ONLY to
 * viewers who chose stream mode (`subscribe`): video from
 * `video.captureStream()`, audio from the Web Audio split (audioRouting.ts),
 * so the sharer's own volume never reaches anyone (spike S2). A new file in
 * the shared tab swaps tracks with `replaceTrack` (S2 T8 / R2 R9). Quality per
 * viewer (R2 R10/R11): 720p30 ≈ 2.5 Mbps by default, full resolution ≈ 5 Mbps
 * for ≤ 3 stream viewers; `contentHint = 'motion'`.
 *
 * VIEWER. Sees every share it may (receivers re-check the room's Q5 rules),
 * subscribes for the stream or plays its own copy kept in time with
 * `clockSync` + `driftController`. A viewer can ask for control; the sharer
 * grants or revokes it and stays the authority (commands are applied to the
 * sharer's own player, which re-broadcasts the state).
 */
import type { Room as TrysteroRoom } from '@trystero-p2p/core';
import type { Fingerprint } from '../media/fingerprint';
import { fingerprintOf } from '../media/fingerprint';
import { audioRouteFor } from '../player/audioRouting';
import type { RoomSession } from '../room/session';
import { canShare } from '../room/roomModel';
import type { TransportRoom } from '../room/transport';
import { ClockEstimate, clockSample } from '../sync/clockSync';
import type { ControlCommand, Playback, ShareMessage } from './protocol';
import { clockMessageSchema, shareMessageSchema } from './protocol';

type ShareView = {
  shareId: string;
  sharer: string;
  sharerName: string;
  title: string;
  fingerprint: Fingerprint | null;
  duration: number | null;
  streamable: boolean;
  /** Who besides the sharer may drive playback. */
  controller: string | null;
  state: Playback | null;
  /** The sharer's connection dropped; the share may come back. */
  lost: boolean;
  ended: boolean;
};

type HostedShare = {
  shareId: string;
  tabId: string;
  title: string;
  element: HTMLVideoElement | null;
  file: File | null;
  fingerprint: Fingerprint | null;
  duration: number | null;
  streamable: boolean;
  stream: MediaStream | null;
  videoTrack: MediaStreamTrack | null;
  subscribers: Set<string>;
  controller: string | null;
  controlRequests: Map<string, string>;
  seq: number;
  cleanup: (() => void) | null;
};

type MyShareView = {
  shareId: string;
  tabId: string;
  title: string;
  streamViewers: number;
  controller: string | null;
  controlRequests: { memberId: string; name: string }[];
};

type ShareSnapshot = {
  /** Shares by OTHER people that I may see. */
  shares: readonly ShareView[];
  /** My own shares. */
  mine: readonly MyShareView[];
  /** Streams I receive, by share id. */
  streams: ReadonlyMap<string, MediaStream>;
  /** Shares I asked control for and am waiting on. */
  controlPending: ReadonlySet<string>;
};

const HEARTBEAT_MS = 1000;
const LOST_GRACE_MS = 30_000;

function newShareId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => (byte % 36).toString(36)).join('');
}

type CapturableVideo = HTMLVideoElement & {
  captureStream?(): MediaStream;
  mozCaptureStream?(): MediaStream;
};

function captureVideoTrack(element: HTMLVideoElement): MediaStreamTrack | null {
  const video = element as CapturableVideo;
  const stream = video.captureStream?.() ?? video.mozCaptureStream?.();
  const track = stream?.getVideoTracks()[0] ?? null;
  if (track) track.contentHint = 'motion';
  return track;
}

function canCapture(element: HTMLVideoElement | null): boolean {
  const video = element as CapturableVideo | null;
  return Boolean(video && (video.captureStream || video.mozCaptureStream));
}

class ShareController {
  private transport: TransportRoom | null = null;
  private readonly hosted = new Map<string, HostedShare>();
  private readonly views = new Map<string, ShareView>();
  private readonly streams = new Map<string, MediaStream>();
  private readonly subscribed = new Set<string>();
  private readonly controlPending = new Set<string>();
  private readonly clocks = new Map<string, ClockEstimate>();
  private readonly lostTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();
  private snapshot: ShareSnapshot = { shares: [], mine: [], streams: new Map(), controlPending: new Set() };
  private readonly unlisten: () => void;
  private readonly unsubscribeRoom: () => void;
  /** Called on the sharer when an allowed viewer sends a command. */
  onControlCommand: ((shareId: string, command: ControlCommand) => void) | null = null;
  /** Called when a viewer asks for control (the app shows a toast). */
  onControlRequest: ((shareId: string, memberId: string, name: string) => void) | null = null;

  constructor(
    private readonly session: RoomSession,
    private readonly now: () => number = Date.now,
  ) {
    this.unlisten = session.listen({
      transport: (room) => this.attach(room),
      peerActive: (peerId) => this.onPeerActive(peerId),
      peerGone: (peerId, memberId) => this.onPeerGone(peerId, memberId),
    });
    // Permission changes (Q5) take effect live, both ways.
    this.unsubscribeRoom = session.subscribe(() => this.enforcePermissions());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  private emit() {
    const room = this.session.getSnapshot().room;
    this.snapshot = {
      shares: [...this.views.values()].filter((view) => !view.ended && (!room || canShare(room, view.sharer))),
      mine: [...this.hosted.values()].map((share) => ({
        shareId: share.shareId,
        tabId: share.tabId,
        title: share.title,
        streamViewers: share.subscribers.size,
        controller: share.controller,
        controlRequests: [...share.controlRequests].map(([memberId, name]) => ({ memberId, name })),
      })),
      streams: new Map(this.streams),
      controlPending: new Set(this.controlPending),
    };
    for (const listener of this.listeners) listener();
  }

  dispose() {
    this.unlisten();
    this.unsubscribeRoom();
    for (const shareId of [...this.hosted.keys()]) this.stopShare(shareId);
    clearInterval(this.heartbeat);
    for (const timer of this.pingTimers.values()) clearInterval(timer);
  }

  // ── wiring ──────────────────────────────────────────────────────────────

  private get media(): TrysteroRoom | null {
    return (this.transport?.media as TrysteroRoom | null) ?? null;
  }

  private attach(room: TransportRoom | null) {
    this.transport = room;
    if (!room) {
      // Left the room: my shares end, everything I watched is gone.
      for (const shareId of [...this.hosted.keys()]) this.stopShare(shareId, { silent: true });
      this.views.clear();
      this.streams.clear();
      this.subscribed.clear();
      this.controlPending.clear();
      for (const timer of this.pingTimers.values()) clearInterval(timer);
      this.pingTimers.clear();
      this.emit();
      return;
    }
    room.on('share', (data, peerId) => this.onShareMessage(data, peerId));
    room.on('clock', (data, peerId) => this.onClockMessage(data, peerId));
    const media = this.media;
    if (media) {
      media.onPeerStream = (stream, _peerId, metadata) => {
        const shareId = (metadata as { shareId?: string } | undefined)?.shareId;
        if (!shareId || !this.subscribed.has(shareId)) return;
        this.streams.set(shareId, stream);
        this.emit();
      };
    }
    this.heartbeat ??= setInterval(() => {
      for (const share of this.hosted.values()) this.broadcastState(share);
    }, HEARTBEAT_MS);
  }

  private send(message: ShareMessage, target?: string | string[]) {
    void this.transport?.send('share', message, target);
  }

  private onPeerActive(peerId: string) {
    // A newcomer (or a reconnection) learns about my shares.
    for (const share of this.hosted.values()) {
      this.send(this.announcement(share), peerId);
      this.broadcastState(share, peerId);
    }
  }

  private onPeerGone(peerId: string, memberId: string | undefined) {
    for (const share of this.hosted.values()) {
      if (share.subscribers.delete(peerId)) this.emit();
      if (memberId && share.controlRequests.delete(memberId)) this.emit();
    }
    if (!memberId || this.session.peersOfMember(memberId).length > 0) return;
    for (const view of this.views.values()) {
      if (view.sharer !== memberId || view.ended) continue;
      view.lost = true;
      this.streams.delete(view.shareId);
      clearTimeout(this.lostTimers.get(view.shareId));
      this.lostTimers.set(
        view.shareId,
        setTimeout(() => {
          view.ended = true;
          this.emit();
        }, LOST_GRACE_MS),
      );
    }
    this.emit();
  }

  private enforcePermissions() {
    const room = this.session.getSnapshot().room;
    if (!room) return;
    for (const share of [...this.hosted.values()]) {
      if (!canShare(room, this.session.me)) this.stopShare(share.shareId);
    }
    this.emit();
  }

  // ── sharing (host) ──────────────────────────────────────────────────────

  /** The file behind one of MY shares (for "save a copy" requests). */
  fileForShare(shareId: string): File | null {
    return this.hosted.get(shareId)?.file ?? null;
  }

  /** Is this peer receiving my stream of this share right now? */
  isStreamingTo(shareId: string, peerId: string): boolean {
    return this.hosted.get(shareId)?.subscribers.has(peerId) ?? false;
  }

  /** A connected peer of the sharer of `shareId`. */
  sharerPeerOf(shareId: string): string | null {
    return this.sharerPeers(shareId)[0] ?? null;
  }

  /** My member id. */
  get myId(): string {
    return this.session.me;
  }

  canShareNow(): boolean {
    const snapshot = this.session.getSnapshot();
    return snapshot.status.kind === 'in-room' && !!snapshot.room && canShare(snapshot.room, this.session.me);
  }

  isSharing(tabId: string): string | null {
    for (const share of this.hosted.values()) if (share.tabId === tabId) return share.shareId;
    return null;
  }

  /**
   * Share a tab. Call from a click (the audio route may need to start its
   * AudioContext). Resolves to the share id, or null when not allowed.
   */
  startShare(input: { tabId: string; title: string; element: HTMLVideoElement | null; file: File | null }): string | null {
    if (!this.canShareNow()) return null;
    const existing = this.isSharing(input.tabId);
    if (existing) return existing;
    const share: HostedShare = {
      shareId: newShareId(),
      tabId: input.tabId,
      title: input.title,
      element: null,
      file: null,
      fingerprint: null,
      duration: null,
      streamable: false,
      stream: null,
      videoTrack: null,
      subscribers: new Set(),
      controller: null,
      controlRequests: new Map(),
      seq: 0,
      cleanup: null,
    };
    this.hosted.set(share.shareId, share);
    this.setSource(share, input.element, input.file, input.title);
    this.emit();
    return share.shareId;
  }

  /** The share continues in another tab (the sharer moved to the next file). */
  retargetShare(shareId: string, tabId: string) {
    const share = this.hosted.get(shareId);
    if (!share) return;
    share.tabId = tabId;
    this.emit();
  }

  /** The shared tab's player was re-created, or moved to another file. */
  updateSource(shareId: string, element: HTMLVideoElement | null, file: File | null, title: string) {
    const share = this.hosted.get(shareId);
    if (share) this.setSource(share, element, file, title);
  }

  private setSource(share: HostedShare, element: HTMLVideoElement | null, file: File | null, title: string) {
    const fileChanged = file !== share.file;
    share.cleanup?.();
    share.cleanup = null;
    share.element = element;
    share.file = file;
    share.title = title;
    if (fileChanged) {
      share.fingerprint = null;
      share.duration = null;
      if (file) {
        void fingerprintOf(file).then((fingerprint) => {
          if (share.file !== file || !this.hosted.has(share.shareId)) return;
          share.fingerprint = fingerprint;
          this.send(this.announcement(share));
        });
      }
    }
    share.streamable = canCapture(element);
    if (element) {
      // Audio for the room comes from the Web Audio split (never muted by
      // the sharer's own volume); created once per element.
      const audioTrack = share.streamable ? audioRouteFor(element).streamTrack() : null;
      const videoTrack = share.streamable ? captureVideoTrack(element) : null;
      if (share.stream && share.videoTrack && videoTrack) {
        void Promise.all(this.media?.replaceTrack(share.videoTrack, videoTrack) ?? []).catch(() => {});
        share.stream.removeTrack(share.videoTrack);
        share.stream.addTrack(videoTrack);
      } else if (videoTrack && audioTrack) {
        share.stream = new MediaStream([videoTrack, audioTrack]);
      }
      share.videoTrack = videoTrack ?? share.videoTrack;
      const onChange = () => this.broadcastState(share);
      const onMetadata = () => {
        share.duration = Number.isFinite(element.duration) ? element.duration : null;
        // A fresh source needs a fresh captured track (S2 T8).
        if (share.streamable && share.stream && share.videoTrack) {
          const fresh = captureVideoTrack(element);
          if (fresh && fresh !== share.videoTrack) {
            void Promise.all(this.media?.replaceTrack(share.videoTrack, fresh) ?? []).catch(() => {});
            share.stream.removeTrack(share.videoTrack);
            share.stream.addTrack(fresh);
            share.videoTrack = fresh;
          }
        }
        this.send(this.announcement(share));
        this.broadcastState(share);
      };
      const events = ['play', 'pause', 'seeked', 'ratechange', 'playing', 'waiting', 'ended'] as const;
      for (const name of events) element.addEventListener(name, onChange);
      element.addEventListener('loadedmetadata', onMetadata);
      share.cleanup = () => {
        for (const name of events) element.removeEventListener(name, onChange);
        element.removeEventListener('loadedmetadata', onMetadata);
      };
      if (element.readyState >= 1) share.duration = Number.isFinite(element.duration) ? element.duration : null;
    }
    this.send(this.announcement(share));
    this.broadcastState(share);
    this.emit();
  }

  private announcement(share: HostedShare): ShareMessage {
    return {
      t: 'announce',
      shareId: share.shareId,
      title: share.title,
      fingerprint: share.fingerprint,
      duration: share.duration,
      streamable: share.streamable,
      controller: share.controller,
    };
  }

  private playbackOf(share: HostedShare): Playback {
    const element = share.element;
    if (!element) return { playing: false, t: 0, rate: 1, at: this.now() };
    const stalled = element.readyState < 3 && !element.paused;
    return {
      playing: !element.paused && !element.ended && !stalled,
      t: Math.max(0, element.currentTime || 0),
      rate: element.playbackRate || 1,
      at: this.now(),
    };
  }

  private broadcastState(share: HostedShare, target?: string) {
    share.seq += 1;
    this.send({ t: 'state', shareId: share.shareId, seq: share.seq, state: this.playbackOf(share) }, target);
  }

  stopShare(shareId: string, options: { silent?: boolean } = {}) {
    const share = this.hosted.get(shareId);
    if (!share) return;
    share.cleanup?.();
    if (share.stream) {
      for (const peerId of share.subscribers) {
        try {
          this.media?.removeStream(share.stream, { target: peerId });
        } catch {
          // The peer may already be gone.
        }
      }
      share.videoTrack?.stop();
    }
    this.hosted.delete(shareId);
    if (!options.silent) this.send({ t: 'end', shareId });
    this.emit();
  }

  private addViewer(share: HostedShare, peerId: string) {
    if (!share.stream || share.subscribers.has(peerId)) return;
    share.subscribers.add(peerId);
    const sends = this.media?.addStream(share.stream, { target: peerId, metadata: { shareId: share.shareId } }) ?? [];
    void Promise.all(sends).then(() => this.tuneQuality(share)).catch(() => {});
    this.emit();
  }

  /** Bitrate / resolution per viewer, from how many stream viewers there are. */
  private tuneQuality(share: HostedShare) {
    const media = this.media;
    if (!media || !share.videoTrack) return;
    const viewers = Math.max(1, share.subscribers.size);
    const height = share.element?.videoHeight || 720;
    const fullQuality = viewers <= 3;
    const scaleResolutionDownBy = fullQuality ? 1 : Math.max(1, height / 720);
    const maxBitrate = fullQuality ? 5_000_000 : 2_500_000;
    const peers = media.getPeers();
    for (const peerId of share.subscribers) {
      const sender = peers[peerId]?.getSenders().find((candidate) => candidate.track === share.videoTrack);
      if (!sender) continue;
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      for (const encoding of parameters.encodings) {
        encoding.maxBitrate = maxBitrate;
        encoding.maxFramerate = 30;
        encoding.scaleResolutionDownBy = scaleResolutionDownBy;
      }
      (parameters as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'maintain-framerate';
      void sender.setParameters(parameters).catch(() => {});
    }
  }

  grantControl(shareId: string, memberId: string | null) {
    const share = this.hosted.get(shareId);
    if (!share) return;
    share.controller = memberId;
    if (memberId) share.controlRequests.delete(memberId);
    this.send({ t: 'control', shareId, controller: memberId });
    this.emit();
  }

  denyControl(shareId: string, memberId: string) {
    const share = this.hosted.get(shareId);
    if (!share?.controlRequests.delete(memberId)) return;
    this.send({ t: 'control', shareId, controller: share.controller }, this.session.peersOfMember(memberId));
    this.emit();
  }

  // ── watching (viewer) ──────────────────────────────────────────────────

  private sharerPeers(shareId: string): string[] {
    const view = this.views.get(shareId);
    return view ? this.session.peersOfMember(view.sharer) : [];
  }

  /** Receive the sharer's stream (stream mode). */
  watchStream(shareId: string) {
    this.subscribed.add(shareId);
    this.startClock(shareId);
    this.send({ t: 'subscribe', shareId }, this.sharerPeers(shareId));
  }

  /** Stop receiving the stream (closing the tab, or switching to my copy). */
  stopStream(shareId: string) {
    if (!this.subscribed.delete(shareId)) return;
    this.streams.delete(shareId);
    this.send({ t: 'unsubscribe', shareId }, this.sharerPeers(shareId));
    this.emit();
  }

  /** Keep a clock for a share (local-copy mode needs it; cheap otherwise). */
  startClock(shareId: string) {
    if (this.pingTimers.has(shareId)) return;
    let count = 0;
    const ping = () => {
      count += 1;
      void this.transport?.send('clock', { t: 'ping', t0: this.now() }, this.sharerPeers(shareId));
      // Quick samples first, then every 2 s.
      if (count === 5) {
        clearInterval(this.pingTimers.get(shareId));
        this.pingTimers.set(shareId, setInterval(ping, 2000));
      }
    };
    this.pingTimers.set(shareId, setInterval(ping, 300));
    ping();
  }

  stopClock(shareId: string) {
    clearInterval(this.pingTimers.get(shareId));
    this.pingTimers.delete(shareId);
  }

  clock(shareId: string): ClockEstimate {
    let clock = this.clocks.get(shareId);
    if (!clock) {
      clock = new ClockEstimate();
      this.clocks.set(shareId, clock);
    }
    return clock;
  }

  requestControl(shareId: string) {
    this.controlPending.add(shareId);
    this.send({ t: 'control-request', shareId }, this.sharerPeers(shareId));
    this.emit();
  }

  hasControl(shareId: string): boolean {
    return this.views.get(shareId)?.controller === this.session.me;
  }

  sendControl(shareId: string, cmd: ControlCommand) {
    if (!this.hasControl(shareId)) return;
    this.send({ t: 'control-cmd', shareId, cmd }, this.sharerPeers(shareId));
  }

  view(shareId: string): ShareView | undefined {
    return this.views.get(shareId);
  }

  // ── incoming ────────────────────────────────────────────────────────────

  private onShareMessage(data: unknown, peerId: string) {
    const parsed = shareMessageSchema.safeParse(data);
    const from = this.session.memberOfPeer(peerId);
    if (!parsed.success || !from) return;
    const message = parsed.data;
    const room = this.session.getSnapshot().room;
    switch (message.t) {
      case 'announce': {
        if (room && !canShare(room, from)) return; // Q5, enforced by every receiver
        const previous = this.views.get(message.shareId);
        if (previous && previous.sharer !== from) return; // someone else's id
        clearTimeout(this.lostTimers.get(message.shareId));
        this.views.set(message.shareId, {
          shareId: message.shareId,
          sharer: from,
          sharerName: this.session.nameOf(from),
          title: message.title,
          fingerprint: message.fingerprint,
          duration: message.duration,
          streamable: message.streamable,
          controller: message.controller,
          state: previous?.state ?? null,
          lost: false,
          ended: false,
        });
        if (previous?.controller !== message.controller) this.controlPending.delete(message.shareId);
        // Reconnected while watching the stream: ask again.
        if (previous?.lost && this.subscribed.has(message.shareId)) {
          this.send({ t: 'subscribe', shareId: message.shareId }, peerId);
        }
        this.emit();
        return;
      }
      case 'state': {
        const view = this.views.get(message.shareId);
        if (!view || view.sharer !== from) return;
        if (view.lost) view.lost = false;
        view.state = message.state;
        this.emit();
        return;
      }
      case 'end': {
        const view = this.views.get(message.shareId);
        if (!view || view.sharer !== from) return;
        view.ended = true;
        this.streams.delete(message.shareId);
        this.subscribed.delete(message.shareId);
        this.stopClock(message.shareId);
        this.emit();
        return;
      }
      case 'control': {
        const view = this.views.get(message.shareId);
        if (!view || view.sharer !== from) return;
        view.controller = message.controller;
        this.controlPending.delete(message.shareId);
        this.emit();
        return;
      }
      case 'subscribe': {
        const share = this.hosted.get(message.shareId);
        if (share) this.addViewer(share, peerId);
        return;
      }
      case 'unsubscribe': {
        const share = this.hosted.get(message.shareId);
        if (!share?.subscribers.delete(peerId)) return;
        if (share.stream) {
          try {
            this.media?.removeStream(share.stream, { target: peerId });
          } catch {
            // already gone
          }
        }
        this.emit();
        return;
      }
      case 'control-request': {
        const share = this.hosted.get(message.shareId);
        if (!share || share.controller === from) return;
        const name = this.session.nameOf(from);
        share.controlRequests.set(from, name);
        this.onControlRequest?.(share.shareId, from, name);
        this.emit();
        return;
      }
      case 'control-cmd': {
        const share = this.hosted.get(message.shareId);
        if (!share || share.controller !== from) return;
        this.onControlCommand?.(share.shareId, message.cmd);
        const element = share.element;
        if (!element) return;
        if (message.cmd.type === 'play') void element.play().catch(() => {});
        else if (message.cmd.type === 'pause') element.pause();
        else if (message.cmd.type === 'seek') element.currentTime = message.cmd.t;
        else element.playbackRate = message.cmd.rate;
        return;
      }
    }
  }

  private onClockMessage(data: unknown, peerId: string) {
    const parsed = clockMessageSchema.safeParse(data);
    if (!parsed.success) return;
    if (parsed.data.t === 'ping') {
      void this.transport?.send('clock', { t: 'pong', t0: parsed.data.t0, t1: this.now() }, peerId);
      return;
    }
    const from = this.session.memberOfPeer(peerId);
    const sample = clockSample(parsed.data.t0, parsed.data.t1, this.now());
    for (const view of this.views.values()) {
      if (view.sharer === from) this.clock(view.shareId).add(sample);
    }
  }
}

export { ShareController };
export type { MyShareView, ShareSnapshot, ShareView };
