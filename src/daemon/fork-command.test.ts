import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { ConversationStore } from './conversation-store.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import { ForkRefused, type AgentFactory, type AgentSession } from './agent.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { HistoryStore } from '../history/store.js';
import type { InboundMessage } from '../types.js';

/**
 * `/fork` in route(): the gateway's half — what is refused and how, what the new topic is set up with,
 * and that nothing reaches an agent but the runtime's own fork. What the runtime does with the fork
 * is pinned in agent-acp-fork.test.ts.
 */

function config(): Config {
  const parsed = parseConfig({
    platforms: { web: { type: 'webui', token: 't' }, discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude', model: 'sonnet' }],
    routing: { default: 'cc' },
  });
  return { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 }, stream: { ...parsed.stream, enabled: false } };
}

const drain = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface RigOpts {
  /** What the source's runtime says about fork support; undefined until "started". */
  canFork?: boolean | 'after-start';
  /** What the fork's runtime does when asked to start as a copy. */
  forkFrom?: (input: { sessionId: string }) => Promise<void>;
  /** The source's last turn number, as the library reports it (a function, so a test can move it). */
  turn?: () => number | undefined;
}

function rig(opts: RigOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fork-cmd-'));
  dirs.push(dir);
  const store = new ConversationStore(path.join(dir, 'conversations.json'));
  const prompts: string[] = [];
  const forks: Array<{ key: string; sessionId: string }> = [];
  const warmed: string[] = [];
  let release: () => void = () => {};
  const sessions = new Map<string, AgentSession>();
  let started = false;
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input) => {
            prompts.push(input.prompt);
            await new Promise<void>((r) => (release = r));
          },
          abort: () => release(),
          dispose: () => {},
          canFork: () => (opts.canFork === 'after-start' ? (started ? true : undefined) : opts.canFork ?? true),
          ensureSession: async () => {
            warmed.push(conversationId);
            started = true;
          },
          forkFrom: async (input) => {
            forks.push({ key: conversationId, sessionId: input.sessionId });
            await (opts.forkFrom ?? (async () => {}))(input);
          },
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const sent: Array<{ thread?: string; text: string }> = [];
  const discarded: string[] = [];
  const forkCalls: Array<{ source: ConversationAddress; turn?: number }> = [];
  let nextFork = 0;
  const base = {
    capabilities: { thread: true, editMessage: true, maxMessageLength: 4000 },
    sendMessage: async (address: ConversationAddress, text: string) => {
      sent.push({ ...(address.thread ? { thread: address.thread } : {}), text });
      return { address, messageId: `out${sent.length}` };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  };
  const web = {
    ...base,
    forkThread: async (source: ConversationAddress, o: { turn?: number }) => {
      forkCalls.push({ source, ...(o.turn !== undefined ? { turn: o.turn } : {}) });
      const thread = `f${++nextFork}`.padEnd(8, '0');
      return { address: { channel: 'main', thread }, title: '[cc] fix login (fork)', discard: () => void discarded.push(thread) };
    },
  } as unknown as PlatformAdapter;
  const discord = base as unknown as PlatformAdapter;
  const history = {
    session: () => undefined,
    turnRecord: () => {
      const turn = (opts.turn ?? (() => 3))();
      return turn === undefined ? undefined : { turn, at: '', outcome: 'done', agent: 'cc', detail: '' };
    },
  } as unknown as HistoryStore;
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  };
  const reg = new ConversationRegistry(
    config(),
    new Map([
      ['web', web],
      ['discord', discord],
    ]),
    factory,
    clock,
    undefined,
    store,
    undefined,
    undefined,
    history
  );

  let n = 0;
  const send = async (content: string, where: { platform?: string; thread?: string } = {}): Promise<void> => {
    const platform = where.platform ?? 'web';
    reg.route({
      conversation:
        platform === 'web'
          ? { platform, channel: 'main', thread: where.thread ?? 'a0a0a0a0', kind: 'direct', user: 'web:owner' }
          : { platform, channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: `m${++n}`,
      content,
      timestamp: 0,
    } as InboundMessage);
    await drain();
  };
  return {
    reg,
    store,
    send,
    prompts,
    forks,
    warmed,
    sent,
    discarded,
    forkCalls,
    release: async () => {
      release();
      await drain();
    },
    /** The last thing said in a web topic. */
    said: (thread = 'a0a0a0a0') => sent.filter((m) => m.thread === thread).at(-1)?.text,
  };
}

const SOURCE = 'web#main#a0a0a0a0';

/** A source topic that has run a turn, with a session id on record and a setup of its own. */
async function withSource(r: ReturnType<typeof rig>): Promise<void> {
  await r.send('fix the login bug');
  await r.release();
  r.store.setAgentSession(SOURCE, 'cc', 'S1');
  r.store.setConversationCwd(SOURCE, 'cc', '/work/shop-api');
  r.store.setConversationChoice(SOURCE, 'cc', 'model', 'opus');
  r.store.setConversationChoice(SOURCE, 'cc', 'effort', 'high');
}

describe('/fork refused', () => {
  it('says it works in the web UI only, anywhere else', async () => {
    const r = rig();
    await r.send('/fork', { platform: 'discord' });
    expect(r.sent.at(-1)?.text).toMatch(/^\/fork works in the web UI only/);
    expect(r.forks).toEqual([]);
  });

  it('says there is nothing to fork in a topic that has never run', async () => {
    const r = rig();
    await r.send('/fork');
    expect(r.said()).toBe('Nothing to fork yet: claude has no conversation here. Send it a message first.');
    expect(r.forkCalls).toEqual([]);
  });

  it('refuses while a turn runs, opening nothing and stopping nothing', async () => {
    const r = rig();
    await withSource(r);
    await r.send('run the full suite');
    await r.send('/fork');
    expect(r.said()).toBe('claude is in the middle of a turn here. /fork once it ends: a copy taken now would hold half of that turn.');
    expect(r.forkCalls).toEqual([]);
    await r.release();
    expect(r.prompts).toEqual(['fix the login bug', 'run the full suite']);
  });

  it('refuses an agent that declares no fork before opening a topic', async () => {
    const r = rig({ canFork: false });
    await withSource(r);
    await r.send('/fork');
    expect(r.said()).toBe('cc does not support /fork: its agent declares no session/fork, which a fork is made with.');
    expect(r.forkCalls).toEqual([]);
  });

  it("starts the source's agent first when nothing has said yet whether it can fork", async () => {
    const r = rig({ canFork: 'after-start' });
    await withSource(r);
    await r.send('/fork');
    await drain();
    expect(r.warmed).toEqual([SOURCE]);
    expect(r.forks).toHaveLength(1);
  });

  it("takes the topic away again when the copy cannot be made, and sends the agent's sentence", async () => {
    const r = rig({
      forkFrom: async () => {
        throw new ForkRefused('cc does not support /fork: its agent declares no session/fork, which a fork is made with.');
      },
    });
    await withSource(r);
    await r.send('/fork');
    await drain();
    expect(r.discarded).toEqual(['f1000000']);
    expect(r.said()).toBe('cc does not support /fork: its agent declares no session/fork, which a fork is made with.');
    expect(r.store.boundAgent('web#main#f1000000')).toBeUndefined();
    expect(r.reg.isBusy('web#main#f1000000')).toBe(false);
  });

  it('says why a fork that failed for any other reason did not happen', async () => {
    const r = rig({
      forkFrom: async () => {
        throw new Error('agent "cc" started, but session/fork failed: Session not found.');
      },
    });
    await withSource(r);
    await r.send('/fork');
    await drain();
    expect(r.discarded).toEqual(['f1000000']);
    expect(r.said()).toBe('Could not fork: agent "cc" started, but session/fork failed: Session not found.');
  });
});

describe('/fork', () => {
  it("opens a topic beside the source, set up as the source is, whose session starts as the source's copy", async () => {
    const r = rig();
    await withSource(r);
    await r.send('/fork');
    await drain();

    expect(r.forkCalls).toEqual([{ source: { channel: 'main', thread: 'a0a0a0a0' }, turn: 3 }]);
    const fork = 'web#main#f1000000';
    expect(r.forks).toEqual([{ key: fork, sessionId: 'S1' }]);
    // Same agent, directory, model and effort; nothing of what was said is the gateway's to copy.
    expect(r.store.boundAgent(fork)).toBe('cc');
    expect(r.store.conversationCwd(fork)).toBe('/work/shop-api');
    expect(r.store.conversationChoice(fork, 'cc', 'model')).toBe('opus');
    expect(r.store.conversationChoice(fork, 'cc', 'effort')).toBe('high');
    // No prompt to anyone: the copy is the harness's, and the source carries on as it was.
    expect(r.prompts).toEqual(['fix the login bug']);
    expect(r.store.agentSession(SOURCE, 'cc')).toBe('S1');
    expect(r.sent.filter((m) => m.thread === 'f1000000')).toEqual([]);
    expect(r.said()).toBe(
      'Forked into [fix login (fork)](?t=f1000000) at turn 3: it carries on from everything said here so far, as a conversation of its own. This topic is unchanged.'
    );
  });

  it('is a conversation of its own afterwards: the next message there is its turn, not the source\'s', async () => {
    const r = rig();
    await withSource(r);
    await r.send('/fork');
    await drain();
    await r.send('try it with redis instead', { thread: 'f1000000' });
    expect(r.prompts).toEqual(['fix the login bug', 'try it with redis instead']);
    expect(r.reg.isBusy('web#main#f1000000')).toBe(true);
    expect(r.reg.isBusy(SOURCE)).toBe(false);
    await r.release();
  });

  it('says so in the fork when the source started a turn while the copy was being made', async () => {
    let turn = 3;
    const r = rig({
      turn: () => turn,
      forkFrom: async () => {
        turn = 4;
      },
    });
    await withSource(r);
    await r.send('/fork');
    await drain();
    expect(r.said('f1000000')).toMatch(/^⚠ claude started a turn in the original topic while this copy was being made/);
  });
});
