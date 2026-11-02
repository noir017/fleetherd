import { describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { ListChannelsResult, TaskAgentsResult, TaskListResult } from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { TopicActivity } from '../types.js';
import { CARD_DELAY_MS, Delegation, PROPOSAL_GATHER_MS, type DelegationDeps } from './delegation.js';
import { jobInCommand, UPDATE_SENDER } from './turn-runner.js';

/**
 * Sub-agents (delegation.ts): who may run the task commands and on what, the confirmation card every
 * start waits on, and the `[sub-agent updates]` card — gathered, and sent only to the conversation
 * that opened the topics. The registry and the platform are fakes: what openTask does to a real
 * conversation is ConversationRegistry's to test (delegation-registry.test.ts).
 */

const P = 'web#main#aaaaaaaa';
const keyOf = (a: ConversationAddress): string => `web#${a.channel}#${a.thread ?? ''}`;
const addrOf = (key: string): ConversationAddress => {
  const [, channel, thread] = key.split('#');
  return { channel: channel!, ...(thread ? { thread } : {}) };
};

function config(): Config {
  return parseConfig({
    platforms: { web: { type: 'webui', token: 't' }, tg: { type: 'telegram', token: 'x' } },
    hosts: { far: { ssh: 'u@far' }, near: { ssh: 'u@near' } },
    agents: [
      { id: 'oc2', harness: 'opencode', host: 'far' },
      { id: 'cc', harness: 'claude', host: 'near', model: 'opus' },
      { id: 'cx', harness: 'codex', host: 'near' },
      { id: 'local', harness: 'claude' },
    ],
    routing: { default: 'cc', pipeline: [] },
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

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function rig(opts: { answer?: string | null; failOpen?: string } = {}) {
  const clock = manualClock();
  const posted: Array<{ to: string; text: string; tools?: boolean }> = [];
  const parents = new Map<string, string>(); // child key → parent key
  const bound = new Map<string, string>([[P, 'cc']]);
  const activity = new Map<string, TopicActivity>();
  const busy = new Set<string>();
  const calls: Array<[string, unknown]> = [];
  const cards: Array<{ text: string; labels: string[]; signal: AbortSignal }> = [];
  let threads = 0;
  const platform = {
    capabilities: { thread: true },
    parentOf: (a: ConversationAddress) => {
      const p = parents.get(keyOf(a));
      return p ? addrOf(p) : undefined;
    },
    childrenOf: (a: ConversationAddress) =>
      [...parents.entries()].filter(([, p]) => p === keyOf(a)).map(([c]) => addrOf(c)),
    sendMessage: async (a: ConversationAddress, text: string, o?: { kind?: string }) => {
      posted.push({ to: keyOf(a), text, ...(o?.kind === 'tools' ? { tools: true } : {}) });
      return { address: a, messageId: 'm' };
    },
    fetchHistory: async () => [
      { conversation: {}, messageId: '1', content: 'do it', timestamp: 0, authorIsBot: false },
      { conversation: {}, messageId: '2', content: 'done', timestamp: 1000, authorIsBot: true },
    ],
  } as unknown as PlatformAdapter;
  const telegram = { capabilities: { thread: true }, sendMessage: async () => ({ messageId: 'm' }) } as unknown as PlatformAdapter;

  const registry = {
    openTask: async (o: { parent: ConversationAddress; agentId: string; text: string; header: string; cwd?: string }) => {
      calls.push(['openTask', o]);
      if (o.agentId === opts.failOpen) throw new Error(`no directory ${o.cwd} on the machine`);
      const key = `web#main#c${++threads}0000000`.slice(0, 17);
      parents.set(key, keyOf(o.parent));
      bound.set(key, o.agentId);
      return { key, address: addrOf(key) };
    },
    handTo: async (key: string, _p: string, _a: ConversationAddress, text: string, header: string) => {
      calls.push(['handTo', { key, text, header }]);
      return 'started' as const;
    },
    isBusy: (k: string) => busy.has(k),
    isAsking: () => false,
    workdirChoices: (id: string) => ({ root: `/home/u/${id}`, dirs: [`/home/u/${id}/talkcode`] }),
    listChannels: (): ListChannelsResult => ({
      channels: [...bound.keys()].map((k) => ({
        id: `web:main/${addrOf(k).thread}`,
        kind: 'topic' as const,
        platform: 'web',
        title: k === P ? 'Release' : `[${bound.get(k)}] part`,
        agent: bound.get(k) ?? '',
        lastAt: '',
        current: false,
      })),
      totalTopics: bound.size,
      limit: 200,
    }),
    conversationAt: (_p: string, a: ConversationAddress) => {
      const key = keyOf(a);
      return bound.has(key) ? { key, agent: bound.get(key)! } : { key };
    },
    laneFor: (k: string) => ({ platformId: k.startsWith('tg#') ? 'tg' : 'web', address: addrOf(k) }),
    activityOf: (k: string) => activity.get(k),
    replyExcerptOf: (k: string) => (activity.get(k)?.outcome?.kind === 'done' ? 'Done: all green, 12 tests.' : undefined),
    stopConversation: (k: string) => {
      calls.push(['stop', k]);
      return 'stopped' as const;
    },
    runScheduledPrompt: async (o: unknown) => {
      calls.push(['prompt', o]);
      return { kind: 'ran' };
    },
    workdirOf: () => '/home/u/workspace/talkcode',
    boundAgentOf: (k: string) => bound.get(k),
  };

  const deps: DelegationDeps = {
    config: config(),
    platforms: new Map([
      ['web', platform],
      ['tg', telegram],
    ]),
    registry: registry as unknown as DelegationDeps['registry'],
    clock,
    confirm: ({ text, labels, signal }) => {
      cards.push({ text, labels, signal });
      return Promise.resolve(opts.answer === undefined ? (labels[0] ?? null) : opts.answer);
    },
  };
  return { d: new Delegation(deps), clock, posted, parents, bound, activity, busy, calls, cards };
}

const task = (agent: string, text: string, extra: Record<string, string> = {}) => ({ kind: 'task-new' as const, agent, text, ...extra });

describe('Delegation: where the commands run', () => {
  it('refuses a call from no conversation, and a platform that cannot nest topics', async () => {
    const r = rig();
    await expect(r.d.handle(undefined, { kind: 'task-agents' })).rejects.toThrow(/from a conversation's own turn/);
    await expect(r.d.handle('tg#1#2', { kind: 'task-agents' })).rejects.toThrow(/only the web UI can show.*telegram/);
  });

  it('lists the agents on the asking agent’s own machine first, and marks them', async () => {
    const r = rig();
    const res = (await r.d.handle(P, { kind: 'task-agents' })) as TaskAgentsResult;
    expect(res.agents.map((a) => [a.id, a.where, a.here])).toEqual([
      ['cc', 'near', true],
      ['cx', 'near', true],
      ['oc2', 'far', false],
      ['local', 'gateway', false],
    ]);
    expect(res.agents[0]!.dirs).toEqual(['talkcode']);
  });
});

describe('Delegation: proposing, and the card every start waits on', () => {
  it('gathers back-to-back task-new calls onto one card and starts nothing before it is answered', async () => {
    const r = rig({ answer: null });
    const first = (await r.d.handle(P, task('cc', 'Fix the bump workflow'))) as { item: number };
    const second = (await r.d.handle(P, task('oc2', 'Check the arm64 build', { cwd: 'talkcode', title: 'arm64' }))) as { item: number };
    expect([first.item, second.item]).toEqual([1, 2]);
    expect(r.cards).toEqual([]);
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.labels).toEqual(['Start all 2', 'Cancel']);
    expect(r.cards[0]!.text).toMatch(/cc wants to start 2 sub-agents/);
    expect(r.cards[0]!.text).toContain('1. **cc** @ near');
    expect(r.cards[0]!.text).toContain('2. **oc2** @ far · `talkcode` — arm64');
    expect(r.cards[0]!.text).toContain('> Check the arm64 build');
    expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);
  });

  it('starts every sub-task once confirmed, nested under the asking topic, and says where they went', async () => {
    const r = rig();
    await r.d.handle(P, task('cc', 'Fix the bump workflow'));
    await r.d.handle(P, task('cx', 'Review the fix'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    const opened = r.calls.filter(([c]) => c === 'openTask').map(([, o]) => o as { parent: ConversationAddress; agentId: string; header: string });
    expect(opened.map((o) => [o.agentId, keyOf(o.parent)])).toEqual([
      ['cc', P],
      ['cx', P],
    ]);
    expect(opened[0]!.header).toBe('**↳ From [Release](?t=aaaaaaaa)**');
    const said = r.posted.find((p) => p.to === P && p.text.startsWith('Started 2'))!;
    expect(said.text).toContain('- [part](?t=c1000000) — cc');
  });

  it('opens nothing when the card is cancelled', async () => {
    const r = rig({ answer: 'Cancel' });
    await r.d.handle(P, task('cc', 'x'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards[0]!.labels).toEqual(['Start it', 'Cancel']);
    expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);
  });

  it('replaces a card still on screen with the newer proposal', async () => {
    const r = rig();
    let release: (v: string | null) => void = () => undefined;
    const d = new Delegation({
      ...(r.d as unknown as { deps: DelegationDeps }).deps,
      confirm: ({ text, labels, signal }) => {
        r.cards.push({ text, labels, signal });
        return new Promise((res) => {
          release = res;
          signal.addEventListener('abort', () => res(null));
        });
      },
    });
    await d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await d.handle(P, task('cc', 'second'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards.map((c) => c.signal.aborted)).toEqual([true, false]);
    release('Start it');
    await settle();
    await settle();
    expect(r.calls.filter(([c]) => c === 'openTask').map(([, o]) => (o as { text: string }).text)).toEqual(['second']);
  });

  it('refuses an agent that is not configured at once', async () => {
    const r = rig();
    await expect(r.d.handle(P, task('zz', 'x'))).rejects.toThrow(/no agent "zz".*oc2, cc, cx, local/);
  });

  it('says which could not start, and tells the asking agent', async () => {
    const r = rig({ failOpen: 'cx' });
    await r.d.handle(P, task('cc', 'a'));
    await r.d.handle(P, task('cx', 'b', { cwd: 'nowhere' }));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    const said = r.posted.find((p) => p.to === P && p.text.startsWith('Started 1'))!;
    expect(said.text).toMatch(/Could not start 1:\n- 2\. cx: no directory nowhere/);
    const prompt = r.calls.find(([c]) => c === 'prompt')![1] as { prompt: string; user: string };
    expect(prompt.prompt).toMatch(/^\[sub-agent updates\] 1 of 2 could not be started/);
    expect(prompt.user).toBe(UPDATE_SENDER);
  });
});

describe('Delegation: acting on the topics it opened, and only those', () => {
  async function withChild() {
    const r = rig();
    await r.d.handle(P, task('cc', 'Fix it'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    return r;
  }

  it('lists, reads, sends to and stops its own sub-agents', async () => {
    const r = await withChild();
    const list = (await r.d.handle(P, { kind: 'task-list' })) as TaskListResult;
    expect(list.tasks.map((t) => [t.topic, t.agent, t.cwd])).toEqual([['web:main/c1000000', 'cc @ near', '~/workspace/talkcode']]);
    await r.d.handle(P, { kind: 'task-send', topic: 'c1000000', text: 'also the docs' });
    expect(r.calls.find(([c]) => c === 'handTo')![1]).toEqual({
      key: 'web#main#c1000000',
      text: 'also the docs',
      header: '**↳ From [Release](?t=aaaaaaaa)**',
    });
    const read = (await r.d.handle(P, { kind: 'task-read', topic: 'web:main/c1000000' })) as { messages: unknown[] };
    expect(read.messages).toHaveLength(2);
    await r.d.handle(P, { kind: 'task-stop', topic: 'c1000000' });
    expect(r.calls).toContainEqual(['stop', 'web#main#c1000000']);
  });

  it('refuses a topic it did not open', async () => {
    const r = await withChild();
    r.bound.set('web#main#bbbbbbbb', 'cx');
    await expect(r.d.handle(P, { kind: 'task-send', topic: 'bbbbbbbb', text: 'x' })).rejects.toThrow(/not a topic this conversation opened/);
    await expect(r.d.handle('web#main#c1000000', { kind: 'task-stop', topic: 'c1000000' })).rejects.toThrow(/not a topic/);
  });
});

describe('Delegation: [sub-agent updates]', () => {
  it('tells the agent that opened a topic when it finishes — gathered, shown folded, then run as a turn', async () => {
    const r = rig();
    await r.d.handle(P, task('cc', 'a'));
    await r.d.handle(P, task('cx', 'b'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    r.activity.set('web#main#c1000000', { outcome: { kind: 'done', at: 5, line: 'Done: all green.' } });
    r.busy.add('web#main#c2000000');
    r.d.childChanged('web#main#c1000000');
    expect(r.calls.filter(([c]) => c === 'prompt')).toEqual([]);
    r.clock.advance(CARD_DELAY_MS);
    const prompt = r.calls.find(([c]) => c === 'prompt')![1] as { key: string; agentId: string; prompt: string; user: string };
    expect(prompt.key).toBe(P);
    expect(prompt.agentId).toBe('cc');
    expect(prompt.user).toBe(UPDATE_SENDER);
    expect(prompt.prompt.split('\n')).toEqual([
      '[sub-agent updates] 1 of 2 sub-agents have finished or stopped; 1 still working.',
      '- topic web:main/c1000000 · "part" · cc @ near in ~/workspace/talkcode · finished',
      '  first line: Done: all green.',
      '  reply: Done: all green, 12 tests.',
      '  link: ?t=c1000000',
    ]);
    expect(r.posted).toContainEqual({ to: P, text: '🔔 part (cc @ near) — finished: Done: all green.', tools: true });
  });

  it('does not tell the parent about a turn the person started in the sub-agent’s topic', async () => {
    const r = rig();
    await r.d.handle(P, task('cc', 'a'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    r.activity.set('web#main#c1000000', { outcome: { kind: 'done', at: 5 } });
    r.d.childChanged('web#main#c1000000');
    r.clock.advance(CARD_DELAY_MS);
    expect(r.calls.filter(([c]) => c === 'prompt')).toHaveLength(1);
    // Reported; the person now writes there directly, and that turn ends.
    r.d.childChanged('web#main#c1000000');
    r.clock.advance(CARD_DELAY_MS);
    expect(r.calls.filter(([c]) => c === 'prompt')).toHaveLength(1);
    // Handed something again by the parent: its end is news again.
    await r.d.handle(P, { kind: 'task-send', topic: 'c1000000', text: 'more' });
    r.d.childChanged('web#main#c1000000');
    r.clock.advance(CARD_DELAY_MS);
    expect(r.calls.filter(([c]) => c === 'prompt')).toHaveLength(2);
  });

  it('tells nobody about a topic nothing opened', () => {
    const r = rig();
    r.bound.set('web#main#bbbbbbbb', 'cc');
    r.d.childChanged('web#main#bbbbbbbb');
    r.clock.advance(CARD_DELAY_MS);
    expect(r.calls.filter(([c]) => c === 'prompt')).toEqual([]);
  });

  it('skips a sub-agent that started again before the card went', async () => {
    const r = rig();
    await r.d.handle(P, task('cc', 'a'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    r.activity.set('web#main#c1000000', { outcome: { kind: 'done', at: 5 } });
    r.d.childChanged('web#main#c1000000');
    r.busy.add('web#main#c1000000');
    r.clock.advance(CARD_DELAY_MS);
    expect(r.calls.filter(([c]) => c === 'prompt')).toEqual([]);
  });
});

describe('naming a /super topic', () => {
  it('takes the job a /super command carries, and nothing from any other command', () => {
    expect(jobInCommand('/super 把 a.txt 改成大写\n然后汇报')).toBe('把 a.txt 改成大写\n然后汇报');
    expect(jobInCommand('/super')).toBeUndefined();
    expect(jobInCommand('/model opus')).toBeUndefined();
    expect(jobInCommand('/superb x')).toBeUndefined();
  });
});
