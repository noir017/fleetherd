import fs from 'node:fs';
import path from 'node:path';
import { AgentDefSchema, PodAgentSchema, podAgentId, type PodAgent } from './schema.js';
import { instructionClashes, instructionsHome } from './instructions.js';

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
  /** `file`: its `~/.fleetherd/pod.yaml`; `probe`: no such file, so the commands found on its PATH. */
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
 *
 * `podPermissions` is folded in the same way, into `permissions`, for the same reasons.
 *
 * `instructions.layer` is filled here when the pod left it out: its default is the agent's id, and
 * the id the gateway names a pod's agent by (`<id>@<host>`) is not the one its layer may use — the
 * pod.yaml id is, without the host. Setting it now keeps the layer stable if the host id changes
 * and saves every reader of the merged config from having to strip `@host` itself.
 *
 * An agent whose file another agent on that machine already delivers keeps its place in the list —
 * routing and conversations treat it like any other — and keeps its `file` and `layer`, with
 * `off: true` added (offInstructionClashes below): the layer stays visible in the web UI and the
 * agent's own files stay listable, but nothing is delivered. A host must not be able to keep the
 * gateway from starting, and an agent it declared must not disappear from under a routing rule.
 */
export function mergePodAgents(raw: Record<string, unknown>, pods: PodsState): { raw: Record<string, unknown>; skipped: string[] } {
  const own = Array.isArray(raw.agents) ? (raw.agents as unknown[]) : [];
  const models = podStringsOf(raw, 'podModels');
  const levels = podStringsOf(raw, 'podPermissions');
  const skipped: string[] = [];
  const declared = podAgents(raw, pods, skipped);
  const off = offInstructionClashes(own, declared, skipped);
  const added = declared.map(({ agent }) => {
    const model = models[agent.id];
    const level = levels[agent.id];
    const marked = off.get(agent.id);
    return {
      ...agent,
      ...(marked ? { instructions: marked } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(level !== undefined ? { permissions: level } : {}),
    };
  });
  const ownIds = new Set(own.map(idOf));
  for (const key of Object.keys(models)) {
    if (ownIds.has(key)) skipped.push(`podModels.${key}: ${key} is defined in config.yaml, so its model is agents[].model there`);
  }
  for (const key of Object.keys(levels)) {
    if (ownIds.has(key)) skipped.push(`podPermissions.${key}: ${key} is defined in config.yaml, so its level is agents[].permissions there`);
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

type DeclaredAgent = { agent: PodAgent & { id: string; host: string }; model: string | undefined };

/**
 * The pod agents whose instruction file another agent on the same machine already delivers, and a
 * line for each. They stay in the config — routing and conversations treat them like any other
 * agent — with the same `file` and `layer` plus `off: true`, which stops the delivery: nothing is
 * written, and the link there is left alone (config/instructions.ts instructionsOff). The layer
 * stays in the web UI's list and the harness's own files stay openable.
 *
 * config.yaml comes first in the merged list, so `instructionClashes` keeps its agent's layer;
 * among a pod's own, the first keeps it. Nothing a pod declares may fail the gateway's config: a
 * host that could keep the daemon from starting is worse than one of its agents not getting the
 * text (the rule that already leaves a bad pod entry out, above). A clash entirely inside
 * config.yaml is not touched — the schema refuses that file.
 *
 * The pod's own file is checked when it is read (daemon/pods.ts), so this is for what pods.json
 * already holds: an older read, or a hand edit.
 */
function offInstructionClashes(
  own: unknown[],
  declared: DeclaredAgent[],
  skipped: string[]
): Map<string, { file: string; layer: string; off: true }> {
  const parsed = own.flatMap((a) => {
    const r = AgentDefSchema.safeParse(a);
    // A malformed agent fails the schema later, with its own message; it takes no part here.
    return r.success ? [r.data] : [];
  });
  const byId = new Map(declared.map(({ agent }) => [agent.id, agent]));
  const off = new Map<string, { file: string; layer: string; off: true }>();
  for (const g of instructionClashes([...parsed, ...declared.map(({ agent }) => agent)])) {
    const keep = g.members[0];
    if (!keep) continue;
    const where = g.machine ? `on host "${g.machine}"` : 'on this machine';
    for (const m of g.members) {
      const agent = byId.get(m.id);
      if (!agent || m.layer === keep.layer) continue;
      // The placement as the agent would write it (`~/…` against its own home), so the marker keeps
      // meaning the same file if its `env.HOME` is resolved later.
      const at = instructionsHome(agent, '~');
      if (!at) continue;
      off.set(m.id, { file: at.file, layer: at.name, off: true });
      skipped.push(
        `instructions.${m.id}: "${m.id}" (layer "${m.layer}") and "${keep.id}" (layer "${keep.layer}") ` +
          `both deliver ${g.file} ${where}; "${keep.id}" keeps it, so nothing is delivered to "${m.id}"`
      );
    }
  }
  return off;
}

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
      const instructions = parsed.data.instructions
        ? { ...parsed.data.instructions, layer: parsed.data.instructions.layer ?? parsed.data.id }
        : undefined;
      out.push({
        agent: { ...parsed.data, id, host, ...(instructions ? { instructions } : {}) },
        model: parsed.data.model,
      });
    }
  }
  return out;
}

/**
 * `podModels` / `podPermissions` from a raw config, keeping only non-empty strings (the schema
 * reports the rest, a level it does not know included).
 */
function podStringsOf(raw: Record<string, unknown>, key: 'podModels' | 'podPermissions'): Record<string, string> {
  const m = raw[key];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  return Object.fromEntries(Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
}

function idOf(a: unknown): unknown {
  return a && typeof a === 'object' ? (a as { id?: unknown }).id : undefined;
}
