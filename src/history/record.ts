import type { HistoryKind, HistoryTrigger } from './store.js';

/**
 * What the turn runner hands the library. Deliberately not the store itself: the daemon
 * enriches each event with what only it knows — the conversation's lane, title, agent, host
 * and directory — and a turn that cannot record (no store, a full disk) must go on.
 *
 * `turn` is the id `startTurn` returned for the turn this row belongs to. Every row written
 * inside a turn carries it: the prompt that opened it, a mid-turn message merged into it, each
 * tool line and the reply. Background output opens a turn of its own (see followUpSink), so it
 * carries one too. A row written outside any turn — an imported transcript, or a row recorded
 * before turns existed — has none, and reads as "unknown" rather than being guessed into a
 * neighbour.
 */
export type HistoryEvent =
  /** The prompt a turn (or a mid-turn message) gave the agent. Attachments are names only. */
  | { type: 'prompt'; text: string; attachments?: string[]; kind: HistoryKind; at: number; turn?: number }
  /**
   * One tool call: its line, then its whole arguments (see toolText). `call` is the harness's id
   * for it: a start re-emitted as the arguments stream in, and the finish that carries the final
   * ones, rewrite the same row instead of adding one each (see HistoryStore.message).
   */
  | { type: 'tool'; title: string; call?: string; kind: HistoryKind; at: number; turn?: number }
  /** What the agent said, in full, when a render was sealed. */
  | { type: 'reply'; text: string; kind: HistoryKind; at: number; turn?: number };

/**
 * The message `kind` a turn's trigger gives it. One mapping, because the two are the same fact
 * at different resolutions: `delegate` and `update` are both `subagent` work in the library
 * (they sort and filter together), and a person's turn and an automatic continue are both
 * ordinary conversation.
 */
export function kindForTrigger(trigger: HistoryTrigger): HistoryKind {
  switch (trigger) {
    case 'schedule':
      return 'schedule';
    case 'delegate':
    case 'update':
      return 'subagent';
    case 'background':
      return 'background';
    case 'continue':
    case 'person':
      return 'normal';
  }
}

export type HistoryRecorder = (conversationId: string, event: HistoryEvent) => void;

/**
 * One tool call as a line: `Bash: git status`.
 *
 * The renderer's own line carries an emoji and quotes (`🔧 Bash: "git status"`); the library
 * keeps the part that reads as a sentence, because the point of a tool row is to be found by
 * a search for what it did, not to be pretty in a bubble.
 */
export function toolLine(name: string, preview: string, agent?: string): string {
  const flat = preview.replace(/\s+/g, ' ').trim();
  const who = agent ? `${agent} · ${name}` : name;
  if (!flat) return who;
  return `${who}: ${flat.length > 200 ? `${flat.slice(0, 199)}…` : flat}`;
}

/**
 * How much of one call's arguments the library keeps. Measured on 2026-11-06 over two days of
 * Claude Code transcripts (3,500 calls): median 305 characters, p99 7.5k, largest 31k. The bound is
 * for the pathological call — a Write of a generated file — and the cut says so in the row.
 */
export const TOOL_INPUT_KEEP = 100_000;

/**
 * One tool call as the library keeps it: the line (`Bash: git status`), then the whole arguments
 * as JSON when they say more than the line does.
 *
 * The line alone was the record until 2026-11-06: a 200-character preview, so a heredoc, an Edit's
 * replacement or a Write's content was never in the library at all. The line stays first because
 * it is what a folded read counts by name and what a search excerpt starts from. The output is not
 * kept — it is several times the size of the arguments (12.7 MB against 2.6 MB in the same sample)
 * and what the agent concluded from it is in the reply.
 */
export function toolText(name: string, preview: string, input: unknown, agent?: string): string {
  const line = toolLine(name, preview, agent);
  const full = argumentsText(input);
  if (!full || full === preview.trim()) return line;
  const cut =
    full.length > TOOL_INPUT_KEEP
      ? `${full.slice(0, TOOL_INPUT_KEEP)}\n[cut: ${full.length - TOOL_INPUT_KEEP} more characters]`
      : full;
  return `${line}\n${cut}`;
}

function argumentsText(input: unknown): string {
  if (typeof input === 'string') return input.trim();
  if (!input || typeof input !== 'object') return '';
  if (Object.keys(input).length === 0) return '';
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}
