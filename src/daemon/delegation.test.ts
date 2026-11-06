import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { AgentStatus, TopicActivity } from '../types.js';
import type {
  ListChannelsResult,
  TaskActionResult,
  TaskAgentsResult,
  TaskListResult,
  TaskNewResult,
  TaskReadResult,
  TaskStatusResult,
} from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import { HistoryStore } from '../history/store.js';
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
import { TurnFailure } from './agent.js';
import type { LiveTurn } from './turn-progress.js';
import { jobInCommand, UPDATE_SENDER } from './turn-runner.js';

/**
 * Sub-agents (delegation.ts): who may run the task commands and on what, the confirmation card every
 * start waits on, and the `[sub-agent updates]` card — gathered, and sent only to the conversation
 * that opened the topics. The registry and the platform are fakes: what openTask does to a real
 * conversation is ConversationRegistry's to test (delegation-registry.test.ts).
 *
 * `task-read` reads the real library, so the rig opens one in a temporary directory: the filters and
 * the turn records are SQL, and a fake that re-implemented them would test the fake.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHistory(): HistoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-delegation-'));
  dirs.push(dir);
  return new HistoryStore(path.join(dir, 'history.db'));
}

/**
 * One turn of a sub-agent topic, filed the way a real one ends up in the library. Each call is a
 * minute later than the one before, so rows sort the way turns happened even when a test seeds
 * several turns into one topic.
 */
let seedClock = Date.UTC(2026, 10, 1, 9, 0);
function seedTurn(
  store: HistoryStore,
  key: string,
  rows: Array<{ role: 'user' | 'agent' | 'tool'; text: string }>,
  outcome: 'done' | 'failed' | 'stopped' | 'running' = 'done',
  detail = ''
): number {
  const at = seedClock;
  seedClock += 60_000;
  const sid = store.session({ key, platform: 'web', agent: 'cc', at })!;
  const turn = store.startTurn(sid, { agent: 'cc', generation: 0, trigger: 'delegate', at })!;
  rows.forEach((row, i) =>
    store.message(sid, { ts: at + i * 1_000, role: row.role, kind: 'subagent', text: row.text, turn })
  );
  if (outcome !== 'running') {
    store.endTurn(turn, { outcome, at: at + rows.length * 1_000, ...(detail ? { detail } : {}) });
  }
  return turn;
}

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

function rig(opts: { answer?: string | null; failOpen?: string; failModel?: string } = {}) {
  const clock = manualClock();
  const posted: Array<{ to: string; text: string; kind?: string }> = [];
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
  const history = tempHistory();
  const platform = {
    capabilities: { thread: true },
    parentOf: (a: ConversationAddress) => {
      const p = parents.get(keyOf(a));
      return p ? addrOf(p) : undefined;
    },
    childrenOf: (a: ConversationAddress) =>
      [...parents.entries()].filter(([, p]) => p === keyOf(a)).map(([c]) => addrOf(c)),
    sendMessage: async (a: ConversationAddress, text: string, o?: { kind?: string }) => {
      posted.push({ to: keyOf(a), text, ...(o?.kind ? { kind: o.kind } : {}) });
      return { address: a, messageId: 'm' };
    },
  } as unknown as PlatformAdapter;
  const telegram = { capabilities: { thread: true }, sendMessage: async () => ({ messageId: 'm' }) } as unknown as PlatformAdapter;

  const registry = {
    openTask: async (o: { parent: ConversationAddress; agentId: string; text: string; header: string; cwd?: string; title?: string; model?: string }) => {
      calls.push(['openTask', o]);
      if (o.agentId === opts.failOpen) throw new Error(`no directory ${o.cwd} on the machine`);
      if (o.model && o.model === opts.failModel) throw new Error(`could not set model "${o.model}": the harness refused it`);
      const key = `web#main#c${++threads}0000000`.slice(0, 17);
      parents.set(key, keyOf(o.parent));
      bound.set(key, o.agentId);
      // What openTask names the topic: the requested --title, else a name cut from the task text,
      // behind the `[agent] ` tag formatLaneTitle adds.
      return { key, address: addrOf(key), title: `[${o.agentId}] ${o.title ?? 'part'}` };
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
    // The store's record, which knows a name written before the topic's first turn; `listChannels`
    // below is the fallback `titleOf` uses when there is none.
    conversationTitle: (k: string) => (k === P ? '[cc] Release' : bound.has(k) ? `[${bound.get(k)}] part` : undefined),
    scheduledModelProblem: async (agent: string, model: string, from: string) => {
      calls.push(['modelProblem', { agent, model, from }]);
      return model === 'nope' ? `unknown model "nope" for agent "${agent}"; choose one of: base-model, fast-model` : undefined;
    },
  };

  const deps: DelegationDeps = {
    config: config(),
    platforms: new Map([
      ['web', platform],
      ['tg', telegram],
    ]),
    registry: registry as unknown as DelegationDeps['registry'],
    clock,
    history,
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

const task = (agent: string | undefined, text: string, extra: Record<string, string> = {}) => ({
  kind: 'task-new' as const,
  ...(agent ? { agent } : {}),
  text,
  ...extra,
});

/**
 * The record card among the messages posted to a topic. It is the only one that closes by naming
 * `/setting delegation`, which tells it apart from the answer a confirmed Start gets — that one has
 * the same first line and rows but no closing line.
 */
function recordCard(r: ReturnType<typeof rig>, to = P): { to: string; text: string; kind?: string } | undefined {
  return r.posted.filter((p) => p.to === to && p.text.includes('/setting delegation')).at(-1);
}

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
    // The answer to Start is the record card's layout: names first, in bold, one row per part.
    const said = r.posted.find((p) => p.to === P && p.text.includes('2 sub-agents'))!;
    // The asker is one of the names, so "started by cc" is left off.
    expect(said.text.split('\n')[0]).toBe('**cc, cx** — 2 sub-agents, each in a topic of its own under this one:');
    expect(said.text).toContain('- **cc** @ near · [part](?t=c1000000) · web:main/c1000000');
    expect(said.text).toContain('- **cx** @ near · [part](?t=c2000000) · web:main/c2000000');
    // The confirmed card's answer is a dispatch: the web UI marks it as a hand-off.
    expect(said.kind).toBe('dispatch');
  });

  it('defaults to the bound agent and shows a validated model on the proposal and started cards', async () => {
    const r = rig();
    r.bound.set(P, 'cx');
    await r.d.handle(P, task(undefined, 'Review the fix', { model: 'fast-model' }));
    expect(r.calls.find(([c]) => c === 'modelProblem')?.[1]).toEqual({ agent: 'cx', model: 'fast-model', from: P });
    expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);

    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    expect(r.cards[0]!.text).toContain('1. **cx** · model `fast-model` @ near');
    expect(r.calls.find(([c]) => c === 'openTask')?.[1]).toMatchObject({ agentId: 'cx', model: 'fast-model' });
    // One part, and the asker is the agent itself: the name is on the first line once, the row
    // leaves it out, and "started by cx" would stutter.
    const said = r.posted.find((p) => p.to === P && p.text.includes('— a sub-agent, in a topic of its own'))!;
    expect(said.text.split('\n')[0]).toBe('**cx** — a sub-agent, in a topic of its own under this one:');
    expect(said.text).toContain('- [part](?t=c1000000) · model `fast-model` @ near · web:main/c1000000');
  });

  it('refuses a model outside the agent’s list before either confirmation path starts anything', async () => {
    for (const confirm of [true, false]) {
      const r = rig();
      r.deps.config.delegation.confirm = confirm;
      await expect(r.d.handle(P, task('cc', 'x', { model: 'nope' }))).rejects.toThrow(
        /unknown model "nope" for agent "cc"; choose one of: base-model, fast-model/
      );
      r.clock.advance(PROPOSAL_GATHER_MS);
      await settle();
      expect(r.cards).toEqual([]);
      expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);
    }
  });

  it('does not probe the model list when --model is absent', async () => {
    const r = rig({ answer: null });
    await r.d.handle(P, task(undefined, 'x'));
    expect(r.calls.filter(([c]) => c === 'modelProblem')).toEqual([]);
  });

  it('refuses to guess when neither --agent nor a bound agent names one', async () => {
    const r = rig();
    r.bound.delete(P);
    await expect(r.d.handle(P, task(undefined, 'x'))).rejects.toThrow(/give task-new --agent <id>/);
  });

  it('reports a model the harness refuses at start as a sub-task that could not start, on both paths', async () => {
    for (const confirm of [true, false]) {
      const r = rig({ failModel: 'fast-model' });
      r.deps.config.delegation.confirm = confirm;
      const res = (await r.d.handle(P, task('cx', 'Review the fix', { model: 'fast-model' }))) as TaskNewResult;
      r.clock.advance(PROPOSAL_GATHER_MS);
      await settle();
      await settle();
      const said = r.posted.find((p) => p.to === P && /could not start/i.test(p.text))!;
      expect(said.text).toContain('- 1. cx: could not set model "fast-model": the harness refused it');
      expect(said.text).not.toMatch(/Started \d|sub-agent started by/);
      // The asking agent learns it with the reason, so it can propose again without --model or another one.
      // Confirmed later, it is told in an update; started at once, task-new's own answer says it.
      if (confirm) {
        const prompt = r.calls.find(([c]) => c === 'prompt')![1] as { prompt: string };
        expect(prompt.prompt).toMatch(/^\[sub-agent updates\] 1 of 1 could not be started:\n- 1\. cx: could not set model/);
      } else {
        expect(res.result).toContain('could not set model "fast-model"');
        expect(res.result).not.toContain('running now');
      }
    }
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
    const said = r.posted.find((p) => p.to === P && p.text.includes('Could not start 1:'))!;
    expect(said.text.split('\n')[0]).toBe('**cc** — a sub-agent, in a topic of its own under this one:');
    expect(said.text).toMatch(/Could not start 1:\n- 2\. cx: no directory nowhere/);
    expect(said.kind).toBe('dispatch');
    const prompt = r.calls.find(([c]) => c === 'prompt')![1] as { prompt: string; user: string };
    expect(prompt.prompt).toMatch(/^\[sub-agent updates\] 1 of 2 could not be started/);
    expect(prompt.user).toBe(UPDATE_SENDER);
  });
});

describe('Delegation: with confirmation off', () => {
  it('still waits for Start when the switch is on, which is the default', async () => {
    const r = rig();
    expect(r.deps.config.delegation.confirm).toBe(true);
    await r.d.handle(P, task('cc', 'x'));
    expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.labels).toEqual(['Start it', 'Cancel']);
  });

  it('opens the sub-task before task-new returns, and says it is running', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = false;
    const res = (await r.d.handle(P, task('cc', 'Fix the bump workflow', { title: 'bump' }))) as TaskNewResult;
    // Nothing to tap: the confirmation is not asked at all.
    expect(r.cards).toEqual([]);
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(1);
    expect(res.result).toContain('running now');
    expect(res.result).not.toMatch(/confirm|until they|wait/i);
  });

  it('starts the bound agent with the requested model and shows it on the record card', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = false;
    const res = (await r.d.handle(P, task(undefined, 'Fix the bump workflow', { model: 'fast-model' }))) as TaskNewResult;
    expect(res.result).toContain('running now');
    expect(r.calls.find(([c]) => c === 'modelProblem')?.[1]).toEqual({ agent: 'cc', model: 'fast-model', from: P });
    expect(r.calls.find(([c]) => c === 'openTask')?.[1]).toMatchObject({ agentId: 'cc', model: 'fast-model' });

    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    const card = recordCard(r)!;
    expect(card.text.split('\n')[0]).toBe('**cc** — a sub-agent, in a topic of its own under this one:');
    expect(card.text).toContain('- [part](?t=c1000000) · model `fast-model` @ near · web:main/c1000000');
  });

  it('posts a card listing what started and where, with no Start to tap', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = false;
    await r.d.handle(P, task('cc', 'Fix the bump workflow'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    const card = recordCard(r)!;
    expect(card).toBeDefined();
    expect(card.kind).toBe('dispatch'); // a dispatch bubble, not a folded tool card
    expect(card.text).toContain('**cc** — a sub-agent, in a topic of its own under this one:');
    expect(card.text).toContain('- [part](?t=c1000000) @ near · web:main/c1000000');
    expect(card.text).toContain('/setting delegation on');
  });

  it('opens with the sub-agent’s name first and bold, and leaves it out of a lone row', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = false;
    await r.d.handle(P, task('oc2', 'Check the arm64 build', { cwd: 'talkcode', title: 'arm64', model: 'fast-model' }));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    const card = recordCard(r)!;
    const [head, row] = card.text.split('\n');
    expect(head).toBe('**oc2** — a sub-agent started by cc, in a topic of its own under this one:');
    expect(row).toBe('- [arm64](?t=c1000000) · model `fast-model` @ far · `talkcode` · web:main/c1000000');
  });

  it('does not repeat a machine the agent’s own name already carries', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = false;
    // A host names its own agents `<id>@<host>` (daemon/pods.ts): `cbc@far` already says `far`.
    r.deps.config.agents.push({ ...r.deps.config.agents[0]!, id: 'cbc@far', host: 'far' });
    await r.d.handle(P, task('cbc@far', 'x'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    const row = recordCard(r)!.text.split('\n')[1];
    expect(row).toBe('- [part](?t=c1000000) · web:main/c1000000');
  });

  it('names every agent on the first line of a burst, and again where each row begins', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = false;
    await r.d.handle(P, task('cc', 'a'));
    await r.d.handle(P, task('oc2', 'b', { cwd: 'talkcode' }));
    await r.d.handle(P, task('cc', 'c'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    const card = recordCard(r)!;
    expect(card.text.split('\n')[0]).toBe(
      '**cc, oc2** — 3 sub-agents, each in a topic of its own under this one:'
    );
    // One row per part, in the order they were proposed; two went to the same agent.
    const rows = card.text.split('\n').filter((l) => l.startsWith('- '));
    expect(rows[0]).toContain('- **cc** @ near · [part]');
    expect(rows[1]).toContain('- **oc2** @ far · [part]');
    expect(rows[2]).toContain('- **cc** @ near · [part]');
  });

  it('gathers a burst into one card, and the person writing does not drop it', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = false;
    await r.d.handle(P, task('cc', 'a'));
    await r.d.handle(P, task('cx', 'b'));
    // Already running: a message from the person is their next turn, not a reason to lose the record.
    r.d.personSpoke(P);
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    const cards = r.posted.filter((p) => p.to === P && p.text.includes('2 sub-agents'));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toContain('**cc** @ near');
    expect(cards[0]!.text).toContain('**cx** @ near');
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(2);
  });

  it('says a sub-task could not start instead of claiming it is running', async () => {
    const r = rig({ failOpen: 'cx' });
    r.deps.config.delegation.confirm = false;
    const res = (await r.d.handle(P, task('cx', 'b', { cwd: 'nowhere' }))) as TaskNewResult;
    expect(res.result).toContain('Could not start');
    expect(res.result).not.toContain('running now');
    expect(res.result).not.toContain('The person sees a card');
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    const card = r.posted.find((p) => p.text.includes('could not start the sub-agent'))!;
    expect(card.text).toContain('no directory nowhere');
  });

  it("still asks the person inside a sub-agent's own topic, so agents cannot chain without a tap", async () => {
    const r = rig();
    r.deps.config.delegation.confirm = false;
    const child = 'web#main#d0000000';
    r.parents.set(child, P); // the platform says this topic was opened under the person's topic
    r.bound.set(child, 'cc');
    const res = (await r.d.handle(child, task('cx', 'dig deeper'))) as TaskNewResult;
    // The switch is the person's, not an agent's: a conversation with a parent still asks.
    expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);
    expect(res.result).toContain('Nothing starts until they confirm');
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.labels).toEqual(['Start it', 'Cancel']);
  });
});

describe('Delegation: confirming each agent only the first time', () => {
  it('asks once in a conversation, then starts that agent at once and posts the record card', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = 'first';
    await r.d.handle(P, task('cc', 'first'));
    expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    expect(r.cards).toHaveLength(1);
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(1);

    // The same agent, now confirmed here: no second card, it starts before task-new returns.
    const res = (await r.d.handle(P, task('cc', 'second'))) as TaskNewResult;
    expect(r.cards).toHaveLength(1);
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(2);
    expect(r.calls.filter(([c]) => c === 'openTask').at(-1)![1]).toMatchObject({ text: 'second' });
    expect(res.result).toContain('running now');
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    const card = recordCard(r)!;
    expect(card.text).toContain('once per agent in each conversation');
    expect(card.text).toContain('/setting delegation on');
  });

  it('still asks for a different agent, and asks the same agent again in another conversation', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = 'first';
    await r.d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();

    await r.d.handle(P, task('cx', 'other agent'));
    // A different agent is not confirmed here: it goes on a card rather than starting.
    expect(r.calls.filter(([c]) => c === 'openTask').map(([, o]) => (o as { agentId: string }).agentId)).toEqual(['cc']);
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(2);
    expect(r.cards[1]!.text).toContain('cx');

    // Another conversation has its own memory: cc is new there, so it asks.
    const other = 'web#main#b0000000';
    r.bound.set(other, 'cc');
    await r.d.handle(other, task('cc', 'somewhere else'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(3);
    expect(r.cards[2]!.text).toContain('somewhere else');
  });

  it('starts the confirmed agents of a mixed batch and puts only the new ones on the card', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = 'first';
    await r.d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();

    const started = (await r.d.handle(P, task('cc', 'again'))) as TaskNewResult;
    await r.d.handle(P, task('cx', 'new one'));
    expect(started.result).toContain('running now');
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(2);
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(2);
    expect(r.cards[1]!.text).toContain('cx');
    expect(r.cards[1]!.text).not.toContain('again');
  });

  it('remembers nothing when the card is cancelled', async () => {
    const r = rig({ answer: 'Cancel' });
    r.deps.config.delegation.confirm = 'first';
    await r.d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(1);
    expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);

    // Still unconfirmed: the next proposal is asked again, not started at once.
    await r.d.handle(P, task('cc', 'second'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(2);
    expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);
  });

  it("asks every time in a sub-agent's own topic, even for an agent confirmed in its parent", async () => {
    const r = rig();
    r.deps.config.delegation.confirm = 'first';
    await r.d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(1);

    const child = 'web#main#d0000000';
    r.parents.set(child, P);
    r.bound.set(child, 'cc');
    const res = (await r.d.handle(child, task('cc', 'dig deeper'))) as TaskNewResult;
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(1);
    expect(res.result).toContain('Nothing starts until they confirm');
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(2);
    expect(r.cards[1]!.text).toContain('dig deeper');
  });

  it('forgets every confirmation when the tier changes, even if it changes back', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = 'first';
    await r.d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(1);

    // `/setting delegation on`, then back to `first` with no task-new in between — the case a
    // read at propose time cannot see, and the reason the settings store calls this directly.
    r.deps.config.delegation.confirm = true;
    r.d.forgetConfirmations();
    r.deps.config.delegation.confirm = 'first';
    r.d.forgetConfirmations();

    const res = (await r.d.handle(P, task('cc', 'after the change'))) as TaskNewResult;
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(1);
    expect(res.result).toContain('Nothing starts until they confirm');
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(2);
  });

  it('notices a tier changed by /reload at the next proposal', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = 'first';
    await r.d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(1);

    // A reload replaces the section in place; no hook runs, so the next proposal compares.
    r.deps.config.delegation.confirm = false;
    await r.d.handle(P, task('cc', 'while off'));
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(2);

    r.deps.config.delegation.confirm = 'first';
    const res = (await r.d.handle(P, task('cc', 'back to first'))) as TaskNewResult;
    expect(res.result).toContain('Nothing starts until they confirm');
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(2);
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(2);
  });

  it('does not record an agent when a superseded card answers Start after a newer card replaced it', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = 'first';
    const releases: Array<(v: string | null) => void> = [];
    // The signal is deliberately ignored: this is the card whose answer arrives late, after a newer
    // card has already taken its place.
    const d = new Delegation({
      ...(r.d as unknown as { deps: DelegationDeps }).deps,
      confirm: ({ text, labels, signal }) => {
        r.cards.push({ text, labels, signal });
        return new Promise((res) => {
          releases.push(res);
        });
      },
    });
    await d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(1);

    // A second proposal re-renders the card and aborts the first; its Start has not come back yet.
    await d.handle(P, task('cx', 'second'));
    await settle();
    expect(r.cards.map((c) => c.signal.aborted)).toEqual([true, false]);

    releases[0]!('Start it');
    await settle();
    await settle();
    expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);

    // The newer card is cancelled, so cc is still unconfirmed and the next proposal asks again. If
    // the late Start had been taken, cc would have started at once and no third card would appear.
    releases[1]!('Cancel');
    await settle();
    await d.handle(P, task('cc', 'third'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(3);
    expect(r.calls.filter(([c]) => c === 'openTask')).toEqual([]);
  });

  it('still counts an agent whose first sub-task failed to start as confirmed', async () => {
    const r = rig({ failOpen: 'cx' });
    r.deps.config.delegation.confirm = 'first';
    await r.d.handle(P, task('cx', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();
    expect(r.cards).toHaveLength(1);
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(1);

    // The person tapped Start; the directory being wrong does not un-tap it.
    const res = (await r.d.handle(P, task('cx', 'second'))) as TaskNewResult;
    expect(r.cards).toHaveLength(1);
    expect(res.result).toContain('Could not start');
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(2);
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.posted.some((p) => p.text.includes('could not start the sub-agent'))).toBe(true);
  });

  it('forgets what was confirmed when the gateway restarts', async () => {
    const r = rig();
    r.deps.config.delegation.confirm = 'first';
    await r.d.handle(P, task('cc', 'first'));
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    await settle();

    // A restart builds a new Delegation over the same config; a surviving map would be the bug.
    const restarted = new Delegation({ ...(r.d as unknown as { deps: DelegationDeps }).deps });
    await restarted.handle(P, task('cc', 'after restart'));
    expect(r.calls.filter(([c]) => c === 'openTask')).toHaveLength(1);
    r.clock.advance(PROPOSAL_GATHER_MS);
    await settle();
    expect(r.cards).toHaveLength(2);
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
    seedTurn(r.history, 'web#main#c1000000', [
      { role: 'user', text: 'do it' },
      { role: 'agent', text: 'done' },
    ]);
    const read = (await r.d.handle(P, { kind: 'task-read', topic: 'web:main/c1000000' })) as TaskReadResult;
    expect(read.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'do it'],
      ['agent', 'done'],
    ]);
    await r.d.handle(P, { kind: 'task-stop', topic: 'c1000000' });
    expect(r.calls).toContainEqual(['stop', 'web#main#c1000000']);
  });

  it('names a topic from the store when `channels` cannot list it yet', async () => {
    const r = await withChild();
    // A topic opened seconds ago has no lastAt, so `channels` — the newest 200 — can drop it; the
    // store still knows the name openTask gave it, and that is what the row must show.
    r.registry.listChannels = () => ({ channels: [], totalTopics: 0, limit: 200 });
    const list = (await r.d.handle(P, { kind: 'task-list' })) as TaskListResult;
    expect(list.tasks[0]!.title).toBe('part');
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
    seedTurn(r.history, 'web#main#c1000000', [{ role: 'agent', text: lines.join('\n') }]);
    const whole = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', full: true })) as TaskReadResult;
    expect(whole.messages[0]!.text).toBe(lines.join('\n'));

    const tail = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', tail: 3 })) as TaskReadResult;
    expect(tail.messages[0]!.text).toContain('…[197 earlier lines]');
    expect(tail.messages[0]!.text.endsWith('line 197\nline 198\nline 199')).toBe(true);
  });

  it('keeps the newest messages when --full would blow the total budget, and says what it left out', async () => {
    const r = await withChild();
    seedTurn(
      r.history,
      'web#main#c1000000',
      Array.from({ length: 6 }, (_, i) => ({ role: 'agent' as const, text: `${i}:`.padEnd(20_000, 'x') }))
    );
    const read = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', full: true, limit: 10 })) as TaskReadResult;
    expect(read.messages).toHaveLength(4);
    expect(read.note).toMatch(/the 2 oldest of 6 messages were left out/);
    expect(read.messages[3]!.text.startsWith('5:')).toBe(true);
  });

  it('says a topic has no record yet, rather than calling the topic wrong', async () => {
    const r = await withChild();
    const read = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000' })) as TaskReadResult;
    expect(read.messages).toEqual([]);
    expect(read.note).toMatch(/nothing has been recorded in this topic yet/);
  });

  it('selects rows with the same filters sessions read uses, and shows the id --since resumes from', async () => {
    const r = await withChild();
    const key = 'web#main#c1000000';
    seedTurn(r.history, key, [
      { role: 'user', text: 'first prompt' },
      { role: 'tool', text: 'Bash: ls' },
      { role: 'agent', text: 'first answer' },
    ]);
    seedTurn(r.history, key, [
      { role: 'user', text: 'second prompt' },
      { role: 'agent', text: 'second answer about needles' },
    ]);

    const first = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', turn: '1' })) as TaskReadResult;
    expect(first.messages.map((m) => m.text)).toEqual(['first prompt', 'Bash: ls', 'first answer']);
    expect(first.turn).toMatchObject({ turn: 1, outcome: 'done', agent: 'cc' });

    const agentRows = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', role: 'agent' })) as TaskReadResult;
    expect(agentRows.messages.map((m) => m.text)).toEqual(['first answer', 'second answer about needles']);

    const grepped = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', grep: 'needles' })) as TaskReadResult;
    expect(grepped.messages.map((m) => m.text)).toEqual(['second answer about needles']);

    const lastTwo = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', turns: 2 })) as TaskReadResult;
    expect(lastTwo.messages.map((m) => m.text)).toEqual([
      'first prompt',
      'Bash: ls',
      'first answer',
      'second prompt',
      'second answer about needles',
    ]);

    // The newest n, oldest first — the default 10 is the same rule, and --since is the other
    // direction: it resumes from a row id this output prints.
    const newest = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', limit: 2 })) as TaskReadResult;
    expect(newest.messages.map((m) => m.text)).toEqual(['second prompt', 'second answer about needles']);
    const since = (await r.d.handle(P, {
      kind: 'task-read',
      topic: 'c1000000',
      since: lastTwo.messages[2]!.id,
    })) as TaskReadResult;
    expect(since.messages.map((m) => m.text)).toEqual(['second prompt', 'second answer about needles']);
  });

  it('does not cut a --turn read at the default ten messages', async () => {
    // The default 10 is "the newest ten messages"; a turn read is about that turn, and ten of its
    // rows is an answer to a question nobody asked.
    const r = await withChild();
    seedTurn(
      r.history,
      'web#main#c1000000',
      Array.from({ length: 12 }, (_, i) => ({ role: 'tool' as const, text: `Bash: step ${i}` }))
    );
    const read = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', turn: 'last' })) as TaskReadResult;
    expect(read.messages).toHaveLength(12);
  });

  it('--reply gives the last normally-ended turn’s reply whole, past every cut', async () => {
    const r = await withChild();
    const key = 'web#main#c1000000';
    const long = 'r'.repeat(30_000);
    seedTurn(r.history, key, [{ role: 'agent', text: 'first reply' }]);
    seedTurn(r.history, key, [{ role: 'agent', text: long }]);
    // A later failed turn must not hide the last one that finished.
    seedTurn(r.history, key, [{ role: 'user', text: 'next question' }, { role: 'agent', text: 'half' }], 'failed', 'boom');

    const reply = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', reply: true })) as TaskReadResult;
    expect(reply.reply).toEqual({ turn: 2, at: expect.any(String), text: long });
    expect(reply.messages).toEqual([]);
  });

  it('--reply says when no turn has ended normally, rather than an older reply', async () => {
    const r = await withChild();
    seedTurn(r.history, 'web#main#c1000000', [{ role: 'user', text: 'go' }], 'running');
    const reply = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', reply: true })) as TaskReadResult;
    expect(reply.reply).toBeUndefined();
    expect(reply.note).toMatch(/no turn in this topic has ended normally in the current generation yet/);
    // `--turn last` is not generation-scoped, so the note must not offer it as the answer.
    expect(reply.note).toMatch(/--turn last is not scoped to the generation/);
    expect(reply.note).toMatch(/after \/new/);
  });

  it('--turn last carries a failed turn’s whole error, which the card could not', async () => {
    const r = await withChild();
    const error = `Process exited 1:\n${'  at step (file.ts:1:1)\n'.repeat(300)}`;
    seedTurn(r.history, 'web#main#c1000000', [{ role: 'user', text: 'go' }], 'failed', error);
    const read = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', turn: 'last' })) as TaskReadResult;
    expect(read.turn).toMatchObject({ turn: 1, outcome: 'failed', agent: 'cc' });
    expect(read.turn!.detail).toBe(error);
    expect(read.turn!.detail!.length).toBeGreaterThan(CARD_ITEM_CHARS);
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
    expect(r.posted).toContainEqual({ to: P, text: '🔔 part (cc @ near) — finished: Done: all green.', kind: 'report' });
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

  it('says no reply instead of passing its first line off as the reply', async () => {
    const r = await oneChild();
    const key = 'web#main#c1000000';
    r.activity.set(key, { outcome: { kind: 'done', at: 5, line: 'Done: first line.' } });
    r.d.childChanged(key);
    r.clock.advance(CARD_DELAY_MS);
    const prompt = cardOf(r);
    expect(prompt).toContain('  reply: no reply');
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
    expect(body).toContain('task-read web:main/c1000000 --reply');
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
    expect(list[2]).toContain('task-read web:main/c3000000 --reply');
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
    expect(r.posted.find((p) => p.kind === 'report')?.text).toBe(
      '🔔 part (cc @ near) — waiting on a question: This needs a decision. Which database should I use? - postgres - sqlite'
    );
    const list = (await r.d.handle(P, { kind: 'task-list' })) as TaskListResult;
    expect(list.tasks[0]!.line).toBe('This needs a decision. Which database should I use? - postgres - sqlite');
  });

  it('cuts a long question at CARD_ITEM_CHARS, and says where it waits rather than pointing at the log', async () => {
    const r = await oneChild();
    const key = 'web#main#c1000000';
    r.questions.set(key, 'q'.repeat(5_000));
    r.asking.add(key);
    r.d.childChanged(key);
    r.clock.advance(CARD_DELAY_MS);
    const [body] = bodies(cardOf(r), 'question');
    expect(body!.length).toBe(CARD_ITEM_CHARS);
    expect(body).toContain('5000 chars total, cut at');
    // The ask is the gateway's own message; `task-read` reads the library, which has no row for it.
    expect(body).toContain('the question is waiting in this topic for the person to answer it');
    expect(body).not.toContain('task-read');
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
    expect(body).toContain("the whole error is in this topic's record — task-read web:main/c1000000 --turn last");
    expect(body).not.toContain('--full');
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
    chain.outcomes.turnEnded('web#main#c1000000', { kind: 'done', text: reply, turn: 1 });
    chain.r.clock.advance(CARD_DELAY_MS);
    expect(cardOf(chain.r)).toContain(`  reply: ${reply.replace(/\n/g, '\n  ')}`);
  });

  it('is fed by a real failed turn: the whole error is cut, disclosed, and says where the rest is', async () => {
    const chain = realChain();
    await openOne(chain);
    const error = `Process exited 1:\n${'  at step (file.ts:1:1)\n'.repeat(400)}`;
    chain.outcomes.turnEnded('web#main#c1000000', { kind: 'failed', error: new Error(error), turn: 1 });
    chain.r.clock.advance(CARD_DELAY_MS);
    const prompt = cardOf(chain.r);
    expect(prompt).toContain('  failure: Process exited 1:');
    expect(prompt).toContain(`${error.length} chars total, cut at`);
    expect(prompt).toContain("the whole error is in this topic's turn 1 — task-read web:main/c1000000 --turn 1");
    expect(prompt).not.toContain('--turn last');
  });

  it('shows a refused turn as failed, with the reason its harness gave', async () => {
    const chain = realChain();
    await openOne(chain);
    const message = 'the agent refused this request: Quota exceeded: request rejected by the upstream gateway';
    chain.outcomes.turnEnded('web#main#c1000000', { kind: 'failed', error: new TurnFailure(message, 'limit'), turn: 1 });
    chain.r.clock.advance(CARD_DELAY_MS);
    // Not "finished with no reply": the parent reads the same sentence the chat got.
    expect(cardOf(chain.r)).toContain(`  failure: ${message}`);
  });

  it('points a cut reply at the turn it quoted, not at whatever is newest after a burst', async () => {
    const chain = realChain();
    await openOne(chain);
    const key = 'web#main#c1000000';
    const reply = `Verdict: merge after one fix.\n${'x'.repeat(5_000)}`;
    seedTurn(chain.r.history, key, [{ role: 'agent', text: reply }], 'done'); // turn 1
    chain.outcomes.turnEnded(key, { kind: 'done', text: reply, turn: 1 });
    chain.r.clock.advance(CARD_DELAY_MS);
    const prompt = cardOf(chain.r);
    expect(prompt).toContain('task-read web:main/c1000000 --turn 1 --full');
    expect(prompt).not.toContain('--reply');

    // A background burst afterwards is turn 2, and `--reply` would now answer with it.
    seedTurn(chain.r.history, key, [{ role: 'agent', text: 'burst: the deploy finished' }], 'done');
    const burst = (await chain.d.handle(P, { kind: 'task-read', topic: 'c1000000', reply: true })) as TaskReadResult;
    expect(burst.reply!.text).toBe('burst: the deploy finished');

    // The turn the card named still reads as the reply it quoted.
    const original = (await chain.d.handle(P, {
      kind: 'task-read',
      topic: 'c1000000',
      turn: '1',
      full: true,
    })) as TaskReadResult;
    expect(original.messages.map((m) => m.text)).toContain(reply);
  });

  it('reads a reply past the 20k log cut whole when the card names its turn', async () => {
    const r = await oneChild();
    const reply = 'r'.repeat(30_016);
    seedTurn(r.history, 'web#main#c1000000', [{ role: 'agent', text: reply }], 'done');
    // The card points here for the rest of a cut reply: a single turn is bounded by the library's
    // 200k, not by the 20k that keeps a --full log readable.
    const whole = (await r.d.handle(P, {
      kind: 'task-read',
      topic: 'c1000000',
      turn: '1',
      full: true,
    })) as TaskReadResult;
    expect(whole.messages).toHaveLength(1);
    expect(whole.messages[0]!.text).toBe(reply);
    // `--turns` is a log read and keeps the smaller cut.
    const log = (await r.d.handle(P, { kind: 'task-read', topic: 'c1000000', turns: 1, full: true })) as TaskReadResult;
    expect(log.messages[0]!.text).not.toBe(reply);
    expect(log.messages[0]!.text).toContain('later characters');
  });

  it('points a cut error at the turn it came from, so a later burst cannot hide it', async () => {
    const chain = realChain();
    await openOne(chain);
    const key = 'web#main#c1000000';
    const error = `Process exited 1:\n${'  at step (file.ts:1:1)\n'.repeat(300)}`;
    seedTurn(chain.r.history, key, [{ role: 'user', text: 'go' }], 'failed', error); // turn 1
    chain.outcomes.turnEnded(key, { kind: 'failed', error: new Error(error), turn: 1 });
    chain.r.clock.advance(CARD_DELAY_MS);
    const prompt = cardOf(chain.r);
    expect(prompt).toContain("the whole error is in this topic's turn 1 — task-read web:main/c1000000 --turn 1");
    expect(prompt).not.toContain('--turn last');

    // A burst after the failure makes turn 2 "last"; the card named turn 1.
    seedTurn(chain.r.history, key, [{ role: 'agent', text: 'burst' }], 'done');
    const original = (await chain.d.handle(P, { kind: 'task-read', topic: 'c1000000', turn: '1' })) as TaskReadResult;
    expect(original.turn!.outcome).toBe('failed');
    expect(original.turn!.detail).toBe(error);
    const positional = (await chain.d.handle(P, { kind: 'task-read', topic: 'c1000000', turn: 'last' })) as TaskReadResult;
    expect(positional.turn!.outcome).toBe('done');
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
