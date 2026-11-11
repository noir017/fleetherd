import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentDefSchema } from '../config/schema.js';
import {
  cacheExpiryFromLines,
  claudeProjectsDir,
  findTranscript,
  projectSlug,
  readCacheExpiry,
} from './claude-transcript.js';

/**
 * Entry shapes captured from Claude Code 2.1.291 transcripts on this machine (2026-10-08), cut
 * down to the fields the reader looks at plus enough of the rest to be recognisable. The format is
 * Claude Code's private one (see the Hyrum's Law note in claude-transcript.ts), so these are what
 * fails first when it moves.
 */
const HOUR = 60 * 60 * 1000;
const MIN5 = 5 * 60 * 1000;

function user(at: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', timestamp: at, isSidechain: false, message: { role: 'user', content: 'x' }, ...extra });
}

function assistant(
  at: string,
  id: string,
  usage: { read?: number; write1h?: number; write5m?: number; input?: number },
  extra: Record<string, unknown> = {}
): string {
  const write1h = usage.write1h ?? 0;
  const write5m = usage.write5m ?? 0;
  return JSON.stringify({
    type: 'assistant',
    timestamp: at,
    isSidechain: false,
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: usage.input ?? 2,
        cache_creation_input_tokens: write1h + write5m,
        cache_read_input_tokens: usage.read ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
        output_tokens: 5,
        service_tier: 'standard',
      },
    },
    ...extra,
  });
}

const attachment = (at: string) => JSON.stringify({ type: 'attachment', timestamp: at });
const t = (iso: string) => Date.parse(iso);

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

describe('cacheExpiryFromLines', () => {
  it('is the time the last request went out plus the TTL it wrote with', () => {
    const lines = [
      user('2026-10-08T06:19:46.000Z'),
      assistant('2026-10-08T06:19:53.564Z', 'msg_1', { read: 30087, write1h: 9507 }),
    ];
    expect(cacheExpiryFromLines(lines)).toEqual({ expiresAt: t('2026-10-08T06:19:46.000Z') + HOUR, ttlMs: HOUR });
  });

  it('dates the request from what it answered, not from when a long response finished', () => {
    // Verbatim timing from this machine: a tool result at 06:37:47.622, then a response that
    // thought until 06:38:39 and was written as three entries under one message id. The request
    // went out at 06:37:47; dating it 52s later would overstate a 5-minute cache by a sixth.
    const lines = [
      assistant('2026-10-08T06:37:43.463Z', 'msg_a', { read: 253183, write1h: 559 }),
      user('2026-10-08T06:37:47.622Z'),
      attachment('2026-10-08T06:37:47.531Z'),
      assistant('2026-10-08T06:38:39.955Z', 'msg_b', { read: 254460, write1h: 288 }),
      assistant('2026-10-08T06:38:39.970Z', 'msg_b', { read: 254460, write1h: 288 }),
      assistant('2026-10-08T06:38:43.100Z', 'msg_b', { read: 254460, write1h: 288 }),
    ];
    expect(cacheExpiryFromLines(lines)?.expiresAt).toBe(t('2026-10-08T06:37:47.622Z') + HOUR);
  });

  it('takes a pure read’s TTL from the last request that wrote', () => {
    // A request that only read the cache renews it at the TTL it was written with, and says nothing
    // about that TTL itself.
    const lines = [
      user('2026-10-08T07:00:00.000Z'),
      assistant('2026-10-08T07:00:05.000Z', 'msg_1', { read: 1000, write5m: 400 }),
      user('2026-10-08T07:02:00.000Z'),
      assistant('2026-10-08T07:02:04.000Z', 'msg_2', { read: 1400 }),
    ];
    expect(cacheExpiryFromLines(lines)).toEqual({ expiresAt: t('2026-10-08T07:02:00.000Z') + MIN5, ttlMs: MIN5 });
  });

  it('skips Claude Code’s own synthetic entries, which no request produced', () => {
    const lines = [
      user('2026-10-08T07:00:00.000Z'),
      assistant('2026-10-08T07:00:05.000Z', 'msg_1', { read: 1000, write1h: 400 }),
      user('2026-10-08T07:10:00.000Z'),
      // An API error reported as a message: model `<synthetic>`, usage all zeros.
      assistant('2026-10-08T07:10:01.000Z', 'msg_err', { input: 0 }),
    ];
    expect(cacheExpiryFromLines(lines)?.expiresAt).toBe(t('2026-10-08T07:00:00.000Z') + HOUR);
  });

  it('ignores a subagent’s sidechain entries — they are not this conversation’s cache', () => {
    const lines = [
      user('2026-10-08T07:00:00.000Z'),
      assistant('2026-10-08T07:00:05.000Z', 'msg_1', { read: 1000, write1h: 400 }),
      user('2026-10-08T07:20:00.000Z', { isSidechain: true }),
      assistant('2026-10-08T07:20:05.000Z', 'msg_side', { read: 50, write5m: 50 }, { isSidechain: true }),
    ];
    expect(cacheExpiryFromLines(lines)).toEqual({ expiresAt: t('2026-10-08T07:00:00.000Z') + HOUR, ttlMs: HOUR });
  });

  it('says nothing when there is nothing to say, rather than inventing an expiry', () => {
    // No request at all, a request that touched no cache, and lines that are not entries.
    expect(cacheExpiryFromLines([user('2026-10-08T07:00:00.000Z')])).toBeUndefined();
    expect(
      cacheExpiryFromLines([user('2026-10-08T07:00:00.000Z'), assistant('2026-10-08T07:00:01.000Z', 'm', { input: 900 })])
    ).toBeUndefined();
    expect(cacheExpiryFromLines(['', 'not json', '[]', '{"type":"assistant"}'])).toBeUndefined();
  });
});

describe('locating the transcript', () => {
  it('files a directory the way Claude Code does — every non-alphanumeric becomes "-"', () => {
    // Both are directory names that exist under ~/.claude/projects on this machine.
    expect(projectSlug('/home/user/workspace/fleetherd')).toBe('-home-user-workspace-fleetherd');
    expect(projectSlug('/home/user/workspace/AutoAnything')).toBe('-home-user-workspace-AutoAnything');
  });

  it('finds it under the slug, and by scanning when the slug misses', async () => {
    const projects = mkdtempSync(join(tmpdir(), 'aa-cc-projects-'));
    const sid = 'edab7e2b-fb5d-4594-9184-32e8999573a7';
    mkdirSync(join(projects, projectSlug('/w/a')));
    writeFileSync(join(projects, projectSlug('/w/a'), `${sid}.jsonl`), '');
    expect(await findTranscript(projects, '/w/a', sid)).toBe(join(projects, '-w-a', `${sid}.jsonl`));

    // A shortened or re-ruled directory name: found by the file name, which is the session id.
    const other = 'c8b4c5bc-e89d-410a-aed1-fa658d3f6979';
    mkdirSync(join(projects, 'shortened-name-1a2b'));
    writeFileSync(join(projects, 'shortened-name-1a2b', `${other}.jsonl`), '');
    expect(await findTranscript(projects, '/some/very/long/path', other)).toBe(
      join(projects, 'shortened-name-1a2b', `${other}.jsonl`)
    );
    expect(await findTranscript(projects, '/w/a', '00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('refuses a session id that is not id-shaped instead of joining it into a path', async () => {
    const projects = mkdtempSync(join(tmpdir(), 'aa-cc-projects-'));
    expect(await findTranscript(projects, '/w', '../../etc/passwd')).toBeUndefined();
  });

  it('reads the agent’s own Claude Code directory: CLAUDE_CONFIG_DIR, else its HOME', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const base = { id: 'cc', harness: 'claude', cwd: '/w' };
    const homed = AgentDefSchema.parse({ ...base, env: { HOME: '/home/other' } });
    expect(claudeProjectsDir(homed)).toBe('/home/other/.claude/projects');
    const configured = AgentDefSchema.parse({ ...base, env: { CLAUDE_CONFIG_DIR: '/srv/cc' } });
    expect(claudeProjectsDir(configured)).toBe('/srv/cc/projects');
  });
});

describe('readCacheExpiry', () => {
  it('reads only the end of a long transcript, and copes with the window cutting a line', async () => {
    const projects = mkdtempSync(join(tmpdir(), 'aa-cc-projects-'));
    const sid = 'cd4f9d58-d378-4a0e-85a6-7093515432a8';
    mkdirSync(join(projects, '-w'));
    // A 2 MB tool result first — the window starts inside it, so its tail is a broken line.
    const huge = user('2026-10-08T05:00:00.000Z', { toolUseResult: 'x'.repeat(2 * 1024 * 1024) });
    const lines = [
      huge,
      user('2026-10-08T06:00:00.000Z'),
      assistant('2026-10-08T06:00:09.000Z', 'msg_1', { read: 5, write1h: 5 }),
    ];
    writeFileSync(join(projects, '-w', `${sid}.jsonl`), lines.join('\n') + '\n');
    expect(await readCacheExpiry(projects, '/w', sid)).toEqual({
      expiresAt: t('2026-10-08T06:00:00.000Z') + HOUR,
      ttlMs: HOUR,
    });
  });

  it('resolves to nothing, never rejects, when there is no transcript', async () => {
    await expect(readCacheExpiry('/nonexistent/projects', '/w', 'edab7e2b-fb5d-4594-9184-32e8999573a7')).resolves.toBeUndefined();
  });
});
