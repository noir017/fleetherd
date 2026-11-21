import { describe, expect, it } from 'vitest';
import { parseRetryButtonId, retryButtons } from './turn-retry.js';

describe('turn-retry buttons', () => {
  it('round-trips both buttons through their ids', () => {
    const [same, other] = retryButtons('ab12cd34', { anotherAgent: true });
    expect(same).toMatchObject({ id: 'rty:ab12cd34:0', label: 'Retry' });
    expect(other).toMatchObject({ id: 'rty:ab12cd34:1', label: 'Retry with another agent' });
    expect(parseRetryButtonId(same!.id)).toEqual({ retryId: 'ab12cd34', mode: 'same' });
    expect(parseRetryButtonId(other!.id)).toEqual({ retryId: 'ab12cd34', mode: 'other' });
  });

  it('offers no other agent when there is none', () => {
    expect(retryButtons('x', { anotherAgent: false }).map((b) => b.label)).toEqual(['Retry']);
  });

  it('ignores ids that are not its own', () => {
    expect(parseRetryButtonId('rty:x:3')).toBeNull();
    expect(parseRetryButtonId('aga:x:0')).toBeNull();
  });

  it('offers Reconnect primary + Resend fallback when reconnect is enabled', () => {
    const btns = retryButtons('ab12cd34', { anotherAgent: true, reconnect: true });
    expect(btns.map((b) => [b.label, b.style])).toEqual([
      ['Reconnect', 'primary'],
      ['Resend', 'secondary'],
      ['Retry with another agent', 'secondary'],
    ]);
    expect(parseRetryButtonId(btns[0]!.id)).toEqual({ retryId: 'ab12cd34', mode: 'reconnect' });
    expect(parseRetryButtonId(btns[1]!.id)).toEqual({ retryId: 'ab12cd34', mode: 'same' });
    expect(parseRetryButtonId(btns[2]!.id)).toEqual({ retryId: 'ab12cd34', mode: 'other' });

    expect(retryButtons('ab12cd34', { anotherAgent: true, reconnect: true, resend: false }).map((b) => b.label)).toEqual([
      'Reconnect',
    ]);
  });
});
