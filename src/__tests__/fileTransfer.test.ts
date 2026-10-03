import { describe, expect, it } from 'vitest';
import { BLOCK_BYTES, receiveFile, sendFile, TransferError } from '../transfer/fileTransfer';
import type { ByteSink, ChannelLike } from '../transfer/fileTransfer';

type FakeChannel = {
  readyState: RTCDataChannelState;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  peer: FakeChannel | null;
  maxBuffered: number;
  sentBytes: number;
  send(data: ArrayBuffer | string): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  emit(type: string, event: Event): void;
  close(): void;
};

/** Byte-array equality without vitest's element-by-element deep diff (which
 *  takes tens of seconds on 8 MB). */
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** Two connected fake data channels with a real-ish buffer + backpressure. */
function channelPair(options: { corruptAt?: number; closeAfterBytes?: number } = {}) {
  const make = (): FakeChannel => {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const channel: FakeChannel = {
      readyState: 'open' as RTCDataChannelState,
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      binaryType: 'arraybuffer' as BinaryType,
      peer: null as null | ReturnType<typeof make>,
      maxBuffered: 0,
      sentBytes: 0,
      send(data: ArrayBuffer | string) {
        // Like RTCDataChannel: sending on a closed channel throws.
        if (channel.readyState !== 'open') throw new DOMException('closed', 'InvalidStateError');
        const size = typeof data === 'string' ? data.length : data.byteLength;
        channel.bufferedAmount += size;
        channel.maxBuffered = Math.max(channel.maxBuffered, channel.bufferedAmount);
        channel.sentBytes += size;
        let payload: ArrayBuffer | string = data;
        if (typeof data !== 'string' && options.corruptAt !== undefined) {
          const at = new DataView(data).getFloat64(0);
          if (at <= options.corruptAt && options.corruptAt < at + data.byteLength - 8) {
            payload = data.slice(0);
            new Uint8Array(payload)[8 + options.corruptAt - at] ^= 0xff;
          }
        }
        setTimeout(() => {
          channel.bufferedAmount -= size;
          channel.peer?.emit('message', new MessageEvent('message', { data: payload }));
          if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) channel.emit('bufferedamountlow', new Event('bufferedamountlow'));
          if (options.closeAfterBytes !== undefined && channel.sentBytes > options.closeAfterBytes && channel.readyState === 'open') {
            channel.close();
          }
        }, 0);
      },
      addEventListener(type: string, listener: (event: Event) => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener(type: string, listener: (event: Event) => void) {
        listeners.get(type)?.delete(listener);
      },
      emit(type: string, event: Event) {
        listeners.get(type)?.forEach((listener) => listener(event));
      },
      close() {
        channel.readyState = 'closed';
        channel.emit('close', new Event('close'));
        if (channel.peer && channel.peer.readyState !== 'closed') channel.peer.close();
      },
    };
    return channel;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return { sender: a, receiver: b };
}

function memorySink() {
  const parts: Uint8Array[] = [];
  let closed = false;
  let aborted = false;
  const sink: ByteSink = {
    async write(chunk) {
      parts.push(chunk.slice());
    },
    async close() {
      closed = true;
    },
    async abort() {
      aborted = true;
    },
  };
  const bytes = () => {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  };
  return { sink, bytes, state: () => ({ closed, aborted }) };
}

const data = (size: number) => {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) out[index] = (index * 31 + 7) % 251;
  return out;
};

describe('file transfer', () => {
  it('moves a multi-block file byte for byte, never buffering more than ~4 MiB', async () => {
    const source = data(BLOCK_BYTES * 2 + 12345);
    const { sender, receiver } = channelPair();
    const sink = memorySink();
    const progress: number[] = [];
    const receiving = receiveFile(receiver as unknown as ChannelLike, sink.sink, {
      size: source.byteLength,
      onProgress: (done) => progress.push(done),
    });
    await sendFile(new Blob([source]), sender as unknown as ChannelLike);
    expect(await receiving).toBe(source.byteLength);
    expect(same(sink.bytes(), source)).toBe(true);
    expect(sink.state().closed).toBe(true);
    expect(progress).toEqual([BLOCK_BYTES, BLOCK_BYTES * 2, source.byteLength]);
    expect(sender.maxBuffered).toBeLessThanOrEqual(4 * 1024 * 1024 + 64 * 1024 + 100);
  });

  it('a corrupted byte fails the block and nothing of it is written', async () => {
    const source = data(BLOCK_BYTES + 1000);
    const { sender, receiver } = channelPair({ corruptAt: BLOCK_BYTES + 10 });
    const sink = memorySink();
    const receiving = receiveFile(receiver as unknown as ChannelLike, sink.sink, { size: source.byteLength });
    void sendFile(new Blob([source]), sender as unknown as ChannelLike).catch(() => {});
    const error = await receiving.catch((reason: TransferError) => reason);
    expect(String(error)).toMatch(/integrity/);
    // The first (good) block was committed; the corrupted second one never
    // reached the sink, and a retry resumes right there.
    expect(sink.bytes().byteLength).toBe(BLOCK_BYTES);
    expect(sink.state()).toEqual({ closed: true, aborted: false });
    expect((error as TransferError).resumeAt).toBe(BLOCK_BYTES);
  });

  it('a dropped connection fails clearly (the partial file can be resumed)', async () => {
    const source = data(BLOCK_BYTES * 2);
    const { sender, receiver } = channelPair({ closeAfterBytes: BLOCK_BYTES + 200_000 });
    const sink = memorySink();
    const receiving = receiveFile(receiver as unknown as ChannelLike, sink.sink, { size: source.byteLength });
    await expect(sendFile(new Blob([source]), sender as unknown as ChannelLike)).rejects.toThrow(TransferError);
    const error = await receiving.catch((reason: TransferError) => reason);
    expect(String(error)).toMatch(/closed/);
    expect(sink.bytes().byteLength).toBe(BLOCK_BYTES); // the first verified block is committed
    expect((error as TransferError).resumeAt).toBe(BLOCK_BYTES);
  });

  it('cancelling discards the partial copy', async () => {
    const source = data(BLOCK_BYTES * 2);
    const { sender, receiver } = channelPair();
    const sink = memorySink();
    const controller = new AbortController();
    const receiving = receiveFile(receiver as unknown as ChannelLike, sink.sink, {
      size: source.byteLength,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    void sendFile(new Blob([source]), sender as unknown as ChannelLike).catch(() => {});
    const error = await receiving.catch((reason: TransferError) => reason);
    expect(String(error)).toMatch(/Cancelled/);
    expect(sink.state().aborted).toBe(true);
  });

  it('resumes from a block boundary', async () => {
    const source = data(BLOCK_BYTES * 2 + 5);
    const { sender, receiver } = channelPair();
    const sink = memorySink();
    const receiving = receiveFile(receiver as unknown as ChannelLike, sink.sink, { size: source.byteLength, offset: BLOCK_BYTES });
    await sendFile(new Blob([source]), sender as unknown as ChannelLike, { offset: BLOCK_BYTES });
    expect(await receiving).toBe(BLOCK_BYTES + 5);
    expect(same(sink.bytes(), source.slice(BLOCK_BYTES))).toBe(true);
    await expect(sendFile(new Blob([source]), sender as unknown as ChannelLike, { offset: 10 })).rejects.toThrow(/block boundary/);
  });
});
