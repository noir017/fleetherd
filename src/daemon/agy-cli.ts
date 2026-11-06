import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import type { AgentDef } from '../config/schema.js';
import { buildHarnessEnv, remoteAgentEnv } from './agent-common.js';
import { remoteHosts } from './remote-hosts.js';
import type { RemoteHost } from '../remote/host.js';

const execFile = promisify(execFileCb);

/**
 * agy as a one-shot CLI, beside the session: `agy -p=/<command>` for the commands agy's CLI answers
 * itself (`/usage`, `/credits`, …).
 *
 * Used by the ACP runtime (agent-acp.ts, `agy acp`) and by conversation.ts, which answers those
 * commands in chat. ACP carries none of it: `agy acp` 1.5.1 has no quota method and lists no
 * `/usage` among its commands (a `/usage` prompt reaches the model as text, probed 2026-11-06).
 * Also the one place left that runs agy as a plain process, which is why it shares agent-common's
 * environment helpers rather than the session's.
 */

/** The executable name; `agy install` puts it on PATH. Exported so doctor reports the same thing. */
export const AGY_COMMAND = 'agy';

// ───────────────────────── one-shot CLI commands ─────────────────────────

/**
 * How long a one-shot `agy -p /<command>` may take before it is given up on.
 *
 * Generous because the floor is a cold CLI start (~5s observed for `agy models`), and the ceiling
 * only has to be short enough that a user does not think the gateway ignored them.
 */
const CLI_COMMAND_TIMEOUT_MS = 60_000;

/** Longest CLI answer forwarded whole. `/changelog` is the one that needs this; the rest are short. */
const CLI_OUTPUT_MAX_CHARS = 2_500;

export type AgyCliResult = { ok: true; output: string } | { ok: false; error: string };

/** runAgyCliCommand's shape — a factory parameter so the session tests never start a real agy. */
export type AgyCliRunner = (name: string, cwd: string, env?: NodeJS.ProcessEnv) => Promise<AgyCliResult>;

/**
 * Run one of agy's own slash commands as its own process and return what it printed.
 *
 * The only path there is under `agy acp`, which treats the same text as a prompt for the model. It
 * is cheap in the way that matters: the CLI answers these from local state, so no model is invoked,
 * no tokens are spent, and the conversation's own agy is never touched.
 *
 * Probed on agy 1.2.0 (2026-09-17) against all eleven commands `agy -p /help` lists: every one
 * exits 0 without a terminal, and none blocks waiting for input — including the four that render as
 * interactive panels in the TUI (`/config`, `/effort`, `/hooks`, `/permissions`), which print their
 * current state instead. `/agents`, `/hooks` and `/permissions` print NOTHING when there is nothing
 * configured, which is why an empty answer is reported rather than passed on as an empty message.
 *
 * `cwd` is the conversation's directory because some answers are workspace-scoped (`/agents` reads
 * the workspace's custom agents). Failure is returned, never thrown: this runs inside a chat
 * command, where the reason belongs in the reply.
 */
export async function runAgyCliCommand(
  name: string,
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<AgyCliResult> {
  try {
    const { stdout } = await execFile(AGY_COMMAND, [`-p=/${name}`], {
      cwd,
      env,
      timeout: CLI_COMMAND_TIMEOUT_MS,
      // agy prints the whole changelog for `/changelog`; the default 1MB buffer is ample, but say so.
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, output: stdout.trim() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One agy invocation on a remote host — `agy -p=/usage` and the rest of the one-shots — run there
 * through talkcode-remote with the agent's environment, answered in AgyCliResult's terms. The host
 * is the one the agent runs on, because that is where agy is signed in.
 */
export async function runAgyOnHost(host: RemoteHost, def: AgentDef, argv: string[], cwd?: string): Promise<AgyCliResult> {
  const what = `agy ${argv.join(' ')}`;
  try {
    const r = await host.run({ argv: [AGY_COMMAND, ...argv], cwd, env: remoteAgentEnv(def), timeoutMs: CLI_COMMAND_TIMEOUT_MS, max: 1 << 20 });
    if (r.spawnError) return { ok: false, error: `${what} on ${host.id}: ${r.spawnError}` };
    if (r.timedOut) return { ok: false, error: `${what} on ${host.id} timed out` };
    if (r.code !== 0) return { ok: false, error: `${what} on ${host.id} exited ${r.code ?? r.signal}${r.stderr ? `: ${r.stderr}` : ''}` };
    return { ok: true, output: r.output.toString('utf8').trim() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One of agy's slash commands as a one-shot, wherever `def` runs (runAgyCliCommand locally). */
export function runAgyCliFor(def: AgentDef, name: string, cwd: string, local: AgyCliRunner = runAgyCliCommand): Promise<AgyCliResult> {
  const host = remoteHosts.hostFor(def);
  return host ? runAgyOnHost(host, def, [`-p=/${name}`], cwd) : local(name, cwd, buildHarnessEnv(def));
}

/**
 * Render what a one-shot CLI command printed, as a chat message.
 *
 * Everything but `/usage` prints either a short TSV table (`/model`, `/credits`, `/effort`,
 * `/config`) or markdown (`/changelog`), so the honest rendering is the text itself in a fenced
 * block — inventing structure per command would be guessing at output this gateway does not own.
 *
 * Truncation is announced and points at the host, because the commands whose answers overflow are
 * exactly the ones a reader might need in full.
 */
export function formatAgyCliOutput(name: string, output: string): string {
  if (!output) {
    return `\`/${name}\` — agy answered with nothing. That is its answer when there is none configured.`;
  }
  if (name === 'usage') {
    const quota = formatAgyQuota(output);
    if (quota) return quota;
  }
  let body = output;
  let note = '';
  if (body.length > CLI_OUTPUT_MAX_CHARS) {
    body = body.slice(0, CLI_OUTPUT_MAX_CHARS);
    note = `\n\nTruncated at ${CLI_OUTPUT_MAX_CHARS} characters — run \`agy -p=/${name}\` on the host for all of it.`;
    console.log(`[agy] truncated the /${name} answer from ${output.length} to ${CLI_OUTPUT_MAX_CHARS} chars`);
  }
  return `\`\`\`\n${body}\n\`\`\`${note}`;
}

/**
 * `/usage` specifically: four tab-separated columns (pool, metric, remaining %, ISO reset), e.g.
 *
 *   Gemini Models\tWeekly Limit Remaining\t100%\t2026-09-24T06:12:21Z
 *
 * Worth a renderer of its own because a percentage and a timestamp are what the question was, and
 * the raw row buries both: the bar makes "how much is left" readable at a glance, and the reset is
 * rewritten as a duration because "in 6d" is actionable where a UTC timestamp is arithmetic.
 *
 * Returns undefined when the shape is not the expected four columns, so the caller falls back to
 * printing the output verbatim rather than dropping an answer it failed to parse.
 */
export function formatAgyQuota(output: string, now: number = Date.now()): string | undefined {
  const rows = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t').map((c) => c.trim()));
  if (rows.length === 0 || rows.some((r) => r.length !== 4)) return undefined;

  const lines = rows.map((r) => {
    const [pool, metric, remaining, resetAt] = r as [string, string, string, string];
    const pct = Number.parseFloat(remaining);
    const bar = Number.isNaN(pct) ? '' : ` ${quotaBar(pct)}`;
    return `**${pool}** — ${metric}: ${remaining}${bar}${formatResetIn(resetAt, now)}`;
  });
  return `Quota:\n${lines.join('\n')}`;
}

/** An 8-cell bar for a remaining-percentage, matching the footer's plain-text idiom. */
function quotaBar(percent: number, width = 8): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

/** ` (resets in 6d 4h)` for a parseable ISO timestamp in the future, and nothing otherwise. */
function formatResetIn(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const secs = Math.round((at - now) / 1000);
  if (secs <= 0) return ' (resets now)';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return ` (resets in ${span})`;
}
