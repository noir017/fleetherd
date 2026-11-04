import { describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { AgentStatus, TopicActivity } from '../types.js';
import type {
  ListChannelsResult,
  TaskActionResult,
  TaskAgentsResult,
  TaskListResult,
  TaskReadResult,
  TaskStatusResult,
} from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import {
  CARD_DELAY_MS,
  CARD_ITEM_CHARS,
  CARD_MAX_ENTRIES,
  CARD_TOTAL_CHARS,
  Delegation,
  PROPOSAL_GATHER_MS,
  type DelegationDeps,
} from './delegation.js';
import { TurnOutcomes } from './turn-outcomes.js';
import type { LiveTurn } from './turn-progress.js';
import { FAILURE_NOTICE_CHARS, jobInCommand, UPDATE_SENDER } from './turn-runner.js';

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
  const progress = new Map<string, LiveTurn>();
  const status = new Map<string, AgentStatus>();
  const questions = new Map<string, string>();
  const failures = new Map<string, string>();
  const replies = new Map<string, string>();
  const asking = new Set<string>();
  const busy = new Set<string>();
  const calls: Array<[string, unknown]> = [];
  const cards: Array<{ text: string; labels: string[]; signal: AbortSignal }> = [];
  let threads = 0;
  let handResult: 'started' | 'joined' | 'queued' = 'started';
  const history = [
    { conversation: {}, messageId: '1', content: 'do it', timestamp: 0, authorIsBot: false },
    { conversation: {}, messageId: '2', content: 'done', timestamp: 1000, authorIsBot: true },
  ];
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
    fetchHistory: async () => history,
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
    handTo: async (key: string, _p: string, _a: ConversationAddress, text: string, header: string, opts?: { queue?: boolean }) => {
      calls.push(['handTo', { key, text, header, ...(opts?.queue ? { queue: true } : {}) }]);
      return handResult;
    },
    isBusy: (k: string) => busy.has(k),
    isAsking: (k: string) => asking.has(k),
    progressOf: (k: string) => progress.get(k),
    runningSince: (k: string) => (busy.has(k) ? 1_000 : undefined),
    statusOf: (k: string) => status.get(k),
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
    replyOf: (k: string) => {
      if (activity.get(k)?.outcome?.kind !== 'done') return undefined;
      const text = replies.get(k);
      return text === undefined ? undefined : { text, total: text.length };
    },
    failureOf: (k: string) => {
      if (activity.get(k)?.outcome?.kind !== 'failed') return undefined;
      const text = failures.get(k);
      return text === undefined ? undefined : { text, total: text.length };
    },
    stopConversation: (k: string) => {
      calls.push(['stop', k]);
      return busy.has(k) ? ('running' as const) : ('idle' as const);
    },
    stopWithPending: (k: string) => {
      calls.push(['stop', k]);
      return { outcome: busy.has(k) ? ('running' as const) : ('idle' as const), calledOff: 0, transcripts: 0 };
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
    questionOf: (k: string) => questions.get(k),
    confirm: ({ text, labels, signal }) => {
      cards.push({ text, labels, signal });
      return Promise.resolve(opts.answer === undefined ? (labels[0] ?? null) : opts.answer);
    },
  };
  return {
    d: new Delegation(deps),
    deps,
    registry,
    clock,
    posted,
    parents,
    bound,
    activity,
    progress,
    status,
    questions,
    failures,
    replies,
    asking,
    history,
    busy,
    calls,
    cards,
    setHandResult: (v: 'started' | 'joined' | 'queued') => {
      handResult = v;
    },
  };
}

const task = (agent: string, text: string, extra: Record<string, string> = {}) => ({ kind: 'task-new' as const, agent, text, ...extra });

describe('Delegation: where the commands run', () => {
  it('refuses a call from no conversation, and a platform that cannot nest topics', async () => {
    const r = rig();
    await expect(r.d.handle(undefined, { kind: 'task-agents' })).rejects.toThrow(/from a conversation's own turn/);
    await expect(r.d.handle('tg#1#2', { kind: 'task-agents' })).rejects.toThrow(/only the web UI can show.*telegram/);
  });

  it('lists the agent answering this conversation first, then the rest of its machine', async () => {
    const r = rig();
    // The conversation is answered by cx, not by the config's first agent: cx leads the list.
    r.bound.set(P, 'cx');
    const res = (await r.d.handle(P, { kind: 'task-agents' })) as TaskAgentsResult;
    expect(res.agents.map((a) => [a.id, a.where, a.here])).toEqual([
      ['cx', 'near', true],
      ['cc', 'near', true],
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

  it('adds a later proposal to the card already on screen, so Start covers both', async () => {
    const r = rig();
    const releases: Array<(v: string | null) => void> = [];
    const d = new Delegation({
      ...(r.d as unknown as { deps: DelegationDeps }).deps,
      confirm: ({ text, labels, signal }) => {
        r.cards.push({ text, labels, signal });
        return new Promise((res) => {
          releases.push(res);
          signal.addEventListener('abort', () => res(null));
        });
      },
    });
    await d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(1);
    // The second call arrives long after the first card went up — the case that used to make a
    // second card and drop the first. It now re-renders the card with both items on it.
    await d.handle(P, task('cx', 'second'));
    await settle();
    expect(r.cards.map((c) => c.signal.aborted)).toEqual([true, false]);
    expect(r.cards[1]!.labels).toEqual(['Start all 2', 'Cancel']);
    expect(r.cards[1]!.text).toContain('1. **cc**');
    expect(r.cards[1]!.text).toContain('2. **cx**');
    releases[1]!('Start all 2');
    await settle();
    await settle();
    expect(r.calls.filter(([c]) => c === 'openTask').map(([, o]) => (o as { text: string }).text)).toEqual(['first', 'second']);
  });

  it('drops the card when the person writes instead, so the re-proposal starts a fresh one', async () => {
    const r = rig();
    const releases: Array<(v: string | null) => void> = [];
    const d = new Delegation({
      ...(r.d as unknown as { deps: DelegationDeps }).deps,
      confirm: ({ text, labels, signal }) => {
        r.cards.push({ text, labels, signal });
        return new Promise((res) => {
          releases.push(res);
          signal.addEventListener('abort', () => res(null));
        });
      },
    });
    await d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    // "use cx instead" — the agent is about to read it and propose again.
    d.personSpoke(P);
    await settle();
    expect(r.cards[0]!.signal.aborted).toBe(true);
    await d.handle(P, task('cx', 'second'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(2);
    expect(r.cards[1]!.labels).toEqual(['Start it', 'Cancel']);
    expect(r.cards[1]!.text).toContain('cx');
    expect(r.cards[1]!.text).not.toContain('first');
    releases[1]!('Start it');
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

describe('Delegation: seeing what a sub-agent is doing', () => {
  async function withChild() {
    const r = rig();
    await r.d.handle(P, task('cc', 'Fix it'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    return r;
  }
  const KEY = 'web#main#c1000000';

  it('shows the tool it is running, its step, elapsed time, context and cost while it works', async () => {
    const r = await withChild();
    r.busy.add(KEY);
    r.clock.advance(2_000); // the proposal card already advanced 3s; runningSince is 1000 → 4s
    r.progress.set(KEY, {
      startedAt: 1_000,
      steps: 148,
      current: { at: 4_000, tool: 'Bash', detail: 'sed -n 1,20p bundle.js' },
      recent: [],
    });
    r.status.set(KEY, {
      agent: 'cc',
      context: { used: 98_000, size: 1_000_000 },
      cost: { amount: 0.42, currency: 'USD' },
    });
    const list = (await r.d.handle(P, { kind: 'task-list' })) as TaskListResult;
    const row = list.tasks[0]!;
    expect(row.stage).toBe('working');
    expect(row.line).toBe('Bash: sed -n 1,20p bundle.js');
    expect(row.step).toBe(148);
    expect(row.elapsed).toBe('4s');
    expect(row.context).toContain('98k');
    expect(row.context).toContain('10%');
    expect(row.cost).toBe('$0.42');
  });

  it('leaves the live columns empty once it is not working, so the last outcome is what shows', async () => {
    const r = await withChild();
    r.progress.set(KEY, { startedAt: 1_000, steps: 148, current: { at: 4_000, tool: 'Bash', detail: 'x' }, recent: [] });
    r.activity.set(KEY, { outcome: { kind: 'done', at: 5, line: 'Done: all green.' } });
    const list = (await r.d.handle(P, { kind: 'task-list' })) as TaskListResult;
    expect(list.tasks[0]).toMatchObject({ stage: 'review', line: 'Done: all green.', step: 0, elapsed: '' });
  });

  it('gives one topic in detail: its row, the last three tool calls and its last reply', async () => {
    const r = await withChild();
    r.activity.set(KEY, { outcome: { kind: 'done', at: 5, line: 'Done.' } });
    r.progress.set(KEY, {
      startedAt: 1_000,
      steps: 5,
      current: { at: 3_000, tool: 'Grep', detail: 'needle' },
      recent: [
        { at: 1_000, tool: 'Bash', detail: 'ls' },
        { at: 2_000, tool: 'Read', detail: 'src/a.ts' },
        { at: 3_000, tool: 'Grep', detail: 'needle' },
      ],
    });
    r.replies.set(KEY, 'Done: all green, 12 tests.');
    const s = (await r.d.handle(P, { kind: 'task-status', topic: 'c1000000' })) as TaskStatusResult;
    expect(s.task.topic).toBe('web:main/c1000000');
    expect(s.task.step).toBe(0); // not working, so the row is the outcome's
    expect(s.recent.map((x) => x.tool)).toEqual(['Bash', 'Read', 'Grep']);
    expect(s.reply).toBe('Done: all green, 12 tests.');
  });

  it('reads a whole long message with --full, and the newest lines with --tail', async () => {
    const r = await withChild();
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    r.history.splice(0, r.history.length, {
      conversation: {},
      messageId: '1',
      content: lines.join('\n'),
      timestamp: 0,
      authorIsBot: true,
    });
    const whole = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', full: true })) as TaskReadResult;
    expect(whole.messages[0]!.text).toBe(lines.join('\n'));

    const tail = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', tail: 3 })) as TaskReadResult;
    expect(tail.messages[0]!.text).toContain('…[197 earlier lines]');
    expect(tail.messages[0]!.text.endsWith('line 197\nline 198\nline 199')).toBe(true);
  });

  it('keeps the newest messages when --full would blow the total budget, and says what it left out', async () => {
    const r = await withChild();
    r.history.splice(
      0,
      r.history.length,
      ...Array.from({ length: 6 }, (_, i) => ({
        conversation: {},
        messageId: String(i),
        content: `${i}:`.padEnd(20_000, 'x'),
        timestamp: i,
        authorIsBot: true,
      }))
    );
    const read = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', full: true, limit: 10 })) as TaskReadResult;
    expect(read.messages).toHaveLength(4);
    expect(read.note).toMatch(/the 2 oldest of 6 messages were left out/);
    expect(read.messages[3]!.text.startsWith('5:')).toBe(true);
  });

  it('says whether task-send joined the turn or is waiting behind it', async () => {
    const r = await withChild();
    r.busy.add(KEY);
    r.setHandResult('queued');
    const queued = (await r.d.handle(P, { kind: 'task-send', topic: 'c1000000', text: 'check the log' })) as TaskActionResult;
    expect(queued.result).toMatch(/cannot take input mid-turn/);
    r.setHandResult('joined');
    const joined = (await r.d.handle(P, { kind: 'task-send', topic: 'c1000000', text: 'check the log' })) as TaskActionResult;
    expect(joined.result).toMatch(/takes it into the turn it is running/);
  });

  it('--interrupt stops the turn and queues the message behind it, saying so', async () => {
    const r = await withChild();
    r.busy.add(KEY);
    r.setHandResult('queued');
    const res = (await r.d.handle(P, {
      kind: 'task-send',
      topic: 'c1000000',
      text: 'stop reading code, check the log',
      interrupt: true,
    })) as TaskActionResult;
    expect(r.calls).toContainEqual(['stop', KEY]);
    expect(r.calls.find(([c]) => c === 'handTo')![1]).toMatchObject({ queue: true });
    expect(res.result).toMatch(/^Stopped the turn it was running\./);
  });

  it('--interrupt with nothing running is an ordinary send', async () => {
    const r = await withChild();
    const res = (await r.d.handle(P, { kind: 'task-send', topic: 'c1000000', text: 'go', interrupt: true })) as TaskActionResult;
    expect(res.result).toMatch(/starting on it now/);
    // The stop is still attempted (it is how "was anything running" is asked), and answers idle.
    expect(r.calls).toContainEqual(['stop', KEY]);
  });
});

describe('Delegation: /stop in the topic that opened them', () => {
  it('stops every sub-agent still at work, theirs too, and says so in each', () => {
    const r = rig();
    const [c1, c2, c3] = ['web#main#c1000000', 'web#main#c2000000', 'web#main#c3000000'];
    r.parents.set(c1, P);
    r.parents.set(c2, c1);
    r.parents.set(c3, P);
    for (const k of [c1, c2, c3]) r.bound.set(k, 'cx');
    r.busy.add(c1);
    r.busy.add(c2);

    expect(r.d.stopOpened(P)).toBe(2);
    expect(r.calls.filter(([what]) => what === 'stop').map(([, k]) => k)).toEqual([c1, c2, c3]);
    expect(r.posted.filter((p) => p.text.startsWith('⏹')).map((p) => p.to)).toEqual([c1, c2]);
    expect(r.posted.find((p) => p.to === c1)?.text).toBe('⏹ Stopped with /stop in [Release](?t=aaaaaaaa).');
  });

  it('stops nothing where topics do not nest, or where none were opened', () => {
    const r = rig();
    expect(r.d.stopOpened('tg#1#2')).toBe(0);
    expect(r.d.stopOpened(P)).toBe(0);
    expect(r.calls).toEqual([]);
  });
});

describe('Delegation: [sub-agent updates]', () => {
  /** The quoted bodies on one card, with the two-space continuation indent taken back off. */
  const bodies = (prompt: string, label: 'reply' | 'question' | 'failure'): string[] =>
    prompt
      .split(`\n  ${label}: `)
      .slice(1)
      .map((p) => p.split('\n  link:')[0]!.replace(/\n {2}/g, '\n'));

  const oneChild = async () => {
    const r = rig();
    await r.d.handle(P, task('cc', 'a'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    return r;
  };

  const cardOf = (r: ReturnType<typeof rig>): string =>
    (r.calls.find(([c]) => c === 'prompt')![1] as { prompt: string }).prompt;

  /** The card with a real TurnOutcomes behind it, so a turn end is the source of what it quotes. */
  const realChain = () => {
    const r = rig();
    const self: { d?: Delegation } = {};
    const outcomes = new TurnOutcomes({
      config: r.deps.config,
      clock: r.clock,
      platforms: r.deps.platforms,
      laneOf: (id) => r.registry.laneFor(id),
      agentIdOf: (id) => r.bound.get(id) ?? 'cc',
      runContinue: () => true,
      onNeedsPerson: (id) => self.d?.childChanged(id),
    });
    const wrapped = {
      ...r.registry,
      activityOf: (k: string) => outcomes.activityOf(k) ?? r.registry.activityOf(k),
      replyOf: (k: string) => outcomes.replyOf(k) ?? r.registry.replyOf(k),
      failureOf: (k: string) => outcomes.failureOf(k) ?? r.registry.failureOf(k),
    };
    const d = new Delegation({ ...r.deps, registry: wrapped as unknown as DelegationDeps['registry'] });
    self.d = d;
    return { r, d, outcomes };
  };

  const openOne = async (chain: ReturnType<typeof realChain>): Promise<void> => {
    await chain.d.handle(P, task('cc', 'a'));
    chain.r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
  };

  it('tells the agent that opened a topic when it finishes — gathered, shown folded, then run as a turn', async () => {
    const r = rig();
    await r.d.handle(P, task('cc', 'a'));
    await r.d.handle(P, task('cx', 'b'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    r.activity.set('web#main#c1000000', { outcome: { kind: 'done', at: 5, line: 'Done: all green.' } });
    r.replies.set('web#main#c1000000', 'Done: all green, 12 tests.');
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
      '  reply: Done: all green, 12 tests.',
      '  link: ?t=c1000000',
    ]);
    expect(r.posted).toContainEqual({ to: P, text: '🔔 part (cc @ near) — finished: Done: all green.', tools: true });
  });

  it('carries a finished reply whole, line breaks and lists intact, with no separate first line', async () => {
    const r = await oneChild();
    const key = 'web#main#c1000000';
    const reply = '## Review\n\nVerdict: merge after one fix.\n\n- rename the flag\n- add a test';
    r.replies.set(key, reply);
    r.activity.set(key, { outcome: { kind: 'done', at: 5, line: 'Review' } });
    r.d.childChanged(key);
    r.clock.advance(CARD_DELAY_MS);
    const prompt = cardOf(r);
    expect(prompt).toContain(`  reply: ${reply.replace(/\n/g, '\n  ')}`);
    expect(prompt).not.toContain('first line');
  });

  it('says a reply was not kept instead of passing its first line off as the reply', async () => {
    const r = await oneChild();
    const key = 'web#main#c1000000';
    r.activity.set(key, { outcome: { kind: 'done', at: 5, line: 'Done: first line.' } });
    r.d.childChanged(key);
    r.clock.advance(CARD_DELAY_MS);
    const prompt = cardOf(r);
    expect(prompt).toContain('  reply: the reply was not kept');
    expect(prompt).not.toContain('reply: Done: first line.');
  });

  it('cuts a reply at CARD_ITEM_CHARS, saying how long it was and where the rest is read', async () => {
    const r = await oneChild();
    const key = 'web#main#c1000000';
    r.replies.set(key, 'x'.repeat(5_000));
    r.activity.set(key, { outcome: { kind: 'done', at: 5, line: 'Done.' } });
    r.d.childChanged(key);
    r.clock.advance(CARD_DELAY_MS);
    const [body] = bodies(cardOf(r), 'reply');
    expect(body).toBeDefined();
    expect(body!.length).toBe(CARD_ITEM_CHARS);
    expect(body).toContain('5000 chars total, cut at');
    expect(body).toContain('task-read web:main/c1000000 --full');
  });

  it('shares CARD_TOTAL_CHARS across a burst, and every cut says where the rest is', async () => {
    const r = rig();
    await r.d.handle(P, task('cc', 'a'));
    await r.d.handle(P, task('cc', 'b'));
    await r.d.handle(P, task('cc', 'c'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    const keys = ['web#main#c1000000', 'web#main#c2000000', 'web#main#c3000000'];
    for (const key of keys) {
      r.replies.set(key, 'r'.repeat(3_500));
      r.activity.set(key, { outcome: { kind: 'done', at: 5, line: 'Done.' } });
      r.d.childChanged(key);
    }
    r.clock.advance(CARD_DELAY_MS);
    const prompt = cardOf(r);
    const list = bodies(prompt, 'reply');
    expect(list).toHaveLength(3);
    expect(list[0]).toBe('r'.repeat(3_500));
    expect(list[1]).toBe('r'.repeat(3_500));
    // The frame takes its room first, so the third gets what is left of the 8000, not 1000.
    expect(list[2]!.length).toBeLessThan(CARD_TOTAL_CHARS - 2 * 3_500);
    expect(list[2]).toContain('3500 chars total, cut at');
    expect(list[2]).toContain('task-read web:main/c3000000 --full');
    expect(prompt.length).toBeLessThanOrEqual(CARD_TOTAL_CHARS);
  });

  it('keeps 8000 a hard cap when three entries each want the 4000 maximum', async () => {
    const r = rig();
    for (const text of ['a', 'b', 'c']) await r.d.handle(P, task('cc', text));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    const keys = ['web#main#c1000000', 'web#main#c2000000', 'web#main#c3000000'];
    for (const key of keys) {
      r.replies.set(key, 'r'.repeat(CARD_ITEM_CHARS));
      r.activity.set(key, { outcome: { kind: 'done', at: 5, line: 'Done.' } });
      r.d.childChanged(key);
    }
    r.clock.advance(CARD_DELAY_MS);
    const prompt = cardOf(r);
    expect(prompt.length).toBeLessThanOrEqual(CARD_TOTAL_CHARS);
    const chunks = prompt.split('\n- topic ').slice(1);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      const [body] = bodies(chunk, 'reply');
      if (body) expect(body.length).toBeLessThanOrEqual(CARD_ITEM_CHARS);
    }
    // The third entry really is there, with its heading and its cut notice — not just two entries
    // whose last one the assertion happened to find.
    expect(chunks[2]).toContain('  reply: ');
    expect(chunks[2]).toContain(`${CARD_ITEM_CHARS} chars total, cut at`);
  });

  it('lists at most CARD_MAX_ENTRIES and folds the rest into one line', async () => {
    const r = rig();
    const keys = Array.from({ length: CARD_MAX_ENTRIES + 3 }, (_, i) => `web#main#a${String(i).padStart(7, '0')}`);
    for (const key of keys) {
      r.parents.set(key, P);
      r.bound.set(key, 'cc');
      r.activity.set(key, { outcome: { kind: 'done', at: 5, line: 'Done.' } });
      r.replies.set(key, 'short reply');
    }
    for (const key of keys) await r.d.handle(P, { kind: 'task-send', topic: key.slice('web#main#'.length), text: 'x' });
    for (const key of keys) r.d.childChanged(key);
    r.clock.advance(CARD_DELAY_MS);
    const prompt = cardOf(r);
    expect(prompt.split('\n- topic ').slice(1)).toHaveLength(CARD_MAX_ENTRIES);
    expect(prompt).toContain(`- 3 more sub-agents — see talkcode tasks`);
    expect(prompt.length).toBeLessThanOrEqual(CARD_TOTAL_CHARS);
  });

  it('carries the whole question, while the topic row and its folded line stay one line', async () => {
    const r = await oneChild();
    const key = 'web#main#c1000000';
    const question = 'This needs a decision.\n\nWhich database should I use?\n- postgres\n- sqlite';
    r.questions.set(key, question);
    r.asking.add(key);
    r.d.childChanged(key);
    r.clock.advance(CARD_DELAY_MS);
    expect(cardOf(r)).toContain(`  question: ${question.replace(/\n/g, '\n  ')}`);
    expect(r.posted.find((p) => p.tools)?.text).toBe(
      '🔔 part (cc @ near) — waiting on a question: This needs a decision. Which database should I use? - postgres - sqlite'
    );
    const list = (await r.d.handle(P, { kind: 'task-list' })) as TaskListResult;
    expect(list.tasks[0]!.line).toBe('This needs a decision. Which database should I use? - postgres - sqlite');
  });

  it('cuts a long question at CARD_ITEM_CHARS, saying how long it was', async () => {
    const r = await oneChild();
    const key = 'web#main#c1000000';
    r.questions.set(key, 'q'.repeat(5_000));
    r.asking.add(key);
    r.d.childChanged(key);
    r.clock.advance(CARD_DELAY_MS);
    const [body] = bodies(cardOf(r), 'question');
    expect(body!.length).toBe(CARD_ITEM_CHARS);
    expect(body).toContain('5000 chars total, cut at');
    expect(body).toContain('task-read web:main/c1000000 --full');
  });

  it('carries a failed turn\'s whole error, not its first line', async () => {
    const r = await oneChild();
    const key = 'web#main#c1000000';
    const error = `Process exited 1:\n${'  at step (file.ts:1:1)\n'.repeat(200)}`;
    r.failures.set(key, error);
    r.activity.set(key, { outcome: { kind: 'failed', at: 5, line: 'Process exited 1:', reason: 'other' } });
    r.d.childChanged(key);
    r.clock.advance(CARD_DELAY_MS);
    const [body] = bodies(cardOf(r), 'failure');
    expect(body).toBeDefined();
    expect(body!.length).toBe(CARD_ITEM_CHARS);
    expect(body).toContain('at step (file.ts:1:1)');
    expect(body).toContain(`${error.length} chars total, cut at`);
    expect(body).toContain(`the topic's ❌ notice carries at most ${FAILURE_NOTICE_CHARS} characters`);
    expect(body).not.toContain('task-read');
  });

  it('keeps task-status to a short preview while the card carries the long reply', async () => {
    const r = await oneChild();
    const key = 'web#main#c1000000';
    r.replies.set(key, 'x'.repeat(2_000));
    r.activity.set(key, { outcome: { kind: 'done', at: 5, line: 'Done.' } });
    const s = (await r.d.handle(P, { kind: 'task-status', topic: 'c1000000' })) as TaskStatusResult;
    expect(s.reply).toHaveLength(600);
    expect(s.reply.endsWith('…')).toBe(true);
  });

  it('is fed by a real turn end: TurnOutcomes stores the reply and childChanged carries it', async () => {
    const chain = realChain();
    await openOne(chain);
    const reply = '## Review\n\nVerdict: merge.\n\n- one\n- two';
    chain.outcomes.turnEnded('web#main#c1000000', { kind: 'done', text: reply });
    chain.r.clock.advance(CARD_DELAY_MS);
    expect(cardOf(chain.r)).toContain(`  reply: ${reply.replace(/\n/g, '\n  ')}`);
  });

  it('is fed by a real failed turn: the whole error is cut, disclosed, and says where the rest is', async () => {
    const chain = realChain();
    await openOne(chain);
    const error = `Process exited 1:\n${'  at step (file.ts:1:1)\n'.repeat(400)}`;
    chain.outcomes.turnEnded('web#main#c1000000', { kind: 'failed', error: new Error(error) });
    chain.r.clock.advance(CARD_DELAY_MS);
    const prompt = cardOf(chain.r);
    expect(prompt).toContain('  failure: Process exited 1:');
    expect(prompt).toContain(`${error.length} chars total, cut at`);
    expect(prompt).toContain(`the topic's ❌ notice carries at most ${FAILURE_NOTICE_CHARS} characters`);
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
