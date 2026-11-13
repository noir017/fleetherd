/**
 * Server-sent events, parsed from bytes.
 *
 * The Interactions API streams `event: <name>` / `data: <json>` frames separated by blank lines,
 * and ends with `data: [DONE]` (recorded 2026-11-13, `project-scripts/antigravity-agent-probe`).
 * This is the subset of the SSE spec that stream uses: `data` lines joined with newlines, a
 * leading space after the colon dropped, `:` comment lines ignored, and frames dispatched on the
 * blank line. `id`/`retry` are accepted and ignored — reconnection here replays from the start
 * and counts frames, so a last-event id would be a second, competing cursor.
 */

export interface SseFrame {
  /** The `event:` field; `message` when absent, as the spec says. */
  event: string;
  /** The `data:` field(s), joined. */
  data: string;
}

/** Parse a complete SSE document. Used by tests and by any non-streaming caller. */
export function parseSseText(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  let event = '';
  let data: string[] = [];
  const dispatch = (): void => {
    if (data.length === 0) return;
    frames.push({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatch();
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  // A stream that ends without its final blank line still delivered a frame.
  dispatch();
  return frames;
}

/**
 * Read frames from a response body as they arrive.
 *
 * The decoder is kept across chunks (`{ stream: true }`) so a multi-byte character split by the
 * network is not mangled; the line buffer does the same for a frame split mid-line. A frame is
 * only yielded once its blank line arrived, so a half-received `data:` line is never parsed.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];

  const consumeLine = (line: string): SseFrame | undefined => {
    if (line === '') {
      if (data.length === 0) return undefined;
      const frame: SseFrame = { event: event || 'message', data: data.join('\n') };
      event = '';
      data = [];
      return frame;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return undefined;
  };

  // A reader loop rather than `for await (chunk of body)`: Node's ReadableStream is async
  // iterable at runtime but its type does not say so (that is a DOM lib declaration), and the
  // reader is also what makes an aborted fetch reject this loop instead of hanging it.
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = buffer.slice(newline + 1);
        const frame = consumeLine(line);
        if (frame) yield frame;
        newline = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    const frame = consumeLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    if (frame) yield frame;
  }
  const last = consumeLine('');
  if (last) yield last;
}
