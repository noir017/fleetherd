import { describe, expect, it } from 'vitest';
import { parseConfig } from './schema.js';

/** The `mcp:` block (docs/external-mcp.md): off unless written, credentials only by variable name. */

function cfg(mcp: unknown, platforms: Record<string, unknown> = { web: { type: 'webui', token: 't', port: 8787 } }) {
  return parseConfig({
    platforms,
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
    mcp,
  });
}

describe('mcp config', () => {
  it('is off by default', () => {
    expect(cfg(undefined).mcp).toBeUndefined();
  });

  it('listens on loopback by default, with each caller\'s token named by its variable', () => {
    const c = cfg({ callers: [{ name: 'gemini', tokenEnv: 'FLEETHERD_MCP_GEMINI_TOKEN', tools: ['skills', 'tasks'] }] });
    expect(c.mcp).toEqual({
      host: '127.0.0.1',
      port: 8790,
      callers: [{ name: 'gemini', tokenEnv: 'FLEETHERD_MCP_GEMINI_TOKEN', tools: ['skills', 'tasks'] }],
    });
  });

  it('refuses a token written in place of its variable\'s name, an unknown tool, and an unknown field', () => {
    expect(() => cfg({ callers: [{ name: 'g', tokenEnv: 'sk-live 123', tools: ['skills'] }] })).toThrow(/NAME of an environment variable/);
    expect(() => cfg({ callers: [{ name: 'g', tokenEnv: 'T', tools: ['schedule'] }] })).toThrow(/callers/);
    expect(() => cfg({ callers: [{ name: 'g', tokenEnv: 'T', tools: [] }] })).toThrow(/callers/);
    expect(() => cfg({ callers: [{ name: 'g', token: 'secret', tokenEnv: 'T', tools: ['skills'] }] })).toThrow(/token/);
  });

  it('refuses two callers of one name', () => {
    expect(() =>
      cfg({
        callers: [
          { name: 'g', tokenEnv: 'A', tools: ['skills'] },
          { name: 'g', tokenEnv: 'B', tools: ['tasks'] },
        ],
      })
    ).toThrow(/caller ..?g..? is listed twice/);
  });

  it('needs a web UI for tasks, and a platform it names to be one', () => {
    const tg = { tg: { type: 'telegram', token: 'x' } };
    expect(() => cfg({ callers: [{ name: 'g', tokenEnv: 'A', tools: ['tasks'] }] }, tg)).toThrow(/no webui platform is configured/);
    // Skills and sessions alone need no topic to open.
    expect(cfg({ callers: [{ name: 'g', tokenEnv: 'A', tools: ['skills'] }] }, tg).mcp?.callers).toHaveLength(1);
    expect(cfg({ callers: [{ name: 'g', tokenEnv: 'A', tools: ['sessions'] }] }, tg).mcp?.callers).toHaveLength(1);
    expect(cfg({ callers: [{ name: 'g', tokenEnv: 'A', tools: ['skills', 'tasks', 'sessions'] }] }).mcp?.callers[0]?.tools).toEqual([
      'skills',
      'tasks',
      'sessions',
    ]);
    expect(() => cfg({ platform: 'tg', callers: [] }, { ...tg, web: { type: 'webui', token: 't' } })).toThrow(/must name a webui instance/);
  });

  it('refuses a port a platform already binds', () => {
    expect(() => cfg({ host: '0.0.0.0', port: 8787, callers: [] }, { web: { type: 'webui', token: 't' } })).toThrow(
      /mcp and platform instance ..?web..? both bind 0.0.0.0:8787/
    );
  });
});
