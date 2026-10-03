/**
 * "Save a copy" of someone's shared video (Q7: "offer downloading from player
 * which sends a request to the streamer, creating local copy").
 *
 *   viewer ── download request ──► sharer: "Asha wants a copy (1.4 GB) [Allow]"
 *          ◄── answer {name, size} ──
 *   both open a NEGOTIATED data channel with the agreed id on their existing
 *   RTCPeerConnection (it cannot clobber Trystero's own channel — R2 R1),
 *   then fileTransfer.ts moves the bytes, verified block by block.
 *
 * The copy goes into the viewer's LIBRARY: the linked folder (upgraded to
 * read & write on first use — ruling D3) or, without a folder, the in-browser
 * library (OPFS-backed for videos). It is written as `<name>.part` (hidden by
 * the app's policy) and renamed when complete, so a half-finished copy never
 * looks like a video. A dropped connection keeps the verified part.
 */
import { z } from 'zod';
import type { FileLibrary, Workspace } from '@theclearsky/easy-folder-management-ui';
import type { Room as TrysteroRoom } from '@trystero-p2p/core';
import type { RoomSession } from '../room/session';
import type { TransportRoom } from '../room/transport';
import type { ShareController } from '../share/shareController';
import type { ByteSink, ChannelLike } from './fileTransfer';
import { receiveFile, sendFile, TransferError } from './fileTransfer';

type TransferView = {
  id: string;
  direction: 'in' | 'out';
  shareId: string;
  peerName: string;
  name: string;
  size: number;
  done: number;
  /** Bytes per second, smoothed. */
  rate: number;
  status: 'asking' | 'transferring' | 'saving' | 'done' | 'failed' | 'declined' | 'cancelled';
  error: string | null;
  /** The saved copy's library id (incoming, done). */
  fileId: string | null;
};

const messageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('request'), id: z.string().max(24), shareId: z.string().max(24), channelId: z.number().int().min(1000).max(65000) }),
  z.object({ t: z.literal('answer'), id: z.string().max(24), accept: z.boolean(), name: z.string().max(300).optional(), size: z.number().nonnegative().optional() }),
  z.object({ t: z.literal('cancel'), id: z.string().max(24) }),
]);

/** While the same viewer also watches the stream, leave room for the video. */
const SHARED_LINK_LIMIT = 6 * 1024 * 1024;

function newId(): string {
  return Math.random().toString(36).slice(2, 12);
}

function openChannel(media: TrysteroRoom | null, peerId: string, channelId: number): RTCDataChannel | null {
  const connection = media?.getPeers()[peerId];
  if (!connection) return null;
  return connection.createDataChannel(`wt-file-${channelId}`, { negotiated: true, id: channelId, ordered: true });
}

/** A ByteSink that feeds a ReadableStream (the library writes from it). */
function pipeSink(): { sink: ByteSink; readable: ReadableStream<Uint8Array> } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  return {
    readable,
    sink: { write: (chunk) => writer.write(chunk), close: () => writer.close(), abort: (reason) => writer.abort(reason) },
  };
}

class Downloads {
  private transport: TransportRoom | null = null;
  private readonly transfers = new Map<string, TransferView & { channel?: RTCDataChannel; abort?: AbortController; peerId?: string; channelId?: number }>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly TransferView[] = [];
  private readonly unlisten: () => void;
  /** Sharer side: someone asks; the app shows Allow / Decline. */
  onRequest: ((transfer: TransferView) => void) | null = null;
  /** Viewer side: a copy finished. */
  onSaved: ((transfer: TransferView) => void) | null = null;

  constructor(
    private readonly session: RoomSession,
    private readonly shares: ShareController,
    private readonly library: FileLibrary,
    private readonly workspace: Workspace<unknown, never> | { setFolderAccess(access: 'read' | 'readwrite'): Promise<boolean> },
  ) {
    this.unlisten = session.listen({
      transport: (room) => {
        this.transport = room;
        if (room) room.on('download', (data, peerId) => this.onMessage(data, peerId));
        else for (const transfer of this.transfers.values()) this.cancel(transfer.id, { silent: true });
      },
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = [...this.transfers.values()].map(({ channel: _c, abort: _a, peerId: _p, channelId: _i, ...view }) => view);
    for (const listener of this.listeners) listener();
  }

  private update(id: string, patch: Partial<TransferView>) {
    const transfer = this.transfers.get(id);
    if (!transfer) return;
    Object.assign(transfer, patch);
    this.emit();
  }

  private get media(): TrysteroRoom | null {
    return (this.transport?.media as TrysteroRoom | null) ?? null;
  }

  dismiss(id: string) {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.status === 'transferring' || transfer.status === 'asking') return;
    this.transfers.delete(id);
    this.emit();
  }

  // ── viewer ──────────────────────────────────────────────────────────────

  /** Can the library take a copy right now (writable, or upgradable)? */
  canSave(): boolean {
    const kind = this.library.mode.kind;
    return kind === 'memory' || kind === 'folder';
  }

  /**
   * Ask the sharer for a copy. Call from a click: a read-only linked folder
   * is upgraded to read & write first, and the browser's prompt needs the
   * click.
   */
  async request(shareId: string): Promise<void> {
    const view = this.shares.view(shareId);
    const peerId = this.shares.sharerPeerOf(shareId);
    if (!view || !peerId || !this.canSave()) return;
    if (this.library.mode.kind === 'folder' && !this.library.writable) {
      const ok = await this.workspace.setFolderAccess('readwrite');
      if (!ok || !this.library.writable) {
        const id = newId();
        this.transfers.set(id, this.blank(id, 'in', shareId, view.sharerName, view.title, view.fingerprint?.size ?? 0, 'failed'));
        this.update(id, { error: 'Saving needs permission to write to your linked folder.' });
        return;
      }
    }
    const id = newId();
    const channelId = 1000 + Math.floor(Math.random() * 60000);
    const channel = openChannel(this.media, peerId, channelId);
    if (!channel) return;
    this.transfers.set(id, {
      ...this.blank(id, 'in', shareId, view.sharerName, view.title, view.fingerprint?.size ?? 0, 'asking'),
      channel,
      peerId,
      channelId,
    });
    this.emit();
    void this.transport?.send('download', { t: 'request', id, shareId, channelId }, peerId);
  }

  private blank(
    id: string,
    direction: 'in' | 'out',
    shareId: string,
    peerName: string,
    name: string,
    size: number,
    status: TransferView['status'],
  ): TransferView {
    return { id, direction, shareId, peerName, name, size, done: 0, rate: 0, status, error: null, fileId: null };
  }

  private async receive(id: string, name: string, size: number) {
    const transfer = this.transfers.get(id);
    if (!transfer?.channel) return;
    const abort = new AbortController();
    transfer.abort = abort;
    this.update(id, { status: 'transferring', name, size });
    const { sink, readable } = pipeSink();
    const parentId = this.library.tree.rootId;
    let partId: string | null = null;
    const saving = this.library.createFile(parentId, `${name}.part`, readable).then((created) => (partId = created));
    let last = { at: performance.now(), done: 0 };
    try {
      await receiveFile(transfer.channel as unknown as ChannelLike, sink, {
        size,
        signal: abort.signal,
        onProgress: (done) => {
          const now = performance.now();
          const rate = now - last.at > 400 ? ((done - last.done) / (now - last.at)) * 1000 : transfer.rate;
          if (now - last.at > 400) last = { at: now, done };
          this.update(id, { done, rate });
        },
      });
      await saving;
      this.update(id, { status: 'saving' });
      // Complete and verified: give it its real name (made unique if taken).
      const finalName = await this.freeName(parentId, name);
      await this.library.rename(partId!, finalName);
      this.update(id, { status: 'done', fileId: partId });
      this.onSaved?.(this.transfers.get(id)!);
    } catch (error) {
      await saving.catch(() => {});
      const cancelled = abort.signal.aborted;
      if (cancelled && partId) await this.library.remove([partId]).catch(() => {});
      this.update(id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : error instanceof TransferError ? error.message : String(error),
      });
    } finally {
      transfer.channel?.close();
    }
  }

  private async freeName(parentId: string, desired: string): Promise<string> {
    const taken = new Set(
      (this.library.tree.children[parentId] ?? []).map((childId) => this.library.tree.nodes[childId]?.name.toLowerCase()),
    );
    if (!taken.has(desired.toLowerCase())) return desired;
    const dot = desired.lastIndexOf('.');
    const stem = dot > 0 ? desired.slice(0, dot) : desired;
    const extension = dot > 0 ? desired.slice(dot) : '';
    for (let counter = 2; ; counter += 1) {
      const candidate = `${stem} (${counter})${extension}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // ── sharer ──────────────────────────────────────────────────────────────

  accept(id: string) {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.direction !== 'out' || transfer.status !== 'asking' || !transfer.peerId || !transfer.channelId) return;
    const file = this.shares.fileForShare(transfer.shareId);
    if (!file) {
      this.decline(id);
      return;
    }
    const channel = openChannel(this.media, transfer.peerId, transfer.channelId);
    if (!channel) return;
    transfer.channel = channel;
    const abort = new AbortController();
    transfer.abort = abort;
    this.update(id, { status: 'transferring', name: file.name, size: file.size });
    void this.transport?.send('download', { t: 'answer', id, accept: true, name: file.name, size: file.size }, transfer.peerId);
    const peerId = transfer.peerId;
    let last = { at: performance.now(), done: 0 };
    void sendFile(file, channel as unknown as ChannelLike, {
      signal: abort.signal,
      maxBytesPerSecond: () => (this.shares.isStreamingTo(transfer.shareId, peerId) ? SHARED_LINK_LIMIT : null),
      onProgress: (done) => {
        const now = performance.now();
        const rate = now - last.at > 400 ? ((done - last.done) / (now - last.at)) * 1000 : transfer.rate;
        if (now - last.at > 400) last = { at: now, done };
        this.update(id, { done, rate });
      },
    }).then(
      () => this.update(id, { status: 'done' }),
      (error) =>
        this.update(id, {
          status: abort.signal.aborted ? 'cancelled' : 'failed',
          error: abort.signal.aborted ? null : String(error instanceof Error ? error.message : error),
        }),
    );
  }

  decline(id: string) {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.direction !== 'out' || !transfer.peerId) return;
    void this.transport?.send('download', { t: 'answer', id, accept: false }, transfer.peerId);
    this.update(id, { status: 'declined' });
  }

  cancel(id: string, options: { silent?: boolean } = {}) {
    const transfer = this.transfers.get(id);
    if (!transfer) return;
    // The sharer dismissing a request they have not answered is a "no".
    if (transfer.direction === 'out' && transfer.status === 'asking' && !options.silent) {
      this.decline(id);
      return;
    }
    transfer.abort?.abort();
    transfer.channel?.close();
    if (!options.silent && transfer.peerId) void this.transport?.send('download', { t: 'cancel', id }, transfer.peerId);
    if (transfer.status === 'asking') this.update(id, { status: 'cancelled' });
  }

  // ── messages ────────────────────────────────────────────────────────────

  private onMessage(data: unknown, peerId: string) {
    const parsed = messageSchema.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.t === 'request') {
      const file = this.shares.fileForShare(message.shareId);
      const from = this.session.memberOfPeer(peerId);
      if (!file || !from) {
        void this.transport?.send('download', { t: 'answer', id: message.id, accept: false }, peerId);
        return;
      }
      this.transfers.set(message.id, {
        ...this.blank(message.id, 'out', message.shareId, this.session.nameOf(from), file.name, file.size, 'asking'),
        peerId,
        channelId: message.channelId,
      });
      this.emit();
      this.onRequest?.(this.transfers.get(message.id)!);
      return;
    }
    const transfer = this.transfers.get(message.id);
    if (!transfer || transfer.peerId !== peerId) return;
    if (message.t === 'answer') {
      if (!message.accept) {
        transfer.channel?.close();
        this.update(message.id, { status: 'declined' });
      } else {
        void this.receive(message.id, message.name ?? transfer.name, message.size ?? transfer.size);
      }
    } else {
      transfer.abort?.abort();
      transfer.channel?.close();
      if (transfer.status === 'asking') this.update(message.id, { status: 'cancelled' });
    }
  }

  dispose() {
    this.unlisten();
  }
}

export { Downloads };
export type { TransferView };
