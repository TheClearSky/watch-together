/**
 * Subtitles travel with a share. A stream viewer has no file to read
 * embedded tracks from, so the sharer sends them (research R3 §5):
 *
 *   viewer ── get ──────────────────────────────► sharer
 *          ◄── manifest {rev, track keys, fonts} ──
 *          ◄── chunks (≤48 KiB each, paced) ───────  tracks first, then fonts
 *
 * Tracks show as soon as they arrive; fonts (often MBs) follow and are
 * SHA-256-verified against the manifest. When the share moves to another
 * video, everyone who asked gets the new manifest (an empty one clears).
 */
import { z } from 'zod';
import type { SubtitlePayload } from '../player/VideoPlayer';
import type { RoomSession } from '../room/session';
import type { TransportRoom } from '../room/transport';
import {
  createChunkAssembler,
  fontChunks,
  fontManifest,
  fontManifestSchema,
  parseSerializedTrack,
  payloadChunkSchema,
  trackChunks,
  verifiedFont,
} from '../subtitles/serialize';
import type { FontManifestEntry, PayloadChunk, SerializedSubtitleTrack } from '../subtitles/serialize';
import type { ShareController } from './shareController';

const shareId = z.string().min(1).max(24);
const relayMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('get'), shareId }),
  z.object({
    t: z.literal('manifest'),
    shareId,
    rev: z.number().int(),
    tracks: z.array(z.string().max(80)).max(64),
    fonts: fontManifestSchema,
  }),
  z.object({ t: z.literal('chunk'), shareId, rev: z.number().int(), chunk: payloadChunkSchema }),
]);

/** Fonts beyond this (total) are not sent; ASS falls back to the default font. */
const MAX_FONT_BYTES = 30 * 1024 * 1024;
/** Pause between chunks so subtitles never crowd out playback messages. */
const CHUNK_GAP_MS = 15;

type Incoming = {
  rev: number;
  trackKeys: string[];
  fonts: FontManifestEntry[];
  tracks: Map<string, SerializedSubtitleTrack>;
  fontData: Map<string, ArrayBuffer>;
  assembler: ReturnType<typeof createChunkAssembler>;
  payload: SubtitlePayload | null;
};

class SubtitleRelay {
  private transport: TransportRoom | null = null;
  /** Sharer: embedded subtitles per player tab. */
  private readonly byTab = new Map<string, SubtitlePayload>();
  /** Sharer: who asked, per share (re-sent when the video changes). */
  private readonly askers = new Map<string, Set<string>>();
  /** Sharer: which tab each share last sent, and its revision. */
  private readonly sent = new Map<string, { tabId: string | null; rev: number }>();
  /** Viewer: what is arriving / arrived, per share. */
  private readonly incoming = new Map<string, Incoming>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private readonly unlisten: Array<() => void> = [];

  constructor(
    private readonly session: RoomSession,
    private readonly shares: ShareController,
  ) {
    this.unlisten.push(
      session.listen({
        transport: (room) => {
          this.transport = room;
          if (room) room.on('subs', (data, peerId) => void this.onMessage(data, peerId));
        },
        peerGone: (peerId) => {
          for (const set of this.askers.values()) set.delete(peerId);
        },
      }),
      shares.subscribe(() => this.onSharesChanged()),
    );
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = () => this.version;

  private emit() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  // ── sharer ──────────────────────────────────────────────────────────────

  /** A player tab finished reading its file's embedded subtitles. */
  setTabSubtitles(tabId: string, payload: SubtitlePayload) {
    this.byTab.set(tabId, payload);
    for (const share of this.shares.getSnapshot().mine) {
      if (share.tabId === tabId) this.pushToAskers(share.shareId, tabId);
    }
  }

  forgetTab(tabId: string) {
    this.byTab.delete(tabId);
  }

  private onSharesChanged() {
    const mine = this.shares.getSnapshot().mine;
    for (const share of mine) {
      const last = this.sent.get(share.shareId);
      if (last && last.tabId !== share.tabId) this.pushToAskers(share.shareId, share.tabId);
    }
    for (const id of [...this.askers.keys()]) {
      if (!mine.some((share) => share.shareId === id)) {
        this.askers.delete(id);
        this.sent.delete(id);
      }
    }
  }

  private pushToAskers(id: string, tabId: string) {
    const targets = [...(this.askers.get(id) ?? [])];
    const rev = (this.sent.get(id)?.rev ?? 0) + 1;
    this.sent.set(id, { tabId, rev });
    if (targets.length > 0) void this.sendTo(id, tabId, rev, targets);
  }

  private async sendTo(id: string, tabId: string, rev: number, targets: string[]) {
    const payload = this.byTab.get(tabId) ?? { tracks: [], fonts: [] };
    let budget = MAX_FONT_BYTES;
    const fonts = payload.fonts.filter((font) => (budget -= font.data.byteLength) >= 0);
    const manifest = await fontManifest(fonts);
    const tracks = payload.tracks.map((track) => ({ track, chunks: trackChunks(track) }));
    const send = (message: z.infer<typeof relayMessageSchema>) => this.transport?.send('subs', message, targets);
    await send({ t: 'manifest', shareId: id, rev, tracks: tracks.map(({ chunks }) => chunks[0]?.key ?? ''), fonts: manifest });
    const queue: PayloadChunk[] = [
      ...tracks.flatMap(({ chunks }) => chunks),
      ...manifest.flatMap((entry, index) => fontChunks(entry, fonts[index].data)),
    ];
    for (const chunk of queue) {
      // A newer revision (the share moved on) supersedes this one.
      if (this.sent.get(id)?.rev !== rev) return;
      await send({ t: 'chunk', shareId: id, rev, chunk });
      await new Promise((resolve) => setTimeout(resolve, CHUNK_GAP_MS));
    }
  }

  // ── viewer ──────────────────────────────────────────────────────────────

  /** Ask the sharer for the subtitles of a share (idempotent per share). */
  request(id: string) {
    const view = this.shares.view(id);
    if (!view) return;
    const peers = this.session.peersOfMember(view.sharer);
    if (peers.length > 0) void this.transport?.send('subs', { t: 'get', shareId: id }, peers);
  }

  /** What arrived so far for a share (null: nothing / none). */
  subtitlesFor(id: string): SubtitlePayload | null {
    return this.incoming.get(id)?.payload ?? null;
  }

  // ── messages ────────────────────────────────────────────────────────────

  private async onMessage(data: unknown, peerId: string) {
    const parsed = relayMessageSchema.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.t === 'get') {
      const share = this.shares.getSnapshot().mine.find((candidate) => candidate.shareId === message.shareId);
      if (!share) return;
      if (!this.askers.has(share.shareId)) this.askers.set(share.shareId, new Set());
      this.askers.get(share.shareId)!.add(peerId);
      const last = this.sent.get(share.shareId);
      const rev = last?.tabId === share.tabId ? last.rev : (last?.rev ?? 0) + 1;
      this.sent.set(share.shareId, { tabId: share.tabId, rev });
      void this.sendTo(share.shareId, share.tabId, rev, [peerId]);
      return;
    }
    // Only the share's sharer may fill it.
    const view = this.shares.view(message.shareId);
    if (!view || this.session.memberOfPeer(peerId) !== view.sharer) return;
    if (message.t === 'manifest') {
      const previous = this.incoming.get(message.shareId);
      if (previous && previous.rev > message.rev) return;
      this.incoming.set(message.shareId, {
        rev: message.rev,
        trackKeys: message.tracks,
        fonts: message.fonts,
        tracks: new Map(),
        fontData: new Map(),
        assembler: createChunkAssembler({ maxPending: 32 }),
        payload: message.tracks.length === 0 ? null : (previous?.rev === message.rev ? previous.payload : null),
      });
      this.emit();
      return;
    }
    const entry = this.incoming.get(message.shareId);
    if (!entry || entry.rev !== message.rev) return;
    const whole = entry.assembler.add(message.chunk);
    if (whole === null) return;
    const key = message.chunk.key;
    if (key.startsWith('track:') && entry.trackKeys.includes(key)) {
      let value: unknown = null;
      try {
        value = JSON.parse(whole);
      } catch {
        return;
      }
      const track = parseSerializedTrack(value);
      if (!track) return;
      entry.tracks.set(key, track);
    } else if (key.startsWith('font:')) {
      const manifest = entry.fonts.find((font) => `font:${font.sha256}` === key);
      if (!manifest) return;
      const bytes = await verifiedFont(manifest, whole);
      if (!bytes || this.incoming.get(message.shareId) !== entry) return;
      entry.fontData.set(manifest.sha256, bytes.slice().buffer);
    } else {
      return;
    }
    entry.payload = {
      tracks: entry.trackKeys.map((trackKey) => entry.tracks.get(trackKey)).filter((track) => track !== undefined),
      fonts: entry.fonts
        .filter((font) => entry.fontData.has(font.sha256))
        .map((font) => ({ name: font.name, data: entry.fontData.get(font.sha256)! })),
    };
    this.emit();
  }

  dispose() {
    for (const off of this.unlisten) off();
  }
}

export { SubtitleRelay };
