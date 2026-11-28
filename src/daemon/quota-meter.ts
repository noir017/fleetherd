import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import type { AgentDef } from '../config/schema.js';
import type { QuotaPool, SessionOption } from '../types.js';
import { buildHarnessEnv, remoteAgentEnv } from './agent-common.js';
import type { AgyCliResult } from './agy-cli.js';
import { parseAgyUsagePools } from './agy-meters.js';
import { remoteHosts } from './remote-hosts.js';
import { HARNESS_PROFILES } from './harness/index.js';
import { agentHome, type HarnessQuota, type QuotaReading } from './harness/profile.js';
import { shellLaunch } from './shell-run.js';

const execFile = promisify(execFileCb);

/**
 * An agent's usage quota: read when a session's first output arrives and after each turn
 * (AgyMeterHelper in agent-acp-harness.ts), and shown in the conversation's status strip
 * (TurnRunner → recordQuota), never in the turn's footer.
 *
 * An agent's quota comes from one of:
 *
 *   - **`agents[].quotaCommand`**, the operator's own command. For an agent whose harness cannot say:
 *     agy signed in through a model gateway (`AGY_LLM_GATEWAY_URL`) prints nothing for `/usage`,
 *     because its quota lives with whatever is behind the gateway (measured on 1.5.8, 2026-11-14) —
 *     and the same holds for any harness on a pooled proxy. It prints the table agy prints, so the
 *     parse is the same and a pool is the same pool whichever source reported it.
 *   - **the harness's own source** (HarnessProfile.quota), when it has one: agy's `agy -p=/usage`,
 *     claude's probe of its relay.
 *   - **what the harness reports by itself** (`record`), which stands its own source down: claude's
 *     rate-limit events on a claude.ai login (claude-rate-limit.ts).
 *
 * This module only schedules: it knows no harness.
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

/** Whether an agent has a quota to read: its own command, or its harness's source. */
export function hasQuotaSource(def: Pick<AgentDef, 'harness' | 'quotaCommand'>): boolean {
  return Boolean(def.quotaCommand) || Boolean(HARNESS_PROFILES[def.harness].quota);
}

export interface QuotaMeter {
  /** Re-read the pools for this agent's source, unless a recent reading or one in flight makes it pointless. */
  refresh(def: AgentDef, cwd: string): Promise<void>;
  /** The latest reading for this agent's source. */
  read(def: AgentDef): QuotaPool[] | undefined;
  /**
   * Pools the harness reported by itself, merged pool by pool into what this agent reported before.
   * Ignored for an agent with a `quotaCommand`: the operator's command is the agent's quota.
   */
  record(def: AgentDef, pools: readonly QuotaPool[]): void;
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
    if (pool) byKey.set(`${pool.accountKey ?? pool.account ?? ''}\0${pool.id}`, pool);
  }
  const pools = [...byKey.values()];
  pools.sort(
    (a, b) =>
      (a.account ?? a.accountKey ?? '').localeCompare(b.account ?? b.accountKey ?? '') || a.id.localeCompare(b.id)
  );
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
  const { id, remaining, resetsAt, account, profile, accountKey } = item as Record<string, unknown>;
  if (typeof id !== 'string' || !id.trim() || typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined;
  const rawAcct = typeof account === 'string' ? account : typeof profile === 'string' ? profile : undefined;
  const acct = rawAcct?.trim() || undefined;
  const key = typeof accountKey === 'string' ? accountKey.trim() || undefined : undefined;
  const resetMs = parseResetTimestamp(resetsAt);
  return {
    id: id.trim(),
    remaining: Math.min(1, Math.max(0, remaining)),
    ...(resetMs !== undefined ? { resetsAt: resetMs } : {}),
    ...(acct ? { account: acct } : {}),
    ...(key ? { accountKey: key } : {}),
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
/** Extract an account identifier from observed upstream response headers using `quotaAccountHeader`. */
export function extractAccountFromHeaders(
  headers: Record<string, string>,
  cfg: NonNullable<AgentDef['quotaAccountHeader']>
): string | undefined {
  const raw = headers[cfg.header.trim().toLowerCase()];
  if (!raw) return undefined;
  if (!cfg.pattern) return raw.trim() || undefined;
  try {
    const match = new RegExp(cfg.pattern).exec(raw);
    const extracted = match?.[1] ?? match?.[0];
    return extracted?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function scopeQuotaPools(
  pools: readonly QuotaPool[],
  options?: readonly SessionOption[],
  observedAccount?: string,
  requireObservedAccount = false
): QuotaPool[] {
  const accounts = new Set<string>();
  for (const p of pools) {
    if (p.account) accounts.add(p.account);
    if (p.accountKey) accounts.add(p.accountKey);
  }
  if (accounts.size === 0) return [...pools];
  if (observedAccount) {
    return pools.filter((p) => (!p.account && !p.accountKey) || p.accountKey === observedAccount || p.account === observedAccount);
  }
  if (requireObservedAccount) return [];
  const selected = selectedAccountOf(options, accounts);
  if (!selected) return [...pools];
  return pools.filter((p) => (!p.account && !p.accountKey) || p.account === selected || p.accountKey === selected);
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
 * The quota pools, per source, and when each is read. A source is whose quota a reading is: a
 * `quotaCommand` is keyed by the agent's home and itself, since two agents on one home may ask two
 * different pools; a harness's own source by the home, or by its `key` (agy's login is the home's,
 * claude's relay the agent's own environment). One read per source at a time, whichever
 * conversation asked, and none sooner than the source's interval after the last began — so
 * conversations ending together share one. Nothing reads unless a session asks (AgyMeterHelper:
 * its first output, the end of a turn), so an idle agent is never read.
 */
export function createQuotaMeter(
  opts: { command?: QuotaCommandRunner; harnessQuota?: (def: AgentDef) => HarnessQuota | undefined } = {}
): QuotaMeter {
  const command = opts.command ?? runQuotaCommand;
  const own = (def: AgentDef): HarnessQuota | undefined =>
    def.quotaCommand ? undefined : (opts.harnessQuota ?? ((d) => HARNESS_PROFILES[d.harness].quota))(def);
  const sources = new Map<string, QuotaSource>();
  const sourceOf = (def: AgentDef): QuotaSource => {
    const home = def.host ? `${def.host}:${def.env['HOME'] ?? '~'}` : agentHome(def);
    const key = own(def)?.key?.(def) ?? `${home}\0${def.quotaCommand ?? ''}`;
    let s = sources.get(key);
    if (!s) sources.set(key, (s = { next: 0, failures: 0 }));
    return s;
  };
  const readOnce = async (def: AgentDef, cwd: string): Promise<QuotaReading> => {
    if (!def.quotaCommand) return (await own(def)?.read(def, cwd)) ?? { ok: false, final: true, reason: 'no quota source' };
    const r = await runQuotaCommandFor(def, cwd, command);
    if (!r.ok) return { ok: false, reason: r.error };
    const pools = parseQuotaOutput(r.output);
    return pools ? { ok: true, pools } : { ok: false, reason: 'quotaCommand printed no row in the /usage format (pool, window, remaining %, reset)' };
  };
  return {
    refresh(def, cwd) {
      if (!def.quotaCommand && !own(def)) return Promise.resolve();
      const s = sourceOf(def);
      if (s.pending) return s.pending;
      // A harness reporting its quota by itself (record) is not asked; nor one that said there is nothing to ask.
      if (s.pushed || s.off === def || Date.now() < s.next) return Promise.resolve();
      const started = Date.now();
      const gap = (): number => own(def)?.interval?.(s.failures) ?? QUOTA_REUSE_MS;
      // Stamped when the run starts, so a failing one is not retried on every turn either.
      s.next = started + gap();
      s.pending = readOnce(def, cwd)
        .then((r) => {
          if (r.ok) {
            s.pools = r.pools;
            s.failures = 0;
          } else {
            s.failures++;
            if (r.final) s.off = def;
            // Once per run of failures: a source failing every turn would otherwise say so every turn.
            (s.failures === 1 ? console.warn : console.debug)(`[acp] ${def.id}: no quota reading: ${r.reason}`);
          }
          s.next = started + gap();
        })
        .finally(() => {
          s.pending = undefined;
        });
      return s.pending;
    },
    read(def) {
      // A window past its reset has refilled; how full it is waits for the next reading.
      const now = Date.now();
      return sourceOf(def).pools?.filter((p) => p.resetsAt === undefined || p.resetsAt > now);
    },
    record(def, pools) {
      if (def.quotaCommand || !pools.length) return;
      const s = sourceOf(def);
      s.pushed = true;
      const byKey = new Map((s.pools ?? []).map((p) => [`${p.accountKey ?? p.account ?? ''}\0${p.id}`, p]));
      for (const p of pools) byKey.set(`${p.accountKey ?? p.account ?? ''}\0${p.id}`, p);
      s.pools = [...byKey.values()].sort(
        (a, b) =>
          (a.account ?? a.accountKey ?? '').localeCompare(b.account ?? b.accountKey ?? '') || a.id.localeCompare(b.id)
      );
    },
  };
}

interface QuotaSource {
  pools?: QuotaPool[];
  /** When the next read may begin. */
  next: number;
  /** Reads failed in a row. */
  failures: number;
  pending?: Promise<void>;
  /** The harness reports this quota by itself (record): its own source is not read. */
  pushed?: boolean;
  /** The definition whose source said there is nothing to read; a redefined agent is asked again. */
  off?: AgentDef;
}
