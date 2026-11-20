import { describe, it, expect } from 'vitest';
import type { MessageRef } from '../types.js';
import { MessageNotEditableError, RateLimitedError } from './outbound-errors.js';
import {
  StreamBuffer,
  splitIntoChunks,
  splitByMeasure,
  type StreamBufferOptions,
  type StreamSink,
} from './stream-buffer.js';

/** Parse the "(i/total) " prefix; returns {i,total,body} or null. */
function parseLabel(chunk: string): { i: number; total: number; body: string } | null {
  const m = /^\((\d+)\/(\d+)\) ([\s\S]*)$/.exec(chunk);
  if (!m) return null;
  return { i: Number(m[1]), total: Number(m[2]), body: m[3]! };
}

/** Count ``` fences; even means paired. */
function fenceCount(s: string): number {
  return (s.match(/```/g) ?? []).length;
}

describe('splitIntoChunks', () => {
  it('short text is not chunked and not labeled', () => {
    expect(splitIntoChunks('hello', 100)).toEqual(['hello']);
  });

  it('exactly equal to limit is not chunked', () => {
    const text = 'x'.repeat(50);
    expect(splitIntoChunks(text, 50)).toEqual([text]);
  });

  it('empty string returns a single chunk, not labeled', () => {
    expect(splitIntoChunks('', 100)).toEqual(['']);
  });

  it('long plain text splits on newlines and adds (i/total) labels', () => {
    const text = ['line-one', 'line-two', 'line-three', 'line-four'].join('\n');
    const limit = 20;
    const chunks = splitIntoChunks(text, limit, true);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, idx) => {
      const p = parseLabel(c);
      expect(p).not.toBeNull();
      expect(p!.i).toBe(idx + 1);
      expect(p!.total).toBe(chunks.length);
    });
    // Label counts against the budget: labeled chunk length stays within limit.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(limit);
    const joined = chunks.map((c) => parseLabel(c)!.body).join('\n');
    expect(joined.replace(/\n+/g, '\n')).toBe(text.replace(/\n+/g, '\n'));
  });

  it('prefers breaking at spaces without splitting words', () => {
    const text = 'alpha beta gamma delta epsilon zeta';
    const limit = 22; // tiny content budget after the label forces multiple chunks
    const chunks = splitIntoChunks(text, limit, true);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(limit);
      const body = parseLabel(c)!.body;
      // No split mid-word: body has no broken leading/trailing whitespace.
      expect(body).toBe(body.trim());
    }
    // Recovered word set matches the original (no word torn apart).
    const words = chunks.flatMap((c) => parseLabel(c)!.body.split(/\s+/));
    expect(words.filter(Boolean)).toEqual(text.split(' '));
  });

  it('a single overlong token with no spaces is hard-cut', () => {
    const token = 'a'.repeat(200);
    const limit = 30;
    const chunks = splitIntoChunks(token, limit, true);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(limit);
    const joined = chunks.map((c) => parseLabel(c)!.body).join('');
    expect(joined).toBe(token);
  });

  it('a code block is kept whole when the budget allows (not split), fences always paired', () => {
    // Large enough limit to keep the whole code block in one slice; long
    // surrounding text forces chunking.
    const pre = '前置文本'.repeat(20);
    const code = '```ts\nconst a = 1;\nconst b = 2;\n```';
    const post = '后置文本'.repeat(20);
    const text = `${pre}\n${code}\n${post}`;
    const limit = 80;
    const chunks = splitIntoChunks(text, limit, true);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(fenceCount(c) % 2).toBe(0);
      expect(c.length).toBeLessThanOrEqual(limit);
    }
    // Code block stays whole in one chunk (both lines together, fences intact).
    const codeChunk = chunks.find((c) => c.includes('const a = 1;'));
    expect(codeChunk).toBeDefined();
    expect(codeChunk!).toContain('const b = 2;');
    expect(parseLabel(codeChunk!)!.body.startsWith('```ts')).toBe(true);
    expect(codeChunk!.endsWith('```')).toBe(true);
  });

  it('an overlong code block, once split, keeps each slice fenced and language-tagged', () => {
    const codeLines = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`);
    const text = '```js\n' + codeLines.join('\n') + '\n```';
    const limit = 50;
    const chunks = splitIntoChunks(text, limit, true);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const body = parseLabel(c)!.body;
      expect(fenceCount(body) % 2).toBe(0);
      // Slices with code start with ```js (language tag preserved).
      if (body.includes('const v')) {
        expect(body.startsWith('```js')).toBe(true);
        expect(body.endsWith('```')).toBe(true);
      }
      expect(c.length).toBeLessThanOrEqual(limit);
    }
    const codeContent = chunks
      .map((c) => parseLabel(c)!.body)
      .join('\n')
      .replace(/```js\n?/g, '')
      .replace(/```/g, '');
    for (const line of codeLines) expect(codeContent).toContain(line);
  });

  it('label width counts against the budget: labeled length never exceeds limit', () => {
    const text = Array.from({ length: 60 }, (_, i) => `这是第${i}行中文内容测试`).join('\n');
    const limit = 35;
    const chunks = splitIntoChunks(text, limit, true);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(limit);
    // Enough chunks to force a two-digit total, exercising adaptive label width.
    expect(chunks.length).toBeGreaterThanOrEqual(10);
  });

  it('default (withLabels=false): multiple chunks but no (i/total) labels', () => {
    const text = ['line-one', 'line-two', 'line-three', 'line-four'].join('\n');
    const limit = 20;
    const chunks = splitIntoChunks(text, limit); // default: no labels
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(parseLabel(c)).toBeNull();
      expect(c.length).toBeLessThanOrEqual(limit);
    }
    expect(chunks.join('\n').replace(/\n+/g, '\n')).toBe(text.replace(/\n+/g, '\n'));
  });
});

// Where a cut lands. The shape that motivated this: a reply of 4632 chars went to Telegram (4096)
// as two messages cut at the last newline that fit, which split "questions for you" 1–2 | 3–4 and
// read as if part of the reply had gone missing.
describe('splitIntoChunks: cut placement', () => {
  const intro = (n: number): string => 'i'.repeat(n);
  const list = ['1. alpha', '2. bravo', '3. charlie', '4. delta'].join('\n');

  it('keeps a list whole by cutting at the paragraph break before it', () => {
    // The window (100) ends inside the list; the blank line at 80 still leaves the message 4/5 full.
    const text = `${intro(80)}\n\n${list}`;
    expect(splitIntoChunks(text, 100)).toEqual([intro(80), list]);
  });

  it('never leaves a heading as the last line of a message', () => {
    // The last newline that fits is right after the heading — which is where the cut used to land.
    const section = `### Questions\n\n${list}`;
    expect(splitIntoChunks(`${intro(76)}\n\n${section}`, 100)).toEqual([intro(76), section]);
  });

  it('treats a line that is only a bold span as a heading too', () => {
    // No blank line anywhere: the last newline that fits follows the bold title, so the cut has to
    // move one line up — to the break before the title, which counts as a block boundary.
    const section = '**Option C**\n- the agent is read-only, every write asks first';
    const before = `${intro(60)}\n${'x'.repeat(20)}`;
    expect(splitIntoChunks(`${before}\n${section}`, 100)).toEqual([before, section]);
  });

  it('takes the last line break when the only block boundary would leave the message under 3/4 full', () => {
    // A blank line at 40 of 100 is too early to be worth a message that much emptier.
    const items = Array.from({ length: 10 }, (_, i) => `item ${String(i).padStart(2, '0')} xxxxx`);
    const text = `${intro(40)}\n\n${items.join('\n')}`;
    const [first, second] = splitIntoChunks(text, 100);
    expect(first!.length).toBeGreaterThan(75);
    expect(first!.endsWith('xxxxx')).toBe(true); // a whole item, not a torn one
    expect(second!.startsWith('item ')).toBe(true);
  });

  it('a continuation never opens with the blank lines it was cut at, nor does a message end with them', () => {
    const text = `${'a'.repeat(80)}\n\n\n${'b'.repeat(30)}`;
    expect(splitIntoChunks(text, 100)).toEqual(['a'.repeat(80), 'b'.repeat(30)]);
  });
});

interface FakeSink extends StreamSink {
  sends: string[];
  edits: Array<{ ref: MessageRef; text: string }>;
  /** Every edit call, successful or not — what a backoff assertion has to count. */
  editAttempts: number;
  setNow(t: number): void;
  runTimers(): void;
  /** Next n edits throw a transient error (rate limit). */
  failEdits(n: number): void;
  /** Next n edits throw `err` — for asserting on a specific failure class. */
  failEditsWith(n: number, err: unknown): void;
  /** Every edit from now on throws MessageNotEditableError — i.e. the platform sealed the message. */
  refuseEditsForever(): void;
}

/** Controllable sink: advance now manually, fire registered timers manually, script edit failures. */
function makeSink(): FakeSink {
  let nowVal = 0;
  let editFailRemaining = 0;
  let editFailWith: unknown;
  let refusing = false;
  const pending: Array<{ fn: () => void; at: number }> = [];
  let msgSeq = 0;

  const sink: FakeSink = {
    sends: [],
    edits: [],
    editAttempts: 0,
    async send(text: string): Promise<MessageRef> {
      sink.sends.push(text);
      return { address: { channel: 'c' }, messageId: `m${++msgSeq}` };
    },
    async edit(ref: MessageRef, text: string): Promise<void> {
      sink.editAttempts++;
      if (refusing) throw new MessageNotEditableError('edit limit reached');
      if (editFailRemaining > 0) {
        editFailRemaining--;
        throw editFailWith ?? new Error('rate-limited');
      }
      sink.edits.push({ ref, text });
    },
    now: () => nowVal,
    schedule(fn: () => void, ms: number): () => void {
      const entry = { fn, at: nowVal + ms };
      pending.push(entry);
      return () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    setNow(t: number) {
      nowVal = t;
    },
    runTimers() {
      // Fire all pending timers (one simple round).
      const due = pending.splice(0, pending.length);
      for (const e of due) e.fn();
    },
    failEdits(n: number) {
      editFailRemaining = n;
      editFailWith = undefined;
    },
    failEditsWith(n: number, err: unknown) {
      editFailRemaining = n;
      editFailWith = err;
    },
    refuseEditsForever() {
      refusing = true;
    },
  };
  return sink;
}

/** Push a delta and let the flush chain settle. */
async function pushAndSettle(buf: StreamBuffer, sink: FakeSink, delta: string): Promise<void> {
  sink.setNow(sink.now() + 100000); // jump past any backoff so the write is guaranteed to trigger
  buf.push(delta);
  // Several microtask rounds: each write settles on the flushChain before the next.
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Everything the sink actually delivered, in order: each send followed by its latest edit. */
function visibleMessages(sink: FakeSink): string[] {
  return sink.sends.map((text, i) => {
    const ref = `m${i + 1}`;
    const lastEdit = [...sink.edits].reverse().find((e) => e.ref.messageId === ref);
    return lastEdit?.text ?? text;
  });
}

function makeOpts(over: Partial<StreamBufferOptions> = {}): StreamBufferOptions {
  return {
    // The suites below drive the live path unless a test overrides it; 'once' has its own block.
    mode: 'live',
    charThreshold: 10,
    flushIntervalMs: 800,
    maxBackoffMs: 10000,
    silentToken: '[SILENT]',
    maxMessageLength: 2000,
    ...over,
  };
}

describe('StreamBuffer dual-trigger and delivery', () => {
  it('accumulating to charThreshold triggers one initial send', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 5 }), sink);

    buf.push('hello world'); // 11 chars >= 5 → triggers
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('hello world');
  });

  it('below the threshold does not trigger immediately, flushes when the timer expires', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 100 }), sink);

    buf.push('hi'); // 2 < 100, no trigger, arms a timer
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);

    sink.setNow(1000); // past flushIntervalMs
    sink.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('hi');
  });

  it('skips the edit call when the text is unchanged', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 1 }), sink);

    buf.push('abc'); // initial send
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(1);

    // Advance time and flush again, but no new text → rendered unchanged → skipped.
    sink.setNow(5000);
    buf.push(''); // doesn't change acc
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.edits.length).toBe(0);
  });

  it('new content after the initial send triggers an in-place edit', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 3 }), sink);

    await pushAndSettle(buf, sink, 'aaa');
    expect(sink.sends.length).toBe(1);

    await pushAndSettle(buf, sink, 'bbbb'); // adds 4 >= 3
    expect(sink.edits.length).toBe(1);
    expect(sink.edits[0]!.text).toBe('aaabbbb');
  });

  it('a transient edit failure keeps the message open: the next flush edits the same message', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 2 }), sink);

    await pushAndSettle(buf, sink, 'ab');
    expect(sink.sends.length).toBe(1);

    sink.failEdits(1);
    await pushAndSettle(buf, sink, 'cd'); // this edit fails (rate limit)
    expect(sink.edits.length).toBe(0);

    await pushAndSettle(buf, sink, 'ef'); // retried on the SAME message, not a new one
    expect(sink.sends.length).toBe(1);
    expect(sink.edits.at(-1)!.text).toBe('abcdef');
  });

  it('spending the edit budget seals the message and streams on into a new one, losing nothing', async () => {
    const sink = makeSink();
    // Budget of 2 edits: send + 2 edits, then the 3rd update must open a new message.
    const buf = new StreamBuffer(makeOpts({ charThreshold: 2, maxEditsPerMessage: 2 }), sink);

    await pushAndSettle(buf, sink, 'aa'); // send #1
    await pushAndSettle(buf, sink, 'bb'); // edit 1/2
    await pushAndSettle(buf, sink, 'cc'); // edit 2/2 → budget spent
    expect(sink.sends.length).toBe(1);
    expect(sink.edits.length).toBe(2);

    await pushAndSettle(buf, sink, 'dd'); // no budget left → seal, send #2 with just the new tail
    expect(sink.sends.length).toBe(2);
    expect(sink.sends[1]).toBe('dd');

    await buf.complete({ footer: 'ftr' });
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // Concatenating what each message shows reproduces the whole reply exactly once.
    expect(visibleMessages(sink).join('')).toBe('aabbccdd\n\nftr');
  });

  it('a platform that refuses further edits seals the message rather than losing the rest', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 2 }), sink);

    await pushAndSettle(buf, sink, 'head');
    expect(sink.sends.length).toBe(1);

    // Lark 230072 equivalent: this message will never accept another edit.
    sink.refuseEditsForever();
    await pushAndSettle(buf, sink, '-tail');

    expect(sink.sends.length).toBe(2);
    expect(sink.sends[1]).toBe('-tail'); // continues in a new message, no duplicated head
    expect(visibleMessages(sink).join('')).toBe('head-tail');
  });

  it("regression: the final flush delivers the conclusion even when the message can't be edited any more", async () => {
    // The exact production failure: a long Lark reply exhausts the per-message edit quota, and the
    // final flush — which carries the complete answer plus footer — used to re-edit that same dead
    // message, swallow the rejection, and report the turn complete. The user saw a reply truncated
    // mid-sentence with a ✅ on it.
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 4 }), sink);

    await pushAndSettle(buf, sink, 'part one. ');
    expect(sink.sends.length).toBe(1);

    sink.refuseEditsForever();
    buf.push('and the whole conclusion nobody ever saw.');
    await buf.complete({ footer: 'oc · 12k / 1M' });
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // The footer had to move into a message of its own. The blank line that separated it from the
    // body is now the seam between two messages, so it is consumed rather than opening that message.
    const shown = visibleMessages(sink);
    expect(shown.slice(0, -1).join('')).toBe('part one. and the whole conclusion nobody ever saw.');
    expect(shown.at(-1)).toBe('oc · 12k / 1M');
  });

  it('the final flush routes around a transient failure too, rather than truncating the reply', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 4 }), sink);

    await pushAndSettle(buf, sink, 'body ');
    expect(sink.sends.length).toBe(1);

    sink.failEdits(99); // every edit fails, including the final one
    buf.push('ending');
    await buf.complete();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // Sealed and sent as a new message: the ending is on screen, not swallowed.
    expect(sink.sends.length).toBe(2);
    expect(sink.sends[1]).toBe('ending');
  });

  it('overflow mid-stream seals the full message and keeps streaming into the next one', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 4, maxMessageLength: 10 }), sink);

    await pushAndSettle(buf, sink, 'aaaaaaaaaa'); // exactly 10 → fills one message
    await pushAndSettle(buf, sink, 'bbbb');       // overflow → second message, still open
    await pushAndSettle(buf, sink, 'cc');         // edits the second message, not the sealed first

    expect(sink.sends.length).toBe(2);
    expect(visibleMessages(sink).join('')).toBe('aaaaaaaaaabbbbcc');
    // The sealed first message was never touched again.
    expect(sink.edits.every((e) => e.ref.messageId !== 'm1')).toBe(true);
  });

  it('the seam newlines between two live messages are consumed, not sent, and nothing else is lost', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 4, maxMessageLength: 20 }), sink);

    await pushAndSettle(buf, sink, 'a'.repeat(18) + '\n\n'); // fits: the blank line is still in m1
    await pushAndSettle(buf, sink, 'next para');            // overflow → cut at the paragraph
    await pushAndSettle(buf, sink, ' goes on');             // edits m2, which never saw the seam
    await buf.complete();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // The cut moves to the paragraph break, so m1 loses its trailing blank line (one edit, as the old
    // cut also cost) and m2 starts at the text — the seam is in neither message.
    const shown = visibleMessages(sink);
    expect(shown).toEqual(['a'.repeat(18), 'next para goes on']);
  });

  it('abort() then complete(): performs no further writes', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 2 }), sink);

    await pushAndSettle(buf, sink, 'ab');
    const sendsBefore = sink.sends.length;
    const editsBefore = sink.edits.length;

    buf.abort();
    await buf.complete(); // after abort, complete returns early: no write
    await Promise.resolve();

    expect(sink.sends.length).toBe(sendsBefore);
    expect(sink.edits.length).toBe(editsBefore);
  });

  it('complete() writes the final body', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2 });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello');
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends[0]).toBe('hello');

    sink.setNow(5000);
    buf.push(' there');
    await buf.complete();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    const lastEdit = sink.edits[sink.edits.length - 1]!;
    expect(lastEdit).toBeDefined();
    expect(lastEdit.text).toBe('hello there');
  });

  it('complete({ footer }): on normal completion the footer is appended to the end of the final message', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2 });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello');
    await Promise.resolve();
    await Promise.resolve();

    sink.setNow(5000);
    await buf.complete({ footer: 'claude-opus · ~/repo' });
    await Promise.resolve();

    const lastEdit = sink.edits[sink.edits.length - 1]!;
    expect(lastEdit).toBeDefined();
    expect(lastEdit.text).toBe('hello\n\nclaude-opus · ~/repo');
  });

  it('complete({ footer }): an empty footer is not appended — and costs no edit', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2 });
    const buf = new StreamBuffer(opts, sink);

    await pushAndSettle(buf, sink, 'hello');
    await buf.complete({ footer: '' });
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // The final render equals what the message already shows, so there is nothing to write.
    expect(visibleMessages(sink)).toEqual(['hello']);
    expect(sink.edits.length).toBe(0);
  });

  it('complete({ footer }): [SILENT] body sends no message at all (footer also absent)', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts(), sink);
    buf.push('[SILENT]');
    await Promise.resolve();
    await buf.complete({ footer: 'claude-opus · ~/repo' });
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);
  });

  it('overlong text is delivered as several messages that reassemble into exactly the original', async () => {
    const sink = makeSink();
    // Chunks 2..N used to be emitted on the final flush only, and an "unchanged" early-exit could
    // drop them entirely. Now each full message is sealed and the next one continues the stream.
    const buf = new StreamBuffer(makeOpts({ maxMessageLength: 60, charThreshold: 5 }), sink);
    const body = 'x'.repeat(220); // far over 60 → certainly multiple chunks
    buf.push(body);
    await Promise.resolve();
    await Promise.resolve();
    await buf.complete();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // Multiple unlabeled messages, fully recoverable.
    expect(sink.sends.length).toBeGreaterThan(1);
    for (const s of sink.sends) expect(parseLabel(s)).toBeNull();
    for (const m of visibleMessages(sink)) expect(m.length).toBeLessThanOrEqual(60);
    expect(visibleMessages(sink).join('')).toBe(body);
  });

  it('complete({ footer }): empty body (never pushed visible text) appends no footer and sends no message', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts(), sink);
    // Never pushed anything → acc empty → no visible body.
    await buf.complete({ footer: 'claude-opus · ~/repo' });
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);
  });

  it('[SILENT] sends no message at all', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts(), sink);
    buf.push('[SILENT]');
    await Promise.resolve();
    await buf.complete();
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);
  });

  it("complete()'s final write is not swallowed while a streaming flush is in flight", async () => {
    // Race regression: the first send hangs (manually resolved) to simulate an
    // in-flight flush; complete() is called during its await, then the send is
    // released. The final write must still land (not be swallowed by a
    // re-entrancy guard).
    let resolveFirstSend: ((ref: MessageRef) => void) | null = null;
    let sendCount = 0;
    let nowVal = 0;
    let msgSeq = 0;
    const sends: string[] = [];
    const edits: Array<{ ref: MessageRef; text: string }> = [];

    const sink: StreamSink = {
      async send(text: string): Promise<MessageRef> {
        sends.push(text);
        if (++sendCount === 1) {
          // First send hangs (in-flight) until released externally.
          return new Promise<MessageRef>((res) => {
            resolveFirstSend = res;
          });
        }
        return { address: { channel: 'c' }, messageId: `m${++msgSeq}` };
      },
      async edit(ref: MessageRef, text: string): Promise<void> {
        edits.push({ ref, text });
      },
      now: () => nowVal,
      schedule(_fn: () => void, _ms: number): () => void {
        return () => {};
      },
    };

    const opts = makeOpts({ charThreshold: 2 });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello'); // triggers first send, which hangs (in-flight)
    await Promise.resolve();
    await Promise.resolve();
    expect(sends.length).toBe(1);
    expect(sends[0]).toBe('hello');

    // End of turn: a re-entrancy-guarded impl would no-op and drop the final write.
    nowVal = 5000;
    const done = buf.complete({ footer: 'ftr' });
    // Release the hung first send so the in-flight flush settles and the chain runs final.
    expect(resolveFirstSend).not.toBeNull();
    resolveFirstSend!({ address: { channel: 'c' }, messageId: 'm-first' });
    await done;
    await Promise.resolve();

    // Final write lands as an edit on the message the hung send returned.
    const lastEdit = edits[edits.length - 1]!;
    expect(lastEdit).toBeDefined();
    expect(lastEdit.ref.messageId).toBe('m-first');
    expect(lastEdit.text).toBe('hello\n\nftr');
  });

  it('push() after abort() produces no new send/edit', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 2 }), sink);

    buf.push('ab'); // initial send
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(1);

    const sendsBefore = sink.sends.length;
    const editsBefore = sink.edits.length;

    buf.abort();
    sink.setNow(5000);
    buf.push('cdef'); // post-abort delta must not trigger any write
    await Promise.resolve();
    await Promise.resolve();
    sink.runTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.sends.length).toBe(sendsBefore);
    expect(sink.edits.length).toBe(editsBefore);
  });
});

// ============================================================================
// 'once' mode: the default (stream.enabled off), and the only mode available on
// platforms that cannot edit messages (QQ/LINE/WeCom/DingTalk)
// ============================================================================

describe("StreamBuffer 'once' mode", () => {
  it('sends nothing during push, complete() emits the accumulated text as a single new send, no edit', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, mode: 'once' });
    const buf = new StreamBuffer(opts, sink);

    // Multiple pushes crossing the char threshold and timer: 'once' never sends mid-turn.
    buf.push('hello');
    await Promise.resolve();
    await Promise.resolve();
    buf.push(' world');
    await Promise.resolve();
    await Promise.resolve();
    sink.setNow(5000);
    sink.runTimers(); // even an expired timer must not trigger a mid-stream send
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);

    await buf.complete();
    await Promise.resolve();
    await Promise.resolve();

    // Finish: accumulated text emitted as a single new message, no edit.
    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('hello world');
    expect(sink.edits.length).toBe(0);
  });

  it('regression: mid-stream no-op flushes must not mark the text as delivered', async () => {
    // The mid-turn and final renders are identical here (no footer). An older mid-stream branch
    // recorded the accumulation as written without sending it, so the final flush saw "unchanged"
    // and skipped: platforms that cannot edit never delivered any reply at all.
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, mode: 'once' });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello'); // crosses charThreshold → triggers a mid-stream (no-op) flush
    await Promise.resolve();
    await Promise.resolve();
    buf.push(' world'); // and again
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(0); // nothing mid-turn, by design

    await buf.complete(); // no footer: final render === mid-stream render
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('hello world');
    expect(sink.edits.length).toBe(0);
  });

  it('overlong text on complete() splits into multiple messages, none of them edited', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, mode: 'once', maxMessageLength: 20 });
    const buf = new StreamBuffer(opts, sink);

    const text = ['line-one', 'line-two', 'line-three', 'line-four'].join('\n');
    buf.push(text);
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(0); // nothing mid-stream

    await buf.complete();
    await Promise.resolve();
    await Promise.resolve();

    // Overlong → multiple sends; each within budget, unlabeled, no edit.
    expect(sink.sends.length).toBeGreaterThan(1);
    for (const s of sink.sends) {
      expect(s.length).toBeLessThanOrEqual(opts.maxMessageLength);
      expect(/^\(\d+\/\d+\) /.test(s)).toBe(false);
    }
    expect(sink.edits.length).toBe(0);
  });

  it('complete() after abort() sends no message', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, mode: 'once' });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello world');
    await Promise.resolve();
    await Promise.resolve();

    buf.abort();
    await buf.complete();
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);
  });

  it('the footer still lands at the end of the last message, with no edit', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, mode: 'once' });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello');
    await Promise.resolve();
    await Promise.resolve();

    await buf.complete({ footer: 'claude-opus · ~/repo' });
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('hello\n\nclaude-opus · ~/repo');
    expect(sink.edits.length).toBe(0);
  });

  it('a [SILENT] body sends no message at all', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ mode: 'once' }), sink);
    buf.push('[SILENT]');
    await Promise.resolve();
    await buf.complete({ footer: 'claude-opus · ~/repo' });
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);
  });

  it('never edits, even with an edit budget available — so the edit cap cannot truncate a reply', async () => {
    // The point of the default: a reply that would have blown Feishu's 20-edit budget while
    // streaming is delivered as finished text, where the only limit left is message length.
    const sink = makeSink();
    const buf = new StreamBuffer(
      makeOpts({ mode: 'once', charThreshold: 2, maxEditsPerMessage: 20, maxMessageLength: 10000 }),
      sink
    );

    // 4.7k of text arriving in 200-char deltas: 24 flushes, i.e. past the budget, while streaming.
    for (let i = 0; i < 24; i++) await pushAndSettle(buf, sink, 'x'.repeat(200));
    expect(sink.sends.length).toBe(0);

    await buf.complete({ footer: 'oc · 12k / 1M' });
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(sink.edits.length).toBe(0);
    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('x'.repeat(4800) + '\n\noc · 12k / 1M');
  });

  it('a reply past the message limit arrives as several messages that reassemble exactly', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ mode: 'once', maxMessageLength: 500 }), sink);

    const body = Array.from({ length: 40 }, (_, i) => `第 ${i} 行内容，凑够长度好切成多条消息。`).join('\n');
    buf.push(body);
    await buf.complete();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(sink.sends.length).toBeGreaterThan(1);
    expect(sink.edits.length).toBe(0);
    for (const s of sink.sends) expect(s.length).toBeLessThanOrEqual(500);
    // Joined back with the separators the chunker consumed at cut points.
    expect(sink.sends.join('\n').replace(/\n+/g, '\n')).toBe(body.replace(/\n+/g, '\n'));
  });

  it('a message cut at a paragraph keeps the list whole, and the next one does not open with a blank line', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ mode: 'once', maxMessageLength: 100 }), sink);
    const intro = 'i'.repeat(80);
    const list = ['1. alpha', '2. bravo', '3. charlie', '4. delta'].join('\n');

    buf.push(`${intro}\n\n${list}`);
    await buf.complete({ footer: 'oc' });
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // Before: the second message was "\n3. charlie\n4. delta\n\noc" — a list starting at 3.
    expect(sink.sends).toEqual([intro, `${list}\n\noc`]);
  });

  it('each completed segment is its own message, so a turn using tools still reports as it goes', async () => {
    // TurnRunner completes the body buffer at every tool boundary and rotates in a fresh one. That
    // is what keeps 'once' from being silent for the whole turn.
    const sink = makeSink();
    const opts = makeOpts({ mode: 'once' });

    const first = new StreamBuffer(opts, sink);
    first.push('looking into it');
    await first.complete(); // tool boundary
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(sink.sends).toEqual(['looking into it']);

    const second = new StreamBuffer(opts, sink);
    second.push('here is the answer');
    await second.complete({ footer: 'oc' });
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(sink.sends).toEqual(['looking into it', 'here is the answer\n\noc']);
    expect(sink.edits.length).toBe(0);
  });
});

describe('splitByMeasure (render-aware chunking)', () => {
  const words = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');

  it('with the default (identity) measure, behaves exactly like splitIntoChunks', () => {
    const text = words(50);
    expect(splitByMeasure(text, 60)).toEqual(splitIntoChunks(text, 60));
  });

  it('a shrinking measure never triggers a needless re-split (full-size chunks kept)', () => {
    const text = words(50);
    // measure roughly halves length: every char-split chunk (<=60) measures <=30 < 60 → no re-split.
    const chunks = splitByMeasure(text, 60, (s) => Math.ceil(s.length / 2));
    expect(chunks).toEqual(splitIntoChunks(text, 60));
  });

  it('an expanding measure shrinks chunks so each rendered length stays within the limit', () => {
    const text = words(80);
    const limit = 60;
    const measure = (s: string) => s.length * 2; // 2x expansion (like a worst-case table)
    const chunks = splitByMeasure(text, limit, measure);
    for (const c of chunks) expect(measure(c)).toBeLessThanOrEqual(limit);
    // more, smaller chunks than a naive raw-char split would produce
    expect(chunks.length).toBeGreaterThan(splitIntoChunks(text, limit).length);
  });

  it('only re-splits the chunks that overflow when rendered (mixed expansion)', () => {
    const limit = 20;
    // only segments containing "BIG" expand (3x); the rest measure as identity.
    const measure = (s: string) => (s.includes('BIG') ? s.length * 3 : s.length);
    const text = 'aaaa\nbbbb\nBIG BIG BIG BIG BIG BIG\ncccc dddd';
    const chunks = splitByMeasure(text, limit, measure);
    for (const c of chunks) expect(measure(c)).toBeLessThanOrEqual(limit);
  });

  it('converges even when the measure expands heavily (no overflow left behind)', () => {
    const text = words(200);
    const limit = 50;
    const measure = (s: string) => s.length * 5; // extreme expansion
    const chunks = splitByMeasure(text, limit, measure);
    for (const c of chunks) expect(measure(c)).toBeLessThanOrEqual(limit);
  });
});

/**
 * A wait the platform NAMED beats the blind exponential cap.
 *
 * `maxBackoffMs` is a guess about how long a rate limit lasts. Telegram has answered
 * `retry after 229` — 22× the 10 s default — so capping a stated wait at the guess means retrying
 * far too early and re-earning the flood limit with every attempt.
 */
describe('stated retry_after overrides the blind backoff cap', () => {
  /** Drive one flush attempt at `t`, without the time jump pushAndSettle uses. */
  async function tick(buf: StreamBuffer, sink: FakeSink, t: number, delta: string): Promise<void> {
    sink.setNow(t);
    buf.push(delta);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  it('waits the 229 s Telegram asked for, not the 10 s maxBackoffMs', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 1, maxBackoffMs: 10_000 }), sink);

    await tick(buf, sink, 0, 'a'); // initial send opens the message
    expect(sink.sends.length).toBe(1);

    sink.failEditsWith(1, new RateLimitedError('flood', { retryAfterMs: 229_000 }));
    await tick(buf, sink, 1_000, 'b');
    expect(sink.editAttempts).toBe(1); // the failed one

    // Past maxBackoffMs but far short of the stated wait: nothing may go out.
    await tick(buf, sink, 20_000, 'c');
    expect(sink.editAttempts).toBe(1);

    // Past the stated wait: delivery resumes, carrying everything accumulated meanwhile.
    await tick(buf, sink, 231_000, 'd');
    expect(sink.editAttempts).toBe(2);
    expect(sink.edits.at(-1)!.text).toBe('abcd');
  });

  it('clamps an absurd stated wait so one bad number cannot wedge the buffer', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(
      makeOpts({ charThreshold: 1, maxBackoffMs: 10_000, maxRetryAfterMs: 60_000 }),
      sink
    );

    await tick(buf, sink, 0, 'a');
    sink.failEditsWith(1, new RateLimitedError('flood', { retryAfterMs: 86_400_000 }));
    await tick(buf, sink, 1_000, 'b');
    expect(sink.editAttempts).toBe(1);

    await tick(buf, sink, 62_000, 'c'); // past the clamp, nowhere near a day
    expect(sink.editAttempts).toBe(2);
  });

  it('an unquantified transient failure still uses the doubling path, capped', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(
      makeOpts({ charThreshold: 1, flushIntervalMs: 800, maxBackoffMs: 10_000 }),
      sink
    );

    await tick(buf, sink, 0, 'a');
    sink.failEdits(1); // plain Error: no number to honor
    await tick(buf, sink, 1_000, 'b');
    expect(sink.editAttempts).toBe(1);

    // Backoff doubled 800 → 1600; still inside it at +1000, through it at +2000.
    await tick(buf, sink, 2_000, 'c');
    expect(sink.editAttempts).toBe(1);
    await tick(buf, sink, 3_000, 'd');
    expect(sink.editAttempts).toBe(2);
  });

  it('the final flush still refuses to leave text undelivered behind a rate limit', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 1 }), sink);

    await tick(buf, sink, 0, 'hello');
    // Every edit is rate-limited; complete() must seal and SEND the remainder rather than
    // reporting the turn done with the tail missing.
    sink.failEditsWith(99, new RateLimitedError('flood', { retryAfterMs: 229_000 }));
    buf.push(' world');
    await buf.complete();

    expect(visibleMessages(sink).join('')).toBe('hello world');
  });
});

/**
 * Regression: the backoff used to gate only the idle TIMER, so the char threshold walked straight
 * through it. A rate-limited stream that kept producing text therefore retried every
 * `charThreshold` characters — deepening the flood instead of waiting it out.
 */
describe('a backoff holds back the char threshold too, not just the timer', () => {
  it('does not retry every charThreshold chars while the platform says wait', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(
      makeOpts({ charThreshold: 10, flushIntervalMs: 800, maxBackoffMs: 10_000 }),
      sink
    );

    sink.setNow(0);
    buf.push('0123456789'); // opens the message
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(sink.sends.length).toBe(1);

    sink.setNow(1_000);
    sink.failEditsWith(1, new RateLimitedError('flood', { retryAfterMs: 229_000 }));
    buf.push('abcdefghij');
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(sink.editAttempts).toBe(1);

    // Ten more threshold-sized bursts inside the wait: each one used to spend an API call.
    for (let n = 0; n < 10; n++) {
      sink.setNow(2_000 + n * 100);
      buf.push('klmnopqrst');
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    expect(sink.editAttempts).toBe(1);
  });
});

describe('StreamBuffer: a code block across buffers', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it('the final message closes a block the text left open, before the footer', async () => {
    for (const mode of ['once', 'live'] as const) {
      const sink = makeSink();
      const buf = new StreamBuffer(makeOpts({ mode, charThreshold: 1 }), sink);
      await pushAndSettle(buf, sink, 'Roll back:\n```sh\nmv a b\n');
      await buf.complete({ footer: 'cc · opus' });
      await settle();
      // Without the closer the footer rendered as the block's last line.
      expect(visibleMessages(sink)).toEqual(['Roll back:\n```sh\nmv a b\n```\n\ncc · opus']);
    }
  });

  it('reports the fence it leaves open, counting the one it was given', () => {
    const sink = makeSink();
    const first = new StreamBuffer(makeOpts(), sink);
    first.push('text\n~~~~md\nsome');
    expect(first.openFence()).toEqual({ marker: '~~~~', info: 'md' });
    const next = new StreamBuffer(makeOpts(), sink, first.openFence());
    expect(next.openFence()).toEqual({ marker: '~~~~', info: 'md' });
    next.push('\n~~~~\nafter');
    expect(next.openFence()).toBeUndefined();
  });

  it('a buffer that continues the block drops the closer it starts with', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ mode: 'once' }), sink, { marker: '```', info: '' });
    buf.push('```\n\nThe build passed.');
    await buf.complete({ footer: 'gemini · Neon' });
    await settle();
    expect(visibleMessages(sink)).toEqual(['The build passed.\n\ngemini · Neon']);
  });

  it('a buffer that continues inside the block reopens it with its info string, and closes it at the end', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ mode: 'once' }), sink, { marker: '```', info: 'yaml' });
    buf.push('  - b\n  - c\n');
    await buf.complete();
    await settle();
    expect(visibleMessages(sink)).toEqual(['```yaml\n  - b\n  - c\n```']);
  });

  it('live: holds the message back until its first line shows whether it closes the block', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 1 }), sink, { marker: '```', info: '' });
    await pushAndSettle(buf, sink, '``');
    await pushAndSettle(buf, sink, '`\n');
    expect(sink.sends).toEqual([]);
    await pushAndSettle(buf, sink, '\nDone');
    await pushAndSettle(buf, sink, '.');
    await buf.complete();
    await settle();
    expect(sink.sends).toEqual(['Done']);
    expect(visibleMessages(sink)).toEqual(['Done.']);
  });

  it('a buffer that only closed the block sends nothing — not even its footer', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ mode: 'once' }), sink, { marker: '```', info: '' });
    buf.push('```\n');
    await buf.complete({ footer: 'cc · opus' });
    await settle();
    expect(sink.sends).toEqual([]);
  });
});
