import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import { EFFORT_OPTION_ID } from '../platform/workbench.js';
import type { AgentFactory, AgentSession } from './agent.js';
import { ConversationStore } from './conversation-store.js';
import type { ConversationId, InboundMessage } from '../types.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();
const registries: ConversationRegistry[] = [];

afterEach(() => {
  for (const r of registries.splice(0)) r.dispose();
});

const clock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/**
 * The web UI's effort switch, through the option picker: what a status line draws before the
 * agent starts (`peek`), the current model's levels (`list`), and a pick (`choose` under
 * EFFORT_OPTION_ID), which takes `/effort`'s path — its checks, its memory and its sentences.
 */

const REF = { platform: 'web', channel: 'main', kind: 'thread' as const, thread: 't1', user: 'u1' };

/** Levels per model, as a harness reports them; a model with none has no effort option at all. */
const LEVELS: Record<string, string[] | undefined> = {
  opus: ['default', 'low', 'high', 'max'],
  sonnet: ['low', 'medium'],
  haiku: undefined,
};

interface Fake {
  started: boolean;
  model: string;
  effort: string;
  sets: string[];
}

function rig(opts: { stored?: boolean; pin?: string } = {}) {
  const fakes = new Map<string, Fake>();
  const sessions = new Map<string, AgentSession>();
  const created: string[] = [];
  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (s) return s;
      created.push(conversationId);
      const f: Fake = { started: false, model: 'opus', effort: 'default', sets: [] };
      fakes.set(conversationId, f);
      const levels = (): string[] | undefined => (f.started ? LEVELS[f.model] : undefined);
      s = {
        conversationId,
        // As the runtime does once the session is up (AcpOptionState.reportSessionFacts): `default` reads as no level.
        runTurn: async (_input, handlers) => {
          f.started = true;
          handlers.onEffort?.(f.effort === 'default' ? undefined : f.effort);
        },
        abort: () => {},
        dispose: () => {},
        ensureSession: async () => {
          f.started = true;
        },
        sessionOptions: () => (f.started ? [] : undefined),
        modelSelector: () =>
          f.started ? { current: f.model, options: Object.keys(LEVELS).map((m) => ({ value: m, name: m })) } : undefined,
        setModel: async (value: string) => {
          f.model = value;
          const offered = LEVELS[value];
          if (offered && !offered.includes(f.effort)) f.effort = offered[0]!;
          return value;
        },
        effortSelector: () => {
          const offered = levels();
          return offered ? { id: 'effort', current: f.effort, options: offered.map((v) => ({ value: v, name: v })) } : undefined;
        },
        setEffort: async (value: string) => {
          f.sets.push(value);
          f.effort = value;
          return value;
        },
      } as AgentSession;
      sessions.set(conversationId, s);
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const parsed = parseConfig({
    platforms: { web: { type: 'webui', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude', ...(opts.pin ? { options: { effort: opts.pin } } : {}) }],
    routing: { default: 'cc', pipeline: [] },
  });
  const cfg = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
  const store = new ConversationStore(join(makeTempDir('aa-effort-switch-'), 'conversations.json'));
  const platform = {
    capabilities: { thread: true, editMessage: true, buttons: false, editButtons: false },
    sendMessage: async (address: unknown) => ({ address, messageId: 'm' }),
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;
  const registry = new ConversationRegistry(cfg, new Map([['web', platform]]), agents, clock, {}, store);
  registries.push(registry);
  const id = (registry as unknown as { idForRef(ref: typeof REF): ConversationId }).idForRef(REF);
  if (opts.stored) store.setAgentSession(id, 'cc', 'earlier-session');
  const own = () => fakes.get(id);
  return { registry, id, own, created, store };
}

describe('what the effort switch shows before the agent starts', () => {
  it('asks once, on a throwaway session, what a new conversation starts at', async () => {
    const r = rig();
    expect((await r.registry.optionStatusForRef(REF)).effort).toBe('default');
    expect(r.created).toEqual(['models:cc']);
    expect(r.own()).toBeUndefined();
    await r.registry.optionStatusForRef({ ...REF, thread: 't2' });
    expect(r.created).toEqual(['models:cc']);
  });

  it('gives a level pinned in agents[].options over what a fresh session reports', async () => {
    const r = rig({ pin: 'max' });
    expect((await r.registry.optionStatusForRef(REF)).effort).toBe('max');
  });

  it('gives the conversation’s own /effort, starting nothing', async () => {
    const r = rig({ stored: true });
    r.store.setConversationChoice(r.id, 'cc', 'effort', 'low');
    expect((await r.registry.optionStatusForRef(REF)).effort).toBe('low');
    expect(r.created).toEqual([]);
  });

  it('gives nothing for a conversation that has had a session and chose nothing: its next turn reports', async () => {
    const r = rig({ stored: true });
    expect((await r.registry.optionStatusForRef(REF)).effort).toBeUndefined();
    expect(r.created).toEqual([]);
  });

  it('gives the live session’s level, and nothing once its model has no levels', async () => {
    const r = rig();
    await r.registry.optionsForRef(REF);
    await r.registry.chooseOptionForRef(REF, EFFORT_OPTION_ID, 'high');
    expect((await r.registry.optionStatusForRef(REF)).effort).toBe('high');
    await r.registry.chooseModelForRef(REF, 'haiku');
    expect((await r.registry.optionStatusForRef(REF)).effort).toBeUndefined();
  });
});

describe('listing the levels', () => {
  it('starts a cold agent and lists the current model’s levels, though it has no settings of its own', async () => {
    const r = rig();
    const list = await r.registry.optionsForRef(REF);
    expect(r.own()?.started).toBe(true);
    expect(list).toMatchObject({
      ok: false,
      reason: 'none',
      effort: { current: 'default', options: LEVELS.opus!.map((v) => ({ value: v, name: v })) },
    });
    expect(r.registry.statusOf(r.id)?.effort).toBe('default');
  });

  it('lists none for a model without levels', async () => {
    const r = rig();
    await r.registry.optionsForRef(REF);
    await r.registry.chooseModelForRef(REF, 'haiku');
    expect((await r.registry.optionsForRef(REF)).effort).toBeUndefined();
  });
});

describe('choosing a level', () => {
  it('sets it as /effort does, remembers it for the conversation and shows it on the strip', async () => {
    const r = rig();
    await r.registry.optionsForRef(REF);
    const result = await r.registry.chooseOptionForRef(REF, EFFORT_OPTION_ID, 'max');
    expect(result).toEqual({
      ok: true,
      options: [],
      effort: 'max',
      text: 'Effort set to `max` for this conversation, from the next message.',
    });
    expect(r.own()?.sets).toEqual(['max']);
    expect(r.store.conversationChoice(r.id, 'cc', 'effort')).toBe('max');
    expect(r.registry.statusOf(r.id)?.effort).toBe('max');
  });

  it('refuses a level the current model no longer offers in /effort’s words, without asking the agent', async () => {
    const r = rig();
    await r.registry.optionsForRef(REF);
    await r.registry.chooseModelForRef(REF, 'sonnet');
    const result = await r.registry.chooseOptionForRef(REF, EFFORT_OPTION_ID, 'max');
    expect(result).toEqual({
      ok: false,
      text: "`max` is no longer offered — the model's levels changed. Run /effort again for the current list.",
    });
    expect(r.own()?.sets).toEqual([]);
  });

  it('says the conversation is gone when there is none', async () => {
    const r = rig();
    expect(await r.registry.chooseOptionForRef(REF, EFFORT_OPTION_ID, 'high')).toEqual({
      ok: false,
      text: 'That conversation is gone — send a message first, then /effort.',
    });
  });
});

describe('a model switch', () => {
  it('moves the strip to the new model’s level, or takes it off when the model has none', async () => {
    const r = rig();
    await r.registry.optionsForRef(REF);
    await r.registry.chooseModelForRef(REF, 'sonnet');
    expect(r.registry.statusOf(r.id)?.effort).toBe('low');
    await r.registry.chooseModelForRef(REF, 'haiku');
    expect(r.registry.statusOf(r.id)?.effort).toBeUndefined();
  });
});

describe('a turn on the model’s default level', () => {
  it('shows `default` on the strip, which the reply footer leaves out', async () => {
    const r = rig();
    r.registry.route({ conversation: REF, messageId: 'm1', content: 'hi', timestamp: 0, mentionedSelf: true } as unknown as InboundMessage);
    for (let i = 0; i < 50 && r.registry.statusOf(r.id)?.effort === undefined; i++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(r.registry.statusOf(r.id)?.effort).toBe('default');
  });
});
