import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { ListChannelsResult, TaskListResult, TaskRow } from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { TopicActivity } from '../types.js';
import { dispatcherConversations } from './dispatcher-home.js';
import { CARD_DELAY_MS, Dispatcher } from './dispatcher.js';

/**
 * The dispatcher (dispatcher.ts): who may run the task commands, what they do to the registry, what
 * the list says, and the `[topic updates]` card — gathered, re-decided, and sent only to the
 * dispatcher. The registry is a fake: what it does with an openTask is ConversationRegistry's to test.
 */

const D = 'web#main#d15a7c40';
const A = 'web#main#aaaaaaaa';
const B = 'web#main#bbbbbbbb';
const keyOf = (a: ConversationAddress): string => `web#${a.channel}#${a.thread ?? ''}`;

function config(dispatcher = true): Config {
  return parseConfig({
    platforms: { web: { type: 'webui', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude', model: 'opus' },
      { id: 'disp', harness: 'claude' },
    ],
    routing: { default: 'cc', pipeline: [] },
    ...(dispatcher ? { dispatcher: { agent: 'disp' } } : {}),
  });
}

function manualClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  return {
    now: () => now,
    schedule(fn: () => void, ms: number) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers) {
        if (!t.live || t.at > now) continue;
        t.live = false;
        t.fn();
      }
    },
  };
}

function rig(opts: { dispatcher?: boolean } = {}) {
  const clock = manualClock();
  const lanes: boolean[] = [];
  const posted: Array<{ to: string; text: string; tools?: boolean }> = [];
  const seen = new Map<string, number>();
  const platform = {
    capabilities: { thread: true },
    dispatchLane: (on: boolean) => {
      lanes.push(on);
      return on ? { channel: 'main', thread: 'd15a7c40' } : undefined;
    },
    seenAt: (a: ConversationAddress) => seen.get(keyOf(a)),
    sendMessage: async (a: ConversationAddress, text: string, o?: { kind?: string }) => {
      posted.push({ to: keyOf(a), text, ...(o?.kind === 'tools' ? { tools: true } : {}) });
      return { address: a, messageId: 'm' };
    },
    fetchHistory: async () => [
      { conversation: {}, messageId: '1', content: 'do it', timestamp: 0, authorIsBot: false },
      { conversation: {}, messageId: '2', content: 'done', timestamp: 1000, authorIsBot: true },
    ],
  } as unknown as PlatformAdapter;

  const activity = new Map<string, TopicActivity>();
  const busy = new Set<string>();
  const calls: Array<[string, unknown]> = [];
  const prompts: Array<{ key: string; prompt: string }> = [];
  const registry = {
    bindDispatcher: (key: string, _p: string, agent: string) => calls.push(['bind', { key, agent }]),
    resetConversation: (key: string) => calls.push(['reset', key]),
    openTask: async (o: unknown) => {
      calls.push(['open', o]);
      return { key: A, address: { channel: 'main', thread: 'aaaaaaaa' } };
    },
    handTo: async (key: string, _p: string, _a: ConversationAddress, text: string) => {
      calls.push(['hand', { key, text }]);
      return busy.has(key) ? ('joined' as const) : ('started' as const);
    },
    stopConversation: (key: string) => {
      calls.push(['stop', key]);
      return busy.has(key) ? ('running' as const) : ('idle' as const);
    },
    isBusy: (key: string) => busy.has(key),
    isAsking: () => false,
    activityOf: (key: string) => activity.get(key),
    replyExcerptOf: (key: string) => (activity.get(key)?.outcome?.kind === 'done' ? 'Full reply text' : undefined),
    workdirOf: () => '/home/u/workspace/quantlab',
    boundAgentOf: () => 'cc',
    workdirChoices: () => ({ root: '/home/u/workspace', dirs: ['/home/u/workspace/quantlab', '/home/u/workspace/talkcode'] }),
    conversationAt: (_p: string, a: ConversationAddress) =>
      [D, A, B].includes(keyOf(a)) ? { key: keyOf(a), agent: 'cc' } : { key: keyOf(a) },
    laneFor: (key: string) => ({ platformId: 'web', address: { channel: 'main', thread: key.split('#')[2]! } }),
    listChannels: (): ListChannelsResult => ({
      channels: [
        { id: 'web:main', kind: 'channel', platform: 'webui', title: '', agent: '', lastAt: '', current: false },
        { id: 'web:main/d15a7c40', kind: 'topic', platform: 'webui', title: '📥', agent: 'disp', lastAt: '3', current: true },
        { id: 'web:main/aaaaaaaa', kind: 'topic', platform: 'webui', title: '[cc] A', agent: 'cc', lastAt: '2', current: false },
        { id: 'web:main/bbbbbbbb', kind: 'topic', platform: 'webui', title: '[cc] B', agent: 'cc', lastAt: '1', current: false },
      ],
      totalTopics: 3,
      limit: 200,
    }),
    runScheduledPrompt: async (o: { key: string; prompt: string }) => {
      prompts.push({ key: o.key, prompt: o.prompt });
      return 'ok' as const;
    },
  };
  const cfg = config(opts.dispatcher ?? true);
  const dispatcher = new Dispatcher({
    config: cfg,
    platforms: new Map([['web', platform]]),
    registry: registry as never,
    clock,
  });
  dispatcher.configure();
  return { dispatcher, clock, lanes, posted, seen, activity, busy, calls, prompts };
}

afterEach(() => dispatcherConversations.clear());

describe('Dispatcher.configure', () => {
  it('opens the platform’s dispatcher topic, binds it to dispatcher.agent and marks it for the runtimes', () => {
    const r = rig();
    expect(r.lanes).toEqual([true]);
    expect(r.calls).toContainEqual(['bind', { key: D, agent: 'disp' }]);
    expect(r.dispatcher.isDispatcher(D)).toBe(true);
    expect(dispatcherConversations.has(D)).toBe(true);
  });

  it('without dispatcher: retires the topic and marks nothing', () => {
    const r = rig({ dispatcher: false });
    expect(r.lanes).toEqual([false]);
    expect(r.dispatcher.active).toBe(false);
    expect(dispatcherConversations.size).toBe(0);
  });
});

describe('Dispatcher.handle — who may', () => {
  it('refuses every task command to any conversation but the dispatcher’s', async () => {
    const r = rig();
    await expect(r.dispatcher.handle(A, { kind: 'task-list' })).rejects.toThrow(/dispatcher's command, and runs only in its topic/);
    await expect(r.dispatcher.handle(undefined, { kind: 'task-agents' })).rejects.toThrow(/only in its topic/);
  });

  it('says so when no dispatcher is configured at all', async () => {
    const r = rig({ dispatcher: false });
    await expect(r.dispatcher.handle(D, { kind: 'task-list' })).rejects.toThrow(/no dispatcher is configured/);
  });
});

describe('Dispatcher.handle — what it does', () => {
  it('task-agents lists every agent with its directories by name', async () => {
    const r = rig();
    const out = (await r.dispatcher.handle(D, { kind: 'task-agents' })) as { agents: Array<{ id: string; dirs: string[]; model: string }> };
    expect(out.agents.map((a) => a.id)).toEqual(['cc', 'disp']);
    expect(out.agents[0]).toMatchObject({ model: 'opus', dirs: ['quantlab', 'talkcode'] });
  });

  it('task-new opens next to the dispatcher topic and answers with the row and its link', async () => {
    const r = rig();
    const out = (await r.dispatcher.handle(D, { kind: 'task-new', agent: 'cc', text: 'fix the bump', cwd: 'quantlab' })) as {
      task: TaskRow;
    };
    expect(r.calls).toContainEqual([
      'open',
      { platform: 'web', root: { channel: 'main' }, agentId: 'cc', text: 'fix the bump', cwd: 'quantlab' },
    ]);
    expect(out.task).toMatchObject({ topic: 'web:main/aaaaaaaa', link: '?t=aaaaaaaa', cwd: '~/workspace/quantlab' });
  });

  it('task-send takes a bare web UI topic id, and says whether the agent was mid-turn', async () => {
    const r = rig();
    expect(await r.dispatcher.handle(D, { kind: 'task-send', topic: 'aaaaaaaa', text: '开工' })).toMatchObject({ result: /starting on it/ });
    r.busy.add(A);
    expect(await r.dispatcher.handle(D, { kind: 'task-send', topic: 'web:main/aaaaaaaa', text: 'also docs' })).toMatchObject({
      result: /already working/,
    });
    expect(r.calls.filter(([k]) => k === 'hand')).toEqual([
      ['hand', { key: A, text: '开工' }],
      ['hand', { key: A, text: 'also docs' }],
    ]);
  });

  it('refuses to hand work to the dispatcher topic itself, or to nowhere', async () => {
    const r = rig();
    await expect(r.dispatcher.handle(D, { kind: 'task-send', topic: 'd15a7c40', text: 'x' })).rejects.toThrow(/dispatcher topic itself/);
    await expect(r.dispatcher.handle(D, { kind: 'task-send', topic: 'cccccccc', text: 'x' })).rejects.toThrow(/nothing has happened/);
  });

  it('task-stop stops and marks it there, or says nothing was running', async () => {
    const r = rig();
    expect(await r.dispatcher.handle(D, { kind: 'task-stop', topic: 'bbbbbbbb' })).toMatchObject({ result: 'Nothing was running there.' });
    r.busy.add(B);
    expect(await r.dispatcher.handle(D, { kind: 'task-stop', topic: 'bbbbbbbb' })).toMatchObject({ result: /^Stopped/ });
    expect(r.posted).toContainEqual({ to: B, text: '⏹ Stopped by the dispatcher.' });
  });

  it('task-read returns who said what, oldest first', async () => {
    const r = rig();
    const out = await r.dispatcher.handle(D, { kind: 'task-read', topic: 'aaaaaaaa' });
    expect(out).toMatchObject({ messages: [{ from: 'person', text: 'do it' }, { from: 'agent', text: 'done' }] });
  });

  it('task-list leaves out its own topic and puts what needs the person first', async () => {
    const r = rig();
    r.activity.set(B, { outcome: { kind: 'failed', at: 5, line: 'upstream 503', reason: 'service' } });
    const out = (await r.dispatcher.handle(D, { kind: 'task-list' })) as TaskListResult;
    expect(out.tasks.map((t) => [t.topic, t.stage, t.line])).toEqual([
      ['web:main/bbbbbbbb', 'failed', 'upstream 503'],
      ['web:main/aaaaaaaa', 'idle', ''],
    ]);
    expect(out.total).toBe(2);
  });
});

describe('Dispatcher: topic updates', () => {
  it('gathers a burst into one card, shows it folded, and puts it in front of the dispatcher', () => {
    const r = rig();
    r.activity.set(A, { outcome: { kind: 'done', at: 10, line: 'Done: green' } });
    r.activity.set(B, { outcome: { kind: 'failed', at: 10, line: 'upstream 503', reason: 'service' } });
    r.dispatcher.needsPerson(A);
    r.dispatcher.needsPerson(B);
    expect(r.prompts).toEqual([]);
    r.clock.advance(CARD_DELAY_MS);
    expect(r.prompts).toHaveLength(1);
    const card = r.prompts[0]!;
    expect(card.key).toBe(D);
    expect(card.prompt.split('\n')[0]).toBe('[topic updates]');
    expect(card.prompt).toContain('web:main/aaaaaaaa');
    expect(card.prompt).toContain('reply: Full reply text');
    expect(card.prompt).toContain('failure: upstream 503');
    expect(card.prompt).toContain('link: ?t=bbbbbbbb');
    expect(r.posted.filter((p) => p.tools)).toEqual([
      { to: D, text: expect.stringContaining('🔔'), tools: true },
    ]);
  });

  it('leaves out what the person read in the meantime, and sends nothing when that is everything', () => {
    const r = rig();
    r.activity.set(A, { outcome: { kind: 'done', at: 10 } });
    r.dispatcher.needsPerson(A);
    r.seen.set(A, 11);
    r.clock.advance(CARD_DELAY_MS);
    expect(r.prompts).toEqual([]);
  });

  it('never reports on the dispatcher topic itself, and does nothing without a dispatcher', () => {
    const r = rig();
    r.activity.set(D, { outcome: { kind: 'done', at: 10 } });
    r.dispatcher.needsPerson(D);
    r.clock.advance(CARD_DELAY_MS);
    expect(r.prompts).toEqual([]);

    const off = rig({ dispatcher: false });
    off.activity.set(A, { outcome: { kind: 'done', at: 10 } });
    off.dispatcher.needsPerson(A);
    off.clock.advance(CARD_DELAY_MS);
    expect(off.prompts).toEqual([]);
  });
});
