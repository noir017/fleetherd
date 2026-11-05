import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { ConversationStore } from './conversation-store.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers, FollowUpSink } from './agent.js';
import type { InboundMessage, SteerOutcome } from '../types.js';
import { HistoryStore } from '../history/store.js';

/**
 * What the library gets from a turn, and what a broken library costs it.
 *
 * The second half is the important one: an answer that was delivered but not indexed is a
 * missing search result; an answer lost because the index could not be written is a broken
 * gateway. Every write on this path is best-effort by design.
 */

const dirs: string[] = [];

function tempStore(): { store: HistoryStore; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-history-turn-'));
  dirs.push(dir);
  const file = path.join(dir, 'history.db');
  return { store: new HistoryStore(file), file };
}

/** What the turns table holds — the trigger and generation are stored, not printed by read. */
function rawTurns(file: string): Array<Record<string, unknown>> {
  const db = new (
    createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (f: string) => { prepare(sql: string): { all(): unknown[] }; close(): void };
    }
  ).DatabaseSync(file);
  const rows = db.prepare('SELECT seq, agent, generation, trigger, outcome FROM turns ORDER BY seq').all() as Array<
    Record<string, unknown>
  >;
  db.close();
  return rows;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function inbound(content: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId: 'm1',
    content,
    timestamp: 0,
    ...extra,
  };
}

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 80));

function rig(
  runTurn: (h: AgentStreamHandlers) => Promise<void>,
  history?: HistoryStore,
  /** When set, the fake agent has a `steer` that answers with this outcome. */
  steerOutcome?: SteerOutcome
) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude', cwd: '/work' },
      { id: 'oc', harness: 'opencode', cwd: '/work' },
    ],
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: false } },
  });
  const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
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
        ...(steerOutcome ? { steer: async () => steerOutcome } : {}),
        setFollowUpSink: (s) => {
          sink = s;
        },
        dispose: () => {},
      };
    },
    peek: () => undefined,
    dispose: () => {},
  };
  let sink: FollowUpSink | undefined;
  // The real store, in a temp dir: /new's generation lives there, and the registry already
  // expects one for its binding bookkeeping.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-reg-'));
  dirs.push(stateDir);
  const reg = new ConversationRegistry(
    cfg,
    new Map([['discord', platform]]),
    factory,
    clock,
    {},
    new ConversationStore(path.join(stateDir, 'conversations.json')),
    undefined,
    undefined,
    history
  );
  return { reg, sent, sink: () => sink };
}

describe('a turn in the conversation library', () => {
  it('records the prompt, each tool line and the whole reply', async () => {
    const { store, file } = tempStore();
    const h = rig(async (t) => {
      t.onText('先看一下仓库。');
      t.onToolStart({ name: 'Bash', inputPreview: 'git status', index: 0 });
      t.onToolFinish({ name: 'Bash', ok: true, durationMs: 5, index: 0 });
      t.onSegmentBreak();
      t.onText('查询做完了，测试全过。');
    }, store);
    h.reg.route(inbound('帮我实现跨会话查询'));
    await drain();

    const sessions = store.list({ days: 30 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ key: 'discord#c1#', agent: 'cc', kind: 'normal' });
    const read = store.read(String(sessions[0]!.id));
    expect(read.messages.map((m) => m.role)).toEqual(['user', 'tool', 'agent']);
    expect(read.messages[0]!.text).toBe('帮我实现跨会话查询');
    expect(read.messages[1]!.text).toBe('Bash: git status');
    expect(read.messages[2]!.text).toBe('先看一下仓库。\n\n查询做完了，测试全过。');
    // Every row of the turn carries its id, and the turn says how it ended.
    const turn = store.read(String(sessions[0]!.id), { turn: 'last' });
    expect(turn.messages.map((m) => `${m.turn}:${m.outcome}:${m.agent}`)).toEqual([
      '1:done:cc',
      '1:done:cc',
      '1:done:cc',
    ]);
    expect(rawTurns(file)).toEqual([{ seq: 1, agent: 'cc', generation: 0, trigger: 'person', outcome: 'done' }]);
    store.close();
  });

  it('records attachment names, never their contents', async () => {
    const { store } = tempStore();
    const h = rig(async (t) => void t.onText('收到'), store);
    h.reg.route(
      inbound('看这个文件', {
        attachments: [{ type: 'file', url: 'https://example.invalid/report.pdf', name: 'report.pdf' }],
      })
    );
    await drain();
    const read = store.read(String(store.list({ days: 30 })[0]!.id));
    expect(read.messages[0]!.text).toBe('看这个文件\n[attachments: report.pdf]');
    store.close();
  });

  it('files a scheduled run as schedule, so it sorts after ordinary work', async () => {
    const { store, file } = tempStore();
    const h = rig(async (t) => void t.onText('晨报：一切正常'), store);
    h.reg.route(inbound('发晨报', { conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'schedule' } }));
    await drain();
    const session = store.list({ days: 30 })[0]!;
    expect(session.kind).toBe('schedule');
    expect(store.read(String(session.id)).messages.every((m) => m.kind === 'schedule')).toBe(true);
    expect(rawTurns(file).map((t) => `${t.trigger}:${t.outcome}`)).toEqual(['schedule:done']);
    store.close();
  });

  it('gives background output a turn of its own, after the turn that asked', async () => {
    const { store, file } = tempStore();
    const h = rig(async (t) => void t.onText('我去跑，回头报。'), store);
    h.reg.route(inbound('跑个后台任务'));
    await drain();
    const sink = h.sink();
    expect(sink).toBeDefined();
    // What the runtime does when the agent reports back after its turn.
    sink!.handlers().onText('后台汇报：跑完了');
    await sink!.close();

    const session = store.list({ days: 30 })[0]!;
    const rows = store.read(String(session.id), { role: 'agent' });
    expect(rows.messages.map((m) => `${m.turn}:${m.outcome}:${m.text}`)).toEqual([
      '1:done:我去跑，回头报。',
      '2:done:后台汇报：跑完了',
    ]);
    expect(rawTurns(file).map((t) => `${t.seq}:${t.trigger}:${t.outcome}`)).toEqual([
      '1:person:done',
      '2:background:done',
    ]);
    store.close();
  });

  it('records a background burst cut off by /stop as stopped, not done', async () => {
    const { store, file } = tempStore();
    const h = rig(async (t) => void t.onText('收到'), store);
    h.reg.route(inbound('跑个后台任务'));
    await drain();
    const sink = h.sink()!;
    sink.handlers().onText('后台汇报到一半');
    // The runtime's stopBackground passes this reason after telling the person it stopped.
    await sink.close('stopped');

    const session = store.list({ days: 30 })[0]!;
    const rows = store.read(String(session.id), { role: 'agent' });
    expect(rows.messages.map((m) => `${m.turn}:${m.outcome}`)).toEqual(['1:done', '2:stopped']);
    expect(rawTurns(file).map((t) => `${t.seq}:${t.trigger}:${t.outcome}`)).toEqual([
      '1:person:done',
      '2:background:stopped',
    ]);
    store.close();
  });

  it('does not file a detached interjection under the turn that just ended', async () => {
    const { store } = tempStore();
    let release: () => void = () => {};
    const h = rig(async () => {
      await new Promise<void>((r) => (release = r));
    }, store, 'detached');
    h.reg.route(inbound('开始'));
    await drain();
    // The harness had finished its turn and answers this in one of its own; the answer will come
    // back as a background burst, so the prompt belongs to no recorded turn.
    h.reg.route(inbound('插话'));
    await drain();
    release();
    await drain();

    const session = store.list({ days: 30 })[0]!;
    const users = store.read(String(session.id), { role: 'user' });
    expect(users.messages.map((m) => `${m.turn}:${m.text}`)).toEqual(['1:开始', 'null:插话']);
    // The finished turn holds one question, not a question it never answered.
    expect(store.read(String(session.id), { turn: '1' }).messages.filter((m) => m.role === 'user')).toHaveLength(1);
    store.close();
  });

  it('files a joined interjection under the running turn', async () => {
    const { store, file } = tempStore();
    let release: () => void = () => {};
    const h = rig(async () => {
      await new Promise<void>((r) => (release = r));
    }, store, 'joined');
    h.reg.route(inbound('开始'));
    await drain();
    // The harness took the message inside the same turn; its answer is this turn's answer.
    h.reg.route(inbound('插话'));
    await drain();
    release();
    await drain();

    const session = store.list({ days: 30 })[0]!;
    const users = store.read(String(session.id), { role: 'user' });
    expect(users.messages.map((m) => `${m.turn}:${m.text}`)).toEqual(['1:开始', '1:插话']);
    expect(rawTurns(file).map((t) => `${t.seq}:${t.outcome}`)).toEqual(['1:done']);
    store.close();
  });

  it('records a foreground turn stopped by /stop as stopped', async () => {
    const { store, file } = tempStore();
    let release: () => void = () => {};
    const h = rig(async () => {
      await new Promise<void>((r) => (release = r));
    }, store);
    h.reg.route(inbound('长任务'));
    await drain();
    h.reg.route(inbound('/stop'));
    await drain();
    // The harness settles when its child is aborted; the turn is recorded from the signal.
    release();
    await drain();

    expect(rawTurns(file).map((t) => `${t.seq}:${t.trigger}:${t.outcome}`)).toEqual(['1:person:stopped']);
    const read = store.read(String(store.list({ days: 30 })[0]!.id), { turn: 'last' });
    expect(read.messages.map((m) => `${m.turn}:${m.outcome}`)).toEqual(['1:stopped']);
    store.close();
  });

  it('numbers turns across a /new, and records the agent that answered each', async () => {
    const { store, file } = tempStore();
    const h = rig(async (t) => void t.onText('好'), store);
    h.reg.route(inbound('第一轮'));
    await drain();
    h.reg.resetConversation('discord#c1#');
    // A reset is what lets this topic change agent (switchRefusal refuses while a session exists).
    h.reg.chooseAgent('discord#c1#', 'oc', inbound('换成 oc').conversation);
    h.reg.route(inbound('第二轮'));
    await drain();

    expect(rawTurns(file).map((t) => `${t.seq}:${t.agent}:${t.generation}`)).toEqual(['1:cc:0', '2:oc:1']);
    const read = store.read(String(store.list({ days: 30 })[0]!.id), { turns: 2 });
    expect(read.messages.map((m) => `${m.turn}:${m.agent}`)).toEqual(['1:cc', '1:cc', '2:oc', '2:oc']);
    store.close();
  });

  it('answers the turn even when every library write throws', async () => {
    const broken = {
      available: true,
      session() {
        throw new Error('disk full');
      },
      message() {
        throw new Error('disk full');
      },
      setTitle() {
        throw new Error('disk full');
      },
    } as unknown as HistoryStore;
    const h = rig(async (t) => void t.onText('答案照常发出。'), broken);
    h.reg.route(inbound('随便问点什么'));
    await drain();
    expect(h.sent).toEqual(['答案照常发出。']);
  });
});
