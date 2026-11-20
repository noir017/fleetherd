import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * A tool call inside a code block. The turn runner starts a new message at every tool call, and a
 * browser-driven harness reports the page's steps as tool calls wherever they fall in the answer:
 * on 2026-11-20 one fell just before a reply's closing fence, the next message opened with that
 * fence, and its paragraph and footer rendered as code. Each message must stand on its own.
 */

function inbound(content: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId: 'm1',
    content,
    timestamp: 0,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function rig(runTurn: (h: AgentStreamHandlers) => Promise<void>, stream: boolean) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: false } },
  });
  const cfg: Config = {
    ...parsed,
    inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 },
    stream: { ...parsed.stream, enabled: stream, charThreshold: 1, flushIntervalMs: 1 },
  };
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  /** The reply's messages as they stand now (tool bubbles left out), by message id. */
  const shown = new Map<string, string>();
  let seq = 0;
  const platform = {
    capabilities: { thread: false, editMessage: true, maxMessageLength: 2000 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: { channel: string }, text: string, opts?: { kind?: string }) => {
      const messageId = `m${++seq}`;
      if (opts?.kind !== 'tools') shown.set(messageId, text);
      return { address, messageId };
    },
    editMessage: async (ref: { messageId: string }, text: string) => {
      if (shown.has(ref.messageId)) shown.set(ref.messageId, text);
    },
    addReaction: async () => {},
    removeReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  const factory: AgentFactory = {
    getOrCreate(conversationId): AgentSession {
      return {
        conversationId,
        runTurn: async (_input, h) => runTurn(h),
        abort: () => {},
        setFollowUpSink: () => {},
        dispose: () => {},
      };
    },
    peek: () => undefined,
    dispose: () => {},
  };

  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock);
  return { reg, messages: () => [...shown.values()] };
}

/** A step between two stretches of text, the way agent-acp reports one: break, tool, break. */
function step(t: AgentStreamHandlers, id: string): void {
  t.onSegmentBreak();
  t.onToolStart({ name: 'Tool', inputPreview: 'step', index: 0, id });
  t.onToolFinish({ name: 'Tool', index: 0, id, ok: true, durationMs: 1 });
  t.onSegmentBreak();
}

describe('a tool call inside a code block', () => {
  for (const stream of [false, true]) {
    const mode = stream ? 'live' : 'once';

    it(`${mode}: just before the closing fence — the next message is text, not code`, async () => {
      const h = rig(async (t) => {
        t.onText('Roll back:\n\n```\nmv a.bak a\nsudo up -d\n');
        step(t, 's1');
        t.onText('```\n\nThe build passed.');
      }, stream);
      h.reg.route(inbound('handoff'));
      await sleep(150);

      expect(h.messages()).toEqual(['Roll back:\n\n```\nmv a.bak a\nsudo up -d\n```', 'The build passed.']);
    });

    it(`${mode}: in the middle of a block, and again — each message reopens and closes it`, async () => {
      const h = rig(async (t) => {
        t.onText('Config:\n~~~yaml\na: 1\n');
        step(t, 's1');
        t.onText('b: 2\n');
        step(t, 's2');
        t.onText('c: 3\n~~~\nDone.');
      }, stream);
      h.reg.route(inbound('config'));
      await sleep(150);

      expect(h.messages()).toEqual([
        'Config:\n~~~yaml\na: 1\n~~~',
        '~~~yaml\nb: 2\n~~~',
        '~~~yaml\nc: 3\n~~~\nDone.',
      ]);
    });
  }
});
