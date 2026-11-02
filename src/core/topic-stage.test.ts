import { describe, expect, it } from 'vitest';
import {
  continueDelayMs,
  describeFailureReason,
  failureLine,
  LINE_MAX,
  needsPerson,
  replyLine,
  topicStage,
} from './topic-stage.js';
import type { TopicStage, TurnFailureReason } from '../types.js';

const done = (at: number) => ({ outcome: { kind: 'done' as const, at } });
const failed = (at: number) => ({ outcome: { kind: 'failed' as const, at, reason: 'service' as const } });

describe('topicStage — first matching row wins', () => {
  it('a question on screen is "answer", even while its turn is still running', () => {
    expect(topicStage({ running: true, asking: true })).toBe('answer');
    expect(topicStage({ running: false, asking: true, activity: failed(5) })).toBe('answer');
  });

  it('a scheduled automatic continue is "retrying", before anything runs again', () => {
    expect(
      topicStage({ running: false, asking: false, activity: { ...failed(5), retry: { attempt: 1, max: 3, at: 10 } } })
    ).toBe('retrying');
  });

  it('a running turn supersedes what the last one left', () => {
    expect(topicStage({ running: true, asking: false, activity: failed(5) })).toBe('working');
    expect(topicStage({ running: true, asking: false, activity: done(5), seenAt: 0 })).toBe('working');
  });

  it('a failure stays a failure after it has been seen', () => {
    expect(topicStage({ running: false, asking: false, activity: failed(5), seenAt: 100 })).toBe('failed');
  });

  it('a finished reply needs reviewing only until the person has looked', () => {
    expect(topicStage({ running: false, asking: false, activity: done(5) })).toBe('review');
    expect(topicStage({ running: false, asking: false, activity: done(5), seenAt: 4 })).toBe('review');
    expect(topicStage({ running: false, asking: false, activity: done(5), seenAt: 5 })).toBe('idle');
    expect(topicStage({ running: false, asking: false, activity: done(5), seenAt: 9 })).toBe('idle');
  });

  it('nothing known is idle', () => {
    expect(topicStage({ running: false, asking: false })).toBe('idle');
  });
});

describe('needsPerson', () => {
  it('is true exactly for answer, failed and review', () => {
    const all: TopicStage[] = ['answer', 'failed', 'review', 'retrying', 'working', 'idle'];
    expect(all.filter(needsPerson)).toEqual(['answer', 'failed', 'review']);
  });
});

describe('replyLine', () => {
  it('takes the first line of prose, stripped of markdown', () => {
    expect(replyLine('**Done:** the bump is green.\n\nDetails…')).toBe('Done: the bump is green.');
    expect(replyLine('## Result\n\n- Fixed `foo` in [bar](http://x)\n')).toBe('Fixed foo in bar');
    expect(replyLine('> quoted conclusion')).toBe('quoted conclusion');
  });

  it('skips fences, rules and tables', () => {
    expect(replyLine('```ts\nconst x = 1;\n```\nAfter the code.')).toBe('After the code.');
    expect(replyLine('---\n| a | b |\n|---|---|\nText')).toBe('Text');
  });

  it('is undefined when there is no prose at all', () => {
    expect(replyLine('')).toBeUndefined();
    expect(replyLine('```\nonly code\n```')).toBeUndefined();
  });

  it('is bounded', () => {
    const line = replyLine('x'.repeat(500));
    expect(line).toHaveLength(LINE_MAX);
    expect(line?.endsWith('…')).toBe(true);
  });
});

describe('failureLine', () => {
  it('folds whitespace and bounds the message', () => {
    expect(failureLine('agent "cc" could not start:\n  ENOENT')).toBe('agent "cc" could not start: ENOENT');
    expect(failureLine('y'.repeat(300))).toHaveLength(LINE_MAX);
  });
});

describe('describeFailureReason', () => {
  it('words every reason', () => {
    const reasons: TurnFailureReason[] = [
      'service',
      'limit',
      'connection',
      'access',
      'request',
      'provider',
      'hung',
      'startup',
      'preLaunch',
      'restart',
      'other',
    ];
    for (const r of reasons) expect(describeFailureReason(r)).not.toBe(r);
  });
});

describe('continueDelayMs', () => {
  it('doubles from the base and is capped at ten minutes', () => {
    expect(continueDelayMs(1, 30_000)).toBe(30_000);
    expect(continueDelayMs(2, 30_000)).toBe(60_000);
    expect(continueDelayMs(3, 30_000)).toBe(120_000);
    expect(continueDelayMs(10, 30_000)).toBe(600_000);
    expect(continueDelayMs(0, 30_000)).toBe(30_000);
  });
});
