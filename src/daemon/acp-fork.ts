import type { ActiveSession, ClientContext } from '@agentclientprotocol/sdk';
import type { McpServer, SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';
import type { ForkSupport } from './acp-side-question.js';

/**
 * `/fork` over ACP: a new topic whose session starts as a copy of another topic's, and is kept.
 *
 * `/btw` already copies a session (acp-side-question.ts), asks the copy once in the same child and
 * deletes it. A fork is the copy kept and handed to a conversation of its own — which has a child of
 * its own — so the question this file answers is where the copy is made, and how the other process
 * comes to hold it.
 *
 * ── What the harnesses do (probed 2026-11-20, project-scripts/fleetherd-fork/) ───────────────────
 * Process A made a session, was told a code word and forked it; a second process B of the same
 * harness then took the copy and was asked for the word; A's own session was then asked to list every
 * message it had received. Every run below kept the original untouched: A never listed B's questions.
 *
 *   claude-agent-acp 0.81.0  B loads A's fork (`session/load`), and B forking A's session itself
 *                            works too — once `session/resume` has loaded the copy, as for `/btw`.
 *   codex-acp 2.5.0          B CANNOT load A's fork while A is alive: "This Codex session is in use
 *                            by another Codex client" (`thread_active_writer`). `session/close` of
 *                            the fork in A is accepted and changes nothing, eight seconds later too;
 *                            only A's exit frees it. B forking A's session itself works while A still
 *                            holds that session, and the copy is then B's own.
 *   opencode 2.2.5           Both work, with or without `session/close` in A.
 *
 * So the copy is made by the NEW topic's child (`forkInto`, below): the one arrangement all three
 * take, and one that leaves the source's process alone — it may hold its session, mid-nothing, the
 * whole time. Every harness that declares resume is sent it on the copy, as `/btw` does: claude
 * needs it, and codex and opencode answer it and carry on (measured the same day).
 *
 * The source must be between turns (ConversationRegistry.forkConversation refuses otherwise). Taken
 * mid-turn, the copy holds a turn nobody will finish — and opencode's copy carries on with a running
 * turn, its commands included (`harness/opencode.ts` `forkCarriesOnRunningTurn`) — so a fork is a snapshot of an idle
 * conversation or nothing.
 *
 * `session/fork` is still UNSTABLE in ACP 0.29.0's schema, so whether an agent can is read off its
 * `initialize` (forkSupportOf), never assumed from the harness's name.
 */

/** Why this agent cannot be forked, in words for the user — or undefined when it can. */
export function forkRefusal(agentId: string, support: ForkSupport): string | undefined {
  if (support.fork) return undefined;
  return `${agentId} does not support /fork: its agent declares no session/fork, which a fork is made with.`;
}

/** The copy, as the child that made it now holds it. */
export interface ForkedSession {
  session: ActiveSession;
  /** What the copy reported about itself: the answer to resume where one was sent, else to fork. */
  configOptions: SessionConfigOption[] | undefined;
  modes: SessionModeState | undefined;
}

/**
 * Fork `sourceId` in this child and load the copy here, ready to be prompted.
 *
 * The copy is attached BEFORE resume, so whatever resume may replay lands in its queue, where the
 * caller's replay fence discards it — history must not re-render into the new topic, which shows
 * none of it on purpose. A resume that fails takes the attachment down with it.
 */
export async function forkInto(
  ctx: ClientContext,
  a: { sourceId: string; cwd: string; mcpServers: McpServer[]; support: ForkSupport; onStep(step: 'session/fork' | 'session/resume'): void }
): Promise<ForkedSession> {
  a.onStep('session/fork');
  const forked = await ctx.request('session/fork', { sessionId: a.sourceId, cwd: a.cwd, mcpServers: a.mcpServers });
  // attachSession is TS-private on ClientContext but stable at runtime, as agent-acp.ts already
  // relies on for session/load.
  const session = (ctx as unknown as { attachSession(r: { sessionId: string }): ActiveSession }).attachSession(forked);
  if (!a.support.resume) {
    return { session, configOptions: forked.configOptions ?? undefined, modes: forked.modes ?? undefined };
  }
  try {
    a.onStep('session/resume');
    const resumed = await ctx.request('session/resume', { sessionId: forked.sessionId, cwd: a.cwd, mcpServers: a.mcpServers });
    return {
      session,
      configOptions: resumed?.configOptions ?? forked.configOptions ?? undefined,
      modes: resumed?.modes ?? forked.modes ?? undefined,
    };
  } catch (e) {
    session.dispose();
    throw e;
  }
}
