/**
 * The wire format shared with talkcode-remote (remote/frame.go — README.md there is the spec):
 *
 *   u32 BE header length · u32 BE body length · header (JSON object) · body (raw bytes)
 *
 * Bodies carry process output and file contents as they are, never base64'd: a chatty agent's
 * stdout is most of what crosses the link, and a third more of it for encoding would buy nothing.
 */

export const MAX_HEADER_BYTES = 1 << 20;
export const MAX_BODY_BYTES = 16 << 20;

/**
 * Every field any frame carries, flat — the mirror of `Header` in frame.go. Unused fields are
 * absent. `s` numbers a sequenced frame, `a` acknowledges the peer's (see link.ts).
 */
export interface FrameHeader {
  t: string;
  s?: number;
  a?: number;
  // hello / welcome
  proto?: number;
  epoch?: string;
  recv?: number;
  version?: string;
  instance?: string;
  resumed?: boolean;
  home?: string;
  pid?: number;
  os?: string;
  arch?: string;
  n?: number;
  // processes
  id?: string;
  cmd?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  unset?: string[];
  fd?: number;
  sig?: string;
  code?: number;
  signal?: string;
  error?: string;
  // one-shot operations
  rid?: string;
  op?: string;
  path?: string;
  max?: number;
  offset?: number;
  append?: boolean;
  grep?: string[];
  fields?: string[];
  mode?: number;
  target?: string;
  requires?: string;
  owned?: string;
  atomic?: boolean;
  bash?: string;
  argv?: string[];
  timeoutMs?: number;
  merge?: boolean;
  res?: unknown;
  // reverse commands
  cid?: string;
  token?: string;
}

export interface Frame {
  h: FrameHeader;
  body: Buffer;
}

export function encodeFrame(h: FrameHeader, body?: Uint8Array): Buffer {
  const hdr = Buffer.from(JSON.stringify(h), 'utf8');
  const len = body?.length ?? 0;
  if (hdr.length > MAX_HEADER_BYTES) throw new Error(`frame header too large (${hdr.length} bytes)`);
  if (len > MAX_BODY_BYTES) throw new Error(`frame body too large (${len} bytes)`);
  const buf = Buffer.allocUnsafe(8 + hdr.length + len);
  buf.writeUInt32BE(hdr.length, 0);
  buf.writeUInt32BE(len, 4);
  hdr.copy(buf, 8);
  if (body && len > 0) Buffer.from(body.buffer, body.byteOffset, len).copy(buf, 8 + hdr.length);
  return buf;
}

/**
 * Incremental decoder: feed it chunks as a stream delivers them, get whole frames back. Throws on
 * a malformed frame — the caller drops the connection, which the reliable layer survives.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];
    for (;;) {
      if (this.buf.length < 8) break;
      const hl = this.buf.readUInt32BE(0);
      const bl = this.buf.readUInt32BE(4);
      if (hl === 0 || hl > MAX_HEADER_BYTES || bl > MAX_BODY_BYTES) {
        throw new Error(`malformed frame: header ${hl} bytes, body ${bl} bytes`);
      }
      if (this.buf.length < 8 + hl + bl) break;
      const h = JSON.parse(this.buf.subarray(8, 8 + hl).toString('utf8')) as unknown;
      if (!h || typeof h !== 'object' || typeof (h as { t?: unknown }).t !== 'string') {
        throw new Error('malformed frame: header is not an object with a type');
      }
      // Copied out, so a retained body does not pin the whole receive buffer.
      const body = Buffer.from(this.buf.subarray(8 + hl, 8 + hl + bl));
      out.push({ h: h as FrameHeader, body });
      this.buf = this.buf.subarray(8 + hl + bl);
    }
    return out;
  }

  /** Bytes buffered but not yet a whole frame. */
  get pending(): number {
    return this.buf.length;
  }
}
