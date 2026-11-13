import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../types.js';
import { FailedInputs, type FailedNotice } from './failed-input.js';

/**
 * What a failed turn's input becomes (failed-input.ts): held for the next turn when the agent never
 * received it, kept for Retry either way, and never sent twice.
 */

const msg = (content: string, user = 'u1', extra: Partial<InboundMessage> = {}): InboundMessage => ({
  conversation: { platform: 'web', channel: 'main', thread: 'aa', kind: 'direct', user },
  messageId: content,
  content,
  timestamp: 0,
  ...extra,
});

function rig() {
  const retired: FailedNotice[] = [];
  let n = 0;
  const f = new FailedInputs({ scheduled: 'schedule', continued: 'continue' }, (notice) => retired.push(notice), () => `r${++n}`);
  return { f, retired };
}

const notice = (id: string): FailedNotice => ({ platformId: 'web', ref: { address: { channel: 'main' }, messageId: id }, text: '❌' });

describe('FailedInputs', () => {
  it('holds an undelivered turn for the next one, once, and keeps it for Retry', () => {
    const { f } = rig();
    const task = msg('build the release', 'delegated', { attachments: [{ type: 'file', url: 'data:text/plain;base64,eA==', name: 'notes.txt' }] });
    expect(f.failed('A', { input: [task], undelivered: true, agentId: 'cbc' })).toEqual({ retryId: 'r1', held: 1 });
    expect(f.heldCount('A')).toBe(1);
    expect(f.peek('r1')?.input).toEqual([task]);
    expect(f.take('A')).toEqual([task]);
    expect(f.take('A')).toEqual([]);
  });

  it('holds nothing for a delivered failure, but still offers Retry', () => {
    const { f } = rig();
    expect(f.failed('A', { input: [msg('hi')], undelivered: false, agentId: 'ag' })).toEqual({ retryId: 'r1', held: 0 });
    expect(f.take('A')).toEqual([]);
  });

  it('does not hold a scheduled prompt, the operator’s continue, or a slash command', () => {
    const { f } = rig();
    const kept = f.failed('A', {
      input: [msg('check the build', 'schedule'), msg('continue', 'continue'), msg('/compact'), msg('and the docs')],
      undelivered: true,
      agentId: 'cc',
    });
    expect(kept.held).toBe(1);
    expect(f.take('A').map((m) => m.content)).toEqual(['and the docs']);
    // Retry sends what was asked, the command too; only the continue is not part of it.
    expect(f.peek(kept.retryId!)?.input.map((m) => m.content)).toEqual(['check the build', '/compact', 'and the docs']);
  });

  it('a continue-only turn keeps the input of the failure it continued', () => {
    const { f } = rig();
    f.failed('A', { input: [msg('the task')], undelivered: false, agentId: 'cc' });
    const again = f.failed('A', { input: [msg('continue', 'continue')], undelivered: true, agentId: 'cc' });
    expect(again).toEqual({ retryId: 'r2', held: 0 });
    expect(f.peek('r1')).toBeUndefined();
    expect(f.peek('r2')?.input.map((m) => m.content)).toEqual(['the task']);
  });

  it('a continue-only failure with nothing before it offers no Retry', () => {
    const { f } = rig();
    expect(f.failed('A', { input: [msg('continue', 'continue')], undelivered: false, agentId: 'cc' })).toEqual({ held: 0 });
  });

  it('claiming a Retry drops the hold, so the same input cannot go out twice', () => {
    const { f } = rig();
    f.failed('A', { input: [msg('task')], undelivered: true, agentId: 'cc' });
    expect(f.claim('r1')?.input.map((m) => m.content)).toEqual(['task']);
    expect(f.take('A')).toEqual([]);
    expect(f.claim('r1')).toBeUndefined();
  });

  it('a turn that ends normally retires the record, and its buttons with it', () => {
    const { f, retired } = rig();
    f.failed('A', { input: [msg('task')], undelivered: true, agentId: 'cc' });
    f.noticeSent('r1', notice('n1'));
    f.take('A'); // the next turn carried it along…
    f.ended('A'); // …and got through
    expect(f.peek('r1')).toBeUndefined();
    expect(retired.map((n) => n.ref.messageId)).toEqual(['n1']);
  });

  it('a newer failure replaces the record and retires the older notice', () => {
    const { f, retired } = rig();
    f.failed('A', { input: [msg('one')], undelivered: false, agentId: 'cc' });
    f.noticeSent('r1', notice('n1'));
    f.failed('A', { input: [msg('two')], undelivered: false, agentId: 'cc' });
    expect(retired.map((n) => n.ref.messageId)).toEqual(['n1']);
    expect(f.peek('r2')?.input.map((m) => m.content)).toEqual(['two']);
  });

  it('a notice for a record already gone is retired at once', () => {
    const { f, retired } = rig();
    f.failed('A', { input: [msg('task')], undelivered: false, agentId: 'cc' });
    f.claim('r1');
    f.noticeSent('r1', notice('late'));
    expect(retired.map((n) => n.ref.messageId)).toEqual(['late']);
  });

  it('/new forgets both', () => {
    const { f } = rig();
    f.failed('A', { input: [msg('task')], undelivered: true, agentId: 'cc' });
    f.forget('A');
    expect(f.take('A')).toEqual([]);
    expect(f.peek('r1')).toBeUndefined();
  });
});
