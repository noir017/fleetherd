import path from 'node:path';
import type { AgentDef } from '../config/schema.js';
import { configDir } from '../config/load.js';
import { TurnFailure } from './agent.js';
import { buildHarnessEnv, remoteAgentEnv } from './agent-common.js';
import { remoteHosts } from './remote-hosts.js';
import { runBashCommand, runRemoteBashCommand, type BashRunResult } from './schedule-bash.js';
import { withLegacyNames } from '../legacy-name.js';

/**
 * The operator's agent hooks (`agents[].hooks` in config.yaml): commands the daemon runs at points in
 * an agent child's life that the harness itself cannot see. The harness has hooks of its own for
 * everything that happens inside a session — Claude Code's run under this gateway like anywhere
 * else — so only what lies outside one belongs here. Today that is `preLaunch`: before the child
 * exists, there is no harness to ask.
 *
 * ── Why preLaunch blocks ──────────────────────────────────────────────────────────────────────
 * It prepares the ground the agent stands on — a container started, a tunnel opened, a checkout
 * pulled — so an agent launched after a failed one would run on a half-prepared machine, which is
 * the one thing worse than not running. A failure therefore fails the startup, with the reason, and
 * the next message tries again from the top.
 *
 * ── What it gets ──────────────────────────────────────────────────────────────────────────────
 * `bash -lc`, through the same runner as a scheduled `--bash` task (schedule-bash.ts): its own
 * process group, killed whole on timeout. The working directory and environment are the ones the
 * agent is about to get, minus the reverse-command token — the hook runs before the session it
 * would belong to, so it has nothing to call back into (buildHarnessEnv's reasoning). Full output
 * goes to a log file per agent; the tail of it is what the chat sees on a failure.
 */

/**
 * How long a preLaunch hook may run. Generous next to the 30s the harness gets to answer
 * `initialize`, because starting a container or pulling a repository is legitimately slow, and
 * frozen rather than configurable: it is a hang detector, not a tuning knob.
 */
export const PRE_LAUNCH_TIMEOUT_MS = 60_000;

/**
 * How much of the hook's output reaches the chat. turn-runner caps the whole failure message at 300
 * characters, and the reason is the END of the output — the line a script printed as it gave up —
 * so the tail is kept, not the head (trimReason in agent-common keeps the head).
 */
const REASON_TAIL_CHARS = 150;

/**
 * Thrown when the hook was cancelled through its signal — a `/stop` or a dispose landing while it
 * ran. A type of its own because the runtimes end the turn QUIETLY on it: nothing failed, someone
 * asked for this, and a "❌ This turn failed" right after the stop acknowledgement would say otherwise.
 * Matching on `aborting` instead would not do: agy raises that flag for its own teardowns too (a
 * model switch respawns through it), and would then swallow a real hook failure.
 */
export class PreLaunchCancelled extends Error {}

/**
 * Run `def.hooks.preLaunch`, if there is one, and resolve once it has succeeded. Rejects with a
 * message written for the chat when it fails, times out or cannot start, and with PreLaunchCancelled
 * when cancelled through `signal` — the runtimes abort it on `/stop` and on dispose, so a `/new` or a
 * shutdown never leaves a child spawned for a session that is already gone.
 */
export async function runPreLaunchHook(
  def: AgentDef,
  opts: { cwd: string; signal: AbortSignal; timeoutMs?: number; logDir?: string }
): Promise<void> {
  const command = def.hooks?.preLaunch;
  if (!command) return;
  const timeoutMs = opts.timeoutMs ?? PRE_LAUNCH_TIMEOUT_MS;
  const started = Date.now();
  // On the agent's own machine: a hook prepares the ground the agent stands on, and for an agent on
  // a remote host that ground is over there.
  const host = remoteHosts.hostFor(def);
  console.log(`[hook] agent "${def.id}": running preLaunch in ${opts.cwd}${host ? ` on ${host.id}` : ''}`);
  const run = {
    command,
    cwd: opts.cwd,
    timeoutMs,
    logDir: opts.logDir ?? path.join(configDir(), 'hooks', def.id),
    stamp: new Date(started).toISOString().replace(/[:.]/g, '-'),
    signal: opts.signal,
  };
  const r = host
    ? await runRemoteBashCommand(host, { ...run, env: remoteAgentEnv(def) })
    : await runBashCommand({ ...run, env: buildHarnessEnv(def), settleOnExit: true });
  const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const output = r.logFile ? `; output: ${r.logFile}` : '';
  const failure = describeFailure(def.id, r, timeoutMs);
  if (!failure) {
    console.log(`[hook] agent "${def.id}": preLaunch ok in ${took}${output}`);
    return;
  }
  console.warn(`[hook] ${failure} (after ${took}${output})`);
  throw r.aborted ? new PreLaunchCancelled(failure) : new TurnFailure(failure, 'preLaunch');
}

/** The chat-facing sentence for a run that did not succeed; undefined when it did. */
function describeFailure(agentId: string, r: BashRunResult, timeoutMs: number): string | undefined {
  const what = `agent "${agentId}" pre-launch hook`;
  // Order matters: a cancelled or timed-out hook was killed, so its exit status says nothing.
  if (r.spawnError) return `${what} could not start: ${r.spawnError}`;
  if (r.aborted) return `${what} was cancelled: the turn was stopped or its session closed`;
  if (r.timedOut) return `${what} timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (r.exitCode === 0) return undefined;
  const status = r.exitCode === null ? 'killed by a signal' : `exit ${r.exitCode}`;
  const reason = tailReason(r.tail);
  return reason ? `${what} failed (${status}): ${reason}` : `${what} failed (${status})`;
}

/** The end of the output, flattened to one line and cut to REASON_TAIL_CHARS from the left. */
export function tailReason(output: string): string {
  const flat = output.replace(/\s+/g, ' ').trim();
  return flat.length > REASON_TAIL_CHARS ? `…${flat.slice(flat.length - (REASON_TAIL_CHARS - 1))}` : flat;
}

/**
 * How long a `hooks.turnFailed.command` may run. It reports a failure; it does not repair one, so a
 * minute is generous — and frozen for the reason PRE_LAUNCH_TIMEOUT_MS is: a hang detector.
 */
export const TURN_FAILED_TIMEOUT_MS = 60_000;

/** What `hooks.turnFailed.command` is told, as JSON in `FLEETHERD_TURN_FAILURE`. */
export interface TurnFailedReport {
  agent: string;
  /** The conversation key (opaque, but stable: the same key every report from that conversation). */
  conversation: string;
  /** TurnFailureReason. */
  reason: string;
  /** The sentence the chat was shown. */
  message: string;
  /** Epoch ms. */
  at: number;
  /** Set when an automatic continue was scheduled for it: which attempt, out of how many. */
  continuing?: { attempt: number; max: number };
}

/**
 * Run `def.hooks.turnFailed.command`, if there is one. Never rejects and is never awaited by a turn:
 * the turn has already failed and said so, and an alert that cannot be sent is a log line, not a
 * second failure in the chat.
 *
 * On the agent's own machine like preLaunch, with the agent's environment minus the token, plus the
 * report. Output goes to a log file per agent beside preLaunch's.
 */
export async function runTurnFailedHook(def: AgentDef, report: TurnFailedReport, opts: { cwd: string; logDir?: string }): Promise<void> {
  const command = def.hooks?.turnFailed?.command;
  if (!command) return;
  const host = remoteHosts.hostFor(def);
  const run = {
    command,
    cwd: opts.cwd,
    timeoutMs: TURN_FAILED_TIMEOUT_MS,
    logDir: opts.logDir ?? path.join(configDir(), 'hooks', def.id),
    stamp: `failed-${new Date(report.at).toISOString().replace(/[:.]/g, '-')}`,
    signal: new AbortController().signal,
  };
  const json = JSON.stringify(report);
  try {
    const r = host
      ? await runRemoteBashCommand(host, { ...run, env: withLegacyNames({ ...remoteAgentEnv(def), FLEETHERD_TURN_FAILURE: json }) })
      : await runBashCommand({ ...run, env: withLegacyNames({ ...buildHarnessEnv(def), FLEETHERD_TURN_FAILURE: json }), settleOnExit: true });
    const failure = r.spawnError ?? (r.timedOut ? 'timed out' : r.exitCode === 0 ? undefined : `exit ${r.exitCode ?? 'by a signal'}`);
    if (failure) console.warn(`[hook] agent "${def.id}": turnFailed command ${failure}${r.logFile ? `; output: ${r.logFile}` : ''}`);
    else console.log(`[hook] agent "${def.id}": turnFailed command ok${r.logFile ? `; output: ${r.logFile}` : ''}`);
  } catch (e) {
    console.warn(`[hook] agent "${def.id}": turnFailed command could not run:`, e instanceof Error ? e.message : e);
  }
}
