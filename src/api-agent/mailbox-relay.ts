/**
 * The client side of an agent-mailbox relay, over fetch.
 *
 * The relay (a Cloudflare Worker, separate repository: agent-mailbox) is a store-and-forward
 * mailbox between this process and an agent that can only poll — Muse, in a cloud VM nobody can
 * call. Both ends are clients; this one sends messages and reads replies with the mailbox's
 * client token. The protocol, as this file uses it:
 *
 *   POST /client/send     {session, turn, type: "message"|"cancel", text} → {seq, turn, agent}
 *   GET  /client/replies?session=&after=  → {replies: [{seq, session, turn, type, text}], cursor, agent}
 *   POST /client/cancel   {session, turn, withdraw_only?} → {withdrawn, seq?, agent}
 *
 * `after` confirms every reply up to it; the relay then deletes them. `agent` says when the
 * agent last polled and how far it has fetched — the only way to tell "not picked up yet" from
 * "nobody is there".
 */

export interface AgentStatus {
  /** Epoch ms of the agent's last inbox poll, or null if it never polled. */
  last_poll_at: number | null;
  /** The highest inbox seq the agent has been handed. */
  fetched_upto: number;
}

export interface RelayReply {
  seq: number;
  session: string;
  /** The turn it belongs to; null for a message the agent sent on its own. */
  turn: string | null;
  type: 'progress' | 'final' | 'message';
  text: string;
}

export interface RepliesPage {
  replies: RelayReply[];
  cursor: number;
  agent: AgentStatus;
}

/**
 * A relay call that failed. `status` 0 is the network (or a non-JSON answer from something in
 * front of the relay); `transient` says whether trying again can help.
 */
export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RelayError';
  }

  get transient(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface RelayClientOptions {
  /** Base URL, e.g. https://mailbox.example.com (a path prefix is allowed). */
  url: string;
  /** The mailbox's client token. Sent as a Bearer header, never in a URL. */
  token: string;
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export class RelayClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: RelayClientOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** The relay's host, for messages: never the token, never a path. */
  get host(): string {
    try {
      return new URL(this.base).host;
    } catch {
      return this.base;
    }
  }

  send(session: string, turn: string, type: 'message' | 'cancel', text: string, signal?: AbortSignal) {
    return this.call<{ seq: number; turn: string; agent: AgentStatus }>(
      'POST',
      '/client/send',
      { session, turn, type, text },
      signal,
    );
  }

  replies(session: string, after: number | undefined, signal?: AbortSignal): Promise<RepliesPage> {
    const query = new URLSearchParams({ session });
    if (after !== undefined) query.set('after', String(after));
    return this.call<RepliesPage>('GET', `/client/replies?${query.toString()}`, undefined, signal);
  }

  cancel(session: string, turn: string, withdrawOnly: boolean, signal?: AbortSignal) {
    return this.call<{ withdrawn: number; seq?: number; agent: AgentStatus }>(
      'POST',
      '/client/cancel',
      { session, turn, withdraw_only: withdrawOnly },
      signal,
    );
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // The token rides in a header; a redirect would carry it somewhere the operator never named.
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new RelayError(`cannot reach the mailbox relay at ${this.host}: ${causeOf(err)}`, 0);
    }
    let parsed: { ok?: boolean; error?: string } & Record<string, unknown>;
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch {
      // Cloudflare answers its own errors (1027: daily request limit) with HTML.
      throw new RelayError(`the mailbox relay at ${this.host} answered ${res.status} with something that is not JSON`, res.ok ? 0 : res.status);
    }
    if (!res.ok || parsed.ok !== true) {
      throw new RelayError(`the mailbox relay answered ${res.status}: ${parsed.error ?? 'no reason given'}`, res.status || 0);
    }
    return parsed as T;
  }
}

function causeOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'TimeoutError') return 'timed out';
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error ? cause.message : err.message;
}
