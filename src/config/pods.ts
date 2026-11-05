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
 *
 * `podModels` in config.yaml is folded in here: a pod agent with an entry there takes that as its
 * `model`, over the one its pod.yaml gives. Here rather than at each place a model is read, because
 * every one of them (the spawn, `/model`, the footer, a scheduled task) already reads `model`, and a
 * second field beside it would be a second answer to "what model does this agent start with". What
 * the pod itself said is kept by podAgentModels, for the settings screen to show and to fall back to.
 * A key naming an agent config.yaml defines is ignored and reported: that agent's model is
 * `agents[].model`, and two places to set one would disagree.
 */
export function mergePodAgents(raw: Record<string, unknown>, pods: PodsState): { raw: Record<string, unknown>; skipped: string[] } {
  const own = Array.isArray(raw.agents) ? (raw.agents as unknown[]) : [];
  const models = podModelsOf(raw);
  const skipped: string[] = [];
  const added = podAgents(raw, pods, skipped).map(({ agent }) => {
    const model = models[agent.id];
    return model !== undefined ? { ...agent, model } : agent;
  });
  const ownIds = new Set(own.map(idOf));
  for (const key of Object.keys(models)) {
    if (ownIds.has(key)) skipped.push(`podModels.${key}: ${key} is defined in config.yaml, so its model is agents[].model there`);
  }
  if (added.length === 0) return { raw, skipped };
  return { raw: { ...raw, agents: [...own, ...added] }, skipped };
}

/**
 * Every agent the pods declare, as mergePodAgents adds it, mapped to the model its pod.yaml gives
 * (undefined: none). What `/setting` needs to say where a pod agent's model comes from — the gateway
 * (`podModels`), the pod, or the harness — and what it falls back to when the gateway's is cleared.
 * Read from pods.json, never from the merged config, where `model` is already the gateway's answer.
 */
export function podAgentModels(raw: Record<string, unknown>, pods: PodsState): Map<string, string | undefined> {
  return new Map(podAgents(raw, pods, []).map(({ agent, model }) => [agent.id, model]));
}

type DeclaredAgent = { agent: Record<string, unknown> & { id: string }; model: string | undefined };

/** The pods' agents in merge order, validated and renamed, each with the model the pod gave it. */
function podAgents(raw: Record<string, unknown>, pods: PodsState, skipped: string[]): DeclaredAgent[] {
  const hosts = raw.hosts && typeof raw.hosts === 'object' ? Object.keys(raw.hosts) : [];
  const own = Array.isArray(raw.agents) ? (raw.agents as unknown[]) : [];
  const taken = new Set(own.map(idOf));
  const out: DeclaredAgent[] = [];
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
      out.push({ agent: { ...parsed.data, id, host }, model: parsed.data.model });
    }
  }
  return out;
}

/** `podModels` from a raw config, keeping only non-empty strings (the schema reports the rest). */
function podModelsOf(raw: Record<string, unknown>): Record<string, string> {
  const m = raw.podModels;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  return Object.fromEntries(Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
}

function idOf(a: unknown): unknown {
  return a && typeof a === 'object' ? (a as { id?: unknown }).id : undefined;
}
