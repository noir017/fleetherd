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
 *
 * ── Refusals ────────────────────────────────────────────────────────────────────────────────────
 * A prompt also ends with `stopReason: "refusal"` — no rejection, no failure record, one field
 * saying the agent would not answer. ACP defines that reason as "the agent refused to complete the
 * request without answering", so a turn that ends this way with nothing rendered must not read
 * downstream as a finished reply (the card said "finished", `turnFailed.continue` never fired, and
 * only `turn complete` reached the log).
 *
 * CodeBuddy (`custom` harness, `codebuddy --acp`) uses the same reason for two different things.
 * Read from codebuddy 2.180.0's dist/codebuddy-headless.js on 2026-11-06:
 *  - the upstream rejected the request (a 429/usage limit, a sign-in failure, an upstream fault):
 *    the response carries `_meta["codebuddy.ai/errorMessage"]`, a JSON string of
 *    `{code, message, data}` where `data.category` is `quota`, `quota_token_limit`, `auth_expired`,
 *    `network`, `model_service`, … (`classifyErrorAsRequestError`); a 408/502/503/504 is classified
 *    `network`, not a model error;
 *  - the model itself declined (finish reason `content_filter`/`refusal`): `mapFinishReasonToStopReason`
 *    turns that into `refusal`, with no provider error to report.
 *
 * A refusal that carries CodeBuddy's cause always fails, even if the turn had already streamed text
 * or opened a tool: the provider rejected the turn, and a 429 after a tool call is exactly the case
 * that used to read as a finished reply. Only an unnamed refusal — the model declining — asks
 * whether the turn showed anything. claude-agent-acp sends `lastRefusalExplanation` as an ordinary
 * `agent_message_chunk` before reporting that refusal (dist/acp-agent.js, 0.81.0), and that
 * explanation is the answer the person reads, so a ❌ under it would be a bug. An unnamed refusal
 * with nothing visible is a `TurnFailure`.
 *
 * The two causes are kept apart only where it changes what happens next: a named upstream cause is
 * classified into the same lanes as a failure record, so a quota rejection is `limit` and the
 * default `hooks.turnFailed.continue.on` list may continue it; an unnamed refusal is `request`,
 * which that list deliberately leaves out — asking the same model the same question again does not
 * change a content refusal. The `max` on a continue bounds either.
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

/** A prompt that ended in `stopReason: "refusal"`, as a failed turn needs it. */
export interface PromptRefusal {
  /** The failure lane the cause falls into, or `request` when the harness gave none. */
  reason: TurnFailureReason;
  /** The sentence the chat and a sub-agent's card show. */
  message: string;
  /**
   * Whether CodeBuddy attached the cause itself. A named cause is an upstream failure and fails the
   * turn whatever it had already streamed; an unnamed one is the model declining, which is a normal
   * end when the turn showed something.
   */
  named: boolean;
}

const REFUSAL_WITHOUT_CAUSE = 'the agent refused this request (stopReason: refusal)';

/**
 * Read a prompt response that stopped on a refusal. Undefined for every other stop reason, so the
 * caller can run this on the ordinary path without a branch of its own.
 *
 * The cause is only ever read from `_meta`, never from text the agent streamed: a refusal's own
 * message is a sequence of `session/update`s that may be empty (a quota rejection sends none) and,
 * when it is not, is the model's words rather than a reason. `codebuddy.ai/errorMessage` is
 * CodeBuddy's private key, in the same Hyrum's Law position as the AIR record above; a renamed key
 * degrades to the unnamed refusal.
 */
export function readPromptRefusal(
  response: { stopReason?: string; _meta?: unknown } | undefined
): PromptRefusal | undefined {
  if (response?.stopReason !== 'refusal') return undefined;
  const detail = refusalDetail(response._meta);
  if (!detail) return { reason: 'request', message: REFUSAL_WITHOUT_CAUSE, named: false };
  return { reason: refusalReasonOf(detail), message: `the agent refused this request: ${detail.text}`, named: true };
}

/** One refusal's cause: the provider's sentence, plus what it admits about its lane. */
interface RefusalDetail {
  text: string;
  category?: string;
  statusCode?: number;
}

/**
 * The cause a refusal attached, if any. Only CodeBuddy's namespaced key is read: the plain
 * `_meta.errorMessage` some of its fallback paths set is not carried onto the wire, so reading it
 * would only risk catching something else. A JSON body without a usable `message` yields nothing
 * rather than dumping the JSON into the chat.
 *
 * The same key also carries a blocked sensitive input's safe message (`prepareSensitiveUserPrompt`
 * denies with it). That body has no `data.category`, so it lands as `provider` — the turn was
 * refused, not answered, which is the right outcome; the key is not "upstream errors only".
 */
function refusalDetail(meta: unknown): RefusalDetail | undefined {
  const m = asRecord(meta);
  if (!m) return undefined;
  const raw = m['codebuddy.ai/errorMessage'];
  const body = typeof raw === 'string' ? parseJsonObject(raw) : asRecord(raw);
  if (body) {
    const text = typeof body.message === 'string' ? body.message.trim() : '';
    if (!text) return undefined;
    const data = asRecord(body.data);
    const category = typeof data?.category === 'string' ? data.category : undefined;
    const statusCode = typeof data?.statusCode === 'number' ? data.statusCode : undefined;
    return { text, ...(category ? { category } : {}), ...(statusCode !== undefined ? { statusCode } : {}) };
  }
  if (typeof raw === 'string' && raw.trim() !== '' && !raw.trimStart().startsWith('{')) {
    return { text: raw.trim() };
  }
  return undefined;
}

/**
 * Which lane a named cause belongs to. CodeBuddy's own categories first, then the HTTP status for
 * a body that carries only that. Categories are matched by prefix because the quota and auth
 * families are many (`quota_token_limit`, `quota_balance_exhausted`, `auth_expired`,
 * `custom_model_auth`, …). Anything unrecognised is `provider`: it did come from the model path,
 * and reading it as `other` would hide it from a policy naming `provider`.
 */
function refusalReasonOf(detail: RefusalDetail): TurnFailureReason {
  const category = detail.category ?? '';
  if (category.startsWith('quota')) return 'limit';
  if (category.startsWith('auth') || category === 'custom_model_auth') return 'access';
  switch (category) {
    case 'network':
      return 'connection';
    case 'service':
    case 'model_service':
    case 'empty_model_response':
      return 'service';
    case 'request':
      return 'request';
    default:
      break;
  }
  switch (detail.statusCode) {
    case 401:
    case 403:
      return 'access';
    case 429:
      return 'limit';
    // CodeBuddy classifies these as a network error, not a model-service one (see the comment
    // above): the request never reached a model, which is `connection` in the gateway's vocabulary.
    case 408:
    case 502:
    case 503:
    case 504:
      return 'connection';
    default:
      return 'provider';
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.trimStart().startsWith('{')) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
