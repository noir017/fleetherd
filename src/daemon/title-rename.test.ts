import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from './daemon.js';
import { ConversationStore } from './conversation-store.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter, PlatformCapabilities } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { InboundMessage } from '../types.js';

/**
 * A conversation's chat lane taking a name generated from its opening message.
 *
 * The bug: a Telegram forum topic keeps whatever name it was created with for as long as it exists,
 * so a topic-per-task workflow ends up as a column of names typed before any of the work happened.
 *
 * Two earlier answers to it are what these tests are shaped against. Following the harness's ACP
 * `session_info_update` gave accurate names that never settled — claude-agent-acp regenerates the
 * title as the session moves on, so topics drifted to whatever had been discussed most recently —
 * and the fallback for the three harnesses that emit no title at all was the first 39 characters of
 * the opening message, a substring rather than a summary. Naming now happens exactly once, from a
 * model given the whole opening message.
 *
 * These run the real `Daemon` and the real `ConversationStore` on a temp file; only the platform
 * adapter, the agent and `fetch` are fakes. That matters because the interesting behaviour is not
 * the API call — it is everything around it: the once-only rule, the persistence that stops a
 * restart re-naming everything, the capability and setting gates, the fallback when the model is
 * unreachable, and the rule that none of it may ever break a turn.
 */

const CONVERSATION = {
  platform: 'tg',
  channel: '-1001234567890',
  thread: '99',
  kind: 'thread' as const,
  user: 'u1',
};

const LLM = { baseUrl: 'http://namer.test/v1', apiKey: 'k', model: 'flash' };

const tmpDirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function config(opts: { autoRenameThread?: boolean; llm?: boolean } = {}): Config {
  const parsed = parseConfig({
    platforms: {
      tg: {
        type: 'telegram',
        token: 't',
        ...(opts.autoRenameThread === undefined ? {} : { autoRenameThread: opts.autoRenameThread }),
      },
    },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
    ...(opts.llm === false ? {} : { title: { llm: LLM } }),
  });
  return { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
}

/**
 * Stand in for the naming endpoint.
 *
 * `fetch` rather than an injected client: the request shaping (URL, bearer, body) is part of what
 * can break, and a fake at this level is the only one that keeps it under test.
 */
function stubNamer(opts: {
  /** One reply per call, in order; the last is reused once exhausted. */
  replies?: string[];
  status?: number;
  fails?: string;
  /** Resolve this long after the call, to model a slow model. */
  delayMs?: number;
}): { calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let n = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fails) throw new Error(opts.fails);
    const status = opts.status ?? 200;
    const content = opts.replies?.[Math.min(n++, opts.replies.length - 1)] ?? 'A generated name';
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => 'upstream said no',
      json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
    } as unknown as Response;
  });
  return { calls };
}

function rig(
  opts: {
    autoRenameThread?: boolean;
    canRename?: boolean;
    renameFails?: string;
    /** Configure no `title.llm`, i.e. the substring fallback. */
    llm?: boolean;
    /** Reuse an existing store file, to model a daemon restart. */
    storeFile?: string;
    /** Hold every turn open until `releaseTurn()` is called, to model work that takes a while. */
    holdTurn?: boolean;
    /** Make every turn throw, to model a harness that cannot answer. */
    turnFails?: string;
  } = {}
) {
  const renames: Array<{ address: ConversationAddress; name: string }> = [];
  const sent: string[] = [];
  const sessions = new Map<string, AgentSession>();

  let release = (): void => {};
  const held = new Promise<void>((r) => {
    release = r;
  });

  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (_input, handlers: AgentStreamHandlers) => {
            if (opts.holdTurn) await held;
            if (opts.turnFails) throw new Error(opts.turnFails);
            handlers.onText('done');
          },
          abort: () => {},
          dispose: () => {},
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const capabilities = {
    thread: true,
    renameThread: opts.canRename ?? true,
    editMessage: true,
    reaction: true,
    reply: true,
    typing: true,
    buttons: true,
    editButtons: true,
    slashCommands: true,
    maxMessageLength: 4096,
  } as unknown as PlatformCapabilities;

  const platform = {
    platform: 'tg',
    platformType: 'telegram',
    capabilities,
    sendMessage: async (address: ConversationAddress, text: string) => {
      sent.push(text);
      return { address, messageId: `m${sent.length}` };
    },
    renameThread: async (address: ConversationAddress, name: string) => {
      if (opts.renameFails) throw new Error(opts.renameFails);
      renames.push({ address, name });
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    stop: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  let file = opts.storeFile;
  if (!file) {
    const dir = mkdtempSync(join(tmpdir(), 'title-rename-'));
    tmpDirs.push(dir);
    file = join(dir, 'conversations.json');
  }
  const store = new ConversationStore(file);
  const daemon = new Daemon(
    config({
      ...(opts.autoRenameThread === undefined ? {} : { autoRenameThread: opts.autoRenameThread }),
      ...(opts.llm === undefined ? {} : { llm: opts.llm }),
    }),
    new Map([['tg', platform]]),
    agents,
    '/tmp/aa-title-rename-test.sock',
    store
  );
  daemons.push(daemon);
  const d = daemon as unknown as { onInbound(m: InboundMessage): void };

  let n = 0;
  const send = async (content: string): Promise<void> => {
    d.onInbound({
      conversation: CONVERSATION,
      messageId: `in${++n}`,
      content,
      timestamp: Date.now(),
      mentionedSelf: true,
    });
    await drain();
  };
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  return { send, renames, replies, store, file, key: 'tg#-1001234567890#99', releaseTurn: release };
}

describe('naming a topic from its opening message', () => {
  it('renames the topic the conversation is in', async () => {
    stubNamer({ replies: ['Fix the ask timeout'] });
    const r = rig();
    await r.send('ask 一直超时，看看是不是默认时间太短了');
    expect(r.renames).toEqual([
      { address: { channel: '-1001234567890', thread: '99' }, name: '[cc] Fix the ask timeout' },
    ]);
  });

  it('remembers what it set, so the name survives a daemon restart unchanged', async () => {
    stubNamer({ replies: ['Fix the ask timeout'] });
    const r = rig();
    await r.send('hello');
    expect(r.store.conversationTitle(r.key)).toBe('[cc] Fix the ask timeout');
  });

  // The whole point of the rewrite. Its predecessor followed the harness's title, which moves as a
  // session moves, so a topic's name tracked "what was said most recently" rather than what the
  // topic is for.
  it('names a conversation once and then leaves it alone', async () => {
    const namer = stubNamer({ replies: ['First subject', 'Something else entirely'] });
    const r = rig();
    await r.send('first thing');
    await r.send('second thing');
    await r.send('third thing');
    expect(r.renames.map((x) => x.name)).toEqual(['[cc] First subject']);
    // Not just "did not rename" — it did not even ask, which is what keeps the cost at one call
    // per conversation rather than one per turn.
    expect(namer.calls).toHaveLength(1);
  });

  // A restart reattaches every conversation it has on disk. Without the persisted title it would
  // rename all of them on the first turn after coming back.
  it('does not name again after a restart', async () => {
    stubNamer({ replies: ['Stable title'] });
    const first = rig();
    await first.send('hello');
    expect(first.renames).toHaveLength(1);

    const second = rig({ storeFile: first.file });
    await second.send('hello again');
    expect(second.renames).toHaveLength(0);
  });

  it('sends the whole opening message to be summarised, not a truncation of it', async () => {
    const namer = stubNamer({});
    const r = rig();
    const long =
      '帮我看下 telegram 话题自动改名这个功能，现在的实现是每轮都跟着 harness 的标题走，' +
      '结果话题名字一直在变，我想改成只命名一次';
    await r.send(long);
    const messages = namer.calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)!.content).toBe(long);
  });

  it('posts to the configured endpoint with the configured model and key', async () => {
    const namer = stubNamer({});
    const r = rig();
    await r.send('hello');
    expect(namer.calls[0]!.url).toBe('http://namer.test/v1/chat/completions');
    expect(namer.calls[0]!.body.model).toBe('flash');
  });

  // The model call takes a second or two, and nothing is recorded until the rename lands — so the
  // store gate cannot see an attempt that is still in the air.
  it('does not start a second naming call while one is in flight', async () => {
    const namer = stubNamer({ delayMs: 60 });
    const r = rig();
    await r.send('first thing');
    await r.send('second thing');
    await new Promise((res) => setTimeout(res, 120));
    expect(namer.calls).toHaveLength(1);
    expect(r.renames).toHaveLength(1);
  });
});

/**
 * When the rename lands, relative to the turn that triggered it.
 *
 * Naming used to be fired after a successful turn, which made the name arrive one whole turn late —
 * and a turn is not a moment: the interesting ones run for minutes, and the user spends all of them
 * looking at a topic column that still says whatever the topic was created as. The seed and the
 * lane are both known before the agent is even asked, so there is nothing to wait for.
 */
describe('naming runs beside the turn, not after it', () => {
  it('renames while the turn is still running', async () => {
    stubNamer({ replies: ['Fix the ask timeout'] });
    const r = rig({ holdTurn: true });
    await r.send('ask 一直超时');
    // The agent has not answered yet — no reply has been sent — and the topic already has its name.
    expect(r.replies().join('')).not.toContain('done');
    expect(r.renames.map((x) => x.name)).toEqual(['[cc] Fix the ask timeout']);
    r.releaseTurn();
  });

  // The old rule was "only after a turn that succeeded", so that a topic could not be labelled with
  // something that failed. That guarded the wrong text: the seed is the user's own request, which is
  // no less what the topic is about for the harness having failed to answer it — and a conversation
  // whose first turn errors is exactly the one the user needs to find again in the column.
  it('names a conversation whose first turn fails', async () => {
    stubNamer({ replies: ['Fix the ask timeout'] });
    const r = rig({ turnFails: 'harness exited before it started' });
    await r.send('ask 一直超时');
    expect(r.renames.map((x) => x.name)).toEqual(['[cc] Fix the ask timeout']);
  });
});

/**
 * What happens when the model cannot be reached.
 *
 * A name that is merely poor ends the attempt; no name at all means every later turn re-runs the
 * call, which against a misconfigured endpoint is an unbounded stream of them. So a failure falls
 * back to the old behaviour — the opening message, cut to length — rather than to nothing.
 */
describe('when the naming call does not work', () => {
  it('falls back to the opening message when the endpoint is unreachable', async () => {
    stubNamer({ fails: 'ECONNREFUSED' });
    const r = rig();
    await r.send('帮我看看这个报错');
    expect(r.renames.at(-1)!.name).toBe('[cc] 帮我看看这个报错');
  });

  it('falls back on a non-2xx too', async () => {
    stubNamer({ status: 401 });
    const r = rig();
    await r.send('帮我看看这个报错');
    expect(r.renames.at(-1)!.name).toBe('[cc] 帮我看看这个报错');
  });

  it('falls back when the model answers with nothing usable', async () => {
    stubNamer({ replies: ['   '] });
    const r = rig();
    await r.send('帮我看看这个报错');
    expect(r.renames.at(-1)!.name).toBe('[cc] 帮我看看这个报错');
  });

  // And the fallback is recorded like any other name, so a broken endpoint costs one call per
  // conversation rather than one per turn forever.
  it('records the fallback, so it is not retried on every later turn', async () => {
    const namer = stubNamer({ fails: 'ECONNREFUSED' });
    const r = rig();
    await r.send('first thing');
    await r.send('second thing');
    expect(namer.calls).toHaveLength(1);
    expect(r.renames).toHaveLength(1);
  });

  it('uses the opening message directly when no title.llm is configured', async () => {
    const namer = stubNamer({});
    const r = rig({ llm: false });
    await r.send('帮我看看这个报错');
    expect(namer.calls).toHaveLength(0);
    expect(r.renames.at(-1)!.name).toBe('[cc] 帮我看看这个报错');
  });

  it('cuts a long opening message to length in the fallback', async () => {
    const r = rig({ llm: false });
    await r.send('a'.repeat(100));
    expect(r.renames.at(-1)!.name).toBe(`[cc] ${'a'.repeat(39)}…`);
  });
});

describe('when it must leave the name alone', () => {
  it('does nothing when autoRenameThread is off', async () => {
    const namer = stubNamer({});
    const r = rig({ autoRenameThread: false });
    await r.send('hello');
    expect(r.renames).toHaveLength(0);
    expect(namer.calls).toHaveLength(0);
    expect(r.store.conversationTitle(r.key)).toBeUndefined();
  });

  it('does nothing on a platform that cannot rename a lane', async () => {
    stubNamer({});
    const r = rig({ canRename: false });
    await r.send('hello');
    expect(r.renames).toHaveLength(0);
  });

  it('never names a topic after a slash command', async () => {
    stubNamer({});
    const r = rig();
    await r.send('/title auto'); // gateway-answered, no turn
    expect(r.renames).toHaveLength(0);
  });

  // A cosmetic failure must not cost the user their answer. This is the assertion that matters
  // most in the file: the reply still lands.
  it('answers the turn normally when the rename is rejected', async () => {
    stubNamer({});
    const r = rig({ renameFails: 'Telegram API error 400: TOPIC_NOT_MODIFIED' });
    await r.send('hello');
    expect(r.replies().join('')).toContain('done');
    // Not recorded as done, so the conversation gets another chance.
    expect(r.store.conversationTitle(r.key)).toBeUndefined();
  });

  it('retries on the next turn after a failure, rather than giving up on the conversation', async () => {
    stubNamer({ replies: ['Try one'] });
    const failing = rig({ renameFails: 'nope' });
    await failing.send('hello');
    expect(failing.store.conversationTitle(failing.key)).toBeUndefined();

    const working = rig({ storeFile: failing.file });
    await working.send('hello again');
    expect(working.renames.map((x) => x.name)).toEqual(['[cc] Try one']);
  });
});

describe('/title', () => {
  it('renames on demand and says so', async () => {
    stubNamer({});
    const r = rig();
    await r.send('/title 我自己起的名字');
    expect(r.renames.map((x) => x.name)).toEqual(['[cc] 我自己起的名字']);
    expect(r.replies().at(-1)).toContain('我自己起的名字');
  });

  it('stops the automatic naming, which would otherwise rename it back', async () => {
    const namer = stubNamer({});
    const r = rig();
    await r.send('/title Mine');
    await r.send('hello');
    expect(r.renames.map((x) => x.name)).toEqual(['[cc] Mine']);
    expect(namer.calls).toHaveLength(0);
    expect(r.store.titlePinned(r.key)).toBe(true);
  });

  it('survives a restart still in force', async () => {
    stubNamer({});
    const first = rig();
    await first.send('/title Mine');

    const second = rig({ storeFile: first.file });
    await second.send('hello');
    expect(second.renames).toHaveLength(0);
  });

  // `/title auto` is the only way to ask for a second name, so releasing the record is what it has
  // to do — the once-only rule is "has a name on record", not "was named automatically".
  it('re-arms the automatic naming with /title auto', async () => {
    stubNamer({ replies: ['The real subject'] });
    const r = rig();
    await r.send('/title Mine');
    await r.send('/title auto');
    expect(r.replies().at(-1)).toContain('Forgot the name');
    expect(r.store.conversationTitle(r.key)).toBeUndefined();

    await r.send('hello'); // named afresh
    expect(r.renames.map((x) => x.name)).toEqual(['[cc] Mine', '[cc] The real subject']);
  });

  // The lane keeps its current name in the meantime: a topic briefly called nothing is worse than
  // one briefly called the wrong thing.
  it('does not rename the lane when releasing the name', async () => {
    stubNamer({});
    const r = rig();
    await r.send('/title Mine');
    await r.send('/title auto');
    expect(r.renames.map((x) => x.name)).toEqual(['[cc] Mine']);
  });

  it('says there is nothing to release when it has named nothing', async () => {
    stubNamer({});
    const r = rig();
    await r.send('/title auto');
    expect(r.replies().at(-1)).toContain('have not named this topic yet');
  });

  it('reports the name it last set when asked with no argument', async () => {
    stubNamer({});
    const r = rig();
    await r.send('/title Some name');
    await r.send('/title');
    expect(r.replies().at(-1)).toContain('Some name');
    expect(r.replies().at(-1)).toContain('you set it');
  });

  it('says who named the topic when it named it itself', async () => {
    stubNamer({ replies: ['A generated name'] });
    const r = rig();
    await r.send('hello');
    await r.send('/title');
    expect(r.replies().at(-1)).toContain('I named this topic');
  });

  it('says it has named nothing when it has not', async () => {
    stubNamer({});
    const r = rig();
    await r.send('/title');
    expect(r.replies().at(-1)).toContain('have not named');
  });

  // Unlike the automatic path, an explicit command gets an explicit reason — a silent no-op on a
  // command the user typed reads as a broken command.
  it('explains a rejection instead of failing silently', async () => {
    stubNamer({});
    const r = rig({ renameFails: 'Telegram API error 400: not a forum chat' });
    await r.send('/title Nope');
    expect(r.replies().at(-1)).toContain('Could not rename');
    expect(r.replies().at(-1)).toContain('not a forum chat');
  });

  it('explains that the platform cannot do it, rather than pretending it worked', async () => {
    stubNamer({});
    const r = rig({ canRename: false });
    await r.send('/title Nope');
    expect(r.replies().at(-1)).toContain('cannot rename');
  });
});

/**
 * The tag.
 *
 * A column of topics named only after their subject says nothing about which agent answers in each,
 * and that is the first thing you need when several are running at once.
 */
describe('how a lane name is shaped', () => {
  it('tags the name with the agent answering in it', async () => {
    stubNamer({ replies: ['Fix the ask timeout'] });
    const r = rig();
    await r.send('hello');
    expect(r.renames.at(-1)!.name).toBe('[cc] Fix the ask timeout');
  });

  // Otherwise every rename of an already-tagged conversation would stack another tag.
  it('replaces its own tag instead of stacking a second one', async () => {
    stubNamer({ replies: ['[cc] Already tagged'] });
    const r = rig();
    await r.send('hello');
    expect(r.renames.at(-1)!.name).toBe('[cc] Already tagged');
  });

  it('keeps a bracketed name that has nothing else in it, rather than emitting a bare tag', async () => {
    stubNamer({ replies: ['[????]'] });
    const r = rig();
    await r.send('hello');
    expect(r.renames.at(-1)!.name).toBe('[cc] [????]');
  });

  it('tags a name the user typed too, so the column reads uniformly', async () => {
    stubNamer({});
    const r = rig();
    await r.send('/title 我自己起的名字');
    expect(r.renames.at(-1)!.name).toBe('[cc] 我自己起的名字');
  });
});
