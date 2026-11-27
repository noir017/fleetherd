import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRegistry } from './conversation.js';
import { ConversationStore } from './conversation-store.js';
import { parseConfig, type Config } from '../config/schema.js';
import { WebuiConfigSchema } from '../config/platform-schemas.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import { CHANNEL, WebRoom } from '../platform/webui/room.js';
import { TopicStore, type Topic } from '../platform/webui/topics.js';
import type { WebEvent } from '../platform/webui/protocol.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import { TurnFailure } from './agent.js';
import { readPromptRefusal } from './session-failure.js';
import type { InboundMessage, PendingQueueItem, SessionOption, TopicActivity } from '../types.js';
import type { PersonWords } from './turn-senders.js';

/**
 * The turn-outcome and sub-agent wiring through a real registry, merger and turn runner, with a fake
 * agent: what a failed turn turns into when `hooks.turnFailed.continue` is set, and what opening a
 * sub-agent's topic (openTask, handTo — daemon/delegation.ts) does to real conversations.
 */

const WAIT = { timeout: 5_000, interval: 10 };

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
    /** The agent's own settings, reported once its session has started; a value in `optionFailure` is refused when set. */
    settings?: SessionOption[];
    optionFailure?: string;
    /** A session start that never answers: an agent on a host that is down. */
    hangStart?: boolean;
    store?: ConversationStore;
    onPersonWords?: (id: string, words: PersonWords) => void;
    platform?: PlatformAdapter;
    ccCwd?: string;
  } = {}
) {
  const parsed = parseConfig({
    platforms: { web: { type: 'webui', token: 't' } },
    agents: [
      {
        id: 'cc',
        harness: 'claude',
        ...(opts.ccCwd ? { cwd: opts.ccCwd } : {}),
        ...(opts.continue ? { hooks: { turnFailed: { continue: opts.continue } } } : {}),
      },
      { id: 'oc', harness: 'opencode' },
    ],
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: false } },
  });
  const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
  const scheduled: Array<{ delay: number; cancelled: boolean }> = [];
  // Every wait shortened, so a backoff is a test step rather than a test timeout: a minute or more to
  // 1 s (time enough for the person to write first), anything shorter to 5 ms.
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const entry = { delay: ms, cancelled: false };
      scheduled.push(entry);
      const t = setTimeout(() => {
        fn();
      }, ms >= 60_000 ? 1_000 : Math.min(ms, 5));
      return () => {
        entry.cancelled = true;
        clearTimeout(t);
      };
    },
  };

  const sent: Array<{ to: string; text: string; kind?: string }> = [];
  const renamed: Array<{ to: string; name: string }> = [];
  const activity: Array<{ to: string; a: TopicActivity | undefined }> = [];
  const pendingQueue: Array<{ to: string; items: readonly PendingQueueItem[] }> = [];
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
    presence: {
      setActivity: (address: ConversationAddress, a: TopicActivity | undefined) => activity.push({ to: where(address), a }),
      setPendingQueue: (address: ConversationAddress, items: readonly PendingQueueItem[]) =>
        pendingQueue.push({ to: where(address), items }),
      markPendingDelivered: () => {},
      setStatus: () => {},
    },
  } as unknown as PlatformAdapter;

  const script = [...(opts.script ?? [])];
  const prompts: Array<{ conversation: string; prompt: string }> = [];
  const models: Array<{ conversation: string; model: string }> = [];
  const events: string[] = [];
  const ensured: string[] = [];
  const factory: AgentFactory = {
    getOrCreate(conversationId): AgentSession {
      // Like an ACP session: the lists exist only once a session has started (both reads are non-spawning).
      let started = false;
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
        ensureSession: async () => {
          ensured.push(conversationId);
          if (opts.hangStart) await new Promise<void>(() => {});
          started = true;
        },
        modelSelector: () =>
          started ? { current: 'base-model', options: [{ value: 'base-model', name: 'Base' }, { value: 'fast-model', name: 'Fast' }] } : undefined,
        sessionOptions: () => (started ? (opts.settings ?? []) : undefined),
        setOption: async (id: string, value: string) => {
          events.push(`option:${id}=${value}`);
          if (value === opts.optionFailure) throw new Error("that account's quota is used up");
          return opts.settings ?? [];
        },
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

  const hooks = opts.onPersonWords ? { onPersonWords: opts.onPersonWords } : undefined;
  const registry = new ConversationRegistry(cfg, new Map([['web', opts.platform ?? platform]]), factory, clock, hooks, opts.store);
  return { registry, sent, prompts, models, events, ensured, activity, pendingQueue, renamed, nested, scheduled };
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
    await vi.waitFor(() => {
      expect(r.activity[r.activity.length - 1]?.a?.outcome).toMatchObject({ kind: 'done', line: 'Done: all green.' });
    }, WAIT);
    expect(r.prompts.map((p) => p.prompt)).toEqual(['build it', '继续', '继续']);
    expect(r.sent.filter((m) => m.text.startsWith('↻')).map((m) => m.text.match(/\(\d\/3\)/)?.[0])).toEqual(['(1/3)', '(2/3)']);
    expect(r.sent.filter((m) => m.text.startsWith('❌'))).toHaveLength(2);
    expect(r.activity[r.activity.length - 1]?.a?.outcome).toMatchObject({ kind: 'done', line: 'Done: all green.' });
  });

  it('a message from the person calls the continue off', async () => {
    const r = rig({ continue: { on: ['service'], backoffMs: 120_000 }, script: ['fail'] });
    live = r.registry;
    r.registry.route(inbound('build it'));
    await vi.waitFor(() => {
      expect(r.activity[r.activity.length - 1]?.a?.retry).toBeDefined();
    }, WAIT);
    const retryTimer = r.scheduled.filter((s) => s.delay >= 120_000).at(-1)!;
    r.registry.route(inbound('/stop'));
    await vi.waitFor(() => {
      expect(retryTimer.cancelled).toBe(true);
    }, WAIT);
    expect(r.scheduled.filter((s) => s.delay >= 120_000 && !s.cancelled)).toEqual([]);
  });

  it('does nothing extra without a policy', async () => {
    const r = rig({ script: ['fail'] });
    live = r.registry;
    r.registry.route(inbound('build it'));
    await vi.waitFor(() => {
      expect(r.activity[r.activity.length - 1]?.a?.outcome).toMatchObject({ kind: 'failed', reason: 'service', line: 'upstream 503' });
    }, WAIT);
    expect(r.prompts.map((p) => p.prompt)).toEqual(['build it']);
    expect(r.activity[r.activity.length - 1]?.a?.outcome).toMatchObject({ kind: 'failed', reason: 'service', line: 'upstream 503' });
  });

  it('a refusal is a failure like any other: the reason reaches the topic and the continue', async () => {
    const r = rig({ continue: { on: ['limit'], message: '继续', max: 3, backoffMs: 1_000 }, script: ['refuse', 'ok'] });
    live = r.registry;
    r.registry.route(inbound('build it'));
    await vi.waitFor(() => {
      expect(r.activity[r.activity.length - 1]?.a?.outcome).toMatchObject({ kind: 'done', line: 'Done: all green.' });
    }, WAIT);

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
    await vi.waitFor(() => {
      expect(r.sent.some((m) => m.text.startsWith('↻ Not continuing again: 3 automatic continues'))).toBe(true);
    }, WAIT);

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
    // The name it gave the topic comes back with it: the card cannot read it off `channels` yet.
    expect(opened).toEqual({ key: 'web#main#new1', address: { channel: 'main', thread: 'new1' }, title: '[oc] 修一下 bump' });
    expect(r.nested).toEqual([{ name: expect.stringContaining('修一下 bump'), under: 'main/aaaaaaaa' }]);
    await vi.waitFor(() => {
      expect(r.prompts).toHaveLength(1);
    }, WAIT);
    expect(r.registry.boundAgentOf(opened.key)).toBe('oc');
    // The `↳ From …` header and the task text are a dispatch, so the web UI draws them as a
    // hand-off rather than as the agent's own words.
    expect(r.sent).toContainEqual({ to: 'main/new1', text: `${header}\n\n修一下 bump`, kind: 'dispatch' });
    expect(r.prompts).toEqual([{ conversation: 'web#main#new1', prompt: '修一下 bump' }]);
  });

  it('openTask answers the name it opened the topic with, --title included', async () => {
    const r = rig();
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'anything', header, title: '删掉 agy 旧运行时' });
    expect(opened.title).toBe('[oc] 删掉 agy 旧运行时');
    expect(r.nested).toEqual([{ name: '[oc] 删掉 agy 旧运行时', under: 'main/aaaaaaaa' }]);

    // The lane title, not the raw request: formatLaneTitle collapses whitespace and drops leading
    // bracketed groups, and the card has to say what the topic actually says — a `--title` with a
    // newline would otherwise split its row in two.
    const odd = await r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'x', header, title: 'a\nb' });
    expect(odd.title).toBe('[oc] a b');
  });

  it('openTask applies an explicit model before the first turn, and keeps it for the topic', async () => {
    const store = new ConversationStore(join(storeDir, 'applied.json'));
    const r = rig({ store });
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'go', header, model: 'fast-model' });
    await vi.waitFor(() => {
      expect(r.events.length).toBeGreaterThanOrEqual(2);
    }, WAIT);
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
    await vi.waitFor(() => {
      expect(r.prompts).toHaveLength(1);
    }, WAIT);
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
    await vi.waitFor(() => {
      expect(r.sent).toHaveLength(1);
    }, WAIT);
    expect(r.prompts).toEqual([]);
    expect(r.sent).toEqual([
      { to: 'main/new1', text: 'Not started — could not set model "runtime-fail": the harness refused this model.' },
    ]);
    expect(store.conversationChoice('web#main#new1', 'oc', 'model')).toBeUndefined();
  });

  it('openTask applies its settings after the model and before the first turn', async () => {
    const store = new ConversationStore(join(storeDir, 'options.json'));
    const r = rig({ store, settings: ACCOUNT });
    live = r.registry;
    const options = { account: 'alice@example.com', region: 'eu' };
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'go', header, model: 'fast-model', options });
    await vi.waitFor(() => {
      expect(r.events.length).toBeGreaterThanOrEqual(4);
    }, WAIT);
    expect(r.events.slice(0, 4)).toEqual(['model:fast-model', 'option:account=alice@example.com', 'option:region=eu', 'turn:go']);
    expect(store.conversationChoice(opened.key, 'oc', 'model')).toBe('fast-model');
  });

  it('openTask runs nothing when the agent refuses a setting, and the topic says why', async () => {
    const store = new ConversationStore(join(storeDir, 'option-refused.json'));
    const r = rig({ store, settings: ACCOUNT, optionFailure: 'bob@example.com' });
    live = r.registry;
    await expect(
      r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'go', header, model: 'fast-model', options: { account: 'bob@example.com' } })
    ).rejects.toThrow("could not set account=bob@example.com: that account's quota is used up");
    await vi.waitFor(() => {
      expect(r.sent).toHaveLength(1);
    }, WAIT);
    // Not started on the default account instead: no turn, and the model is not kept for a topic that never ran.
    expect(r.prompts).toEqual([]);
    expect(r.sent).toEqual([
      { to: 'main/new1', text: "Not started — could not set account=bob@example.com: that account's quota is used up." },
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

  it('openTask shows the child topic its own cwd and agent during its first running turn', async () => {
    const parentDir = join(storeDir, 'parent-repo');
    const childDir = join(storeDir, 'child-repo');
    mkdirSync(parentDir, { recursive: true });
    mkdirSync(childDir, { recursive: true });

    const store = new ConversationStore(join(storeDir, 'first-turn-cwd.json'));
    const topics = new TopicStore(join(storeDir, 'webui-topics.json'));
    const room = new WebRoom({ ...WebuiConfigSchema.parse({ type: 'webui', token: 't' }), id: 'web' }, topics);
    const webAdapter = {
      platform: 'web',
      capabilities: { thread: true, renameThread: true, editMessage: true, maxMessageLength: 20_000 },
      measureRendered: (s: string) => s.length,
      sendMessage: async (address: ConversationAddress, text: string) => {
        const msg = room.post(address.thread!, { own: false, html: text }, text);
        return { address, messageId: msg.id };
      },
      editMessage: async () => {},
      addReaction: async () => {},
      startTyping: async (address: ConversationAddress) => room.setTyping(address.thread!, true),
      stopTyping: async (address: ConversationAddress) => room.setTyping(address.thread!, false),
      createThread: async (_ref: unknown, name: string, o?: { under?: ConversationAddress }) => {
        const t = room.createTopic(name, o?.under?.thread);
        return { address: { channel: CHANNEL, thread: t.id } };
      },
      renameThread: async (address: ConversationAddress, name: string) => room.renameTopic(address.thread!, name),
      workbench: {
        useWorkdirLookup: (lookup: Parameters<WebRoom['useWorkdirLookup']>[0]) => room.useWorkdirLookup(lookup),
        refreshWorkdir: (address: ConversationAddress) => {
          if (address.thread) room.refreshWorkdir(address.thread);
        },
      },
    } as unknown as PlatformAdapter;

    const r = rig({ store, hold: true, platform: webAdapter, ccCwd: parentDir });
    live = r.registry;
    webAdapter.workbench?.useWorkdirLookup((ref) => r.registry.workdirForRef(ref));

    const parentTopic = room.createTopic('parent');
    const seen = new Map<string, Topic>();
    const detach = room.subscribe(parentTopic.id, (_id, ev: WebEvent) => {
      if (ev.t === 'sync' || ev.t === 'topics') {
        seen.clear();
        for (const t of ev.topics) seen.set(t.id, t);
      } else if (ev.t === 'topic-rows') {
        for (const row of ev.rows) seen.set(row.id, row);
      }
    });
    try {
      const opened = await r.registry.openTask({
        platform: 'web',
        parent: { channel: CHANNEL, thread: parentTopic.id },
        agentId: 'oc',
        cwd: childDir,
        text: 'work in child',
        header,
      });
      await vi.waitFor(() => {
        expect(r.prompts).toHaveLength(1);
      }, WAIT);
      const childId = opened.address.thread!;
      const row = room.topicList().find((t) => t.id === childId);
      expect(row?.dir?.path).toBe(childDir);
      expect(row?.agent?.id).toBe('oc');
      expect(seen.get(childId)?.dir?.path).toBe(childDir);
      expect(seen.get(childId)?.agent?.id).toBe('oc');
    } finally {
      detach();
      room.dispose();
    }
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
    await vi.waitFor(() => {
      expect(r.prompts).toHaveLength(1);
    }, WAIT);
    expect(r.registry.canSteer(opened.key)).toBe(false);
    await expect(r.registry.handTo(opened.key, 'web', opened.address, 'stop that', header)).resolves.toBe('queued');
    // A later task-send is the same dispatch as the first message.
    expect(r.sent.at(-1)).toEqual({ to: 'main/new1', text: `${header}\n\nstop that`, kind: 'dispatch' });
  });

  it('says joined only when the running harness really takes mid-turn input', async () => {
    const r = rig({ hold: true, steer: true });
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'cc', text: 'go', header });
    await vi.waitFor(() => {
      expect(r.prompts).toHaveLength(1);
    }, WAIT);
    expect(r.registry.canSteer(opened.key)).toBe(true);
    await expect(r.registry.handTo(opened.key, 'web', opened.address, 'also the docs', header)).resolves.toBe('joined');
    expect(r.sent.at(-1)).toEqual({ to: 'main/new1', text: `${header}\n\nalso the docs`, kind: 'dispatch' });
  });

  it('handTo --forward shows the reply as a report first, folded, and gives the agent the whole text', async () => {
    const r = rig();
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'go', header });
    await vi.waitFor(() => {
      expect(r.activity[r.activity.length - 1]?.a?.outcome?.kind).toBe('done');
    }, WAIT);
    const heading = '↳ Forwarded from "Review" · web:main/new1 · turn 1';
    await r.registry.handTo(opened.key, 'web', opened.address, 'fix it', header, {
      forward: { heading, text: 'Verdict: one fix.' },
    });
    await vi.waitFor(() => {
      expect(r.prompts).toHaveLength(2);
    }, WAIT);
    // A report bubble: line-based, so the page folds it to one row per line instead of a wall of
    // prose in the middle of the topic. Posted before the task that refers to it.
    const report = r.sent.findIndex((m) => m.kind === 'report');
    expect(r.sent[report]).toEqual({ to: 'main/new1', text: `${heading}\nVerdict: one fix.`, kind: 'report' });
    expect(r.sent[report + 1]).toEqual({ to: 'main/new1', text: `${header}\n\nfix it`, kind: 'dispatch' });
    // The agent gets it whole, under the same heading, in the one message it reads.
    expect(r.prompts.at(-1)!.prompt).toBe(`fix it\n\n${heading}\n\nVerdict: one fix.`);
  });

  it('a forward with no words of its own — the review loop’s — gives the agent the heading and the reply alone', async () => {
    const r = rig();
    live = r.registry;
    const loopHeader = '**↳ Automatic review, set up in [Release](?t=aaaaaaaa)**';
    const heading = '↳ Forwarded from "Review: part" · web:main/new2 · turn 1 · verdict: changes';
    // The first review is opened with its task and the work's reply together.
    const opened = await r.registry.openTask({
      platform: 'web',
      parent,
      agentId: 'oc',
      text: 'Review it.',
      header: loopHeader,
      forward: { heading, text: 'Built.' },
    });
    await vi.waitFor(() => {
      expect(r.activity[r.activity.length - 1]?.a?.outcome?.kind).toBe('done');
    }, WAIT);
    expect(r.prompts.at(-1)!.prompt).toBe(`Review it.\n\n${heading}\n\nBuilt.`);
    await r.registry.handTo(opened.key, 'web', opened.address, '', loopHeader, { forward: { heading, text: 'Rename the flag.' } });
    await vi.waitFor(() => {
      expect(r.prompts).toHaveLength(2);
    }, WAIT);
    // The topic shows the header alone above nothing; the agent reads the heading and the reply.
    expect(r.sent.filter((m) => m.kind === 'dispatch').at(-1)).toEqual({ to: 'main/new1', text: loopHeader, kind: 'dispatch' });
    expect(r.prompts.at(-1)!.prompt).toBe(`${heading}\n\nRename the flag.`);
    await expect(r.registry.handTo(opened.key, 'web', opened.address, '', loopHeader)).rejects.toThrow(/nothing to send/);
  });
});

describe('what a person writes reaches delegation (recordPersonWords)', () => {
  const header = '**↳ From [Release](?t=aaaaaaaa)**';
  const parent = { channel: 'main', thread: 'aaaaaaaa' };

  it('reports the person’s message as the agent read it, quoted line and all, and never a task the parent handed over', async () => {
    const words: Array<{ id: string; words: PersonWords }> = [];
    const r = rig({ onPersonWords: (id, w) => words.push({ id, words: w }) });
    live = r.registry;
    const opened = await r.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'the task', header });
    await vi.waitFor(() => {
      expect(r.activity[r.activity.length - 1]?.a?.outcome?.kind).toBe('done');
    }, WAIT);
    expect(words).toEqual([]);
    r.registry.route({ ...inbound('use sqlite instead', 'new1'), quotedContent: 'Which database?' });
    await vi.waitFor(() => {
      expect(r.prompts).toHaveLength(2);
      expect(words).toHaveLength(1);
    }, WAIT);
    expect(r.prompts.map((p) => p.prompt)).toEqual(['the task', '(replying to: "Which database?")\nuse sqlite instead']);
    expect(words).toEqual([
      { id: opened.key, words: { text: '(replying to: "Which database?")\nuse sqlite instead', attachments: [] } },
    ]);
  });

  it('reports a message the running turn took (joined) at once, and a queued one only when its turn starts', async () => {
    const joined: PersonWords[] = [];
    const a = rig({ hold: true, steer: true, onPersonWords: (_id, w) => joined.push(w) });
    live = a.registry;
    await a.registry.openTask({ platform: 'web', parent, agentId: 'cc', text: 'go', header });
    await vi.waitFor(() => {
      expect(a.prompts).toHaveLength(1);
    }, WAIT);
    a.registry.route(inbound('and keep it short', 'new1'));
    await vi.waitFor(() => {
      expect(joined).toHaveLength(1);
    }, WAIT);
    expect(joined.map((w) => w.text)).toEqual(['and keep it short']);
    a.registry.dispose();

    const queued: PersonWords[] = [];
    const b = rig({ hold: true, onPersonWords: (_id, w) => queued.push(w) });
    live = b.registry;
    await b.registry.openTask({ platform: 'web', parent, agentId: 'oc', text: 'go', header });
    await vi.waitFor(() => {
      expect(b.prompts).toHaveLength(1);
    }, WAIT);
    b.registry.route(inbound('and keep it short', 'new1'));
    await vi.waitFor(() => {
      expect(b.pendingQueue.at(-1)?.items.some((i) => i.content === 'and keep it short')).toBe(true);
    }, WAIT);
    // Waiting behind a turn that never ends here: nothing has reached the agent, so nothing is reported.
    expect(queued).toEqual([]);
  });
});

const ACCOUNT: SessionOption[] = [
  {
    id: 'account',
    name: 'Account',
    current: 'alice@example.com',
    options: [
      { value: 'alice@example.com', name: 'Alice' },
      { value: 'bob@example.com', name: 'Bob', description: 'quota used up' },
    ],
  },
  { id: 'region', name: 'Region', current: 'us', options: [{ value: 'us', name: 'US' }, { value: 'eu', name: 'EU' }] },
];

describe('scheduledChoicesProblem: a sub-task’s model and settings checked before the card', () => {
  it('checks --model and --option on one throwaway session, never the caller’s own', async () => {
    const r = rig({ settings: ACCOUNT });
    live = r.registry;
    r.registry.route(inbound('hello', 'own'));
    await vi.waitFor(() => {
      expect(r.prompts).toHaveLength(1);
      expect(r.registry.boundAgentOf('web#main#own')).toBe('cc');
    }, WAIT);
    const from = 'web#main#own';
    expect(r.registry.boundAgentOf(from)).toBe('cc');
    r.ensured.length = 0;
    // The caller is cc too, but a session that has run may list only the value it locked.
    expect(await r.registry.scheduledChoicesProblem('cc', { model: 'fast-model', options: { account: 'bob@example.com' } }, from)).toBeUndefined();
    expect(r.ensured).toHaveLength(1);
    expect(r.ensured[0]).toMatch(/^__schedule-model__#cc#/);
  });

  it('names what the agent does offer: its settings, or a setting’s choices with their notes', async () => {
    const r = rig({ settings: ACCOUNT });
    live = r.registry;
    // Every setting with its values, so one refusal is enough to propose again.
    expect(await r.registry.scheduledChoicesProblem('oc', { options: { acct: 'x' } }, undefined)).toBe(
      'agent "oc" has no setting "acct"; its settings: account (Account): alice@example.com, bob@example.com (quota used up); region (Region): us, eu'
    );
    expect(await r.registry.scheduledChoicesProblem('oc', { options: { account: 'carol@example.com' } }, undefined)).toBe(
      '"carol@example.com" is not a choice for account on agent "oc"; choose one of: alice@example.com, bob@example.com (quota used up)'
    );
    // The model is checked first, and its own refusal is unchanged.
    expect(await r.registry.scheduledChoicesProblem('oc', { model: 'nope', options: { acct: 'x' } }, undefined)).toBe(
      'unknown model "nope" for agent "oc"; choose one of: base-model, fast-model'
    );
  });

  it('refuses --option for an agent with no settings of its own', async () => {
    const r = rig();
    live = r.registry;
    expect(await r.registry.scheduledChoicesProblem('oc', { options: { account: 'a' } }, undefined)).toBe(
      'agent "oc" has no settings of its own, so --option cannot be used with it; drop --option to use the agent\'s defaults'
    );
  });
});

describe('agentLists and runningOn: one agent in full (task-agents <id>)', () => {
  it('reads a fresh session, never the conversation bound to that agent, and callers asking at once share it', async () => {
    const r = rig({ settings: ACCOUNT });
    live = r.registry;
    r.registry.route(inbound('hello', 'own'));
    await vi.waitFor(() => {
      expect(r.prompts).toHaveLength(1);
    }, WAIT);
    r.ensured.length = 0;
    const [a, b] = await Promise.all([r.registry.agentLists('cc'), r.registry.agentLists('cc')]);
    expect(a).toBe(b);
    expect(r.ensured).toHaveLength(1);
    expect(r.ensured[0]).toMatch(/^__schedule-model__#cc#/);
    expect(a.models?.current).toBe('base-model');
    expect(a.settings?.map((o) => o.id)).toEqual(['account', 'region']);
    // Done is done: the next call asks again rather than answering from a stale probe.
    await r.registry.agentLists('cc');
    expect(r.ensured).toHaveLength(2);
  });

  it('gives up on a session that never starts, and says so instead of hanging the command', async () => {
    const r = rig({ hangStart: true });
    live = r.registry;
    expect(await r.registry.agentLists('oc')).toEqual({ error: 'no answer in 45s' });
  });

  it('counts the turns in progress on an agent across conversations', async () => {
    const r = rig({ hold: true });
    live = r.registry;
    r.registry.route(inbound('one', 't1'));
    r.registry.route(inbound('two', 't2'));
    await vi.waitFor(() => {
      expect(r.registry.runningOn('cc')).toBe(2);
    }, WAIT);
    expect(r.registry.runningOn('cc')).toBe(2);
    expect(r.registry.runningOn('oc')).toBe(0);
  });
});
