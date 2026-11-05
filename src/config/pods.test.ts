import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergePodAgents, podAgentModels, readPods, writePods, type PodsState } from './pods.js';
import { readConfig } from './load.js';
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

describe('readConfig with pods.json', () => {
  let dir: string;
  const saved = process.env.TALKCODE_CONFIG_FILE;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-pods-'));
    process.env.TALKCODE_CONFIG_FILE = path.join(dir, 'config.yaml');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TALKCODE_CONFIG_FILE;
    else process.env.TALKCODE_CONFIG_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const yaml = `platforms:
  tg: { type: telegram, token: t }
hosts:
  box: { ssh: u@box }
routing:
  default: cc@box
`;

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

  it('reads a missing or broken pods.json as no pods', () => {
    expect(readPods(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, 'pods.json'), '{nope');
    expect(readPods(dir)).toEqual({});
  });
});
