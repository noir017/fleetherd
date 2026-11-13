import type { TopicActivity, TopicStage, TurnFailureReason } from '../types.js';

/**
 * Where a conversation stands from a person's point of view, decided from facts alone.
 *
 * This is what lets one person run more conversations than they can watch: a list of the ones that
 * need them, with every other conversation taking no space. The model is DeepSeek's Super-agent
 * prototype (`src/core/stage.ts` in deepseek-ai/dsh-superagent-prototype, read 2026-11-02), whose
 * ticket stages are read top to bottom with the first matching row winning — and which deliberately
 * refuses to infer "waiting on a person" from what a reply SAYS: "the classification needs
 * structured facts". So does this. A question is a question because buttons are on screen, a
 * failure is a failure because the turn threw, and a reply wants reviewing because it arrived after
 * the person last looked. Nothing here reads prose to decide anything.
 *
 * Pure, like the rest of core: the caller supplies every fact, including when the person last
 * looked, so the web UI (which knows that) and the daemon (which asks it) reach the same answer.
 */

/** The facts a stage is decided from. */
export interface TopicFacts {
  /** A turn is running here, or background work is reporting in after one (the typing hold). */
  running: boolean;
  /** A question is on screen and nothing moves until it is answered (an ask, an elicitation, a permission request). */
  asking: boolean;
  /** What the gateway pushed about the last turn (see TopicActivity). */
  activity?: TopicActivity;
  /** When the person last looked at this conversation, epoch ms; absent = never, as far as anyone can tell. */
  seenAt?: number;
}

/**
 * The stage, first matching row winning:
 *
 * | stage      | when                                                                    |
 * |------------|-------------------------------------------------------------------------|
 * | `answer`   | a question is on screen                                                 |
 * | `retrying` | the last turn failed and an automatic continue is scheduled             |
 * | `working`  | a turn is running (a new turn supersedes whatever the last one left)    |
 * | `failed`   | the last turn failed, and nothing has run since                         |
 * | `review`   | the last turn finished after the person last looked                     |
 * | `idle`     | none of the above                                                       |
 *
 * `answer` beats `working` because a question holds its turn open — both are true at once, and only
 * one of them says what the conversation is waiting for. `retrying` beats `working` for the moment
 * between a failure and its continue, when nothing is running yet but nothing needs a person either.
 *
 * A failure stays a failure after it has been seen, where a finished reply stops being news: the
 * work is still not done, and Super-agent keeps its `person/failed` the same way, until a person
 * writes. Here the next turn clears it — whoever starts that turn.
 */
export function topicStage(f: TopicFacts): TopicStage {
  if (f.asking) return 'answer';
  if (f.activity?.retry) return 'retrying';
  if (f.running) return 'working';
  const outcome = f.activity?.outcome;
  if (outcome?.kind === 'failed') return 'failed';
  if (outcome?.kind === 'done' && outcome.at > (f.seenAt ?? 0)) return 'review';
  return 'idle';
}

/** Whether a stage is one a person has to act on — the ones a list of things to do shows. */
export function needsPerson(stage: TopicStage): boolean {
  return stage === 'answer' || stage === 'failed' || stage === 'review';
}

/** How long the one line beside a conversation's name may be. A sidebar row, not a summary. */
export const LINE_MAX = 120;

/**
 * The one line that stands for a reply: its first line of prose, stripped of markdown.
 *
 * The first line rather than a summary, because replies here are written conclusion-first (the
 * operator's own standing instruction to every agent), so the first line usually IS the summary —
 * and because a summary would need a model call per finished turn, for a line that is only there so
 * the person can decide which conversation to open. Headings, fences and blank lines are skipped:
 * a reply that opens with `## Result` has said nothing yet.
 */
export function replyLine(text: string, max = LINE_MAX): string | undefined {
  let fenced = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || /^#{1,6}\s/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line) || line.startsWith('|')) continue;
    const plain = line
      .replace(/^>\s*/, '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!plain) continue;
    return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
  }
  return undefined;
}

/**
 * The line a failure stands for. The runtimes' messages are written to be read (see TurnRunner's
 * failure path), so this only bounds them.
 */
export function failureLine(message: string, max = LINE_MAX): string {
  const one = message.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * What a failure says about a prompt the agent never received: that it did not, and — when the
 * turn's messages are held (FailedInputs) — that they go with the next one. Without it a failed
 * start read like any failure, and the "continue" sent after it became the only thing the agent
 * was ever told (2026-11-07, 18 sub-agent topics).
 */
export function undeliveredLine(held: number): string {
  return held > 0
    ? `The agent did not receive this — it will be sent along with the next message.`
    : 'The agent did not receive this.';
}

/**
 * How a failure reason reads in a sentence ("failed (service)" says nothing to most people). Total
 * over the union, so a new reason fails to compile here rather than reading as its identifier.
 */
export function describeFailureReason(reason: TurnFailureReason): string {
  switch (reason) {
    case 'service':
      return 'the model provider failed';
    case 'limit':
      return 'a usage limit was hit';
    case 'connection':
      return 'the connection to the model provider failed';
    case 'access':
      return 'the agent is not signed in or not allowed';
    case 'request':
      return 'the model provider refused the request';
    case 'provider':
      return 'the model provider failed';
    case 'hung':
      return 'the agent stopped responding';
    case 'startup':
      return 'the agent could not start';
    case 'preLaunch':
      return 'the preLaunch hook failed';
    case 'restart':
      return 'the gateway restarted mid-turn';
    case 'other':
      return 'the turn failed';
    default: {
      const _exhaustive: never = reason;
      return String(_exhaustive);
    }
  }
}

/**
 * How long to wait before automatic continue number `attempt` (1-based): `baseMs`, doubling each
 * time, capped at ten minutes so a long `max` cannot stretch one wait past what anyone would call
 * "automatic". Doubling for the reason every retry here doubles: a provider that failed twice in a
 * row is not helped by being asked again at the same pace.
 */
export function continueDelayMs(attempt: number, baseMs: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(baseMs * 2 ** (n - 1), 10 * 60_000);
}
