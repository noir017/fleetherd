import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from './daemon.js';
import { loadConfig } from '../config/load.js';
import { parseConfig, type Config } from '../config/schema.js';
import { applyConfig, describeReload, diffConfig } from './config-reload.js';
import { renderResult } from '../commands/reverse.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, ReclaimState } from './agent.js';
import type { InboundMessage, SlashCommandSpec } from '../types.js';

/**
 * Reloading config.yaml into a running daemon (`/reload`, `talkcode reload`).
 *
 * The pure half is checked directly. The rest runs a real Daemon against a real file, because what
 * matters is what the RUNNING daemon does afterwards: who answers the next message, which agent
 * processes are ended and when, and that a file which does not load changes nothing at all —
 * process.env included.
 */

const base = (over: Record<string, unknown> = {}): Config =>
  parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'oc', harness: 'opencode' },
    ],
    routing: { default: 'cc' },
    ...over,
  });

describe('diffConfig', () => {
  it('names agents added, removed and changed, and nothing else when nothing else moved', () => {
    const live = base();
    const next = base({
      agents: [
        { id: 'cc', harness: 'claude', args: ['--verbose'] },
        { id: 'oc2', harness: 'custom', command: 'ssh' },
      ],
    });
    expect(diffConfig(live, next)).toEqual({
      agentsAdded: ['oc2'],
      agentsRemoved: ['oc'],
      agentsChanged: ['cc'],
      sections: [],
      restartNeeded: [],
    });
  });

  it('is not fooled by key order — /setting appends the field it writes', () => {
    const live = base();
    // What `/setting model.cc x` does to the live object: the key lands last.
    live.agents[0]!.model = 'x';
    const next = base({ agents: [{ model: 'x', harness: 'claude', id: 'cc' }, { id: 'oc', harness: 'opencode' }] });
    expect(diffConfig(live, next).agentsChanged).toEqual([]);
  });

  it('lists live sections that changed, and platforms as restart-only', () => {
    const next = base({
      routing: { default: 'oc' },
      access: { allowFrom: ['tg:1'] },
      platforms: { tg: { type: 'telegram', token: 'rotated' }, web: { type: 'webui', token: 'w' } },
    });
    const d = diffConfig(base(), next);
    expect(d.sections).toEqual(['routing', 'access']);
    expect(d.restartNeeded).toEqual(['platforms.tg', 'platforms.web']);
  });
});

describe('applyConfig', () => {
  it('writes into the live object, keeping the agents array everyone already holds', () => {
    const live = base();
    const agentsRef = live.agents;
    const next = base({ agents: [{ id: 'cc', harness: 'claude' }, { id: 'cx', harness: 'codex' }], routing: { default: 'cx' } });
    applyConfig(live, next);
    expect(live.agents).toBe(agentsRef);
    expect(live.agents.map((a) => a.id)).toEqual(['cc', 'cx']);
    expect(live.routing.default).toBe('cx');
  });

  it('leaves platforms alone: the running adapters were built from them', () => {
    const live = base();
    applyConfig(live, base({ platforms: { tg: { type: 'telegram', token: 'rotated' } } }));
    expect(live.platforms.tg).toMatchObject({ token: 't' });
  });
});

describe('describeReload', () => {
  const none = { now: 0, afterTurn: 0, kept: 0 };
  it('says so when nothing changed', () => {
    expect(describeReload(diffConfig(base(), base()), none, [])).toBe('config.yaml reloaded: nothing changed.');
  });

  it('names .env variables but never their values', () => {
    const out = describeReload(diffConfig(base(), base()), none, ['OC_KEY']);
    expect(out).toContain('.env: OC_KEY');
  });

  it('reports what happens to running conversations and what still needs a restart', () => {
    const d = diffConfig(base(), base({ platforms: { tg: { type: 'telegram', token: 'x' } } }));
    const out = describeReload(d, { now: 2, afterTurn: 1, kept: 1 }, []);
    expect(out).toContain('2 restart their agent on the next message');
    expect(out).toContain('1 after the turn now running');
    expect(out).toContain('1 stay on the old definition until /new');
    expect(out).toContain('needs a daemon restart to take effect: platforms.tg');
  });
});

// ─────────────────────────────── the running daemon ───────────────────────────────

const FILE = `version: 1
platforms:
  tg:
    type: telegram
    token: tok
agents:
  - id: cc
    harness: claude
  - id: oc
    harness: opencode
  - id: dumb
    harness: custom
    command: /bin/true
routing:
  default: cc
  pipeline:
    - when: { command: oc }
      use: { agent: oc }
    - when: { command: dumb }
      use: { agent: dumb }
`;

let dir: string;
let file: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-reload-'));
  file = path.join(dir, 'config.yaml');
  for (const k of ['TALKCODE_CONFIG_FILE', 'RELOAD_KEY']) savedEnv[k] = process.env[k];
  process.env.TALKCODE_CONFIG_FILE = file;
  delete process.env.RELOAD_KEY;
  fs.writeFileSync(file, FILE);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const edit = (from: string, to: string): void => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to));

/** A daemon on the file above, with agents whose turns the test holds open and releases. */
function rig() {
  const sent: string[] = [];
  const registered: SlashCommandSpec[][] = [];
  const sessions = new Map<string, AgentSession & { agentId: string }>();
  const disposed: string[] = [];
  const turnsBy: string[] = [];
  let release: (() => void) | undefined;
  let holdTurns = false;

  const agents: AgentFactory = {
    getOrCreate(conversationId, agentId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          agentId,
          runTurn: async () => {
            turnsBy.push(agentId);
            if (holdTurns) await new Promise<void>((r) => (release = r));
          },
          abort: () => {},
          dispose: () => {},
          // The custom agent stands for a harness that cannot reload a session.
          reclaimState: (): ReclaimState => (agentId === 'dumb' ? 'unresumable' : 'resumable'),
        } as AgentSession & { agentId: string };
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => {
      if (sessions.delete(id)) disposed.push(id);
    },
  };

  const platform = {
    platform: 'tg',
    platformType: 'telegram',
    capabilities: { thread: true, editMessage: true, reaction: true, reply: true, slashCommands: true, typing: true, maxMessageLength: 4096 },
    sendMessage: async (address: { channel: string }, body: string) => {
      sent.push(body);
      return { address, messageId: `m${sent.length}` };
    },
    registerCommands: async (specs: SlashCommandSpec[]) => void registered.push(specs),
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const loaded = loadConfig();
  const cfg: Config = { ...loaded, inbound: { ...loaded.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
  const daemon = new Daemon(cfg, new Map([['tg', platform]]), agents, path.join(dir, 'd.sock'));
  const d = daemon as unknown as {
    onInbound(m: InboundMessage): void;
    reloadConfig(): { ok: boolean; summary: string };
    handleGatewayQuery(action: { kind: 'reload-config' }, address: { channel: string }): unknown;
  };

  let n = 0;
  const send = async (content: string, channel = 'c1'): Promise<void> => {
    d.onInbound({
      conversation: { platform: 'tg', channel, kind: 'direct', user: 'u1' },
      messageId: `in${++n}`,
      content,
      timestamp: Date.now(),
      mentionedSelf: true,
    });
    await drain();
  };
  return {
    cfg, daemon: d, send, sent, registered, sessions, disposed, turnsBy,
    replies: () => sent.filter((t) => !t.startsWith('🤖')),
    hold: () => void (holdTurns = true),
    finish: async () => {
      holdTurns = false;
      release?.();
      await drain();
    },
  };
}

describe('/reload in a running daemon', () => {
  it('applies a new agent and answers with what changed', async () => {
    const r = rig();
    const agentsRef = r.cfg.agents;
    edit('routing:', '  - id: cx\n    harness: codex\nrouting:');
    await r.send('/reload');
    expect(r.replies().at(-1)).toContain('agents: added cx');
    expect(r.cfg.agents).toBe(agentsRef);
    expect(r.cfg.agents.map((a) => a.id)).toContain('cx');
    // A new harness means a new agent command, so the menu is registered again — with it.
    expect(r.registered.at(-1)?.map((s) => s.name)).toContain('cx');
  });

  it('does not re-register the menu when its set did not change', async () => {
    const r = rig();
    edit('default: cc', 'default: oc');
    await r.send('/reload');
    expect(r.replies().at(-1)).toContain('applied: routing');
    expect(r.registered).toHaveLength(0);
    expect(r.cfg.routing.default).toBe('oc');
  });

  it('clears the delegation confirmations whenever a reload changes its tier', async () => {
    const r = rig();
    const { delegation } = r.daemon as unknown as { delegation: { forgetConfirmations(): void } };
    const forget = vi.spyOn(delegation, 'forgetConfirmations');

    edit('routing:', 'delegation:\n  confirm: false\nrouting:');
    await r.send('/reload');
    expect(forget).toHaveBeenCalledTimes(1);

    // Same tier again: no diff, nothing to forget.
    await r.send('/reload');
    expect(forget).toHaveBeenCalledTimes(1);

    // Away and back across two reloads, with no `task-new` in between — the case a comparison at
    // proposal time cannot see, because the value it would compare against is the same again.
    edit('confirm: false', 'confirm: first');
    await r.send('/reload');
    expect(forget).toHaveBeenCalledTimes(2);
    edit('confirm: first', 'confirm: true');
    await r.send('/reload');
    expect(forget).toHaveBeenCalledTimes(3);

    // An unrelated section does not touch it.
    edit('default: cc', 'default: oc');
    await r.send('/reload');
    expect(forget).toHaveBeenCalledTimes(3);
  });

  it('changes nothing when the file does not load, and says why', async () => {
    const r = rig();
    edit('harness: opencode', 'harness: nonsense');
    await r.send('/reload');
    const answer = r.replies().at(-1)!;
    expect(answer).toContain('was not reloaded — nothing changed');
    expect(answer).toContain('agents.1.harness');
    // Not the startup advice: the wizard is interactive, and neither a chat user nor an agent can run it.
    expect(answer).not.toContain('talkcode setup');
    expect(r.cfg.agents[1]!.harness).toBe('opencode');
  });

  it('ends an idle conversation\'s process now, and a busy one\'s when its turn ends', async () => {
    const r = rig();
    await r.send('hi', 'idle');
    r.hold();
    await r.send('hi', 'busy');
    edit('  - id: cc\n    harness: claude', '  - id: cc\n    harness: claude\n    args: [--verbose]');
    const reply = r.daemon.reloadConfig().summary;
    expect(reply).toContain('changed cc');
    expect(reply).toContain('1 restart their agent on the next message');
    expect(reply).toContain('1 after the turn now running');
    expect(r.disposed).toEqual(['tg#idle#']);
    await r.finish();
    expect(r.disposed).toEqual(['tg#idle#', 'tg#busy#']);
  });

  it('leaves a conversation on a harness that cannot resume alone, rather than restart it blank', async () => {
    const r = rig();
    await r.send('/dumb hi', 'd1');
    edit('command: /bin/true', 'command: /bin/false');
    expect(r.daemon.reloadConfig().summary).toContain('1 stay on the old definition until /new');
    expect(r.disposed).toEqual([]);
  });

  it('moves a conversation bound to a removed agent to whoever routing picks now', async () => {
    const r = rig();
    await r.send('/oc hi', 'o1');
    expect(r.turnsBy).toEqual(['oc']);
    edit('  - id: oc\n    harness: opencode\n', '');
    edit('    - when: { command: oc }\n      use: { agent: oc }\n', '');
    expect(r.daemon.reloadConfig().summary).toContain('removed oc');
    await r.send('still there?', 'o1');
    expect(r.turnsBy).toEqual(['oc', 'cc']);
  });

  it('re-reads .env, and leaves process.env alone when the config fails', async () => {
    const r = rig();
    const env = path.join(dir, '.env');
    edit('command: /bin/true', 'command: /bin/true\n    env: { KEY: "${RELOAD_KEY}" }');
    fs.writeFileSync(env, 'RELOAD_KEY=one\n');
    expect(r.daemon.reloadConfig().summary).toContain('.env: RELOAD_KEY');
    expect(process.env.RELOAD_KEY).toBe('one');

    fs.writeFileSync(env, 'RELOAD_KEY=two\n');
    edit('harness: opencode', 'harness: nonsense');
    expect(r.daemon.reloadConfig().ok).toBe(false);
    expect(process.env.RELOAD_KEY).toBe('one');

    edit('harness: nonsense', 'harness: opencode');
    r.daemon.reloadConfig();
    expect(process.env.RELOAD_KEY).toBe('two');
    expect(r.cfg.agents.find((a) => a.id === 'dumb')?.env).toEqual({ KEY: 'two' });
  });
});

describe('talkcode reload', () => {
  // Answered once the hosts' pods have been read again (daemon.ts reloadAll), hence awaited.
  it('prints the same summary /reload posts', async () => {
    const r = rig();
    edit('default: cc', 'default: oc');
    const data = await r.daemon.handleGatewayQuery({ kind: 'reload-config' }, { channel: 'c1' });
    expect(renderResult({ kind: 'reload-config' }, data).stdout).toContain('applied: routing');
  });

  it('fails — non-zero exit for the agent — when the file does not load', async () => {
    const r = rig();
    edit('harness: opencode', 'harness: nonsense');
    await expect(r.daemon.handleGatewayQuery({ kind: 'reload-config' }, { channel: 'c1' })).rejects.toThrow(/nothing changed/);
  });
});
