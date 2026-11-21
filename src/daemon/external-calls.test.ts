import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decode } from '@toon-format/toon';
import { parseConfig } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { TaskListResult } from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { InboundMessage } from '../types.js';
import { ExternalCalls, MAX_TOPICS_PER_CALLER, type ExternalCallsDeps } from './external-calls.js';
import type { ExternalCaller } from './external-mcp.js';
import { ExternalTopics } from './external-topics.js';
import { SkillLibrary } from './skill-library.js';
import { createSkill, setResident } from './skills-store.js';

/**
 * What an external caller's calls do (external-calls.ts): its topics opened and recorded, every
 * task command routed to a topic it opened — and refused, in the same words, for any it did not —
 * and the person's messages in such a topic answered instead of reaching an agent. Delegation is
 * faked: what the commands do there is delegation.test.ts's.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const GEM: ExternalCaller = { name: 'gem', tools: ['skills', 'tasks'] };
const OTHER: ExternalCaller = { name: 'other', tools: ['tasks'] };
const keyOf = (a: ConversationAddress): string => `web#${a.channel}#${a.thread ?? ''}`;

function rig(opts: { skills?: ExternalCallsDeps['skills']; taskList?: TaskListResult; sharedKey?: boolean; boundAgents?: Record<string, string> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-external-'));
  dirs.push(dir);
  const file = path.join(dir, 'external-topics.json');
  const topics = new ExternalTopics(file, () => undefined);
  const threads = new Set<string>();
  const parents = new Map<string, string>(); // child thread → parent thread
  const posted: Array<{ to: string; text: string }> = [];
  const handled: Array<{ key: string; kind: string; hosted?: boolean }> = [];
  const searched: unknown[] = [];
  let next = 0;
  let scope = '';
  const adapter = {
    capabilities: { thread: true },
    parentOf: (a: ConversationAddress) => (a.thread && parents.has(a.thread) ? { channel: 'main', thread: parents.get(a.thread)! } : undefined),
    childrenOf: () => [],
    hasThread: (a: ConversationAddress) => threads.has(a.thread ?? ''),
    createThread: async (_r: unknown, name: string) => {
      // e1000000, e2000000, … ef000000, f0000000: unique and eight hex digits up to 31 topics.
      const thread = (0xe0000000 + ++next * 0x1000000).toString(16);
      threads.add(thread);
      posted.push({ to: thread, text: `(created ${name})` });
      return { address: { channel: 'main', thread } };
    },
    sendMessage: async (a: ConversationAddress, text: string) => {
      posted.push({ to: a.thread ?? '', text });
      return { address: a, messageId: 'm' };
    },
  } as unknown as PlatformAdapter;
  const stopped: string[] = [];
  const deps: ExternalCallsDeps = {
    config: parseConfig({
      platforms: { web: { type: 'webui', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc' },
      mcp: { callers: [{ name: 'gem', tokenEnv: 'T', tools: ['skills', 'tasks'] }] },
    }),
    platforms: new Map([['web', adapter]]),
    topics,
    conversationAt: (_p, a) => {
      const key = opts.sharedKey ? 'web#main' : `${keyOf(a)}${scope}`;
      const agent = a.thread ? opts.boundAgents?.[a.thread] : undefined;
      return { key, ...(agent ? { agent } : {}) };
    },
    delegation: {
      handleExternal: async (key, action, _at, callOpts) => {
        handled.push({ key, kind: action.kind, ...(callOpts?.hosted ? { hosted: true } : {}) });
        return action.kind === 'task-list'
          ? (opts.taskList ?? { tasks: [{ stage: 'working' }, { stage: 'review' }], total: 2 })
          : { ok: true };
      },
      externalAgents: () => ({ agents: [] }),
      stopOpened: (key) => {
        stopped.push(key);
        return 2;
      },
    },
    skills: opts.skills ?? {
      search: (query, asker) => {
        searched.push({ query, asker });
        return { query, results: [] };
      },
      show: (name) => ({ name }),
      categories: () => ({ total: 0, library: 0, categories: [] }),
    },
    render: (action, data) => JSON.stringify({ kind: action.kind, data }),
    now: () => Date.UTC(2026, 10, 19),
  };
  return { calls: new ExternalCalls(deps), topics, file, threads, parents, posted, handled, stopped, searched, setScope: (s: string) => (scope = s) };
}

const open = async (r: ReturnType<typeof rig>, caller = GEM, title?: string): Promise<string> => {
  const out = decode(await r.calls.call(caller, { kind: 'open', ...(title ? { title } : {}) })) as { topic: string };
  return out.topic;
};

describe('ExternalCalls: open', () => {
  it('opens a top-level topic named for the caller, records it, and says whose it is there', async () => {
    const r = rig();
    const topic = await open(r, GEM, 'Trip plan');
    expect(topic).toBe('web:main/e1000000');
    expect(r.posted[0]).toEqual({ to: 'e1000000', text: '(created [gem] Trip plan)' });
    expect(r.posted[1]!.text).toMatch(/^Opened by \*\*gem\*\*, outside this gateway/);
    expect(r.topics.get('web', { channel: 'main', thread: 'e1000000' })).toMatchObject({ caller: 'gem', platform: 'web', title: '[gem] Trip plan' });
    // Survives a restart: the record is the file.
    expect(new ExternalTopics(r.file).of('gem').map((t) => t.key)).toEqual(['web:main/e1000000']);
    expect(fs.statSync(r.file).mode & 0o777).toBe(0o600);
  });

  it('holds a caller to MAX_TOPICS_PER_CALLER, so it cannot push the person\'s topics out of the web UI', async () => {
    const r = rig();
    for (let i = 0; i < MAX_TOPICS_PER_CALLER; i++) await open(r, GEM, `job ${i}`);
    await expect(open(r, GEM, 'one more')).rejects.toThrow(/the most a caller may hold/);
    // Another caller has its own allowance, and a deleted topic frees one.
    await open(r, OTHER, 'theirs');
    r.threads.delete('e1000000');
    await expect(open(r, GEM, 'again')).resolves.toMatch(/^web:main\//);
  });
});

describe('ExternalCalls: ownership', () => {
  it('routes new and list to the caller\'s own topic, by full id or bare id', async () => {
    const r = rig();
    const topic = await open(r);
    await r.calls.call(GEM, { kind: 'task', in: topic, action: { kind: 'task-new', agent: 'cc', text: 'x' } });
    await r.calls.call(GEM, { kind: 'task', in: 'e1000000', action: { kind: 'task-list' } });
    expect(r.handled).toEqual([
      { key: 'web#main#e1000000', kind: 'task-new' },
      { key: 'web#main#e1000000', kind: 'task-list' },
    ]);
  });

  it('refuses another caller\'s topic and a topic that does not exist in the same words', async () => {
    const r = rig();
    const topic = await open(r);
    const theirs = r.calls.call(OTHER, { kind: 'task', in: topic, action: { kind: 'task-list' } });
    const none = r.calls.call(GEM, { kind: 'task', in: 'web:main/ffffffff', action: { kind: 'task-list' } });
    await expect(theirs).rejects.toThrow(/is not a topic you opened, or a sub-task under one/);
    await expect(none).rejects.toThrow(/is not a topic you opened, or a sub-task under one/);
    expect(r.handled).toEqual([]);
  });

  it('keeps two callers apart when per_channel gives their topics one shared key', async () => {
    const r = rig({ sharedKey: true });
    const a = await open(r, GEM, 'a');
    const b = await open(r, OTHER, 'b');

    // Ownership is by address and caller, not by the conversation id they now share.
    await expect(r.calls.call(OTHER, { kind: 'task', in: a, action: { kind: 'task-list' } })).rejects.toThrow(
      /is not a topic you opened, or a sub-task under one/
    );
    const listed = decode(await r.calls.call(GEM, { kind: 'topics' })) as { topics: Array<{ topic: string }> };
    expect(listed.topics.map((t) => t.topic)).toEqual([a]);
    expect(b).not.toBe(a);
  });

  it('reaches a sub-task only through its parent, which has to be the caller\'s', async () => {
    const r = rig();
    const topic = await open(r);
    r.threads.add('c1000000');
    r.parents.set('c1000000', 'e1000000');
    r.threads.add('c2000000');
    r.parents.set('c2000000', 'aaaaaaaa'); // a person's topic
    await r.calls.call(GEM, { kind: 'task', action: { kind: 'task-read', topic: 'web:main/c1000000', reply: true } });
    expect(r.handled).toEqual([{ key: 'web#main#e1000000', kind: 'task-read' }]);
    await expect(r.calls.call(GEM, { kind: 'task', action: { kind: 'task-stop', topic: 'c2000000' } })).rejects.toThrow(/not a topic you opened/);
    // A sub-task under gem's topic is still not other's.
    await expect(r.calls.call(OTHER, { kind: 'task', action: { kind: 'task-stop', topic: 'web:main/c1000000' } })).rejects.toThrow(
      /not a topic you opened/
    );
    expect(topic).toBeTruthy();
  });

  it('forgets a topic deleted in the web UI, and lists the ones still there with their counts', async () => {
    const r = rig();
    await open(r, GEM, 'one');
    await open(r, GEM, 'two');
    r.threads.delete('e1000000');
    const listed = decode(await r.calls.call(GEM, { kind: 'topics' })) as { topics: Array<Record<string, unknown>> };
    expect(listed.topics).toEqual([
      { topic: 'web:main/e2000000', title: '[gem] two', opened: '2026-11-19T00:00:00.000Z', subtasks: 2, working: 1 },
    ]);
    expect(r.topics.get('web', { channel: 'main', thread: 'e1000000' })).toBeUndefined();
    expect(decode(await r.calls.call(OTHER, { kind: 'topics' }))).toMatchObject({ count: 0 });
  });

  it('allows acting on a live topic bound to an agent listed in caller.agents (exact or @host)', async () => {
    const r = rig({ boundAgents: { aaaaaaaa: 'gemini-task@uniagent', bbbbbbbb: 'cc' } });
    r.threads.add('aaaaaaaa');
    r.threads.add('bbbbbbbb');
    r.threads.add('c1000000');
    r.parents.set('c1000000', 'aaaaaaaa');
    const hostedCaller: ExternalCaller = { name: 'gem', tools: ['skills', 'tasks'], agents: ['gemini-task'] };

    await r.calls.call(hostedCaller, { kind: 'task', in: 'web:main/aaaaaaaa', action: { kind: 'task-new', agent: 'cc', text: 'do work' } });
    await r.calls.call(hostedCaller, { kind: 'task', action: { kind: 'task-read', topic: 'web:main/c1000000', reply: true } });
    expect(r.handled).toEqual([
      { key: 'web#main#aaaaaaaa', kind: 'task-new', hosted: true },
      { key: 'web#main#aaaaaaaa', kind: 'task-read', hosted: true },
    ]);

    // A topic bound to an unlisted agent, or a caller without `agents`, is refused the same way.
    await expect(
      r.calls.call(hostedCaller, { kind: 'task', in: 'web:main/bbbbbbbb', action: { kind: 'task-list' } })
    ).rejects.toThrow(/is not a topic you opened, or a sub-task under one/);
    await expect(
      r.calls.call(GEM, { kind: 'task', in: 'web:main/aaaaaaaa', action: { kind: 'task-list' } })
    ).rejects.toThrow(/is not a topic you opened, or a sub-task under one/);
  });
});

describe('ExternalCalls: skills', () => {
  it('asks the library as from no host and no harness, and as a caller outside it', async () => {
    const r = rig();
    await r.calls.call(GEM, { kind: 'skills', action: { kind: 'skills', action: 'search', query: 'deploy' } });
    expect(r.searched).toEqual([
      { query: 'deploy', asker: { agent: 'external:gem', host: 'external', harness: 'external', external: true } },
    ]);
    await expect(r.calls.call(GEM, { kind: 'skills', action: { kind: 'skills', action: 'archive', name: 'x' } })).rejects.toThrow(
      /only search and show/
    );
  });

  it('answers a search with no path and no resident note, and points at show', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-external-skills-'));
    dirs.push(dir);
    createSkill({ name: 'server-ops', description: 'Use when operating a fleet server over SSH', body: 'x', now: 0 }, dir);
    setResident('server-ops', true, dir, 0);
    const r = rig({ skills: new SkillLibrary(() => dir) });
    const out = JSON.parse(
      await r.calls.call(GEM, { kind: 'skills', action: { kind: 'skills', action: 'search', query: 'fleet server' } })
    ) as { data: { results: Array<Record<string, unknown>>; help?: string } };
    expect(out.data.results[0]).toEqual({ name: 'server-ops', description: 'Use when operating a fleet server over SSH', resident: true });
    expect(out.data.help).toMatch(/skills show <name>/);
  });
});

describe('ExternalCalls: tasks list', () => {
  it('answers an empty list in words a caller has, not a conversation it never had', async () => {
    const r = rig({ taskList: { tasks: [], total: 0 } });
    const topic = await open(r);
    const out = decode(await r.calls.call(GEM, { kind: 'task', in: topic, action: { kind: 'task-list' } })) as {
      count: number;
      note: string;
    };
    expect(out).toEqual({ count: 0, note: 'this topic has no sub-tasks yet; propose one with action new' });
  });

  it('says how many a limit hid, in the caller\'s words and with the right singular', async () => {
    const cases: Array<[number, string]> = [
      [3, '3 sub-tasks in this topic; raise limit to list them'],
      [1, '1 sub-task in this topic; raise limit to list it'],
    ];
    for (const [total, note] of cases) {
      const r = rig({ taskList: { tasks: [], total } });
      const topic = await open(r);
      const out = decode(
        await r.calls.call(GEM, { kind: 'task', in: topic, action: { kind: 'task-list', limit: 0 } })
      ) as { count: number; note: string };
      expect(out).toEqual({ count: 0, note });
    }
  });
});

describe('ExternalCalls: what the person types in a coordination topic', () => {
  const msg = (thread: string, content: string): InboundMessage =>
    ({
      conversation: { platform: 'web', channel: 'main', thread, kind: 'direct', user: 'owner' },
      messageId: 'm1',
      content,
      timestamp: 0,
    }) as unknown as InboundMessage;

  it('is answered, never routed, and /stop stops what is under it', async () => {
    const r = rig();
    await open(r);
    expect(r.calls.intercept(msg('e1000000', 'please also book a car'))).toBe(true);
    expect(r.posted.at(-1)!.text).toMatch(/has no agent: nothing typed here reaches one/);
    expect(r.calls.intercept(msg('e1000000', '/stop'))).toBe(true);
    expect(r.stopped).toEqual(['web#main#e1000000']);
    expect(r.posted.at(-1)!.text).toBe('⏹ Stopped 2 sub-agents under this topic.');
    // Any other topic goes on to routing.
    expect(r.calls.intercept(msg('aaaaaaaa', 'hello'))).toBe(false);
  });

  it('keeps answering and owning the topic after a scope change', async () => {
    const r = rig();
    const topic = await open(r, GEM, 'one');
    // `/reload` with another session.scope: the same address now maps to a different conversation.
    r.setScope('@scope2');

    // The person typing is still answered, never routed to an agent.
    expect(r.calls.intercept(msg('e1000000', 'hello'))).toBe(true);
    expect(r.posted.at(-1)!.text).toMatch(/has no agent: nothing typed here reaches one/);
    // Ownership is still found by the topic's own id, and delegation gets the key the new scope gives it.
    await r.calls.call(GEM, { kind: 'task', in: topic, action: { kind: 'task-list' } });
    expect(r.handled).toEqual([{ key: 'web#main#e1000000@scope2', kind: 'task-list' }]);
    const listed = decode(await r.calls.call(GEM, { kind: 'topics' })) as { topics: unknown[] };
    expect(listed.topics).toHaveLength(1);
    expect(r.handled.at(-1)).toEqual({ key: 'web#main#e1000000@scope2', kind: 'task-list' });
  });
});
