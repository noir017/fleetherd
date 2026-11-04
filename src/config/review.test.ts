import { describe, expect, it } from 'vitest';
import { parseConfig } from './schema.js';

function cfg(review: unknown): unknown {
  return parseConfig({
    platforms: { telegram: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'ag', harness: 'agy' },
    ],
    routing: { default: 'cc' },
    review,
  });
}

describe('review config', () => {
  it('is off by default', () => {
    const c = parseConfig({
      platforms: { telegram: { type: 'telegram', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc' },
    });
    expect(c.review).toBeUndefined();
  });

  it('names the reviewer and, optionally, its model', () => {
    const c = cfg({ agent: 'ag', model: 'gemini-3.8-flash-high' }) as ReturnType<typeof parseConfig>;
    expect(c.review).toEqual({ agent: 'ag', model: 'gemini-3.8-flash-high' });
  });

  it('refuses an agent id that does not exist', () => {
    expect(() => cfg({ agent: 'nobody' })).toThrow(/non-existent agent id/);
  });

  it('refuses an agent that is not agy: a review runs `agy -p`', () => {
    expect(() => cfg({ agent: 'cc' })).toThrow(/must name an agy agent/);
  });
});
