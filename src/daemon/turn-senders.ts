/** Synthetic sender IDs written by the gateway; any other sender is a person's message. */
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

/** A person's own messages in a turn batch or merged into a running turn (excludes gateway senders). */
export interface PersonWords {
  text: string;
  attachments: string[];
  turn?: number;
}
