import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDef, Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import type { HistoryReviewChange, HistoryReviewRecord, HistoryStore, HistorySessionRow, ReviewWindow } from '../history/store.js';
import { buildHarnessEnv, remoteAgentEnv } from './agent-common.js';
import { AGY_COMMAND } from './agent-agy.js';
import type { ReviewFacts } from './conversation.js';
import { remoteHosts } from './remote-hosts.js';
import { buildReviewPrompt, parseReviewOutput, usedSkillNames, type PromptSkill, type PromptSkillText, type ReviewChange } from './review-prompt.js';
import { classifyReview, recordedChange, undoOf, type AppliedChange } from './review-result.js';
import type { ReviewStateStore } from './review-state.js';
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
 * One review at a time and at most REVIEW_DAILY_LIMIT a day, so a bug that keeps finding
 * candidates cannot spend the reviewer's quota. A failed review backs off for six hours.
 */

/** A conversation has to be quiet this long before a review — the reclaim deadline's own hour. */
export const REVIEW_IDLE_MS = 3_600_000;

/** How often the sweep looks. The same coarse minute as the idle sweeper, for the same reason. */
export const REVIEW_SWEEP_MS = 60_000;

/** Reviews per UTC day. One review is one `agy` call; ten leaves room for a busy day. */
export const REVIEW_DAILY_LIMIT = 10;

/** How many of the person's messages make a conversation worth reviewing. */
export const REVIEW_MIN_USER_MESSAGES = 3;

/** How much of the conversation the prompt carries, in characters. */
export const REVIEW_CONVERSATION_CHARS = 40_000;

/** How many used skills are quoted in full. The rest stay in the catalog. */
const MAX_USED_SKILLS = 8;

/** One review's wall clock. A review reads, thinks and prints one JSON object. */
export const REVIEW_TIMEOUT_MS = 5 * 60_000;

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

export type ReviewRun = { ok: true; output: string } | { ok: false; error: string };

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
      const now = this.deps.clock.now();
      const reclaimOff = !(this.deps.config.session.idleTimeoutMs > 0);
      const candidates = this.deps
        .candidates()
        .filter((c) => eligible(c, reclaimOff))
        // Freshest first. On the first start with this feature every conversation has no
        // watermark and so looks reviewable; taking the ones that just went quiet is useful, while
        // replaying months of history is not. The daily cap bounds both.
        .sort((a, b) => a.idleMs - b.idleMs);
      for (const candidate of candidates) {
        const current = this.reviewer();
        if (!current || this.stopped) break;
        // One conversation's broken row must not end the pass: the next candidate may be fine.
        try {
          const plan = this.plan(candidate, now);
          if (!plan) continue;
          if (!this.deps.state.takeSlot(REVIEW_DAILY_LIMIT, now)) {
            this.log(`[review] ${REVIEW_DAILY_LIMIT} reviews already ran today; the rest wait for tomorrow`);
            break;
          }
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
   * off, and the person has said enough since the last review.
   */
  private plan(candidate: ReviewCandidate, now: number): Plan | undefined {
    const session = this.deps.history.sessionOf(candidate.key);
    if (!session || EXCLUDED_KINDS.has(session.kind)) return undefined;
    if (!this.deps.state.ready(candidate.key, now)) return undefined;
    const mark = this.deps.state.markOf(candidate.key);
    const window = this.deps.history.reviewWindow(candidate.key, mark?.messageId ?? 0, REVIEW_CONVERSATION_CHARS);
    if (!window || window.messages.length === 0) return undefined;
    if (window.userMessages < REVIEW_MIN_USER_MESSAGES) return undefined;
    return { session, window };
  }

  private async runOne(candidate: ReviewCandidate, plan: Plan, reviewer: AgentDef, now: number): Promise<void> {
    const prompt = this.promptFor(plan);
    const model = this.deps.config.review?.model ?? reviewer.model;
    const result = await this.run(reviewer, model, prompt);
    if (!result.ok) {
      this.deps.state.failed(candidate.key, result.error, now);
      this.log(`[review] ${candidate.key}: ${result.error}`);
      // A failed attempt is a review too. Until this row existed the reason a quiet conversation
      // was never reviewed lived only in the log, which is not where a person looks; the Reviews
      // tab is. The session has no answer to file, only the prompt and the failure.
      const failedId = this.record(plan, prompt, '', reviewer, candidate, now);
      this.writeResult(failedId, plan, candidate, now, {
        outcome: 'failed',
        changes: [],
        preferences: [],
        invalid: [],
        error: result.error,
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
    const outcome = this.apply(candidate, parsed.parsed.output.changes, reviewer);
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
      // this — `origin` is what tells them apart in `.usage.json`.
      origin: 'review' as const,
    };
    for (const change of changes) {
      try {
        if (change.action === 'create') {
          createSkill({ name: change.name, description: change.description, body: change.body, source, note: change.reason }, dir);
          out.applied.push({ change, result: { name: change.name, action: 'created' } });
        } else if (change.action === 'patch') {
          patchSkill({ name: change.name, version: change.version, content: change.content, note: change.reason }, dir);
          out.applied.push({
            change,
            result: { name: change.name, action: 'patched', revertId: newestHistoryId(change.name, dir) },
          });
        } else {
          writeSkillFile({ name: change.name, file: change.file, content: change.content, note: change.reason }, dir);
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
   * session then holds the prompt alone.
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
      this.deps.history.message(id, { ts: now, role: 'user', kind: 'review', text: prompt });
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
    if (r.timedOut) return { ok: false, error: `agy on ${host.id} timed out after ${REVIEW_TIMEOUT_MS / 60_000} min` };
    if (r.code !== 0) return { ok: false, error: `agy on ${host.id} exited ${r.code ?? r.signal}${r.stderr ? `: ${r.stderr}` : ''}` };
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
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false, error: `agy did not finish within ${REVIEW_TIMEOUT_MS / 60_000} min` });
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
          finish({ ok: false, error: `agy exited ${code ?? 'by signal'}${err.trim() ? `: ${err.trim().slice(0, 500)}` : ''}` });
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
