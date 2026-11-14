import type { ContentBlock, InitializeResponse } from '@agentclientprotocol/sdk';
import type { SteerOutcome } from '../types.js';

/**
 * How an ACP harness takes a message into a turn that is already running (AgentSession.steer).
 *
 * ACP itself has no answer: one `session/prompt` is one turn, and the spec says nothing about a
 * second one arriving while the first is in flight. The harnesses here answer it three ways, all
 * probed on 2026-10-10 with the same script (project-scripts/talkcode-steer-probe/cc-probe.mjs in the
 * operator's workspace): a thirty-second foreground command, and a second message six seconds in.
 *
 * - `prompt` — send it as another `session/prompt`. claude-agent-acp advertises this as
 *   `agentCapabilities._meta.claudeCode.promptQueueing` and implements it by pushing the message onto
 *   the SDK's input stream (0.81 dist/acp-agent.js `prompt()`: `session.turnQueue.push(turn);
 *   session.input.push(userMessage)`). Claude Code queues it at its default priority, `next`, and
 *   absorbs it at the next tool boundary: the command ran its full thirty seconds, the transcript
 *   recorded a `queued_command` attachment and `queue-operation remove, reason: "absorbed_mid_turn"`,
 *   and the one reply answered both. The FIRST prompt then settles as soon as the absorbed message
 *   starts being answered, and the reply streams under the second — which is why a turn that took
 *   one in has to wait for the LAST prompt it sent, not its own (see runTurn in agent-acp.ts).
 *   This is the behaviour of Claude Code's own CLI when you type while it works.
 *
 * - `steer` — the `_session/steering` extension request, advertised as top-level
 *   `InitializeResponse._meta.steering.supported`. codex-acp 2.2.1 maps it onto app-server
 *   `turn/steer` (dist/index.js, the SteeringQueue): codex appends it to the turn's pending input and
 *   reads it before its next request to the model, so the command again finished, the reply covered
 *   both, and the turn's one `session/prompt` resolved once, at the end. Answers `{outcome}`:
 *   `injected`, or `startedNewTurn` when the turn had already ended inside codex — codex-acp then
 *   runs it as a turn of its own with no `session/prompt` behind it (it does not honour the
 *   `promptRequired` opt-out below), so its output reaches the gateway as background output.
 *
 * - `none` — everything else. opencode 2.0.26 rejects a second `session/prompt` with -32603
 *   "Session already has an active ACP prompt" and the message is gone, so it must never be tried.
 *
 * `agy acp` advertises nothing and behaves as `prompt`, so agent-acp.ts says so through
 * steeringModeOf's second argument (agy-acp.ts takesPromptMidTurn has the measurement).
 *
 * claude-agent-acp advertises `steering` too, and `prompt` is preferred on purpose: its steer is
 * delivered at priority `now`, which pre-empts. Probed with the same script, Claude Code moved the
 * running foreground command to the background to let the message through, answered it at once, and
 * ended the turn — the command's result then came back later as a background notification. That is
 * a different feature (an interjection, not a queue), and not what a user who typed "also check X"
 * while tests run is asking for.
 *
 * ⚠️ HYRUM'S LAW: `_meta.claudeCode.promptQueueing` is claude-agent-acp's private extension, not ACP,
 * and `_session/steering` an extension method. If a release drops the first marker, claude falls to
 * `steer` (works, with the interjection semantics above); if it drops both, to `none` — the queue
 * the gateway always had. Neither failure loses a message.
 */
export type SteeringMode = 'prompt' | 'steer' | 'none';

/** The extension request a `steer` harness takes a mid-turn message through. */
export const STEER_METHOD = '_session/steering';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Which mode this harness supports, from what it advertised in `initialize` (see SteeringMode).
 * `promptUnadvertised` is for a harness measured to take a second prompt that says nothing about it
 * (agy-acp.ts takesPromptMidTurn): `prompt` unless it advertised something of its own.
 */
export function steeringModeOf(init: Pick<InitializeResponse, '_meta' | 'agentCapabilities'>, promptUnadvertised = false): SteeringMode {
  const claude = init.agentCapabilities?._meta?.['claudeCode'];
  if (isRecord(claude) && claude['promptQueueing'] === true) return 'prompt';
  const steering = init._meta?.['steering'];
  if (isRecord(steering) && steering['supported'] === true) return 'steer';
  return promptUnadvertised ? 'prompt' : 'none';
}

/**
 * Params for `_session/steering`.
 *
 * `idleBehavior: "promptRequired"` asks a harness that finds no turn running to hand the message back
 * (`{outcome: "promptRequired"}`) instead of starting a detached turn the gateway has no prompt for.
 * claude-agent-acp honours it (0.81 `parseSteerRequest`, which rejects any OTHER value as invalid
 * params); codex-acp 2.2.1 ignores `_meta` and starts the turn anyway — read as `detached`.
 */
export function steerParams(sessionId: string, prompt: ContentBlock[]): Record<string, unknown> {
  return { sessionId, prompt, _meta: { steering: { idleBehavior: 'promptRequired' } } };
}

/**
 * What a `_session/steering` response means for the message.
 *
 * Unknown outcomes — codex-acp's `failed` (a steer into a review or compact turn) or anything a later
 * release adds — are `refused`: the gateway keeps the message and sends it after the turn, which can
 * at worst answer it twice if the harness did in fact take it. The opposite reading could lose it.
 */
export function readSteerOutcome(response: unknown): SteerOutcome {
  const outcome = isRecord(response) ? response['outcome'] : undefined;
  if (outcome === 'injected') return 'joined';
  if (outcome === 'startedNewTurn') return 'detached';
  return 'refused';
}
