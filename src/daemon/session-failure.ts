import type { TurnFailureReason } from '../types.js';

/**
 * claude-agent-acp's typed failure records (its "AIR session failure" extension): the capability
 * that asks for them, and how one is read off the wire.
 *
 * ── Why the gateway asks for them ───────────────────────────────────────────────────────────────
 * Without them, Claude Code retrying a failing API looks exactly like a hang. Reported 2026-10-06:
 * the newapi gateway first left a request hanging until it timed out after five minutes, then
 * answered `500 Database error` and a run of `503`s. Claude Code kept retrying for the whole ten
 * minutes (its transcript records each attempt as an `api_error`, out of 10), and the turn failed
 * with "sent no update for 600000ms … treating it as hung". The adapter DOES turn every attempt
 * into a "Retrying Claude, attempt N of M." record, but only for a client that advertised this
 * capability at `initialize`. Anyone else gets nothing, because the record is dropped inside the
 * adapter. Every update re-arms the silence watchdog, so receiving these records is the whole fix
 * for the false "hung". Showing them is what tells the user why the turn is slow.
 *
 * ── What else changes once a client asks ────────────────────────────────────────────────────────
 * Read from the 0.81.0 and 0.81.2 dist (identical for this extension) on 2026-10-06:
 * 1. A turn that fails on the provider, ends with no result, or loses its transport no longer
 *    REJECTS `session/prompt`. It resolves with `stopReason: "end_turn"` and puts the failure in
 *    `_meta`, so a client that asks and then does not look reports a failed turn as a success. The
 *    adapter also stops forwarding the error text as an ordinary agent message. runTurn reads the
 *    record and fails the turn with its title, which is the same text the rejection used to carry
 *    after its "Internal error: " prefix.
 * 2. A failure with no turn to attach to (a background cycle's own, a sign-out, a dying worker)
 *    arrives as a `session_info_update`. So does the model-fallback advisory, which used to be a
 *    bold line inside the agent's text. Both become notices (see the `onSessionFailure` wiring in
 *    agent-acp.ts).
 * 3. The one rejection left, a stream that died outside a turn, loses its raw detail: the adapter
 *    strips it in favour of the record. The adapter still writes it to stderr, which is daemon.log.
 * 4. `session/load` re-publishes past usage-limit failures from history. That is history, not
 *    news, and it arrives before the first prompt, which is where the runtime stops announcing.
 *
 * ⚠️ HYRUM'S LAW: `_meta.jetbrains.air` is claude-agent-acp's private extension (named for
 * JetBrains' AIR client), not ACP. session-failure.test.ts runs this module against the installed
 * adapter's own encoder and capability check. If either is renamed the test fails, instead of the
 * false "hung" quietly coming back.
 */

/** One failure record as the gateway uses it. */
export interface SessionFailure {
  /**
   * Identity of one incident. The retry warnings for one prompt all share it, with the adapter's
   * `revision` counting up, and the turn's terminal failure re-uses it as well.
   */
  id: string;
  /**
   * `error` ends something; `warning` reports a retry in progress or an advisory. A value the
   * adapter does not send today reads as a warning: an unknown record must never fail a turn.
   */
  severity: 'error' | 'warning';
  /** The adapter's coarse lane: service, limit, connection, access, request, or unknown (advisory). */
  category: string;
  title: string;
  details?: string;
}

/**
 * The `_meta` that goes in `initialize`'s `clientCapabilities` to receive failure records: AIR
 * extension version 1, advertising `sessionFailure` and nothing else. The adapter gates other
 * behaviour (subagent sessions, async tasks, file-change reports) on other names in the same list,
 * so this list is kept to exactly the one this module handles.
 */
export const SESSION_FAILURE_CAPABILITY_META = {
  jetbrains: { air: { version: 1, capabilities: ['sessionFailure'] } },
};

/**
 * The failure record in an update's or a prompt response's `_meta`, or undefined when there is
 * none. Wire data, so every field is checked rather than cast. A record without a usable id or
 * title is treated as absent, because there would be nothing to say about it.
 */
export function readSessionFailure(meta: unknown): SessionFailure | undefined {
  const f = asRecord(asRecord(asRecord(asRecord(meta)?.jetbrains)?.air)?.sessionFailure);
  if (!f) return undefined;
  const { id, severity, category, title, details } = f;
  if (typeof id !== 'string' || typeof title !== 'string' || title.trim() === '') return undefined;
  return {
    id,
    severity: severity === 'error' ? 'error' : 'warning',
    category: typeof category === 'string' ? category : 'unknown',
    title: title.trim(),
    ...(typeof details === 'string' && details.trim() !== '' ? { details: details.trim() } : {}),
  };
}

/**
 * A record as one line of chat: the title, followed by the details when they add anything. The
 * adapter fills `details` with a copy of the title in some lanes (a sign-out), and repeating it
 * would only double the line.
 */
export function describeSessionFailure(f: SessionFailure): string {
  const extra = f.details && !f.title.includes(f.details) ? ` ${f.details}` : '';
  return `${f.title}${extra}`.replace(/\s+/g, ' ');
}

/**
 * The turn-failure reason a terminal record stands for (TurnFailureReason): the adapter's own lane
 * when it is one of the five it documents, else `provider` — the record came from the provider path
 * whatever its lane is called, and an unrecognised lane must not read as the gateway's `other`.
 */
export function failureReasonOf(f: SessionFailure): TurnFailureReason {
  switch (f.category) {
    case 'service':
    case 'limit':
    case 'connection':
    case 'access':
    case 'request':
      return f.category;
    default:
      return 'provider';
  }
}

/**
 * Which records count as the same news, so a notice is sent once per key and the rest are only
 * logged.
 *
 * A retry series sends one warning per attempt ("attempt 1 of 10", "attempt 2 of 10", …), and ten
 * messages saying the same thing would be noise. So warnings are keyed by category: a retry whose
 * cause changes (a dropped connection turning into a 5xx) is announced again, and the next attempt
 * of the same cause is not. Errors are rare and each is its own news, so they are keyed by id, and
 * only a re-published revision of the same record is held back.
 */
export function failureNoticeKey(f: SessionFailure): string {
  return f.severity === 'warning' ? `warning:${f.category}` : `error:${f.id}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
