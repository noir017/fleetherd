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

  it('takes an agent of any harness: the review switches its tools off itself', () => {
    expect((cfg({ agent: 'cc' }) as ReturnType<typeof parseConfig>).review).toEqual({ agent: 'cc' });
  });

  it('takes an OpenAI-compatible endpoint instead', () => {
    const c = cfg({ api: { url: 'http://newapi:3000/v1', key: 'sk', model: 'gemini-3.8-flash' } }) as ReturnType<typeof parseConfig>;
    expect(c.review).toEqual({ api: { url: 'http://newapi:3000/v1', key: 'sk', model: 'gemini-3.8-flash' } });
  });

  it('refuses both reviewers at once, and neither', () => {
    expect(() => cfg({ agent: 'ag', api: { url: 'u', key: 'k', model: 'm' } })).toThrow(/both an agent and an api/);
    expect(() => cfg({ model: 'm' })).toThrow(/needs a reviewer/);
  });

  it('refuses an endpoint missing its url, key or model', () => {
    expect(() => cfg({ api: { url: 'u', key: 'k' } })).toThrow();
    expect(() => cfg({ api: { url: '', key: 'k', model: 'm' } })).toThrow();
  });

  it('refuses review.model and review.args beside an endpoint', () => {
    expect(() => cfg({ api: { url: 'u', key: 'k', model: 'm' }, model: 'x' })).toThrow(/review.api.model/);
    expect(() => cfg({ api: { url: 'u', key: 'k', model: 'm' }, args: ['--x'] })).toThrow(/no command/);
  });

  it('takes review.args for a custom reviewer only', () => {
    const custom = parseConfig({
      platforms: { telegram: { type: 'telegram', token: 't' } },
      agents: [
        { id: 'cc', harness: 'claude' },
        { id: 'cur', harness: 'custom', command: '/opt/cursor/cursor-agent', args: ['acp'] },
      ],
      routing: { default: 'cc' },
      review: { agent: 'cur', args: ['--mode', 'ask'] },
    });
    expect(custom.review?.args).toEqual(['--mode', 'ask']);
    expect(() => cfg({ agent: 'cc', args: ['--x'] })).toThrow(/review.args is for a custom, gemini or dsh reviewer/);
    expect(() => cfg({ agent: 'ag', args: ['--x'] })).toThrow(/agy, whose tools the gateway turns off itself/);
  });
});
