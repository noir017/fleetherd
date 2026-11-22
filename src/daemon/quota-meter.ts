import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import type { AgentDef } from '../config/schema.js';
import type { QuotaPool, SessionOption } from '../types.js';
import { buildHarnessEnv, remoteAgentEnv } from './agent-common.js';
import { runAgyCliCommand, runAgyCliFor, type AgyCliResult, type AgyCliRunner } from './agy-cli.js';
import { parseAgyUsagePools } from './agy-meters.js';
import { remoteHosts } from './remote-hosts.js';
import { agentHome } from './skills-scan.js';
import { shellLaunch } from './schedule-bash.js';

const execFile = promisify(execFileCb);

/**
 * An agent's usage quota, which no ACP message carries: read when a session's first output arrives
 * and after each turn (AgyMeterHelper in agent-acp-harness.ts), and shown in the conversation's
 * status strip (TurnRunner → recordQuota), never in the turn's footer.
 *
 * Two sources, and an agent has at most one:
 *
 *   - **`agents[].quotaCommand`**, the operator's own command. For an agent whose harness cannot say:
 *     agy signed in through a model gateway (`AGY_LLM_GATEWAY_URL`) prints nothing for `/usage`,
 *     because its quota lives with whatever is behind the gateway (measured on 1.5.8, 2026-11-14) —
 *     and the same holds for any harness on a pooled proxy. It prints the table agy prints, so the
 *     parse is the same and a pool is the same pool whichever source reported it.
 *   - **agy's own `agy -p=/usage`** (agy-cli.ts), for an agy signed in to Google.
 *
 * Never read twice at once per source, whichever conversation asked, and a reading begun moments ago
 * answers in place of a new one: conversations whose turns end together share one run.
 */

/** A reading begun this recently answers instead of a new run. */
const QUOTA_REUSE_MS = 10_000;

/**
 * How long a quota command may run. Generous for the same reason agy's one-shots are (agy-cli.ts):
 * nothing waits on it, and a proxy that asks several accounts in turn is not instant.
 */
const QUOTA_COMMAND_TIMEOUT_MS = 60_000;

/** runQuotaCommand's shape — injectable so the tests never start a shell. */
export type QuotaCommandRunner = (command: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<AgyCliResult>;

/**
 * `bash -lc <command>` on this machine; stdout is the answer. A login shell, like the hooks
 * (agent-hooks.ts), so a command installed under the user's own PATH is found. Failure is returned,
 * never thrown: a quota that cannot be read is a missing segment, not a broken turn.
 */
export async function runQuotaCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<AgyCliResult> {
  try {
    const launch = shellLaunch(command, process.platform, env);
    const { stdout } = await execFile(launch.command, launch.args, {
      cwd,
      env,
      timeout: QUOTA_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      ...(launch.windowsHide ? { windowsHide: true } : {}),
    });
    return { ok: true, output: stdout.trim() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `def.quotaCommand` where the agent runs, with the agent's environment: on its host through
 * fleetherd-remote, as agy's own `/usage` is (agy-cli.ts runAgyOnHost). There and not here, because
 * a pod declares this command in its own pod.yaml, and a host must never be able to make the gateway
 * run something (AGENTS.md, security invariant 5).
 */
export async function runQuotaCommandFor(def: AgentDef, cwd: string, local: QuotaCommandRunner = runQuotaCommand): Promise<AgyCliResult> {
  const command = def.quotaCommand;
  if (!command) return { ok: false, error: `agent "${def.id}" has no quotaCommand` };
  const host = remoteHosts.hostFor(def);
  if (!host) return local(command, cwd, buildHarnessEnv(def));
  try {
    const r = await host.run({ bash: command, cwd, env: remoteAgentEnv(def), timeoutMs: QUOTA_COMMAND_TIMEOUT_MS, max: 1 << 20 });
    if (r.spawnError) return { ok: false, error: `quotaCommand on ${host.id}: ${r.spawnError}` };
    if (r.timedOut) return { ok: false, error: `quotaCommand on ${host.id} timed out` };
    if (r.code !== 0) return { ok: false, error: `quotaCommand on ${host.id} exited ${r.code ?? r.signal}${r.stderr ? `: ${r.stderr}` : ''}` };
    return { ok: true, output: r.output.toString('utf8').trim() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether an agent has a quota to read: its own command, or agy's `/usage`. */
export function hasQuotaSource(def: Pick<AgentDef, 'harness' | 'quotaCommand'>): boolean {
  return Boolean(def.quotaCommand) || def.harness === 'agy';
}

export interface QuotaMeter {
  /** Re-read the pools for this agent's source, unless a recent reading or one in flight makes it pointless. */
  refresh(def: AgentDef, cwd: string): Promise<void>;
  /** The latest reading for this agent's source. */
  read(def: AgentDef): QuotaPool[] | undefined;
}

/**
 * Parse stdout of `quotaCommand` (or `agy -p=/usage`) into QuotaPool[].
 *
 * Accepts either:
 *   1. Standard JSON — `QuotaPool[]` or `{ pools: QuotaPool[] }` (remaining in [0, 1], resetsAt as
 *      epoch ms or ISO-8601 string), so future agents are not tied to agy's table column names.
 *   2. The 4-column TSV table printed by `agy -p=/usage` (via `parseAgyUsagePools`).
 */
export function parseQuotaOutput(output: string): QuotaPool[] | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const json = parseJsonQuotaPools(trimmed);
    if (json) return json;
  }
  return parseAgyUsagePools(trimmed);
}

function parseJsonQuotaPools(raw: string): QuotaPool[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const list = extractJsonPoolList(parsed);
  if (!list) return undefined;
  const byKey = new Map<string, QuotaPool>();
  for (const item of list) {
    const pool = parseJsonQuotaItem(item);
    if (pool) byKey.set(`${pool.account ?? ''}\0${pool.id}`, pool);
  }
  const pools = [...byKey.values()];
  pools.sort((a, b) => (a.account ?? '').localeCompare(b.account ?? '') || a.id.localeCompare(b.id));
  return pools.length ? pools : undefined;
}

function extractJsonPoolList(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { pools?: unknown }).pools)) {
    return (parsed as { pools: unknown[] }).pools;
  }
  return undefined;
}

function parseJsonQuotaItem(item: unknown): QuotaPool | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const { id, remaining, resetsAt, account, profile } = item as Record<string, unknown>;
  if (typeof id !== 'string' || !id.trim() || typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined;
  const rawAcct = typeof account === 'string' ? account : typeof profile === 'string' ? profile : undefined;
  const acct = rawAcct?.trim() || undefined;
  const resetMs = parseResetTimestamp(resetsAt);
  return {
    id: id.trim(),
    remaining: Math.min(1, Math.max(0, remaining)),
    ...(resetMs !== undefined ? { resetsAt: resetMs } : {}),
    ...(acct ? { account: acct } : {}),
  };
}

function parseResetTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

/**
 * Narrow a multi-account quota reading to the account this session is actually running on.
 *
 * `QuotaMeter` caches one `quotaCommand` reading per agent across conversations. When that reading
 * lists pools per account (e.g. `wad quota` for several running profiles) and the session exposes
 * an `account` option (or any custom option whose value matches the pool accounts), each
 * conversation sees only its own account's pools — never another conversation's — and gets `[]`
 * rather than a wrong account's numbers if its own account has not reported yet. Single-account
 * or already-aggregated readings pass through untouched.
 */
export function scopeQuotaPools(pools: readonly QuotaPool[], options?: readonly SessionOption[]): QuotaPool[] {
  const accounts = new Set<string>();
  for (const p of pools) {
    if (p.account) accounts.add(p.account);
  }
  if (accounts.size === 0) return [...pools];
  const selected = selectedAccountOf(options, accounts);
  if (!selected) return [...pools];
  return pools.filter((p) => !p.account || p.account === selected);
}

function selectedAccountOf(options: readonly SessionOption[] | undefined, accounts: ReadonlySet<string>): string | undefined {
  if (!options?.length) return undefined;
  const byId = options.find((o) => o.id === 'account' && typeof o.current === 'string' && o.current.trim());
  if (byId?.current) return byId.current.trim();
  const byMatch = options.find(
    (o) =>
      typeof o.current === 'string' &&
      o.current.trim() &&
      (accounts.has(o.current.trim()) || o.options.some((c) => accounts.has(c.value))),
  );
  return byMatch?.current?.trim();
}
/**
 * The quota pools, per source. Keyed by where the reading comes from: agy's quota belongs to whoever
 * agy is signed in as, so every conversation on a home shares one reading and the same HOME on two
 * hosts is two; a command is keyed by itself on top of that, since two agents on one home may ask
 * two different pools.
 */
export function createQuotaMeter(runners: { agy?: AgyCliRunner; command?: QuotaCommandRunner } = {}): QuotaMeter {
  const agy = runners.agy ?? runAgyCliCommand;
  const command = runners.command ?? runQuotaCommand;
  const bySource = new Map<string, { pools?: QuotaPool[]; at: number; pending?: Promise<void>; warned?: boolean }>();
  const sourceOf = (def: AgentDef): string =>
    `${def.host ? `${def.host}:${def.env['HOME'] ?? '~'}` : agentHome(def)}\0${def.quotaCommand ?? ''}`;
  return {
    refresh(def, cwd) {
      const key = sourceOf(def);
      let entry = bySource.get(key);
      if (!entry) bySource.set(key, (entry = { at: 0 }));
      if (entry.pending) return entry.pending;
      // Stamped when the run starts, so a failing one is not retried on every turn either.
      if (Date.now() - entry.at < QUOTA_REUSE_MS) return Promise.resolve();
      entry.at = Date.now();
      const e = entry;
      const run = def.quotaCommand ? runQuotaCommandFor(def, cwd, command) : runAgyCliFor(def, 'usage', cwd, agy);
      e.pending = run
        .then((r) => {
          if (!r.ok) {
            console.debug(`[acp] could not read the quota (${def.id}):`, r.error);
            return;
          }
          const pools = parseQuotaOutput(r.output);
          if (pools) e.pools = pools;
          else if (def.quotaCommand && !e.warned) {
            // Once per source: a command printing the wrong shape would otherwise say so every minute.
            e.warned = true;
            console.warn(`[acp] ${def.id}: quotaCommand printed no row in the /usage format (pool, window, remaining %, reset)`);
          }
        })
        .finally(() => {
          e.pending = undefined;
        });
      return e.pending;
    },
    read: (def) => bySource.get(sourceOf(def))?.pools,
  };
}
