import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDef, Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import type { HistoryReviewChange, HistoryReviewRecord, HistoryStore, HistorySessionRow, ReviewWindow } from '../history/store.js';
import { buildHarnessEnv, remoteAgentEnv } from './agent-common.js';
import { AGY_COMMAND } from './agy-cli.js';
import type { ReviewFacts } from './conversation.js';
import { remoteHosts } from './remote-hosts.js';
import { buildReviewPrompt, parseReviewOutput, usedSkillNames, type PromptSkill, type PromptSkillText, type ReviewChange } from './review-prompt.js';
import { classifyReview, recordedChange, undoOf, type AppliedChange } from './review-result.js';
import { REVIEW_CAPACITY_MAX_ATTEMPTS, REVIEW_CAPACITY_RETRY_MS, type ReviewStateStore } from './review-state.js';
import {
  activeSkillNames,
  createSkill,
  listSkills,
  patchSkill,
  readSkillFiles,
  showSkill,
  skillHistory,
  writeSkillFile,
} from './skills-store.js';

/**
 * Automatic review of quiet conversations (`docs/skills.md#auto-review`).
 *
 * ── When it runs ────────────────────────────────────────────────────────────────────────────────
 * The moment idle reclaim stops a conversation's agent process, if the person has said at least
 * three things since the last review. In practice this is a sweep, not a hook on reclaim: reclaim
 * runs on a minute timer, and the same timer covers the three edges — the backfill after a gateway
 * restart (every child is gone, so "stopped" is true and the idle clock comes from the library),
 * `/kill` and `/new` (the child is already gone, so the conversation becomes a candidate when the
 * hour is up), and a conversation that is never reclaimed (reclaim off, or a harness that cannot
 * resume a session — those are reviewed while their child is still up, because waiting for a
 * reclaim that never comes would mean never reviewing them).
 *
 * ── What the reviewer is ────────────────────────────────────────────────────────────────────────
 * One `agy -p` on the machine the configured reviewer agent runs on, in an empty temporary
 * directory, with every permission class denied (`AGY_NO_TOOLS`). Three measurements on agy 1.5.0
 * (2026-11-04) shaped this, and the first two contradict what the plan assumed:
 *  - print mode WITHOUT `--dangerously-skip-permissions` still auto-approves file writes (its
 *    default is accept-edits); a prompt that asked for a file created it;
 *  - `deny: ["*"]` denies NOTHING — the rule names a permission class literally, so `"*"` is a
 *    class that does not exist. The explicit list is what refuses `write_file`, `command`,
 *    `read_file` and `mcp` (measured: each reported "Matches user-configured deny rule", and the
 *    directory stayed empty);
 *  - the prompt cannot ride in argv: Linux caps one argument at 128 KB (`MAX_ARG_STRLEN`), and a
 *    360 KB `-p=` fails with "Argument list too long". It goes on stdin as one NDJSON user
 *    message instead (`reviewAgyInput`), in the same stream-json shape `agent-agy.ts` drives.
 * The agent's own CLI still keeps its conversation state under `~/.gemini`, as any CLI does; that
 * is not a tool call. A tool added in a permission class not in that list would not be denied, so
 * the list is part of the security contract — see AGENTS.md invariant 8.
 *
 * The prompt also says, in its first line, that nobody will answer and no approval is coming: on
 * this host agy reads the operator's global `~/.gemini/config/AGENTS.md`, whose standing rule is
 * "propose first, wait for 开工". Without that line the reviewer comes back asking permission
 * instead of answering.
 *
 * ── Who writes ──────────────────────────────────────────────────────────────────────────────────
 * The gateway, through skills-store's own functions, one change at a time. A change the store
 * refuses (a bad name, an oversized file, a version that moved while the reviewer was thinking) is
 * dropped and logged, never retried in a loop. The reviewer itself never has a write path.
 *
 * ── What it costs ───────────────────────────────────────────────────────────────────────────────
 * One review at a time, a six-hour back-off after a failure, and at most REVIEW_MAX_ATTEMPTS tries
 * on the same batch of messages before the sweep gives up on it. A failure whose output says the
 * provider has no capacity for the model is not the reviewer failing: it waits an hour, does not
 * count toward those tries, and does not abandon the batch — up to
 * REVIEW_CAPACITY_MAX_ATTEMPTS such failures in a row, after which they count like any other (see
 * isCapacityFailure). There is no daily cap: each conversation's watermark is what stops it being
 * reviewed again, and REVIEW_LAST_MESSAGE_MAX_MS keeps the first start from replaying months of
 * history for conversations it has never seen. A watermark that cannot be written is held in
 * memory (review-state.ts), so a full disk does not become a review loop.
 */

/** A conversation has to be quiet this long before a review — the reclaim deadline's own hour. */
export const REVIEW_IDLE_MS = 3_600_000;

/** How often the sweep looks. The same coarse minute as the idle sweeper, for the same reason. */
export const REVIEW_SWEEP_MS = 60_000;

/**
 * How old the newest message may be, for a conversation this feature has never seen. This is what
 * the daily cap used to do on the first start: review the conversations that just went quiet, not
 * every conversation since the gateway was installed. A conversation with a mark (reviewed or
 * failed) is not subject to it — its watermark and retry time do that job.
 */
export const REVIEW_LAST_MESSAGE_MAX_MS = 24 * 3_600_000;

/**
 * Failed attempts allowed on one batch of messages. After this the sweep gives up on the batch and
 * moves the watermark past it: an exhausted reviewer (or a host that is down) must not hold the
 * single review lane forever, retrying the same messages every six hours.
 */
export const REVIEW_MAX_ATTEMPTS = 3;

/** How many of the person's messages make a conversation worth reviewing. */
export const REVIEW_MIN_USER_MESSAGES = 3;

/** How much of the conversation the prompt carries, in characters. */
export const REVIEW_CONVERSATION_CHARS = 40_000;

/** How many used skills are quoted in full. The rest stay in the catalog. */
const MAX_USED_SKILLS = 8;

/**
 * One review's wall clock. A review reads, thinks and prints one JSON object — but it can also
 * spend a long time waiting on the provider.
 *
 * Thirty minutes, not five, measured on 2026-11-05/06: of 26 reviews, the 6 failures were all
 * `agy on awsfree2 timed out after 5 min`, and every one was Google queueing
 * `gemini-3.8-flash-high` — the request hangs for 2–4.5 minutes, then answers `UNAVAILABLE (503):
 * No capacity available for model gemini-3.8-flash-high`. agy 1.5.1 retries that itself after 4 s
 * (`attempt 1 failed … retrying in 4s`; a recovery after attempt 3 was seen on 11-04), so the old
 * five-minute cap killed agy before its own retry loop could finish. Successful reviews took
 * 37–251 s regardless of prompt size, so 30 minutes is about six worst-case queue waits — enough
 * for a 10–20 minute drought with room to spare. A review has no deadline; holding the single lane
 * longer is cheaper than losing the batch.
 *
 * The timeout is treated as capacity even though it proves nothing about the cause. Measured on
 * 11-06 in agy 1.5.1 (cli-20261106_110242.log): it retried past `attempt 5 failed … retrying in
 * 18.9s`, and no give-up limit was found in the binary, so a capacity queue can keep it running
 * past any cap — and a kill leaves no result event or stderr to read. Calling every timeout an
 * ordinary failure would bring back exactly the six lost batches this change is for. A permanently
 * hung agy is bounded by the twelve-in-a-row capacity limit instead: those timeouts stop being
 * exempt, count, and the batch is given up on after three more. Errors that fail at once — no such
 * host, a spawn failure, ssh refused — never reach the timeout and stay ordinary failures.
 */
export const REVIEW_TIMEOUT_MS = 30 * 60_000;

/**
 * How long one sweep may keep starting reviews. A pass that has already spent this long stops
 * starting new ones and leaves the rest to the next minute's tick, so a run of capacity-starved
 * batches cannot make one pass last for hours. It bounds *starting*, not the pass: the review
 * already running finishes, so a pass takes at most 40 minutes plus its last review's 30.
 */
export const REVIEW_PASS_BUDGET_MS = 40 * 60_000;

/**
 * Every permission class the CLI knows, denied. `"*"` is NOT a wildcard here — measured on agy
 * 1.5.0, `deny: ["*"]` matched nothing and `write_file` still wrote a file — so each class is
 * named. The reviewer reads nothing and writes nothing: everything it needs is in the prompt.
 *
 * An unknown class in this list is ignored by the CLI (it logs "ignoring invalid deny entry"), so
 * adding one costs nothing; a NEW tool class in a future agy is not covered, which is why the
 * security note in AGENTS.md calls this list part of the contract.
 */
export const AGY_NO_TOOLS = JSON.stringify({
  permissions: {
    deny: [
      'write_file(*)',
      'read_file(*)',
      'list_dir(*)',
      'search(*)',
      'command(*)',
      'url(*)',
      'browser(*)',
      'mcp(*)',
    ],
  },
});

export interface ReviewLane {
  platform: string;
  channel: string;
  thread?: string;
}

/** One conversation, as the sweep sees it. Built by the daemon from live state and the store. */
export interface ReviewCandidate {
  /** The conversation key `conversations.json` and `history.db` share. */
  key: string;
  lane?: ReviewLane;
  /** Ms since anything last happened here. */
  idleMs: number;
  /** A turn is running, or a batch is about to start one. */
  busyTurn: boolean;
  /** The daemon holds out-of-turn work (a pending `ask`). */
  pendingWork: boolean;
  /** No agent child is resident. */
  stopped: boolean;
  /** A child is resident but its harness cannot resume a session, so reclaim leaves it alone. */
  unresumable: boolean;
}

export type ReviewRun =
  | { ok: true; output: string }
  | {
      ok: false;
      error: string;
      /**
       * The provider had no capacity for the model, or the run hit the review timeout. The caller
       * then retries without counting the attempt, up to the consecutive-capacity limit.
       */
      capacity?: boolean;
    };

/**
 * Whether a run that finished said the provider had no capacity for this model.
 *
 * Narrow on purpose. This failure alone skips the attempt count, so a false positive turns any
 * permanent fault into an endless retry and defeats the three-attempt limit. The evidence agy
 * actually produces is `UNAVAILABLE (code 503): No capacity available for model <id> on the
 * server` (measured 11-04/11-06, in the result event or on stderr); it is matched either as
 * `no capacity available` or as `UNAVAILABLE` and a standalone `503` in the same text. A bare
 * `503` (a port, an id), `resource temporarily unavailable`, `Connection timed out`, or any other
 * error is not evidence.
 *
 * A timeout is handled separately, by the runner's own `capacity` flag, not by this match: a
 * killed run has no output to read and no cause to name. See REVIEW_TIMEOUT_MS for why it is
 * still treated as capacity and what bounds that.
 */
export function isCapacityFailure(error: string): boolean {
  if (/no capacity available/i.test(error)) return true;
  return /\bunavailable\b/i.test(error) && /\b503\b/.test(error);
}

/** One `agy -p`, injected so tests never start a model. */
export type ReviewRunner = (def: AgentDef, model: string | undefined, prompt: string) => Promise<ReviewRun>;

export interface ReviewDeps {
  config: Config;
  history: HistoryStore;
  state: ReviewStateStore;
  clock: { now(): number; schedule(fn: () => void, ms: number): () => void };
  /** Every conversation the daemon knows, live or from `conversations.json` after a restart. */
  candidates(): ReviewCandidate[];
  /** Say one line in the reviewed conversation. Rejections are logged, never fatal. */
  notify(lane: ReviewLane, text: string): Promise<void>;
  /** The managed skills directory; `configDir()` in production, a temp dir in tests. */
  skillsDir?: string;
  /**
   * Run the review's writes as one: the daemon's skills repository pulls before them and pushes
   * after them, so a patch is checked against the newest version and lands in the repository at
   * once. Absent in a test, where they simply run.
   */
  writeSkills?: <T>(fn: () => T) => Promise<T>;
  run?: ReviewRunner;
  log?: (message: string) => void;
}

interface Plan {
  session: HistorySessionRow;
  window: ReviewWindow;
}

/** What one review's answer produced: what the store took, and what it refused. */
interface AppliedResult {
  applied: Array<{ change: ReviewChange; result: AppliedChange }>;
  refused: Array<{ change: ReviewChange; error: string }>;
}

export class ReviewService {
  private timer: (() => void) | undefined;
  private busy = false;
  private stopped = false;

  constructor(private readonly deps: ReviewDeps) {}

  /** Arm the sweep and take the first pass at once — the backfill after a restart. */
  start(): void {
    this.stopped = false;
    const pass = (): void => {
      void this.sweep().catch((e) => this.log(`[review] sweep failed: ${e instanceof Error ? e.message : e}`));
    };
    pass();
    const tick = (): void => {
      pass();
      if (!this.stopped) this.timer = this.deps.clock.schedule(tick, REVIEW_SWEEP_MS);
    };
    this.timer = this.deps.clock.schedule(tick, REVIEW_SWEEP_MS);
  }

  stop(): void {
    this.stopped = true;
    this.timer?.();
    this.timer = undefined;
  }

  /** The configured reviewer, when `review.agent` names an agent this config still has. */
  private reviewer(): AgentDef | undefined {
    const id = this.deps.config.review?.agent;
    return id ? findAgent(this.deps.config, id) : undefined;
  }

  /**
   * Whether a reviewer is configured right now. Read live rather than cached, because `/reload`
   * mutates the config in place and the web UI's Reviews tab must not keep saying "off" after a
   * reviewer was named (or the reverse).
   */
  enabled(): boolean {
    return this.reviewer() !== undefined;
  }

  /**
   * One pass. Public because the timer is not the interesting part — the decision is, and a test
   * drives it against a controlled clock.
   */
  async sweep(): Promise<void> {
    if (this.busy || this.stopped) return;
    const reviewer = this.reviewer();
    if (!reviewer || !this.deps.history.available) return;
    this.busy = true;
    try {
      const reclaimOff = !(this.deps.config.session.idleTimeoutMs > 0);
      const all = this.deps.candidates();
      const ready = all.filter((c) => eligible(c, reclaimOff));
      // A conversation whose last failure was the provider out of capacity goes behind the rest.
      // It is the one kind that can spend the whole 30-minute timeout and still be retried an hour
      // later, so leaving it at the head of the queue would let one starved batch delay every
      // fresh conversation behind it again and again.
      const stalled = new Set(ready.filter((c) => this.deps.state.markOf(c.key)?.capacity).map((c) => c.key));
      const candidates = ready.sort(
        (a, b) => Number(stalled.has(a.key)) - Number(stalled.has(b.key)) || a.idleMs - b.idleMs
      );
      // Freshest first otherwise: on the first start with this feature every conversation looks
      // reviewable, and the ones that just went quiet are the useful ones. The freshness rule
      // in `plan` is what keeps months of history out; there is no daily cap any more.
      const startedAt = this.deps.clock.now();
      for (const candidate of candidates) {
        const current = this.reviewer();
        if (!current || this.stopped) break;
        // One conversation's broken row must not end the pass: the next candidate may be fine.
        try {
          // Per candidate, not once per pass: with no cap a pass can outlive the hour, and a
          // retry that is six hours old by now must not be held back by a stale clock.
          const now = this.deps.clock.now();
          if (now - startedAt >= REVIEW_PASS_BUDGET_MS) {
            this.log(`[review] pass budget of ${REVIEW_PASS_BUDGET_MS / 60_000} min reached; the rest waits for the next sweep`);
            break;
          }
          const plan = this.plan(candidate, now);
          if (!plan) continue;
          await this.runOne(candidate, plan, current, now);
        } catch (e) {
          this.log(`[review] ${candidate.key}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Whether this conversation is worth reviewing now: the library has it, it is a person's
   * conversation rather than a scheduled, sub-agent or review one, its last failure has backed
   * off, its newest message is under a day old when this feature has never seen it, and the person
   * has said enough since the last review.
   */
  private plan(candidate: ReviewCandidate, now: number): Plan | undefined {
    const session = this.deps.history.sessionOf(candidate.key);
    if (!session || EXCLUDED_KINDS.has(session.kind)) return undefined;
    if (!this.deps.state.ready(candidate.key, now)) return undefined;
    const mark = this.deps.state.markOf(candidate.key);
    const window = this.deps.history.reviewWindow(candidate.key, mark?.messageId ?? 0, REVIEW_CONVERSATION_CHARS);
    if (!window || window.messages.length === 0) return undefined;
    // The freshness rule applies only to a conversation with no mark at all: it exists so the
    // first start after enabling cannot replay months of history. Once a mark exists — reviewed or
    // failed — the watermark and the six-hour retry decide; applying the age here too would make a
    // failed conversation permanently unreviewable once its messages turned a day old.
    const newest = window.messages[window.messages.length - 1];
    if (!newest) return undefined;
    if (!mark && now - (Date.parse(newest.at) || 0) > REVIEW_LAST_MESSAGE_MAX_MS) return undefined;
    if (window.userMessages < REVIEW_MIN_USER_MESSAGES) return undefined;
    return { session, window };
  }

  /**
   * Record one failure and return the sentence for the log and the Reviews row. A counted failure
   * is one of the three that give up on the batch: the watermark moves past it, so only messages
   * that arrive afterwards can start another review.
   *
   * A capacity failure is not counted — up to REVIEW_CAPACITY_MAX_ATTEMPTS in a row. Past that the
   * store counts it, and the sentence says so, because the batch is now on its way to being given
   * up on like any other repeated failure. `at` is when the attempt ended, so the back-off runs
   * from there rather than from before a 30-minute timeout.
   */
  private fail(candidate: ReviewCandidate, plan: Plan, error: string, at: number, capacity: boolean): string {
    const { attempts, counted } = this.deps.state.failed(candidate.key, error, at, capacity ? 'capacity' : 'attempt');
    if (!counted) {
      const message = `${error} (no capacity at the provider; retrying in ${REVIEW_CAPACITY_RETRY_MS / 3_600_000}h, not counted as an attempt)`;
      this.log(`[review] ${candidate.key}: ${message}`);
      return message;
    }
    let message = error;
    if (attempts >= REVIEW_MAX_ATTEMPTS) {
      message = `gave up after ${attempts} attempts: ${error}`;
      this.deps.state.gaveUp(candidate.key, plan.window.lastMessageId, message, at);
    } else if (capacity) {
      // The capacity streak reached its cap: this is the first one that counts, and the ones after
      // it will count too.
      const streak = this.deps.state.markOf(candidate.key)?.capacityAttempts ?? REVIEW_CAPACITY_MAX_ATTEMPTS;
      message = `${error} (no capacity ${streak} times in a row; counting this as attempt ${attempts} of ${REVIEW_MAX_ATTEMPTS})`;
    }
    this.log(`[review] ${candidate.key}: ${message}`);
    return message;
  }

  private async runOne(candidate: ReviewCandidate, plan: Plan, reviewer: AgentDef, now: number): Promise<void> {
    let prompt: string;
    try {
      prompt = this.promptFor(plan);
    } catch (e) {
      // Building the prompt reads the skill library and every skill the conversation used. A
      // failure there — an unreadable directory, a broken `SKILL.md` — is a failed review like any
      // other: back off, and leave a row so the Reviews tab can say why nothing happened.
      const error = this.fail(candidate, plan, `could not prepare the review: ${e instanceof Error ? e.message : String(e)}`, now, false);
      const failedId = this.record(plan, '', '', reviewer, candidate, now);
      this.writeResult(failedId, plan, candidate, now, {
        outcome: 'failed',
        changes: [],
        preferences: [],
        invalid: [],
        error,
      });
      return;
    }
    const model = this.deps.config.review?.model ?? reviewer.model;
    const result = await this.run(reviewer, model, prompt);
    if (!result.ok) {
      // Two sources: the runner's own `capacity` flag, which is how a timeout is marked (a killed
      // run has no output to read), and the text of a run that finished with a 503. An immediate
      // failure — spawn, ssh — sets neither and counts as ordinary.
      const capacity = result.capacity === true || isCapacityFailure(result.error);
      // The back-off runs from the end of the attempt: `now` was taken before a run that may have
      // spent 30 minutes timing out, and "an hour" from its start would only be 30 minutes of wait.
      const endedAt = this.deps.clock.now();
      const error = this.fail(candidate, plan, result.error, endedAt, capacity);
      // A failed attempt is a review too. Until this row existed the reason a quiet conversation
      // was never reviewed lived only in the log, which is not where a person looks; the Reviews
      // tab is. The session has no answer to file, only the prompt and the failure.
      const failedId = this.record(plan, prompt, '', reviewer, candidate, now);
      this.writeResult(failedId, plan, candidate, now, {
        outcome: 'failed',
        changes: [],
        preferences: [],
        invalid: [],
        error,
      });
      return;
    }
    const id = this.record(plan, prompt, result.output, reviewer, candidate, now);
    const parsed = parseReviewOutput(result.output);
    if (!parsed.ok) {
      // The model answered, just not in the shape this expects. Treat it as a review that found
      // nothing: the conversation is marked seen (retrying it every six hours would spend quota on
      // the same answer), nothing is posted, and the log says what came back. The raw answer is
      // already in the library, in the review session recorded above — and the result row says the
      // answer could not be read, so the tab does not present an unreadable answer as "nothing".
      this.deps.state.reviewed(candidate.key, plan.window.lastMessageId, now);
      this.log(`[review] ${candidate.key}: ${parsed.error}; treated as no change; the answer starts: ${result.output.slice(0, 200)}`);
      this.writeResult(id, plan, candidate, now, {
        outcome: 'failed',
        changes: [],
        preferences: [],
        invalid: [],
        error: `the answer could not be read: ${parsed.error}`,
      });
      return;
    }
    for (const bad of parsed.parsed.invalid) this.log(`[review] ${candidate.key}: dropped ${bad}`);
    const changesToApply = parsed.parsed.output.changes;
    const applyAll = (): AppliedResult => this.apply(candidate, changesToApply, reviewer);
    const outcome = this.deps.writeSkills ? await this.deps.writeSkills(applyAll) : applyAll();
    this.deps.state.reviewed(candidate.key, plan.window.lastMessageId, now);
    const changes: HistoryReviewChange[] = [
      ...outcome.applied.map((a) => recordedChange(a.change, { applied: a.result })),
      ...outcome.refused.map((r) => recordedChange(r.change, { refused: r.error })),
    ];
    this.writeResult(id, plan, candidate, now, {
      outcome: classifyReview({ changes, preferences: parsed.parsed.output.preferences, invalid: parsed.parsed.invalid }),
      changes,
      preferences: parsed.parsed.output.preferences,
      invalid: parsed.parsed.invalid,
    });
    await this.notify(
      candidate,
      outcome.applied.map((a) => a.result),
      parsed.parsed.output.preferences
    );
  }

  /** Build the prompt: rules, catalog, the skills this conversation used, then the conversation. */
  private promptFor(plan: Plan): string {
    const dir = this.deps.skillsDir;
    const catalog = listSkills(dir)
      .filter((s) => s.status !== 'archived')
      .map((s): PromptSkill => ({ name: s.name, version: s.version, description: s.description }));
    const used: PromptSkillText[] = [];
    for (const name of usedSkillNames(plan.window.messages, new Set(activeSkillNames(dir))).slice(0, MAX_USED_SKILLS)) {
      try {
        used.push(this.usedSkill(name));
      } catch (e) {
        // Archived between the listing and the read: the catalog still names it, so a create or a
        // patch of something else is unaffected.
        this.log(`[review] could not read "${name}" for the prompt: ${e instanceof Error ? e.message : e}`);
      }
    }
    return buildReviewPrompt({
      title: plan.session.title,
      messages: plan.window.messages.map((m) => ({ at: m.at, role: m.role, text: m.text })),
      dropped: plan.window.dropped,
      catalog,
      used,
    });
  }

  /** One used skill in full: its `SKILL.md`, its version and the names of the files beside it. */
  private usedSkill(name: string): PromptSkillText {
    const dir = this.deps.skillsDir;
    const shown = showSkill(name, undefined, dir);
    const files = [...readSkillFiles(name, dir).keys()].filter((f) => f !== 'SKILL.md').sort();
    return { name, version: shown.version, description: '', content: shown.content, files };
  }

  private async run(reviewer: AgentDef, model: string | undefined, prompt: string): Promise<ReviewRun> {
    const runner = this.deps.run ?? runAgyReview;
    try {
      return await runner(reviewer, model, prompt);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Apply what passed the store's rules. Each change stands alone: a name that is already taken, a
   * version that moved, a file outside the three directories — that change is dropped and logged,
   * and the next one is still tried.
   */
  private apply(candidate: ReviewCandidate, changes: ReviewChange[], reviewer: AgentDef): AppliedResult {
    const out: AppliedResult = { applied: [], refused: [] };
    const dir = this.deps.skillsDir;
    const source = {
      conversation: candidate.key,
      ...(candidate.lane ? { platform: candidate.lane.platform, address: addressOfLane(candidate.lane) } : {}),
      agent: reviewer.id,
      // "来源记为复盘": the conversation is the one that was reviewed, not one that asked for
      // this — `origin` is what tells them apart in the usage file.
      origin: 'review' as const,
    };
    const by = { kind: 'review' as const, agent: reviewer.id, conversation: candidate.key };
    for (const change of changes) {
      try {
        if (change.action === 'create') {
          createSkill({ name: change.name, description: change.description, body: change.body, source, note: change.reason, by }, dir);
          out.applied.push({ change, result: { name: change.name, action: 'created' } });
        } else if (change.action === 'patch') {
          patchSkill({ name: change.name, version: change.version, content: change.content, note: change.reason, by }, dir);
          out.applied.push({
            change,
            result: { name: change.name, action: 'patched', revertId: newestHistoryId(change.name, dir) },
          });
        } else {
          writeSkillFile({ name: change.name, file: change.file, content: change.content, note: change.reason, by }, dir);
          out.applied.push({
            change,
            result: { name: change.name, action: 'file', file: change.file, revertId: newestHistoryId(change.name, dir) },
          });
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        out.refused.push({ change, error });
        this.log(`[review] dropped ${change.action} "${change.name}": ${error}`);
      }
    }
    return out;
  }

  /**
   * File the review itself in the library, as a `review` session no search returns, and answer its
   * id so the result row can be attached. An empty `output` is a run that never answered: the
   * session then holds the prompt alone. An empty `prompt` is a preparation failure, before
   * anything was sent: the session holds no messages at all.
   */
  private record(
    plan: Plan,
    prompt: string,
    output: string,
    reviewer: AgentDef,
    candidate: ReviewCandidate,
    now: number
  ): number | undefined {
    try {
      const id = this.deps.history.session({
        key: `review:${candidate.key}:${now}`,
        platform: candidate.lane?.platform ?? '',
        title: `复盘：${plan.session.title || candidate.key}`,
        agent: reviewer.id,
        host: reviewer.host ?? '',
        kind: 'review',
        at: now,
      });
      if (prompt) this.deps.history.message(id, { ts: now, role: 'user', kind: 'review', text: prompt });
      if (output) this.deps.history.message(id, { ts: now, role: 'agent', kind: 'review', text: output });
      return id;
    } catch (e) {
      this.log(`[review] could not record the review session: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  /** Attach what the review produced to its session — the Reviews tab reads exactly this. */
  private writeResult(
    sessionId: number | undefined,
    plan: Plan,
    candidate: ReviewCandidate,
    now: number,
    result: Pick<HistoryReviewRecord, 'outcome' | 'changes' | 'preferences' | 'invalid' | 'error'>
  ): void {
    if (sessionId === undefined) return;
    this.deps.history.recordReview(sessionId, {
      reviewedKey: candidate.key,
      reviewedTitle: plan.session.title || candidate.key,
      platform: candidate.lane?.platform ?? '',
      ...(candidate.lane ? { channel: candidate.lane.channel } : {}),
      ...(candidate.lane?.thread ? { thread: candidate.lane.thread } : {}),
      at: now,
      ...result,
    });
  }

  /** One line in the conversation, and only when something changed. */
  private async notify(candidate: ReviewCandidate, applied: AppliedChange[], preferences: string[]): Promise<void> {
    if (applied.length === 0) {
      if (preferences.length > 0) {
        this.log(`[review] ${candidate.key}: no skill change; preferences: ${preferences.join('；')}`);
      }
      return;
    }
    const text = noticeLine(applied, preferences);
    // No lane, or a gateway on its way down: the line still lands in the log, which is where an
    // operator looks when a change was made and no chat said so.
    if (!candidate.lane || this.stopped) {
      this.log(`[review] ${candidate.key}: ${text} (not posted: ${this.stopped ? 'shutting down' : 'no lane'})`);
      return;
    }
    try {
      await this.deps.notify(candidate.lane, text);
    } catch (e) {
      this.log(`[review] ${candidate.key}: could not post the notice: ${e instanceof Error ? e.message : e}`);
    }
  }

  private log(message: string): void {
    (this.deps.log ?? ((m) => console.log(m)))(message);
  }
}

/** Conversation kinds a review never looks at: its own, a scheduled task's, a sub-agent's. */
const EXCLUDED_KINDS: ReadonlySet<string> = new Set(['schedule', 'subagent', 'review']);

/** What `conversations.json` remembers that the sweep needs. The key is the tuple's first half. */
export interface StoredConversation {
  lane?: ReviewLane;
  lastAt?: number;
}

/**
 * The sweep's candidate list: `conversations.json` (which survives a restart and knows the lane)
 * with this process's live facts laid over it where there are any (which know whether a turn is
 * running, a child is resident, or a question is waiting).
 *
 * A conversation the library has never recorded is left out — there is nothing to review, and the
 * row's `kind` is what keeps scheduled, sub-agent and review conversations out. After a restart no
 * child exists, so "stopped" defaults to true: that is exactly the backfill's condition, and the
 * idle clock falls back to the last recorded message rather than the record's "a turn started".
 */
export function reviewCandidatesFrom(
  stored: Iterable<[string, StoredConversation]>,
  live: ReviewFacts[],
  sessionOf: (key: string) => { lastAt: string } | undefined,
  now: number
): ReviewCandidate[] {
  const byKey = new Map(live.map((f) => [f.key, f]));
  const out: ReviewCandidate[] = [];
  const seen = new Set<string>();
  for (const [key, record] of stored) {
    const session = sessionOf(key);
    if (!session) continue;
    seen.add(key);
    out.push(mergeCandidate(key, record, session, byKey.get(key), now));
  }
  for (const fact of live) {
    if (!seen.has(fact.key)) out.push(liveCandidate(fact));
  }
  return out;
}

function mergeCandidate(
  key: string,
  record: StoredConversation,
  session: { lastAt: string },
  fact: ReviewFacts | undefined,
  now: number
): ReviewCandidate {
  const lastAt = Math.max(Date.parse(session.lastAt) || 0, record.lastAt ?? 0);
  const lane = record.lane ?? fact?.lane;
  return {
    key,
    ...(lane ? { lane } : {}),
    idleMs: fact?.idleMs ?? now - lastAt,
    busyTurn: fact?.busyTurn ?? false,
    pendingWork: fact?.pendingWork ?? false,
    stopped: fact ? fact.stopped : true,
    unresumable: fact?.unresumable ?? false,
  };
}

function liveCandidate(fact: ReviewFacts): ReviewCandidate {
  return {
    key: fact.key,
    ...(fact.lane ? { lane: fact.lane } : {}),
    idleMs: fact.idleMs,
    busyTurn: fact.busyTurn,
    pendingWork: fact.pendingWork,
    stopped: fact.stopped,
    unresumable: fact.unresumable,
  };
}

/**
 * The trigger, as one predicate.
 *
 * Quiet for an hour and no turn running is common to every case. What differs is the process:
 * a conversation whose child can still be reclaimed is reviewed only once that child is gone —
 * the plan's "at the moment reclaim stops it" — while one that is never reclaimed (reclaim off,
 * or a harness that cannot resume) is reviewed with its child still up. Waiting for a reclaim
 * that will not come would mean never reviewing those.
 */
export function eligible(candidate: ReviewCandidate, reclaimOff: boolean): boolean {
  if (candidate.idleMs < REVIEW_IDLE_MS) return false;
  if (candidate.busyTurn || candidate.pendingWork) return false;
  if (reclaimOff || candidate.unresumable) return true;
  return candidate.stopped;
}

/** The line posted back: what changed, how to undo it, and any preference the reviewer noticed. */
export function noticeLine(applied: AppliedChange[], preferences: string[]): string {
  const parts = applied.map((a) => {
    const undo = undoOf(a);
    if (a.action === 'created') return `新建技能 \`${a.name}\`（撤掉用 \`${undo}\`）`;
    const what = a.action === 'patched' ? `更新技能 \`${a.name}\`` : `给 \`${a.name}\` 写了 \`${a.file}\``;
    return undo ? `${what}（回滚 \`${undo}\`）` : what;
  });
  // One line, as promised: a model's preference is a sentence, and a sentence with a newline in it
  // would turn the notice into a paragraph.
  const said = preferences.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const tail = said.length ? `偏好建议：${said.join('；')}` : '';
  return ['📝 复盘：' + parts.join('；'), tail].filter(Boolean).join('。');
}

function newestHistoryId(name: string, dir: string | undefined): string | undefined {
  try {
    const entry = skillHistory(name, dir)[0];
    return entry?.beforeVersion ? entry.id : undefined;
  } catch {
    return undefined;
  }
}

function addressOfLane(lane: ReviewLane): { channel: string; thread?: string } {
  return lane.thread ? { channel: lane.channel, thread: lane.thread } : { channel: lane.channel };
}

/**
 * The argv for one review. The prompt is NOT here: a single argv entry is capped at 128 KB
 * (`MAX_ARG_STRLEN`), and a long Chinese conversation (40k characters is ~120 KB) plus the skills
 * it used blows through that — measured: a 360 KB `-p=` fails with "Argument list too long".
 * Instead agy is driven the way talkcode drives it everywhere else: stream-json on both ends, one
 * NDJSON user message on stdin, the answer on stdout.
 */
export function reviewAgyArgs(model: string | undefined): string[] {
  return [
    ...(model ? [`--model=${model}`] : []),
    `--settings=${AGY_NO_TOOLS}`,
    '--disable-slash-commands',
    '--input-format=stream-json',
    '--output-format=stream-json',
    // No prompt after `-p=`: stream-json reads stdin. This is the daemon's own resident shape
    // (agent-agy.ts buildAgyArgs), with stdin closed after the one message.
    '-p=',
  ];
}

/** The one NDJSON frame agy expects from stdin, shaped as agent-agy.ts writes it. */
export function reviewAgyInput(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

interface AgyReviewEvent {
  event?: string;
  step_update?: { step_type?: string; text_delta?: string };
  result?: { status?: string; response?: string; error?: string };
}

/**
 * What agy answered, read off its event stream.
 *
 * The text comes from the `agent_response` deltas, as the resident runtime reads it; `result.response`
 * is the fallback for a version that only fills the final frame. A non-SUCCESS result with no text
 * is a failure — except `ERROR` after a reply, which the runtime also believes, because some
 * providers report a failure after the answer has already streamed.
 */
export function agyReviewAnswer(stdout: string): ReviewRun {
  const { streamed, result } = scanAgyEvents(stdout);
  if (!result) return { ok: false, error: 'agy ended without a result event' };
  const answer = (streamed.trim() ? streamed : result.response ?? '').trim();
  const status = result.status ?? 'SUCCESS';
  if (status !== 'SUCCESS' && !(status === 'ERROR' && answer)) {
    return { ok: false, error: `agy ended with status ${status}${result.error ? `: ${result.error}` : ''}` };
  }
  if (!answer) return { ok: false, error: 'agy produced no answer' };
  return { ok: true, output: answer };
}

/** The two things the answer is built from: the streamed text, and the final frame. */
function scanAgyEvents(stdout: string): { streamed: string; result: AgyReviewEvent['result'] } {
  let streamed = '';
  let result: AgyReviewEvent['result'];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue; // a banner or log line on stdout: not our protocol
    let msg: AgyReviewEvent;
    try {
      msg = JSON.parse(text) as AgyReviewEvent;
    } catch {
      continue;
    }
    if (msg.event === 'step_update' && msg.step_update?.step_type === 'agent_response') {
      streamed += msg.step_update.text_delta ?? '';
    } else if (msg.event === 'result') {
      result = msg.result ?? {};
    }
  }
  return { streamed, result };
}

/**
 * One review run: `agy -p` in an empty directory on the reviewer's machine, with every tool
 * denied and the prompt on stdin. Remote uses the gateway's existing ssh link (`RemoteHost.run`,
 * whose body is the child's stdin); local spawns the CLI directly. The directory is removed
 * afterwards either way — it exists only so the reviewer has no workspace to read and nothing of
 * the operator's within reach.
 */
export async function runAgyReview(def: AgentDef, model: string | undefined, prompt: string): Promise<ReviewRun> {
  const argv = reviewAgyArgs(model);
  const input = reviewAgyInput(prompt);
  const host = remoteHosts.hostFor(def);
  // An agent with `host:` whose host is not registered (yet) must not be run HERE: in a
  // gateway-only container that is a machine with no agy, and on any other it is the wrong account
  // and the wrong quota. Same rule as fetchAgyModelsFor.
  if (def.host && !host) return { ok: false, error: `host "${def.host}" is not registered` };
  if (!host) return runAgyReviewLocal(def, argv, input);
  const welcome = await host.ready();
  const root = path.posix.join(welcome.home, '.talkcode', 'reviews');
  const dir = path.posix.join(root, `r${Date.now().toString(36)}${randomBytes(3).toString('hex')}`);
  try {
    await host.mkdirp(dir, 0o700);
    const r = await host.run({
      argv: [AGY_COMMAND, ...argv],
      cwd: dir,
      env: remoteAgentEnv(def),
      stdin: input,
      timeoutMs: REVIEW_TIMEOUT_MS,
      max: 1 << 20,
    });
    if (r.spawnError) return { ok: false, error: `agy on ${host.id}: ${r.spawnError}` };
    // A timeout is capacity by the runner's own judgement, not by text: a killed run usually
    // leaves nothing to match. Errors that fail at once (spawn, ssh) never reach this branch and
    // stay ordinary failures, so they still count toward the three-attempt limit.
    if (r.timedOut) {
      return { ok: false, error: `agy on ${host.id} timed out after ${REVIEW_TIMEOUT_MS / 60_000} min`, capacity: true };
    }
    if (r.code !== 0) {
      const error = `agy on ${host.id} exited ${r.code ?? r.signal}${r.stderr ? `: ${r.stderr}` : ''}`;
      // Both streams, as in the local runner: the 503 may be in a result event on stdout while
      // stderr holds only the exit reason.
      const captured = `${r.output.toString('utf8')}\n${r.stderr ?? ''}`;
      return isCapacityFailure(captured) ? { ok: false, error, capacity: true } : { ok: false, error };
    }
    return agyReviewAnswer(r.output.toString('utf8'));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await host.removePath(dir, root).catch((e: Error) => console.warn(`[review] could not remove ${dir} on ${host.id}: ${e.message}`));
  }
}

/** How much of agy's stdout is kept while it runs. The answer is one JSON object; this is slack. */
const REVIEW_OUTPUT_MAX = 4 << 20;
const REVIEW_STDERR_MAX = 8 << 10;

async function runAgyReviewLocal(def: AgentDef, argv: string[], input: string): Promise<ReviewRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-review-'));
  try {
    return await new Promise<ReviewRun>((resolve) => {
      const child = spawn(AGY_COMMAND, argv, { cwd: dir, env: buildHarnessEnv(def), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let settled = false;
      const finish = (result: ReviewRun): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      // Classified from the full stderr and stdout, before the error sentence keeps only 500
      // characters of it. agy's retry lines go to its own CLI log, not these streams, but a 503 in
      // a result event or a final error does arrive here. The timeout branch below does not use
      // this: a killed run is capacity whether or not it wrote anything.
      const failed = (error: string): ReviewRun => {
        const capacity = isCapacityFailure(`${err}\n${out}`);
        return capacity ? { ok: false, error, capacity } : { ok: false, error };
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false, error: `agy did not finish within ${REVIEW_TIMEOUT_MS / 60_000} min`, capacity: true });
      }, REVIEW_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
        if (out.length > REVIEW_OUTPUT_MAX) out = out.slice(-REVIEW_OUTPUT_MAX);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        err += chunk;
        if (err.length > REVIEW_STDERR_MAX) err = err.slice(-REVIEW_STDERR_MAX);
      });
      child.on('error', (e) => finish({ ok: false, error: `agy: ${e.message}` }));
      child.on('close', (code) => {
        if (code !== 0) {
          finish(failed(`agy exited ${code ?? 'by signal'}${err.trim() ? `: ${err.trim().slice(0, 500)}` : ''}`));
          return;
        }
        finish(agyReviewAnswer(out));
      });
      // agy can exit before reading all of stdin; that is a close, not a crash.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
