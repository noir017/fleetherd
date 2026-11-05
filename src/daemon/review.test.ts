import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config/schema.js';
import { HistoryStore } from '../history/store.js';
import {
  ReviewService,
  agyReviewAnswer,
  eligible,
  noticeLine,
  reviewAgyArgs,
  reviewAgyInput,
  reviewCandidatesFrom,
  type ReviewCandidate,
  type ReviewRunner,
} from './review.js';
import { ReviewStateStore } from './review-state.js';
import { buildReviewPrompt, parseReviewOutput, usedSkillNames } from './review-prompt.js';
import { createSkill, listSkills, readSkillFiles, showSkill } from './skills-store.js';

/**
 * The review service, driven with a controlled clock and an injected runner — no model is ever
 * started here. The history is a real `history.db` in a temp dir, because the trigger is a query
 * ("three things since the watermark, in a conversation that is not scheduled or a sub-agent's")
 * and faking the query would test the fake.
 */

let dir: string;
let history: HistoryStore;
let now: number;
const clock = { now: () => now, schedule: () => () => {} };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-review-'));
  history = new HistoryStore(path.join(dir, 'history.db'), () => {});
  now = Date.UTC(2026, 10, 4, 12, 0);
});

afterEach(() => {
  history.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({
    platforms: { telegram: { type: 'telegram', token: 'x' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'ag', harness: 'agy', host: 'uniagent', model: 'gemini-3.8-flash-high' },
    ],
    hosts: { uniagent: { ssh: 'me@10.0.0.5:22' } },
    routing: { default: 'cc' },
    review: { agent: 'ag' },
    ...overrides,
  });
}

/** One conversation with `users` messages from the person and a reply after each. */
function seed(
  key: string,
  users: number,
  kind: 'normal' | 'schedule' | 'subagent' | 'review' = 'normal',
  at = now - 2 * 3_600_000
): number {
  const id = history.session({ key, platform: 'telegram', title: key, kind, at })!;
  for (let i = 0; i < users; i++) {
    history.message(id, { ts: at + i * 1_000, role: 'user', kind, text: `第 ${i + 1} 句` });
    history.message(id, { ts: at + i * 1_000 + 1, role: 'agent', kind, text: `回答 ${i + 1}` });
  }
  return id;
}

function candidate(over: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    key: 'telegram:chat:1',
    lane: { platform: 'telegram', channel: 'chat' },
    idleMs: 2 * 3_600_000,
    busyTurn: false,
    pendingWork: false,
    stopped: true,
    unresumable: false,
    ...over,
  };
}

interface Harness {
  service: ReviewService;
  notifications: Array<{ platform: string; channel: string; text: string }>;
  logs: string[];
  calls: Array<{ agent: string; model: string | undefined; prompt: string }>;
}

function harness(opts: { candidates?: ReviewCandidate[]; output?: string | (() => Promise<string>); run?: ReviewRunner; cfg?: Config } = {}): Harness {
  const notifications: Harness['notifications'] = [];
  const logs: string[] = [];
  const calls: Harness['calls'] = [];
  const output = opts.output ?? '{"changes":[],"preferences":[]}';
  const run: ReviewRunner =
    opts.run ??
    (async (def, model, prompt) => {
      calls.push({ agent: def.id, model, prompt });
      return { ok: true, output: typeof output === 'function' ? await output() : output };
    });
  const service = new ReviewService({
    config: opts.cfg ?? config(),
    history,
    state: new ReviewStateStore(path.join(dir, 'reviews.json'), (m) => logs.push(m)),
    clock,
    candidates: () => opts.candidates ?? [candidate()],
    notify: async (lane, text) => {
      notifications.push({ platform: lane.platform, channel: lane.channel, text });
    },
    skillsDir: dir,
    run,
    log: (m) => logs.push(m),
  });
  return { service, notifications, logs, calls };
}

const SKILL_MD = (name: string, description = 'When deploying') =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n步骤。\n`;

describe('reviewCandidatesFrom', () => {
  const session = (lastAt: number) => ({ lastAt: new Date(lastAt).toISOString() });

  it('treats a stored conversation with no live state as stopped: the backfill after a restart', () => {
    const [c] = reviewCandidatesFrom(
      [['telegram:chat:1', { lane: { platform: 'telegram', channel: 'chat' }, lastAt: now - 3 * 3_600_000 }]],
      [],
      () => session(now - 2 * 3_600_000),
      now
    );
    expect(c).toMatchObject({ key: 'telegram:chat:1', stopped: true, busyTurn: false, unresumable: false });
    // The library's last message wins over the record's "a turn started", which is older for a long turn.
    expect(c!.idleMs).toBe(2 * 3_600_000);
    expect(c!.lane).toEqual({ platform: 'telegram', channel: 'chat' });
  });

  it('lets live facts win over the stored ones', () => {
    const [c] = reviewCandidatesFrom(
      [['telegram:chat:1', { lastAt: now - 9 * 3_600_000 }]],
      [{ key: 'telegram:chat:1', agentId: 'cc', idleMs: 1_000, busyTurn: true, pendingWork: true, stopped: false, unresumable: true }],
      () => session(now - 9 * 3_600_000),
      now
    );
    expect(c).toMatchObject({ idleMs: 1_000, busyTurn: true, pendingWork: true, stopped: false, unresumable: true });
  });

  it('keeps a live conversation the store does not know, and drops a stored one the library never saw', () => {
    const out = reviewCandidatesFrom(
      [['gone:chat:1', {}]],
      [{ key: 'telegram:chat:2', agentId: 'cc', idleMs: 5_000, busyTurn: false, pendingWork: false, stopped: true, unresumable: false }],
      (key) => (key === 'gone:chat:1' ? undefined : session(now)),
      now
    );
    expect(out.map((c) => c.key)).toEqual(['telegram:chat:2']);
  });

  it('takes the lane from the live state when the stored record lost it (`/new` clears it)', () => {
    const [c] = reviewCandidatesFrom(
      [['telegram:chat:1', {}]],
      [
        {
          key: 'telegram:chat:1',
          agentId: 'cc',
          idleMs: 2 * 3_600_000,
          busyTurn: false,
          pendingWork: false,
          stopped: true,
          unresumable: false,
          lane: { platform: 'telegram', channel: 'chat' },
        },
      ],
      () => session(now - 2 * 3_600_000),
      now
    );
    expect(c!.lane).toEqual({ platform: 'telegram', channel: 'chat' });
  });
});

describe('eligible', () => {
  it('needs an hour of quiet', () => {
    expect(eligible(candidate({ idleMs: 3_599_999 }), false)).toBe(false);
    expect(eligible(candidate({ idleMs: 3_600_000 }), false)).toBe(true);
  });

  it('never reviews a turn that is running, or one waiting on the person', () => {
    expect(eligible(candidate({ busyTurn: true }), false)).toBe(false);
    expect(eligible(candidate({ pendingWork: true }), false)).toBe(false);
    expect(eligible(candidate({ busyTurn: true }), true)).toBe(false);
  });

  it('waits for the child to be reclaimed when it can be', () => {
    expect(eligible(candidate({ stopped: false }), false)).toBe(false);
  });

  it('reviews a conversation that is never reclaimed while its child is still up', () => {
    expect(eligible(candidate({ stopped: false, unresumable: true }), false)).toBe(true);
    expect(eligible(candidate({ stopped: false }), true)).toBe(true);
  });
});

describe('ReviewService', () => {
  it('does not review a conversation where the person said two things', async () => {
    seed('telegram:chat:1', 2);
    const h = harness();
    await h.service.sweep();
    expect(h.calls).toHaveLength(0);
  });

  it('reviews at three messages and not again until three more', async () => {
    const id = seed('telegram:chat:1', 3);
    const h = harness({ output: '{"changes":[],"preferences":[]}' });
    await h.service.sweep();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.agent).toBe('ag');
    expect(h.calls[0]!.model).toBe('gemini-3.8-flash-high');
    // The prompt is the conversation plus the rules, not the gateway's own framing.
    expect(h.calls[0]!.prompt).toContain('第 3 句');
    expect(h.calls[0]!.prompt).toContain('不删技能');

    await h.service.sweep();
    expect(h.calls).toHaveLength(1);

    history.message(id, { ts: now, role: 'user', kind: 'normal', text: '第四句' });
    await h.service.sweep();
    expect(h.calls).toHaveLength(1); // one since the review is not three

    history.message(id, { ts: now + 1, role: 'user', kind: 'normal', text: '第五句' });
    history.message(id, { ts: now + 2, role: 'user', kind: 'normal', text: '第六句' });
    await h.service.sweep();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.prompt).toContain('第六句');
    expect(h.calls[1]!.prompt).not.toContain('第 1 句');
  });

  it('never reviews a scheduled, sub-agent or review conversation', async () => {
    seed('telegram:chat:1', 5, 'schedule');
    seed('telegram:chat:2', 5, 'subagent');
    seed('telegram:chat:3', 5, 'review');
    const h = harness({
      candidates: [
        candidate({ key: 'telegram:chat:1' }),
        candidate({ key: 'telegram:chat:2' }),
        candidate({ key: 'telegram:chat:3' }),
      ],
    });
    await h.service.sweep();
    expect(h.calls).toHaveLength(0);
  });

  it('skips a conversation the library has never seen', async () => {
    const h = harness();
    await h.service.sweep();
    expect(h.calls).toHaveLength(0);
  });

  it('runs one at a time', async () => {
    seed('telegram:chat:1', 3);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const h = harness({
      run: async () => {
        started++;
        await gate;
        return { ok: true, output: '{"changes":[],"preferences":[]}' };
      },
    });
    const first = h.service.sweep();
    await Promise.resolve();
    await h.service.sweep(); // returns at once while the first is running
    expect(started).toBe(1);
    release!();
    await first;
    expect(started).toBe(1);
  });

  it('reviews every fresh conversation in one pass, with no daily cap', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `telegram:chat:${i}`);
    for (const key of keys) seed(key, 3);
    const h = harness({ candidates: keys.map((key) => candidate({ key })) });
    await h.service.sweep();
    expect(h.calls).toHaveLength(keys.length);
    expect(h.logs.some((l) => l.includes('already ran today'))).toBe(false);
  });

  it('leaves a conversation whose newest message is older than a day alone', async () => {
    seed('telegram:chat:1', 3, 'normal', now - 25 * 3_600_000);
    const h = harness();
    await h.service.sweep();
    expect(h.calls).toHaveLength(0);
  });

  it('retries a failed conversation after 24 hours once the six-hour back-off is up', async () => {
    seed('telegram:chat:1', 3);
    let attempts = 0;
    const h = harness({
      run: async () => {
        attempts += 1;
        return { ok: false, error: 'agy exited 1' };
      },
    });
    await h.service.sweep();
    expect(attempts).toBe(1);

    // The messages are now over a day old, but this conversation has a mark: the retry rule is
    // the six-hour back-off, not the first-start freshness rule.
    now += 25 * 3_600_000;
    await h.service.sweep();
    expect(attempts).toBe(2);
  });

  it('gives up on a batch after three failed attempts and reviews new messages afterwards', async () => {
    const id = seed('telegram:chat:1', 3);
    let attempts = 0;
    const h = harness({
      run: async () => {
        attempts += 1;
        return { ok: false, error: 'agy quota exhausted' };
      },
    });

    await h.service.sweep();
    now += 6 * 3_600_000;
    await h.service.sweep();
    now += 6 * 3_600_000;
    await h.service.sweep();
    expect(attempts).toBe(3);

    const [row] = history.reviewSessions();
    expect(row!.record).toMatchObject({ outcome: 'failed' });
    expect(row!.record!.error).toContain('gave up after 3 attempts');

    // The watermark moved past the batch, so the same messages are not tried again.
    now += 6 * 3_600_000;
    await h.service.sweep();
    expect(attempts).toBe(3);

    // Three new messages start a new batch, which gets three attempts of its own.
    for (const [i, text] of ['新一', '新二', '新三'].entries()) {
      history.message(id, { ts: now + i, role: 'user', kind: 'normal', text });
    }
    await h.service.sweep();
    expect(attempts).toBe(4);
    now += 6 * 3_600_000;
    await h.service.sweep();
    expect(attempts).toBe(5);
    now += 6 * 3_600_000;
    await h.service.sweep();
    expect(attempts).toBe(6);
    now += 6 * 3_600_000;
    await h.service.sweep();
    expect(attempts).toBe(6);
  });

  it('backs off for six hours when the prompt cannot be prepared', async () => {
    seed('telegram:chat:1', 3);
    // A file where the skills directory should be: listSkills throws ENOTDIR.
    fs.writeFileSync(path.join(dir, 'skills'), 'not a directory');
    const h = harness();
    const prepared = () => h.logs.filter((l) => l.includes('could not prepare the review')).length;

    await h.service.sweep();
    expect(prepared()).toBe(1);
    expect(h.calls).toHaveLength(0);

    now += 3_600_000;
    await h.service.sweep();
    expect(prepared()).toBe(1); // still backing off

    now += 6 * 3_600_000;
    await h.service.sweep();
    expect(prepared()).toBe(2);

    // A preparation failure is still a review attempt, so the Reviews tab can say why it failed.
    const rows = history.reviewSessions();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.record).toMatchObject({ outcome: 'failed' });
    expect(rows[0]!.record!.error).toContain('could not prepare the review');
  });

  it('does not review the same conversation again when the watermark cannot be written', async () => {
    seed('telegram:chat:1', 3);
    // A directory where reviews.json should be: every write fails, whatever the process can do.
    fs.mkdirSync(path.join(dir, 'reviews.json'));
    const h = harness();
    await h.service.sweep();
    expect(h.calls).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('could not write'))).toBe(true);

    // The watermark lives in memory, so the next tick does not review it again.
    await h.service.sweep();
    expect(h.calls).toHaveLength(1);
  });

  it('applies a create through the store and posts one line with how to undo it', async () => {
    seed('telegram:chat:1', 3);
    const output = JSON.stringify({
      changes: [
        {
          action: 'create',
          name: 'deploy-check',
          description: '部署前检查',
          body: '先跑测试。',
          reason: '这段对话里两次漏了测试',
        },
      ],
      preferences: ['回答先给结论'],
    });
    const h = harness({ output });
    await h.service.sweep();
    const skill = listSkills(dir).find((s) => s.name === 'deploy-check');
    expect(skill?.description).toBe('部署前检查');
    expect(readSkillFiles('deploy-check', dir).get('SKILL.md')!.toString()).toContain('先跑测试。');
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]!.text).toContain('新建技能 `deploy-check`');
    expect(h.notifications[0]!.text).toContain('talkcode skills archive deploy-check');
    expect(h.notifications[0]!.text).toContain('偏好建议：回答先给结论');
    expect(h.notifications[0]!.text).not.toContain('\n');
    // The source says where it came from: the reviewed conversation, marked as a review.
    const usage = JSON.parse(fs.readFileSync(path.join(dir, 'skills', '.usage.json'), 'utf8'));
    expect(usage.skills['deploy-check'].source).toMatchObject({
      conversation: 'telegram:chat:1',
      origin: 'review',
      agent: 'ag',
    });
  });

  it('patches only from the version the reviewer was given', async () => {
    seed('telegram:chat:1', 3);
    createSkill({ name: 'deploy-check', description: '部署前检查', body: '旧正文。' }, dir);
    const version = showSkill('deploy-check', undefined, dir).version;
    const good = JSON.stringify({
      changes: [{ action: 'patch', name: 'deploy-check', version, content: SKILL_MD('deploy-check'), reason: '补一条' }],
    });
    const h = harness({ output: good });
    await h.service.sweep();
    expect(readSkillFiles('deploy-check', dir).get('SKILL.md')!.toString()).toContain('步骤。');
    expect(h.notifications[0]!.text).toContain('talkcode skills revert deploy-check');

    // The next review is handed a stale version (the skill moved underneath it): the patch is
    // dropped, the conversation is still marked reviewed, and nothing is posted.
    history.message(history.sessionOf('telegram:chat:1')!.id, { ts: now + 10, role: 'user', kind: 'normal', text: 'x' });
    history.message(history.sessionOf('telegram:chat:1')!.id, { ts: now + 11, role: 'user', kind: 'normal', text: 'y' });
    history.message(history.sessionOf('telegram:chat:1')!.id, { ts: now + 12, role: 'user', kind: 'normal', text: 'z' });
    const stale = JSON.stringify({
      changes: [{ action: 'patch', name: 'deploy-check', version: 'deadbeef0000', content: SKILL_MD('deploy-check'), reason: '旧版本' }],
    });
    const second = harness({ output: stale });
    await second.service.sweep();
    expect(second.calls).toHaveLength(1);
    expect(second.logs.some((l) => l.includes('version mismatch'))).toBe(true);
    expect(second.notifications).toHaveLength(0);
  });

  it('drops one malformed change and applies the rest', async () => {
    seed('telegram:chat:1', 3);
    const output = JSON.stringify({
      changes: [
        { action: 'create', name: 'Bad Name', description: 'x', body: '' },
        { action: 'create', name: 'good-skill', description: '好技能', body: '正文' },
      ],
    });
    const h = harness({ output });
    await h.service.sweep();
    expect(listSkills(dir).map((s) => s.name)).toContain('good-skill');
    expect(h.logs.some((l) => l.includes('dropped create "Bad Name"'))).toBe(true);
    expect(h.notifications[0]!.text).toContain('good-skill');
  });

  it('posts nothing when the reviewer changed nothing', async () => {
    seed('telegram:chat:1', 3);
    const h = harness({ output: '{"changes":[],"preferences":[]}' });
    await h.service.sweep();
    expect(h.notifications).toHaveLength(0);
  });

  it('keeps a preference suggestion to the log when no skill changed', async () => {
    seed('telegram:chat:1', 3);
    const h = harness({ output: '{"changes":[],"preferences":["别用表情"]}' });
    await h.service.sweep();
    expect(h.notifications).toHaveLength(0);
    expect(h.logs.some((l) => l.includes('别用表情'))).toBe(true);
  });

  it('files the review as a review session that search and list leave out', async () => {
    seed('telegram:chat:1', 3);
    const h = harness({ output: '{"changes":[],"preferences":[]}' });
    await h.service.sweep();
    const review = history.sessionOf(`review:telegram:chat:1:${now}`);
    expect(review?.kind).toBe('review');
    expect(review?.agent).toBe('ag');
    expect(review?.title).toBe('复盘：telegram:chat:1');
    expect(history.list({ days: 30 }).every((r) => r.kind !== 'review')).toBe(true);
    expect(history.search('读下面的对话记录')).toHaveLength(0);
  });

  it('records what each change became, with the command that undoes it', async () => {
    seed('telegram:chat:1', 3);
    const output = JSON.stringify({
      changes: [
        { action: 'create', name: 'deploy-check', description: '部署前检查', body: '先跑测试。', reason: '两次漏了测试' },
      ],
      preferences: ['回答先给结论'],
    });
    const h = harness({ output });
    await h.service.sweep();

    const [row] = history.reviewSessions();
    expect(row!.record).toMatchObject({
      reviewedKey: 'telegram:chat:1',
      reviewedTitle: 'telegram:chat:1',
      platform: 'telegram',
      channel: 'chat',
      outcome: 'changed',
      preferences: ['回答先给结论'],
      invalid: [],
    });
    expect(row!.record!.changes[0]).toMatchObject({
      action: 'create',
      name: 'deploy-check',
      reason: '两次漏了测试',
      applied: true,
    });
    // The result is a fact about the review, not the notice: the undo command is derived from it
    // by the panel, and a create has no history entry to revert to.
    expect(row!.record!.changes[0]!.revertId).toBeUndefined();
  });

  it('records a change the store refused, with the store’s own sentence', async () => {
    seed('telegram:chat:1', 3);
    createSkill({ name: 'deploy-check', description: '部署前检查', body: '旧正文。' }, dir);
    const output = JSON.stringify({
      changes: [
        { action: 'patch', name: 'deploy-check', version: 'deadbeef0000', content: SKILL_MD('deploy-check'), reason: '旧版本' },
      ],
    });
    const h = harness({ output });
    await h.service.sweep();

    const [row] = history.reviewSessions();
    expect(row!.record!.outcome).toBe('refused');
    expect(row!.record!.changes[0]).toMatchObject({ action: 'patch', name: 'deploy-check', applied: false });
    expect(row!.record!.changes[0]!.error).toContain('version mismatch');
  });

  it('records a change that never passed the shape check under invalid', async () => {
    seed('telegram:chat:1', 3);
    const output = JSON.stringify({
      changes: [
        { action: 'create', name: 'bad-skill', description: '' },
        { action: 'create', name: 'good-skill', description: '好技能', body: '正文' },
      ],
    });
    const h = harness({ output });
    await h.service.sweep();
    const [row] = history.reviewSessions();
    expect(row!.record!.outcome).toBe('changed');
    expect(row!.record!.invalid).toHaveLength(1);
    expect(row!.record!.invalid[0]).toContain('change #1');
    expect(row!.record!.changes.map((c) => c.name)).toEqual(['good-skill']);
  });

  it('records only preference suggestions, so they are not lost to the log', async () => {
    seed('telegram:chat:1', 3);
    const h = harness({ output: '{"changes":[],"preferences":["别用表情"]}' });
    await h.service.sweep();
    const [row] = history.reviewSessions();
    expect(row!.record).toMatchObject({ outcome: 'preferences', preferences: ['别用表情'], changes: [] });
  });

  it('files a failed run too, so the tab can say why nothing was reviewed', async () => {
    seed('telegram:chat:1', 3);
    const h = harness({ run: async () => ({ ok: false, error: 'agy exited 1' }) });
    await h.service.sweep();

    const [row] = history.reviewSessions();
    expect(row!.session.kind).toBe('review');
    expect(row!.record).toMatchObject({ outcome: 'failed', error: 'agy exited 1', changes: [], preferences: [] });
    // The prompt is what was sent; there is no answer to file.
    expect(history.reviewAnswer(row!.session.id)).toBeUndefined();
  });

  it('records an answer it could not read as a failed review, not as "nothing"', async () => {
    seed('telegram:chat:1', 3);
    const h = harness({ output: '我觉得这段对话没什么可改的' });
    await h.service.sweep();
    const [row] = history.reviewSessions();
    expect(row!.record!.outcome).toBe('failed');
    expect(row!.record!.error).toContain('could not be read');
  });

  it('backs off for six hours after a failed run', async () => {
    seed('telegram:chat:1', 3);
    const calls: number[] = [];
    const h = harness({
      run: async () => {
        calls.push(now);
        return { ok: false, error: 'agy exited 1' };
      },
    });
    await h.service.sweep();
    expect(calls).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('agy exited 1'))).toBe(true);

    now += 3_600_000;
    await h.service.sweep();
    expect(calls).toHaveLength(1); // still backing off

    now += 6 * 3_600_000;
    await h.service.sweep();
    expect(calls).toHaveLength(2);
  });

  it('treats an answer that is not JSON as no change, and moves the watermark', async () => {
    seed('telegram:chat:1', 3);
    const h = harness({ output: 'I could not review this.' });
    await h.service.sweep();
    expect(h.notifications).toHaveLength(0);
    expect(h.logs.some((l) => l.includes('no JSON object') && l.includes('treated as no change'))).toBe(true);
    // Seen, not failed: the same three messages are not reviewed again on the next tick, and no
    // six-hour back-off is involved.
    await h.service.sweep();
    expect(h.calls).toHaveLength(1);
  });

  it('does nothing at all without a configured reviewer', async () => {
    seed('telegram:chat:1', 3);
    const cfg = config({ review: undefined });
    const h = harness({ cfg });
    await h.service.sweep();
    expect(h.calls).toHaveLength(0);
  });

  it('quotes a used skill in full, and only in the catalog otherwise', async () => {
    createSkill({ name: 'deploy-check', description: '部署前检查', body: '先跑测试。' }, dir);
    createSkill({ name: 'other-skill', description: '别的事', body: '别的内容。' }, dir);
    const id = seed('telegram:chat:1', 3);
    history.message(id, { ts: now, role: 'tool', kind: 'normal', text: 'cc · Skill: deploy-check' });
    history.message(id, { ts: now + 1, role: 'user', kind: 'normal', text: '继续' });
    const h = harness();
    await h.service.sweep();
    const prompt = h.calls[0]!.prompt;
    expect(prompt).toContain('先跑测试。');
    expect(prompt).toContain('other-skill');
    expect(prompt).not.toContain('别的内容。');
    expect(prompt).toContain(showSkill('deploy-check', undefined, dir).version);
  });
});

describe('the agy invocation', () => {
  it('never puts the prompt in argv, however long it is', () => {
    const prompt = '对话'.repeat(60_000); // 120k characters, 360 KB in UTF-8
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(128 * 1024);
    const argv = reviewAgyArgs('gemini-3.8-flash-high');
    expect(argv.join(' ')).not.toContain('对话');
    expect(Math.max(...argv.map((a) => Buffer.byteLength(a)))).toBeLessThan(4096);
    expect(argv).toContain('--input-format=stream-json');
    expect(argv).toContain('--output-format=stream-json');
    expect(argv).toContain('-p=');
    expect(JSON.parse(reviewAgyInput(prompt))).toEqual({ event: 'user', message: { content: prompt } });
  });

  it('reads the answer off the event stream', () => {
    const events = [
      { event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } },
      { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: '{"changes":' } },
      { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: '[]}' } },
      { event: 'result', result: { status: 'SUCCESS', response: '{"changes":[]}' } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    expect(agyReviewAnswer(events)).toEqual({ ok: true, output: '{"changes":[]}' });
  });

  it('falls back to the final frame when nothing streamed, and ignores banner lines', () => {
    const out = `warning: something\n${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '{"changes":[]}' } })}`;
    expect(agyReviewAnswer(out)).toEqual({ ok: true, output: '{"changes":[]}' });
  });

  it('believes a reply that ended in an error status, and refuses an error with none', () => {
    const withText = JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '{"changes":[]}' } });
    expect(agyReviewAnswer(withText).ok).toBe(true);
    const noText = JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'quota' } });
    const r = agyReviewAnswer(noText);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('quota');
  });

  it('refuses a run with no result event or no text', () => {
    expect(agyReviewAnswer('').ok).toBe(false);
    expect(agyReviewAnswer(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '' } })).ok).toBe(false);
  });
});

describe('review prompt', () => {
  it('carries the rules, the catalog, the used skill text and the conversation', () => {
    const prompt = buildReviewPrompt({
      title: '部署',
      messages: [
        { at: '2026-11-04T09:00:00.000Z', role: 'user', text: '部署一下' },
        { at: '2026-11-04T09:01:00.000Z', role: 'tool', text: 'Bash: git status' },
      ],
      dropped: 2,
      catalog: [{ name: 'deploy-check', version: 'abc123', description: '部署前检查' }],
      used: [{ name: 'deploy-check', version: 'abc123', description: '', content: '先跑测试。', files: ['references/api.md'] }],
    });
    expect(prompt).toContain('- deploy-check（abc123）：部署前检查');
    expect(prompt).toContain('### deploy-check（abc123）\n先跑测试。');
    expect(prompt).toContain('其他文件：references/api.md');
    expect(prompt).toContain('省略了最早的 2 条');
    expect(prompt).toContain('用户：部署一下');
    expect(prompt).toContain('工具：Bash: git status');
    expect(prompt).toContain('不要调用任何工具');
    expect(prompt.startsWith('这是一次自动复盘')).toBe(true);
    expect(prompt).toContain('不要请求确认，不要等待批准，不要先给方案');
  });
});

describe('parseReviewOutput', () => {
  it('reads a fenced object with text around it', () => {
    const r = parseReviewOutput('好的，结果如下：\n```json\n{"changes":[],"preferences":["短一点"]}\n```\n完。');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.output.preferences).toEqual(['短一点']);
  });

  it('reads the widest braces when there is no fence', () => {
    const r = parseReviewOutput('prefix {"changes":[{"action":"create","name":"a-b","description":"d"}],"preferences":[]} suffix');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.output.changes).toHaveLength(1);
  });

  it('keeps the valid changes and names the invalid ones', () => {
    const r = parseReviewOutput(
      JSON.stringify({
        changes: [
          { action: 'create', name: 'ok', description: 'd' },
          { action: 'remove', name: 'nope' },
          { action: 'patch', name: 'x' },
        ],
        preferences: [1, 'keep'],
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.output.changes).toHaveLength(1);
    expect(r.parsed.output.preferences).toEqual(['keep']);
    expect(r.parsed.invalid).toHaveLength(2);
  });

  it('refuses a changes value that is not an array', () => {
    const r = parseReviewOutput('{"changes":"none"}');
    expect(r.ok).toBe(false);
  });

  it('refuses prose with no JSON', () => {
    expect(parseReviewOutput('没有要改的。').ok).toBe(false);
  });

  it('caps how many changes one answer may apply', () => {
    const changes = Array.from({ length: 15 }, (_, i) => ({ action: 'create', name: `s-${i}`, description: 'd' }));
    const r = parseReviewOutput(JSON.stringify({ changes }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.output.changes).toHaveLength(10);
    expect(r.parsed.invalid).toHaveLength(5);
  });
});

describe('usedSkillNames', () => {
  const known = new Set(['deploy-check', 'other-skill']);

  it('finds a Skill tool line, a path into the managed copy, and a slash message', () => {
    expect(
      usedSkillNames(
        [
          { role: 'tool', text: 'cc · Skill: deploy-check' },
          { role: 'tool', text: 'Bash: cat ~/.talkcode/skills/other-skill/SKILL.md' },
          { role: 'user', text: '/deploy-check 再跑一次' },
        ],
        known
      )
    ).toEqual(['deploy-check', 'other-skill']);
  });

  it('ignores names that are not managed skills, and counts one skill once', () => {
    expect(
      usedSkillNames(
        [
          { role: 'tool', text: 'Skill: super' },
          { role: 'tool', text: 'Skill: deploy-check' },
          { role: 'tool', text: 'Skill: deploy-check' },
        ],
        known
      )
    ).toEqual(['deploy-check']);
  });
});

describe('noticeLine', () => {
  it('names what changed and how to undo each one, on one line', () => {
    const line = noticeLine(
      [
        { name: 'a-skill', action: 'created' },
        { name: 'b-skill', action: 'patched', revertId: '0001-abc' },
        { name: 'c-skill', action: 'file', file: 'references/x.md', revertId: '0002-def' },
      ],
      ['先给结论']
    );
    expect(line).toContain('新建技能 `a-skill`（撤掉用 `talkcode skills archive a-skill`）');
    expect(line).toContain('更新技能 `b-skill`（回滚 `talkcode skills revert b-skill 0001-abc`）');
    expect(line).toContain('给 `c-skill` 写了 `references/x.md`（回滚 `talkcode skills revert c-skill 0002-def`）');
    expect(line).toContain('偏好建议：先给结论');
    expect(line).not.toContain('\n');
  });
});
