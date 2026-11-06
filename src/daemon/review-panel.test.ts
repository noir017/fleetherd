import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../history/store.js';
import { buildReviewPanel } from './review-panel.js';
import { ReviewStateStore } from './review-state.js';

/**
 * The Reviews tab's data, built from a real `history.db` in a temp dir: the point of the module is
 * the difference between a review that recorded its result and one that only left a raw answer, and
 * faking the query would test the fake.
 */

let dir: string;
let history: HistoryStore;
const now = Date.UTC(2026, 10, 5, 12, 34);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-review-panel-'));
  history = new HistoryStore(path.join(dir, 'history.db'), () => {});
});

afterEach(() => {
  history.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function panel(over: { running?: boolean; instance?: string; state?: ReviewStateStore } = {}) {
  const state = over.state ?? new ReviewStateStore(path.join(dir, 'reviews.json'), () => {});
  return buildReviewPanel({
    history,
    instance: over.instance ?? 'web',
    enabled: () => over.running ?? true,
    dismissed: () => state.dismissedPreferences(),
    dismiss: (text) => state.dismissPreference(text),
  });
}

function reviewSession(key: string, title: string, at = now, answer?: string): number {
  const id = history.session({ key, platform: 'web', title, kind: 'review', at })!;
  history.message(id, { ts: at, role: 'user', kind: 'review', text: '读下面的对话记录' });
  if (answer !== undefined) history.message(id, { ts: at, role: 'agent', kind: 'review', text: answer });
  return id;
}

describe('buildReviewPanel', () => {
  it('draws a recorded review: outcome, changes, undo commands, preferences and the topic', () => {
    const id = reviewSession('review:web#main#abcdef12:1', '复盘：跨会话查询');
    history.recordReview(id, {
      reviewedKey: 'web#main#abcdef12',
      reviewedTitle: '跨会话查询',
      platform: 'web',
      channel: 'main',
      thread: 'abcdef12',
      outcome: 'changed',
      changes: [
        { action: 'patch', name: 'deploy-check', reason: '两次漏了测试', applied: true, revertId: '0001-abc' },
        { action: 'write-file', name: 'ci-logs', file: 'references/grep.md', applied: false, error: 'files may only go in references/' },
      ],
      preferences: ['回答先给结论'],
      invalid: ['change #3: name is required'],
      at: now,
    });

    const [entry] = panel().list().reviews;
    expect(entry).toMatchObject({
      title: '跨会话查询',
      at: now,
      outcome: 'changed',
      summary: 'updated deploy-check · 2 refused · 1 preference',
      topic: 'abcdef12',
      preferences: ['回答先给结论'],
      invalid: ['change #3: name is required'],
    });
    expect(entry!.inferred).toBeUndefined();
    expect(entry!.changes[0]).toMatchObject({
      action: 'patch',
      name: 'deploy-check',
      applied: true,
      undo: 'talkcode skills revert deploy-check 0001-abc',
    });
    // A refused change has no undo command: there is nothing to undo.
    expect(entry!.changes[1]).toMatchObject({ applied: false, error: 'files may only go in references/' });
    expect(entry!.changes[1]!.undo).toBeUndefined();
  });

  it('gives a create its archive command and names a lone change', () => {
    const id = reviewSession('review:web#main#abcdef12:1', '复盘：部署');
    history.recordReview(id, {
      reviewedKey: 'web#main#abcdef12',
      reviewedTitle: '部署',
      platform: 'web',
      channel: 'main',
      thread: 'abcdef12',
      outcome: 'changed',
      changes: [{ action: 'create', name: 'deploy-check', applied: true }],
      preferences: [],
      invalid: [],
      at: now,
    });
    const [entry] = panel().list().reviews;
    expect(entry!.summary).toBe('created deploy-check');
    expect(entry!.changes[0]!.undo).toBe('talkcode skills archive deploy-check');
  });

  it('offers no topic link for a review of another platform', () => {
    const id = reviewSession('review:telegram#chat#1:1', '复盘：部署');
    history.recordReview(id, {
      reviewedKey: 'telegram#chat#1',
      reviewedTitle: '部署',
      platform: 'telegram',
      channel: 'chat',
      thread: '1',
      outcome: 'nothing',
      changes: [],
      preferences: [],
      invalid: [],
      at: now,
    });
    expect(panel().list().reviews[0]!.topic).toBeUndefined();
  });

  it('infers an old review from its raw answer, and says so', () => {
    reviewSession(
      'review:web#main#abcdef12:1',
      '复盘：跨会话查询',
      now,
      JSON.stringify({
        changes: [{ action: 'patch', name: 'deploy-check', version: 'v1', content: 'x', reason: '补一条' }],
        preferences: ['先给结论'],
      })
    );

    const [entry] = panel().list().reviews;
    expect(entry).toMatchObject({
      title: '跨会话查询',
      outcome: 'proposed',
      summary: '1 change proposed',
      topic: 'abcdef12',
      inferred: true,
      preferences: ['先给结论'],
    });
    // Nothing in the raw answer says whether it was applied, so the panel does not pretend.
    expect(entry!.changes[0]).toMatchObject({ action: 'patch', name: 'deploy-check', reason: '补一条' });
    expect(entry!.changes[0]!.applied).toBeUndefined();
    expect(entry!.changes[0]!.undo).toBeUndefined();
  });

  it('infers a quiet old review as preferences or nothing, and a broken one as failed', () => {
    reviewSession('review:web#main#abcdef12:1', '复盘：甲', now, '{"changes":[],"preferences":["别用表情"]}');
    reviewSession('review:web#main#abcdef12:2', '复盘：乙', now - 1_000, '{"changes":[],"preferences":[]}');
    reviewSession('review:web#main#abcdef12:3', '复盘：丙', now - 2_000, '我觉得没什么可改的');
    const rows = panel().list().reviews;
    expect(rows.map((r) => r.outcome)).toEqual(['preferences', 'nothing', 'failed']);
    expect(rows[2]!.error).toContain('could not be read');
    expect(rows.every((r) => r.inferred === true)).toBe(true);
  });

  it('reads the reviewed key out of the session key without tripping on a colon in a channel', () => {
    reviewSession('review:web#main#abcdef12:1720000000000', '复盘：部署', now, '{"changes":[]}');
    expect(panel().list().reviews[0]!.topic).toBe('abcdef12');
  });

  it('reports no quota: the sweep has no daily limit', () => {
    reviewSession('review:web#main#abcdef12:1', '复盘：部署', now, '{"changes":[]}');
    const list = panel().list();
    expect(list).not.toHaveProperty('quota');
  });

  it('says whether a reviewer is configured right now', () => {
    expect(panel({ running: false }).list().running).toBe(false);
    expect(panel({ running: true }).list().running).toBe(true);
  });

  it('answers an empty list, not an error, when nothing has been reviewed', () => {
    const list = panel().list();
    expect(list).toMatchObject({ enabled: true, reviews: [], pending: [] });
  });
});

describe('the pending preference list', () => {
  /** A recorded review of `title` that suggested `preferences`, `minutes` after `now`. */
  function suggested(n: number, title: string, preferences: string[], thread = `t${n}`): void {
    const at = now + n * 60_000;
    const id = reviewSession(`review:web#main#${thread}:${at}`, `复盘：${title}`, at);
    history.recordReview(id, {
      reviewedKey: `web#main#${thread}`,
      reviewedTitle: title,
      platform: 'web',
      channel: 'main',
      thread,
      outcome: 'preferences',
      changes: [],
      preferences,
      invalid: [],
      at,
    });
  }

  it('merges one wording across reviews, newest first, with where it came from', () => {
    suggested(1, '部署', ['回答先给结论。']);
    suggested(2, '查日志', ['删除凭据默认移入垃圾箱', '回答先给结论']);
    suggested(3, '再部署', ['回答  先给结论'], 't1');
    const pending = panel().list().pending;
    expect(pending.map((p) => [p.text, p.count])).toEqual([
      ['回答  先给结论', 3],
      ['删除凭据默认移入垃圾箱', 1],
    ]);
    expect(pending[0]!.from).toEqual([
      { title: '再部署', topic: 't1' },
      { title: '查日志', topic: 't2' },
      { title: '部署', topic: 't1' },
    ]);
  });

  it('drops a dismissed suggestion for good, whatever review suggests it again', () => {
    const state = new ReviewStateStore(path.join(dir, 'reviews.json'), () => {});
    suggested(1, '部署', ['回答先给结论', '代码只推送到自建 Gitea']);
    const after = panel({ state }).dismiss('代码只推送到自建 Gitea。');
    expect(after.pending.map((p) => p.text)).toEqual(['回答先给结论']);
    suggested(2, '又一次', ['代码只推送到自建 Gitea']);
    // A new store over the same file: the dismissal is on disk, not in this process.
    const fresh = new ReviewStateStore(path.join(dir, 'reviews.json'), () => {});
    expect(panel({ state: fresh }).list().pending.map((p) => p.text)).toEqual(['回答先给结论']);
    // Reviews are untouched by it.
    expect(panel({ state: fresh }).list().reviews).toHaveLength(2);
  });
});
