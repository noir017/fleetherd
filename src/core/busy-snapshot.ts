import { type Locale } from './i18n/index.js';
import { tRuntime } from './i18n/runtime.js';
import { formatRuntimeFooter } from './runtime-footer.js';

/**
 * The gateway's own answer to a session query (`/usage`, `/context`) asked while the conversation
 * is busy — pure text, no clock (elapsed time is passed in).
 *
 * Exists because forwarding the command is what the translation table would do, and a forwarded
 * command interrupts the running turn (see GenericCommand.query in command-translate.ts). So the
 * answer is built from what the gateway already holds: the latest context snapshot and the last
 * cost the harness reported. It is deliberately LESS than the harness's own answer — claude's
 * native `/usage` adds per-model tokens, cache and API time, none of which reaches the gateway —
 * and the note says so, so nobody mistakes the snapshot for the full report.
 */

export interface UsageSnapshotInput {
  /** Display name of the agent answering the conversation. */
  agent: string;
  /** Latest context snapshot; absent when the harness has reported none yet. */
  usage?: { used: number; size: number };
  /** Cumulative session cost as of the last finished turn; absent when never reported. */
  cost?: { amount: number; currency: string };
  /** How long the running turn has been going; absent while it is still being collected. */
  runningForMs?: number;
  locale?: Locale;
}

/** `$30.64` for USD (the only currency seen so far), `12.50 EUR` otherwise. */
export function formatCost(cost: { amount: number; currency: string }): string {
  const amount = cost.amount.toFixed(2);
  return cost.currency.toUpperCase() === 'USD' ? `$${amount}` : `${amount} ${cost.currency}`;
}

/**
 * `42s`, `4m 12s`, `1h 3m`. Finer than schedule.ts's formatDuration on purpose: that one rounds to
 * whole minutes for a run that is over, while this answers "is it still moving", where 4m and 4m 50s
 * are different answers.
 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The `/usage` snapshot body (the busy note is appended separately — see busyNote). */
export function formatUsageSnapshot(input: UsageSnapshotInput, locale?: Locale): string {
  const loc = locale ?? input.locale ?? 'en';
  const lines = [tRuntime(loc, 'usageSnapshotTitle', { agent: input.agent })];
  const context = input.usage
    ? formatRuntimeFooter({ contextTokens: input.usage.used, contextLength: input.usage.size }, ['context'])
    : '';
  lines.push(
    context
      ? tRuntime(loc, 'usageSnapshotContext', { context })
      : tRuntime(loc, 'usageSnapshotContextNotReported')
  );
  // "Not reported" rather than "yet": codex-acp never sends a cost at all, while claude sends one
  // only when a turn finishes, and nothing here can tell the two apart honestly.
  lines.push(
    input.cost
      ? tRuntime(loc, 'usageSnapshotCost', { cost: formatCost(input.cost) })
      : tRuntime(loc, 'usageSnapshotCostNotReported')
  );
  if (input.runningForMs !== undefined) lines.push(tRuntime(loc, 'usageSnapshotRunning', { elapsed: formatElapsed(input.runningForMs) }));
  return lines.join('\n');
}

/**
 * The line appended to every busy answer: why the gateway answered, and how to get the harness's
 * own. Worded for both states the caller treats as busy — a running turn, which a forwarded command
 * would have had to wait out, and a batch still in its merge window, which it would have been glued
 * onto. Either way the command would not have been answered now.
 */
export function busyNote(command: string, agent: string, locale: Locale = 'en'): string {
  return tRuntime(locale, 'busyNote', { command, agent });
}
