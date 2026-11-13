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
    expect(parseRetryButtonId('rty:x:2')).toBeNull();
    expect(parseRetryButtonId('aga:x:0')).toBeNull();
  });
});
