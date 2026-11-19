import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Daemon, COORDINATION_WRITE_ACTIONS } from './daemon.js';
import { ConversationStore } from './conversation-store.js';
import { parseConfig } from '../config/schema.js';
import { configDir } from '../config/load.js';
import { callDaemon } from '../ipc/client.js';
import { REVERSE_COMMANDS } from '../ipc/commands.js';
import type { IpcAction, ListChannelsResult } from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * Reverse commands aimed at ANOTHER platform (`--channel <instance>:<address>`), and the
 * `channels` list that prints those ids — exercised over the real unix socket, because the part
 * that changed is the boundary itself: the server parses the value against the configured
 * instances, the daemon picks the adapter from it. A unit test of either half would pass while the
 * two disagreed.
 */

const parsed = parseConfig({
  platforms: { tg: { type: 'telegram', token: 't' }, web: { type: 'webui', token: 'w' } },
  agents: [{ id: 'cc', harness: 'claude' }],
  routing: { default: 'cc' },
});
const cfg = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

type Sent = { platform: string; address: { channel: string; thread?: string }; text: string };

function adapter(id: string, type: string, sent: Sent[]): PlatformAdapter {
  return {
    platform: id,
    platformType: type,
    capabilities: { thread: true, editMessage: true, buttons: false, reaction: false, reply: false, typing: false, maxMessageLength: 4096 },
    sendMessage: async (address: Sent['address'], text: string) => {
      sent.push({ platform: id, address, text });
      return { address, messageId: `${id}-${sent.length}` };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
    parentOf: () => undefined,
    childrenOf: () => [],
  } as unknown as PlatformAdapter;
}

const dirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await (d as unknown as { ipc: { stop(): Promise<void> } }).ipc.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function rig(scope?: 'per_channel') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-target-'));
  dirs.push(dir);
  const socket = path.join(dir, 'd.sock');
  const sent: Sent[] = [];
  const tokens: string[] = [];
  const sessions = new Map<string, AgentSession>();
  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input: { sessionToken: string }) => void tokens.push(input.sessionToken),
          abort: () => {},
          dispose: () => {},
        } as unknown as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };
  const store = new ConversationStore(path.join(dir, 'conversations.json'));
  const config = scope === undefined ? cfg : { ...cfg, session: { ...cfg.session, scope } };
  const daemon = new Daemon(
    config,
    new Map([
      ['tg', adapter('tg', 'telegram', sent)],
      ['web', adapter('web', 'webui', sent)],
    ]),
    agents,
    socket,
    store
  );
  daemons.push(daemon);
  await (daemon as unknown as { ipc: { start(): Promise<void> } }).ipc.start();

  let n = 0;
  const inbound = async (conversation: InboundMessage['conversation'], content: string): Promise<void> => {
    (daemon as unknown as { onInbound: (m: InboundMessage) => void }).onInbound({
      conversation,
      messageId: `in_${++n}`,
      content,
      timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 40));
  };
  return { socket, sent, tokens, inbound, daemon };
}

// `direct` like the live deployment's Telegram DM topics and the web UI's: a group/thread would be
// gated on a mention, which is not what this suite is about.
const TG_TOPIC = { platform: 'tg', channel: '586', thread: '8068', kind: 'direct' as const, user: 'u1' };
const WEB_TOPIC = { platform: 'web', channel: 'main', thread: 't1', kind: 'direct' as const, user: 'u1' };

describe('--channel <instance>:<address>', () => {
  it('posts to the named platform, not the caller\'s own', async () => {
    const r = await rig();
    await r.inbound(TG_TOPIC, 'hello');
    const token = r.tokens[0]!;
    r.sent.length = 0;

    const resp = await callDaemon(r.socket, { kind: 'send-message', text: 'cross', channelId: 'web:main/t1' }, token);
    expect(resp).toMatchObject({ ok: true });
    expect(r.sent).toEqual([{ platform: 'web', address: { channel: 'main', thread: 't1' }, text: 'cross' }]);
  });

  it('keeps the unqualified form on the caller\'s platform, colons and all', async () => {
    const r = await rig();
    await r.inbound(TG_TOPIC, 'hello');
    r.sent.length = 0;
    // `private:9` is not an instance, so the colon is part of the channel id — as it always was.
    await callDaemon(r.socket, { kind: 'send-message', text: 'same', channelId: 'private:9' }, r.tokens[0]!);
    expect(r.sent).toEqual([{ platform: 'tg', address: { channel: 'private:9' }, text: 'same' }]);
  });

  it('with no --channel still answers in the caller\'s own lane', async () => {
    const r = await rig();
    await r.inbound(TG_TOPIC, 'hello');
    r.sent.length = 0;
    await callDaemon(r.socket, { kind: 'send-message', text: 'here' }, r.tokens[0]!);
    expect(r.sent).toEqual([{ platform: 'tg', address: { channel: '586', thread: '8068' }, text: 'here' }]);
  });
});

describe('a coordination topic an external caller opened', () => {
  const channelId = 'web:main/e1000000';

  function writeRecord(version: 1 | 2): void {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'external-topics.json'),
      JSON.stringify({
        version,
        topics: [
          {
            key: version === 1 ? 'web#main#e1000000' : 'web:main/e1000000',
            caller: 'gem',
            platform: 'web',
            address: { channel: 'main', thread: 'e1000000' },
            title: '[gem] tasks',
            openedAt: '2026-11-19T00:00:00.000Z',
          },
        ],
      })
    );
  }

  it('refuses every agent write in the set, not only send-message and reply', async () => {
    // A v1 record on purpose: the daemon migrates it and the guard still finds it.
    writeRecord(1);
    const r = await rig();
    await r.inbound(TG_TOPIC, 'hello');
    const token = r.tokens[0]!;
    r.sent.length = 0;

    const actions: Record<string, IpcAction> = {
      'send-message': { kind: 'send-message', text: 'x', channelId },
      reply: { kind: 'reply', messageId: 'm1', text: 'x', channelId },
      'edit-message': { kind: 'edit-message', messageId: 'm1', text: 'x', channelId },
      'send-file': { kind: 'send-file', path: '/tmp/x', channelId },
      react: { kind: 'react', messageId: 'm1', emoji: '👍', channelId },
      delete: { kind: 'delete', messageId: 'm1', channelId },
      'create-thread': { kind: 'create-thread', messageId: 'm1', name: 'n', channelId },
      ask: { kind: 'ask', prompt: 'p', options: [], channelId },
    };
    for (const kind of COORDINATION_WRITE_ACTIONS) {
      const action = actions[kind];
      expect(action, `no test action for ${kind}`).toBeDefined();
      const resp = await callDaemon(r.socket, action!, token);
      expect(resp, kind).toMatchObject({ ok: false });
      expect((resp as { error: string }).error, kind).toMatch(/coordination topic an external caller opened/);
    }
    expect(r.sent).toEqual([]);
  });

  it('keeps every command that can name a channel guarded or explicitly exempt', () => {
    const exempt: Record<string, string> = {
      'fetch-messages': 'reads the conversation; it writes nothing',
      schedule: 'ScheduleService refuses a coordination topic before any run, card or notice',
    };
    for (const spec of REVERSE_COMMANDS) {
      if (spec.channel === false) continue;
      const name = spec.usage.split(' ')[0]!;
      const guarded = COORDINATION_WRITE_ACTIONS.has(name as IpcAction['kind']);
      expect(guarded || name in exempt, `${name} accepts --channel but is neither guarded nor exempt`).toBe(true);
    }
  });

  it('finds the topic under per_channel, where every thread shares one conversation id', async () => {
    writeRecord(2);
    const r = await rig('per_channel');
    await r.inbound(WEB_TOPIC, 'hello');
    const d = (
      r.daemon as unknown as {
        delegation: {
          handleExternal(key: string, action: IpcAction): Promise<unknown>;
          place(key: string): unknown;
          tell(place: unknown, lines: string[], shown: string[]): void;
        };
      }
    ).delegation;

    // The caller's tasks are accepted: the owner is found by scanning the records, not the lane.
    await expect(d.handleExternal('web#main', { kind: 'task-list' })).resolves.toMatchObject({ tasks: [], total: 0 });

    // tell shows the update in the topic, never starts a turn there.
    const before = r.tokens.length;
    d.tell(d.place('web#main'), ['a sub-task finished'], ['🔔 part finished']);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.tokens).toHaveLength(before);
    expect(r.sent.at(-1)).toMatchObject({
      platform: 'web',
      address: { channel: 'main', thread: 'e1000000' },
      text: '🔔 part finished',
    });
  });
});

describe('channels', () => {
  it('lists every place a turn has run, as ids --channel accepts, marking the caller', async () => {
    const r = await rig();
    await r.inbound(TG_TOPIC, 'hello');
    await r.inbound(WEB_TOPIC, 'hi from the browser');
    const resp = await callDaemon(r.socket, { kind: 'list-channels' }, r.tokens[0]!);
    expect(resp.ok).toBe(true);
    const data = (resp as { data: ListChannelsResult }).data;
    const ids = data.channels.map((c) => `${c.kind}:${c.id}`);
    expect(ids).toEqual(expect.arrayContaining(['channel:tg:586', 'channel:web:main', 'topic:tg:586/8068', 'topic:web:main/t1']));
    expect(data.channels.find((c) => c.current)?.id).toBe('tg:586/8068');
    // Most recent topic first: the web topic ran last.
    expect(data.channels.filter((c) => c.kind === 'topic')[0]!.id).toBe('web:main/t1');
  });

  it('refuses an unknown --platform by name instead of answering with an empty list', async () => {
    const r = await rig();
    await r.inbound(TG_TOPIC, 'hello');
    const resp = await callDaemon(r.socket, { kind: 'list-channels', platform: 'discord' }, r.tokens[0]!);
    expect(resp).toMatchObject({ ok: false });
    expect((resp as { error: string }).error).toMatch(/unknown platform instance "discord"; configured: tg, web/);
  });
});
