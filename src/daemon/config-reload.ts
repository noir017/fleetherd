import type { Config, UserConfig } from '../config/schema.js';

/**
 * Applying an edited config.yaml to the running daemon (`/reload`, `talkcode reload`) — the pure
 * half: what changed, which of it can take effect now, and the sentence that says so. The daemon
 * (Daemon.reloadConfig) reads the files and drives the side effects; the registry decides what
 * happens to the agent processes already running (ConversationRegistry.respawnAgents).
 *
 * ── Why in place ──────────────────────────────────────────────────────────────────────────────
 * Every component was handed the same Config object at startup and reads it when it needs a value
 * (`/setting` has relied on that since it was written). So a reload copies the new sections INTO
 * that object rather than building a new daemon around a new one: nothing has to be re-wired, and
 * a turn already running keeps working on what it started with — an agent definition is captured
 * by its session when the session is created, which is why changed agents need respawnAgents.
 */

/**
 * How each section of config.yaml reaches a running daemon. A `satisfies Record` over the user
 * schema's keys, so a new section fails to compile until someone decides this for it.
 *
 * - live: read wherever it is used, so replacing it is the whole job.
 * - agents: replaced, and conversations running a changed agent are respawned onto it.
 * - restart: built into objects at startup — the platform adapters connect once, with these
 *   credentials — so a change is reported, not applied.
 * - ignore: carries nothing that can change at runtime.
 */
const RELOAD_KIND = {
  version: 'ignore',
  platforms: 'restart',
  agents: 'agents',
  routing: 'live',
  session: 'live',
  access: 'live',
  stream: 'live',
  display: 'live',
  title: 'live',
  voice: 'live',
  // Live: the daemon rebuilds its host table from it after a reload (remoteHosts.configure), and an
  // agent on a host whose entry changed counts as changed itself (diffConfig), so it is respawned.
  hosts: 'live',
} as const satisfies Record<keyof UserConfig, 'ignore' | 'restart' | 'agents' | 'live'>;

type LiveSection = { [K in keyof typeof RELOAD_KIND]: (typeof RELOAD_KIND)[K] extends 'live' ? K : never }[keyof typeof RELOAD_KIND];

const LIVE_SECTIONS = (Object.keys(RELOAD_KIND) as Array<keyof typeof RELOAD_KIND>).filter(
  (k): k is LiveSection => RELOAD_KIND[k] === 'live'
);

/** What differs between the running config and the one just read. Names only, never values. */
export interface ConfigDiff {
  agentsAdded: string[];
  agentsRemoved: string[];
  /** Agents whose definition changed in any field (harness, args, env, cwd, model, hooks, …). */
  agentsChanged: string[];
  /** Live sections that changed. */
  sections: LiveSection[];
  /** What changed but only takes effect after a restart, e.g. `platforms.web`. */
  restartNeeded: string[];
}

export function diffConfig(live: Config, next: Config): ConfigDiff {
  const before = new Map(live.agents.map((a) => [a.id, a]));
  const after = new Map(next.agents.map((a) => [a.id, a]));
  const ids = (m: Map<string, unknown>, other: Map<string, unknown>): string[] => [...m.keys()].filter((id) => !other.has(id));
  return {
    agentsAdded: ids(after, before),
    agentsRemoved: ids(before, after),
    agentsChanged: [...after.keys()].filter(
      (id) =>
        before.has(id) &&
        (!same(before.get(id), after.get(id)) || !same(hostOf(live, before.get(id)), hostOf(next, after.get(id))))
    ),
    sections: LIVE_SECTIONS.filter((k) => !same(live[k], next[k])),
    restartNeeded: diffKeys(live.platforms, next.platforms).map((id) => `platforms.${id}`),
  };
}

export function isEmptyDiff(d: ConfigDiff): boolean {
  return [d.agentsAdded, d.agentsRemoved, d.agentsChanged, d.sections, d.restartNeeded].every((l) => l.length === 0);
}

/**
 * Copy everything a reload applies from `next` into the live config. `platforms` is left alone on
 * purpose (see RELOAD_KIND): the live map is what the running adapters were built from, and the
 * IPC server validates `--channel` instance ids against it.
 */
export function applyConfig(live: Config, next: Config): void {
  // Spliced rather than reassigned: the array itself is shared, not just the Config around it.
  live.agents.splice(0, live.agents.length, ...next.agents);
  const copy = <K extends LiveSection>(k: K): void => {
    live[k] = next[k];
  };
  for (const k of LIVE_SECTIONS) copy(k);
}

/** What the registry did with the conversations that were running a changed or removed agent. */
export interface RespawnCounts {
  /** Idle conversations whose agent process was ended; the next message starts it on the new definition. */
  now: number;
  /** Conversations mid-turn: their process ends when the turn does. */
  afterTurn: number;
  /** Conversations whose harness cannot resume a session: left on the old definition rather than restarted blank. */
  kept: number;
}

/** The reply to `/reload` and the output of `talkcode reload`. */
export function describeReload(
  d: ConfigDiff,
  respawn: RespawnCounts,
  envChanges: string[],
  warnings: string[] = []
): string {
  if (isEmptyDiff(d) && envChanges.length === 0) return 'config.yaml reloaded: nothing changed.';
  const lines = ['config.yaml reloaded.'];
  const agents = [
    d.agentsAdded.length ? `added ${d.agentsAdded.join(', ')}` : '',
    d.agentsChanged.length ? `changed ${d.agentsChanged.join(', ')}` : '',
    d.agentsRemoved.length ? `removed ${d.agentsRemoved.join(', ')}` : '',
  ].filter(Boolean);
  if (agents.length) lines.push(`- agents: ${agents.join('; ')}`);
  if (d.sections.length) lines.push(`- applied: ${d.sections.join(', ')}`);
  // Names only: a value from .env is usually a secret, and this text goes into a chat.
  if (envChanges.length) lines.push(`- .env: ${envChanges.join(', ')}`);
  const moved = [
    respawn.now ? `${respawn.now} restart their agent on the next message` : '',
    respawn.afterTurn ? `${respawn.afterTurn} after the turn now running` : '',
    respawn.kept ? `${respawn.kept} stay on the old definition until /new (their agent cannot resume a session)` : '',
  ].filter(Boolean);
  if (moved.length) lines.push(`- conversations: ${moved.join('; ')}`);
  if (d.restartNeeded.length) lines.push(`- needs a daemon restart to take effect: ${d.restartNeeded.join(', ')}`);
  for (const w of warnings) lines.push(`- ⚠️ ${w}`);
  return lines.join('\n');
}

/** The `hosts:` entry an agent runs on, for comparing two configs. */
function hostOf(cfg: Config, def: Config['agents'][number] | undefined): unknown {
  return def?.host ? cfg.hosts?.[def.host] : undefined;
}

/** Keys added, removed or changed between two records. */
function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !same(a[k], b[k])).sort();
}

/**
 * Structural equality by canonical JSON. Key order is normalised because it is NOT stable across
 * the two sides: `/setting` writes a field onto the live object (`def.model = …`), which puts it
 * last, while the same field read back from the file sits where the file has it.
 */
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : value
  );
}
