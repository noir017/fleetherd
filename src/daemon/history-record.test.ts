import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { InboundMessage } from '../types.js';
import { HistoryStore } from '../history/store.js';

/**
 * What the library gets from a turn, and what a broken library costs it.
 *
 * The second half is the important one: an answer that was delivered but not indexed is a
 * missing search result; an answer lost because the index could not be written is a broken
 * gateway. Every write on this path is best-effort by design.
 */

const dirs: string[] = [];

function tempStore(): HistoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-history-turn-'));
  dirs.push(dir);
  return new HistoryStore(path.join(dir, 'history.db'));
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
  history?: HistoryStore
) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude', cwd: '/work' }],
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
        setFollowUpSink: () => {},
        dispose: () => {},
      };
    },
    peek: () => undefined,
    dispose: () => {},
  };
  const reg = new ConversationRegistry(
    cfg,
    new Map([['discord', platform]]),
    factory,
    clock,
    {},
    undefined,
    undefined,
    undefined,
    history
  );
  return { reg, sent };
}

describe('a turn in the conversation library', () => {
  it('records the prompt, each tool line and the whole reply', async () => {
    const store = tempStore();
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
    store.close();
  });

  it('records attachment names, never their contents', async () => {
    const store = tempStore();
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
    const store = tempStore();
    const h = rig(async (t) => void t.onText('晨报：一切正常'), store);
    h.reg.route(inbound('发晨报', { conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'schedule' } }));
    await drain();
    const session = store.list({ days: 30 })[0]!;
    expect(session.kind).toBe('schedule');
    expect(store.read(String(session.id)).messages.every((m) => m.kind === 'schedule')).toBe(true);
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
