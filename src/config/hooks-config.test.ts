import { describe, expect, it } from 'vitest';
import { parseConfig } from './schema.js';

/** `agents[].hooks.turnFailed`, as config.yaml can state it. */

const base = {
  platforms: { web: { type: 'webui', token: 't' } },
  agents: [
    { id: 'cc', harness: 'claude' },
    { id: 'ag', harness: 'agy' },
  ],
  routing: { default: 'cc', pipeline: [] },
};

describe('agents[].hooks.turnFailed', () => {
  const withHook = (turnFailed: unknown) =>
    parseConfig({ ...base, agents: [{ id: 'cc', harness: 'claude', hooks: { turnFailed } }] }).agents[0]!.hooks?.turnFailed;

  it('fills in the continue policy’s defaults', () => {
    expect(withHook({ continue: {} })).toEqual({
      continue: { on: ['service', 'connection', 'limit', 'hung', 'restart'], message: 'continue', max: 3, backoffMs: 30_000 },
    });
  });

  it('takes the operator’s words, reasons and limits', () => {
    expect(withHook({ continue: { on: ['other'], message: '继续', max: 1, backoffMs: 5_000 }, command: 'notify.sh' })).toEqual({
      continue: { on: ['other'], message: '继续', max: 1, backoffMs: 5_000 },
      command: 'notify.sh',
    });
  });

  it('refuses an unknown reason, a runaway max, and a misspelt key', () => {
    expect(() => withHook({ continue: { on: ['oops'] } })).toThrow();
    expect(() => withHook({ continue: { max: 50 } })).toThrow();
    expect(() => withHook({ contnue: {} })).toThrow();
  });
});
