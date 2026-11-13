import { formatButtonId, parseButtonId } from './button-id.js';

/**
 * The buttons on a failed turn's ❌ notice: send the same input again, to the same agent or to one
 * the person picks. The daemon keeps the input under the id (daemon/failed-input.ts); the button
 * carries only that and which of the two it is, on the shared `<prefix><reqId>:<n>` grammar.
 *
 * Before these, the only way to try a failed turn again was to copy the message out and send it
 * once more — into a new conversation when the agent itself was what failed (#208467 → #208472,
 * #208530 → #208565, 2026-11-12). The web UI's own Retry is a different thing: it re-posts a message
 * the browser never managed to send.
 */

/** `rty:<retryId>:<0 | 1>` — 0 the same agent, 1 another one. */
export const RETRY_PREFIX = 'rty:';

export type RetryMode = 'same' | 'other';

export interface RetryButtonClick {
  retryId: string;
  mode: RetryMode;
}

/** The notice's buttons. `anotherAgent` is false when there is no other agent to pick. */
export function retryButtons(
  retryId: string,
  opts: { anotherAgent: boolean }
): Array<{ id: string; label: string; style?: 'primary' | 'secondary' }> {
  return [
    { id: formatButtonId(RETRY_PREFIX, retryId, 0), label: 'Retry', style: 'primary' },
    ...(opts.anotherAgent ? [{ id: formatButtonId(RETRY_PREFIX, retryId, 1), label: 'Retry with another agent', style: 'secondary' as const }] : []),
  ];
}

/** Decode a retry button's id, or null when it is not one. */
export function parseRetryButtonId(id: string): RetryButtonClick | null {
  const parsed = parseButtonId(id, RETRY_PREFIX);
  if (!parsed || parsed.n > 1) return null;
  return { retryId: parsed.reqId, mode: parsed.n === 0 ? 'same' : 'other' };
}
