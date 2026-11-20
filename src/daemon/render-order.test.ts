import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { withOutboundPacing } from './paced-adapter.js';
import { OutboundPacer } from '../core/outbound-pacer.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * The order a turn is READ in: ConversationRegistry → TurnRunner → ToolRenderer → paced adapter →
 * OutboundPacer → a fake Telegram, with one chronological log of everything that reached it.
 *
 * ── The bug this pins ─────────────────────────────────────────────────────────
 * Tool bubbles are painted asynchronously, off the turn's side-effect chain, so that a rate-limited
 * chat cannot stall the reply behind a progress write. The cost was invisible until someone read a
 * transcript: the painter runs one write BEHIND the chain, so the bubble for a tool was posted after
 * the body text of the segment that followed it. A real turn read
 *
 *     "Let me look at the config first."
 *     📖 Read: "config.yaml"
 *     "The config pins the model via env. Now the profile."
 *     "Found it — three profiles declare it."
 *     🔍 Grep: "menuPageSize"            ← the search that found them, below the finding
 *
 * with no rate pressure at all. It is the normal case, not a congestion edge, which is why the fix
 * is a barrier rather than a tuning change (TurnRunner BUBBLE_PLACEMENT_WAIT_MS / ToolRenderer.placed).
 *
 * Why a separate file from tool-flood.test.ts, which drives the same stack: that one asserts on
 * `[...sends, ...edits]`, a shape that cannot express interleaving at all — which is precisely how
 * this went unnoticed. Here every write lands in ONE array, in the order the platform saw it.
 */

const PLATFORM_LATENCY_MS = 12;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const drain = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

function inbound(content: string): InboundMessage {
  return {
    conversation: { platform: 'tg', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId: 'm1',
    content,
    timestamp: 0,
  };
}

function rig(opts: { ratePerSec?: number } = {}) {
  const parsed = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: false } },
  });
  const cfg: Config = {
    ...parsed,
    inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 },
    outbound: { ...parsed.outbound, ratePerSec: opts.ratePerSec ?? 1000 },
  };

  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  /** Every write, in the order the platform saw it. `kind` distinguishes a position from a rewrite. */
  const log: Array<{ kind: 'send' | 'edit'; id: string; text: string }> = [];
  let seq = 0;

  const platform = {
    platform: 'tg',
    platformType: 'telegram',
    capabilities: { thread: false, editMessage: true, maxMessageLength: 4096 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: { channel: string }, text: string) => {
      await sleep(PLATFORM_LATENCY_MS);
      const id = `m${++seq}`;
      log.push({ kind: 'send', id, text });
      return { address, messageId: id };
    },
    editMessage: async (ref: { messageId: string }, text: string) => {
      await sleep(PLATFORM_LATENCY_MS);
      log.push({ kind: 'edit', id: ref.messageId, text });
    },
    addReaction: async () => {},
    removeReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  const pacer = new OutboundPacer(cfg.outbound, clock);
  const paced = withOutboundPacing(platform, pacer);

  // The ordinary shape of a turn: say what you are about to do, do it, report, do it again, answer.
  const factory: AgentFactory = {
    getOrCreate(conversationId): AgentSession {
      return {
        conversationId,
        runTurn: async (_input, h: AgentStreamHandlers) => {
          h.onText('Let me look at the config first.');
          h.onToolStart({ name: 'Read', inputPreview: 'config.yaml', index: 0 });
          await sleep(20);
          h.onToolFinish({ name: 'Read', ok: true, durationMs: 20, index: 0 });
          h.onSegmentBreak();
          h.onText('The config pins the model via env. Now the profile.');
          h.onToolStart({ name: 'Grep', inputPreview: 'menuPageSize', index: 1 });
          await sleep(20);
          h.onToolFinish({ name: 'Grep', ok: true, durationMs: 20, index: 1 });
          h.onSegmentBreak();
          h.onText('Found it — three profiles declare it.');
        },
        abort: () => {},
        setFollowUpSink: () => {},
        dispose: () => {},
      };
    },
    peek: () => undefined,
    dispose: () => {},
  };

  const reg = new ConversationRegistry(cfg, new Map([['tg', paced]]), factory, clock);
  return {
    reg,
    log,
    /** What a reader scrolls past: messages in the order they took their place, edits folded in. */
    transcript(): string[] {
      const order: string[] = [];
      const latest = new Map<string, string>();
      for (const w of log) {
        if (w.kind === 'send') order.push(w.id);
        latest.set(w.id, w.text);
      }
      return order.map((id) => latest.get(id)!);
    },
  };
}

describe('a turn reads in the order it happened', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('puts each tool bubble between the text that announced it and the text that followed', async () => {
    const h = rig();
    h.reg.route(inbound('do the thing'));
    await drain(3_000);

    expect(h.transcript()).toEqual([
      'Let me look at the config first.',
      '📖 Read: "config.yaml" ✓ 20ms',
      'The config pins the model via env. Now the profile.',
      '🔍 Grep: "menuPageSize" ✓ 20ms',
      'Found it — three profiles declare it.',
    ]);
  }, 20_000);

  it('holds that order under the 1 write/sec the deployment actually runs at', async () => {
    // The rate limit is where a reordering would be easiest to dismiss as congestion. It is not:
    // the barrier is in the chain, so the queue drains in the same order either way.
    const h = rig({ ratePerSec: 1 });
    h.reg.route(inbound('do the thing'));
    await drain(20_000);

    expect(h.transcript()).toEqual([
      'Let me look at the config first.',
      '📖 Read: "config.yaml" ✓ 20ms',
      'The config pins the model via env. Now the profile.',
      '🔍 Grep: "menuPageSize" ✓ 20ms',
      'Found it — three profiles declare it.',
    ]);
  }, 40_000);

  it('never rewrites a message that was sent after it — an edit only ever touches the newest bubble', async () => {
    const h = rig();
    h.reg.route(inbound('do the thing'));
    await drain(3_000);

    // A ✓ landing late is fine (it rewrites a message already in place); a ✓ landing on a bubble
    // that sits ABOVE text posted since is what the reader experiences as scrambled.
    const placedAt = new Map<string, number>();
    h.log.forEach((w, i) => {
      if (w.kind === 'send') placedAt.set(w.id, i);
    });
    for (const [i, w] of h.log.entries()) {
      if (w.kind !== 'edit') continue;
      const sendsAfter = h.log
        .slice(placedAt.get(w.id)! + 1, i)
        .filter((later) => later.kind === 'send');
      expect(sendsAfter).toEqual([]);
    }
  }, 20_000);
});
