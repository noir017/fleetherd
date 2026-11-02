import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import { TurnFailure } from './agent.js';
import type { InboundMessage, TopicActivity } from '../types.js';

/**
 * The turn-outcome and dispatcher wiring through a real registry, merger and turn runner, with a fake
 * agent: what a failed turn turns into when `hooks.turnFailed.continue` is set, and what the
 * dispatcher's hands (openTask, handTo, the topic refusal) do to real conversations.
 */

const wait = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

function inbound(content: string, thread = 'tt'): InboundMessage {
  return {
    conversation: { platform: 'web', channel: 'main', thread, kind: 'direct', user: 'owner' },
    messageId: `m-${content}`,
    content,
    timestamp: 0,
  };
}

function rig(opts: { continue?: Record<string, unknown>; script?: Array<'fail' | 'ok'>; dispatcherTopic?: string } = {}) {
  const parsed = parseConfig({
    platforms: { web: { type: 'webui', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude', ...(opts.continue ? { hooks: { turnFailed: { continue: opts.continue } } } : {}) },
      { id: 'oc', harness: 'opencode' },
    ],
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: false } },
  });
  const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
  // Every wait shortened, so a backoff is a test step rather than a test timeout: a minute or more to
  // 200 ms (time enough for the person to write first), anything shorter to 5 ms.
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms >= 60_000 ? 200 : Math.min(ms, 5));
      return () => clearTimeout(t);
    },
  };

  const sent: Array<{ to: string; text: string }> = [];
  const activity: Array<{ to: string; a: TopicActivity | undefined }> = [];
  let seq = 0;
  let threads = 0;
  const where = (a: ConversationAddress) => `${a.channel}/${a.thread ?? ''}`;
  const platform = {
    platform: 'web',
    capabilities: { thread: true, editMessage: true, maxMessageLength: 2000 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: ConversationAddress, text: string) => {
      sent.push({ to: where(address), text });
      return { address, messageId: `s${++seq}` };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    createThread: async () => ({ address: { channel: 'main', thread: `new${++threads}` } }),
    renameThread: async () => {},
    setActivity: (address: ConversationAddress, a: TopicActivity | undefined) => activity.push({ to: where(address), a }),
  } as unknown as PlatformAdapter;

  const script = [...(opts.script ?? [])];
  const prompts: Array<{ conversation: string; prompt: string }> = [];
  const factory: AgentFactory = {
    getOrCreate(conversationId): AgentSession {
      return {
        runTurn: async (input: { prompt: string }, h: AgentStreamHandlers) => {
          prompts.push({ conversation: conversationId, prompt: input.prompt });
          const next = script.shift() ?? 'ok';
          if (next === 'fail') throw new TurnFailure('upstream 503', 'service');
          h.onText('Done: all green.');
        },
        abort: () => {},
        setFollowUpSink: () => {},
        dispose: () => {},
      } as unknown as AgentSession;
    },
    peek: () => undefined,
    dispose: () => {},
  };

  const dispatcherKey = opts.dispatcherTopic ? `web#main#${opts.dispatcherTopic}` : undefined;
  const registry = new ConversationRegistry(cfg, new Map([['web', platform]]), factory, clock, {
    isDispatcher: (id) => id === dispatcherKey,
  });
  return { registry, sent, prompts, activity };
}

let live: ConversationRegistry | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

describe('hooks.turnFailed.continue through a real turn', () => {
  it('continues after a failure with the operator’s words until a turn succeeds', async () => {
    const r = rig({ continue: { on: ['service'], message: '继续', max: 3, backoffMs: 1_000 }, script: ['fail', 'fail', 'ok'] });
    live = r.registry;
    r.registry.route(inbound('build it'));
    for (let i = 0; i < 20 && r.prompts.length < 3; i++) await wait(20);
    await wait();
    expect(r.prompts.map((p) => p.prompt)).toEqual(['build it', '继续', '继续']);
    expect(r.sent.filter((m) => m.text.startsWith('↻')).map((m) => m.text.match(/\(\d\/3\)/)?.[0])).toEqual(['(1/3)', '(2/3)']);
    expect(r.sent.filter((m) => m.text.startsWith('❌'))).toHaveLength(2);
    expect(r.activity[r.activity.length - 1]?.a?.outcome).toMatchObject({ kind: 'done', line: 'Done: all green.' });
  });

  it('a message from the person calls the continue off', async () => {
    const r = rig({ continue: { on: ['service'], backoffMs: 60_000 }, script: ['fail'] });
    live = r.registry;
    r.registry.route(inbound('build it'));
    await wait(30);
    r.registry.route(inbound('/stop'));
    await wait(300);
    expect(r.prompts.map((p) => p.prompt)).not.toContain('continue');
  });

  it('does nothing extra without a policy', async () => {
    const r = rig({ script: ['fail'] });
    live = r.registry;
    r.registry.route(inbound('build it'));
    await wait();
    expect(r.prompts.map((p) => p.prompt)).toEqual(['build it']);
    expect(r.activity[r.activity.length - 1]?.a?.outcome).toMatchObject({ kind: 'failed', reason: 'service', line: 'upstream 503' });
  });
});

describe('the dispatcher’s hands', () => {
  it('openTask opens a topic, binds it, shows the request as the dispatcher’s, and runs it verbatim', async () => {
    const r = rig();
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', root: { channel: 'main' }, agentId: 'oc', text: '修一下 bump' });
    expect(opened).toEqual({ key: 'web#main#new1', address: { channel: 'main', thread: 'new1' } });
    await wait();
    expect(r.registry.boundAgentOf(opened.key)).toBe('oc');
    expect(r.sent).toContainEqual({ to: 'main/new1', text: '**📥 From the dispatcher**\n\n修一下 bump' });
    expect(r.prompts).toEqual([{ conversation: 'web#main#new1', prompt: '修一下 bump' }]);
  });

  it('openTask refuses an agent that is not configured, before opening anything', async () => {
    const r = rig();
    live = r.registry;
    await expect(r.registry.openTask({ platform: 'web', root: { channel: 'main' }, agentId: 'zz', text: 'x' })).rejects.toThrow(
      /no agent "zz"/
    );
    expect(r.sent).toEqual([]);
  });

  it('handTo refuses a conversation nobody has answered yet', async () => {
    const r = rig();
    live = r.registry;
    await expect(r.registry.handTo('web#main#never', 'web', { channel: 'main', thread: 'never' }, 'x')).rejects.toThrow(/nobody answers/);
  });

  it('the dispatcher topic refuses another agent and another directory', async () => {
    const r = rig({ dispatcherTopic: 'd15a7c40' });
    live = r.registry;
    for (const cmd of ['/oc hello', '/agent oc', '/cd quantlab']) {
      r.registry.route(inbound(cmd, 'd15a7c40'));
    }
    await wait();
    expect(r.sent.filter((m) => m.text.startsWith("📥 This is the dispatcher's topic"))).toHaveLength(3);
    expect(r.prompts).toEqual([]);
  });
});
