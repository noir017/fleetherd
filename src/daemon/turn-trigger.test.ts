import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../types.js';
import { kindForTrigger } from '../history/record.js';
import {
  CONTINUE_SENDER,
  DELEGATE_SENDER,
  SCHEDULED_SENDER,
  UPDATE_SENDER,
  historyTriggerOf,
} from './turn-runner.js';

/**
 * What started a turn, from the sender the daemon puts on the batch. These strings are the wire
 * format between the daemon and the library — a typo here records every scheduled run as a
 * person's, and nothing else would notice.
 */

function msg(user: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user },
    messageId: 'm1',
    content: 'x',
    timestamp: 0,
  };
}

describe('historyTriggerOf', () => {
  it.each([
    ['a person', [msg('u1')], 'person'],
    ['a scheduled run', [msg(SCHEDULED_SENDER), msg(SCHEDULED_SENDER)], 'schedule'],
    ['an automatic continue', [msg(CONTINUE_SENDER)], 'continue'],
    ['a task handed to a sub-agent', [msg(DELEGATE_SENDER)], 'delegate'],
    ['the sub-agent updates card', [msg(UPDATE_SENDER)], 'update'],
    ['both delegation senders in one batch', [msg(UPDATE_SENDER), msg(DELEGATE_SENDER)], 'delegate'],
    ['a person who wrote into a delegated batch', [msg('u1'), msg(DELEGATE_SENDER)], 'person'],
  ])('names %s', (_what, batch, expected) => {
    expect(historyTriggerOf(batch)).toBe(expected);
  });

  it('maps each trigger onto the message kind the library already uses', () => {
    expect(kindForTrigger('person')).toBe('normal');
    expect(kindForTrigger('continue')).toBe('normal');
    expect(kindForTrigger('schedule')).toBe('schedule');
    expect(kindForTrigger('delegate')).toBe('subagent');
    expect(kindForTrigger('update')).toBe('subagent');
    expect(kindForTrigger('background')).toBe('background');
  });
});
