import fs from 'node:fs';
import path from 'node:path';
import { PodAgentSchema, podAgentId } from './schema.js';

/**
 * What each host's pod declared, as the gateway last read it — `<config dir>/pods.json`, written by
 * daemon/pods.ts — and how those agents join the ones in config.yaml.
 *
 * A file rather than memory because agents are config: routing names them, conversations are bound
 * to them, and both have to make sense the moment the daemon starts, before any host has been
 * reached. A host that is down at startup keeps the agents it had.
 *
 * Merged in readConfig after `${VAR}` expansion, so nothing a pod wrote is expanded with the
 * gateway's environment (schema.ts PodAgentSchema says why that matters), and before validation, so
 * routing that names a pod's agent is checked like any other.
 */

/** One host's entry. `agents` is what the pod declared, by the pod's own ids (no `@host`). */
export interface PodRecord {
  /** `file`: its `~/.talkcode/pod.yaml`; `probe`: no such file, so the commands found on its PATH. */
  source: 'file' | 'probe';
  agents: unknown[];
  /**
   * In the pod-to-pod ssh mesh (`peer:` in its pod.yaml; daemon/pod-peers.ts): its own public key,
   * and how the other pods reach it when that is not how the gateway does.
   */
  peer?: { key: string; ssh?: string };
  /** When it was read (ISO). */
  at: string;
}

export type PodsState = Record<string, PodRecord>;

export function podsPath(dir: string): string {
  return path.join(dir, 'pods.json');
}

/** The file, or nothing: a missing or unreadable one means no host has been read yet. */
export function readPods(dir: string): PodsState {
  try {
    const raw = JSON.parse(fs.readFileSync(podsPath(dir), 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as PodsState;
  } catch {
    // first run, or a file someone broke — the next read of the hosts writes a good one
  }
  return {};
}

export function writePods(dir: string, state: PodsState): void {
  const file = podsPath(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The raw config with every pod's agents appended to `agents`, as `<id>@<host>` with `host` set —
 * in the order of `hosts:`, so a harness command like `/oc` keeps reaching the same agent. An agent
 * config.yaml already defines under the same id wins, and a host no longer under `hosts:` brings
 * nothing. An entry that does not validate is left out and named in `skipped`, rather than failing
 * the whole config: a pod's typo must not stop the gateway.
 */
export function mergePodAgents(raw: Record<string, unknown>, pods: PodsState): { raw: Record<string, unknown>; skipped: string[] } {
  const hosts = raw.hosts && typeof raw.hosts === 'object' ? Object.keys(raw.hosts) : [];
  const own = Array.isArray(raw.agents) ? (raw.agents as unknown[]) : [];
  const taken = new Set(own.map((a) => (a && typeof a === 'object' ? (a as { id?: unknown }).id : undefined)));
  const added: unknown[] = [];
  const skipped: string[] = [];
  for (const host of hosts) {
    for (const [i, entry] of (pods[host]?.agents ?? []).entries()) {
      const parsed = PodAgentSchema.safeParse(entry);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        skipped.push(`${host}: agents[${i}]${issue?.path.length ? `.${issue.path.join('.')}` : ''}: ${issue?.message ?? 'invalid'}`);
        continue;
      }
      const id = podAgentId(parsed.data.id, host);
      if (taken.has(id)) continue;
      taken.add(id);
      added.push({ ...parsed.data, id, host });
    }
  }
  if (added.length === 0) return { raw, skipped };
  return { raw: { ...raw, agents: [...own, ...added] }, skipped };
}
