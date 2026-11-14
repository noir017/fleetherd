import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import type { AgentDef } from '../config/schema.js';
import type { QuotaPool } from '../types.js';
import { buildHarnessEnv, remoteAgentEnv } from './agent-common.js';
import { runAgyCliCommand, runAgyCliFor, type AgyCliResult, type AgyCliRunner } from './agy-cli.js';
import { parseAgyUsagePools } from './agy-meters.js';
import { remoteHosts } from './remote-hosts.js';
import { agentHome } from './skills-scan.js';

const execFile = promisify(execFileCb);

/**
 * An agent's usage quota, which no ACP message carries: read beside a turn and shown in the
 * conversation's status strip (TurnRunner → recordQuota), never in the turn's footer.
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
 * Read at most once a minute per source and never twice at once, whichever conversation asked.
 */

/** How old a quota reading may get before a turn asks again. */
const QUOTA_REFRESH_MS = 60_000;

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
    const { stdout } = await execFile('bash', ['-lc', command], { cwd, env, timeout: QUOTA_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
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
      if (Date.now() - entry.at < QUOTA_REFRESH_MS) return Promise.resolve();
      entry.at = Date.now();
      const e = entry;
      const run = def.quotaCommand ? runQuotaCommandFor(def, cwd, command) : runAgyCliFor(def, 'usage', cwd, agy);
      e.pending = run
        .then((r) => {
          if (!r.ok) {
            console.debug(`[acp] could not read the quota (${def.id}):`, r.error);
            return;
          }
          const pools = parseAgyUsagePools(r.output);
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
