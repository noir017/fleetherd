import type { Config } from '../config/schema.js';
import type { HistoryReviewChange, HistoryReviewRecord, HistoryStore, HistorySessionRow, ReviewWindow } from '../history/store.js';
import type { ReviewFacts } from './conversation.js';
import {
  buildReviewPrompt,
  parseReviewOutput,
  skillFileOfPath,
  usedSkillNames,
  writtenSkillFiles,
  type PromptSkill,
  type PromptSkillText,
  type PromptWrittenFile,
  type ReviewChange,
} from './review-prompt.js';
import { classifyReview, recordedChange, undoOf, type AppliedChange } from './review-result.js';
import { isCapacityFailure, reviewerOf, runReview, type Reviewer, type ReviewRun } from './review-run.js';
import { REVIEW_CAPACITY_MAX_ATTEMPTS, REVIEW_CAPACITY_RETRY_MS, type ReviewStateStore } from './review-state.js';
import {
  SKILL_FILE,
  activeSkillNames,
  conversationSkillFiles,
  createSkill,
  listSkills,
  patchSkill,
  readSkillFiles,
  showSkill,
  skillHistory,
  validateFilePath,
  writeSkillFile,
  type SkillChangeBy,
  type SkillSource,
} from './skills-store.js';

// The reviewer's routes moved to review-run.ts; these stay importable from here.
export {
  AGY_NO_TOOLS,
  REVIEW_TIMEOUT_MS,
  agyReviewAnswer,
  isCapacityFailure,
  reviewAgyArgs,
  reviewAgyInput,
  type Reviewer,
  type ReviewRun,
} from './review-run.js';

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
 * `review.agent` — any agent, on its own machine — or `review.api`, an OpenAI-compatible endpoint
 * (review-run.ts, which has the routes and the measurements behind each harness's switches). Every
 * route gets the whole review in one prompt and answers once; none can write: an endpoint has no
 * tools, agy runs `agy -p` with every permission class denied, and any other agent runs one session
 * of its own in an empty temporary directory, with no MCP servers, every permission request
 * refused and its tools switched off where the harness allows it. What a harness cannot switch off
 * may read outside that directory; writes and commands still need a permission nobody gives —
 * AGENTS.md invariant 8.
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

/** How much of one file the conversation wrote is quoted, and of all of them together, in characters. */
const WRITTEN_FILE_CHARS = 8_000;
const WRITTEN_CHARS = 20_000;
const MAX_WRITTEN_FILES = 20;

/**
 * How long one sweep may keep starting reviews. A pass that has already spent this long stops
 * starting new ones and leaves the rest to the next minute's tick, so a run of capacity-starved
 * batches cannot make one pass last for hours. It bounds *starting*, not the pass: the review
 * already running finishes, so a pass takes at most 40 minutes plus its last review's 30.
 */
export const REVIEW_PASS_BUDGET_MS = 40 * 60_000;

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

/** One review run (review-run.ts runReview), injected so tests never start a model. */
export type ReviewRunner = (reviewer: Reviewer, prompt: string) => Promise<ReviewRun>;

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
  /** What every agent is told (`instructions/common.md`), read per review; see PromptInput.standing. */
  standing?: () => string | undefined;
  /** What this conversation's agents searched the library for since a time and found nothing. */
  searchMisses?: (conversation: string, sinceMs: number) => string[];
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

  /** The configured reviewer: `review.api`, or `review.agent` when it names an agent this config still has. */
  private reviewer(): Reviewer | undefined {
    return reviewerOf(this.deps.config);
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

  private async runOne(candidate: ReviewCandidate, plan: Plan, reviewer: Reviewer, now: number): Promise<void> {
    let prompt: string;
    try {
      prompt = this.promptFor(plan, candidate.key);
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
    const result = await this.run(reviewer, prompt);
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
  private promptFor(plan: Plan, key: string): string {
    const dir = this.deps.skillsDir;
    // The misses since the window's first message: searches from before it were about turns this
    // review is not reading, and an earlier review already saw them.
    const since = Date.parse(plan.window.messages[0]?.at ?? '') || 0;
    const searchedFor = this.deps.searchMisses?.(key, since) ?? [];
    const active = listSkills(dir).filter((s) => s.status !== 'archived');
    const catalog = active.map((s): PromptSkill => ({ name: s.name, version: s.version, description: s.description }));
    const categories = [...new Set(active.map((s) => s.category).filter((c): c is string => !!c))].sort();
    // The calls are not in the conversation the reviewer reads (see HistoryStore.reviewWindow);
    // the ones that touched a skill are what says which skills were used and which were written.
    const calls = plan.window.skillCalls;
    const signals = [...calls.map((text) => ({ role: 'tool', text })), ...plan.window.messages];
    const used: PromptSkillText[] = [];
    for (const name of usedSkillNames(signals, new Set(activeSkillNames(dir))).slice(0, MAX_USED_SKILLS)) {
      try {
        used.push(this.usedSkill(name));
      } catch (e) {
        // Archived between the listing and the read: the catalog still names it, so a create or a
        // patch of something else is unaffected.
        this.log(`[review] could not read "${name}" for the prompt: ${e instanceof Error ? e.message : e}`);
      }
    }
    const written = this.writtenFiles(key, since, calls, used);
    return buildReviewPrompt({
      title: plan.session.title,
      messages: plan.window.messages.map((m) => ({ at: m.at, role: m.role, text: m.text })),
      dropped: plan.window.dropped,
      catalog,
      used,
      ...(written.length ? { written } : {}),
      ...(categories.length ? { categories } : {}),
      ...this.standing(),
      ...(searchedFor.length ? { searchedFor } : {}),
    });
  }

  /**
   * The skill files this conversation wrote, with what they hold now. Two sources, because there
   * are two ways to write one: the skills repository's commits that name this conversation (an
   * agent's `talkcode skills create|patch|write-file`, an earlier review of it), and the file-writing
   * tool calls whose path is under some `skills/<name>/` (an agent editing a checkout of the
   * repository, or another library). A path that names one of the gateway's skills is quoted from
   * the store; any other is named only. Quoting stops at WRITTEN_FILE_CHARS a file and
   * WRITTEN_CHARS in all, past which a file is named with the reason.
   */
  private writtenFiles(key: string, since: number, calls: string[], used: PromptSkillText[]): PromptWrittenFile[] {
    const dir = this.deps.skillsDir;
    let committed: Array<{ name: string; file: string }> = [];
    try {
      committed = conversationSkillFiles(key, since, dir);
    } catch (e) {
      // Best-effort like `standing`: without it the review only risks writing a thing twice.
      this.log(`[review] could not read what ${key} wrote to the skills: ${e instanceof Error ? e.message : e}`);
    }
    const known = new Set(activeSkillNames(dir));
    const fromCalls = writtenSkillFiles(calls).map((p) => skillFileOfPath(p, known) ?? p);
    const out: PromptWrittenFile[] = [];
    const seen = new Set<string>();
    let left = WRITTEN_CHARS;
    for (const entry of [...committed, ...fromCalls]) {
      if (typeof entry === 'string') {
        if (!seen.has(entry)) out.push({ path: entry });
        seen.add(entry);
        continue;
      }
      const path = `${entry.name}/${entry.file}`;
      if (seen.has(path)) continue;
      seen.add(path);
      if (entry.file === 'SKILL.md' && used.some((u) => u.name === entry.name)) {
        out.push({ path, note: '全文见上' });
        continue;
      }
      let content: string;
      try {
        content = showSkill(entry.name, entry.file, dir).content;
      } catch {
        out.push({ path });
        continue;
      }
      if (content.length > WRITTEN_FILE_CHARS || content.length > left) {
        out.push({ path, note: '太长，没有附上' });
        continue;
      }
      left -= content.length;
      out.push({ path, content });
    }
    return out.slice(0, MAX_WRITTEN_FILES);
  }

  /**
   * The rules every agent is already given, for the prompt's preference check. Best-effort: a review
   * without them only risks suggesting a preference the person already set, so an unreadable file
   * is logged and the review goes on.
   */
  private standing(): { standing?: string } {
    try {
      const text = this.deps.standing?.();
      return text ? { standing: text } : {};
    } catch (e) {
      this.log(`[review] could not read the standing instructions: ${e instanceof Error ? e.message : e}`);
      return {};
    }
  }

  /** One used skill in full: its `SKILL.md`, its version and the names of the files beside it. */
  private usedSkill(name: string): PromptSkillText {
    const dir = this.deps.skillsDir;
    const shown = showSkill(name, undefined, dir);
    const files = [...readSkillFiles(name, dir).keys()].filter((f) => f !== 'SKILL.md').sort();
    return { name, version: shown.version, description: '', content: shown.content, files };
  }

  private async run(reviewer: Reviewer, prompt: string): Promise<ReviewRun> {
    const runner = this.deps.run ?? runReview;
    try {
      return await runner(reviewer, prompt);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Apply what passed the store's rules. Each change stands alone: a name that is already taken, a
   * version that moved, a file outside the three directories — that change is dropped and logged,
   * and the next one is still tried.
   */
  private apply(candidate: ReviewCandidate, changes: ReviewChange[], reviewer: Reviewer): AppliedResult {
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
        out.applied.push({ change, result: applyChange(change, { source, by }, dir) });
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
    reviewer: Reviewer,
    candidate: ReviewCandidate,
    now: number
  ): number | undefined {
    try {
      const id = this.deps.history.session({
        key: `review:${candidate.key}:${now}`,
        platform: candidate.lane?.platform ?? '',
        title: `复盘：${plan.session.title || candidate.key}`,
        agent: reviewer.id,
        host: reviewer.host,
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

/** Who a review's writes are from, as the store records them. */
interface ReviewAuthor {
  source: SkillSource;
  by: SkillChangeBy;
}

/**
 * One change through the store's own functions — never a file edit (AGENTS.md invariant 8). Throws
 * the store's sentence, or this one's, when it is not applied.
 */
function applyChange(change: ReviewChange, who: ReviewAuthor, dir: string | undefined): AppliedChange {
  const { source, by } = who;
  switch (change.action) {
    case 'create':
      createSkill(
        {
          name: change.name,
          description: change.description,
          body: change.body,
          ...(change.category ? { category: change.category } : {}),
          source,
          note: change.reason,
          by,
        },
        dir
      );
      return { name: change.name, action: 'created' };
    case 'patch':
      // Not offered any more (review-prompt.ts PatchChange): retyping a whole SKILL.md is how a
      // review changes words it never meant to. Refused with the reason, not quietly applied.
      throw new Error('patch is not offered to the review; an edit replaces only the text it changes');
    case 'edit': {
      const file = change.file === SKILL_FILE ? SKILL_FILE : validateFilePath(change.file);
      const shown = showSkill(change.name, file, dir);
      if (shown.version !== change.version) {
        throw new Error(`version mismatch: "${change.name}" is at ${shown.version}, not ${change.version}`);
      }
      const content = applyEdits(shown.content, change.edits);
      if (file === SKILL_FILE) patchSkill({ name: change.name, version: change.version, content, note: change.reason, by }, dir);
      else writeSkillFile({ name: change.name, file, content, note: change.reason, by }, dir);
      const revertId = newestHistoryId(change.name, dir);
      return file === SKILL_FILE
        ? { name: change.name, action: 'patched', revertId }
        : { name: change.name, action: 'file', file, revertId };
    }
    case 'write-file': {
      // A new file only: replacing one the reviewer may never have been shown is the whole-file
      // rewrite `edit` exists to avoid.
      const file = validateFilePath(change.file);
      if (readSkillFiles(change.name, dir).has(file)) {
        throw new Error(`${file} already exists in "${change.name}"; the review changes an existing file with edit`);
      }
      writeSkillFile({ name: change.name, file, content: change.content, note: change.reason, by }, dir);
      return { name: change.name, action: 'file', file, revertId: newestHistoryId(change.name, dir) };
    }
    default: {
      const _exhaustive: never = change;
      throw new Error(`unknown change ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * `text` with each edit applied in turn. An `old` must occur exactly once in the text as it stands
 * when its turn comes, so a replacement lands where the reviewer meant it or nowhere: a miss or a
 * second match throws, naming the edit, and nothing is written.
 */
export function applyEdits(text: string, edits: ReadonlyArray<{ old: string; new: string }>): string {
  let out = text;
  edits.forEach((edit, i) => {
    out = applyEdit(out, edit, i + 1);
  });
  if (out === text) throw new Error('the edits change nothing');
  return out;
}

function applyEdit(text: string, edit: { old: string; new: string }, n: number): string {
  const at = text.indexOf(edit.old);
  if (at >= 0) {
    if (text.indexOf(edit.old, at + 1) >= 0) throw new Error(`edit ${n}: its old text occurs more than once; quote more of it`);
    return text.slice(0, at) + edit.new + text.slice(at + edit.old.length);
  }
  const loose = escapeTolerantMatch(text, edit.old, n);
  if (!loose) throw new Error(`edit ${n}: its old text is not in the file; it must be copied exactly`);
  return text.slice(0, loose.start) + carriedNew(edit, text, loose) + text.slice(loose.start + loose.map[edit.old.length]!);
}

/**
 * Where `old` occurs if a newline or tab in it may stand for the two characters `\n` / `\t` in the
 * file — exactly once, or undefined. Measured on the first real `edit` (2026-11-07, gemini 3.8
 * flash): the reviewer quoted vlt's `tr -d '\n'` without doubling the backslash in its JSON, so the
 * parsed `old` held a newline where the file has a backslash and an `n`, and a correct change to
 * the right line was refused. A JSON string cannot say which was meant; the file can. `map[i]` is
 * the offset in the match that `old[i]` begins at, `map[old.length]` the match's length.
 */
function escapeTolerantMatch(text: string, old: string, n: number): { start: number; map: number[] } | undefined {
  if (!/[\n\t]/.test(old)) return undefined;
  const source = [...old]
    .map((ch) => (ch === '\n' ? '(?:\\n|\\\\n)' : ch === '\t' ? '(?:\\t|\\\\t)' : ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')))
    .join('');
  const matches = [...text.matchAll(new RegExp(source, 'g'))];
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new Error(`edit ${n}: its old text occurs more than once; quote more of it`);
  const start = matches[0]!.index;
  const map: number[] = [];
  let j = start;
  for (let i = 0; i < old.length; i++) {
    map.push(j - start);
    j += old[i] === text[j] ? 1 : 2;
  }
  map.push(j - start);
  return { start, map };
}

/**
 * The replacement for an escape-tolerant match: what `new` shares with `old` at its start and end
 * is taken from the file as it is — the usual edit keeps the quoted line and adds one beside it —
 * and only what the reviewer actually wrote between them is its own text.
 */
function carriedNew(edit: { old: string; new: string }, text: string, m: { start: number; map: number[] }): string {
  const { old, new: next } = edit;
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p++;
  let s = 0;
  while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  const head = text.slice(m.start, m.start + m.map[p]!);
  const tail = text.slice(m.start + m.map[old.length - s]!, m.start + m.map[old.length]!);
  return head + next.slice(p, next.length - s) + tail;
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
