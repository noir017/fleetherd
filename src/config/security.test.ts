import { describe, it, expect } from 'vitest';
import { parseConfig, accessUnrestricted, type Config } from './schema.js';

/**
 * accessUnrestricted is the access-control signal (loadConfig + doctor warn on it): agents always
 * run with full tool access, so an empty access.allowFrom means anyone who can message the bot can
 * trigger them. Non-blocking, but surfaced loudly.
 */
function cfg(partial: Record<string, unknown>): Config {
  return parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'default', harness: 'claude' }],
    routing: { default: 'default' },
    ...partial,
  });
}

describe('accessUnrestricted', () => {
  it('is true when allowFrom is empty (the default)', () => {
    expect(accessUnrestricted(cfg({}))).toBe(true);
  });

  it('is false once allowFrom is non-empty', () => {
    expect(accessUnrestricted(cfg({ access: { allowFrom: ['discord:123'] } }))).toBe(false);
  });
});

describe('AgentDefSchema permissions', () => {
  it('defaults to auto: tool calls are approved unless the operator asks otherwise', () => {
    const c = cfg({ agents: [{ id: 'default', harness: 'claude' }] });
    expect(c.agents[0]!.permissions).toBe('auto');
  });

  it('takes ask for an ACP agent', () => {
    const c = cfg({ agents: [{ id: 'default', harness: 'claude', permissions: 'ask' }] });
    expect(c.agents[0]!.permissions).toBe('ask');
  });

  it('takes ask for agy over ACP, which sends session/request_permission like any ACP harness', () => {
    const c = cfg({ agents: [{ id: 'default', harness: 'agy', permissions: 'ask' }] });
    expect(c.agents[0]!.permissions).toBe('ask');
  });
});
