/**
 * Embedded subtitles (and their fonts) out of a Matroska/WebM file, fast.
 *
 * WHY OUR OWN: `matroska-subtitles` (MIT) decodes every element through Node
 * streams — measured 62 s for the 1.47 GB Slime S4 episode in Repos/. This
 * scanner reads the file sequentially in large windows but DECODES only what
 * subtitles need: element headers, the Tracks and Attachments sections, and
 * blocks that belong to a subtitle track. Every other element (video/audio
 * frames, cues, tags) is skipped by its size without looking inside.
 *
 * Matroska in one paragraph: the file is a tree of EBML elements, each
 * `ID (1–4 byte vint, marker kept) · size (1–8 byte vint, marker removed;
 * all-ones = unknown) · payload`. Segment → Info (TimestampScale), Tracks →
 * TrackEntry (number, type 0x11 = subtitle, codec, language, name,
 * CodecPrivate = the ASS header), Attachments → AttachedFile (fonts),
 * Cluster (Timestamp) → SimpleBlock | BlockGroup (Block + BlockDuration). A
 * block payload starts with the track number (vint), a signed 16-bit
 * timestamp relative to its cluster, and a flags byte.
 */

type ByteSource = {
  size: number;
  /** Bytes [offset, offset + length), possibly fewer at the end of the file. */
  read(offset: number, length: number): Promise<Uint8Array>;
};

type SubtitleTrack = {
  number: number;
  codec: 'ass' | 'ssa' | 'srt' | 'vtt' | 'other';
  codecId: string;
  language: string | undefined;
  name: string | undefined;
  default: boolean;
  forced: boolean;
  /** The ASS/SSA script header (styles), from CodecPrivate. */
  header: string | undefined;
};

type SubtitleEvent = {
  track: number;
  /** Milliseconds from the start of the media. */
  start: number;
  duration: number | undefined;
  /** Raw block text. For ASS/SSA: `ReadOrder,Layer,Style,Name,MarginL,
   *  MarginR,MarginV,Effect,Text` (see `toAssDialogue`). */
  text: string;
};

type Attachment = { name: string; mimeType: string; data: Uint8Array };

type ScanHandlers = {
  onTracks?(tracks: SubtitleTrack[]): void;
  onAttachment?(attachment: Attachment): void;
  onEvent?(event: SubtitleEvent): void;
  /** Fraction of the file scanned, 0..1 (throttled by the caller). */
  onProgress?(fraction: number): void;
};

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  Attachments: 0x1941a469,
  AttachedFile: 0x61a7,
  FileName: 0x466e,
  FileMimeType: 0x4660,
  FileData: 0x465c,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
} as const;

/** Top-level children of a Segment: an unknown-size Cluster ends where one
 *  of these begins. */
const SEGMENT_CHILDREN = new Set([
  0x114d9b74, // SeekHead
  ID.Info,
  ID.Tracks,
  0x1c53bb6b, // Cues
  ID.Attachments,
  0x1043a770, // Chapters
  0x1254c367, // Tags
  ID.Cluster,
]);

const UNKNOWN = -1;

/** Sequential reader over a large source with a sliding window. */
class Cursor {
  private window: Uint8Array = new Uint8Array(0);
  private windowStart = 0;
  position = 0;

  constructor(
    private readonly source: ByteSource,
    private readonly windowBytes: number,
  ) {}

  get size(): number {
    return this.source.size;
  }

  /** Make bytes [position, position + n) available; false at end of file. */
  private async ensure(n: number): Promise<boolean> {
    const start = this.position - this.windowStart;
    if (start >= 0 && start + n <= this.window.length) return true;
    if (this.position + n > this.source.size) return false;
    const length = Math.max(n, this.windowBytes);
    this.window = await this.source.read(this.position, length);
    this.windowStart = this.position;
    return this.window.length >= n;
  }

  async bytes(n: number): Promise<Uint8Array | null> {
    if (!(await this.ensure(n))) return null;
    const start = this.position - this.windowStart;
    this.position += n;
    return this.window.subarray(start, start + n);
  }

  /** A vint. `keepMarker` for element IDs; sizes drop the marker and map
   *  all-ones to UNKNOWN. */
  async vint(keepMarker: boolean): Promise<{ value: number; length: number } | null> {
    const first = await this.bytes(1);
    if (!first) return null;
    const lead = first[0];
    let length = 1;
    while (length <= 8 && !(lead & (0x80 >> (length - 1)))) length += 1;
    if (length > 8 || (keepMarker && length > 4)) throw new MatroskaError(`Bad vint at ${this.position - 1}`);
    const rest = length > 1 ? await this.bytes(length - 1) : new Uint8Array(0);
    if (!rest) return null;
    let value = keepMarker ? lead : lead & (0xff >> length);
    let allOnes = value === 0xff >> length;
    for (const byte of rest) {
      value = value * 256 + byte;
      if (byte !== 0xff) allOnes = false;
    }
    if (!keepMarker && allOnes) return { value: UNKNOWN, length };
    return { value, length };
  }

  skip(n: number): void {
    this.position += n;
  }
}

class MatroskaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatroskaError';
  }
}

function readUint(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

const utf8 = new TextDecoder('utf-8');
const text = (bytes: Uint8Array) => utf8.decode(bytes).replace(/\0+$/, '');

function codecOf(codecId: string): SubtitleTrack['codec'] {
  if (codecId === 'S_TEXT/ASS' || codecId === 'S_ASS') return 'ass';
  if (codecId === 'S_TEXT/SSA' || codecId === 'S_SSA') return 'ssa';
  if (codecId === 'S_TEXT/UTF8' || codecId === 'S_TEXT/ASCII') return 'srt';
  if (codecId === 'S_TEXT/WEBVTT' || codecId === 'D_WEBVTT/SUBTITLES') return 'vtt';
  return 'other';
}

type Header = { id: number; size: number; dataStart: number };

async function header(cursor: Cursor): Promise<Header | null> {
  const id = await cursor.vint(true);
  if (!id) return null;
  const size = await cursor.vint(false);
  if (!size) return null;
  return { id: id.value, size: size.value, dataStart: cursor.position };
}

/** Children of a KNOWN-size element, fully decoded (small sections only). */
async function children(cursor: Cursor, parent: Header, visit: (child: Header) => Promise<void>): Promise<void> {
  const end = parent.dataStart + parent.size;
  while (cursor.position < end) {
    const child = await header(cursor);
    if (!child) return;
    if (child.size === UNKNOWN) throw new MatroskaError('Unknown size inside a sized element');
    await visit(child);
    cursor.position = child.dataStart + child.size;
  }
}

async function payload(cursor: Cursor, element: Header): Promise<Uint8Array> {
  cursor.position = element.dataStart;
  const bytes = await cursor.bytes(element.size);
  if (!bytes) throw new MatroskaError('Truncated element');
  return bytes;
}

/**
 * Scan `source`, reporting tracks, attachments and subtitle events as they
 * are found. Resolves with everything when the whole file has been read.
 * Throws `MatroskaError` for a file that is not Matroska.
 */
async function scanMatroska(
  source: ByteSource,
  handlers: ScanHandlers = {},
  options: { windowBytes?: number; attachments?: boolean } = {},
): Promise<{ tracks: SubtitleTrack[]; events: SubtitleEvent[]; attachments: Attachment[] }> {
  const cursor = new Cursor(source, options.windowBytes ?? 8 * 1024 * 1024);
  const wantAttachments = options.attachments ?? true;
  const tracks: SubtitleTrack[] = [];
  const events: SubtitleEvent[] = [];
  const attachments: Attachment[] = [];
  const subtitleTracks = new Map<number, SubtitleTrack>();
  let timestampScaleNs = 1_000_000;

  const ebml = await header(cursor);
  if (!ebml || ebml.id !== ID.EBML) throw new MatroskaError('Not a Matroska/WebM file');
  cursor.position = ebml.dataStart + ebml.size;
  const segment = await header(cursor);
  if (!segment || segment.id !== ID.Segment) throw new MatroskaError('No Segment');
  const segmentEnd = segment.size === UNKNOWN ? source.size : Math.min(source.size, segment.dataStart + segment.size);

  const block = async (data: Uint8Array, clusterTime: number, durationTicks: number | undefined) => {
    // Track number (vint, marker removed), int16 relative time, flags.
    let length = 1;
    while (length <= 8 && !(data[0] & (0x80 >> (length - 1)))) length += 1;
    let trackNumber = data[0] & (0xff >> length);
    for (let index = 1; index < length; index += 1) trackNumber = trackNumber * 256 + data[index];
    const track = subtitleTracks.get(trackNumber);
    if (!track) return;
    const relative = (data[length] << 8) | data[length + 1];
    const signed = relative & 0x8000 ? relative - 0x10000 : relative;
    const flags = data[length + 2];
    if (flags & 0x06) return; // laced: never used for text subtitles
    const ticksToMs = timestampScaleNs / 1_000_000;
    const event: SubtitleEvent = {
      track: trackNumber,
      start: (clusterTime + signed) * ticksToMs,
      duration: durationTicks === undefined ? undefined : durationTicks * ticksToMs,
      text: text(data.subarray(length + 3)),
    };
    events.push(event);
    handlers.onEvent?.(event);
  };

  /** Read just enough of a block to see its track; decode only subtitle ones. */
  const peekTrack = async (element: Header): Promise<number> => {
    cursor.position = element.dataStart;
    const lead = await cursor.bytes(1);
    if (!lead) return -1;
    let length = 1;
    while (length <= 8 && !(lead[0] & (0x80 >> (length - 1)))) length += 1;
    let value = lead[0] & (0xff >> length);
    if (length > 1) {
      const rest = await cursor.bytes(length - 1);
      if (!rest) return -1;
      for (const byte of rest) value = value * 256 + byte;
    }
    return value;
  };

  let lastProgress = 0;
  while (cursor.position < segmentEnd) {
    const element = await header(cursor);
    if (!element) break;
    const end = element.size === UNKNOWN ? segmentEnd : element.dataStart + element.size;
    if (element.id === ID.Info && element.size !== UNKNOWN) {
      await children(cursor, element, async (child) => {
        if (child.id === ID.TimestampScale) timestampScaleNs = readUint(await payload(cursor, child)) || 1_000_000;
      });
    } else if (element.id === ID.Tracks && element.size !== UNKNOWN) {
      await children(cursor, element, async (entry) => {
        if (entry.id !== ID.TrackEntry) return;
        const track: Partial<SubtitleTrack> & { type?: number } = { default: true, forced: false };
        await children(cursor, entry, async (field) => {
          const bytes = await payload(cursor, field);
          switch (field.id) {
            case ID.TrackNumber: track.number = readUint(bytes); break;
            case ID.TrackType: track.type = readUint(bytes); break;
            case ID.CodecID: track.codecId = text(bytes); break;
            case ID.CodecPrivate: track.header = text(bytes); break;
            case ID.Language: track.language ??= text(bytes); break;
            case ID.LanguageBCP47: track.language = text(bytes); break;
            case ID.Name: track.name = text(bytes); break;
            case ID.FlagDefault: track.default = readUint(bytes) === 1; break;
            case ID.FlagForced: track.forced = readUint(bytes) === 1; break;
          }
        });
        if (track.type === 0x11 && track.number !== undefined && track.codecId !== undefined) {
          const full: SubtitleTrack = {
            number: track.number,
            codec: codecOf(track.codecId),
            codecId: track.codecId,
            language: track.language === 'und' ? undefined : track.language,
            name: track.name,
            default: track.default ?? true,
            forced: track.forced ?? false,
            header: track.header,
          };
          tracks.push(full);
          subtitleTracks.set(full.number, full);
        }
      });
      handlers.onTracks?.(tracks);
    } else if (element.id === ID.Attachments && element.size !== UNKNOWN && wantAttachments) {
      await children(cursor, element, async (file) => {
        if (file.id !== ID.AttachedFile) return;
        const attachment: Partial<Attachment> = {};
        await children(cursor, file, async (field) => {
          if (field.id === ID.FileName) attachment.name = text(await payload(cursor, field));
          else if (field.id === ID.FileMimeType) attachment.mimeType = text(await payload(cursor, field));
          else if (field.id === ID.FileData) attachment.data = (await payload(cursor, field)).slice();
        });
        if (attachment.name && attachment.data) {
          const full = { name: attachment.name, mimeType: attachment.mimeType ?? 'application/octet-stream', data: attachment.data };
          attachments.push(full);
          handlers.onAttachment?.(full);
        }
      });
    } else if (element.id === ID.Cluster) {
      if (subtitleTracks.size === 0 && tracks.length === 0 && element.size !== UNKNOWN) {
        // Tracks always precede clusters; no subtitle tracks → nothing to find.
      }
      let clusterTime = 0;
      cursor.position = element.dataStart;
      while (cursor.position < end) {
        const childStart = cursor.position;
        const child = await header(cursor);
        if (!child) break;
        if (element.size === UNKNOWN && SEGMENT_CHILDREN.has(child.id)) {
          // An unknown-size cluster ends where the next top-level element starts.
          cursor.position = childStart;
          break;
        }
        const childEnd = child.dataStart + child.size;
        if (child.id === ID.Timestamp) {
          clusterTime = readUint(await payload(cursor, child));
        } else if (child.id === ID.SimpleBlock) {
          if (subtitleTracks.has(await peekTrack(child))) await block(await payload(cursor, child), clusterTime, undefined);
        } else if (child.id === ID.BlockGroup && child.size !== UNKNOWN) {
          let blockData: Uint8Array | null = null;
          let duration: number | undefined;
          await children(cursor, child, async (part) => {
            if (part.id === ID.Block) {
              if (subtitleTracks.has(await peekTrack(part))) blockData = (await payload(cursor, part)).slice();
            } else if (part.id === ID.BlockDuration) {
              duration = readUint(await payload(cursor, part));
            }
          });
          if (blockData) await block(blockData, clusterTime, duration);
        }
        cursor.position = childEnd;
      }
      if (element.size !== UNKNOWN) cursor.position = end;
    }
    if (element.size !== UNKNOWN && element.id !== ID.Cluster) cursor.position = end;
    if (element.size === UNKNOWN && element.id !== ID.Cluster) break; // cannot skip an unknown-size non-cluster
    const fraction = cursor.position / source.size;
    if (fraction - lastProgress >= 0.01) {
      lastProgress = fraction;
      handlers.onProgress?.(fraction);
    }
  }
  handlers.onProgress?.(1);
  return { tracks, events, attachments };
}

/** A Matroska ASS block (`ReadOrder,Layer,Style,…,Text`) as a script line. */
function toAssDialogue(event: SubtitleEvent): string {
  const fields = event.text.split(',');
  const [, layer = '0', ...rest] = fields; // drop ReadOrder
  // Style, Name, MarginL, MarginR, MarginV, Effect, then Text (may contain commas).
  const head = rest.slice(0, 6);
  const body = rest.slice(6).join(',');
  const stamp = (ms: number) => {
    const cs = Math.round(ms / 10);
    const h = Math.floor(cs / 360000);
    const m = Math.floor((cs % 360000) / 6000);
    const s = Math.floor((cs % 6000) / 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  const end = event.start + (event.duration ?? 0);
  return `Dialogue: ${layer},${stamp(event.start)},${stamp(end)},${head.join(',')},${body}`;
}

/** A `Blob`/`File` as a ByteSource. */
function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

export { blobSource, MatroskaError, scanMatroska, toAssDialogue };
export type { Attachment, ByteSource, ScanHandlers, SubtitleEvent, SubtitleTrack };
