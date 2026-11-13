/**
 * The seam between the ACP server and an HTTP API.
 *
 * `server.ts` is protocol work — ACP frames in, `session/update` notifications out — and knows
 * nothing about any vendor. A backend is one HTTP API wrapped as a turn: it is handed the user's
 * message and the session's server-side ids, and it yields what happened in the order it happened.
 * Everything vendor-specific (the request body, the event vocabulary, how cancellation is spelled)
 * stays on the backend's side of this interface.
 *
 * Backends: Antigravity (`antigravity.ts`) and the agent-mailbox relay (`mailbox.ts`). Adding
 * another one is a new file plus one arm in `commands/api-agent.ts`; no daemon change, because
 * the daemon only ever sees ACP.
 */

/** One model the backend can be asked for, as ACP's `configOptions` wants it. */
export interface ModelOption {
  /** The value the backend's own API expects, e.g. `gemini-4-hydrogen`. */
  value: string;
  /** What the `/model` menu shows. */
  name: string;
}

/** An image the user attached, base64 as ACP delivered it. */
export interface PromptImage {
  data: string;
  mimeType: string;
}

/**
 * What one backend turn produced.
 *
 * A turn is a generator of these rather than a callback bag so ordering is the language's: the
 * server renders them as they arrive and needs no queue of its own. `state` carries server-side
 * ids the next turn must send back; it is emitted as soon as they are known, before any text,
 * because a process killed mid-turn should still leave the ids on disk.
 */
export type BackendEvent =
  /** A piece of the answer, already in the user's language. */
  | { type: 'text'; text: string }
  /** The model's reasoning summary. The gateway keeps thoughts out of the reply body. */
  | { type: 'thought'; text: string }
  /**
   * A tool the backend's own sandbox ran, announced before its result. `kind` is ACP's tool kind;
   * it defaults to `execute`, what a sandbox's code execution is.
   */
  | { type: 'tool_start'; id: string; title: string; rawInput?: unknown; kind?: 'execute' | 'other' }
  /** The result of that tool. `failed` draws the row's ✗ rather than its ✓. */
  | { type: 'tool_end'; id: string; status: 'completed' | 'failed'; output?: string }
  /** Tokens in context after a step, for the footer's `18k / 1M (2%)`. */
  | { type: 'usage'; used: number; size: number }
  /** Server-side ids this turn established, for the next `session/prompt`. */
  | { type: 'state'; lastInteractionId?: string; environmentId?: string }
  /** The turn finished normally. */
  | { type: 'done' }
  /**
   * Output sent outside a turn (`ApiBackend.follow`) is complete for now. The gateway holds such
   * output until it can tell a burst ended, so a backend says so instead of leaving it to wait.
   */
  | { type: 'settled' };

/** Everything a backend needs to run one turn. */
export interface TurnRequest {
  /** The ACP session id; backends use it only to scope their own bookkeeping. */
  sessionId: string;
  /** The user's message: the text blocks of the ACP prompt, joined. */
  text: string;
  /** Images from the prompt, in the order the client sent them. */
  images: PromptImage[];
  /** The model the session's `/model` menu selected. */
  model: string;
  /** The interaction to continue, when the session has one and it is still usable. */
  previousInteractionId?: string;
  /** The sandbox/environment to continue in. */
  environmentId?: string;
  /** Aborted by `session/cancel` or by the ACP connection going away. */
  signal: AbortSignal;
}

export interface ApiBackend {
  /** Backend name as `fleetherd api-agent <name>` spells it. */
  readonly id: string;
  /** Model a fresh session starts on. */
  readonly defaultModel: string;
  /** The models this backend offers, after `--models` narrowed them. Empty: no model menu. */
  readonly models: readonly ModelOption[];
  /** Whether pictures may be sent as prompt blocks (`promptCapabilities.image`). Default true. */
  readonly images?: boolean;
  /** Run one turn. The generator ends after yielding `done`, or throws. */
  turn(request: TurnRequest): AsyncGenerator<BackendEvent>;
  /**
   * Best-effort server-side cancellation. Called after the local turn has already been stopped,
   * so a failure is logged and never fails the turn — the user asked to stop, and it is stopped.
   */
  cancel(interactionId: string | undefined, sessionId: string): Promise<void>;
  /**
   * Optional: deliver what the service sends for this session between turns. The server calls it
   * after each turn of the session ends (the backend keeps one follower per session); `emit`
   * sends an event as a `session/update` with no prompt in flight, which the gateway shows as a
   * follow-up message. Not called before a session's first turn in this process: the gateway
   * drops output from a child it has not prompted yet (daemon/README.md, "Replayed history is not
   * output"), so such output must wait for the next turn instead.
   */
  follow?(sessionId: string, emit: (event: BackendEvent) => Promise<void>): void;
  /** Optional: stop timers and followers; the connection is gone. */
  close?(): void;
}

/**
 * A failure written for the person in the chat.
 *
 * The daemon turns a rejected `session/prompt` into `❌ This turn failed: <message>`, so `message`
 * is the whole of what the user reads: it must say what happened and what to do, in one line.
 * `kind` is for the server's own decisions — a context that expired is also a state that must be
 * reset before the next turn.
 */
export class ApiAgentError extends Error {
  constructor(
    message: string,
    readonly kind: 'context_expired' | 'token_limit' | 'rate_limit' | 'auth' | 'upstream' | 'network',
  ) {
    super(message);
    this.name = 'ApiAgentError';
  }
}
