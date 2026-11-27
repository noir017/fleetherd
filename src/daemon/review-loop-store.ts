import fs from 'node:fs';
import path from 'node:path';
import type { ConversationAddress } from '../core/conversation.js';
import type { TaskVerdict } from '../ipc/protocol.js';
import type { ConversationId } from '../types.js';

/** `task-new --review-by`: who reviews the work, what it is told, and how often it may send it back. */
export interface ReviewPlan {
  agent: string;
  text: string;
  rounds: number;
}

/**
 * One review loop (see `delegation.ts`), keyed by the work's topic. Kept after it ends, so `tasks`
 * and the card can still say how it ended. Persisted in `<configDir>/review-loops.json`.
 */
export interface ReviewLoop {
  work: ConversationId;
  /** The work's topic id, as `tasks` prints it. */
  workTopic: string;
  plan: ReviewPlan;
  /** Times the review has sent the work back so far. */
  sentBack: number;
  /**
   * The commit already reviewed — at first the one the work started from. Undefined until it is
   * read, and for good when it cannot be: the first commit range is then just the commit reviewed.
   */
  reviewed?: string;
  /** The commit handed to the review now running. */
  pending?: string;
  /** The reviewer's topic, once the first review opened it. */
  review?: { key: ConversationId; address: ConversationAddress; topic: string };
  /**
   * Whose turn end the loop is waiting for: the work's (`work`; `finish` after a `nits`, which ends
   * the loop whatever it committed) or the reviewer's (`review`). Any other end is ordinary news.
   */
  phase: 'work' | 'review' | 'finish';
  /** What the reviewer answered with `task-verdict` in the turn now running; read once, at its end. */
  verdict?: TaskVerdict;
  /** How it ended, once it has — the line `tasks` and the card show. */
  outcome?: { passed: boolean; line: string };
  /** Why the last end did not move it on (no commit, no reply): said on the next card, then dropped. */
  note?: string;
}

interface ReviewLoopsFile {
  version: 1;
  loops: ReviewLoop[];
}

const VERSION = 1;

export class ReviewLoopStore {
  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = (l) => console.warn(l)
  ) {}

  load(): ReviewLoop[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { version?: unknown; loops?: unknown };
      if (!Array.isArray(parsed.loops)) {
        this.log(`[delegation] ${this.file} has no loops list; starting empty`);
        return [];
      }
      return parsed.loops.filter(isReviewLoop);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`[delegation] could not read ${this.file}: ${e instanceof Error ? e.message : e}`);
      }
      return [];
    }
  }

  save(loops: Iterable<ReviewLoop>): void {
    const data: ReviewLoopsFile = { version: VERSION, loops: [...loops] };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`[delegation] could not write ${this.file}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

function isAddress(v: unknown): v is ConversationAddress {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return typeof a.channel === 'string' && (a.thread === undefined || typeof a.thread === 'string');
}

function isReviewPlan(v: unknown): v is ReviewPlan {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.agent === 'string' && typeof p.text === 'string' && typeof p.rounds === 'number';
}

function isVerdict(v: unknown): v is TaskVerdict {
  return v === 'pass' || v === 'nits' || v === 'changes';
}

function isReviewTarget(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== 'object' || v === null) return false;
  const rev = v as Record<string, unknown>;
  return typeof rev.key === 'string' && typeof rev.topic === 'string' && isAddress(rev.address);
}

function isLoopOutcome(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== 'object' || v === null) return false;
  const out = v as Record<string, unknown>;
  return typeof out.passed === 'boolean' && typeof out.line === 'string';
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string';
}

function isReviewLoop(v: unknown): v is ReviewLoop {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.work === 'string' &&
    typeof r.workTopic === 'string' &&
    isReviewPlan(r.plan) &&
    typeof r.sentBack === 'number' &&
    (r.phase === 'work' || r.phase === 'review' || r.phase === 'finish') &&
    isOptionalString(r.reviewed) &&
    isOptionalString(r.pending) &&
    (r.verdict === undefined || isVerdict(r.verdict)) &&
    isOptionalString(r.note) &&
    isReviewTarget(r.review) &&
    isLoopOutcome(r.outcome)
  );
}
