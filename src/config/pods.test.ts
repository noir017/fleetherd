import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergePodAgents, podAgentModels, readPods, writePods, type PodsState } from './pods.js';
import { instructionsHome, instructionsOff } from './instructions.js';
import { loadConfig, readConfig } from './load.js';
import { ConfigSchema, PodFileSchema } from './schema.js';

/**
 * The agents hosts' pods declared (pods.json) joining config.yaml's: named `<id>@<host>`, in the
 * order of `hosts:`, never over an id config.yaml uses, and never failing the config for one bad
 * entry.
 */

const record = (agents: unknown[]): PodsState[string] => ({ source: 'file', agents, at: '2026-11-03T00:00:00.000Z' });

describe('mergePodAgents', () => {
  const raw = {
    hosts: { b: { ssh: 'u@b' }, a: { ssh: 'u@a' } },
    agents: [{ id: 'cc', harness: 'claude' }, { id: 'oc@a', harness: 'opencode', host: 'a', model: 'mine' }],
  };

  it('names each agent <id>@<host>, places it on that host, and follows the order of hosts:', () => {
    const { raw: out } = mergePodAgents(raw, {
      a: record([{ id: 'ag', harness: 'agy' }]),
      b: record([{ id: 'oc', harness: 'opencode', model: 'x' }]),
    });
    const ids = (out.agents as Array<{ id: string; host?: string }>).map((a) => `${a.id}:${a.host ?? ''}`);
    expect(ids).toEqual(['cc:', 'oc@a:a', 'oc@b:b', 'ag@a:a']);
  });

  it("keeps a connect agent's address, token file and meta as the pod wrote them", () => {
    const connect = { url: 'tcp://wad:7790', tokenFile: '~/.wad/token', meta: { wad: { site: 'gemini-task', profile: 'a,b' } } };
    const { raw: out, skipped } = mergePodAgents(raw, { a: record([{ id: 'web', harness: 'custom', connect, permissions: 'ask' }]) });
    expect(skipped).toEqual([]);
    expect((out.agents as Array<Record<string, unknown>>).find((a) => a.id === 'web@a')).toMatchObject({ host: 'a', connect });
  });

  it('leaves an id config.yaml already defines to config.yaml', () => {
    const { raw: out } = mergePodAgents(raw, { a: record([{ id: 'oc', harness: 'opencode', model: 'theirs' }]) });
    const oc = (out.agents as Array<{ id: string; model?: string }>).filter((a) => a.id === 'oc@a');
    expect(oc).toEqual([expect.objectContaining({ model: 'mine' })]);
  });

  it('brings nothing from a host that is no longer under hosts:', () => {
    const { raw: out } = mergePodAgents(raw, { gone: record([{ id: 'oc', harness: 'opencode' }]) });
    expect(out).toBe(raw);
  });

  it('leaves out an entry that does not validate, and says which, without failing the rest', () => {
    const { raw: out, skipped } = mergePodAgents(raw, {
      a: record([{ id: 'x', harness: 'nope' }, { id: 'ag', harness: 'agy' }]),
    });
    expect((out.agents as Array<{ id: string }>).map((a) => a.id)).toContain('ag@a');
    expect(skipped).toEqual([expect.stringMatching(/^a: agents\[0\]\.harness: /)]);
  });

  // Agent env is ${VAR}-expanded again at spawn, from the GATEWAY's environment (agent-common.ts
  // expandEnv). A pod that could write ${TELEGRAM_BOT_TOKEN} would be handed the bot token.
  it("refuses ${VAR} in a pod's env, so a pod cannot read the gateway's environment", () => {
    const { raw: out, skipped } = mergePodAgents(raw, {
      a: record([{ id: 'ag', harness: 'agy', env: { X: '${TELEGRAM_BOT_TOKEN}' } }]),
    });
    expect(out).toBe(raw);
    expect(skipped[0]).toMatch(/env\.X: pod\.yaml is used as written/);
    expect(PodFileSchema.safeParse({ agents: [{ id: 'ag', harness: 'agy', env: { X: 'a${B}' } }] }).success).toBe(false);
  });

  it('refuses a pod agent id that already carries an @ or a host', () => {
    expect(PodFileSchema.safeParse({ agents: [{ id: 'oc@x', harness: 'opencode' }] }).success).toBe(false);
    expect(PodFileSchema.safeParse({ agents: [{ id: 'oc', harness: 'opencode', host: 'x' }] }).success).toBe(true);
    // …where `host` is dropped: the pod's agents run on the pod.
    const parsed = PodFileSchema.parse({ agents: [{ id: 'oc', harness: 'opencode', host: 'x' }] });
    expect(parsed.agents[0]).not.toHaveProperty('host');
  });

  it("defaults a pod agent's instruction layer to its pod.yaml id, without the host", () => {
    const { raw: out } = mergePodAgents(raw, {
      a: record([
        { id: 'mh', harness: 'custom', command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md' } },
        {
          id: 'ex',
          harness: 'custom',
          command: 'my-harness',
          instructions: { file: '~/.my-harness/OTHER.md', layer: 'mine' },
        },
      ]),
    });
    const byId = Object.fromEntries(
      (out.agents as Array<{ id: string; instructions?: { file: string; layer?: string } }>).map((a) => [a.id, a.instructions])
    );
    expect(byId['mh@a']).toEqual({ file: '~/.my-harness/AGENTS.md', layer: 'mh' });
    expect(byId['ex@a']).toEqual({ file: '~/.my-harness/OTHER.md', layer: 'mine' });
    expect(byId['cc']).toBeUndefined();
  });

  // A host must never be able to keep the gateway's config from loading, so a pod's agent yields to
  // config.yaml's on the same machine — but it stays an agent, only its delivery is turned off.
  it('turns delivery off for a pod agent whose file a config.yaml agent already delivers', () => {
    const cfg = { hosts: { box: { ssh: 'u@box' } }, agents: [{ id: 'cc', harness: 'claude', host: 'box' }] };
    const { raw: out, skipped } = mergePodAgents(cfg, {
      box: record([{ id: 'mh', harness: 'custom', command: 'my-harness', instructions: { file: '~/.claude/CLAUDE.md' } }]),
    });
    expect(out.agents).toEqual([
      expect.objectContaining({ id: 'cc' }),
      expect.objectContaining({
        id: 'mh@box',
        instructions: { file: '~/.claude/CLAUDE.md', layer: 'mh', off: true },
      }),
    ]);
    expect(skipped).toEqual([
      'instructions.mh@box: "mh@box" (layer "mh") and "cc" (layer "claude") both deliver ~/.claude/CLAUDE.md on host "box"; "cc" keeps it, so nothing is delivered to "mh@box"',
    ]);
  });

  it('leaves two pod agents with one file and the same layer alone: they share it', () => {
    const cfg = { hosts: { box: { ssh: 'u@box' } }, agents: [] };
    const { raw: out, skipped } = mergePodAgents(cfg, {
      box: record([
        { id: 'a', harness: 'custom', command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md', layer: 'mine' } },
        { id: 'b', harness: 'custom', command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md', layer: 'mine' } },
      ]),
    });
    expect((out.agents as Array<{ id: string }>).map((a) => a.id)).toEqual(['a@box', 'b@box']);
    expect(skipped).toEqual([]);
  });
});

describe('agents[].instructions', () => {
  const base = {
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [{ id: 'mh', harness: 'custom', command: 'my-harness' }],
    routing: { default: 'mh' },
  };
  const parsed = (instructions: unknown, id = 'mh') =>
    ConfigSchema.safeParse({ ...base, agents: [{ ...base.agents[0], id, instructions }], routing: { default: id } });

  it('takes a ~ or absolute file, with a plain layer', () => {
    expect(parsed({ file: '~/.my-harness/AGENTS.md' }).success).toBe(true);
    expect(parsed({ file: '/opt/my-harness/AGENTS.md', layer: 'my-harness' }).success).toBe(true);
  });

  it('refuses a relative file, a trailing slash, a layer with a path, and common in any case', () => {
    for (const instructions of [
      { file: 'AGENTS.md' },
      { file: '~/' },
      { file: '~/.my-harness/AGENTS.md', layer: '../mine' },
      // On a case-insensitive filesystem `Common.md` IS `common.md`, the layer every agent gets.
      { file: '~/.my-harness/AGENTS.md', layer: 'common' },
      { file: '~/.my-harness/AGENTS.md', layer: 'Common' },
      { file: '~/.my-harness/AGENTS.md', layer: 'COMMON' },
    ]) {
      expect(parsed(instructions).success, JSON.stringify(instructions)).toBe(false);
    }
  });

  it('refuses an id that cannot be the default layer', () => {
    expect(parsed({ file: '~/.my-harness/AGENTS.md' }, 'a/b').success).toBe(false);
  });

  it('keeps the merge’s off marker out of pod.yaml: the gateway sets it, a pod does not', () => {
    expect(
      PodFileSchema.safeParse({
        agents: [{ id: 'a', harness: 'claude', instructions: { file: '~/.claude/CLAUDE.md', layer: 'a', off: true } }],
      }).success
    ).toBe(false);
  });
});

describe('podModels: the gateway naming a pod agent’s model', () => {
  const pods: PodsState = {
    box: record([
      { id: 'oc', harness: 'opencode', model: 'opencode/big-pickle' },
      { id: 'ag', harness: 'agy' },
    ]),
  };
  const raw = (podModels?: Record<string, string>) => ({
    hosts: { box: { ssh: 'u@box' } },
    agents: [{ id: 'cc', harness: 'claude', model: 'opus' }],
    ...(podModels ? { podModels } : {}),
  });
  const models = (out: Record<string, unknown>) =>
    Object.fromEntries((out.agents as Array<{ id: string; model?: string }>).map((a) => [a.id, a.model]));

  it('wins over the pod’s own model, and gives one to an agent the pod gave none', () => {
    const { raw: out, skipped } = mergePodAgents(raw({ 'oc@box': 'opencode/glm-5', 'ag@box': 'gemini-3.8-pro' }), pods);
    expect(models(out)).toEqual({ cc: 'opus', 'oc@box': 'opencode/glm-5', 'ag@box': 'gemini-3.8-pro' });
    expect(skipped).toEqual([]);
  });

  it('leaves the pod’s model where the gateway names none', () => {
    expect(models(mergePodAgents(raw(), pods).raw)).toEqual({ cc: 'opus', 'oc@box': 'opencode/big-pickle', 'ag@box': undefined });
  });

  it('keeps what the pod said apart, for the settings screen to show and fall back to', () => {
    const declared = podAgentModels(raw({ 'oc@box': 'opencode/glm-5' }), pods);
    expect([...declared]).toEqual([
      ['oc@box', 'opencode/big-pickle'],
      ['ag@box', undefined],
    ]);
    // config.yaml's own agent is not a pod's, whatever its id looks like.
    expect(declared.has('cc')).toBe(false);
  });

  it('ignores, and names, a key for an agent config.yaml defines: that one has agents[].model', () => {
    const own = { ...raw({ 'cc@here': 'sonnet' }), agents: [{ id: 'cc@here', harness: 'claude', model: 'opus' }] };
    const { raw: out, skipped } = mergePodAgents(own, pods);
    expect(models(out)['cc@here']).toBe('opus');
    expect(skipped).toEqual(['podModels.cc@here: cc@here is defined in config.yaml, so its model is agents[].model there']);
  });

  it('cannot be written by a pod: pod.yaml has no such field', () => {
    const r = PodFileSchema.safeParse({ agents: [{ id: 'oc', harness: 'opencode' }], podModels: { 'cc@box': 'x' } });
    expect(r.success).toBe(false);
  });

  it('is a map of <id>@<host> to a name, and nothing else', () => {
    const base = {
      platforms: { tg: { type: 'telegram', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc' },
    };
    expect(ConfigSchema.safeParse({ ...base, podModels: { 'oc@box': 'opencode/glm-5' } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ ...base, podModels: { oc: 'x' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...base, podModels: { 'oc@box': '' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...base, podModels: { 'oc@box': { harness: 'custom' } } }).success).toBe(false);
  });
});

describe('podPermissions: the gateway setting a pod agent’s permission level', () => {
  const pods: PodsState = {
    box: record([
      { id: 'oc', harness: 'opencode', permissions: 'ask' },
      { id: 'ag', harness: 'agy' },
    ]),
  };
  const levels = (out: Record<string, unknown>) =>
    Object.fromEntries((out.agents as Array<{ id: string; permissions?: string }>).map((a) => [a.id, a.permissions]));

  it('wins over the pod’s own level, and leaves the rest as the pod said', () => {
    const raw = { hosts: { box: { ssh: 'u@box' } }, agents: [{ id: 'cc', harness: 'claude' }], podPermissions: { 'oc@box': 'plan' } };
    const { raw: out, skipped } = mergePodAgents(raw, pods);
    expect(levels(out)).toEqual({ cc: undefined, 'oc@box': 'plan', 'ag@box': undefined });
    expect(skipped).toEqual([]);
  });

  it('is ignored, and said to be, for an agent config.yaml defines', () => {
    const raw = { hosts: { box: { ssh: 'u@box' } }, agents: [{ id: 'cc@here', harness: 'claude' }], podPermissions: { 'cc@here': 'full' } };
    const { raw: out, skipped } = mergePodAgents(raw, pods);
    expect(levels(out)['cc@here']).toBeUndefined();
    expect(skipped).toEqual(['podPermissions.cc@here: cc@here is defined in config.yaml, so its level is agents[].permissions there']);
  });

  it('is a map of <id>@<host> to a level, and nothing else', () => {
    const base = {
      platforms: { tg: { type: 'telegram', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc' },
    };
    expect(ConfigSchema.safeParse({ ...base, podPermissions: { 'oc@box': 'edits' } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ ...base, podPermissions: { 'oc@box': 'yolo' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...base, podPermissions: { oc: 'ask' } }).success).toBe(false);
  });
});

describe('readConfig with pods.json', () => {
  let dir: string;
  const saved = process.env.FLEETHERD_CONFIG_FILE;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-pods-'));
    process.env.FLEETHERD_CONFIG_FILE = path.join(dir, 'config.yaml');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FLEETHERD_CONFIG_FILE;
    else process.env.FLEETHERD_CONFIG_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const yaml = `platforms:
  tg: { type: telegram, token: t }
hosts:
  box: { ssh: u@box }
routing:
  default: cc@box
`;
  /** The same file, routing to a pod agent these tests declare. */
  const yamlFor = (agent: string): string => yaml.replace('default: cc@box', `default: ${agent}`);

  it('accepts routing that names a pod agent, and config.yaml needs no agents of its own', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), yaml);
    writePods(dir, { box: record([{ id: 'cc', harness: 'claude', env: { A: 'b' } }]) });
    const { config } = readConfig();
    expect(config.agents).toEqual([expect.objectContaining({ id: 'cc@box', host: 'box', harness: 'claude', env: { A: 'b' } })]);
    expect(config.routing.default).toBe('cc@box');
  });

  it('fails as before when nothing declares the agent routing names', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), yaml);
    expect(() => readConfig()).toThrow(/agents|routing\.default/);
  });

  // pods.json can hold a clash an older version wrote, or one somebody edited in. Neither may stop
  // the gateway: the first agent keeps the file, the other keeps running without delivery, and a
  // routing that names the second still loads.
  it('loads, and starts, with a pods.json whose agents fight over one file — routing included', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), yamlFor('b@box'));
    writePods(dir, {
      box: record([
        { id: 'a', harness: 'custom', command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md' } },
        { id: 'b', harness: 'custom', command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md' } },
      ]),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { config } = readConfig();
      expect(config.agents.map((a) => a.id)).toEqual(['a@box', 'b@box']);
      const b = config.agents.find((a) => a.id === 'b@box')!;
      expect(b.instructions).toEqual({ file: '~/.my-harness/AGENTS.md', layer: 'b', off: true });
      expect(instructionsOff(b)).toBe(true);
      // Its placement is still known, so the editor keeps listing the layer.
      expect(instructionsHome(b, '~')).toMatchObject({ name: 'b', file: '~/.my-harness/AGENTS.md' });
      expect(loadConfig().agents.map((a) => a.id)).toEqual(['a@box', 'b@box']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('nothing is delivered to "b@box"'));
    } finally {
      warn.mockRestore();
    }
  });

  it('lets two pod agents share one file when they name the same layer', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), yamlFor('a@box'));
    writePods(dir, {
      box: record([
        { id: 'a', harness: 'custom', command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md', layer: 'mine' } },
        { id: 'b', harness: 'custom', command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md', layer: 'mine' } },
      ]),
    });
    expect(readConfig().config.agents.map((a) => a.id)).toEqual(['a@box', 'b@box']);
  });

  it('reads a missing or broken pods.json as no pods', () => {
    expect(readPods(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, 'pods.json'), '{nope');
    expect(readPods(dir)).toEqual({});
  });

  it('refuses the merge’s off marker in config.yaml: the merge sets it, not the file', () => {
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `platforms:
  tg: { type: telegram, token: t }
agents:
  - id: cc
    harness: claude
    instructions: { file: '~/.claude/CLAUDE.md', layer: cc, off: true }
routing:
  default: cc
`
    );
    expect(() => readConfig()).toThrow(/agents\.0\.instructions\.off: this is not a setting/);
  });
});
