import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRegistry } from './conversation.js';
import { ConversationStore } from './conversation-store.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import { TurnFailure } from './agent.js';
import { readPromptRefusal } from './session-failure.js';
import type { InboundMessage, TopicActivity } from '../types.js';

/**
 * The turn-outcome and sub-agent wiring through a real registry, merger and turn runner, with a fake
 * agent: what a failed turn turns into when `hooks.turnFailed.continue` is set, and what opening a
 * sub-agent's topic (openTask, handTo — daemon/delegation.ts) does to real conversations.
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

function rig(
  opts: {
    continue?: Record<string, unknown>;
    script?: Array<'fail' | 'ok' | 'refuse'>;
    hold?: boolean;
    steer?: boolean;
    modelFailure?: string;
    store?: ConversationStore;
  } = {}
) {
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

  const sent: Array<{ to: string; text: string; kind?: string }> = [];
  const renamed: Array<{ to: string; name: string }> = [];
  const activity: Array<{ to: string; a: TopicActivity | undefined }> = [];
  const nested: Array<{ name: string; under: string }> = [];
  let seq = 0;
  let threads = 0;
  const where = (a: ConversationAddress) => `${a.channel}/${a.thread ?? ''}`;
  const platform = {
    platform: 'web',
    capabilities: { thread: true, renameThread: true, editMessage: true, maxMessageLength: 2000 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: ConversationAddress, text: string, opts?: { kind?: string }) => {
      sent.push({ to: where(address), text, ...(opts?.kind ? { kind: opts.kind } : {}) });
      return { address, messageId: `s${++seq}` };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    createThread: async (_ref: unknown, name: string, o?: { under?: ConversationAddress }) => {
      nested.push({ name, under: o?.under ? where(o.under) : '' });
      return { address: { channel: 'main', thread: `new${++threads}` } };
    },
    renameThread: async (address: ConversationAddress, name: string) => renamed.push({ to: where(address), name }),
    setActivity: (address: ConversationAddress, a: TopicActivity | undefined) => activity.push({ to: where(address), a }),
  } as unknown as PlatformAdapter;

  const script = [...(opts.script ?? [])];
  const prompts: Array<{ conversation: string; prompt: string }> = [];
  const models: Array<{ conversation: string; model: string }> = [];
  const events: string[] = [];
  const factory: AgentFactory = {
    getOrCreate(conversationId): AgentSession {
      return {
        runTurn: async (input: { prompt: string }, h: AgentStreamHandlers) => {
          prompts.push({ conversation: conversationId, prompt: input.prompt });
          events.push(`turn:${input.prompt}`);
          // A turn that stays running, so a handTo lands mid-turn (the queued/joined distinction).
          if (opts.hold) await new Promise<void>(() => {});
          const next = script.shift() ?? 'ok';
          if (next === 'fail') throw new TurnFailure('upstream 503', 'service');
          if (next === 'refuse') {
            // Exactly what the ACP runtime throws for CodeBuddy's quota refusal (session-failure.ts),
            // so this half of the test starts from the message the chat and the card would show.
            const refusal = readPromptRefusal({
              stopReason: 'refusal',
              _meta: {
                'codebuddy.ai/errorMessage': JSON.stringify({
                  code: -32003,
                  message: 'Quota exceeded: request rejected by the upstream gateway',
                  data: { statusCode: 429, category: 'quota' },
                }),
              },
            })!;
            throw new TurnFailure(refusal.message, refusal.reason);
          }
          h.onText('Done: all green.');
        },
        abort: () => {},
        setFollowUpSink: () => {},
        dispose: () => {},
        ensureSession: async () => {},
        setModel: async (model: string) => {
          models.push({ conversation: conversationId, model });
          events.push(`model:${model}`);
          if (model === opts.modelFailure) throw new Error('the harness refused this model');
          return model;
        },
        ...(opts.steer ? { steer: async () => 'joined' as const } : {}),
      } as unknown as AgentSession;
    },
    peek: () => undefined,
    dispose: () => {},
  };

  const registry = new ConversationRegistry(cfg, new Map([['web', platform]]), factory, clock, undefined, opts.store);
  return { registry, sent, prompts, models, events, activity, renamed, nested };
}

const storeDir = mkdtempSync(join(tmpdir(), 'delegation-registry-'));
afterAll(() => rmSync(storeDir, { recursive: true, force: true }));

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

  it('a refusal is a failure like any other: the reason reaches the topic and the continue', async () => {
    const r = rig({ continue: { on: ['limit'], message: '继续', max: 3, backoffMs: 1_000 }, script: ['refuse', 'ok'] });
    live = r.registry;
    r.registry.route(inbound('build it'));
    for (let i = 0; i < 20 && r.prompts.length < 2; i++) await wait(20);
    await wait();

    const message = 'the agent refused this request: Quota exceeded: request rejected by the upstream gateway';
    // The failure was listed with its reason (that is what the card shows), and a retry was scheduled.
    expect(r.activity).toContainEqual({
      to: 'main/tt',
      a: expect.objectContaining({
        outcome: expect.objectContaining({ kind: 'failed', reason: 'limit', line: message }),
        retry: expect.objectContaining({ attempt: 1, max: 3 }),
      }),
    });
    // ...the chat got the failure and the announcement, in that order...
    expect(r.sent.filter((m) => m.text.startsWith('❌')).map((m) => m.text)).toEqual([
      `❌ This turn failed: ${message}`,
    ]);
    expect(r.sent.some((m) => m.text.startsWith('↻ A usage limit was hit'))).toBe(true);
    // ...and the policy that names `limit` continued it.
    expect(r.prompts.map((p) => p.prompt)).toEqual(['build it', '继续']);
    expect(r.activity[r.activity.length - 1]?.a?.outcome).toMatchObject({ kind: 'done', line: 'Done: all green.' });
  });

  it('stops after max refusals instead of continuing forever', async () => {
    const r = rig({
      continue: { on: ['limit'], message: '继续', max: 3, backoffMs: 1_000 },
      script: ['refuse', 'refuse', 'refuse', 'refuse'],
    });
    live = r.registry;
    r.registry.route(inbound('build it'));
    for (let i = 0; i < 40 && r.prompts.length < 4; i++) await wait(20);
    await wait(80);

    // The initial turn and exactly three continues — the fourth refusal ends the run.
    expect(r.prompts.map((p) => p.prompt)).toEqual(['build it', '继续', '继续', '继续']);
    expect(r.sent.some((m) => m.text.startsWith('↻ Not continuing again: 3 automatic continues'))).toBe(true);
  });
});

describe('a sub-agent’s topic (openTask, handTo)', () => {
  const header = '**↳ From [Release](?t=aaaaaaaa)**';
  const parent = { channel: 'main', thread: 'aaaaaaaa' };

  it('openTask nests a topic under its parent, binds it, shows the header, and gives the agent the text alone', async () => {
    const r = rig();
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: '修一下 bump', header });
    expect(opened).toEqual({ key: 'web#main#new1', address: { channel: 'main', thread: 'new1' } });
    expect(r.nested).toEqual([{ name: expect.stringContaining('修一下 bump'), under: 'main/aaaaaaaa' }]);
    await wait();
    expect(r.registry.boundAgentOf(opened.key)).toBe('oc');
    // The `↳ From …` header and the task text are a dispatch, so the web UI draws them as a
    // hand-off rather than as the agent's own words.
    expect(r.sent).toContainEqual({ to: 'main/new1', text: `${header}\n\n修一下 bump`, kind: 'dispatch' });
    expect(r.prompts).toEqual([{ conversation: 'web#main#new1', prompt: '修一下 bump' }]);
  });

  it('openTask applies an explicit model before the first turn, and keeps it for the topic', async () => {
    const store = new ConversationStore(join(storeDir, 'applied.json'));
    const r = rig({ store });
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'go', header, model: 'fast-model' });
    await wait();
    expect(r.models).toEqual([{ conversation: opened.key, model: 'fast-model' }]);
    expect(r.events.slice(0, 2)).toEqual(['model:fast-model', 'turn:go']);
    // On record like a /model choice: a later task-send, /new or restart reads it back.
    expect(store.conversationChoice(opened.key, 'oc', 'model')).toBe('fast-model');
  });

  it('openTask without a model leaves the topic on the configured one', async () => {
    const store = new ConversationStore(join(storeDir, 'default.json'));
    const r = rig({ store });
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'go', header });
    await wait();
    expect(r.models).toEqual([]);
    expect(store.conversationChoice(opened.key, 'oc', 'model')).toBeUndefined();
  });

  it('openTask runs nothing when the harness refuses the model, and the topic says why', async () => {
    const store = new ConversationStore(join(storeDir, 'refused.json'));
    const r = rig({ modelFailure: 'runtime-fail', store });
    live = r.registry;
    await expect(
      r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'go', header, model: 'runtime-fail' })
    ).rejects.toThrow('could not set model "runtime-fail": the harness refused this model');
    await wait();
    expect(r.prompts).toEqual([]);
    expect(r.sent).toEqual([
      { to: 'main/new1', text: 'Not started — could not set model "runtime-fail": the harness refused this model.' },
    ]);
    expect(store.conversationChoice('web#main#new1', 'oc', 'model')).toBeUndefined();
  });

  it('openTask refuses an agent that is not configured, before opening anything', async () => {
    const r = rig();
    live = r.registry;
    await expect(r.registry.openTask({ platform: 'web', parent, agentId: 'zz', text: 'x', header })).rejects.toThrow(/no agent "zz"/);
    expect(r.sent).toEqual([]);
    expect(r.nested).toEqual([]);
  });

  it('handTo refuses a conversation nobody has answered yet', async () => {
    const r = rig();
    live = r.registry;
    await expect(r.registry.handTo('web#main#never', 'web', { channel: 'main', thread: 'never' }, 'x', header)).rejects.toThrow(/nobody answers/);
  });

  it('says queued, not joined, while a harness with no steer is mid-turn', async () => {
    const r = rig({ hold: true });
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'go', header });
    await wait(20);
    expect(r.registry.canSteer(opened.key)).toBe(false);
    await expect(r.registry.handTo(opened.key, 'web', opened.address, 'stop that', header)).resolves.toBe('queued');
    // A later task-send is the same dispatch as the first message.
    expect(r.sent.at(-1)).toEqual({ to: 'main/new1', text: `${header}\n\nstop that`, kind: 'dispatch' });
  });

  it('says joined only when the running harness really takes mid-turn input', async () => {
    const r = rig({ hold: true, steer: true });
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'cc', text: 'go', header });
    await wait(20);
    expect(r.registry.canSteer(opened.key)).toBe(true);
    await expect(r.registry.handTo(opened.key, 'web', opened.address, 'also the docs', header)).resolves.toBe('joined');
    expect(r.sent.at(-1)).toEqual({ to: 'main/new1', text: `${header}\n\nalso the docs`, kind: 'dispatch' });
  });
});
