import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AgentDef } from '../config/schema.js';
import type { QuotaPool } from '../types.js';
import { TurnFailure } from './agent.js';
import { truncateToolName } from './agent-common.js';
import { runAgyCliCommand, runAgyCliFor, type AgyCliRunner } from './agy-cli.js';
import { agyContextWindow, parseAgyUsagePools } from './agy-meters.js';
import { agentHome } from './skills-scan.js';

/**
 * What the ACP runtime does differently for `agy` — the Google Antigravity CLI, served by
 * `agy acp` since 2026-11-06 (agent-acp.ts). Everything that is ACP is handled there like any other
 * harness: `session/new` / `session/load`, the model and effort selectors, permissions, tool calls,
 * `session/cancel`, native tools over MCP. This file holds what `agy acp` 1.5.1 does its own way,
 * each measured with `project-scripts/talkcode-agy-acp/` (probe.mjs, run-probe.sh, run-fail.sh)
 * on this machine and on awsfree2.pod; a test gateway then ran turns, `/model`, `/stop` and a
 * resume against 1.5.2, which agy updated itself to the same day:
 *
 *   - **Two spellings of a model.** `configOptions.model` offers bare ids (`gemini-3.8-flash`) with
 *     the thinking level as a separate `thought_level` option; `agy models`, the stream-json runtime
 *     and therefore configs and stored `/model` choices use `gemini-3.8-flash-high`. See
 *     agySplitModel.
 *   - **A model that does not survive a reload.** `session/load` and `session/resume` both answer
 *     with agy's default model, whatever the session was on — so a configured model must be put back
 *     after a load, not only after `session/new` (agent-acp.ts reapplyPreferences).
 *   - **Diagnostics in the reply.** A retry, a refusal and a spent quota all arrive as an
 *     `agent_message_chunk` of the form `"\n⚠ <text>\n"` — no failure record, no error. See
 *     agyWarningOf and AgyTurnWatch.
 *   - **No `usage_update`.** Usage comes once, in the `session/prompt` response, summed over every
 *     model call the turn made. See AgyTurnWatch.settle.
 *   - **No quota over ACP**, so it is still a one-shot `agy -p=/usage` (createAgyQuotaMeter).
 *   - **Tool names in the title.** `kind` is good for the common tools; the rest are `other`, titled
 *     `Run <tool name>` (`Run invoke_subagent`, `Run mcp_chat_send_file`). See agyAcpToolLabel.
 *
 * ⚠️ HYRUM'S LAW: the warning chunk's shape, the summed usage and the `Run <name>` title are agy's
 * behaviour, not ACP's. agy-acp.test.ts replays the captured frames, so a change shows there; each
 * regression degrades to what any ACP harness gets (a warning rendered as text, no context numbers,
 * a generic tool label) rather than to a broken turn.
 */

// ───────────────────────── which runtime ─────────────────────────

/** `TALKCODE_AGY_RUNTIME: stream-json` in an agy agent's env keeps it on agent-agy.ts (see schema.ts). */
export { AGY_RUNTIME_ENV, agyRuntime } from '../config/schema.js';

// ───────────────────────── models ─────────────────────────

/** The model the session's options offer, flattened to their values. */
function offeredModels(options: SessionConfigOption[] | null | undefined): string[] | undefined {
  const opt = options?.find((o) => o.id === 'model');
  if (!opt || opt.type !== 'select') return undefined;
  return opt.options.flatMap((entry) => ('group' in entry ? entry.options : [entry])).map((o) => o.value);
}

/**
 * A model id in the `agy models` spelling, split into what `agy acp` offers: the model, and the
 * thinking level that spelling folded into its name.
 *
 * `agy acp` 1.5.1 lists `gemini-3.8-flash` as one model with a `thought_level` option of
 * low/medium/high, where `agy models` lists `gemini-3.8-flash-low`, `-medium` and `-high`. Every
 * model chosen before the ACP runtime is in the second spelling — `agents[].model`, and each
 * conversation's stored `/model` choice — and would otherwise be refused as "not among the models
 * it offers", leaving the conversation on agy's default. Ids both lists share
 * (`gpt-oss-120b-medium`, `claude-opus-4-6-thinking`) are offered as they are and never split.
 *
 * Undefined when there is nothing to split: the id is offered, or its base is not.
 */
export function agySplitModel(
  want: string,
  options: SessionConfigOption[] | null | undefined
): { model: string; effort: string } | undefined {
  const offered = offeredModels(options);
  if (!offered || offered.includes(want)) return undefined;
  const m = /^(.+)-(low|medium|high)$/.exec(want);
  if (!m || !offered.includes(m[1]!)) return undefined;
  return { model: m[1]!, effort: m[2]! };
}

/**
 * Whether a harness answers `session/load` on its default model rather than the one the session
 * was on — which makes the configured model something to re-apply after every load, not only once
 * at `session/new` (agent-acp.ts reapplyPreferences). Measured on `agy acp` 1.5.1: a session put on
 * `gpt-oss-120b-medium` came back from both `session/load` and `session/resume` with
 * `currentModelId: gemini-3.8-flash-high`, and its next turn ran on Gemini.
 */
export function forgetsModelOnLoad(def: Pick<AgentDef, 'harness'>): boolean {
  return def.harness === 'agy';
}

// ───────────────────────── warnings in the message stream ─────────────────────────

/**
 * agy's own diagnostic, when an `agent_message_chunk` is one: its text without the frame.
 *
 * Captured on 1.5.1, each a chunk of its own, between newlines and behind U+26A0 and a space:
 *
 *   "\n⚠ API error (attempt 1): INTERNAL (code 500): Internal error encountered.\n"  (retrying)
 *   "\n⚠ Model produced invalid output.\n"                                            (retrying)
 *   "\n⚠ Agent execution terminated due to error.\n"            (gave up, after 8 attempts / ~150s)
 *   "\n⚠ You have exhausted your quota on this model.\n"                        (no model call made)
 *   "\n⚠ Our servers are experiencing high traffic right now, please try again in a minute.\n"
 *
 * The first three were provoked through a proxy answering the Cloud Code API with errors
 * (run-fail.sh), the quota one with Google's 429 body, the last one happened on its own. Strict on
 * purpose — one line, the exact frame — so text the model writes is never mistaken for one.
 */
export function agyWarningOf(text: string): string | undefined {
  const m = /^\n⚠ ([^\n]+)\n$/.exec(text);
  return m?.[1]?.trim() || undefined;
}

/** A warning that says agy is trying again, as opposed to one that says what went wrong. */
function isRetryWarning(warning: string): boolean {
  return /\(attempt \d+\)/i.test(warning);
}

/**
 * What a turn's warnings, tools and usage come to, for the runtime to act on. Built per turn (and
 * per follow-up burst) by agent-acp.ts newTranslationState and fed from translateUpdate.
 *
 * ── Why a warning is not left in the reply ───────────────────────────────────────────────────────
 * It is not the agent's words, and the body belongs to the agent (AgentStreamHandlers.onNotice). Left
 * in, an upstream outage wrote eight "⚠ API error (attempt N)" lines into the reply over 150 seconds,
 * and a spent quota was a ✓ turn whose whole answer was "⚠ You have exhausted your quota". So:
 *
 *   - a retry is said at once, as a notice, once per kind of error per turn — the minutes it can go
 *     on for are exactly when the chat needs to hear something;
 *   - anything else is held until the turn ends. If nothing the agent wrote or ran came after it,
 *     the turn never got its answer and FAILS with it (`provider`, which is what the stream-json
 *     runtime called an agy error too) — the quota, the give-up and the refusal all end a turn this
 *     way, and all three came with no `usage` at all. If the agent carried on, it recovered, and
 *     the warning is said as such.
 *
 * Out of a turn there is nothing to fail and no end to hold for, so every warning is said at once.
 */
export interface AgyTurnWatch {
  /** A text chunk: true when it was agy's warning (and is not reply text), false when it is reply. */
  text(chunk: string): boolean;
  /** A tool call opened. */
  tool(): void;
  /** The prompt settled: what to report, and whether the turn failed. */
  settle(usage: unknown): AgyTurnOutcome;
}

export interface AgyTurnOutcome {
  /** The turn did not get its answer: throw this. */
  failure?: TurnFailure;
  /** Tokens in context after the turn, when the usage can say (see contextTokensOf). */
  contextTokens?: number;
  /** Why there are no context tokens, when there are none. */
  noContext?: 'tools' | 'no-usage';
}

export function agyTurnWatch(agentId: string, notice: (text: string) => void, inTurn: boolean): AgyTurnWatch {
  /** Keys already said this turn: a retry loop repeats itself, the chat should not. */
  const said = new Set<string>();
  const say = (key: string, text: string): void => {
    if (said.has(key)) return;
    said.add(key);
    notice(text);
  };
  const held: string[] = [];
  let lastWarning: string | undefined;
  let endedInWarning = false;
  let tools = 0;
  return {
    text(chunk) {
      const warning = agyWarningOf(chunk);
      if (!warning) {
        if (chunk.trim()) endedInWarning = false;
        return false;
      }
      console.log(`[acp] ${agentId}: agy says: ${warning}`);
      lastWarning = warning;
      endedInWarning = true;
      if (!inTurn) {
        say(warning, `⚠️ ${agentId}: ${warning}`);
      } else if (isRetryWarning(warning)) {
        say(warning.replace(/\(attempt \d+\)/i, ''), `⚠️ ${agentId} hit an error and is retrying: ${warning}`);
      } else {
        held.push(warning);
      }
      return true;
    },
    tool() {
      tools++;
      endedInWarning = false;
    },
    settle(usage) {
      if (endedInWarning && lastWarning) {
        return { failure: new TurnFailure(`agy: ${lastWarning}`, 'provider') };
      }
      for (const w of held) say(w, `⚠️ ${agentId} hit an error and recovered: ${w}`);
      const tokens = contextTokensOf(usage);
      if (tokens === undefined) return { noContext: 'no-usage' };
      // One model call per tool round and one for the answer: a turn that ran a tool made several,
      // and the sum over them is not the context of any one.
      if (tools > 0) return { noContext: 'tools' };
      return { contextTokens: tokens };
    },
  };
}

/**
 * Tokens in context, from a `session/prompt` response's `usage`: input plus cache reads.
 *
 * Measured on 1.5.1 (gpt-oss-120b-medium): the figure covers the whole turn, summed over its model
 * calls. A turn that ran `echo` and then answered reported 5574 + 6016 cached = 11590; the plain turn
 * after it 230 + 5696 = 5926; four tool rounds and an answer, 5601 + 18176 = 23777 ≈ 4 × 5.9k. So it
 * is the context only for a turn of one call — which the caller can tell by the turn having run no
 * tool — and the cached part has to be added back, as it does for the stream-json runtime's per-step
 * figure (agy-meters.ts agyStepContextTokens).
 */
function contextTokensOf(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as { inputTokens?: unknown; cachedReadTokens?: unknown };
  const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const input = n(u.inputTokens);
  if (input === undefined) return undefined;
  return input + (n(u.cachedReadTokens) ?? 0);
}

/** The window to show agy's context against: the configured one, else the measured table's. */
export function agyWindow(def: Pick<AgentDef, 'contextWindow'>, model: string | undefined): number | undefined {
  return def.contextWindow ?? agyContextWindow(model);
}

// ───────────────────────── tool labels ─────────────────────────

/**
 * agy tool name → short display name, aligned with the default `tools.emojiMap` keys (see
 * config/schema.ts) so each bubble picks up the same emoji as the equivalent Claude/Codex tool.
 * Both protocols' spellings: stream-json named `view_file` / `write_to_file`, `agy acp` 1.5.1 names
 * `read_file` / `write_file` for the same tools.
 */
const AGY_TOOL_LABELS: Record<string, string> = {
  run_command: 'Bash',
  command_status: 'Bash',
  send_command_input: 'Bash',
  view_file: 'Read',
  read_file: 'Read',
  read_resource: 'Read',
  notebook_edit: 'Edit',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  sed_file: 'Edit',
  write_to_file: 'Write',
  write_file: 'Write',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  list_dir: 'Glob',
  read_url_content: 'WebFetch',
  open_browser_url: 'WebFetch',
  search_web: 'WebSearch',
  invoke_subagent: 'Task',
  browser_subagent: 'Task',
  define_subagent: 'Task',
  manage_task: 'Task',
};

/** The label for one of agy's tools by its own name, or undefined for one not in the table. */
export function agyToolLabel(name: string): string | undefined {
  return AGY_TOOL_LABELS[name];
}

/**
 * The label for a tool call `agy acp` made, or undefined to leave it to the generic `kind` mapping
 * (agent-acp.ts toolLabel).
 *
 * Needed for the calls `agy acp` files as `kind: "other"`, whose title is `Run <tool name>`: a
 * subagent (`Run invoke_subagent`, which the stream-json runtime showed as a Task) and every MCP
 * tool, the gateway's own `send_file` among them (`Run mcp_chat_send_file` — agy joins server and
 * tool with single underscores, where the generic rule expects Claude Code's `mcp__chat__send_file`).
 * Read off the title because that is in the schema: agy also sends the bare name as a `name` field,
 * but the SDK's validation strips a field ACP does not define before the gateway sees the update.
 */
export function agyAcpToolLabel(title: string | undefined, kind: string | undefined): string | undefined {
  if (kind && kind !== 'other') return undefined;
  const name = title ? /^Run ([A-Za-z0-9_-]+)$/.exec(title.trim())?.[1] : undefined;
  if (!name) return undefined;
  const known = agyToolLabel(name);
  if (known) return known;
  const mcp = /^mcp_[A-Za-z0-9-]+_([A-Za-z0-9_-]+)$/.exec(name);
  return truncateToolName(mcp?.[1] ?? name);
}

// ───────────────────────── quota ─────────────────────────

/** How old a quota reading may get before a turn asks `agy -p=/usage` again. */
const QUOTA_REFRESH_MS = 60_000;

export interface AgyQuotaMeter {
  /** Re-read the pools for this agent's account, unless a recent reading or one in flight makes it pointless. */
  refresh(def: AgentDef, cwd: string): Promise<void>;
  /** The latest reading for this agent's account. */
  read(def: AgentDef): QuotaPool[] | undefined;
}

/**
 * The quota pools, per account: a one-shot `agy -p=/usage` (agy-cli.ts), at most once a minute per
 * home and never two at once. `agy acp` 1.5.1 has nothing in its place — no method, no `_meta`, and
 * a `/usage` prompt is answered by the model as a question about usage.
 *
 * The same reading the stream-json runtime takes (agent-agy.ts metersFor), kept separately so that
 * file can go without taking this with it. Keyed like it: the quota belongs to whoever agy is signed
 * in as, so every conversation on a home shares one reading, and the same HOME on two hosts is two.
 */
export function createAgyQuotaMeter(cli: AgyCliRunner = runAgyCliCommand): AgyQuotaMeter {
  const byHome = new Map<string, { pools?: QuotaPool[]; at: number; pending?: Promise<void> }>();
  const homeOf = (def: AgentDef): string => (def.host ? `${def.host}:${def.env['HOME'] ?? '~'}` : agentHome(def));
  return {
    refresh(def, cwd) {
      const home = homeOf(def);
      let entry = byHome.get(home);
      if (!entry) byHome.set(home, (entry = { at: 0 }));
      if (entry.pending) return entry.pending;
      // Stamped when the run starts, so a failing one is not retried on every turn either.
      if (Date.now() - entry.at < QUOTA_REFRESH_MS) return Promise.resolve();
      entry.at = Date.now();
      const e = entry;
      e.pending = runAgyCliFor(def, 'usage', cwd, cli)
        .then((r) => {
          if (!r.ok) {
            console.debug(`[acp] could not read agy's quota (${def.id}):`, r.error);
            return;
          }
          const pools = parseAgyUsagePools(r.output);
          if (pools) e.pools = pools;
        })
        .finally(() => {
          e.pending = undefined;
        });
      return e.pending;
    },
    read: (def) => byHome.get(homeOf(def))?.pools,
  };
}
