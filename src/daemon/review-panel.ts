import type { HistoryReviewChange, HistoryReviewRecord, HistoryReviewRow, HistorySessionRow, HistoryStore } from '../history/store.js';
import type { ReviewPanel, ReviewPanelEntry, ReviewPanelList } from '../platform/adapter.js';
import { parseReviewOutput } from './review-prompt.js';
import { inferOutcome, summaryOf, undoOf, type AppliedChange } from './review-result.js';
import type { ReviewStateStore } from './review-state.js';

/**
 * The daemon's side of the web UI's Reviews tab: `history.db`'s review sessions → the flat rows
 * the panel draws, plus today's quota.
 *
 * A review recorded since results were kept has a `reviews` row saying what was applied, what was
 * refused and why. One recorded before that table existed has only the prompt and the reviewer's
 * raw answer — those are read back with `parseReviewOutput` and marked `inferred`, because nothing
 * in the library says whether any of the proposed changes took effect. Showing them as facts would
 * be inventing the one thing the feature is for.
 *
 * The quota is `ReviewStateStore`'s own counter, read live: the panel is the place a person sees
 * that today's ten reviews are gone, so it must not be a second counter that can drift.
 */

/** How many reviews the tab carries. A review happens at most ten times a day. */
export const REVIEW_PANEL_LIMIT = 50;

export interface ReviewPanelOptions {
  history: HistoryStore;
  state: Pick<ReviewStateStore, 'countToday'>;
  /** Reviews per UTC day, from `review.ts` (REVIEW_DAILY_LIMIT). */
  limit: number;
  /** The platform instance showing the panel; a topic of another instance gets no link. */
  instance: string;
  /** Whether a reviewer is configured right now — read per call, so `/reload` shows at once. */
  enabled: () => boolean;
  /** Injected by a test; the system clock otherwise. */
  now?: () => number;
  max?: number;
}

export function buildReviewPanel(options: ReviewPanelOptions): ReviewPanel {
  const now = options.now ?? Date.now;
  return {
    list(): ReviewPanelList {
      const at = now();
      const rows = options.history.reviewSessions(options.max ?? REVIEW_PANEL_LIMIT);
      return {
        enabled: true,
        running: options.enabled(),
        reviews: rows.map((row) =>
          row.record ? recordedEntry(row.record, row.session, options.instance) : inferredEntry(row, options.history, options.instance)
        ),
        quota: {
          used: options.state.countToday(at),
          limit: options.limit,
          // The next UTC midnight: when `countToday` starts answering zero again. The page turns
          // it into the browser's own clock, which is the only one the person reading it has.
          resetsAt: Math.floor(at / 86_400_000) * 86_400_000 + 86_400_000,
        },
      };
    },
  };
}

function recordedEntry(record: HistoryReviewRecord, session: HistorySessionRow, instance: string): ReviewPanelEntry {
  return {
    id: session.key,
    title: record.reviewedTitle || stripTitle(session.title) || record.reviewedKey,
    at: Date.parse(session.startedAt) || record.at,
    outcome: record.outcome,
    summary: summaryOf(record),
    changes: record.changes.map((change) => {
      const undo = undoFor(change);
      return { ...change, ...(undo ? { undo } : {}) };
    }),
    preferences: record.preferences,
    invalid: record.invalid,
    ...(record.error ? { error: record.error } : {}),
    ...(record.platform === instance && record.thread ? { topic: record.thread } : {}),
  };
}

/**
 * One review from before results were kept. The raw answer is the only evidence, so the entry says
 * `inferred` and a change carries no `applied` at all.
 */
function inferredEntry(row: HistoryReviewRow, history: HistoryStore, instance: string): ReviewPanelEntry {
  const session = row.session;
  const key = reviewedKeyOf(session.key);
  const lane = laneOf(key, instance);
  const raw = history.reviewAnswer(session.id);
  const parsed = raw ? parseReviewOutput(raw) : undefined;
  const changes: HistoryReviewChange[] = parsed?.ok
    ? parsed.parsed.output.changes.map((change) => ({
        action: change.action,
        name: change.name,
        ...(change.action === 'write-file' ? { file: change.file } : {}),
        ...(change.reason ? { reason: change.reason } : {}),
      }))
    : [];
  const preferences = parsed?.ok ? parsed.parsed.output.preferences : [];
  const invalid = parsed?.ok ? parsed.parsed.invalid : [];
  const error =
    raw === undefined
      ? 'the review left no answer'
      : parsed && parsed.ok
        ? undefined
        : `the answer could not be read: ${parsed ? parsed.error : 'no answer'}`;
  const record: HistoryReviewRecord = {
    reviewedKey: key,
    reviewedTitle: stripTitle(session.title) || key,
    platform: lane.platform,
    ...(lane.channel ? { channel: lane.channel } : {}),
    ...(lane.thread ? { thread: lane.thread } : {}),
    outcome: error ? 'failed' : inferOutcome(changes, preferences, invalid),
    changes,
    preferences,
    invalid,
    ...(error ? { error } : {}),
    at: Date.parse(session.startedAt) || 0,
  };
  const entry = recordedEntry(record, session, instance);
  return { ...entry, inferred: true };
}

/** `复盘：<title>` → `<title>`. An untitled review is titled with the conversation key instead. */
function stripTitle(title: string): string {
  return title.replace(/^复盘：/, '');
}

/**
 * The reviewed conversation key, out of `review:<key>:<epoch ms>`. The suffix is stripped rather
 * than split on every colon: a channel id may contain one (`telegram#chat:1`), and only the last
 * `:<digits>` is the timestamp.
 */
function reviewedKeyOf(sessionKey: string): string {
  return sessionKey.replace(/^review:/, '').replace(/:\d+$/, '');
}

/**
 * The lane a conversation key names, for a link back to the topic. Only this instance's own keys
 * are read: a key from another platform has a different shape, and a wrong topic id would point the
 * page at a conversation it does not have.
 */
function laneOf(key: string, instance: string): { platform: string; channel?: string; thread?: string } {
  const parts = key.split('#');
  const platform = parts[0] ?? '';
  if (platform !== instance) return { platform };
  const channel = parts[1];
  const thread = parts[2];
  return { platform, ...(channel ? { channel } : {}), ...(thread ? { thread } : {}) };
}

function undoFor(change: HistoryReviewChange): string | undefined {
  if (change.applied !== true) return undefined;
  const applied: AppliedChange = {
    name: change.name,
    action: change.action === 'create' ? 'created' : change.action === 'patch' ? 'patched' : 'file',
    ...(change.file ? { file: change.file } : {}),
    ...(change.revertId ? { revertId: change.revertId } : {}),
  };
  return undoOf(applied);
}
