import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Daemon } from './daemon.js';
import { parseConfig } from '../config/schema.js';
import type { SessionOptionList, SessionOptionResult, PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import { ConversationStore } from './conversation-store.js';
import type { AgentStatus, ConversationId, SessionOption, StatusOption } from '../types.js';

/**
 * The switch a platform draws for the agent's own settings (`useOptionPicker`), through the
 * registry: which to draw before anything has reported (`peek`), their choices (`list`, which
 * starts a cold agent as the model list does), and a pick (`choose`), which the agent may refuse.
 *
 * The case all of it exists for is a new conversation: before its first message is the one time a
 * setting like an account can still change, and no session has reported it yet.
 */

const REF = { platform: 'web', channel: 'main', kind: 'thread' as const, thread: 't1', user: 'u1' };

const ACCOUNTS: SessionOption = {
  id: 'account',
  name: 'Account',
  current: 'work',
  options: [
    { value: 'work', name: 'Work' },
    { value: 'home', name: 'Home', description: '5-hour limit used up' },
  ],
};

interface Fake {
  /** What the conversation's own session reports — undefined until it has started. */
  options?: SessionOption[];
  ensured: number;
  sets: string[];
  /** The agent's refusal, when it should refuse. */
  refuse?: string;
}

function rig(opts: { stored?: boolean } = {}) {
  const fakes = new Map<string, Fake>();
  const sessions = new Map<string, AgentSession>();
  const created: string[] = [];
  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        created.push(conversationId);
        const f: Fake = { ensured: 0, sets: [] };
        fakes.set(conversationId, f);
        s = {
          conversationId,
          runTurn: async () => {},
          abort: () => {},
          dispose: () => {},
          ensureSession: async () => {
            f.ensured++;
            f.options ??= [structuredClone(ACCOUNTS)];
          },
          sessionOptions: () => f.options,
          setOption: async (id: string, value: string) => {
            if (f.refuse) throw new Error(f.refuse);
            f.sets.push(`${id}=${value}`);
            f.options = f.options!.map((o) => (o.id === id ? { ...o, current: value } : o));
            return f.options;
          },
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const cfg = parseConfig({
    platforms: { web: { type: 'webui', token: 't' } },
    agents: [
      { id: 'browser', harness: 'custom', command: 'browser-agent', args: ['acp'] },
      { id: 'cc', harness: 'claude' },
    ],
    routing: { default: 'browser', pipeline: [] },
  });
  const store = new ConversationStore(join(mkdtempSync(join(tmpdir(), 'aa-option-picker-')), 'conversations.json'));
  const platform = {
    platform: 'web',
    platformType: 'webui',
    capabilities: { thread: true, editMessage: true, reaction: false, reply: true, slashCommands: true, typing: true, maxMessageLength: 100000 },
    sendMessage: async (address: unknown) => ({ address, messageId: 'm' }),
  } as unknown as PlatformAdapter;
  const daemon = new Daemon(cfg, new Map([['web', platform]]), agents, '/tmp/aa-option-picker-test.sock', store);
  const registry = (daemon as unknown as {
    registry: {
      idForRef(ref: typeof REF): ConversationId;
      statusOf(id: ConversationId): AgentStatus | undefined;
      optionStatusForRef(ref: typeof REF): Promise<{ agent: string; options: StatusOption[] }>;
      optionsForRef(ref: typeof REF): Promise<SessionOptionList>;
      chooseOptionForRef(ref: typeof REF, id: string, value: string): Promise<SessionOptionResult>;
    };
  }).registry;
  const id = registry.idForRef(REF);
  if (opts.stored) store.setAgentSession(id, 'browser', 'earlier-session');
  const own = () => fakes.get(id);
  return { registry, id, own, fakes, created };
}

describe('listing a conversation’s settings', () => {
  it('starts a new conversation’s session first, as the model list does, and lists what it reports', async () => {
    const r = rig();
    const list = await r.registry.optionsForRef(REF);
    expect(r.own()?.ensured).toBe(1);
    expect(list).toEqual({ ok: true, agent: 'browser', options: [ACCOUNTS] });
    // And the strip hears it now, not at the first turn.
    expect(r.registry.statusOf(r.id)?.options).toEqual([{ id: 'account', name: 'Account', value: 'Work' }]);
  });

  it('says so for an agent with no settings of its own', async () => {
    const r = rig();
    const first = await r.registry.optionsForRef(REF);
    expect(first.ok).toBe(true);
    // The session is up and reports an empty set: warming it again cannot change that.
    r.own()!.options = [];
    const none = await r.registry.optionsForRef(REF);
    expect(none).toEqual({ ok: false, agent: 'browser', reason: 'none', text: 'browser has no settings of its own to change.' });
  });
});

describe('choosing one', () => {
  it('sets it through the session and reports what the agent says afterwards', async () => {
    const r = rig();
    await r.registry.optionsForRef(REF);
    const result = await r.registry.chooseOptionForRef(REF, 'account', 'home');
    expect(result).toEqual({
      ok: true,
      options: [{ ...ACCOUNTS, current: 'home' }],
      text: 'Account set to Home for this conversation.',
    });
    expect(r.own()?.sets).toEqual(['account=home']);
    expect(r.registry.statusOf(r.id)?.options).toEqual([
      { id: 'account', name: 'Account', value: 'Home', note: '5-hour limit used up' },
    ]);
  });

  it('hands the agent’s refusal back in its own words', async () => {
    const r = rig();
    await r.registry.optionsForRef(REF);
    r.own()!.refuse = 'This conversation already started on work; its account cannot change.';
    const result = await r.registry.chooseOptionForRef(REF, 'account', 'home');
    expect(result).toEqual({ ok: false, text: 'This conversation already started on work; its account cannot change.' });
  });

  it('refuses a value or a setting the agent does not list, without asking it', async () => {
    const r = rig();
    await r.registry.optionsForRef(REF);
    expect(await r.registry.chooseOptionForRef(REF, 'account', 'nowhere')).toEqual({
      ok: false,
      text: 'Account: "nowhere" is no longer offered.',
    });
    expect(await r.registry.chooseOptionForRef(REF, 'region', 'eu')).toEqual({ ok: false, text: 'browser no longer offers that setting.' });
    expect(r.own()?.sets).toEqual([]);
  });

  it('cannot set anything on a conversation that does not exist', async () => {
    const r = rig();
    expect(await r.registry.chooseOptionForRef(REF, 'account', 'home')).toEqual({
      ok: false,
      text: 'That conversation is gone — send a message first.',
    });
  });
});

describe('what a status line draws before anything has reported', () => {
  it('asks the agent once, on a throwaway session, for a new conversation — including default value', async () => {
    const r = rig();
    const peek = await r.registry.optionStatusForRef(REF);
    expect(peek).toEqual({ agent: 'browser', options: [{ id: 'account', name: 'Account', value: 'Work' }] });
    // Not this conversation's session: that would bind the topic before its first message.
    expect(r.created).toEqual(['models:browser']);
    expect(r.own()).toBeUndefined();
    // Known from then on, for this agent.
    await r.registry.optionStatusForRef(REF);
    expect(r.created).toEqual(['models:browser']);
  });

  it('gives the conversation’s own session’s values once it has one', async () => {
    const r = rig();
    await r.registry.optionsForRef(REF);
    await r.registry.chooseOptionForRef(REF, 'account', 'home');
    expect(await r.registry.optionStatusForRef(REF)).toEqual({
      agent: 'browser',
      options: [{ id: 'account', name: 'Account', value: 'Home', note: '5-hour limit used up' }],
    });
  });

  it('marks a setting with a single choice as fixed', async () => {
    const r = rig();
    await r.registry.optionsForRef(REF);
    r.own()!.options = [{ ...ACCOUNTS, options: [ACCOUNTS.options[0]!] }];
    expect((await r.registry.optionStatusForRef(REF)).options).toEqual([{ id: 'account', name: 'Account', value: 'Work', fixed: true }]);
  });

  it('starts nothing for a conversation that has had a session: its next turn reports', async () => {
    const r = rig({ stored: true });
    expect(await r.registry.optionStatusForRef(REF)).toEqual({ agent: 'browser', options: [] });
    expect(r.created).toEqual([]);
  });
});
