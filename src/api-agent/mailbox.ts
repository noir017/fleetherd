/**
 * The agent-mailbox backend: a turn is a message left in a relay for an agent that polls.
 *
 * Built for Meta's Muse, which runs in a cloud VM nobody can call: a hook there polls the relay
 * every few seconds and wakes Muse, and Muse posts its replies back to the relay. Nothing here is
 * Muse-specific — any agent that speaks the relay's agent side works (protocol: mailbox-relay.ts;
 * the agent's rules: agent-mailbox/integrations/muse/hooks/agent-mailbox.json).
 *
 *   fleetherd ──ACP──► api-agent mailbox ──HTTPS──► relay ◄──poll / reply── agent
 *
 * A turn: deliver one `message`, then follow that turn's replies until a `final`.
 * - `progress` is a status line. It is drawn as a tool row (`progress: "…"`, ✓ when the next one
 *   arrives), not a thought: the gateway never shows `agent_thought_chunk` (agent-acp.ts
 *   translateUpdate), so progress as a thought would be invisible, which defeats sending it.
 * - `message` and `final` text is the reply body; `final` ends the turn.
 * - Nobody fetches the message within `pickupTimeoutMs`: the message is withdrawn and the turn
 *   fails, saying when the agent last polled (the relay knows).
 * - No reply for `silenceTimeoutMs` after pickup: the turn ends with what arrived and a note that
 *   no completion mark came. This must stay under the gateway's `session.turnTimeoutMs` (10 min),
 *   or the gateway would kill the child first and the user would get a timeout instead.
 *
 * Between turns (the agent answers late, or messages on its own), replies are delivered through
 * `follow` as a follow-up message, while this process lives. When it does not — reclaimed idle,
 * or the gateway restarted — they wait in the relay and are shown at the start of the session's
 * next turn, before the new message goes out.
 */
import { randomBytes } from 'node:crypto';
import { ApiAgentError, type ApiBackend, type BackendEvent, type TurnRequest } from './backend.js';
import { RelayClient, RelayError, type AgentStatus, type RelayReply } from './mailbox-relay.js';

/** How long a delivered message may wait to be picked up. */
export const PICKUP_TIMEOUT_MS = 120_000;
/** How long a picked-up turn may go without any reply. Below session.turnTimeoutMs (600 s). */
export const SILENCE_TIMEOUT_MS = 300_000;
/** Reply polling during a turn. The agent polls every 5 s, so faster buys nothing. */
const TURN_POLL_MS = 2_000;
/** Reply polling between turns. Each poll is a request against the relay's daily quota. */
const IDLE_POLL_MS = 20_000;
/** First between-turn poll after a turn ends: soon, but after the prompt response is out. */
const FOLLOW_START_MS = 1_000;
/** Attempts at delivering the message when the relay is unreachable or failing. */
const SEND_ATTEMPTS = 3;

/**
 * Where the gateway's prompt puts attachments: after the user's text, under this line
 * (daemon/turn-runner.ts buildPrompt). Readable files are inlined there and others named by
 * path — a path on this machine, which the agent in its cloud VM cannot open. Hyrum's Law: the
 * separator is the daemon's internal format; mailbox.test.ts pins it.
 */
export const ATTACHMENTS_MARKER = '\n\n---\nAttachments:\n';

export interface MailboxBackendOptions {
  /** Relay base URL. */
  url: string;
  /** The mailbox's client token; empty fails each turn with a sentence saying so. */
  token: string;
  pickupTimeoutMs?: number;
  silenceTimeoutMs?: number;
  turnPollMs?: number;
  idlePollMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  newTurnId?: () => string;
  log?: (line: string) => void;
}

interface SessionState {
  /** The relay's reply cursor for this session; undefined until the first read. */
  cursor?: number;
  /** Replies read during a turn that belong to no running turn, shown after it. */
  queue: RelayReply[];
  /** A turn is running or about to: the follower must not emit. */
  inTurn: boolean;
  /** The follower's poll in progress, which a starting turn waits out. */
  polling?: Promise<void>;
  emit?: (event: BackendEvent) => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

export function createMailboxBackend(options: MailboxBackendOptions): ApiBackend {
  return new MailboxBackend(options);
}

class MailboxBackend implements ApiBackend {
  readonly id = 'mailbox';
  readonly defaultModel = '';
  readonly models = [];
  /** Text only: the relay carries text, and the agent could not open a file from here anyway. */
  readonly images = false;

  private readonly relay: RelayClient;
  private readonly sessions = new Map<string, SessionState>();
  private readonly pickupTimeoutMs: number;
  private readonly silenceTimeoutMs: number;
  private readonly turnPollMs: number;
  private readonly idlePollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly newTurnId: () => string;
  private readonly log: (line: string) => void;
  private closed = false;

  constructor(private readonly options: MailboxBackendOptions) {
    this.relay = new RelayClient({ url: options.url, token: options.token, fetch: options.fetch });
    this.pickupTimeoutMs = options.pickupTimeoutMs ?? PICKUP_TIMEOUT_MS;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
    this.turnPollMs = options.turnPollMs ?? TURN_POLL_MS;
    this.idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleepFor;
    this.newTurnId = options.newTurnId ?? (() => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
    this.log = options.log ?? ((line) => console.error(line));
  }

  private session(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) this.sessions.set(sessionId, (s = { queue: [], inTurn: false }));
    return s;
  }

  async *turn(request: TurnRequest): AsyncGenerator<BackendEvent> {
    if (!this.options.token) {
      throw new ApiAgentError('MAILBOX_TOKEN is not set for this agent; add it to the agent\'s env in config.yaml', 'auth');
    }
    const s = this.session(request.sessionId);
    s.inTurn = true;
    try {
      await s.polling;
      const { text, attachments } = splitAttachments(request.text);
      const late = await this.collectLate(request.sessionId, s, request.signal);
      if (late.length > 0) yield { type: 'text', text: lateBlock(late) };
      if (attachments || request.images.length > 0) yield { type: 'text', text: attachmentNote(text.trim() !== '') };
      if (text.trim() === '') {
        yield { type: 'done' };
        return;
      }
      yield* this.runTurn(request, s, text);
    } finally {
      s.inTurn = false;
      if (s.emit) this.schedule(request.sessionId, s, FOLLOW_START_MS);
    }
  }

  /** Deliver the message and follow its turn to the end. */
  private async *runTurn(request: TurnRequest, s: SessionState, text: string): AsyncGenerator<BackendEvent> {
    const { sessionId, signal } = request;
    const turnId = this.newTurnId();
    // First, so /stop can name the turn (server.ts passes it to cancel()).
    yield { type: 'state', lastInteractionId: turnId };
    const sent = await this.deliver(sessionId, turnId, text, signal);
    const follow = new TurnFollower(turnId, sent.seq, this.now(), this.pickupTimeoutMs, this.silenceTimeoutMs);
    follow.saw(sent.agent, this.now());

    for (;;) {
      await this.sleep(this.turnPollMs, signal);
      let lastError: RelayError | undefined;
      try {
        const page = await this.relay.replies(sessionId, s.cursor, signal);
        s.cursor = page.cursor;
        for (const reply of page.replies) {
          if (reply.turn !== turnId) {
            if (reply.type !== 'progress') s.queue.push(reply);
            continue;
          }
          yield* follow.render(reply, this.now());
        }
        follow.saw(page.agent, this.now());
      } catch (err) {
        lastError = this.relayFailure(err, signal);
      }
      if (follow.finished) {
        await this.ack(sessionId, s, signal);
        yield { type: 'done' };
        return;
      }
      const now = this.now();
      if (follow.pickupExpired(now)) {
        if (lastError) throw new ApiAgentError(lastError.message, 'network');
        const withdrawn = await this.relay.cancel(sessionId, turnId, true, signal).catch((err: unknown) => {
          throw new ApiAgentError(this.relayFailure(err, signal).message, 'network');
        });
        if (withdrawn.withdrawn > 0) throw new ApiAgentError(this.notPickedUp(withdrawn.agent), 'upstream');
        follow.pickedUp(now); // it went in the moment we gave up on it
      }
      if (follow.silenceExpired(now)) {
        yield* follow.giveUp(this.silenceTimeoutMs, lastError);
        yield { type: 'done' };
        return;
      }
    }
  }

  /** POST the message, retrying what the network or a failing relay lost. */
  private async deliver(sessionId: string, turnId: string, text: string, signal: AbortSignal) {
    for (let attempt = 1; ; attempt++) {
      try {
        // Same turn id on every attempt: the relay files a repeat under the first copy.
        return await this.relay.send(sessionId, turnId, 'message', text, signal);
      } catch (err) {
        const failure = this.relayFailure(err, signal);
        if (!failure.transient || attempt >= SEND_ATTEMPTS) {
          throw new ApiAgentError(`the message was not delivered: ${failure.message}`, kindOf(failure));
        }
        await this.sleep(1_000 * attempt, signal);
      }
    }
  }

  /** A relay failure as a RelayError; an abort or a rejected token propagates instead. */
  private relayFailure(err: unknown, signal: AbortSignal): RelayError {
    if (signal.aborted) throw err;
    if (err instanceof RelayError) {
      if (err.status === 401 || err.status === 403) {
        throw new ApiAgentError(
          `the mailbox relay rejected MAILBOX_TOKEN (${err.status}); check this agent's client token`,
          'auth',
        );
      }
      this.log(`[api-agent] mailbox: ${err.message}`);
      return err;
    }
    throw err;
  }

  /** Confirm what was read, so a restart does not show it again. Anything newer joins the queue. */
  private async ack(sessionId: string, s: SessionState, signal: AbortSignal): Promise<void> {
    try {
      const page = await this.relay.replies(sessionId, s.cursor, signal);
      s.cursor = page.cursor;
      s.queue.push(...page.replies.filter((r) => r.type !== 'progress'));
    } catch (err) {
      if (signal.aborted) return;
      this.log(`[api-agent] mailbox: could not confirm replies: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Replies nobody has seen yet: queued in this process, or waiting in the relay. */
  private async collectLate(sessionId: string, s: SessionState, signal: AbortSignal): Promise<RelayReply[]> {
    const late = s.queue.splice(0);
    try {
      for (let pages = 0; pages < 10; pages++) {
        const page = await this.relay.replies(sessionId, s.cursor, signal);
        s.cursor = page.cursor;
        if (page.replies.length === 0) break;
        // Progress of a turn that is over says nothing now.
        late.push(...page.replies.filter((r) => r.type !== 'progress'));
      }
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof RelayError && (err.status === 401 || err.status === 403)) this.relayFailure(err, signal);
      // The new message matters more than old replies: deliver it anyway, show these next time.
      this.log(`[api-agent] mailbox: could not read earlier replies: ${err instanceof Error ? err.message : String(err)}`);
    }
    return late;
  }

  private notPickedUp(agent: AgentStatus): string {
    const wait = formatDuration(this.pickupTimeoutMs);
    const head = `nobody picked the message up from the mailbox in ${wait}`;
    const tail = 'it was withdrawn; send it again once the agent is polling';
    if (agent.last_poll_at === null) return `${head}, and the agent has never polled this mailbox — ${tail}`;
    const ago = formatDuration(Math.max(0, this.now() - agent.last_poll_at));
    return `${head}; the agent last polled ${ago} ago (${formatUtc(agent.last_poll_at)}) — ${tail}`;
  }

  async cancel(turnId: string | undefined, sessionId: string): Promise<void> {
    if (!turnId || !this.options.token) return;
    // A message still in the relay is withdrawn; one the agent has gets a `cancel` after it.
    const result = await this.relay.cancel(sessionId, turnId, false);
    this.log(`[api-agent] mailbox: /stop on ${turnId}: ${result.withdrawn > 0 ? 'withdrawn before pickup' : 'cancel sent'}`);
  }

  // ───────────────────────── between turns ─────────────────────────

  follow(sessionId: string, emit: (event: BackendEvent) => Promise<void>): void {
    if (this.closed) return;
    const s = this.session(sessionId);
    s.emit = emit;
    if (!s.inTurn && !s.timer) this.schedule(sessionId, s, FOLLOW_START_MS);
  }

  private schedule(sessionId: string, s: SessionState, delay: number): void {
    if (this.closed) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = undefined;
      s.polling = this.pollBetweenTurns(sessionId, s).finally(() => {
        s.polling = undefined;
        if (!s.inTurn) this.schedule(sessionId, s, this.idlePollMs);
      });
    }, delay);
    // A follower must never be what keeps the process alive.
    s.timer.unref?.();
  }

  private async pollBetweenTurns(sessionId: string, s: SessionState): Promise<void> {
    if (s.inTurn || !s.emit || this.closed || !this.options.token) return;
    let shown: RelayReply | undefined;
    let lost = false;
    /** Emit replies in order; false when a turn began or the connection is gone (nothing is lost then). */
    const show = async (replies: RelayReply[]): Promise<boolean> => {
      for (const [i, reply] of replies.entries()) {
        // A turn started meanwhile: it shows the rest first, as replies it had not seen.
        if (s.inTurn || !s.emit) {
          s.queue.unshift(...replies.slice(i));
          return false;
        }
        try {
          await s.emit({ type: 'text', text: shown ? joinText(shown.text, reply.text) : reply.text });
        } catch (err) {
          // The connection is gone; keep them for a next turn in this process, if there is one.
          this.log(`[api-agent] mailbox: could not show a between-turn reply: ${err instanceof Error ? err.message : String(err)}`);
          s.queue.unshift(...replies.slice(i));
          s.emit = undefined;
          lost = true;
          return false;
        }
        shown = reply;
      }
      return true;
    };
    try {
      if (!(await show(s.queue.splice(0)))) return;
      for (let pages = 0; pages < 10; pages++) {
        // Reading a page confirms the one before it, which is on screen by now: a reply is
        // deleted from the relay only after it was shown.
        const page = await this.relay.replies(sessionId, s.cursor);
        s.cursor = page.cursor;
        if (page.replies.length === 0) break;
        if (!(await show(page.replies.filter((r) => r.type !== 'progress')))) return;
      }
    } catch (err) {
      this.log(`[api-agent] mailbox: between-turn poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (shown && !lost && !s.inTurn && s.emit) await s.emit({ type: 'settled' }).catch(() => undefined);
    }
  }

  close(): void {
    this.closed = true;
    for (const s of this.sessions.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = undefined;
      s.emit = undefined;
    }
  }
}

/**
 * One turn's view of the relay: what to draw for each reply, and its two deadlines.
 */
class TurnFollower {
  finished = false;
  private picked = false;
  private silenceDeadline: number | undefined;
  private readonly pickupDeadline: number;
  private progressRow: string | undefined;
  private body = '';

  constructor(
    private readonly turnId: string,
    private readonly seq: number,
    now: number,
    pickupMs: number,
    private readonly silenceMs: number,
  ) {
    this.pickupDeadline = now + pickupMs;
  }

  /** The relay's view of the agent: picked up once it has been handed our seq. */
  saw(agent: AgentStatus, now: number): void {
    if (!this.picked && agent.fetched_upto >= this.seq) this.pickedUp(now);
  }

  pickedUp(now: number): void {
    if (this.picked) return;
    this.picked = true;
    this.silenceDeadline = now + this.silenceMs;
  }

  pickupExpired(now: number): boolean {
    return !this.picked && now >= this.pickupDeadline;
  }

  silenceExpired(now: number): boolean {
    return this.silenceDeadline !== undefined && now >= this.silenceDeadline;
  }

  *render(reply: RelayReply, now: number): Generator<BackendEvent> {
    this.pickedUp(now);
    this.silenceDeadline = now + this.silenceMs;
    if (reply.type === 'progress') {
      yield* this.closeRow('completed');
      this.progressRow = `progress-${this.turnId}-${reply.seq}`;
      // `prompt` is one of the input keys the gateway previews a tool row by (agent-common.ts
      // PREVIEW_KEYS), so the row reads `progress: "<text>"`.
      yield { type: 'tool_start', id: this.progressRow, title: 'progress', kind: 'other', rawInput: { prompt: reply.text } };
      return;
    }
    yield* this.closeRow('completed');
    yield { type: 'text', text: this.body === '' ? reply.text : joinText(this.body, reply.text) };
    this.body += reply.text;
    if (reply.type === 'final') this.finished = true;
  }

  /** Silence: close what is open and say why the turn ends here. */
  *giveUp(silenceMs: number, lastError: RelayError | undefined): Generator<BackendEvent> {
    yield* this.closeRow('failed');
    const why = lastError
      ? `the mailbox relay could not be read (${lastError.message})`
      : `no reply from the agent for ${formatDuration(silenceMs)}`;
    const note = `(No completion mark: ${why}, so this turn ends here. Anything the agent sends later arrives as a separate message.)`;
    yield { type: 'text', text: this.body === '' ? note : `\n\n${note}` };
  }

  private *closeRow(status: 'completed' | 'failed'): Generator<BackendEvent> {
    if (!this.progressRow) return;
    yield { type: 'tool_end', id: this.progressRow, status };
    this.progressRow = undefined;
  }
}

/**
 * The user's text, and whether the gateway appended attachments to it (daemon/turn-runner.ts
 * buildPrompt; each entry is a `[Attachment …]` line or an inlined `Attachment …:` block).
 */
export function splitAttachments(prompt: string): { text: string; attachments: boolean } {
  const at = prompt.lastIndexOf(ATTACHMENTS_MARKER);
  if (at < 0) return { text: prompt, attachments: false };
  return { text: prompt.slice(0, at), attachments: true };
}

function attachmentNote(hasText: boolean): string {
  return hasText
    ? '(Attachments cannot go through the mailbox; only the text was sent.)\n\n'
    : '(Attachments cannot go through the mailbox, and there was no text to send, so nothing was sent.)';
}

/** Replies that arrived while nothing was showing them, ahead of the new turn. */
function lateBlock(replies: RelayReply[]): string {
  let text = '';
  for (const reply of replies) text += text === '' ? reply.text : joinText(text, reply.text);
  return `⏱ Earlier replies not shown yet:\n\n${text}\n\n---\n\n`;
}

/**
 * Join two pieces of reply text. A long answer arrives cut at paragraph or line breaks (the
 * agent-side helper splits at 15,000 characters and keeps the break), so a piece that already
 * ends in a break needs no more; separate messages get a blank line between them.
 */
export function joinText(before: string, next: string): string {
  if (before.endsWith('\n\n')) return next;
  if (before.endsWith('\n')) return `\n${next}`;
  return `\n\n${next}`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function kindOf(err: RelayError): ApiAgentError['kind'] {
  if (err.status === 429) return 'rate_limit';
  return err.status === 0 || err.status >= 500 ? 'network' : 'upstream';
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
