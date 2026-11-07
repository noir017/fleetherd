import type { HistoryReviewChange, HistoryReviewRecord, HistoryReviewRow, HistorySessionRow, HistoryStore } from '../history/store.js';
import type { ReviewPanel, ReviewPanelEntry, ReviewPanelList, ReviewPanelPreference } from '../platform/adapter.js';
import { parseReviewOutput } from './review-prompt.js';
import { inferOutcome, recordedAction, summaryOf, undoOf, type AppliedChange } from './review-result.js';
import { preferenceKey } from './review-state.js';

/**
 * The daemon's side of the web UI's Reviews tab: `history.db`'s review sessions → the flat rows
 * the panel draws.
 *
 * A review recorded since results were kept has a `reviews` row saying what was applied, what was
 * refused and why. One recorded before that table existed has only the prompt and the reviewer's
 * raw answer — those are read back with `parseReviewOutput` and marked `inferred`, because nothing
 * in the library says whether any of the proposed changes took effect. Showing them as facts would
 * be inventing the one thing the feature is for.
 *
 * There is no quota: the sweep has no daily cap, so a "used up" line would describe a limit that
 * does not exist.
 */

/** How many reviews the tab carries. Reviews are slow; this is a screenful of history. */
export const REVIEW_PANEL_LIMIT = 50;

/**
 * How many reviews the pending list is gathered from — more than the tab shows, because a
 * suggestion nobody has dealt with yet is still pending after its review scrolls off. The store
 * reads at most 200.
 */
export const PENDING_SCAN = 200;

/** How many suggestions the pending list carries. */
export const PENDING_LIMIT = 50;

export interface ReviewPanelOptions {
  history: HistoryStore;
  /** The platform instance showing the panel; a topic of another instance gets no link. */
  instance: string;
  /** Whether a reviewer is configured right now — read per call, so `/reload` shows at once. */
  enabled: () => boolean;
  /** The suggestions already dismissed, by preferenceKey (ReviewStateStore). */
  dismissed: () => ReadonlySet<string>;
  /** Dismiss one suggestion (ReviewStateStore.dismissPreference). */
  dismiss: (text: string) => void;
  max?: number;
}

export function buildReviewPanel(options: ReviewPanelOptions): ReviewPanel {
  const list = (): ReviewPanelList => {
    const rows = options.history.reviewSessions(Math.max(options.max ?? REVIEW_PANEL_LIMIT, PENDING_SCAN));
    const entries = rows.map((row) =>
      row.record ? recordedEntry(row.record, row.session, options.instance) : inferredEntry(row, options.history, options.instance)
    );
    return {
      enabled: true,
      running: options.enabled(),
      reviews: entries.slice(0, options.max ?? REVIEW_PANEL_LIMIT),
      pending: pendingPreferences(entries, options.dismissed()),
    };
  };
  return {
    list,
    dismiss(text: string): ReviewPanelList {
      options.dismiss(text);
      return list();
    },
  };
}

/**
 * The suggestions no one has dealt with: every review's preferences, newest first, one entry per
 * wording (preferenceKey), less the dismissed ones.
 *
 * Why a list at all: a suggestion used to live only inside the review that made it, so the same
 * rule suggested by three reviews was three rows to open, and one already in the person's
 * instructions looked as new as one that was not. On 2026-11-06 the thirteen suggestions so far
 * included two the instructions already carried; the reviewer is now shown those instructions, and
 * what still gets through is dismissed here.
 */
export function pendingPreferences(entries: ReviewPanelEntry[], dismissed: ReadonlySet<string>): ReviewPanelPreference[] {
  const byKey = new Map<string, ReviewPanelPreference>();
  for (const entry of entries) {
    for (const text of entry.preferences) {
      const key = preferenceKey(text);
      if (!key || dismissed.has(key)) continue;
      const seen = byKey.get(key);
      const from = { title: entry.title, ...(entry.topic ? { topic: entry.topic } : {}) };
      if (!seen) {
        byKey.set(key, { text: text.trim(), count: 1, at: entry.at, from: [from] });
        continue;
      }
      seen.count += 1;
      seen.at = Math.max(seen.at, entry.at);
      if (seen.from.length < 3 && !seen.from.some((f) => f.title === from.title)) seen.from.push(from);
    }
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, PENDING_LIMIT);
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
        ...recordedAction(change),
        name: change.name,
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
