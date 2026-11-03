import { parse } from 'yaml';
import type { Welcome } from '../remote/connection.js';
import type { RunOptions, RunResult } from '../remote/host.js';
import { PodFileSchema, type PodAgent } from '../config/schema.js';
import { readPods, writePods, type PodRecord, type PodsState } from '../config/pods.js';
import { hostProbeScript, readHostProbe } from './host-probe.js';

/**
 * Reading what each host's pod declares (config/pods.ts holds it, and says how it joins config.yaml).
 *
 * A pod says which agents it has in `~/.talkcode/pod.yaml`. Without that file the gateway looks on
 * the pod's login PATH — the PATH its agents start with (remote/shellenv.go) — for the harness
 * commands it knows, and offers each one it finds under a short id. A host whose agents are written
 * in config.yaml instead is left alone unless it has the file: looking there would offer every one
 * of them a second time under another id.
 *
 * Read when the daemon starts and on every `/reload`. A host that cannot be reached, or whose file
 * does not validate, keeps what was read before — one bad line on a pod must not take its working
 * agents away — and the reason goes into the reload's answer.
 */

export const POD_FILE = '.talkcode/pod.yaml';
/** A pod file larger than this is not a list of agents. */
const POD_FILE_MAX = 64 << 10;

/**
 * What the gateway offers when a pod has no file: the command that has to be on its PATH, and the
 * agent that command makes. Commands are the presets' own (agent-acp.ts resolveHarness, run
 * remotely). CodeBuddy has no preset: `codebuddy --acp` is its ACP mode (`codebuddy --help`,
 * 2.179.3, 2026-11-03; it already ran that way as a `custom` agent on uniagent).
 */
const PROBES: ReadonlyArray<{ command: string; agent: PodAgent }> = [
  { command: 'claude-agent-acp', agent: agent({ id: 'cc', harness: 'claude' }) },
  { command: 'codex-acp', agent: agent({ id: 'cx', harness: 'codex' }) },
  { command: 'opencode', agent: agent({ id: 'oc', harness: 'opencode' }) },
  { command: 'agy', agent: agent({ id: 'ag', harness: 'agy' }) },
  { command: 'codebuddy', agent: agent({ id: 'cbc', harness: 'custom', command: 'codebuddy', args: ['--acp'] }) },
];

function agent(a: Pick<PodAgent, 'id' | 'harness'> & Partial<PodAgent>): PodAgent {
  return { args: [], env: {}, permissions: 'auto', ...a };
}

/** The parts of a RemoteHost this reads with (a fake in tests). */
export interface PodHost {
  readonly id: string;
  ready(): Promise<Welcome>;
  stat(path: string, timeoutMs?: number): Promise<{ exists: boolean; dir?: boolean }>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  run(o: RunOptions, signal?: AbortSignal): Promise<RunResult>;
}

/** One host's outcome: a record to keep, nothing (agents in config.yaml), or why it kept the old one. */
export type PodRead = { kind: 'record'; record: PodRecord } | { kind: 'none' } | { kind: 'kept'; note: string };

/**
 * Read one host's pod. `configured`: config.yaml already defines agents on this host.
 * Bounded by `timeoutMs` as a whole — a host that is down queues requests rather than failing them.
 */
export async function readPod(host: PodHost, configured: boolean, timeoutMs: number, now = new Date()): Promise<PodRead> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([readPodUnbounded(host, configured, abort.signal, now), deadline]);
  } catch (e) {
    return { kind: 'kept', note: `${host.id}: not read (${e instanceof Error ? e.message : String(e)}); kept what was read before` };
  } finally {
    clearTimeout(timer);
  }
}

async function readPodUnbounded(host: PodHost, configured: boolean, signal: AbortSignal, now: Date): Promise<PodRead> {
  const w = await host.ready();
  const file = `${w.home}/${POD_FILE}`;
  if ((await host.stat(file)).exists) {
    const text = (await host.readFile(file, POD_FILE_MAX)).toString('utf8');
    let doc: unknown;
    try {
      doc = parse(text) ?? {};
    } catch (e) {
      return { kind: 'kept', note: `${host.id}: ~/${POD_FILE} is not valid YAML (${firstLine(e)}); kept what was read before` };
    }
    const parsed = PodFileSchema.safeParse(doc);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ');
      return { kind: 'kept', note: `${host.id}: ~/${POD_FILE}: ${issues}; kept what was read before` };
    }
    const ids = parsed.data.agents.map((a) => a.id);
    const twice = ids.find((id, i) => ids.indexOf(id) !== i);
    if (twice) return { kind: 'kept', note: `${host.id}: ~/${POD_FILE} names agent "${twice}" twice; kept what was read before` };
    const record: PodRecord = { source: 'file', agents: parsed.data.agents, at: now.toISOString() };
    if (parsed.data.peer !== undefined) {
      const key = await peerKey(host, signal);
      if (typeof key !== 'string') return { kind: 'kept', note: `${host.id}: ${key.error}; kept what was read before` };
      record.peer = { key, ...(parsed.data.peer?.ssh ? { ssh: parsed.data.peer.ssh } : {}) };
    }
    return { kind: 'record', record };
  }
  if (configured) return { kind: 'none' };
  const script = hostProbeScript(PROBES.map((p) => ({ command: p.command })));
  const r = await host.run({ argv: ['sh', '-c', script], timeoutMs: 15_000 }, signal);
  if (r.spawnError || r.code !== 0) {
    return { kind: 'kept', note: `${host.id}: could not look for agents (${r.spawnError || r.stderr?.trim() || `exit ${r.code}`}); kept what was read before` };
  }
  const { missing, unchecked } = readHostProbe(PROBES.map((p) => ({ command: p.command })), r.output.toString('utf8'));
  const found = PROBES.filter((p) => !missing.includes(p.command) && !unchecked.includes(p.command)).map((p) => p.agent);
  return { kind: 'record', record: { source: 'probe', agents: found, at: now.toISOString() } };
}

/** Where a pod keeps what the mesh needs (pod-peers.ts): its key, and the files the gateway writes. */
export const PEER_DIR = '.talkcode/ssh';

/**
 * The pod's mesh key, made on the pod the first time (so the private half never leaves it), as
 * `<type> <base64>`. ssh-keygen is there wherever sshd is.
 */
async function peerKey(host: PodHost, signal: AbortSignal): Promise<string | { error: string }> {
  const d = `"$HOME/${PEER_DIR}"`;
  const script =
    `mkdir -p ${d} && chmod 700 ${d} && ` +
    `{ test -f ${d}/id_ed25519 || ssh-keygen -q -t ed25519 -N "" -C talkcode-peer@${host.id} -f ${d}/id_ed25519 </dev/null; } && ` +
    `cat ${d}/id_ed25519.pub`;
  const r = await host.run({ argv: ['sh', '-c', script], timeoutMs: 15_000 }, signal);
  const key = /^(ssh-ed25519 [A-Za-z0-9+/=]+)/.exec(r.output.toString('utf8').trim())?.[1];
  if (r.code === 0 && key) return key;
  return { error: `peer: could not make its key in ~/${PEER_DIR} (${r.spawnError || r.stderr?.trim() || `exit ${r.code}`})` };
}

/** The hosts config.yaml itself places agents on (raw file: `agents[].host`). */
export function hostsWithConfiguredAgents(raw: Record<string, unknown> | undefined): Set<string> {
  const agents = Array.isArray(raw?.agents) ? (raw.agents as unknown[]) : [];
  return new Set(
    agents.flatMap((a) => (a && typeof a === 'object' && typeof (a as { host?: unknown }).host === 'string' ? [(a as { host: string }).host] : []))
  );
}

/**
 * Read every host's pod at once and write pods.json when what they declare changed. Returns whether
 * it did, and a line for each host that kept its old entry. Hosts no longer configured lose theirs.
 */
export async function refreshPods(opts: {
  dir: string;
  hostIds: readonly string[];
  host(id: string): PodHost | undefined;
  configured: Set<string>;
  timeoutMs: number;
}): Promise<PodsRefresh> {
  const before = readPods(opts.dir);
  const after: PodsState = {};
  const notes: string[] = [];
  const reads = await Promise.all(
    opts.hostIds.map(async (id) => {
      const host = opts.host(id);
      return [id, host ? await readPod(host, opts.configured.has(id), opts.timeoutMs) : ({ kind: 'none' } as const)] as const;
    })
  );
  const answered = reads.filter(([, r]) => r.kind !== 'kept').map(([id]) => id);
  for (const [id, read] of reads) {
    if (read.kind === 'record') {
      const old = before[id];
      // Unchanged keeps its old time, so a file that did not change is not rewritten.
      after[id] = old && same(old, read.record) ? old : read.record;
    } else if (read.kind === 'kept') {
      notes.push(read.note);
      if (before[id]) after[id] = before[id];
    }
  }
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) writePods(opts.dir, after);
  return { changed, notes, read: answered };
}

/** What one pass over the pods did. */
export interface PodsRefresh {
  /** pods.json changed, so the config has to be read again for it to apply. */
  changed: boolean;
  /** One line per host that kept what it had, and why. */
  notes: string[];
  /** The hosts answered this time — the ones the mesh files can be written to now. */
  read: string[];
}

function same(a: PodRecord, b: PodRecord): boolean {
  return a.source === b.source && JSON.stringify([a.agents, a.peer]) === JSON.stringify([b.agents, b.peer]);
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
}
