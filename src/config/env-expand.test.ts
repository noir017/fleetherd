import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDotEnvDelta, dotEnvDelta, expandEnvVars, loadDotEnv } from './env-expand.js';

describe('expandEnvVars', () => {
  const env = { DISCORD_TOKEN: 'tok-123', EMPTY: '' } as NodeJS.ProcessEnv;

  it('expands ${VAR} inside strings anywhere in the tree', () => {
    const out = expandEnvVars(
      {
        platforms: { d: { token: '${DISCORD_TOKEN}', list: ['a-${DISCORD_TOKEN}'] } },
        n: 42,
        b: true,
        nil: null,
      },
      env
    ) as Record<string, unknown>;
    expect(out).toEqual({
      platforms: { d: { token: 'tok-123', list: ['a-tok-123'] } },
      n: 42,
      b: true,
      nil: null,
    });
  });

  it('an empty-string env var is defined (expands to ""), not missing', () => {
    expect(expandEnvVars('x${EMPTY}y', env)).toBe('xy');
  });

  it('escapes $${VAR} to a literal ${VAR} without consulting the environment', () => {
    expect(expandEnvVars('keep $${NOT_SET} as-is', env)).toBe('keep ${NOT_SET} as-is');
  });

  it('lowercase / malformed references are left untouched (only ${UPPER_CASE} is a reference)', () => {
    expect(expandEnvVars('${lower} $NOPE {X}', env)).toBe('${lower} $NOPE {X}');
  });

  it('aggregates ALL missing variables into one error with their config paths', () => {
    expect(() =>
      expandEnvVars({ a: '${MISS_ONE}', b: { c: ['${MISS_TWO}'] } }, env)
    ).toThrowError(/MISS_ONE[\s\S]*MISS_TWO/);
    try {
      expandEnvVars({ a: '${MISS_ONE}', b: { c: ['${MISS_TWO}'] } }, env);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('a: ${MISS_ONE}');
      expect(msg).toContain('b.c[0]: ${MISS_TWO}');
    }
  });
});

describe('loadDotEnv', () => {
  it('fills gaps but never overrides existing process env; parses quotes/comments/export', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-dotenv-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      [
        '# comment',
        'PLAIN=one',
        'QUOTED="two words"',
        "SINGLE='three'",
        'export EXPORTED=four',
        'ALREADY=from-file',
        'not a valid line',
        '',
      ].join('\n')
    );
    const env: NodeJS.ProcessEnv = { ALREADY: 'from-process' };
    loadDotEnv(dir, env);
    expect(env.PLAIN).toBe('one');
    expect(env.QUOTED).toBe('two words');
    expect(env.SINGLE).toBe('three');
    expect(env.EXPORTED).toBe('four');
    expect(env.ALREADY).toBe('from-process'); // process wins
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when no .env exists', () => {
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(path.join(os.tmpdir(), 'fleetherd-definitely-missing'), env);
    expect(env).toEqual({});
  });
});

describe('reloading .env (dotEnvDelta)', () => {
  it('updates and drops what the sidecar supplied, never what the process was started with', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-dotenv-reload-'));
    const file = path.join(dir, '.env');
    const env: NodeJS.ProcessEnv = { REAL: 'from-process' };
    fs.writeFileSync(file, 'A=one\nB=gone-soon\nREAL=from-file\n');
    loadDotEnv(dir, env);
    expect(env).toEqual({ REAL: 'from-process', A: 'one', B: 'gone-soon' });

    fs.writeFileSync(file, 'A=two\nREAL=from-file-again\n');
    const delta = dotEnvDelta(dir, env);
    // Computing it changes nothing: a reload validates first.
    expect(env.A).toBe('one');
    expect(delta.set).toEqual({ A: 'two' });
    expect(delta.unset).toEqual(['B']);

    applyDotEnvDelta(env, delta);
    expect(env).toEqual({ REAL: 'from-process', A: 'two' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
