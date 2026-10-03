/**
 * Moving a multi-GB file over ONE RTCDataChannel, peer to peer (Q7:
 * "offer downloading from player which sends a request to the streamer,
 * creating local copy").
 *
 * Why not Trystero's binary actions (research R2 §1.1): they load the whole
 * file into memory, pre-build every chunk, and silently truncate a send that
 * stalls 10 s. So: our own negotiated channel (R2 R1), and this:
 *
 *  - 64 KiB messages (Chromium's max message is 256 KiB, and a 1 MiB send
 *    CLOSES the channel — measured in R2); each binary message is an 8-byte
 *    offset header + bytes.
 *  - Backpressure: stop queueing above 4 MiB buffered, resume at 1 MiB
 *    (`bufferedamountlow`) — never "send queue is full".
 *  - Integrity: after every 4 MiB block the sender sends the block's SHA-256
 *    (WebCrypto, ~1 GB/s — R2 R5). The receiver holds at most one block in
 *    memory, verifies it, and only THEN writes it — corrupted bytes never
 *    reach the disk. A mismatch fails the transfer.
 *  - Resume: a transfer can start at any block boundary (`offset`).
 *  - Optional rate limit (the same connection may also carry the video).
 */

const CHUNK_BYTES = 64 * 1024;
const BLOCK_BYTES = 4 * 1024 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const HEADER_BYTES = 8;

/** The part of RTCDataChannel this uses (tests pass a fake). */
interface ChannelLike {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  send(data: ArrayBuffer | string): void;
  addEventListener(type: 'open' | 'close' | 'message' | 'bufferedamountlow' | 'error', listener: (event: Event) => void): void;
  removeEventListener(type: 'open' | 'close' | 'message' | 'bufferedamountlow' | 'error', listener: (event: Event) => void): void;
  close(): void;
}

/** Where received bytes go, in order. */
interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: unknown): Promise<void>;
}

type Progress = (done: number, total: number) => void;

class TransferError extends Error {
  /** Bytes safely on disk (verified) — where a retry can resume. */
  resumeAt: number | null = null;
  constructor(message: string) {
    super(message);
    this.name = 'TransferError';
  }
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function waitOpen(channel: ChannelLike, signal?: AbortSignal): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new TransferError('The connection closed before the transfer started.'));
    };
    const onAbort = () => {
      cleanup();
      reject(new TransferError('Cancelled.'));
    };
    const cleanup = () => {
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
    signal?.addEventListener('abort', onAbort);
  });
}

function drained(channel: ChannelLike, signal?: AbortSignal): Promise<void> {
  if (channel.bufferedAmount <= HIGH_WATER) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new TransferError(signal?.aborted ? 'Cancelled.' : 'The connection closed during the transfer.'));
    };
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', fail);
      signal?.removeEventListener('abort', fail);
    };
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', fail);
    signal?.addEventListener('abort', fail);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send `file` from `offset` (a block boundary). Resolves when all is queued. */
async function sendFile(
  file: Blob,
  channel: ChannelLike,
  options: { offset?: number; signal?: AbortSignal; onProgress?: Progress; maxBytesPerSecond?: () => number | null } = {},
): Promise<void> {
  const offset = options.offset ?? 0;
  if (offset % BLOCK_BYTES !== 0) throw new TransferError('A transfer can only resume at a block boundary.');
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = LOW_WATER;
  await waitOpen(channel, options.signal);
  let windowStart = performance.now();
  let windowBytes = 0;
  for (let blockStart = offset; blockStart < file.size; blockStart += BLOCK_BYTES) {
    if (options.signal?.aborted) throw new TransferError('Cancelled.');
    const block = await file.slice(blockStart, Math.min(file.size, blockStart + BLOCK_BYTES)).arrayBuffer();
    const hash = hex(await crypto.subtle.digest('SHA-256', block));
    for (let at = 0; at < block.byteLength; at += CHUNK_BYTES) {
      if (channel.readyState !== 'open') throw new TransferError('The connection closed during the transfer.');
      await drained(channel, options.signal);
      const piece = new Uint8Array(block, at, Math.min(CHUNK_BYTES, block.byteLength - at));
      const message = new ArrayBuffer(HEADER_BYTES + piece.byteLength);
      new DataView(message).setFloat64(0, blockStart + at);
      new Uint8Array(message, HEADER_BYTES).set(piece);
      channel.send(message);
      // Rate limit (bytes per second), measured over 1 s windows.
      const limit = options.maxBytesPerSecond?.() ?? null;
      windowBytes += piece.byteLength;
      if (limit) {
        const elapsed = performance.now() - windowStart;
        if (windowBytes >= limit && elapsed < 1000) await sleep(1000 - elapsed);
        if (performance.now() - windowStart >= 1000) {
          windowStart = performance.now();
          windowBytes = 0;
        }
      }
    }
    channel.send(JSON.stringify({ t: 'block', start: blockStart, size: block.byteLength, hash }));
    options.onProgress?.(Math.min(file.size, blockStart + block.byteLength), file.size);
  }
  channel.send(JSON.stringify({ t: 'end', size: file.size }));
  // "Sent" means handed to the network, not merely queued: wait for the
  // buffer to empty, and fail if the connection closes first.
  await flushed(channel, options.signal);
}

function flushed(channel: ChannelLike, signal?: AbortSignal): Promise<void> {
  if (channel.bufferedAmount === 0) return Promise.resolve();
  channel.bufferedAmountLowThreshold = 0;
  return new Promise((resolve, reject) => {
    const done = () => {
      if (channel.bufferedAmount > 0) return;
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new TransferError(signal?.aborted ? 'Cancelled.' : 'The connection closed before the file was fully sent.'));
    };
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', fail);
      signal?.removeEventListener('abort', fail);
    };
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', fail);
    signal?.addEventListener('abort', fail);
  });
}

/**
 * Receive into `sink` until the sender's end message; every block verified
 * before it is written. Resolves with the bytes written (from `offset`).
 *
 * On failure the sink is CLOSED, not aborted: a browser file writable
 * discards everything since it was opened when aborted, which would throw
 * away gigabytes of verified data. Closing commits the verified blocks, and
 * the error's `resumeAt` says where to continue. (Only `signal` — the user
 * cancelling — aborts.)
 */
function receiveFile(
  channel: ChannelLike,
  sink: ByteSink,
  options: { size: number; offset?: number; signal?: AbortSignal; onProgress?: Progress },
): Promise<number> {
  const offset = options.offset ?? 0;
  channel.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    let expected = offset;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let written = offset;
    let queue: Promise<void> = Promise.resolve();
    let finished = false;
    // Set the moment the user cancels: queued steps (block writes, the final
    // close) must not run after that. (After a dropped connection, verified
    // blocks still queued DO land — they are what a retry resumes from; an
    // integrity failure rejects the queue, which skips everything after it.)
    let cancelledNow = false;

    const fail = (error: unknown, cancelled = false) => {
      if (finished) return;
      finished = true;
      if (cancelled) cancelledNow = true;
      cleanup();
      const failure = error instanceof TransferError ? error : new TransferError(String(error));
      // Let verified blocks still in flight land, then commit (or, when the
      // user cancelled, discard).
      void queue
        .catch(() => {})
        .then(() => (cancelled ? sink.abort(failure) : sink.close()))
        .catch(() => {})
        .then(() => {
          failure.resumeAt = cancelled ? null : written;
          reject(failure);
        });
    };
    const onMessage = (event: Event) => {
      if (finished) return;
      const data = (event as MessageEvent).data as ArrayBuffer | string;
      if (typeof data !== 'string') {
        const at = new DataView(data).getFloat64(0);
        if (at !== expected) return fail(new TransferError(`Out-of-order data at byte ${at} (expected ${expected}).`));
        const piece = new Uint8Array(data, HEADER_BYTES);
        pending.push(piece);
        pendingBytes += piece.byteLength;
        expected += piece.byteLength;
        if (pendingBytes > BLOCK_BYTES) return fail(new TransferError('A block was larger than allowed.'));
        return;
      }
      let message: { t?: string; start?: number; size?: number; hash?: string };
      try {
        message = JSON.parse(data) as typeof message;
      } catch {
        return fail(new TransferError('Unreadable control message.'));
      }
      if (message.t === 'block') {
        const blockParts = pending;
        const blockBytes = pendingBytes;
        pending = [];
        pendingBytes = 0;
        if (blockBytes !== message.size) return fail(new TransferError('A block arrived incomplete.'));
        queue = queue.then(async () => {
          if (cancelledNow) return;
          const block = new Uint8Array(blockBytes);
          let at = 0;
          for (const part of blockParts) {
            block.set(part, at);
            at += part.byteLength;
          }
          const hash = hex(await crypto.subtle.digest('SHA-256', block));
          if (hash !== message.hash) throw new TransferError('A block failed its integrity check — the copy was not kept.');
          if (cancelledNow) return;
          await sink.write(block);
          written += blockBytes;
          options.onProgress?.(written, options.size);
        });
        queue.catch(fail);
      } else if (message.t === 'end') {
        queue = queue.then(async () => {
          if (cancelledNow) return;
          if (written !== options.size || message.size !== options.size) {
            throw new TransferError(`The transfer ended early (${written} of ${options.size} bytes).`);
          }
          await sink.close();
          finished = true;
          cleanup();
          resolve(written - offset);
        });
        queue.catch(fail);
      }
    };
    const onClose = () => {
      if (!finished) fail(new TransferError('The connection closed during the transfer.'));
    };
    const onAbort = () => fail(new TransferError('Cancelled.'), true);
    const cleanup = () => {
      channel.removeEventListener('message', onMessage);
      channel.removeEventListener('close', onClose);
      options.signal?.removeEventListener('abort', onAbort);
    };
    channel.addEventListener('message', onMessage);
    channel.addEventListener('close', onClose);
    options.signal?.addEventListener('abort', onAbort);
  });
}

/** A ByteSink over a WritableStream (an OPFS / File System Access writable). */
function streamSink(writable: WritableStream<Uint8Array> | FileSystemWritableFileStream): ByteSink {
  const writer = (writable as WritableStream<Uint8Array>).getWriter();
  return {
    write: (chunk) => writer.write(chunk),
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  };
}

export { BLOCK_BYTES, CHUNK_BYTES, receiveFile, sendFile, streamSink, TransferError };
export type { ByteSink, ChannelLike, Progress };
