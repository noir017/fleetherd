import type { ConversationId, ToolEvent } from '../types.js';

/**
 * What a conversation's agent is doing *right now* — the live half of the sub-agent view.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────────────────
 * `TurnOutcomes` only learns something when a turn ends, which is exactly when a sub-agent's long
 * turn is the thing the agent that opened it needs to see. Reported 2026-11-03: a sub-agent ran
 * 150+ tool calls while `tasks` showed `stage: working` and an empty line, and the only way to find
 * out what it was doing was to ssh into its host and read the transcript. A turn's *end* is not
 * news when the turn is the problem.
 *
 * ── What it is not ────────────────────────────────────────────────────────────────────────────
 * Not a log and not a source of truth about outcomes: it holds only the turn that is running, is
 * cleared the moment that turn ends, and never invents a value. A harness that reports no tool
 * calls shows a step count of zero, which is honest.
 *
 * It is fed from `onToolStart`, synchronously and off the rendering chain: the callbacks that draw
 * tool bubbles are enqueued behind network writes, and a status read must not wait for a rate-limited
 * chat to finish painting.
 */

/** How many recent tool calls are kept for `task-status`. */
export const RECENT_TOOLS = 3;

/** How much of a tool's argument preview is kept. The full command can be a whole script. */
export const DETAIL_CHARS = 120;

/** One tool call as the live view shows it. */
export interface ToolCall {
  /** Epoch ms, from the daemon's clock. */
  at: number;
  /** The tool's name, with the subagent that ran it when the harness says (`probe · Bash`). */
  tool: string;
  /** Its arguments, flattened to one line and cut at DETAIL_CHARS. */
  detail: string;
}

/** One conversation's turn in flight. */
export interface LiveTurn {
  /** When the turn started, epoch ms. */
  startedAt: number;
  /** Tool calls started in this turn. */
  steps: number;
  /** The last tool call started — what it is doing now, as far as anyone can tell. */
  current?: ToolCall;
  /** The last RECENT_TOOLS calls, oldest first. */
  recent: ToolCall[];
}

export class TurnProgressBoard {
  private readonly turns = new Map<ConversationId, LiveTurn>();

  constructor(private readonly clock: { now(): number }) {}

  /** A turn started here: whatever the last one left is not "now". */
  started(id: ConversationId): void {
    this.turns.set(id, { startedAt: this.clock.now(), steps: 0, recent: [] });
  }

  /**
   * A tool call started. Ignored when no turn is known: out-of-turn (follow-up) output has no
   * start and no end to bound it, so recording it would leave a line that never goes away.
   */
  tool(id: ConversationId, evt: ToolEvent): void {
    const turn = this.turns.get(id);
    if (!turn) return;
    const call: ToolCall = {
      at: this.clock.now(),
      tool: evt.agent ? `${evt.agent} · ${evt.name}` : evt.name,
      detail: flatten(evt.inputPreview),
    };
    turn.steps += 1;
    turn.current = call;
    turn.recent.push(call);
    if (turn.recent.length > RECENT_TOOLS) turn.recent.shift();
  }

  /**
   * Forget a conversation (a reset, or an idle reclaim). A finished turn's last tools are kept
   * until then on purpose: "what did it do before it failed" is asked after the turn ended, and
   * `tasks` only shows the live half while the stage is `working`.
   */
  forget(id: ConversationId): void {
    this.turns.delete(id);
  }

  progressOf(id: ConversationId): LiveTurn | undefined {
    return this.turns.get(id);
  }

  dispose(): void {
    this.turns.clear();
  }
}

/** One line, bounded: a preview that spans lines breaks a one-row-per-topic table. */
function flatten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 1)}…` : flat;
}
