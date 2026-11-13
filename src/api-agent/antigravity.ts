/**
 * The Antigravity backend: Google's Interactions API, wrapped as a turn.
 *
 * Everything here was established against the live API on 2026-11-13
 * (`project-reports/agent-antigravity-probe-20261113.md`; raw, redacted streams in
 * `project-scripts/antigravity-agent-probe/*.sse`). The parts that are not obvious:
 *
 * - **Background + follow.** A turn is created with `background: true` and then read with
 *   `GET /interactions/{id}?stream=true`. Creating it in the foreground would make the POST the
 *   stream, and a POST cannot be cancelled from here without killing the response — the id is
 *   what `/cancel` needs, and the id only exists once creation returns.
 * - **The GET replays from the beginning.** Measured 2026-11-13 (`probe-reconnect.mjs`): a
 *   reconnect while the interaction is still running answers 200 and starts again at
 *   `interaction.created`. There is no `event_id` in any frame — 0 of 292 in the recorded stream,
 *   0 of 8 in the live one — so the documented `?last_event_id=` resume has nothing to resume
 *   from; reconnection counts frames already handled and skips that many instead.
 * - **A reconnect can be refused.** The same probe got 400 `Precondition check failed` when it
 *   reconnected in the instant after aborting the first stream, and again after the interaction
 *   had finished. The first is transient (a retry a few seconds later returned 200); the second
 *   is resolved by reading the interaction itself, so a stream lost after the answer completed
 *   still ends the turn normally.
 * - **`step.delta` is the only text channel**, and `thought_signature` is opaque noise that must
 *   be dropped: the recorded turns carry 172–1016 characters of it per turn, and rendering it
 *   would pour base64 into the chat.
 * - **`agent_config.model` is per interaction** (only an `agents.create` managed agent locks it),
 *   so `/model` switches mid-conversation without touching the continuation ids — verified: a
 *   continuation with a different model was accepted (200).
 * - **Cancellation is best-effort.** `/cancel` only works while the interaction is still
 *   `in_progress`; delayed attempts returned 400 (probed at 2.5s, 4.5s and 8s). So the local turn
 *   stops immediately either way, and the POST is fired as soon as the id exists.
 */
import {
  ApiAgentError,
  type ApiBackend,
  type BackendEvent,
  type ModelOption,
  type PromptImage,
  type TurnRequest,
} from './backend.js';
import { readSse, type SseFrame } from './sse.js';

/**
 * The six values `agent_config.model` accepts for `antigravity-preview-09-2026`
 * (antigravity-agent.md §Model selection, 2026-11-13). Carbon and Argon are labelled because the
 * free tier answers them with a 429 and "Please upgrade your tier" — a menu that hides that would
 * turn a model choice into a failed turn.
 */
export const ANTIGRAVITY_MODELS: readonly ModelOption[] = [
  { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen (default)' },
  { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon (paid tier)' },
  { value: 'gemini-4-argon', name: 'Gemini 4 Argon (paid tier)' },
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { value: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
  { value: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite' },
];

/** The model the API itself defaults to (antigravity-agent.md, 2026-11-13). */
export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-4-hydrogen';

/** The agent code the Interactions API names; the model is chosen separately. */
const ANTIGRAVITY_AGENT = 'antigravity-preview-09-2026';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * The API revision the probe ran against. The interactions endpoints are preview surface and
 * change shape between revisions, so the header is pinned rather than omitted — an unversioned
 * request is how a working integration breaks silently on Google's schedule.
 */
const API_REVISION = '2026-05-20';

/**
 * Context window of the preview model: 1,048,576 tokens (models/antigravity-preview-09-2026,
 * 2026-11-13). Only used for the footer's percentage; the API reports usage, not its window.
 */
const CONTEXT_WINDOW = 1_048_576;

/** A dropped stream is retried this many times before the turn fails. */
const MAX_RECONNECTS = 6;

/** An interaction id is 70 characters and appears in every log line; ten is enough to correlate. */
const shortId = (id: string | undefined): string => (id ? `${id.slice(0, 10)}…` : 'none');

/**
 * Thrown by `stream()` when the stream is gone but the interaction itself reached a terminal
 * state: the answer exists, it just was not delivered. `turn()` renders what is left of it.
 */
class InteractionFinished extends Error {
  constructor(readonly interaction: Record<string, unknown>) {
    super('the interaction finished while the stream was down');
    this.name = 'InteractionFinished';
  }
}

export interface AntigravityOptions {
  /** `GEMINI_API_KEY`; empty is allowed so the first turn can say so in the chat. */
  apiKey: string;
  /** The models to offer, already narrowed by `--models`. */
  models?: readonly ModelOption[];
  /** Per-turn `max_total_tokens`. */
  maxTokens: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests; no trailing slash. */
  baseUrl?: string;
  log?: (line: string) => void;
}

interface InteractionBody {
  id?: string;
  status?: string;
  environment_id?: string;
  interaction?: { id?: string; status?: string; environment_id?: string };
}

export function createAntigravityBackend(options: AntigravityOptions): ApiBackend {
  return new AntigravityBackend(options);
}

class AntigravityBackend implements ApiBackend {
  readonly id = 'antigravity';
  readonly defaultModel: string;
  readonly models: ModelOption[];

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly log: (line: string) => void;
  private readonly maxTokens: number;

  constructor(options: AntigravityOptions) {
    this.models = options.models?.length ? [...options.models] : [...ANTIGRAVITY_MODELS];
    this.defaultModel = this.models.some((model) => model.value === ANTIGRAVITY_DEFAULT_MODEL)
      ? ANTIGRAVITY_DEFAULT_MODEL
      : this.models[0]!.value;
    this.apiKey = options.apiKey.trim();
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.log = options.log ?? ((line: string) => console.error(line));
    this.maxTokens = options.maxTokens;
  }

  async *turn(request: TurnRequest): AsyncGenerator<BackendEvent> {
    if (!this.apiKey) {
      throw new ApiAgentError(
        "GEMINI_API_KEY is not set for this agent; add it to the agent's env in config.yaml",
        'auth',
      );
    }
    const created = await this.create(request);
    this.log(`[api-agent] interaction ${shortId(created.id)} created (environment ${shortId(created.environmentId)})`);
    yield { type: 'state', lastInteractionId: created.id, environmentId: created.environmentId };

    // A /stop that landed while the POST was in flight has no id yet; now it does, so the
    // server-side turn is cancelled on the way out instead of left running for nothing.
    if (request.signal.aborted) {
      await this.cancel(created.id);
      throw new ApiAgentError('cancelled', 'network');
    }

    const mapper = new AntigravityEventMapper(this.maxTokens);
    try {
      for await (const frame of this.stream(created.id, request.signal)) {
        for (const event of mapper.push(frame)) yield event;
        // Yielded before the throw so the final usage reaches the footer even on an incomplete
        // turn: the mapper records the failure and hands back the events it already produced.
        if (mapper.failure) throw mapper.failure;
        if (frame.data.trim() === '[DONE]') {
          if (!mapper.completed) {
            throw new ApiAgentError('the Antigravity stream ended before the interaction completed', 'upstream');
          }
          return;
        }
      }
    } catch (err) {
      // The stream is gone, but the interaction finished: deliver the part of the answer that was
      // never streamed, then the terminal event, so a drop at the very end is not a failed turn.
      if (err instanceof InteractionFinished) {
        for (const event of mapper.recover(err.interaction)) yield event;
        if (mapper.failure) throw mapper.failure;
        return;
      }
      throw err;
    }
    if (!mapper.completed) {
      throw new ApiAgentError('the Antigravity stream ended before the interaction completed', 'upstream');
    }
  }

  /** Best-effort: the local turn is already over, so a failure is only a log line. */
  async cancel(interactionId: string | undefined): Promise<void> {
    if (!interactionId) return;
    try {
      const res = await this.fetchImpl(this.url(`/interactions/${encodeURIComponent(interactionId)}/cancel`), {
        method: 'POST',
        headers: this.headers(),
        // Not the turn's signal: that one is already aborted, which would cancel this request.
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const detail = upstreamMessage(await res.text().catch(() => '')) ?? `HTTP ${res.status}`;
        this.log(`[api-agent] cancel ${shortId(interactionId)} failed: ${detail}`);
      }
    } catch (err) {
      this.log(`[api-agent] cancel ${shortId(interactionId)} failed: ${messageOf(err)}`);
    }
  }

  private async create(request: TurnRequest): Promise<{ id: string; environmentId?: string }> {
    const body: Record<string, unknown> = {
      agent: ANTIGRAVITY_AGENT,
      input: inputOf(request.text, request.images),
      // A fresh conversation gets a remote sandbox; a continuation reuses the one it ran in.
      environment: request.environmentId ?? 'remote',
      // The POST must return the id rather than the stream: that id is what /cancel takes.
      stream: false,
      background: true,
      agent_config: { type: 'antigravity', model: request.model, max_total_tokens: String(this.maxTokens) },
    };
    if (request.previousInteractionId) body.previous_interaction_id = request.previousInteractionId;

    const res = await this.call('POST', '/interactions', body, request.signal);
    if (!res.ok) throw await this.fail(res, request.signal, request.previousInteractionId);
    const parsed = (await res.json().catch(() => ({}))) as InteractionBody;
    const id = parsed.id ?? parsed.interaction?.id;
    if (!id) {
      throw new ApiAgentError('the Antigravity API accepted the turn but returned no interaction id', 'upstream');
    }
    return { id, environmentId: parsed.environment_id ?? parsed.interaction?.environment_id };
  }

  /**
   * Read the interaction's stream, reconnecting on a drop.
   *
   * There is no `last_event_id` to send: the live frames carried no `event_id` (see the header),
   * and a reconnect replays from `interaction.created`. Frames are therefore counted, and a
   * replay skips what was already handed to the caller.
   *
   * Two kinds of close are retried, both bounded: an error, and a clean EOF before `[DONE]` — the
   * server closing a stream that has not finished, which used to fail the turn outright. A
   * reconnect that yields no new frames twice in a row ends it: retrying the same log forever only
   * delays the failure.
   */
  private async *stream(id: string, signal: AbortSignal): AsyncGenerator<SseFrame> {
    let skip = 0;
    let emptyReconnects = 0;
    for (let attempt = 0; ; attempt++) {
      const already = skip;
      let seen = 0;
      let sawDone = false;
      try {
        const res = await this.openStream(id, signal);
        if (!res.body) throw new ApiAgentError('the Antigravity stream response had no body', 'upstream');
        for await (const frame of readSse(res.body)) {
          seen += 1;
          if (seen <= skip) continue;
          skip += 1;
          if (frame.data.trim() === '[DONE]') sawDone = true;
          yield frame;
        }
        if (sawDone) return;
        if (seen < already) {
          throw new ApiAgentError('the replayed stream was shorter than what was already read', 'upstream');
        }
        emptyReconnects = seen === already ? emptyReconnects + 1 : 0;
        if (emptyReconnects >= 2) {
          throw new ApiAgentError(
            'the Antigravity stream closed before completion and a reconnect delivered no new events',
            'upstream',
          );
        }
        throw new ApiAgentError('the Antigravity stream closed before completion', 'network');
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof InteractionFinished) throw err;
        // An HTTP error from the API is an answer, not a flaky connection: retrying a 429 or a
        // 401 only spends time. Network failures, drops and clean early EOFs are what the loop is
        // for.
        if (err instanceof ApiAgentError && err.kind !== 'network') throw err;
        if (attempt >= MAX_RECONNECTS) {
          throw new ApiAgentError(
            `lost the Antigravity stream and could not reconnect after ${MAX_RECONNECTS} attempts: ${messageOf(err)}`,
            'network',
          );
        }
        this.log(
          `[api-agent] stream for ${shortId(id)} dropped (${messageOf(err)}); reconnecting, ${skip} event(s) already read`,
        );
        await sleep(500 * 2 ** attempt, signal);
      }
    }
  }

  /**
   * Open the stream, turning the API's refusals into the two outcomes the caller can act on.
   *
   * 400/404 is the API refusing to (re)open the stream: measured transiently right after an
   * abort, and permanently once the interaction has finished (2026-11-13). Ask the interaction
   * itself which one it is; a finished one is delivered from its steps, a running one is retried.
   */
  private async openStream(id: string, signal: AbortSignal): Promise<Response> {
    const res = await this.call('GET', `/interactions/${encodeURIComponent(id)}?stream=true`, undefined, signal);
    if (res.ok) return res;
    if (res.status === 400 || res.status === 404) {
      const finished = await this.terminalInteraction(id, signal);
      if (finished) throw new InteractionFinished(finished);
      const detail = upstreamMessage(await res.text().catch(() => '')) ?? `HTTP ${res.status}`;
      throw new ApiAgentError(`the Antigravity stream is unavailable (${res.status}: ${detail})`, 'network');
    }
    throw await this.fail(res, signal);
  }

  /**
   * The interaction itself (no stream), when it has reached a terminal state.
   *
   * Probed 2026-11-13: `GET /interactions/{id}` answers 200 for a real id and 404 `not_found` for
   * a well-formed id that never existed, so the same call is the existence test `fail()` needs
   * and the recovery path for a stream that closed after the answer was ready.
   */
  private async terminalInteraction(id: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    try {
      const res = await this.call('GET', `/interactions/${encodeURIComponent(id)}`, undefined, signal);
      if (!res.ok) {
        await res.text().catch(() => '');
        return undefined;
      }
      const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      const status = typeof body?.status === 'string' ? body.status : '';
      if (!status || status === 'in_progress' || status === 'requires_action') return undefined;
      return body;
    } catch {
      return undefined;
    }
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-goog-api-key': this.apiKey,
      'Api-Revision': API_REVISION,
    };
  }

  private url(suffix: string): string {
    return `${this.baseUrl}${suffix}`;
  }

  private async call(method: 'GET' | 'POST', suffix: string, body: unknown, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(this.url(suffix), {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ApiAgentError(`cannot reach the Antigravity API: ${messageOf(err)}`, 'network');
    }
  }

  /**
   * Turn an HTTP failure into something the person in the chat can act on.
   *
   * A 400/404 on a continuation is **not** enough to call the context expired: the same status
   * comes back for a bad model, a bad image or a malformed input, and resetting then would drop
   * the conversation and fail the resent message the same way. So the API is asked whether the
   * interaction the session points at still exists — 404 `not_found` for one that does not, 200
   * for a real one (probed 2026-11-13). Only "gone" resets; anything else is reported as the
   * upstream error it is, and the session keeps its state.
   */
  private async fail(res: Response, signal: AbortSignal, previousInteractionId?: string): Promise<ApiAgentError> {
    const text = await res.text().catch(() => '');
    const upstream = upstreamMessage(text) ?? `HTTP ${res.status}`;
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      const after = retry ? ` (retry after ${retry}s)` : '';
      return new ApiAgentError(`rate limited by the Antigravity API (429): ${upstream}${after}`, 'rate_limit');
    }
    if (res.status === 401 || res.status === 403) {
      return new ApiAgentError(`the Antigravity API rejected GEMINI_API_KEY (${res.status}): ${upstream}`, 'auth');
    }
    if (previousInteractionId && (res.status === 400 || res.status === 404)) {
      const exists = await this.interactionExists(previousInteractionId, signal);
      if (exists === false) {
        return new ApiAgentError(
          `context expired: the upstream interaction can no longer be continued (${res.status}: ${upstream}); the session was reset, send the message again`,
          'context_expired',
        );
      }
    }
    return new ApiAgentError(`the Antigravity API returned ${res.status}: ${upstream}`, 'upstream');
  }

  /** `true` when the interaction exists, `false` only when the API says it is gone. */
  private async interactionExists(id: string, signal: AbortSignal): Promise<boolean | undefined> {
    try {
      const res = await this.call('GET', `/interactions/${encodeURIComponent(id)}`, undefined, signal);
      await res.text().catch(() => '');
      if (res.ok) return true;
      if (res.status === 404) return false;
      return undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Translate one SSE frame into what the ACP server should render.
 *
 * Kept as a class with its own state because tool calls are split across frames: the call step
 * carries the id, the result step carries `call_id` (the same value in the recording) and the
 * output. `completed` is how the caller tells "the interaction finished" from "the stream just
 * stopped"; a stream that ends without it is a failure, not an empty answer.
 */
export class AntigravityEventMapper {
  completed = false;
  /**
   * Set instead of thrown, so the events produced by the same frame (the final usage) reach the
   * caller before the turn fails. `turn()` checks it after yielding each frame's events.
   */
  failure?: ApiAgentError;
  private readonly toolIds = new Map<number, string>();
  /** All text emitted so far, for rebuilding a tail after the stream was lost. */
  private text = '';

  constructor(private readonly maxTokens: number) {}

  push(frame: SseFrame): BackendEvent[] {
    if (frame.data.trim() === '[DONE]') return [];
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      // One malformed frame must not kill a turn that is otherwise streaming; the rest of the
      // answer still arrives, and the missing piece is a line in no log rather than a lost turn.
      return [];
    }
    const type = typeof payload.event_type === 'string' ? payload.event_type : frame.event;
    switch (type) {
      case 'interaction.completed':
        return this.finished(payload);
      case 'step.start':
        return this.stepStarted(payload);
      case 'step.delta':
        return this.stepDelta(payload);
      case 'step.stop':
        return this.stepStopped(payload);
      case 'error': {
        const error = payload.error as { message?: string; code?: string } | undefined;
        const detail = error?.message ?? 'no detail';
        this.failure = new ApiAgentError(`the Antigravity agent reported an error: ${detail}`, 'upstream');
        return [];
      }
      default:
        return [];
    }
  }

  /**
   * Rebuild the end of an interaction that finished while its stream was down.
   *
   * The final `model_output` steps are the whole answer; whatever was already streamed is a
   * prefix of it, so only the missing suffix is emitted. A mismatch (which would mean the two
   * disagree about the answer) emits no text rather than a duplicate, and the turn still ends
   * with the terminal state instead of failing.
   */
  recover(interaction: Record<string, unknown>): BackendEvent[] {
    const events: BackendEvent[] = [];
    const full = textOfInteraction(interaction);
    if (full.startsWith(this.text)) {
      const suffix = full.slice(this.text.length);
      if (suffix) {
        this.text += suffix;
        events.push({ type: 'text', text: suffix });
      }
    }
    events.push(...this.finished({ interaction }));
    return events;
  }

  private stepStarted(payload: Record<string, unknown>): BackendEvent[] {
    const step = payload.step as Record<string, unknown> | undefined;
    if (!step) return [];
    const index = typeof payload.index === 'number' ? payload.index : 0;
    if (step.type === 'code_execution_call') {
      const id = typeof step.id === 'string' ? step.id : `code-${index}`;
      this.toolIds.set(index, id);
      const args = step.arguments as { language?: unknown; code?: unknown } | undefined;
      const language = typeof args?.language === 'string' ? args.language : undefined;
      return [
        {
          type: 'tool_start',
          id,
          title: language ? `Running ${language} code` : 'Running code',
          rawInput: args,
        },
      ];
    }
    if (step.type === 'code_execution_result') {
      const id = typeof step.call_id === 'string' ? step.call_id : this.toolIds.get(index) ?? `code-${index}`;
      return [
        {
          type: 'tool_end',
          id,
          status: step.is_error === true ? 'failed' : 'completed',
          output: typeof step.result === 'string' ? step.result : undefined,
        },
      ];
    }
    // `model_output` and `thought` are markers for the deltas that follow, not content.
    return [];
  }

  private stepDelta(payload: Record<string, unknown>): BackendEvent[] {
    const delta = payload.delta as Record<string, unknown> | undefined;
    if (!delta) return [];
    if (delta.type === 'text' && typeof delta.text === 'string' && delta.text.length > 0) {
      this.text += delta.text;
      return [{ type: 'text', text: delta.text }];
    }
    if (delta.type === 'thought_summary') {
      const content = delta.content as { text?: unknown } | undefined;
      if (typeof content?.text === 'string' && content.text.length > 0) {
        return [{ type: 'thought', text: content.text }];
      }
      return [];
    }
    // `thought_signature` is opaque and 172–1016 chars per recorded turn. Anything else is an
    // event shape not seen yet; dropping it is the only safe rendering.
    return [];
  }

  private stepStopped(payload: Record<string, unknown>): BackendEvent[] {
    const usage = payload.usage as { total_tokens?: unknown } | undefined;
    if (typeof usage?.total_tokens !== 'number') return [];
    return [{ type: 'usage', used: usage.total_tokens, size: CONTEXT_WINDOW }];
  }

  private finished(payload: Record<string, unknown>): BackendEvent[] {
    const interaction = payload.interaction as Record<string, unknown> | undefined;
    const status = typeof interaction?.status === 'string' ? interaction.status : 'completed';
    const events: BackendEvent[] = [];
    const usage = interaction?.usage as { total_tokens?: unknown } | undefined;
    if (typeof usage?.total_tokens === 'number') {
      events.push({ type: 'usage', used: usage.total_tokens, size: CONTEXT_WINDOW });
    }
    if (status === 'incomplete') {
      // Documented (`antigravity-agent.md` §Budget controls, 2026-11-13) but never reproduced in
      // the probe — the cap was not reached. The branch follows the document; the usage above is
      // returned first so the footer still shows what the turn spent.
      this.failure = new ApiAgentError(
        `hit this turn's ${this.maxTokens}-token cap (status "incomplete"); the answer above is all there is — raise --max-tokens or ask for less at once`,
        'token_limit',
      );
    } else if (status !== 'completed') {
      this.failure = new ApiAgentError(`the Antigravity interaction ended as "${status}"`, 'upstream');
    } else {
      this.completed = true;
      events.push({ type: 'done' });
    }
    return events;
  }
}

/**
 * The answer out of a finished interaction: every `model_output` step's text, in order. This is
 * the only place `steps[]` is read — the streaming path uses the deltas — and it exists for the
 * stream that was lost after the answer was ready.
 */
function textOfInteraction(interaction: Record<string, unknown>): string {
  const steps = interaction.steps;
  if (!Array.isArray(steps)) return '';
  let text = '';
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const record = step as Record<string, unknown>;
    if (record.type !== 'model_output' || !Array.isArray(record.content)) continue;
    for (const part of record.content) {
      if (!part || typeof part !== 'object') continue;
      const block = part as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    }
  }
  return text;
}

/**
 * The request's `input`. A text-only turn is a bare string, which is what the probe sent and what
 * the API's simplest form accepts; images make it a content array.
 *
 * Image parts are `{type:'image', data, mime_type}` — `data` is base64 and the mime field is
 * snake_case, unlike ACP's `mimeType` (create-interaction.md, 2026-11-13). Text comes first: that
 * is the order the API's own example shows, and the gateway's text names each attachment by path.
 */
export function inputOf(text: string, images: readonly PromptImage[]): unknown {
  if (images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((image) => ({ type: 'image', data: image.data, mime_type: image.mimeType })),
  ];
}

/** Pull `error.message` out of the API's error envelope, falling back to the raw body. */
function upstreamMessage(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch {
    // Not JSON; the body itself is the best description available.
  }
  return text.trim().slice(0, 300);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Abortable delay, so a cancel during the reconnect backoff ends the turn at once. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
