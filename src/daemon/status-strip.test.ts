import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { AgentStatus, InboundMessage } from '../types.js';

/**
 * The web UI's status strip, end to end through the registry: what a harness reports during a turn
 * reaches `PlatformAdapter.setStatus` for the conversation's lane, and a reset takes it down.
 *
 * status-board.test.ts pins the board's own rules (throttle, dedupe, cache reads). This pins the
 * WIRING — that the TurnRunner deps feed the board and that `/new` reaches it — which is the part a
 * refactor of the registry could silently drop while every board test stayed green.
 */

const drain = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

function rig(opts: { canShow: boolean }) {
  const shown: Array<AgentStatus | undefined> = [];
  let report: (h: AgentStreamHandlers) => void = () => {};

  const sessions = new Map<string, AgentSession>();
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (_input, handlers) => report(handlers),
          abort: () => {},
          dispose: () => {},
          modelSelector: () => undefined,
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const platform = {
    capabilities: { thread: false, editMessage: true },
    sendMessage: async (address: { channel: string }) => ({ address, messageId: 'm1' }),
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
    ...(opts.canShow ? { setStatus: (_a: unknown, s: AgentStatus | undefined) => void shown.push(s) } : {}),
  } as unknown as PlatformAdapter;

  const config = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'agy', harness: 'agy', model: 'gemini-3.8-flash-high' }],
    routing: { default: 'agy' },
  });
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  };
  const reg = new ConversationRegistry(
    { ...config, inbound: { ...config.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } },
    new Map([['discord', platform]]),
    factory,
    clock
  );

  let n = 0;
  const send = async (content: string): Promise<void> => {
    reg.route({
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: `m${++n}`,
      content,
      timestamp: 0,
    } as InboundMessage);
    await drain();
  };
  return { reg, send, shown, onTurn: (fn: (h: AgentStreamHandlers) => void) => void (report = fn), dispose: () => reg.dispose() };
}

describe('the status strip, through the registry', () => {
  it('passes what the harness reported during a turn to the platform that can show it', async () => {
    const r = rig({ canShow: true });
    r.onTurn((h) => {
      h.onModel?.('Claude Opus 5.5 (Medium)');
      h.onUsage?.({ used: 17_000, size: 1_048_576 });
      h.onQuota?.([{ id: '3p-5h', remaining: 0.9, active: true }]);
    });
    await r.send('hi');
    // Throttled: the first report shows at once, the rest of the turn lands at the window's end.
    await drain(2_100);
    expect(r.shown.at(-1)).toEqual({
      agent: 'agy',
      model: 'Claude Opus 5.5 (Medium)',
      context: { used: 17_000, size: 1_048_576 },
      quota: [{ id: '3p-5h', remaining: 0.9, active: true }],
    });
    r.dispose();
  });

  it('takes the strip down on /new — the context it described is gone', async () => {
    const r = rig({ canShow: true });
    r.onTurn((h) => h.onUsage?.({ used: 17_000, size: 1_048_576 }));
    await r.send('hi');
    expect(r.shown.at(-1)?.context).toEqual({ used: 17_000, size: 1_048_576 });
    await r.send('/new');
    expect(r.shown.at(-1)).toBeUndefined();
    r.dispose();
  });

  it('asks nothing of a platform with no strip', async () => {
    const r = rig({ canShow: false });
    r.onTurn((h) => h.onUsage?.({ used: 1, size: 10 }));
    await r.send('hi');
    expect(r.shown).toEqual([]);
    r.dispose();
  });

  it('lets a throwaway scheduled run go whole — its status and its outcome — and blanks nobody’s strip', async () => {
    // A platform that cannot open a topic: a new-session run posts into the target and is released
    // after (releaseScheduled). Each such run used to leave a status entry and an outcome behind.
    const r = rig({ canShow: true });
    r.onTurn((h) => h.onUsage?.({ used: 5, size: 100 }));
    const opened = await r.reg.openScheduledConversation({
      platform: 'discord',
      address: { channel: 'c1' },
      agentId: 'agy',
      title: 'nightly',
      ephemeralKey: 'schedule#t1#1',
    });
    expect(opened.ephemeral).toBe(true);
    await r.reg.runScheduledPrompt({ key: opened.key, platform: 'discord', address: { channel: 'c1' }, agentId: 'agy', prompt: 'go' });
    expect(r.reg.statusOf(opened.key)?.context).toEqual({ used: 5, size: 100 });
    expect(r.reg.activityOf(opened.key)?.outcome?.kind).toBe('done');

    const shownBefore = r.shown.length;
    r.reg.releaseScheduled(opened.key);
    expect(r.reg.statusOf(opened.key)).toBeUndefined();
    expect(r.reg.activityOf(opened.key)).toBeUndefined();
    // The lane it showed on is the person's own conversation: forgetting the run sends nothing there.
    expect(r.shown).toHaveLength(shownBefore);
    r.dispose();
  });
});
