import { describe, it, expect } from 'vitest';
import type { MessageRef, ToolEvent, ToolFinishEvent } from '../types.js';
import { MessageNotEditableError, RateLimitedError, WriteDroppedError } from './outbound-errors.js';
import {
  ToolRenderer,
  formatDuration,
  type BubbleSink,
  type ToolRendererOptions,
} from './tool-renderer.js';

/**
 * Mock BubbleSink with a manual clock.
 *
 * Painting is asynchronous now, so a test has to say when the writes it queued are allowed to
 * settle (`flush`) and when time is allowed to pass (`advanceTo`). That is the point of the
 * change: `onToolStart` no longer waits for the platform.
 */
function makeSink(opts: { withEdit: boolean }) {
  const sends: string[] = [];
  const edits: Array<{ ref: MessageRef; text: string }> = [];
  let counter = 0;
  let refuseAfter = Infinity;
  let nowVal = 0;
  let pending: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
  /** Queued failures for the next edits, oldest first. */
  const editFailures: unknown[] = [];

  const sink: BubbleSink = {
    async sendBubble(text: string): Promise<MessageRef> {
      sends.push(text);
      counter += 1;
      return { address: { channel: 'c' }, messageId: `m${counter}` };
    },
    now: () => nowVal,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, at: nowVal + ms, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  if (opts.withEdit) {
    sink.editBubble = async (ref: MessageRef, text: string): Promise<void> => {
      const scripted = editFailures.shift();
      if (scripted !== undefined) throw scripted;
      if (edits.length >= refuseAfter) throw new MessageNotEditableError('edit limit reached');
      edits.push({ ref, text });
    };
  }

  /** Let every queued write settle (the painter awaits between writes). */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };

  return {
    sink,
    sends,
    edits,
    flush,
    /** Advance to `t`, firing timers in due order, then settle. */
    async advanceTo(t: number): Promise<void> {
      await flush();
      for (let guard = 0; guard < 200; guard++) {
        pending = pending.filter((e) => !e.cancelled);
        const next = pending
          .filter((e) => e.at <= t)
          .reduce<(typeof pending)[number] | undefined>(
            (best, e) => (best === undefined || e.at < best.at ? e : best),
            undefined
          );
        if (!next) break;
        pending = pending.filter((e) => e !== next);
        nowVal = Math.max(nowVal, next.at);
        next.fn();
        await flush();
      }
      nowVal = Math.max(nowVal, t);
      await flush();
    },
    /** Whether a timer is armed and still in the future — i.e. a retry is pending. */
    hasArmedTimer(): boolean {
      return pending.some((e) => !e.cancelled);
    },
    /** Make editBubble start refusing (as Lark does) once n edits have landed. */
    refuseEditsAfter(n: number) {
      refuseAfter = n;
    },
    /** The next edit throws `err`. */
    failNextEdit(err: unknown) {
      editFailures.push(err);
    },
  };
}

function makeOpts(over: Partial<ToolRendererOptions> = {}): ToolRendererOptions {
  return {
    mode: 'all',
    grouping: 'separate',
    previewLimit: 40,
    defaultEmoji: '⚙️',
    emojiMap: { Read: '📖', Edit: '✏️', Bash: '💻' },
    ...over,
  };
}

function start(name: string, inputPreview: string, index?: number): ToolEvent {
  return { name, inputPreview, index };
}
function finish(name: string, ok: boolean, durationMs: number, index?: number): ToolFinishEvent {
  return { name, ok, durationMs, index };
}

describe('formatDuration', () => {
  it('<1000ms uses milliseconds', () => {
    expect(formatDuration(832)).toBe('832ms');
    expect(formatDuration(999)).toBe('999ms');
  });
  it('>=1000ms uses seconds (one decimal)', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1200)).toBe('1.2s');
    expect(formatDuration(1500)).toBe('1.5s');
  });
});

describe('separate mode', () => {
  it('a second start for the same index does not post the call twice', async () => {
    // No line set here, so the row cannot be corrected — but a second bubble for one call would
    // read as the tool having run twice. The first bubble, wrong as it is, stands.
    const { sink, sends, flush } = makeSink({ withEdit: false });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate' }), sink);

    r.onToolStart(start('Tool', 'Bash', 0));
    await flush();
    r.onToolStart(start('Bash', 'echo hi', 0));
    await flush();

    expect(sends).toEqual(['⚙️ Tool: "Bash"']);
  });

  it('two different tools → two sendBubble calls, no editBubble', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts'));
    r.onToolStart(start('Edit', 'src/b.ts'));
    await flush();

    expect(sends).toHaveLength(2);
    expect(edits).toHaveLength(0);
    expect(sends[0]).toBe('📖 Read: "src/a.ts"');
    expect(sends[1]).toBe('✏️ Edit: "src/b.ts"');
  });

  it('onToolFinish is a safe no-op under separate', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    r.onToolFinish(finish('Read', true, 1200, 0));
    await flush();

    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(0);
  });
});

describe('accumulate mode', () => {
  it('a second start for the same index rewrites that line instead of adding one', async () => {
    // CodeBuddy Code announces a call before its parameters: `Tool: "Bash"`, then the same index
    // again with the real kind and command. One row, corrected — not two rows, one of them wrong.
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Tool', 'Bash', 0));
    await flush();
    r.onToolStart(start('Bash', 'echo hi', 0));
    await flush();

    expect(sends).toHaveLength(1);
    expect(sends[0]).toBe('⚙️ Tool: "Bash"');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toBe('💻 Bash: "echo hi"');
  });

  it('an update to a finished line is ignored (its ✓ is the last word)', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Bash', 'ls', 0));
    r.onToolFinish(finish('Bash', true, 500, 0));
    await flush();
    const before = edits.length;
    r.onToolStart(start('Bash', 'ls -la', 0));
    await flush();

    expect(edits).toHaveLength(before); // no edit, and no second row either
    expect(edits[edits.length - 1]!.text).toContain('💻 Bash: "ls" ✓ 500ms');
  });

  it('two starts → one sendBubble + one editBubble, bubble holds two lines', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    await flush();
    r.onToolStart(start('Edit', 'src/b.ts', 1));
    await flush();

    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);

    const finalText = edits[edits.length - 1]!.text;
    expect(finalText).toBe('📖 Read: "src/a.ts"\n✏️ Edit: "src/b.ts"');
    expect(finalText.split('\n')).toHaveLength(2);
  });

  it('onToolFinish marks the matching line with ✓ and duration', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    r.onToolStart(start('Edit', 'src/b.ts', 1));
    r.onToolFinish(finish('Read', true, 1200, 0));
    await flush();

    const text = edits[edits.length - 1]!.text;
    const readLine = text.split('\n').find((l) => l.startsWith('📖'))!;
    expect(readLine).toContain('✓');
    expect(readLine).toContain('1.2s');
    expect(readLine).toBe('📖 Read: "src/a.ts" ✓ 1.2s');
  });

  it('ok=false → ✗', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Bash', 'ls', 0));
    await flush();
    r.onToolFinish(finish('Bash', false, 832, 0));
    await flush();

    const text = edits[edits.length - 1]!.text;
    expect(text).toContain('✗');
    expect(text).toContain('832ms');
    expect(text).toBe('💻 Bash: "ls" ✗ 832ms');
  });

  it('with no index, locates by appearance order / same name', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'all' }), sink);

    r.onToolStart(start('Read', 'src/a.ts'));
    r.onToolStart(start('Read', 'src/b.ts'));
    // No index → hits the first unfinished line with the same name.
    r.onToolFinish(finish('Read', true, 500));
    await flush();

    const lines = edits[edits.length - 1]!.text.split('\n');
    expect(lines[0]).toBe('📖 Read: "src/a.ts" ✓ 500ms');
    expect(lines[1]).toBe('📖 Read: "src/b.ts"');
  });

  it('under verbose, JSON is attached below the line (only once)', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'verbose' }), sink);

    r.onToolStart({ name: 'Read', inputPreview: 'src/a.ts', input: { path: 'src/a.ts' }, index: 0 });
    await flush();

    expect(sends[0]).toContain('```json');
    expect(sends[0]).toContain('"path": "src/a.ts"');
  });

  it('with no sink.editBubble, degrades to separate (a new bubble each time)', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: false });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    r.onToolStart(start('Edit', 'src/b.ts', 1));
    await flush();

    expect(sends).toHaveLength(2);
    expect(edits).toHaveLength(0);
  });

  it('after resetSegment the next segment starts a new bubble', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    await flush();
    r.resetSegment();
    await flush();
    r.onToolStart(start('Edit', 'src/b.ts', 0));
    await flush();

    expect(sends).toHaveLength(2);
    // The second segment's bubble holds only the new line, not the prior segment.
    expect(sends[1]).toBe('✏️ Edit: "src/b.ts"');
  });
});

/**
 * The headline regression. Under a run of back-to-back tool calls the renderer wrote twice per
 * tool into one chat with no pacing; Telegram answered 429 (`retry after` up to 229 s) and
 * `paint()` rethrew, so the update was logged and gone — the bubble froze on stale progress with
 * nothing left to re-trigger a paint. 78 updates were lost this way in one daemon run.
 */
describe('a rate-limited write is retried, never lost', () => {
  it('a 429 no longer loses the update: the newest state lands on the retry', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(
      makeOpts({ grouping: 'accumulate', retryIntervalMs: 1_200 }),
      sink
    );

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();

    failNextEdit(new RateLimitedError('Too Many Requests', { retryAfterMs: 5_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();
    expect(edits).toHaveLength(0); // the write failed...

    await advanceTo(5_000);
    expect(edits).toHaveLength(1); // ...and the retry carried it
    expect(edits[0]!.text).toBe('📖 Read: "a.ts" ✓ 500ms');
  });

  it('waits the time the platform NAMED, not the configured interval', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(
      makeOpts({ grouping: 'accumulate', retryIntervalMs: 1_200 }),
      sink
    );

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    failNextEdit(new RateLimitedError('flood', { retryAfterMs: 229_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    await advanceTo(10_000); // way past retryIntervalMs, nowhere near the stated wait
    expect(edits).toHaveLength(0);

    await advanceTo(229_000);
    expect(edits).toHaveLength(1);
  });

  it('clamps an absurd stated wait so the bubble cannot freeze forever', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(
      makeOpts({ grouping: 'accumulate', maxRetryAfterMs: 60_000 }),
      sink
    );

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    failNextEdit(new RateLimitedError('flood', { retryAfterMs: 86_400_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    await advanceTo(60_000);
    expect(edits).toHaveLength(1);
  });

  it('an unquantified failure backs off exponentially, capped at maxRetryMs', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(
      makeOpts({ grouping: 'accumulate', retryIntervalMs: 1_000, maxRetryMs: 2_500 }),
      sink
    );

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();

    failNextEdit(new Error('socket hang up'));
    failNextEdit(new Error('socket hang up'));
    failNextEdit(new Error('socket hang up'));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    await advanceTo(1_000); // 1st retry: fails (2nd scripted), backoff → 2000
    expect(edits).toHaveLength(0);
    await advanceTo(3_000); // 2nd retry: fails (3rd scripted), backoff → 2500 (capped, not 4000)
    expect(edits).toHaveLength(0);
    await advanceTo(5_500); // 3rd retry, 2500 after the last: the sink is out of failures
    expect(edits).toHaveLength(1);
  });

  it('a write the pacer dropped is treated as undelivered, so the next paint carries it', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', retryIntervalMs: 800 }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    failNextEdit(new WriteDroppedError('timeout', { retryAfterMs: 3_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();
    expect(edits).toHaveLength(0);

    await advanceTo(3_000);
    expect(edits[0]!.text).toContain('✓'); // the ✓ was never marked delivered, so it came back
  });

  it('abort() cancels an armed retry: a finished turn stops repainting', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    failNextEdit(new RateLimitedError('flood', { retryAfterMs: 1_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    r.abort();
    await advanceTo(60_000);
    expect(edits).toHaveLength(0);
  });
});

describe('painting is off the caller’s critical path', () => {
  it('onToolStart does not wait for the platform to answer', () => {
    // A sink that never answers: if onToolStart awaited delivery, this call would never return —
    // which is exactly what used to put every progress write in front of the user's reply.
    const sink: BubbleSink = {
      sendBubble: () => new Promise<MessageRef>(() => undefined),
      editBubble: () => new Promise<void>(() => undefined),
      now: () => 0,
      schedule: () => () => undefined,
    };
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    r.onToolFinish(finish('Read', true, 500, 0));
    r.onToolStart(start('Bash', 'ls', 1));
    expect(true).toBe(true); // reaching here at all is the assertion
  });

  it('a burst of tool events collapses into far fewer writes than events', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    // 20 back-to-back tool calls: the shape that produced two writes per tool and 78 × 429.
    for (let i = 0; i < 20; i++) {
      r.onToolStart(start('Read', `f${i}.ts`, i));
      r.onToolFinish(finish('Read', true, 100, i));
    }
    await flush();

    expect(sends).toHaveLength(1);
    expect(edits.length).toBeLessThanOrEqual(2); // was 40 writes
    expect(edits[edits.length - 1]!.text.split('\n')).toHaveLength(20); // all of it still shown
  });

  it('settle() resolves once everything has landed', async () => {
    const { sink, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    const settled = r.settle(10_000);
    await flush();
    await expect(settled).resolves.toBeUndefined();
  });

  it('settle() gives up on its deadline rather than holding the turn open', async () => {
    const { sink, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    failNextEdit(new RateLimitedError('flood', { retryAfterMs: 229_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    const settled = r.settle(15_000);
    await advanceTo(15_000);
    await expect(settled).resolves.toBeUndefined(); // the turn is free; the write still lands later
  });

  it('resetSegment waits for the segment’s last ✓ instead of discarding it', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    // The finish lands while the lane is stuck; the turn ends immediately after.
    failNextEdit(new RateLimitedError('flood', { retryAfterMs: 2_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();
    r.resetSegment();
    await flush();
    expect(edits).toHaveLength(0);

    await advanceTo(2_000);
    // Clearing the line set immediately would have thrown this ✓ away with it.
    expect(edits[0]!.text).toBe('📖 Read: "a.ts" ✓ 500ms');
  });
});

describe('accumulate: sealing a bubble that can take no more edits', () => {
  it('spending maxEdits opens a new bubble carrying only the unsettled lines', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    // Budget of 1 edit per bubble: send, one edit, then the next update must open a new bubble.
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', maxEdits: 1 }), sink);

    r.onToolStart(start('Read', 'a.ts', 0)); // sends bubble 1
    await flush();
    r.onToolFinish(finish('Read', true, 500, 0)); // edit 1/1 → ✓ delivered
    await flush();
    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);

    // Budget spent → seal. The finished Read line stays in bubble 1 and is not repeated.
    r.onToolStart(start('Bash', 'ls', 1));
    await flush();
    expect(sends).toHaveLength(2);
    expect(sends[1]).toBe('💻 Bash: "ls"');
    expect(edits[0]!.text).toBe('📖 Read: "a.ts" ✓ 500ms');
  });

  it('a finish that arrives with no budget left is carried into the new bubble, not lost', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', maxEdits: 0 }), sink);

    r.onToolStart(start('Bash', 'sleep 1', 0)); // bubble 1, no edits allowed at all
    await flush();
    r.onToolFinish(finish('Bash', true, 1200, 0));
    await flush();

    // The ✓ could not be edited into bubble 1, so the line moves to a bubble that can show it.
    expect(sends).toHaveLength(2);
    expect(sends[1]).toBe('💻 Bash: "sleep 1" ✓ 1.2s');
  });

  it('a platform refusing an edit seals the bubble and repaints into a new one', async () => {
    const { sink, sends, edits, flush, refuseEditsAfter } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    refuseEditsAfter(0); // every edit from here on is rejected permanently (Lark 230072)

    r.onToolStart(start('Bash', 'ls', 1));
    await flush();
    expect(edits).toHaveLength(0);
    expect(sends).toHaveLength(2);
    // Still-running Read is unsettled, so it is carried over rather than stranded.
    expect(sends[1]).toBe('📖 Read: "a.ts"\n💻 Bash: "ls"');
  });

  it('a line finished while a write was in flight is not marked delivered by that write', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    // maxEdits 0 forces a seal on the very next paint, which is what reads the delivery state.
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', maxEdits: 0 }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    // No flush: the send is in flight. The ✓ recorded now was NOT part of it.
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    // A boolean "delivered" flag would have been set by the send and the ✓ dropped on the seal.
    expect(edits).toHaveLength(0);
    expect(sends[sends.length - 1]).toContain('✓ 500ms');
  });
});

describe('accumulate: sealing a bubble that is full', () => {
  it('outgrowing maxMessageLength seals the bubble and continues in a new one', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    // '📖 Read: "a.ts"' is 15 chars; two lines plus the newline is 31. A 40-char ceiling
    // therefore holds two lines but not three.
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', maxMessageLength: 40 }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    r.onToolStart(start('Read', 'b.ts', 1));
    await flush();
    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);

    // The third line would overflow, so the bubble is sealed rather than rejected on the wire.
    r.onToolStart(start('Read', 'c.ts', 2));
    await flush();
    expect(sends).toHaveLength(2);
    // All three are still running, so all three are unsettled and carry over — then the oldest
    // are dropped to fit, leaving the newest progress, which is what the user is waiting on.
    expect(sends[1]).toBe('📖 Read: "b.ts"\n📖 Read: "c.ts"');
  });

  it('a delivered line is dropped on the length seal, so the new bubble stays small', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', maxMessageLength: 40 }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    r.onToolFinish(finish('Read', true, 500, 0)); // ✓ delivered into bubble 1
    await flush();
    r.onToolStart(start('Bash', 'ls', 1));
    await flush();

    // Bubble 1 already shows the finished Read, so the seal carries only the running Bash.
    r.onToolStart(start('Edit', 'src/x.ts', 2));
    await flush();
    expect(sends[sends.length - 1]).not.toContain('Read');
  });

  it('measures the RENDERED length, not the raw one', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    // A profile whose rendering doubles the visible length: 15 raw chars measure as 30, so a
    // single line already fills a 40-char message and the second one must open a new bubble.
    const r = new ToolRenderer(
      makeOpts({
        grouping: 'accumulate',
        maxMessageLength: 40,
        measureLength: (s) => s.length * 2,
      }),
      sink
    );

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    r.onToolStart(start('Read', 'b.ts', 1));
    await flush();
    expect(sends).toHaveLength(2);
  });

  it('separate mode clamps a bubble no seal can shrink', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: false });
    const r = new ToolRenderer(
      makeOpts({ mode: 'verbose', grouping: 'separate', maxMessageLength: 30 }),
      sink
    );

    // verbose appends the args JSON, which alone blows past the limit; there is no line set to
    // seal in separate mode, so the only honest option is to clamp and still deliver something.
    r.onToolStart({ name: 'Read', inputPreview: 'a.ts', index: 0, input: { path: 'x'.repeat(200) } });
    await flush();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.length).toBeLessThanOrEqual(30);
    expect(sends[0]!.endsWith('…')).toBe(true);
  });

  it('is unbounded when no limit is configured', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    for (let i = 0; i < 20; i++) {
      r.onToolStart(start('Read', `f${i}.ts`, i));
      await flush();
    }
    expect(sends).toHaveLength(1); // one bubble, edited throughout
    expect(edits.length).toBe(19);
  });

  it('an identical repaint spends no write at all', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'new' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    // Deduped by 'new', so the line set does not change — and a write saying the same thing is
    // a token spent for nothing.
    r.onToolStart(start('Read', 'b.ts', 1));
    await flush();
    expect(edits).toHaveLength(0);
  });
});

describe('new dedupe', () => {
  it('separate: consecutive same name sends only one', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate', mode: 'new' }), sink);

    r.onToolStart(start('Read', 'src/a.ts'));
    r.onToolStart(start('Read', 'src/b.ts'));
    r.onToolStart(start('Edit', 'src/c.ts'));
    await flush();

    expect(sends).toHaveLength(2);
  });

  it('accumulate: consecutive same name does not enter the line set', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'new' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    await flush();
    r.onToolStart(start('Read', 'src/b.ts', 1)); // deduped
    r.onToolStart(start('Edit', 'src/c.ts', 2)); // added to line + edit
    await flush();

    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);
    const text = edits[edits.length - 1]!.text;
    expect(text).toBe('📖 Read: "src/a.ts"\n✏️ Edit: "src/c.ts"');
  });

  it("a subagent's call after the main agent's same-name call is not a repeat", async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate', mode: 'new' }), sink);

    r.onToolStart(start('Bash', 'ls'));
    r.onToolStart({ ...start('Bash', 'pwd'), agent: 'probe' });
    r.onToolStart({ ...start('Bash', 'whoami'), agent: 'probe' }); // same owner, same name: deduped
    await flush();

    expect(sends).toEqual(['💻 Bash: "ls"', '↳ probe · 💻 Bash: "pwd"']);
  });
});

/**
 * A subagent's tools carry its name (ToolEvent.agent), so they can be told from the main agent's.
 * Before, the two were indistinguishable: a background subagent's eighty calls read as the main
 * agent's, in the same bubble, with the same look.
 */
describe('subagent tools', () => {
  it('lead with ↳ and the subagent name; the main agent’s lines are unchanged', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Task', 'probe subagent', 0));
    r.onToolStart({ ...start('Bash', 'echo probe-ok', 1), agent: 'probe subagent' });
    r.onToolFinish(finish('Bash', true, 1200, 1));
    await flush();

    expect(edits[edits.length - 1]!.text).toBe(
      '⚙️ Task: "probe subagent"\n↳ probe subagent · 💻 Bash: "echo probe-ok" ✓ 1.2s'
    );
  });

  it('cut a long name short, so the part of the line that changes stays readable', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate' }), sink);

    r.onToolStart({ ...start('Bash', 'python3 fetch_prices.py'), agent: '回测按分红选股的收益与回撤，并和红利ETF对比' });
    await flush();

    expect(sends).toEqual(['↳ 回测按分红选股的收益与回撤，并… · 💻 Bash: "python3 fetch_prices.py"']);
  });

  it('name the subagent once per run: the lines under it keep only the ↳', async () => {
    // The 2026-10-10 phone screenshot: fifteen of one subagent's lines, each repeating its name.
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);
    const agent = '接手修复 quantlab 存量数据';

    r.onToolStart(start('Task', agent, 0));
    r.onToolStart({ ...start('Bash', 'cd /home/user/workspace/quantlab', 1), agent });
    r.onToolStart({ ...start('Read', '/home/user/workspace/quantlab/a.py', 2), agent });
    r.onToolFinish(finish('Bash', true, 97, 1));
    r.onToolStart({ ...start('Bash', 'ls /tmp', 3), agent });
    await flush();

    expect(edits[edits.length - 1]!.text).toBe(
      [
        '⚙️ Task: "接手修复 quantlab 存量数据"',
        '↳ 接手修复 quantlab 存… · 💻 Bash: "cd /home/user/workspace/quantlab" ✓ 97ms',
        '↳ 📖 Read: "/home/user/workspace/quantlab/a.py"',
        '↳ 💻 Bash: "ls /tmp"',
      ].join('\n')
    );
  });

  it('put the name back whenever the owner changes, so interleaved runs stay attributed', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart({ ...start('Bash', 'a1', 0), agent: 'alpha' });
    r.onToolStart({ ...start('Bash', 'a2', 1), agent: 'alpha' });
    r.onToolStart({ ...start('Bash', 'b1', 2), agent: 'beta' });
    r.onToolStart({ ...start('Bash', 'a3', 3), agent: 'alpha' });
    r.onToolStart(start('Bash', 'main', 4));
    r.onToolStart({ ...start('Bash', 'a4', 5), agent: 'alpha' });
    r.onToolStart({ ...start('Bash', 'a5', 6), agent: 'alpha' });
    await flush();

    expect(edits[edits.length - 1]!.text).toBe(
      [
        '↳ alpha · 💻 Bash: "a1"',
        '↳ 💻 Bash: "a2"',
        '↳ beta · 💻 Bash: "b1"',
        '↳ alpha · 💻 Bash: "a3"',
        '💻 Bash: "main"',
        '↳ alpha · 💻 Bash: "a4"',
        '↳ 💻 Bash: "a5"',
      ].join('\n')
    );
  });

  it('name the owner again at the top of a new bubble, even mid-run', async () => {
    // The line above it is in the sealed bubble now, out of sight once the chat scrolls.
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', maxEdits: 1 }), sink);

    r.onToolStart({ ...start('Bash', 'one', 0), agent: 'probe' }); // bubble 1
    await flush();
    r.onToolFinish(finish('Bash', true, 500, 0)); // its one edit, ✓ delivered
    await flush();
    r.onToolStart({ ...start('Bash', 'two', 1), agent: 'probe' }); // budget spent → bubble 2
    await flush();

    expect(sends).toEqual(['↳ probe · 💻 Bash: "one"', '↳ probe · 💻 Bash: "two"']);
  });

  it('in separate grouping, name the owner on every bubble: there is no line above to share it', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate' }), sink);

    r.onToolStart({ ...start('Bash', 'one'), agent: 'probe' });
    r.onToolStart({ ...start('Read', 'two'), agent: 'probe' });
    await flush();

    expect(sends).toEqual(['↳ probe · 💻 Bash: "one"', '↳ probe · 📖 Read: "two"']);
  });
});

/**
 * `placed()` — the ordering barrier the body text holds on.
 *
 * The distinction it encodes is the whole reason it is cheap: a SEND takes a position in the chat
 * and therefore has to be ordered against the reply, while an EDIT rewrites a message that already
 * has one and never does. So these pin that it waits for exactly the first kind and not a tick
 * longer — a barrier that also waited for edits would put every ✓ in front of the user's answer,
 * which is the flood this renderer's asynchronous painting exists to prevent.
 */
describe('placed', () => {
  it('resolves immediately when nothing is waiting to be posted', async () => {
    const { sink } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);
    await expect(r.placed(1000)).resolves.toBeUndefined();
  });

  it('holds until the bubble has actually been sent', async () => {
    // The send is gated by hand: with a sink that resolves on its own there is no window in which
    // "the write is out but not acknowledged" exists, and the assertion would be about the mock.
    let release!: (ref: MessageRef) => void;
    const sent: string[] = [];
    const gated: BubbleSink = {
      sendBubble: (text) => {
        sent.push(text);
        return new Promise<MessageRef>((r) => (release = r));
      },
      editBubble: async () => undefined,
      now: () => 0,
      schedule: () => () => undefined,
    };
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), gated);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    let released = false;
    void r.placed(10_000).then(() => {
      released = true;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(released).toBe(false); // written, but the bubble holds no position yet

    release({ address: { channel: 'c' }, messageId: 'm1' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(released).toBe(true);
  });

  it('does not hold for an edit — a ✓ never has to precede the reply', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    await flush(); // bubble placed

    r.onToolFinish(finish('Read', true, 100, 0)); // an edit is now pending
    await expect(r.placed(1000)).resolves.toBeUndefined();
    await flush();
    expect(edits).toHaveLength(1); // …and it still lands, just not in front of anyone
  });

  it('holds again when a seal means the carried lines need a fresh bubble', async () => {
    const { sink, sends, flush, refuseEditsAfter } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    await flush();
    refuseEditsAfter(0); // the platform declares this bubble un-editable
    r.onToolStart(start('Edit', 'src/b.ts', 1));

    // The line set now has no bubble to live in, so the next write is a SEND and must be ordered.
    const wait = r.placed(1000);
    await flush();
    await expect(wait).resolves.toBeUndefined();
    expect(sends).toHaveLength(2);
  });

  it('gives up at the deadline rather than holding the reply behind a paused chat', async () => {
    const stalled: BubbleSink = {
      sendBubble: () => new Promise<MessageRef>(() => undefined), // never settles
      now: () => 0,
      schedule(fn: () => void, ms: number) {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    };
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), stalled);
    r.onToolStart(start('Read', 'src/a.ts', 0));
    // The wait ends on its own; the reply is worth more than the reading order.
    await expect(r.placed(20)).resolves.toBeUndefined();
  });

  it('releases an aborted turn instead of stranding whatever is waiting on it', async () => {
    const stalled: BubbleSink = {
      sendBubble: () => new Promise<MessageRef>(() => undefined),
      now: () => 0,
      schedule: () => () => undefined, // no timer will ever fire it
    };
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), stalled);
    r.onToolStart(start('Read', 'src/a.ts', 0));
    const wait = r.placed(10_000);
    r.abort();
    await expect(wait).resolves.toBeUndefined();
  });

  it('separate grouping: holds for a standalone bubble in flight', async () => {
    let release!: (ref: MessageRef) => void;
    const gated: BubbleSink = {
      sendBubble: () => new Promise<MessageRef>((r) => (release = r)),
      now: () => 0,
      schedule: () => () => undefined,
    };
    const r = new ToolRenderer(makeOpts({ grouping: 'separate' }), gated);
    r.onToolStart(start('Read', 'src/a.ts', 0));

    let released = false;
    void r.placed(10_000).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    release({ address: { channel: 'c' }, messageId: 'm1' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(released).toBe(true);
  });
});
