/**
 * Wire-format sender IDs written to the history library (a typo records a scheduled run as a person's).
 * DELEGATE_SENDER and UPDATE_SENDER are attended turns, so permission levels that ask still ask the person (invariant 1);
 * UPDATE_SENDER stays distinct so a `/super` topic is not named after its first update card.
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
