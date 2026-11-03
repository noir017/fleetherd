import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../remote/host.js';
import type { Welcome } from '../remote/connection.js';
import { readPods, writePods } from '../config/pods.js';
import { hostsWithConfiguredAgents, readPod, refreshPods, type PodHost } from './pods.js';

/**
 * Reading what a pod declares: its `~/.talkcode/pod.yaml`, or — without one, and with no agents for
 * it in config.yaml — the harness commands on its login PATH. A pod that cannot be read keeps what
 * was read before.
 */

let home: string;
let bin: string;
let dir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-pod-home-'));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-pod-bin-'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-pod-cfg-'));
});
afterEach(() => {
  for (const d of [home, bin, dir]) fs.rmSync(d, { recursive: true, force: true });
});

/** A host whose files are under `home` and whose PATH is `bin` — the probe really runs, in sh. */
function host(id = 'box', opts: { down?: boolean } = {}): PodHost & { runs: number } {
  const h = {
    id,
    runs: 0,
    ready: (): Promise<Welcome> =>
      opts.down ? new Promise<Welcome>(() => {}) : Promise.resolve({ home, version: 'v', instance: 'i', pid: 1, os: 'linux', arch: 'x64', resumed: false }),
    stat: async (p: string) => ({ exists: fs.existsSync(p) }),
    readFile: async (p: string) => fs.readFileSync(p),
    run: async (o: RunOptions): Promise<RunResult> => {
      h.runs++;
      // PATH is `bin` alone, so nothing installed on the machine running the test is found.
      const r = spawnSync('/bin/sh', o.argv!.slice(1), { env: { PATH: bin }, encoding: 'buffer' });
      return { code: r.status, output: r.stdout };
    },
  };
  return h;
}

function install(...commands: string[]): void {
  for (const c of commands) {
    const f = path.join(bin, c);
    fs.writeFileSync(f, '#!/bin/sh\n');
    fs.chmodSync(f, 0o755);
  }
}

function podFile(text: string): void {
  fs.mkdirSync(path.join(home, '.talkcode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.talkcode', 'pod.yaml'), text);
}

describe('readPod', () => {
  it('reads the agents pod.yaml declares, with their settings', async () => {
    podFile('agents:\n  - id: oc\n    harness: opencode\n    model: m\n    cwd: /w\n  - { id: cbc, harness: custom, command: codebuddy, args: [--acp] }\n');
    const r = await readPod(host(), false, 5_000);
    expect(r).toMatchObject({ kind: 'record', record: { source: 'file' } });
    if (r.kind !== 'record') return;
    expect(r.record.agents).toEqual([
      expect.objectContaining({ id: 'oc', harness: 'opencode', model: 'm', cwd: '/w' }),
      expect.objectContaining({ id: 'cbc', harness: 'custom', command: 'codebuddy', args: ['--acp'] }),
    ]);
  });

  it('makes a pod in the mesh its own key, once, and reports only the public half', async () => {
    podFile('agents: []\npeer:\n  ssh: user@10.1.2.3:2222\n');
    // This test needs a real ssh-keygen, so the host's PATH includes the system's.
    const h = { ...host(), run: async (o: RunOptions): Promise<RunResult> => {
      const r = spawnSync('/bin/sh', o.argv!.slice(1), { env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'buffer' });
      return { code: r.status, output: r.stdout, stderr: r.stderr.toString() };
    } };
    const first = await readPod(h, false, 10_000);
    if (first.kind !== 'record') throw new Error(JSON.stringify(first));
    expect(first.record.peer).toEqual({ key: expect.stringMatching(/^ssh-ed25519 [A-Za-z0-9+/=]+$/), ssh: 'user@10.1.2.3:2222' });
    expect(fs.statSync(path.join(home, '.talkcode/ssh')).mode & 0o777).toBe(0o700);
    const again = await readPod(h, false, 10_000);
    expect(again.kind === 'record' && again.record.peer?.key).toBe(first.record.peer?.key);
  });

  it('reads an empty pod.yaml as a pod with no agents', async () => {
    podFile('');
    expect(await readPod(host(), false, 5_000)).toMatchObject({ kind: 'record', record: { agents: [] } });
  });

  it('without pod.yaml, offers what is on the login PATH under short ids', async () => {
    install('opencode', 'agy', 'codebuddy');
    const r = await readPod(host(), false, 5_000);
    expect(r).toMatchObject({ kind: 'record', record: { source: 'probe' } });
    if (r.kind !== 'record') return;
    expect(r.record.agents).toEqual([
      expect.objectContaining({ id: 'oc', harness: 'opencode' }),
      expect.objectContaining({ id: 'ag', harness: 'agy' }),
      expect.objectContaining({ id: 'cbc', harness: 'custom', command: 'codebuddy', args: ['--acp'] }),
    ]);
  });

  it('does not look on a host whose agents config.yaml defines — but still reads its pod.yaml', async () => {
    install('opencode');
    const h = host();
    expect(await readPod(h, true, 5_000)).toEqual({ kind: 'none' });
    expect(h.runs).toBe(0);
    podFile('agents: [{ id: ag, harness: agy }]\n');
    expect(await readPod(h, true, 5_000)).toMatchObject({ kind: 'record', record: { source: 'file' } });
  });

  it.each([
    ['not YAML', 'agents: [', /not valid YAML/],
    ['a wrong field', 'agents: [{ id: oc, harness: nope }]\n', /agents\.0\.harness/],
    ['an unknown top-level key', 'agent: []\n', /Unrecognized key/],
    ['one id twice', 'agents: [{ id: oc, harness: opencode }, { id: oc, harness: agy }]\n', /names agent "oc" twice/],
  ])('keeps what it had for %s, and says why', async (_what, text, why) => {
    podFile(text);
    const r = await readPod(host(), false, 5_000);
    expect(r.kind).toBe('kept');
    if (r.kind === 'kept') expect(r.note).toMatch(why);
  });

  it('gives up on a host that does not answer in time', async () => {
    const r = await readPod(host('box', { down: true }), false, 50);
    expect(r).toEqual({ kind: 'kept', note: expect.stringMatching(/^box: not read \(no answer/) });
  });
});

describe('refreshPods', () => {
  const run = (hosts: Record<string, PodHost>, configured = new Set<string>()) =>
    refreshPods({ dir, hostIds: Object.keys(hosts), host: (id) => hosts[id], configured, timeoutMs: 5_000 });

  it('writes pods.json when what a pod declares changed, and not when it did not', async () => {
    install('agy');
    expect((await run({ box: host() })).changed).toBe(true);
    const first = fs.statSync(path.join(dir, 'pods.json')).mtimeMs;
    expect(readPods(dir).box?.agents).toEqual([expect.objectContaining({ id: 'ag' })]);
    expect((await run({ box: host() })).changed).toBe(false);
    expect(fs.statSync(path.join(dir, 'pods.json')).mtimeMs).toBe(first);
    install('opencode');
    expect((await run({ box: host() })).changed).toBe(true);
    expect(readPods(dir).box?.agents).toHaveLength(2);
  });

  it('keeps an unreachable host’s agents, and drops a host no longer configured', async () => {
    writePods(dir, {
      box: { source: 'file', agents: [{ id: 'oc', harness: 'opencode' }], at: 't' },
      gone: { source: 'file', agents: [{ id: 'oc', harness: 'opencode' }], at: 't' },
    });
    const r = await refreshPods({ dir, hostIds: ['box'], host: () => host('box', { down: true }), configured: new Set(), timeoutMs: 50 });
    expect(r.notes).toEqual([expect.stringMatching(/^box: not read/)]);
    expect(Object.keys(readPods(dir))).toEqual(['box']);
  });
});

describe('hostsWithConfiguredAgents', () => {
  it('lists the hosts config.yaml places agents on', () => {
    expect(hostsWithConfiguredAgents({ agents: [{ id: 'a', host: 'x' }, { id: 'b' }, { id: 'c', host: 'y' }] })).toEqual(new Set(['x', 'y']));
    expect(hostsWithConfiguredAgents(undefined)).toEqual(new Set());
  });
});
