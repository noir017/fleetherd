import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRegistry } from './conversation.js';
import { ConversationStore } from './conversation-store.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, RunTurnInput } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * The model and effort a person chose for a conversation, across everything that replaces the
 * session object holding them.
 *
 * Reported 2026-11-05 as "remember the model chosen for this conversation, and restore it when the
 * agent restarts". Both choices used to live only in memory — the runtime's closure and
 * ConversationState — so a daemon restart dropped them, and `/new` and `/cd`, which dispose the
 * session object, dropped the runtime's copy while the status line went on naming the choice.
 *
 * What is pinned here is the registry's half: the person's choice is written to the record (the
 * value as offered, not the name the harness answers with), kept across `/new` and `/cd`, read back
 * into a fresh registry over the same file, and NOT written for a scheduled task's `--model`. The
 * runtime's half — handing the record to the harness — is in agent-acp-effort.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), 'model-memory-'));
mkdirSync(join(root, 'quantlab'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const parsed = parseConfig({
  platforms: { discord: { type: 'discord', token: 't' } },
  agents: [{ id: 'oc', harness: 'opencode', cwd: root, model: 'opencode/glm-5' }],
  routing: { default: 'oc', pipeline: [] },
});
const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

const clock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const MODELS = [
  { value: 'opencode/glm-5', name: 'GLM-5' },
  { value: 'newapi/kimi-k3', name: 'Kimi K3' },
];
const LEVELS = [
  { value: 'low', name: 'low' },
  { value: 'high', name: 'high' },
];

function rig(file: string) {
  const turns: RunTurnInput[] = [];
  const sessions = new Map<string, AgentSession>();
  const created: string[] = [];
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        let model = 'opencode/glm-5';
        let effort = 'high';
        created.push(conversationId);
        s = {
          conversationId,
          runTurn: async (input) => void turns.push(input),
          abort: () => {},
          dispose: () => {},
          ensureSession: async () => {},
          modelSelector: () => ({ current: model, options: MODELS }),
          // The harness answers with its display name, as liveModelName does for opencode.
          setModel: async (v: string) => {
            model = v;
            return MODELS.find((m) => m.value === v)?.name ?? v;
          },
          effortSelector: () => ({ current: effort, options: LEVELS }),
          setEffort: async (v: string) => {
            effort = v;
            return v;
          },
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };
  const platform = {
    capabilities: { thread: false, editMessage: true, buttons: false, editButtons: false },
    sendMessage: async (address: { channel: string }) => ({ address, messageId: 'm1' }),
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;
  const store = new ConversationStore(file);
  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock, {}, store);
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
  return { reg, send, store, turns, created, key: 'discord#c1#' };
}

const freshFile = (): string => join(mkdtempSync(join(tmpdir(), 'model-memory-store-')), 'conversations.json');

describe('the model and effort a person chose', () => {
  it('are recorded as the values offered, not the names the harness answered with', async () => {
    const { send, store, key } = rig(freshFile());
    await send('/model kimi');
    await send('/effort low');
    expect(store.conversationChoice(key, 'oc', 'model')).toBe('newapi/kimi-k3');
    expect(store.conversationChoice(key, 'oc', 'effort')).toBe('low');
  });

  it('survive /new and /cd, which replace the session object that held them', async () => {
    const { send, store, key, turns } = rig(freshFile());
    await send('/model kimi');
    await send('/effort low');
    await send('/new');
    await send('/cd quantlab');
    expect(store.conversationChoice(key, 'oc', 'model')).toBe('newapi/kimi-k3');
    expect(store.conversationChoice(key, 'oc', 'effort')).toBe('low');
    await send('hello');
    expect(turns.at(-1)?.model).toBe('Kimi K3');
  });

  it('come back after a restart: the first turn carries the model', async () => {
    const file = freshFile();
    const before = rig(file);
    await before.send('/model kimi');
    await before.send('hello');

    // A new daemon over the same conversations.json.
    const after = rig(file);
    await after.send('hello again');
    expect(after.turns.at(-1)?.model).toBe('newapi/kimi-k3');
    expect(after.store.conversationChoice(after.key, 'oc', 'effort')).toBeUndefined();
  });

  it('a scheduled task’s --model is applied without being recorded', async () => {
    const { reg, store, key } = rig(freshFile());
    expect(await reg.applyScheduledModel(key, 'discord', 'oc', 'newapi/kimi-k3')).toBeUndefined();
    expect(store.conversationChoice(key, 'oc', 'model')).toBeUndefined();
  });
});
