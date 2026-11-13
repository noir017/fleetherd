import type { ActiveSession, ClientContext, ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentDef } from '../config/schema.js';
import type { TurnState } from './agent-acp.js';

/**
 * A side question (`/btw`) over ACP: ask a copy of the session, then throw the copy away.
 *
 * ── Why a fork in the same child ─────────────────────────────────────────────────────────────────
 * `session/fork` copies a session's history into a new session id. A prompt on that id sees
 * everything the conversation holds, and what it answers is written to the copy alone — which is
 * the whole of what `/btw` promises: an answer from the conversation that does not become part of
 * it, and no turn stopped to get it. Starting a second child instead would isolate it further and
 * cost a cold start each time (about 4.5 CPU-seconds and 500 MB for cbc, see START_CONCURRENCY in
 * agent-acp.ts). A second session in the child already running costs what that harness charges for
 * a session: codex and opencode hold it in-process, while claude-agent-acp runs every session as a
 * Claude Code process of its own (the Agent SDK's ProcessTransport), so there the copy starts one,
 * and the delete ends it.
 *
 * ── What the harnesses actually do (probed 2026-11-13, project-scripts/fleetherd-btw/) ───────────
 * Each was asked a question about the conversation from a fork taken while a turn was running a
 * shell command, and the conversation's next turn was then asked to list every message it had been
 * sent. All three answered from the fork, and none listed the side question.
 *
 *   claude-agent-acp 0.81.0  The fork is made on disk (the Agent SDK's forkSession) and NOT loaded:
 *                            a prompt straight after it fails with "Session not found". It answers
 *                            once `session/resume` has loaded it — which is why resume is sent
 *                            whenever the agent declares it. `session/delete` removes the file.
 *   codex-acp 2.5.0          The fork is live at once; resume is accepted and changes nothing.
 *   opencode 2.2.5           Answers, but the copy carries on with the TURN IN PROGRESS as well: it
 *                            re-ran the running turn's shell command and answered both. Twice, at 1.5 s
 *                            and at 8 s into the turn. See FORK_CARRIES_ON_RUNNING_TURN.
 *
 * `session/fork` is still marked UNSTABLE in ACP 0.29.0's schema, which is one more reason the
 * capability is read off `initialize` every time rather than assumed from the harness's name.
 */

/** What an agent's `initialize` says about the session methods a side question uses. */
export interface ForkSupport {
  fork: boolean;
  /** Needed to load a fork the agent made but did not open (claude-agent-acp, see above). */
  resume: boolean;
  /** Removes the copy from the agent's own store; preferred. */
  delete: boolean;
  /** Frees the copy in the child; the fallback when there is no delete. */
  close: boolean;
}

export const NO_FORK: ForkSupport = { fork: false, resume: false, delete: false, close: false };

/** Read ForkSupport off an `initialize` response. A capability is declared by being present (`{}`). */
export function forkSupportOf(init: { agentCapabilities?: { sessionCapabilities?: object | null } | null }): ForkSupport {
  const caps = (init.agentCapabilities?.sessionCapabilities ?? {}) as Record<string, unknown>;
  const has = (key: string): boolean => caps[key] !== undefined && caps[key] !== null;
  return { fork: has('fork'), resume: has('resume'), delete: has('delete'), close: has('close') };
}

/**
 * Harnesses whose fork, taken while a turn runs, carries on with that turn: the copy holds the
 * unanswered message and the model answers it too — running its commands a second time. A side
 * question there waits for the turn to end rather than risk that; between turns there is nothing in
 * flight to copy. Measured, not guessed (see the header): opencode 2.2.5 did it both times, claude
 * and codex never.
 */
export const FORK_CARRIES_ON_RUNNING_TURN: ReadonlySet<AgentDef['harness']> = new Set(['opencode']);

/**
 * Why a side question cannot be asked of a live child, in words for the user — or undefined when it
 * can. Asked once the child is up, since both answers come from its `initialize`.
 */
export function sideQuestionRefusal(
  agentId: string,
  harness: AgentDef['harness'],
  support: ForkSupport,
  turnRunning: boolean
): string | undefined {
  if (!support.fork) return `${agentId} does not support /btw: its agent declares no session/fork, which a side question is asked on.`;
  if (turnRunning && FORK_CARRIES_ON_RUNNING_TURN.has(harness)) {
    return `${agentId} cannot take /btw while a turn runs: on ${harness}, a fork taken mid-turn carries on with that turn too and repeats its commands. Ask again when this turn ends.`;
  }
  return undefined;
}

/** One side question in flight, as the runtime that started it keeps track of it. */
export interface SideAskHandle {
  /** Where its permission requests and questions go (the same lane as its answer). */
  state: TurnState;
  /** `session/cancel` on the copy; the answer then ends as stopped. */
  cancel(): void;
}

export interface SideAsk {
  /** The child's connection: the copy lives in the same process as the conversation's session. */
  ctx: ClientContext;
  /** The conversation's own session, the one copied. */
  parentId: string;
  cwd: string;
  support: ForkSupport;
  prompt: ContentBlock[];
  /** What the copy's updates are rendered through. */
  state: TurnState;
  translate(u: SessionUpdate, st: TurnState): void;
  /** The longest the copy may stay silent before it is given up on; 0 for no limit. */
  silenceMs: number;
  /** Prefix for log lines (the conversation id). */
  label: string;
  /** Told the copy's id once it can be cancelled, and again (undefined) when it is gone. */
  track(forkId: string, handle: SideAskHandle | undefined): void;
}

/**
 * Fork, ask, read the answer to its end, and delete the fork — whatever happened in between.
 *
 * Resolves `stopped` when the copy was cancelled (`/stop`), `done` otherwise; rejects when the fork
 * could not be made or asked, or went silent for `silenceMs`.
 *
 * The copy gets no MCP servers. The gateway's native tools act on the conversation — post a file,
 * schedule a prompt — and an aside is an answer, not work done in the chat; anything the harness
 * itself configured (its own MCP servers, its built-in tools) it still has.
 */
export async function askOnFork(a: SideAsk): Promise<'done' | 'stopped'> {
  const forked = await a.ctx.request('session/fork', { sessionId: a.parentId, cwd: a.cwd, mcpServers: [] });
  const forkId = forked.sessionId;
  console.log(`[acp] ${a.label}: side question on a fork of ${a.parentId} (${forkId})`);
  let side: ActiveSession | undefined;
  try {
    if (a.support.resume) await a.ctx.request('session/resume', { sessionId: forkId, cwd: a.cwd, mcpServers: [] });
    // Attached after resume, so nothing it might replay can reach the answer. attachSession is
    // TS-private on ClientContext but stable at runtime, as agent-acp.ts already relies on for load.
    side = (a.ctx as unknown as { attachSession(r: { sessionId: string }): ActiveSession }).attachSession(forked);
    let stopped = false;
    a.track(forkId, {
      state: a.state,
      cancel: () => {
        stopped = true;
        void a.ctx.notify('session/cancel', { sessionId: forkId });
      },
    });
    const prompt = side.prompt(a.prompt);
    // Its failure also rejects the queue read below, which is where it is reported.
    void prompt.catch(() => {});
    await readToStop(side, a, () => stopped);
    return stopped ? 'stopped' : 'done';
  } finally {
    a.track(forkId, undefined);
    side?.dispose();
    await discard(a, forkId);
  }
}

/** Render the copy's updates until its prompt settles, giving up after `silenceMs` of nothing. */
async function readToStop(side: ActiveSession, a: SideAsk, stopped: () => boolean): Promise<void> {
  for (;;) {
    const msg = await withSilence(side.nextUpdate(), a.silenceMs, () => {
      a.ctx.notify('session/cancel', { sessionId: side.sessionId }).catch(() => {});
      return new Error(`the agent sent nothing for ${a.silenceMs}ms; the side question was given up`);
    });
    if (msg.kind === 'stop') return;
    if (stopped()) continue; // a cancelled copy's tail is not part of the answer
    try {
      a.translate(msg.update, a.state);
    } catch (e) {
      console.error(`[acp] ${a.label}: failed to render a side question's ${msg.update.sessionUpdate}:`, e instanceof Error ? e.message : e);
    }
  }
}

function withSilence<T>(read: Promise<T>, ms: number, onSilence: () => Error): Promise<T> {
  if (ms <= 0) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onSilence()), ms);
  });
  return Promise.race([read, silent]).finally(() => clearTimeout(timer));
}

/**
 * Remove the copy: deleted where the agent can delete, closed where it can only close. Neither is
 * worth failing the answer over, so a refusal is logged — and so is an agent that offers neither,
 * whose copy then stays in its own session list.
 */
async function discard(a: SideAsk, forkId: string): Promise<void> {
  const method = a.support.delete ? 'session/delete' : a.support.close ? 'session/close' : undefined;
  if (!method) {
    console.log(`[acp] ${a.label}: the agent offers neither session/delete nor session/close; fork ${forkId} is left in its store`);
    return;
  }
  try {
    await a.ctx.request(method, { sessionId: forkId });
  } catch (e) {
    console.warn(`[acp] ${a.label}: ${method} for fork ${forkId} failed:`, e instanceof Error ? e.message : e);
  }
}
