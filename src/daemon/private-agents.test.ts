import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Daemon } from './daemon.js';
import { ConversationStore } from './conversation-store.js';
import { HistoryStore } from '../history/store.js';
import { parseConfig, privateAgentWarnings } from '../config/schema.js';
import { PRIVATE_NO_SKILLS } from '../ipc/tools.js';
import type { AgentFactory } from './agent.js';
import type { IpcAction } from '../ipc/protocol.js';

/**
 * A private agent (docs/agents.md#private-agents), through the daemon: what it asks for that is
 * shared is refused, and what it said is read by no agent that is not private.
 */

const dirs: string[] = [];
const daemons: Daemon[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const factory: AgentFactory = {
  getOrCreate: () => {
    throw new Error('no agent is started in this test');
  },
  peek: () => undefined,
  dispose: () => {},
};

type Reverse = {
  setResolved(id: string | undefined, platform: string | undefined): void;
  handleGatewayQuery(action: IpcAction, address: { channel: string }): Promise<unknown>;
  handleSessionsQuery(action: IpcAction, readerPrivate?: boolean): unknown;
};

function rig(defaultAgent: 'cc' | 'secret') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-private-'));
  dirs.push(dir);
  const history = new HistoryStore(path.join(dir, 'history.db'));
  const store = new ConversationStore(path.join(dir, 'conversations.json'));
  const at = Date.UTC(2026, 10, 28, 9, 0);
  const said = (key: string, agent: string, text: string): number => {
    const session = history.session({ key, platform: 'tg', agent, at })!;
    const turn = history.startTurn(session, { agent, generation: 0, trigger: 'person', at })!;
    history.message(session, { ts: at, role: 'user', kind: 'normal', text, turn });
    history.endTurn(turn, { outcome: 'done', at: at + 1 });
    return session;
  };
  const open = said('tg#open#', 'cc', 'deploy the gateway tonight');
  const hidden = said('tg#hidden#', 'secret', 'deploy the private thing');
  const cfg = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'secret', harness: 'claude', private: true, env: { HOME: '/home/u/private' } },
    ],
    routing: { default: defaultAgent },
  });
  const daemon = new Daemon(cfg, new Map(), factory, path.join(dir, 'd.sock'), store, undefined, undefined, history);
  daemons.push(daemon);
  const reverse = (daemon as unknown as { reverse: Reverse }).reverse;
  return { history, reverse, open, hidden };
}

describe('private agents', () => {
  it('refuses every skills action from a private agent, with the text fleetherd mcp matches', async () => {
    const r = rig('secret');
    r.reverse.setResolved('tg#hidden#', 'tg');
    await expect(r.reverse.handleGatewayQuery({ kind: 'skills', action: 'categories' }, { channel: 'hidden' })).rejects.toThrow(
      PRIVATE_NO_SKILLS
    );
    await expect(
      r.reverse.handleGatewayQuery({ kind: 'skills', action: 'show', name: 'anything' }, { channel: 'hidden' })
    ).rejects.toThrow(PRIVATE_NO_SKILLS);
    r.history.close();
  });

  it('answers skills for an agent that is not private', async () => {
    const r = rig('cc');
    r.reverse.setResolved('tg#open#', 'tg');
    await expect(r.reverse.handleGatewayQuery({ kind: 'skills', action: 'categories' }, { channel: 'open' })).resolves.toBeDefined();
    r.history.close();
  });

  it("hides a private agent's conversations from every reader that is not private", () => {
    const r = rig('cc');
    const search = (readerPrivate: boolean) =>
      (r.reverse.handleSessionsQuery({ kind: 'sessions-search', query: 'deploy' }, readerPrivate) as { hits: Array<{ agent: string }> }).hits.map(
        (h) => h.agent
      );
    const list = (readerPrivate: boolean) =>
      (r.reverse.handleSessionsQuery({ kind: 'sessions-list' }, readerPrivate) as { sessions: Array<{ agent: string }> }).sessions
        .map((s) => s.agent)
        .sort();

    expect(search(false)).toEqual(['cc']);
    expect(list(false)).toEqual(['cc']);
    expect(() => r.reverse.handleSessionsQuery({ kind: 'sessions-read', session: `#${r.hidden}` })).toThrow(
      /private agent secret's; only a private agent reads it/
    );
    // A search naming the agent that found nothing lists the agents to choose from — not the private one.
    const named = r.reverse.handleSessionsQuery({ kind: 'sessions-search', query: 'deploy', agent: 'nobody' }) as { agents?: string[] };
    expect(named.agents).toEqual(['cc']);

    // A private agent reads them all.
    expect(search(true).sort()).toEqual(['cc', 'secret']);
    expect(list(true)).toEqual(['cc', 'secret']);
    expect((r.reverse.handleSessionsQuery({ kind: 'sessions-read', session: `#${r.hidden}` }, true) as { messages: unknown[] }).messages).toHaveLength(1);
    r.history.close();
  });

  it('warns about a private agent that shares its home, not one with a home of its own or a connect agent', () => {
    const cfg = parseConfig({
      platforms: { tg: { type: 'telegram', token: 't' } },
      agents: [
        { id: 'shared', harness: 'opencode', private: true },
        { id: 'own', harness: 'codex', private: true, env: { HOME: '~/private' } },
        { id: 'web', harness: 'custom', private: true, connect: { url: 'tcp://agent-svc:7790' } },
        { id: 'plain', harness: 'codex' },
      ],
      routing: { default: 'plain' },
    });
    const lines = privateAgentWarnings(cfg);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/agent "shared" is private but has no env\.HOME of its own/);
  });
});
