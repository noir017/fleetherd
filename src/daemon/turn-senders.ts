/**
 * Synthetic sender IDs mapped to history-library triggers by `historyTriggerOf` (a typo records a
 * scheduled run as a person's). Turns of every sender follow the agent's permission level and still
 * ask the person when that level asks (invariant 1; see turn-runner.ts:122); UPDATE_SENDER stays
 * distinct so a `/super` topic is not named after its first update card.
 */
export const SCHEDULED_SENDER = 'schedule';
export const CONTINUE_SENDER = 'continue';
export const DELEGATE_SENDER = 'delegated';
export const UPDATE_SENDER = 'sub-agent-updates';
export const RECONNECT_SENDER = 'reconnect';

/** Senders the gateway writes as; messages from any other sender are typed by a person. */
export const GATEWAY_SENDERS: ReadonlySet<string> = new Set([
  SCHEDULED_SENDER,
  CONTINUE_SENDER,
  DELEGATE_SENDER,
  UPDATE_SENDER,
  RECONNECT_SENDER,
]);

/**
 * A person's own messages in a turn batch or merged into a running turn (excludes gateway senders).
 * `text` is the prompt as the agent read it (including quoted lines and voice transcripts); `attachments` are filenames only.
 */
export interface PersonWords {
  text: string;
  attachments: string[];
  turn?: number;
}
