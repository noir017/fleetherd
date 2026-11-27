import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { harnessLogProbe, readHarnessErrors } from './harness-log.js';
import { parseOpencodeLog } from './harness/opencode.js';
import type { AgentDef } from '../config/schema.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();

/**
 * Reading a harness's own log to explain a turn the gateway went blind on.
 *
 * Every line below is VERBATIM from `~/.local/share/opencode/log/opencode.log` on opencode 1.18.30
 * (captured 2026-09-17 while reproducing the rate-limit incident), because the whole value of this
 * module is that it matches a format nobody documents — a fixture written from memory would pin the
 * format this code expects rather than the one opencode emits. The one edit made to any of them is
 * called out where it happens.
 */

const def = (over: Partial<AgentDef> = {}): AgentDef =>
  ({ id: 'oc', harness: 'opencode', args: [], env: {}, ...over }) as AgentDef;

/** The session that hung in the report. */
const SESSION = 'ses_f50ad7853ffe6X1R7a1EXaR7CF';

/** The rate limit, on the main (`small=false`) stream — the line the incident turned on. */
const RATE_LIMIT =
  'timestamp=2026-09-17T12:23:38.570Z level=ERROR run=fc674adf message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free session.id=ses_f50ad7853ffe6X1R7a1EXaR7CF small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."';

/** opencode titling the session with its small model; a failed title is not a failed turn. */
const TITLE_RETRY =
  'timestamp=2026-09-17T12:23:43.277Z level=ERROR run=fc674adf message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free session.id=ses_f50ad7853ffe6X1R7a1EXaR7CF small=true agent=title mode=primary error.error="AI_RetryError: Failed after 3 attempts. Last error: Rate limit exceeded. Please try again later."';

/** A different conversation failing at the same moment. */
const OTHER_SESSION =
  'timestamp=2026-09-17T14:09:49.346Z level=ERROR run=c4a371a0 message="stream error" providerID=opencode modelID=mimo-v2.5-free session.id=ses_f504c4536ffeUbHlGWdmRoSHDm small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."';

/**
 * An ERROR carrying neither `session.id` nor `error.error` — opencode logs plenty of these, and
 * they must not be mistaken for a turn's reason.
 */
const NO_SESSION =
  'timestamp=2026-09-17T02:30:37.924Z level=ERROR run=0c5529f7 message="Failed to fetch models.dev" cause="Cause([Fail(HttpClientError: Transport error (GET https://models.opencode.ai/api.json) (cause: Error: UnsupportedProxyProtocol fetching \\"https://models.opencode.ai/api.json\\". For more information, pass `verbose: true` in the second argument to fetch()))])"';

/**
 * Escaped quotes inside the reason. Verbatim except for `small=true` → `small=false` and the
 * session id, so the main-stream path is what gets exercised: every real escaped-quote line on this
 * machine happened to be a title call, and the escaping is a property of the format, not of which
 * model produced it.
 */
const ESCAPED_QUOTES =
  'timestamp=2026-09-17T14:09:33.605Z level=ERROR run=757f9c79 message="stream error" providerID=newapi modelID=deepseek-v4-flash-0731 session.id=ses_f50ad7853ffe6X1R7a1EXaR7CF small=false agent=build mode=primary error.error="TypeError [ERR_INVALID_URL]: \\"/chat/completions\\" cannot be parsed as a URL."';

/** Before every timestamp above, so nothing is filtered on age unless a test asks for it. */
const BEFORE = new Date('2026-09-17T00:00:00.000Z');

/** A tail always begins mid-line, so fixtures get a sacrificial first line. */
const tail = (...lines: string[]): string => ['…truncated first line', ...lines].join('\n');

describe('parseOpencodeLog', () => {
  it('finds the reason a hung turn never reported', () => {
    const events = parseOpencodeLog(tail(RATE_LIMIT), SESSION, BEFORE);
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe('AI_APICallError: Rate limit exceeded. Please try again later.');
    expect(events[0]?.at.toISOString()).toBe('2026-09-17T12:23:38.570Z');
  });

  it('ignores the small model opencode titles a session with', () => {
    // Both lines land within milliseconds during a rate limit; reporting the title failure too
    // doubled every notice for something the user cannot act on.
    expect(parseOpencodeLog(tail(TITLE_RETRY), SESSION, BEFORE)).toEqual([]);
  });

  it('ignores another conversation failing at the same moment', () => {
    // The log is shared by every session on the machine — this is the whole reason it is keyed.
    expect(parseOpencodeLog(tail(OTHER_SESSION), SESSION, BEFORE)).toEqual([]);
  });

  it('ignores errors older than the turn', () => {
    // Otherwise a conversation that hit a rate limit yesterday would blame it for today's timeout.
    const since = new Date('2026-09-17T13:00:00.000Z');
    expect(parseOpencodeLog(tail(RATE_LIMIT), SESSION, since)).toEqual([]);
  });

  it('unescapes quotes inside the reason', () => {
    const events = parseOpencodeLog(tail(ESCAPED_QUOTES), SESSION, BEFORE);
    expect(events[0]?.reason).toBe('TypeError [ERR_INVALID_URL]: "/chat/completions" cannot be parsed as a URL.');
  });

  it('skips errors that name no session and no reason', () => {
    expect(parseOpencodeLog(tail(NO_SESSION), SESSION, BEFORE)).toEqual([]);
  });

  it('drops the first line, which a tail read always cuts in half', () => {
    // The fixture's first line IS a complete match; it must still be discarded, because at the
    // read boundary the same bytes could just as easily be the tail of a longer, different line.
    expect(parseOpencodeLog([RATE_LIMIT, RATE_LIMIT].join('\n'), SESSION, BEFORE)).toHaveLength(1);
  });

  it('survives garbage without throwing', () => {
    expect(parseOpencodeLog('level=ERROR\n\nnot a log line at all\n', SESSION, BEFORE)).toEqual([]);
  });

  it('keeps several errors from one turn in order', () => {
    const events = parseOpencodeLog(tail(RATE_LIMIT, TITLE_RETRY, ESCAPED_QUOTES), SESSION, BEFORE);
    expect(events.map((e) => e.at.toISOString())).toEqual([
      '2026-09-17T12:23:38.570Z',
      '2026-09-17T14:09:33.605Z',
    ]);
  });
});

describe('harnessLogProbe', () => {
  it('locates opencode’s log under the XDG data dir', () => {
    expect(harnessLogProbe('opencode')?.logPath('/h', {})).toBe('/h/.local/share/opencode/log/opencode.log');
  });

  it('honours XDG_DATA_HOME', () => {
    expect(harnessLogProbe('opencode')?.logPath('/h', { XDG_DATA_HOME: '/data' })).toBe(
      '/data/opencode/log/opencode.log'
    );
  });

  it('has nothing to say about harnesses that report their own failures', () => {
    // claude-agent-acp rejects the prompt with its reason, so the turn already fails with one.
    expect(harnessLogProbe('claude')).toBeUndefined();
    expect(harnessLogProbe('agy')).toBeUndefined();
  });
});

describe('readHarnessErrors', () => {
  it('reads the reason out of a real log layout', async () => {
    const home = makeTempDir('harness-log-');
    const dir = join(home, '.local', 'share', 'opencode', 'log');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.log'), tail(RATE_LIMIT));
    const events = await readHarnessErrors(def({ env: { HOME: home } }), SESSION, BEFORE, {});
    expect(events[0]?.reason).toBe('AI_APICallError: Rate limit exceeded. Please try again later.');
  });

  it('says nothing when the harness keeps no log the daemon knows about', async () => {
    expect(await readHarnessErrors(def({ harness: 'claude' }), SESSION, BEFORE, {})).toEqual([]);
  });

  it('says nothing before a session id exists', async () => {
    expect(await readHarnessErrors(def(), undefined, BEFORE, {})).toEqual([]);
  });

  it('says nothing when the log file is absent', async () => {
    // opencode installed but never run, or a moved log: the turn reports its timeout unchanged.
    const home = makeTempDir('harness-log-');
    expect(await readHarnessErrors(def({ env: { HOME: home } }), SESSION, BEFORE, {})).toEqual([]);
  });
});
