import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Daemon } from './daemon.js';
import { ConversationStore } from './conversation-store.js';
import { HistoryStore } from '../history/store.js';
import { parseConfig } from '../config/schema.js';
import type { AgentFactory } from './agent.js';
import type { IpcAction } from '../ipc/protocol.js';

/**
 * `sessions read --turn done` after `/new`, end to end through the daemon.
 *
 * The store alone cannot answer this: after `/new` its newest turn still belongs to the
 * generation the person discarded, and no turn of the new one exists yet. Only conversations.json
 * knows the reset happened, so the daemon has to pass it in. A store test with a hand-written
 * `current` would keep passing if that wiring were dropped — this one would not.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const factory: AgentFactory = {
  getOrCreate: () => {
    throw new Error('no agent is started in this test');
  },
  peek: () => undefined,
  dispose: () => {},
};

describe('sessions read over the daemon', () => {
  it('answers --turn done from conversations.json, not the newest library turn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-sessions-read-'));
    dirs.push(dir);
    const history = new HistoryStore(path.join(dir, 'history.db'));
    const store = new ConversationStore(path.join(dir, 'conversations.json'));
    const at = Date.UTC(2026, 10, 5, 9, 0);
    const session = history.session({ key: 'tg#ctx#', platform: 'tg', agent: 'cc', at })!;
    const t1 = history.startTurn(session, { agent: 'cc', generation: 0, trigger: 'person', at })!;
    history.message(session, { ts: at, role: 'user', kind: 'normal', text: '重置前', turn: t1 });
    history.endTurn(t1, { outcome: 'done', at: at + 1 });

    const cfg = parseConfig({
      platforms: { tg: { type: 'telegram', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc' },
    });
    const daemon = new Daemon(cfg, new Map(), factory, path.join(dir, 'd.sock'), store, undefined, undefined, history);
    const query = (
      daemon as unknown as { handleSessionsQuery(action: IpcAction): unknown }
    ).handleSessionsQuery.bind(daemon);

    // Before `/new`: the newest turn is the live context's, and it is the answer.
    expect(
      (query({ kind: 'sessions-read', session: `#${session}`, turn: 'done' }) as { messages: unknown[] }).messages
    ).toHaveLength(1);

    // `/new`: generation 1, no turn run in it yet. The old answer is not this context's.
    store.setGeneration('tg#ctx#', 'cc', 1);
    const afterNew = query({ kind: 'sessions-read', session: `#${session}`, turn: 'done' }) as {
      messages: unknown[];
      note?: string;
    };
    expect(afterNew.messages).toEqual([]);
    expect(afterNew.note).toMatch(/for agent cc in generation 1 yet/);

    history.close();
  });

  it('reads the topic id every other command prints, and still the key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-sessions-topic-'));
    dirs.push(dir);
    const history = new HistoryStore(path.join(dir, 'history.db'));
    const store = new ConversationStore(path.join(dir, 'conversations.json'));
    const at = Date.UTC(2026, 10, 5, 9, 0);
    // What the web UI stores: platform, channel, thread, joined by `#` — while `channels`, the
    // update cards and `tasks` all print `web:main/c962cd3f`.
    const session = history.session({ key: 'web#main#c962cd3f', platform: 'web', agent: 'cc', at })!;
    history.message(session, { ts: at, role: 'user', kind: 'normal', text: '在吗' });

    const cfg = parseConfig({
      platforms: { web: { type: 'webui', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc' },
    });
    const daemon = new Daemon(cfg, new Map(), factory, path.join(dir, 'd.sock'), store, undefined, undefined, history);
    const query = (
      daemon as unknown as { handleSessionsQuery(action: IpcAction): unknown }
    ).handleSessionsQuery.bind(daemon);

    for (const ref of ['web:main/c962cd3f', 'web#main#c962cd3f', `#${session}`]) {
      const read = query({ kind: 'sessions-read', session: ref }) as { messages: Array<{ text: string }> };
      expect(read.messages.map((m) => m.text), ref).toEqual(['在吗']);
    }
    history.close();
  });
});
