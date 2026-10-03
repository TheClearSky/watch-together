/**
 * Room chat: plain text, to everyone in the room, never stored anywhere (it
 * lives in each open page). The sender is whoever the connection's handshake
 * proved it to be — a message cannot claim another name.
 */
import { chatMessageSchema } from '../share/protocol';
import type { RoomSession } from './session';
import type { TransportRoom } from './transport';

type ChatLine = { id: string; from: string; name: string; text: string; at: number; mine: boolean };

const MAX_LINES = 300;

class RoomChat {
  private lines: ChatLine[] = [];
  private transport: TransportRoom | null = null;
  private unread = 0;
  private readonly listeners = new Set<() => void>();
  private snapshot = { lines: [] as readonly ChatLine[], unread: 0 };
  /** Set by the UI while the chat is visible (no unread count then). */
  visible = false;
  private readonly unlisten: () => void;

  constructor(private readonly session: RoomSession) {
    this.unlisten = session.listen({
      transport: (room) => {
        this.transport = room;
        if (!room) {
          this.lines = [];
          this.unread = 0;
          this.emit();
          return;
        }
        room.on('chat', (data, peerId) => this.receive(data, peerId));
      },
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = { lines: [...this.lines], unread: this.unread };
    for (const listener of this.listeners) listener();
  }

  private push(line: ChatLine) {
    this.lines = [...this.lines, line].slice(-MAX_LINES);
    if (!line.mine && !this.visible) this.unread += 1;
    this.emit();
  }

  private receive(data: unknown, peerId: string) {
    const parsed = chatMessageSchema.safeParse(data);
    const from = this.session.memberOfPeer(peerId);
    if (!parsed.success || !from) return;
    if (this.lines.some((line) => line.id === parsed.data.id && line.from === from)) return;
    this.push({ id: parsed.data.id, from, name: this.session.nameOf(from), text: parsed.data.text, at: parsed.data.at, mine: false });
  }

  send(text: string) {
    const clean = text.trim().slice(0, 2000);
    if (!clean || !this.transport) return;
    const message = { id: Math.random().toString(36).slice(2, 12), text: clean, at: Date.now() };
    void this.transport.send('chat', message);
    const me = this.session.getSnapshot().me;
    this.push({ ...message, from: me.memberId, name: me.name, mine: true });
  }

  markRead() {
    if (this.unread === 0) return;
    this.unread = 0;
    this.emit();
  }

  dispose() {
    this.unlisten();
  }
}

export { RoomChat };
export type { ChatLine };
