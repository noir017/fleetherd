import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { FAILURE_NOTICE_CHARS, TurnRunner } from './turn-runner.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * What a FAILED turn leaves in the chat.
 *
 * ── The bug this pins ─────────────────────────────────────────────────────────
 * Reply text is sent when its segment completes — at the next tool boundary, or when the turn is
 * finalized — so the last segment of every turn, usually its conclusion, exists only in the
 * buffer until the end. The failure path posted `❌ This turn failed` and skipped the finalize, so
 * that segment was thrown away. Reported 2026-09-29: claude-agent-acp never closed a turn whose
 * answer had fully arrived, the watchdog failed it ten minutes later, and the answer was never
 * sent — the chat showed the model's opening line, its tool bubbles, and then only the ❌.
 *
 * The streaming setting is left at its default (off) on purpose: that is the delivery mode in
 * which the unsent segment is the whole of the conclusion, rather than a few unflushed characters.
 */

const HUNG = 'agent "cc" sent no update for 600000ms; treating it as hung and aborting this turn';

function inbound(content: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId: 'm1',
    content,
    timestamp: 0,
  };
}

/** Let the 1 ms merge window elapse, the turn run and fail, and the render chain drain. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

function rig(runTurn: (h: AgentStreamHandlers) => Promise<void>) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: true } },
  });
  const cfg: Config = {
    ...parsed,
    inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 },
  };
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  /** Every message body the platform was asked to send, in order. */
  const sent: string[] = [];
  let seq = 0;
  const platform = {
    capabilities: { thread: false, editMessage: true, maxMessageLength: 2000 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `m${++seq}` };
    },
    editMessage: async () => {},
    addReaction: async () => {},
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
  return { reg, sent };
}

describe('a failed turn', () => {
  it('still delivers the reply it had produced, before saying it failed', async () => {
    const h = rig(async (t) => {
      t.onText('The bridge is online and the backend accepts its token.');
      throw new Error(HUNG);
    });
    h.reg.route(inbound('is the bridge up?'));
    await drain();

    expect(h.sent).toEqual([
      'The bridge is online and the backend accepts its token.',
      `❌ This turn failed: ${HUNG}`,
    ]);
  });

  it('delivers the segment after the last tool — where the conclusion is', async () => {
    // The live shape: an opening line, tools, and then the answer. The opening line was always
    // delivered (a tool boundary sends it); the answer after the last tool was the part lost.
    const h = rig(async (t) => {
      t.onText('Checking the bridge from the backend.');
      t.onToolStart({ name: 'Bash', inputPreview: 'curl /health', index: 0 });
      t.onToolFinish({ name: 'Bash', ok: true, durationMs: 5, index: 0 });
      t.onSegmentBreak();
      t.onText('The bridge is online: /health answered 200.');
      throw new Error(HUNG);
    });
    h.reg.route(inbound('is the bridge up?'));
    await drain();

    const answer = h.sent.indexOf('The bridge is online: /health answered 200.');
    const failure = h.sent.indexOf(`❌ This turn failed: ${HUNG}`);
    expect(h.sent[0]).toBe('Checking the bridge from the backend.');
    expect(answer).toBeGreaterThan(0);
    expect(failure).toBeGreaterThan(answer);
  });

  it('carries no footer on the partial reply — the turn did not finish', async () => {
    // A footer is the mark of a completed answer; putting one on the text of a turn that is about
    // to say it failed would contradict the very next message.
    const h = rig(async (t) => {
      t.onText('Half of an answer');
      throw new Error(HUNG);
    });
    h.reg.route(inbound('go'));
    await drain();
    expect(h.sent[0]).toBe('Half of an answer');

    // Control: the same rig DOES footer a turn that finishes, so the assertion above is about the
    // failure path and not about a footer that was never going to appear.
    const ok = rig(async (t) => void t.onText('A whole answer'));
    ok.reg.route(inbound('go'));
    await drain();
    expect(ok.sent[0]).toMatch(/^A whole answer\n\n.+/s);
  });

  it('sends only the failure when the turn had produced nothing', async () => {
    const h = rig(async () => {
      throw new Error(HUNG);
    });
    h.reg.route(inbound('go'));
    await drain();

    expect(h.sent).toEqual([`❌ This turn failed: ${HUNG}`]);
  });
});

describe('a failed turn’s record', () => {
  it('keeps the whole error, not the opening the ❌ notice carries', async () => {
    // Longer than the 4,000-character update card: before this, the rest of it existed nowhere —
    // the chat notice has 300 characters and the library kept 500.
    const error = `Process exited 1:\n${'  at step (file.ts:1:1)\n'.repeat(600)}`;
    const ended: Array<{ outcome: string; detail?: string }> = [];
    const live: Array<{ turn?: number }> = [];
    const platform = {
      capabilities: { thread: false, editMessage: true, maxMessageLength: 2_000 },
      measureRendered: (s: string) => s.length,
      sendMessage: async (address: { channel: string }) => ({ address, messageId: 'm' }),
      editMessage: async () => {},
      addReaction: async () => {},
      startTyping: async () => {},
      stopTyping: async () => {},
    } as unknown as PlatformAdapter;
    const factory: AgentFactory = {
      getOrCreate: (conversationId): AgentSession => ({
        conversationId,
        runTurn: async () => {
          throw new Error(error);
        },
        abort: () => {},
        dispose: () => {},
      }),
      peek: () => undefined,
      dispose: () => {},
    };
    const cfg = parseConfig({
      platforms: { discord: { type: 'discord', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc', pipeline: [] },
    });
    const runner = new TurnRunner(
      cfg,
      new Map([['discord', platform]]),
      factory,
      { now: () => 1_000, schedule: () => () => {} },
      {
        tokenFor: () => 'tok',
        agentIdOf: () => 'cc',
        getModelOverride: () => undefined,
        setLane: () => {},
        beginHistoryTurn: () => ({ id: 1, seq: 7 }),
        endHistoryTurn: (_id, end) => ended.push(end),
        recordTurnEnd: (_id, end) => live.push(end),
      }
    );

    await expect(runner.runTurn('discord#c1', [inbound('go')])).rejects.toThrow(/Process exited 1/);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe('failed');
    expect(ended[0]!.detail).toBe(error);
    expect(ended[0]!.detail!.length).toBeGreaterThan(FAILURE_NOTICE_CHARS);
    // The live report carries the library's number for this turn, so the card can quote it by
    // number instead of by "last" (see TurnEnd.turn).
    expect(live).toEqual([{ kind: 'failed', error: expect.any(Error), turn: 7 }]);
  });
});
