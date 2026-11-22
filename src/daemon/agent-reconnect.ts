/**
 * An agent whose connection is the agent going away mid-turn or refusing a dial: how long it is tried
 * again, and whether its turn can be picked up. Never by sending the input again on the gateway's
 * own initiative — the rules, and why, are in README.md "An agent that goes away mid-turn".
 */
import type { Locale } from '../core/i18n/index.js';
import { tRuntime } from '../core/i18n/runtime.js';
import { TurnFailure } from './agent.js';

/** How long a lost connection is tried again before the turn fails: a container restart, with room. */
export const RECONNECT_WINDOW_MS = 120_000;

/** Waits between tries: quick for a blip, then every 15s until the window closes. */
const DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** How long an outage lasts before the chat is told about it (the remote link's LINK_NOTICE_AFTER_MS). */
const NOTICE_AFTER_MS = 10_000;

/** What an agent declared about picking a turn back up (`agentCapabilities._meta.fleetherd`). */
export interface ResumeSupport {
  reconnect: boolean;
  promptId: boolean;
}

export const NO_RESUME: ResumeSupport = { reconnect: false, promptId: false };

export function readResumeSupport(capabilities: unknown): ResumeSupport {
  const meta = capabilities && typeof capabilities === 'object' ? (capabilities as { _meta?: unknown })._meta : undefined;
  const fleetherd = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)['fleetherd'] : undefined;
  if (!fleetherd || typeof fleetherd !== 'object') return NO_RESUME;
  const f = fleetherd as Record<string, unknown>;
  return { reconnect: f['reconnectTurn'] === true, promptId: f['promptId'] === true };
}

/**
 * Whether a turn whose connection went away can be picked up. Without `promptId` the agent cannot say
 * whether it took the prompt, and until reply text came a queued turn looks like a running one: a
 * reconnect to it would pick up the previous reply.
 */
export function canPickUp(support: ResumeSupport, sawText: boolean): boolean {
  return support.promptId || (support.reconnect && sawText);
}

/**
 * The agent could not be reached: a dial that failed, or a connection that closed before the agent
 * answered. Told apart from an answer the agent gave (a bad token, a missing setting), which is not
 * worth dialling again for. The message is the startup failure's, unchanged.
 */
export class AgentUnreachable extends TurnFailure {
  constructor(message: string) {
    super(message, 'startup');
    this.name = 'AgentUnreachable';
  }
}

/**
 * Whether an error is the agent's own JSON-RPC answer (the SDK's RequestError carries a numeric
 * `code`). A closed connection rejects with a plain Error: the process going away without a word.
 */
export function isAgentAnswer(err: unknown): boolean {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'number';
}

export type OutageKind = 'start' | 'turn';

/** The window and the waits, injectable so a test need not wait two minutes. */
export interface RedialTiming {
  windowMs?: number;
  delaysMs?: readonly number[];
}

/**
 * One turn's tries at getting a lost connection back: the waits between them, the window they fit
 * in, and the one notice the chat gets about it — only past NOTICE_AFTER_MS, so a blip says nothing,
 * and with a second line once it is back. A window opens with the first wait after the connection
 * was last up, so a turn that loses it twice gets two.
 */
export class Redialer {
  private since: number | undefined;
  private tries = 0;
  private told = false;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly windowMs: number;
  private readonly delaysMs: readonly number[];
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly locale: Locale;

  constructor(
    private readonly opts: {
      agent: string;
      notice?: (text: string) => void;
      windowMs?: number;
      delaysMs?: readonly number[];
      now?: () => number;
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
      locale?: Locale;
    }
  ) {
    this.windowMs = opts.windowMs ?? RECONNECT_WINDOW_MS;
    this.delaysMs = opts.delaysMs?.length ? opts.delaysMs : DELAYS_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
    this.locale = opts.locale ?? 'en';
  }

  /** Wait before the next try. False once the window is over or `signal` aborted (a `/stop`). */
  async next(signal: AbortSignal, kind: OutageKind): Promise<boolean> {
    if (signal.aborted) return false;
    const now = this.now();
    if (this.since === undefined) {
      this.since = now;
      this.armNotice(kind);
    }
    const left = this.since + this.windowMs - now;
    if (left <= 0) {
      this.stopNotice();
      return false;
    }
    const delay = Math.min(this.delaysMs[Math.min(this.tries, this.delaysMs.length - 1)]!, left);
    this.tries++;
    try {
      await this.sleep(delay, signal);
    } catch {
      return false;
    }
    return !signal.aborted;
  }

  /** How long the current outage has lasted, for the log and the failure. */
  elapsedMs(): number {
    return this.since === undefined ? 0 : this.now() - this.since;
  }

  /** The connection is up again: say so if the chat was told it was gone, and start afresh. */
  back(): void {
    if (this.told) this.opts.notice?.(tRuntime(this.locale, 'noticeReconnected', { target: this.opts.agent }));
    this.clear();
  }

  /** Forget the outage; the turn is over, or the connection back. */
  clear(): void {
    this.stopNotice();
    this.since = undefined;
    this.tries = 0;
    this.told = false;
  }

  private stopNotice(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
  }

  private armNotice(kind: OutageKind): void {
    if (!this.opts.notice) return;
    const minutes = Math.round(this.windowMs / 60_000);
    const span =
      minutes >= 1
        ? minutes === 1
          ? tRuntime(this.locale, 'spanMinutesSingle')
          : tRuntime(this.locale, 'spanMinutesMultiple', { count: minutes })
        : tRuntime(this.locale, 'spanSeconds', { count: Math.round(this.windowMs / 1000) });
    const text =
      kind === 'turn'
        ? tRuntime(this.locale, 'noticeLostConnectionTurn', { agent: this.opts.agent, span })
        : tRuntime(this.locale, 'noticeCannotReachStart', { agent: this.opts.agent, span });
    this.noticeTimer = setTimeout(() => {
      this.told = true;
      this.opts.notice?.(text);
    }, NOTICE_AFTER_MS);
    this.noticeTimer.unref?.();
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
