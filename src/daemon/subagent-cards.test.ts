import { describe, expect, it } from 'vitest';
import { ToolRenderer, type BubbleSink } from '../core/tool-renderer.js';
import type { MessageRef, ToolEvent, ToolFinishEvent } from '../types.js';
import { SubagentCards } from './subagent-cards.js';

/**
 * Cards over real renderers, each painting into its own message; `shown[i]` is what message i shows
 * now and `series[i]` the key it was sent under. `render()` starts the next render's cards on the
 * same chat, the way TurnRunner makes a SubagentCards per render.
 */
function setup(maxMessageLength?: number) {
  let now = 0;
  const shown: string[] = [];
  const series: string[] = [];
  const make = (key: string): ToolRenderer => {
    const sink: BubbleSink = {
      sendBubble: async (text): Promise<MessageRef> => {
        shown.push(text);
        series.push(key);
        return { address: { channel: 'c' }, messageId: String(shown.length - 1) };
      },
      editBubble: async (ref, text) => {
        shown[Number(ref.messageId)] = text;
      },
      now: () => now,
      schedule: () => () => undefined,
    };
    return new ToolRenderer(
      {
        mode: 'all',
        grouping: 'accumulate',
        previewLimit: 40,
        defaultEmoji: '⚙️',
        emojiMap: { Bash: '💻' },
        ...(maxMessageLength !== undefined ? { maxMessageLength } : {}),
      },
      sink
    );
  };
  const cards = new SubagentCards(make, () => now);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return {
    cards,
    shown,
    series,
    flush,
    render: () => new SubagentCards(make, () => now),
    at: (t: number) => {
      now = t;
    },
  };
}

const sub = (parent: string, agent: string, index: number, command: string): ToolEvent => ({
  name: 'Bash',
  inputPreview: command,
  index,
  id: `${parent}-${index}`,
  agent,
  parent,
});
const done = (parent: string, index: number, durationMs = 100): ToolFinishEvent => ({
  name: 'Bash',
  index,
  id: `${parent}-${index}`,
  parent,
  ok: true,
  durationMs,
});
const spawnDone = (id: string, spawns: 'foreground' | 'background', ok = true): ToolFinishEvent => ({
  name: 'Task',
  id,
  spawns,
  ok,
  durationMs: 1,
});

describe('SubagentCards', () => {
  it('gives each subagent a card of its own, and leaves the main agent’s tools alone', async () => {
    const { cards, shown, flush } = setup();
    cards.onToolStart({ name: 'Bash', inputPreview: 'main', index: 0 });
    cards.onToolStart(sub('a', 'back end', 1, 'grep 401'));
    cards.onToolStart(sub('b', 'front end', 2, 'grep login'));
    cards.onToolStart(sub('a', 'back end', 3, 'go test'));
    cards.onToolFinish(done('a', 1));
    await flush();
    expect(shown).toEqual(['↳ back end\n💻 Bash: "grep 401" ✓ 100ms\n💻 Bash: "go test"', '↳ front end\n💻 Bash: "grep login"']);
  });

  it('ends a foreground subagent’s card when the call that started it finishes', async () => {
    const { cards, shown, flush, at } = setup();
    at(1_000);
    cards.onToolStart(sub('a', 'probe', 1, 'ls'));
    cards.onToolFinish(done('a', 1));
    at(14_000);
    cards.onToolFinish(spawnDone('a', 'foreground'));
    await flush();
    expect(shown[0]).toBe('↳ probe ✓ 13.0s\n💻 Bash: "ls" ✓ 100ms');
  });

  it('leaves a background subagent’s card open when its call returns, and ends it with the render', async () => {
    const { cards, shown, flush, at } = setup();
    cards.onToolStart(sub('a', 'probe', 1, 'ls'));
    cards.onToolFinish(spawnDone('a', 'background'));
    await flush();
    expect(shown[0]).toBe('↳ probe\n💻 Bash: "ls"');
    at(5_000);
    cards.endAll(true);
    await flush();
    expect(shown[0]).toBe('↳ probe ✓ 5.0s\n💻 Bash: "ls"');
  });

  it('ends a background subagent’s card when the harness says it ended, and leaves the others running', async () => {
    const { cards, shown, flush, at } = setup();
    cards.onToolStart(sub('a', 'short', 1, 'ls'));
    cards.onToolStart(sub('b', 'long', 2, 'sleep 40'));
    at(3_000);
    cards.onSubagentEnd('a', true);
    cards.onSubagentEnd('never-seen', true);
    await flush();
    expect(shown).toEqual(['↳ short ✓ 3.0s\n💻 Bash: "ls"', '↳ long\n💻 Bash: "sleep 40"']);
    at(9_000);
    cards.onSubagentEnd('b', false);
    cards.endAll(true);
    await flush();
    expect(shown[1]).toBe('↳ long ✗ 9.0s\n💻 Bash: "sleep 40"');
  });

  it('marks what was still running ✗ when the render is stopped, and keeps what had ended', async () => {
    const { cards, shown, flush, at } = setup();
    cards.onToolStart(sub('a', 'first', 1, 'ls'));
    cards.onToolStart(sub('b', 'second', 2, 'pwd'));
    at(2_000);
    cards.onToolFinish(spawnDone('a', 'foreground'));
    at(3_000);
    cards.endAll(false);
    await flush();
    expect(shown.map((t) => t.split('\n')[0])).toEqual(['↳ first ✓ 2.0s', '↳ second ✗ 3.0s']);
  });

  it('opens a card again for a tool that arrives after it ended', async () => {
    const { cards, shown, flush } = setup();
    cards.onToolStart(sub('a', 'probe', 1, 'ls'));
    cards.endAll(true);
    cards.onToolStart(sub('a', 'probe', 2, 'pwd'));
    await flush();
    expect(shown).toEqual(['↳ probe\n💻 Bash: "ls"\n💻 Bash: "pwd"']);
  });

  it('draws no card for a subagent that ran no tools', async () => {
    const { cards, shown, flush } = setup();
    cards.onToolFinish(spawnDone('a', 'foreground'));
    cards.endAll(true);
    await flush();
    expect(shown).toEqual([]);
  });

  it('sends every message of a subagent under its key, a bubble it overflowed into included', async () => {
    const { cards, shown, series, flush } = setup(80);
    cards.onToolStart(sub('a', 'probe', 1, 'cat one.txt'));
    cards.onToolFinish(done('a', 1));
    await flush();
    cards.onToolStart(sub('b', 'other', 2, 'ls'));
    cards.onToolStart(sub('a', 'probe', 3, 'cat a-much-longer-file-name.txt'));
    cards.onToolFinish(done('a', 3));
    await flush();
    // The first bubble filled up and the card went on in another: every one of them is subagent a's.
    const probe = shown.flatMap((t, i) => (t.startsWith('↳ probe') ? [series[i]] : []));
    expect(probe.length).toBeGreaterThan(1);
    expect(probe.every((k) => k === 'a')).toBe(true);
    expect(series[shown.findIndex((t) => t.startsWith('↳ other'))]).toBe('b');
  });

  it('keeps one key for a subagent paused with its render and resumed in the next, running again and then ✓', async () => {
    const { cards, shown, series, flush, at, render } = setup();
    // Render 1: the subagent runs a tool, and the render ends with it still alive (paused).
    cards.onToolStart(sub('a', 'probe', 1, 'ls'));
    cards.onToolFinish(done('a', 1));
    at(4_000);
    cards.endAll(true);
    await flush();
    expect(shown).toEqual(['↳ probe ✓ 4.0s\n💻 Bash: "ls" ✓ 100ms']);
    // Render 2: it is resumed, under the same call — a new card, but the same subagent.
    const next = render();
    at(10_000);
    next.onToolStart(sub('a', 'probe', 2, 'pwd'));
    await flush();
    expect(shown[1]).toBe('↳ probe\n💻 Bash: "pwd"');
    at(12_500);
    next.onToolFinish(done('a', 2));
    next.onSubagentEnd('a', true);
    await flush();
    expect(shown[1]).toBe('↳ probe ✓ 2.5s\n💻 Bash: "pwd" ✓ 100ms');
    expect(series).toEqual(['a', 'a']);
  });
});
