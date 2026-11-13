import { describe, expect, it } from 'vitest';
import { parseSseText, readSse, type SseFrame } from './sse.js';

/**
 * The Interactions API stream, as bytes. These cases are the parser's contract with
 * `antigravity.ts`: the recorded frames use `event:` + one-line JSON `data:`, and the stream ends
 * with `data: [DONE]` (project-scripts/antigravity-agent-probe, 2026-11-13).
 */

function streamOf(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of readSse(stream)) frames.push(frame);
  return frames;
}

describe('parseSseText', () => {
  it('reads event/data pairs and drops the blank separators', () => {
    const frames = parseSseText('event: step.delta\ndata: {"a":1}\n\nevent: done\ndata: [DONE]\n\n');
    expect(frames).toEqual([
      { event: 'step.delta', data: '{"a":1}' },
      { event: 'done', data: '[DONE]' },
    ]);
  });

  it('joins multiple data lines with a newline, as the spec says', () => {
    expect(parseSseText('event: x\ndata: one\ndata: two\n\n')).toEqual([{ event: 'x', data: 'one\ntwo' }]);
  });

  it('ignores comments and unknown fields, and keeps the event name across data lines', () => {
    const text = ': keep-alive\nid: 7\nretry: 500\nevent: step.stop\ndata: {}\n\n';
    expect(parseSseText(text)).toEqual([{ event: 'step.stop', data: '{}' }]);
  });

  it('defaults the event name to "message"', () => {
    expect(parseSseText('data: hello\n\n')).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('dispatches a trailing frame that arrived without its blank line', () => {
    expect(parseSseText('event: done\ndata: [DONE]')).toEqual([{ event: 'done', data: '[DONE]' }]);
  });

  it('handles CRLF line endings', () => {
    expect(parseSseText('event: a\r\ndata: 1\r\n\r\n')).toEqual([{ event: 'a', data: '1' }]);
  });
});

describe('readSse', () => {
  it('yields frames as their blank line arrives', async () => {
    const frames = await collect(streamOf(['event: a\ndata: 1\n\n', 'event: b\ndata: 2\n\n']));
    expect(frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('does not yield a frame split mid-line', async () => {
    const frames = await collect(streamOf(['event: step.delta\ndata: {"te', 'xt":"hi"}\n', '\n']));
    expect(frames).toEqual([{ event: 'step.delta', data: '{"text":"hi"}' }]);
  });

  it('keeps a multi-byte character split across chunks intact', async () => {
    const bytes = new TextEncoder().encode('data: 中文\n\n');
    // Cut inside the three-byte sequence of 中, which is where a naive per-chunk decode breaks.
    const frames = await collect(streamOf([bytes.slice(0, 7), bytes.slice(7)]));
    expect(frames).toEqual([{ event: 'message', data: '中文' }]);
  });

  it('yields a final frame when the body ends without a blank line', async () => {
    const frames = await collect(streamOf(['event: done\ndata: [DONE]']));
    expect(frames).toEqual([{ event: 'done', data: '[DONE]' }]);
  });
});
