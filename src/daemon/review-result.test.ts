import { describe, expect, it } from 'vitest';
import type { HistoryReviewRecord } from '../history/store.js';
import { classifyReview, inferOutcome, summaryOf, undoOf } from './review-result.js';

/** The classification the writer and the panel must agree on, without a database in the way. */

const base = {
  reviewedKey: 'web#main#abcdef12',
  reviewedTitle: '部署',
  platform: 'web',
  changes: [],
  preferences: [],
  invalid: [],
  at: 0,
};

function record(over: Partial<HistoryReviewRecord>): HistoryReviewRecord {
  return { ...base, outcome: 'nothing', ...over };
}

describe('classifyReview', () => {
  it('calls a run that failed failed, whatever else the answer carried', () => {
    expect(classifyReview({ changes: [], preferences: ['x'], invalid: [], error: 'agy exited 1' })).toBe('failed');
  });

  it('needs one change that actually landed for "changed"', () => {
    expect(
      classifyReview({ changes: [{ action: 'create', name: 'a', applied: true }], preferences: [], invalid: [] })
    ).toBe('changed');
    expect(
      classifyReview({ changes: [{ action: 'create', name: 'a', applied: false }], preferences: [], invalid: [] })
    ).toBe('refused');
  });

  it('calls a change the shape check rejected refused, not nothing', () => {
    expect(classifyReview({ changes: [], preferences: [], invalid: ['change #1: name is required'] })).toBe('refused');
  });

  it('distinguishes preferences from nothing', () => {
    expect(classifyReview({ changes: [], preferences: ['先给结论'], invalid: [] })).toBe('preferences');
    expect(classifyReview({ changes: [], preferences: [], invalid: [] })).toBe('nothing');
  });

  it('never calls an inferred answer changed', () => {
    expect(inferOutcome([{ action: 'patch', name: 'a' }], [], [])).toBe('proposed');
    expect(inferOutcome([], ['先给结论'], [])).toBe('preferences');
    expect(inferOutcome([], [], [])).toBe('nothing');
  });
});

describe('summaryOf', () => {
  it('names a lone change by what it did to which skill', () => {
    expect(summaryOf(record({ outcome: 'changed', changes: [{ action: 'create', name: 'a', applied: true }] }))).toBe(
      'created a'
    );
    expect(summaryOf(record({ outcome: 'changed', changes: [{ action: 'patch', name: 'b', applied: true }] }))).toBe(
      'updated b'
    );
    expect(
      summaryOf(record({ outcome: 'changed', changes: [{ action: 'write-file', name: 'c', file: 'references/x.md', applied: true }] }))
    ).toBe('wrote references/x.md in c');
  });

  it('counts a mixed answer: applied, refused, preferences', () => {
    expect(
      summaryOf(
        record({
          outcome: 'changed',
          changes: [
            { action: 'patch', name: 'a', applied: true },
            { action: 'patch', name: 'b', applied: false, error: 'version mismatch' },
          ],
          preferences: ['先给结论'],
        })
      )
    ).toBe('updated a · 1 refused · 1 preference');
  });

  it('sums up the other outcomes', () => {
    expect(summaryOf(record({ outcome: 'refused', changes: [{ action: 'create', name: 'a', applied: false }] }))).toBe(
      '1 change refused'
    );
    expect(summaryOf(record({ outcome: 'proposed', changes: [{ action: 'create', name: 'a' }] }))).toBe(
      '1 change proposed'
    );
    expect(summaryOf(record({ outcome: 'preferences', preferences: ['x', 'y'] }))).toBe('2 preferences');
    expect(summaryOf(record({ outcome: 'nothing' }))).toBe('nothing found');
    expect(summaryOf(record({ outcome: 'failed', error: 'agy exited 1' }))).toBe('agy exited 1');
  });
});

describe('undoOf', () => {
  it('archives a create and reverts a patch or a file write', () => {
    expect(undoOf({ name: 'a', action: 'created' })).toBe('talkcode skills archive a');
    expect(undoOf({ name: 'b', action: 'patched', revertId: '0001-abc' })).toBe('talkcode skills revert b 0001-abc');
    expect(undoOf({ name: 'c', action: 'file', file: 'references/x.md', revertId: '0002-def' })).toBe(
      'talkcode skills revert c 0002-def'
    );
  });

  it('says nothing when there is nothing to go back to', () => {
    expect(undoOf({ name: 'b', action: 'patched' })).toBeUndefined();
  });
});
