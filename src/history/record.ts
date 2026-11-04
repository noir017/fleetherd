import type { HistoryKind, HistoryTrigger } from './store.js';

/**
 * What the turn runner hands the library. Deliberately not the store itself: the daemon
 * enriches each event with what only it knows — the conversation's lane, title, agent, host
 * and directory — and a turn that cannot record (no store, a full disk) must go on.
 *
 * `turn` is the id `startTurn` returned for the turn this row belongs to. Every row a turn
 * writes carries it: the prompt that opened it, a mid-turn message merged into it, each tool
 * line and the reply. A row written outside a turn (an import, a background burst before this
 * field existed) has none, and reads as "unknown" rather than being guessed into a neighbour.
 */
export type HistoryEvent =
  /** The prompt a turn (or a mid-turn message) gave the agent. Attachments are names only. */
  | { type: 'prompt'; text: string; attachments?: string[]; kind: HistoryKind; at: number; turn?: number }
  /** One tool call, as the single line the library keeps. */
  | { type: 'tool'; title: string; kind: HistoryKind; at: number; turn?: number }
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
