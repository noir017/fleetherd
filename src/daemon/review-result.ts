import type { HistoryReviewChange, HistoryReviewOutcome, HistoryReviewRecord } from '../history/store.js';
import type { ReviewChange } from './review-prompt.js';

/**
 * The vocabulary shared by the review that records a result and the panel that draws one.
 *
 * Kept out of `review.ts` because the panel must not import the service: it reads what the service
 * wrote, and the same classification has to answer for a review recorded live and for one inferred
 * from a raw answer. The sentences live here for the same reason the schedule panel's do
 * (`daemon/schedule-panel.ts`) — one wording, not a copy in the browser.
 */

/** A change the store applied, as the notice line and the result record both need it. */
export interface AppliedChange {
  name: string;
  action: 'created' | 'patched' | 'file';
  file?: string;
  /** The history entry a `revert` names, when there is something to go back to. */
  revertId?: string;
}

/** The command that undoes one applied change, or nothing when it cannot be undone by name. */
export function undoOf(change: AppliedChange): string | undefined {
  if (change.action === 'created') return `talkcode skills archive ${change.name}`;
  return change.revertId ? `talkcode skills revert ${change.name} ${change.revertId}` : undefined;
}

/**
 * What one recorded review produced.
 *
 * A change the store refused counts as `refused` even when the reviewer also noticed preferences:
 * "it tried to change something and was not allowed" is the fact a person needs, and the
 * preferences are still in the detail. `changed` needs at least one change that actually landed —
 * a proposed-but-refused change is not a change.
 */
export function classifyReview(input: {
  changes: HistoryReviewChange[];
  preferences: string[];
  invalid: string[];
  error?: string;
}): HistoryReviewOutcome {
  if (input.error) return 'failed';
  if (input.changes.some((c) => c.applied === true)) return 'changed';
  if (input.changes.length > 0 || input.invalid.length > 0) return 'refused';
  if (input.preferences.length > 0) return 'preferences';
  return 'nothing';
}

/**
 * The same classification for a review recorded before results were kept.
 *
 * Nothing in the raw answer says whether a change was applied, so a review that proposed one is
 * `proposed` rather than `changed` or `refused`: the panel marks it inferred, and the detail says
 * what the library does not know.
 */
export function inferOutcome(changes: HistoryReviewChange[], preferences: string[], invalid: string[]): HistoryReviewOutcome {
  if (changes.length > 0 || invalid.length > 0) return 'proposed';
  if (preferences.length > 0) return 'preferences';
  return 'nothing';
}

/** One change as the result record keeps it, with what became of it. */
export function recordedChange(
  change: ReviewChange,
  outcome: { applied: AppliedChange } | { refused: string }
): HistoryReviewChange {
  const base: HistoryReviewChange = {
    action: change.action,
    name: change.name,
    ...(change.action === 'write-file' ? { file: change.file } : {}),
    ...(change.reason ? { reason: change.reason } : {}),
  };
  if ('applied' in outcome) {
    return { ...base, applied: true, ...(outcome.applied.revertId ? { revertId: outcome.applied.revertId } : {}) };
  }
  return { ...base, applied: false, error: outcome.refused };
}

/** The row's one line: what happened, short enough to scan. */
export function summaryOf(record: HistoryReviewRecord): string {
  switch (record.outcome) {
    case 'failed':
      return record.error?.trim() || 'the review failed';
    case 'changed':
      return changedSummary(record);
    case 'refused': {
      const n = record.changes.length + record.invalid.length;
      return `${n} change${n === 1 ? '' : 's'} refused`;
    }
    case 'proposed': {
      const n = record.changes.length + record.invalid.length;
      return `${n} change${n === 1 ? '' : 's'} proposed`;
    }
    case 'preferences': {
      const n = record.preferences.length;
      return `${n} preference${n === 1 ? '' : 's'}`;
    }
    case 'nothing':
      return 'nothing found';
    default: {
      const _exhaustive: never = record.outcome;
      return _exhaustive;
    }
  }
}

function changedSummary(record: HistoryReviewRecord): string {
  const applied = record.changes.filter((c) => c.applied === true);
  const refused = record.changes.filter((c) => c.applied === false).length + record.invalid.length;
  const head =
    applied.length === 1 && applied[0]
      ? oneChange(applied[0])
      : `${applied.length} changes · ${nameList(applied)}`;
  const parts = [head];
  // A refused change beside an applied one is not visible anywhere else in the row, and "it tried
  // three things and one was not allowed" is what a person needs to know before trusting the rest.
  if (refused) parts.push(`${refused} refused`);
  if (record.preferences.length) {
    parts.push(`${record.preferences.length} preference${record.preferences.length === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

function oneChange(change: HistoryReviewChange): string {
  if (change.action === 'create') return `created ${change.name}`;
  if (change.action === 'patch') return `updated ${change.name}`;
  return `wrote ${change.file ?? 'a file'} in ${change.name}`;
}

function nameList(changes: HistoryReviewChange[]): string {
  const names = [...new Set(changes.map((c) => c.name))];
  const shown = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}
