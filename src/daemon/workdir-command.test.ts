import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRegistry, REMOTE_LISTING_WAIT_MS } from './conversation.js';
import { remoteHosts } from './remote-hosts.js';
import type { RemoteHost } from '../remote/host.js';
import { ConversationStore } from './conversation-store.js';
import { WorkdirUsageStore } from './workdir-usage.js';
import { resolveConversationCwd } from './agent-common.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ConversationId, InboundMessage } from '../types.js';
import type { WorkdirOption } from '../core/workdir-menu.js';

/**
 * Choosing the directory a conversation works in.
 *
 * Two behaviours are being pinned here, and the second is the subtle one:
 *
 * 1. WHEN the question is asked. A conversation that has never run gets the directory menu from a
 *    bare agent command, because that is the moment the answer is free. One already under way gets
 *    the harness command list it always got — and "under way" is read off the STORE, so an
 *    idle-reclaimed conversation (child gone, session id kept) is NOT asked to re-pick. That case
 *    is the whole reason the predicate is not "is a child running".
 *
 * 2. What a move COSTS. A session is pinned to the directory it started in, so moving drops every
 *    agent's session id and the resident child. Re-picking the directory already in use must cost
 *    nothing at all — the menu marks it with ●, so tapping it is how a user dismisses the menu.
 *
 * The agent commands are exercised across all three harness shapes (`/cc` ACP + picker, `/oc` ACP +
 * picker, `/agy` no picker), because the directory is a property of the conversation and none of
 * this may depend on which runtime is bound.
 */

const root = mkdtempSync(join(tmpdir(), 'workdir-cmd-'));
for (const name of ['quantlab', 'gateway', 'uniagent']) mkdirSync(join(root, name));
const QUANTLAB = join(root, 'quantlab');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const parsed = parseConfig({
  platforms: { discord: { type: 'discord', token: 't' } },
  agents: [
    { id: 'cc', harness: 'claude', cwd: root },
    { id: 'oc', harness: 'opencode', cwd: root },
    { id: 'agy', harness: 'agy', cwd: root },
  ],
  routing: {
    default: 'cc',
    pipeline: [
      { when: { command: 'cc' }, use: { agent: 'cc' } },
      { when: { command: 'oc' }, use: { agent: 'oc' } },
      { when: { command: 'agy' }, use: { agent: 'agy' } },
    ],
  },
});
const cfg: Config = {
  ...parsed,
  inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 },
};

const clock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

interface WorkdirMenuCall {
  id: ConversationId;
  agentId: string;
  options: WorkdirOption[];
  current: string;
}

function rig(opts: { buttons?: boolean; usage?: WorkdirUsageStore; config?: Config; clock?: typeof clock } = {}) {
  const buttons = opts.buttons ?? true;
  const sent: string[] = [];
  const prompts: string[] = [];
  const disposed: string[] = [];
  const menus: WorkdirMenuCall[] = [];
  const pickers: string[] = [];
  const sessions = new Map<string, AgentSession>();

  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input) => void prompts.push(input.prompt),
          abort: () => {},
          dispose: () => {},
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => {
      disposed.push(id);
      sessions.delete(id);
    },
  };

  const platform = {
    capabilities: { thread: false, editMessage: true, buttons, editButtons: buttons },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: 'm1' };
    },
    sendButtons: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: 'm1' };
    },
    editMessage: async () => {},
    editButtons: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const file = join(mkdtempSync(join(tmpdir(), 'workdir-store-')), 'conversations.json');
  const store = new ConversationStore(file);
  const usage = opts.usage;
  const reg = new ConversationRegistry(
    opts.config ?? cfg,
    new Map([['discord', platform]]),
    factory,
    opts.clock ?? clock,
    {
      onPickerRequest: (_id, agentId) => void pickers.push(agentId),
      onWorkdirMenuRequest: (id, agentId, _msg, menu) =>
        void menus.push({ id, agentId, options: menu.options, current: menu.current }),
    },
    store,
    usage
  );

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
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  const key = 'discord#c1#'; // per_thread scope on a DM with no thread
  return { reg, send, replies, prompts, disposed, menus, pickers, store, key, factory };
}

describe('when the directory question is asked', () => {
  it('offers the menu on a bare agent command in a conversation that has never run', async () => {
    const { send, menus, pickers } = rig();
    await send('/cc');
    expect(menus).toHaveLength(1);
    expect(menus[0]!.agentId).toBe('cc');
    // The root leads, then the projects alphabetically.
    expect(menus[0]!.options.map((o) => o.name)).toEqual([
      menus[0]!.options[0]!.name,
      'gateway',
      'quantlab',
      'uniagent',
    ]);
    expect(menus[0]!.options[0]).toMatchObject({ path: root, root: true });
    expect(menus[0]!.current).toBe(root);
    // The command list is NOT also posted: one question at a time.
    expect(pickers).toEqual([]);
  });

  it('offers it for a harness with no command list of its own (agy) too', async () => {
    const { send, menus, replies } = rig();
    await send('/agy');
    expect(menus).toHaveLength(1);
    expect(menus[0]!.agentId).toBe('agy');
    // Not the plain binding ack it would otherwise have sent.
    expect(replies().join('')).not.toContain('is now answered by');
  });

  it('falls back to the command list once the agent has a session here', async () => {
    const { send, menus, pickers, store, key } = rig();
    await send('/cc hello'); // a turn, after which the runtime records its session id
    store.setAgentSession(key, 'cc', 'acp-session-1');

    await send('/cc');
    expect(menus).toHaveLength(0);
    expect(pickers).toEqual(['cc']);
  });

  // The case the store-based predicate exists for: an idle sweep stops the child but keeps the
  // session id, and the next message resumes it. Asking that user to re-pick a directory would
  // destroy the very context the reclaim was careful to preserve.
  it('still falls back to the command list after an idle reclaim killed the child', async () => {
    const { send, menus, pickers, store, key, factory } = rig();
    await send('/cc hello');
    store.setAgentSession(key, 'cc', 'acp-session-1');
    // What the sweeper does: the child goes, the conversation and its session id stay.
    factory.dispose(key);

    await send('/cc');
    expect(menus).toHaveLength(0);
    expect(pickers).toEqual(['cc']);
  });

  it('asks again after /new, which is the other moment the answer is free', async () => {
    const { send, menus, replies } = rig();
    await send('/cc hello');
    await send('/new');
    expect(replies().at(-1)).toContain('Context cleared');
    expect(menus).toHaveLength(1);
  });

  it('never interrupts a command that carries a prompt', async () => {
    const { send, menus, prompts } = rig();
    await send('/cc look at this');
    expect(prompts).toEqual(['look at this']);
    expect(menus).toHaveLength(0);
  });

  it('answers with text where buttons cannot be posted', async () => {
    const { send, menus, replies } = rig({ buttons: false });
    await send('/cd');
    expect(menus).toHaveLength(0);
    expect(replies().at(-1)).toContain('Working dir:');
    expect(replies().at(-1)).toContain('/cd quantlab');
  });
});

describe('moving a conversation', () => {
  it('records the directory, drops every session id, and stops the child', async () => {
    const { send, replies, disposed, store, key } = rig();
    await send('/cc hello');
    store.setAgentSession(key, 'cc', 'acp-1');
    store.setAgentSession(key, 'oc', 'oc-1');
    disposed.length = 0;

    await send('/cd quantlab');
    expect(store.conversationCwd(key)).toBe(QUANTLAB);
    // Every agent's, not just the bound one's: the directory belongs to the conversation.
    expect(store.agentSession(key, 'cc')).toBeUndefined();
    expect(store.agentSession(key, 'oc')).toBeUndefined();
    expect(disposed).toEqual([key]);
    expect(replies().at(-1)).toContain('fresh session');
  });

  it('is what the runtimes will read at spawn', async () => {
    const { reg, send, key } = rig();
    await send('/cd quantlab');
    // workdirOf is the same call the runtime makes (resolveConversationCwd), so this is the
    // directory the next child actually starts in — and what the footer reports.
    expect(reg.workdirOf(key, 'cc')).toBe(QUANTLAB);
    // …for every agent that answers here, not only the one bound when the move was made.
    expect(reg.workdirOf(key, 'oc')).toBe(QUANTLAB);
  });

  it('costs nothing when the directory picked is the one already in use', async () => {
    const { send, replies, disposed, store, key } = rig();
    await send('/cd quantlab');
    store.setAgentSession(key, 'cc', 'acp-2');
    disposed.length = 0;

    await send('/cd quantlab');
    expect(replies().at(-1)).toContain('nothing reset');
    expect(disposed).toEqual([]);
    expect(store.agentSession(key, 'cc')).toBe('acp-2');
  });

  it('clears the override when the root is chosen, so config can still move it later', async () => {
    const { send, store, key } = rig();
    await send('/cd quantlab');
    expect(store.conversationCwd(key)).toBe(QUANTLAB);
    await send(`/cd ${root}`);
    expect(store.conversationCwd(key)).toBeUndefined();
  });

  it('refuses to guess between two matches, and changes nothing', async () => {
    const { send, replies, store, key } = rig();
    await send('/cd a'); // matches gateway and quantlab (both contain "a")
    expect(replies().at(-1)).toContain('matches');
    expect(store.conversationCwd(key)).toBeUndefined();
  });

  it('says so when nothing matches', async () => {
    const { send, replies, store, key } = rig();
    await send('/cd nowhere-at-all');
    expect(replies().at(-1)).toContain('No directory matches');
    expect(store.conversationCwd(key)).toBeUndefined();
  });

  it('survives /new: a reset clears the context, not the place it happens in', async () => {
    const { send, store, key } = rig();
    await send('/cd quantlab');
    await send('/new');
    expect(store.conversationCwd(key)).toBe(QUANTLAB);
  });

  it('never reaches the agent as a prompt', async () => {
    const { send, prompts } = rig();
    await send('/cd');
    await send('/cd quantlab');
    expect(prompts).toEqual([]);
  });
});

/**
 * The order the directories come back in.
 *
 * Alphabetical is the ordering guaranteed to ignore what the user does, and on a phone that meant
 * paging to reach the project you reach every day. These pin the two halves of the fix: uses are
 * counted where a move actually happened, and the menu leads with what has been used — while the
 * root keeps the first slot, because it is the way OUT of a project rather than one of them.
 */
describe('ordering by use', () => {
  const usageStore = (): WorkdirUsageStore =>
    new WorkdirUsageStore(join(mkdtempSync(join(tmpdir(), 'workdir-usage-')), 'usage.json'));

  it('stays alphabetical for a machine with no history', async () => {
    const { send, menus } = rig({ usage: usageStore() });
    await send('/cc');
    expect(menus[0]!.options.map((o) => o.name)).toEqual([
      menus[0]!.options[0]!.name,
      'gateway',
      'quantlab',
      'uniagent',
    ]);
  });

  it('leads with the directory that has been used, root still first', async () => {
    const usage = usageStore();
    const { send, menus } = rig({ usage });
    // uniagent sorts last alphabetically; using it should bring it to the top of the projects.
    await send('/cd uniagent');
    await send('/new');
    expect(menus).toHaveLength(1);
    const names = menus[0]!.options.map((o) => o.name);
    expect(names[0]).toBe(menus[0]!.options[0]!.name);
    expect(menus[0]!.options[0]!.root).toBe(true);
    expect(names.slice(1)).toEqual(['uniagent', 'gateway', 'quantlab']);
  });

  it('carries the history across daemon restarts, into a conversation that never chose anything', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'workdir-usage-')), 'usage.json');
    const first = rig({ usage: new WorkdirUsageStore(file) });
    await first.send('/cd uniagent');

    // A different registry, a different store instance, reading the same file: what a restart is.
    const { send, menus } = rig({ usage: new WorkdirUsageStore(file) });
    await send('/cc');
    expect(menus[0]!.options.map((o) => o.name).slice(1)).toEqual([
      'uniagent',
      'gateway',
      'quantlab',
    ]);
  });

  it('does not count re-picking the directory already in use (that is how a menu is dismissed)', async () => {
    const usage = usageStore();
    const { send } = rig({ usage });
    await send('/cd quantlab');
    const after = usage.stat(QUANTLAB)!;
    await send('/cd quantlab'); // `unchanged`: nothing moved, nothing reset
    expect(usage.stat(QUANTLAB)).toEqual(after);
  });

  it('does not count a directory that turned out not to exist', async () => {
    const usage = usageStore();
    const { reg, send, key } = rig({ usage });
    await send('/cc');
    const gone = join(root, 'deleted-since-the-menu-was-drawn');
    expect(reg.applyWorkdirChoice(key, 'cc', gone)).toEqual({ kind: 'missing', path: gone });
    expect(usage.stat(gone)).toBeUndefined();
  });

  it('orders the text list the same way, so both surfaces agree', async () => {
    const usage = usageStore();
    const withButtons = rig({ usage });
    await withButtons.send('/cd uniagent');

    const { send, replies } = rig({ buttons: false, usage });
    await send('/cd');
    const text = replies().at(-1)!;
    expect(text.indexOf('/cd uniagent')).toBeLessThan(text.indexOf('/cd gateway'));
  });
});

describe('applying a click', () => {  it('moves the conversation the menu was opened for', async () => {
    const { reg, send, store, key } = rig();
    await send('/cc');
    expect(reg.applyWorkdirChoice(key, 'cc', QUANTLAB)).toEqual({
      kind: 'applied',
      path: QUANTLAB,
    });
    expect(store.conversationCwd(key)).toBe(QUANTLAB);
  });

  it('refuses when another agent has taken over since the menu was posted', async () => {
    const { reg, send, key } = rig();
    await send('/cc');
    await send('/oc'); // rebind
    const result = reg.applyWorkdirChoice(key, 'cc', QUANTLAB);
    expect(result.kind).toBe('rebound');
  });

  it('reports a directory that disappeared between the menu and the tap', async () => {
    const { reg, send, key } = rig();
    await send('/cc');
    const result = reg.applyWorkdirChoice(key, 'cc', join(root, 'deleted-since'));
    expect(result).toEqual({ kind: 'missing', path: join(root, 'deleted-since') });
  });
});

/**
 * The other end of the wire: what agent-acp calls at spawn to decide where to put the child.
 * Tested directly because the runtime itself can only be exercised by launching a harness — and
 * this one function is the whole of what `/cd` changes about it.
 */
describe('resolveConversationCwd (read by the runtime at spawn)', () => {
  const def = cfg.agents.find((a) => a.id === 'cc')!;
  const file = () => join(mkdtempSync(join(tmpdir(), 'workdir-resolve-')), 'conversations.json');

  it('falls back to the agent root when the conversation has chosen nothing', () => {
    expect(resolveConversationCwd(def, 'k', new ConversationStore(file()))).toBe(root);
    // …and with no store at all (a deployment or test that runs without one).
    expect(resolveConversationCwd(def, 'k')).toBe(root);
  });

  it('honours the recorded directory', () => {
    const store = new ConversationStore(file());
    store.setConversationCwd('k', 'cc', QUANTLAB);
    expect(resolveConversationCwd(def, 'k', store)).toBe(QUANTLAB);
  });

  // A spawn that died on a missing cwd would strand the conversation with an error nobody can act
  // on from a phone; the agent's own workspace is still a place it can answer from.
  it('falls back to the root when the recorded directory has since been deleted', () => {
    const store = new ConversationStore(file());
    store.setConversationCwd('k', 'cc', join(root, 'deleted-since'));
    expect(resolveConversationCwd(def, 'k', store)).toBe(root);
  });
});

/**
 * `workdirForRef` — the lookup handed to a platform that can SHOW where a conversation works
 * (`PlatformAdapter.useWorkdirLookup`, implemented only by the web UI's topic list).
 *
 * The reason it exists rather than the platform forming a key itself: the key depends on the
 * session scope and on the alias table, and a platform that guessed would be right about the
 * default scope and quietly wrong about the rest.
 */
describe('workdirForRef (what a platform is told to display)', () => {
  const ref = (over: Partial<Parameters<ConversationRegistry['workdirForRef']>[0]> = {}) => ({
    platform: 'discord',
    channel: 'c1',
    kind: 'direct' as const,
    user: 'u1',
    ...over,
  });

  it('answers the agent root for a conversation that has never chosen one', () => {
    const { reg } = rig();
    expect(reg.workdirForRef(ref())).toEqual({ path: root });
  });

  it('follows a /cd, so the label a page shows is the directory the child will start in', () => {
    const { reg, send } = rig();
    return send('/cd quantlab').then(() => {
      expect(reg.workdirForRef(ref())?.path).toBe(QUANTLAB);
      // The same answer the runtimes read at spawn, by construction — one resolver, not two.
      expect(reg.workdirForRef(ref())?.path).toBe(reg.workdirOf('discord#c1#', 'cc'));
    });
  });

  it('separates lanes, because under the default scope they are separate conversations', async () => {
    const { reg, send } = rig();
    await send('/cd quantlab');
    // Same channel, a lane of its own: it has chosen nothing and must not inherit the move.
    expect(reg.workdirForRef(ref({ thread: 't7' }))?.path).toBe(root);
    expect(reg.workdirForRef(ref())?.path).toBe(QUANTLAB);
  });

  it('answers for an address nothing has ever been said at', () => {
    // Every topic in the switcher after a restart, and most of them at any time: the list is
    // rendered for conversations with no in-memory state, and a blank second line for all of
    // them would make the feature look broken rather than empty.
    const { reg } = rig();
    expect(reg.workdirForRef(ref({ channel: 'never-used', thread: 'nor-this' }))?.path).toBe(root);
  });

  it('names the machine an agent on a host works on: its group, else its host', () => {
    // Two agy agents on two hosts with the same home layout: the path is the same string on both,
    // so the machine is the only part of the answer that tells their topics apart.
    const remote = parseConfig({
      platforms: { discord: { type: 'discord', token: 't' } },
      hosts: { box: { ssh: 'u@box' }, aws: { ssh: 'u@aws' } },
      agents: [
        { id: 'ag', harness: 'agy', host: 'box', cwd: '/home/u/workspace' },
        { id: 'ag2', harness: 'agy', host: 'aws', group: 'sydney', cwd: '/home/u/workspace' },
        { id: 'cc', harness: 'claude', cwd: root },
      ],
      routing: {
        default: 'ag',
        pipeline: [
          { when: { command: 'ag2' }, use: { agent: 'ag2' } },
          { when: { command: 'cc' }, use: { agent: 'cc' } },
        ],
      },
    });
    const { reg, send } = rig({ config: { ...remote, inbound: { ...remote.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } } });
    expect(reg.workdirForRef(ref())).toEqual({ path: '/home/u/workspace', host: 'box' });
    // `group` wins, because it is the name the `/agent` menu already shows for that machine.
    return send('/ag2').then(async () => {
      expect(reg.workdirForRef(ref())).toEqual({ path: '/home/u/workspace', host: 'sydney' });
      // And an agent on the gateway's own machine has no machine to name.
      await send('/cc');
      expect(reg.workdirForRef(ref())).toEqual({ path: root });
    });
  });
});

/**
 * `agentCatalogForRef` — the lookup the web UI's empty topic lays out as a choice of agent
 * (`PlatformAdapter.useAgentCatalog`). What it pins is when the question is still open: until the
 * agent a first message would reach has a session here, since chooseAgent refuses to move one.
 */
describe('agentCatalogForRef (what a new topic offers)', () => {
  const ref = { platform: 'discord', channel: 'c1', kind: 'direct' as const, user: 'u1' };

  it('offers every agent, grouped, with the route default as the one that answers', () => {
    const { reg } = rig();
    expect(reg.agentCatalogForRef(ref)).toEqual({
      current: 'cc',
      groups: [
        {
          name: 'this machine',
          agents: [
            { id: 'cc', harness: 'claude', kind: 'Claude Code' },
            { id: 'oc', harness: 'opencode', kind: 'OpenCode' },
            { id: 'agy', harness: 'agy', kind: 'Antigravity' },
          ],
        },
      ],
    });
  });

  it('follows a binding made before the first turn, and is still open there', async () => {
    const { reg, send } = rig();
    await send('/agent oc');
    expect(reg.agentCatalogForRef(ref)?.current).toBe('oc');
  });

  it('closes once the answering agent has a session here', async () => {
    const { reg, send, store, key } = rig();
    await send('hello');
    store.setAgentSession(key, 'cc', 'acp-session-1');
    expect(reg.agentCatalogForRef(ref)).toBeUndefined();
    // Another lane of the same channel is another conversation, still open.
    expect(reg.agentCatalogForRef({ ...ref, thread: 't7' })?.current).toBe('cc');
  });

  it('is never offered with a single agent: a choice of one is not a choice', () => {
    const one = parseConfig({
      platforms: { discord: { type: 'discord', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude', cwd: root }],
      routing: { default: 'cc' },
    });
    const { reg } = rig({ config: one });
    expect(reg.agentCatalogForRef(ref)).toBeUndefined();
  });

  it('names as default the agent a channel rule routes to, not routing.default', () => {
    const ruled = parseConfig({
      platforms: { discord: { type: 'discord', token: 't' } },
      agents: [
        { id: 'cc', harness: 'claude', cwd: root },
        { id: 'oc', harness: 'opencode', cwd: root },
      ],
      routing: { default: 'cc', pipeline: [{ when: { platform: 'discord' }, use: { agent: 'oc' } }] },
    });
    const { reg } = rig({ config: ruled });
    expect(reg.agentCatalogForRef(ref)?.current).toBe('oc');
  });
});

/**
 * An agent on a host (talkcode 2.9.0): its directories can only be listed over the link, which is
 * asynchronous, while the menu decides on the spot. Until 2.9.2 the menus on the side read ahead and
 * declined when nothing was listed yet — and the list lives in the process, so after every restart
 * a host's first new conversation got Claude's command list for `/cc` instead of the directory menu
 * (2026-10-29, the first day every agent ran on a host).
 */
describe('the directory question for an agent on a host', () => {
  const remoteCfg = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    hosts: { box: { ssh: 'u@box' } },
    agents: [
      { id: 'rc', harness: 'claude', host: 'box', cwd: '/srv/work' },
      { id: 'ro', harness: 'opencode', host: 'box', cwd: '/srv/work' },
      { id: 'rg', harness: 'agy', host: 'box', cwd: '/srv/other' },
    ],
    routing: { default: 'rc' },
  });
  const config: Config = { ...remoteCfg, inbound: { ...remoteCfg.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

  let listDir: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    listDir = vi.fn(async () => [
      { name: 'proj', dir: true },
      { name: 'notes.txt', dir: false },
    ]);
    const host = { conn: { welcome: { home: '/home/u' } }, ready: async () => ({}), listDir } as unknown as RemoteHost;
    vi.spyOn(remoteHosts, 'hostFor').mockImplementation((def) => (def?.host ? host : undefined));
  });
  afterEach(() => vi.restoreAllMocks());

  it('waits for the first listing instead of answering a bare /cc with the command list', async () => {
    const { send, menus, pickers } = rig({ config });
    await send('/cc');
    expect(listDir).toHaveBeenCalledWith('/srv/work', 15_000);
    expect(pickers).toEqual([]);
    expect(menus).toHaveLength(1);
    expect(menus[0]!.agentId).toBe('rc');
    expect(menus[0]!.options.map((o) => o.path)).toEqual(['/srv/work', '/srv/work/proj']);
  });

  it('reads every remote root ahead when asked to warm up, once per host and directory', async () => {
    const { reg, send, menus } = rig({ config });
    reg.warmRemoteScans();
    await drain();
    // rc and ro share /srv/work on box; rg has a root of its own.
    expect(listDir.mock.calls.map((c) => c[0]).sort()).toEqual(['/srv/other', '/srv/work']);

    await send('/cc');
    expect(menus).toHaveLength(1);
    // Offered from what was read, and read again behind it so a new project shows up next time.
    expect(listDir).toHaveBeenCalledTimes(3);
  });

  it('answers the way it would without a list when the host does not answer in time', async () => {
    listDir.mockImplementation(() => new Promise(() => {}));
    // The same clock, with the listing wait cut short so the test does not sit through it.
    const quick = { ...clock, schedule: (fn: () => void, ms: number) => clock.schedule(fn, ms === REMOTE_LISTING_WAIT_MS ? 1 : ms) };
    const { send, menus, pickers } = rig({ config, clock: quick });
    await send('/cc');
    expect(menus).toHaveLength(0);
    expect(pickers).toEqual(['rc']);
  });

  it('reads a listing that failed again before answering, rather than answering from the failure', async () => {
    // 2.11.1: the reread behind the menu fixed only the next `/cc`, so this one got the command list.
    const { reg, send, menus, pickers } = rig({ config });
    listDir.mockRejectedValueOnce(new Error('talkcode-remote on host "box" restarted'));
    reg.warmRemoteScans();
    await drain();
    expect(listDir.mock.calls[0]![0]).toBe('/srv/work');

    await send('/cc');
    expect(pickers).toEqual([]);
    expect(menus).toHaveLength(1);
    expect(menus[0]!.options.map((o) => o.path)).toEqual(['/srv/work', '/srv/work/proj']);
  });

  it('waits after /new too', async () => {
    const { send, menus, replies } = rig({ config });
    await send('/cc hello');
    await send('/new');
    expect(replies().at(-1)).toContain('Context cleared');
    expect(menus).toHaveLength(1);
    expect(menus[0]!.options.map((o) => o.name)).toContain('proj');
  });
});
