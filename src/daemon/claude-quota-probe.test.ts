import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentDef } from '../config/schema.js';
import { CLAUDE_PROBE_MODEL, CLAUDE_PROBE_SCRIPT, parseClaudeProbe, readClaudeQuota } from './claude-quota-probe.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();
// 2026-11-28T15:00:00Z and a week later, in seconds as the headers carry them.
const R5 = 1_795_878_000;
const R7 = R5 + 7 * 86_400;
const OK = [
  'HTTP/1.1 200 OK',
  'Content-Type: application/json',
  'Anthropic-Ratelimit-Unified-Status: allowed',
  'anthropic-ratelimit-unified-5h-utilization: 0.4',
  `anthropic-ratelimit-unified-5h-reset: ${R5}`,
  'anthropic-ratelimit-unified-7d-utilization: 0.75',
  `anthropic-ratelimit-unified-7d-reset: ${R7}`,
  '',
].join('\r\n');

describe('parseClaudeProbe', () => {
  it('reads the 5h / 7d headers into the same pools claude’s own rate-limit events give', () => {
    expect(parseClaudeProbe(OK)).toEqual({
      ok: true,
      pools: [
        { id: 'claude-5h', remaining: 0.6, resetsAt: R5 * 1000 },
        { id: 'claude-weekly', remaining: 0.25, resetsAt: R7 * 1000 },
      ],
    });
  });

  it('reads the last header block, after a proxy’s CONNECT or a 100 Continue', () => {
    const out = `HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 100 Continue\r\n\r\n${OK}`;
    expect(parseClaudeProbe(out)).toMatchObject({ ok: true });
  });

  it('reads a rejected window with no utilization as spent', () => {
    const out = [
      'HTTP/2 200',
      'anthropic-ratelimit-unified-status: rejected',
      'anthropic-ratelimit-unified-representative-claim: five_hour',
      `anthropic-ratelimit-unified-5h-reset: ${R5}`,
      '',
    ].join('\n');
    expect(parseClaudeProbe(out)).toEqual({ ok: true, pools: [{ id: 'claude-5h', remaining: 0, resetsAt: R5 * 1000 }] });
  });

  it('fails anything but a 200, and never turns it into a reading', () => {
    const out = `HTTP/1.1 429 Too Many Requests\r\nanthropic-ratelimit-unified-5h-utilization: 1\r\n\r\n`;
    expect(parseClaudeProbe(out)).toEqual({ ok: false, reason: 'probe answered HTTP 429' });
    expect(parseClaudeProbe('')).toMatchObject({ ok: false });
    expect(parseClaudeProbe('')).not.toHaveProperty('final');
  });

  it('gives up for good on a relay that answers without the headers, and on an agent with no relay', () => {
    expect(parseClaudeProbe('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n')).toMatchObject({ ok: false, final: true });
    expect(parseClaudeProbe('fleetherd-probe: no relay\n')).toMatchObject({ ok: false, final: true });
  });
});

/** A `curl` that records its argv and stdin, and prints the given answer as `-D -` would. */
function fakeCurl(answer: string): { dir: string; argv: () => string; stdin: () => string } {
  const dir = makeTempDir();
  writeFileSync(join(dir, 'answer'), answer);
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\ncat "${dir}/answer"\n`,
  );
  chmodSync(join(dir, 'curl'), 0o755);
  return { dir, argv: () => readFileSync(join(dir, 'argv'), 'utf8'), stdin: () => readFileSync(join(dir, 'stdin'), 'utf8') };
}

const agent = (env: Record<string, string>, dir: string) =>
  ({ id: 'cc', harness: 'claude', env: { PATH: `${dir}:${process.env.PATH ?? ''}`, ...env } }) as unknown as AgentDef;

describe.skipIf(process.platform === 'win32')('the probe on the agent’s machine', () => {
  it('sends the key only as curl config on stdin — never in a process’s argv', async () => {
    const curl = fakeCurl(OK);
    const def = agent({ ANTHROPIC_BASE_URL: 'http://relay.invalid:3000/', ANTHROPIC_API_KEY: 'sk-test-secret', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_DEFAULT_HAIKU_MODEL: '' }, curl.dir);
    const r = await readClaudeQuota(def, curl.dir);
    expect(r).toMatchObject({ ok: true });
    expect(curl.argv()).not.toContain('sk-test-secret');
    expect(curl.argv()).toContain('http://relay.invalid:3000/v1/messages');
    expect(curl.argv()).toContain(`{"model":"${CLAUDE_PROBE_MODEL}","max_tokens":1,"messages":[{"role":"user","content":"hello"}]}`);
    expect(curl.stdin()).toBe('header = "x-api-key: sk-test-secret"\n');
    // The script itself names the variables, never their values.
    expect(CLAUDE_PROBE_SCRIPT).not.toContain('sk-');
  });

  it('uses ANTHROPIC_AUTH_TOKEN as a bearer token and ANTHROPIC_DEFAULT_HAIKU_MODEL as the model', async () => {
    const curl = fakeCurl(OK);
    const def = agent(
      { ANTHROPIC_BASE_URL: 'http://relay.invalid', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-x' },
      curl.dir,
    );
    await readClaudeQuota(def, curl.dir);
    expect(curl.stdin()).toBe('header = "authorization: Bearer tok"\n');
    expect(curl.argv()).toContain('"model":"haiku-x"');
  });

  it('says there is no relay, without calling curl, when ANTHROPIC_BASE_URL is unset', async () => {
    const curl = fakeCurl(OK);
    const r = await readClaudeQuota(agent({ ANTHROPIC_BASE_URL: '' }, curl.dir), curl.dir);
    expect(r).toMatchObject({ ok: false, final: true });
    expect(() => curl.argv()).toThrow();
  });

  it('fails, without sending anything, for a model name that could break out of the request body', async () => {
    const curl = fakeCurl(OK);
    const def = agent({ ANTHROPIC_BASE_URL: 'http://relay.invalid', ANTHROPIC_API_KEY: 'k', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x","max_tokens":9999' }, curl.dir);
    const r = await readClaudeQuota(def, curl.dir);
    expect(r).toMatchObject({ ok: false });
    expect(r).not.toHaveProperty('final');
    expect(() => curl.argv()).toThrow();
  });
});
