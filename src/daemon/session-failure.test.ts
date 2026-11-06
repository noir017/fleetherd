import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  sessionFailureMeta,
  supportsAirSessionFailures,
} from '@agentclientprotocol/claude-agent-acp/dist/session-failure-extension.js';
import {
  describeSessionFailure,
  failureNoticeKey,
  readPromptRefusal,
  readSessionFailure,
  SESSION_FAILURE_CAPABILITY_META,
  type SessionFailure,
} from './session-failure.js';

/** A record's `_meta`, shaped the way claude-agent-acp 0.81.x encodes one. */
const meta = (record: Record<string, unknown>): unknown => ({
  jetbrains: { air: { version: 1, sessionFailure: record } },
});

const failure = (over: Partial<SessionFailure> = {}): SessionFailure => ({
  id: 'p1:error',
  severity: 'warning',
  category: 'service',
  title: 'Retrying Claude, attempt 2 of 10.',
  ...over,
});

describe('readSessionFailure', () => {
  it('reads a retry warning and a terminal error', () => {
    expect(
      readSessionFailure(
        meta({ id: 'p1:error', revision: 2, category: 'service', severity: 'warning', title: 'Retrying Claude, attempt 2 of 10.', actions: [] })
      )
    ).toEqual(failure());
    expect(
      readSessionFailure(
        meta({ id: 'p1:error', revision: 3, category: 'service', severity: 'error', title: ' API Error: 503 ', actions: ['retry'] })
      )
    ).toEqual(failure({ severity: 'error', title: 'API Error: 503' }));
  });

  it('finds nothing where there is no record', () => {
    expect(readSessionFailure(undefined)).toBeUndefined();
    expect(readSessionFailure(null)).toBeUndefined();
    // What every ordinary prompt response carries: the adapter's quota report, no failure.
    expect(readSessionFailure({ quota: { token_count: {} } })).toBeUndefined();
    expect(readSessionFailure({ jetbrains: { air: { version: 1 } } })).toBeUndefined();
    expect(readSessionFailure({ jetbrains: { air: { sessionFailure: [] } } })).toBeUndefined();
  });

  it('treats a record with nothing to say as absent', () => {
    expect(readSessionFailure(meta({ id: 'x', severity: 'error', title: '   ' }))).toBeUndefined();
    expect(readSessionFailure(meta({ severity: 'error', title: 'no id' }))).toBeUndefined();
    expect(readSessionFailure(meta({ id: 'x', severity: 'error', title: 42 }))).toBeUndefined();
  });

  it('never lets an unknown severity fail a turn', () => {
    expect(readSessionFailure(meta({ id: 'x', severity: 'fatal', title: 'something new' }))?.severity).toBe(
      'warning'
    );
    expect(readSessionFailure(meta({ id: 'x', title: 'no severity' }))?.severity).toBe('warning');
  });

  it('keeps details only when there are some', () => {
    expect(readSessionFailure(meta({ id: 'x', severity: 'warning', title: 't', details: '  ' }))).not.toHaveProperty(
      'details'
    );
    expect(readSessionFailure(meta({ id: 'x', severity: 'warning', title: 't', details: 'why' }))?.details).toBe('why');
  });
});

describe('describeSessionFailure', () => {
  it('adds details that say something new, on one line', () => {
    expect(describeSessionFailure(failure({ title: 'Model fallback', details: 'opus declined;\nretried with sonnet' }))).toBe(
      'Model fallback opus declined; retried with sonnet'
    );
  });

  it('does not repeat details that only copy the title', () => {
    // A sign-out arrives with its title copied into details.
    const t = 'Sign in to continue using Claude.';
    expect(describeSessionFailure(failure({ title: t, details: t }))).toBe(t);
  });
});

describe('failureNoticeKey', () => {
  it('collapses a retry series into one notice per cause', () => {
    const attempt = (n: number, category: string): SessionFailure =>
      failure({ category, title: `Retrying Claude, attempt ${n} of 10.` });
    expect(failureNoticeKey(attempt(2, 'service'))).toBe(failureNoticeKey(attempt(3, 'service')));
    expect(failureNoticeKey(attempt(1, 'connection'))).not.toBe(failureNoticeKey(attempt(2, 'service')));
  });

  it('keeps errors apart unless they are the same record', () => {
    const a = failure({ severity: 'error', id: 's:session-error:e:1' });
    const b = failure({ severity: 'error', id: 's:session-error:e:2' });
    expect(failureNoticeKey(a)).not.toBe(failureNoticeKey(b));
    expect(failureNoticeKey(a)).toBe(failureNoticeKey({ ...a, title: 'revised' }));
    // ...and an error is never hidden behind a warning about the same thing.
    expect(failureNoticeKey(a)).not.toBe(failureNoticeKey(failure({ id: a.id })));
  });
});

describe('readPromptRefusal', () => {
  /** A prompt response the way codebuddy 2.180.0 sends one when its upstream rejects the call. */
  const refused = (errorMessage?: string) => ({
    stopReason: 'refusal',
    ...(errorMessage !== undefined ? { _meta: { 'codebuddy.ai/errorMessage': errorMessage } } : {}),
  });

  it('turns a quota rejection into a limit failure carrying the provider’s own words', () => {
    const body = JSON.stringify({
      code: -32003,
      message: 'Quota exceeded: you have used your weekly allowance',
      data: { statusCode: 429, category: 'quota' },
    });
    expect(readPromptRefusal(refused(body))).toEqual({
      reason: 'limit',
      message: 'the agent refused this request: Quota exceeded: you have used your weekly allowance',
      named: true,
    });
  });

  it('leaves an unnamed refusal as a request failure that says which stop reason it was', () => {
    // What a model's own refusal looks like: finish_reason content_filter/refusal, no provider error.
    expect(readPromptRefusal(refused())).toEqual({
      reason: 'request',
      message: 'the agent refused this request (stopReason: refusal)',
      named: false,
    });
    expect(readPromptRefusal({ stopReason: 'refusal', _meta: { quota: { token_count: {} } } })).toEqual({
      reason: 'request',
      message: 'the agent refused this request (stopReason: refusal)',
      named: false,
    });
  });

  it('classifies the other causes CodeBuddy names, including the families', () => {
    const at = (data: Record<string, unknown>) =>
      readPromptRefusal(refused(JSON.stringify({ message: 'upstream said no', data })))?.reason;
    expect(at({ category: 'auth' })).toBe('access');
    expect(at({ category: 'auth_expired' })).toBe('access');
    expect(at({ category: 'custom_model_auth' })).toBe('access');
    expect(at({ category: 'quota_token_limit' })).toBe('limit');
    expect(at({ category: 'quota_balance_exhausted' })).toBe('limit');
    expect(at({ category: 'quota_request_limit' })).toBe('limit');
    expect(at({ category: 'quota_active_session' })).toBe('limit');
    expect(at({ category: 'network' })).toBe('connection');
    expect(at({ category: 'model_service' })).toBe('service');
    expect(at({ category: 'empty_model_response' })).toBe('service');
    expect(at({ category: 'internal' })).toBe('provider');
    // A body that carries only an HTTP status still classifies; CodeBuddy calls 408/502/503/504 a
    // network error, not a model-service one.
    expect(at({ statusCode: 401 })).toBe('access');
    expect(at({ statusCode: 429 })).toBe('limit');
    expect(at({ statusCode: 408 })).toBe('connection');
    expect(at({ statusCode: 503 })).toBe('connection');
  });

  it('reads a plain string under CodeBuddy’s key, and ignores every other key', () => {
    expect(readPromptRefusal(refused('the model is not available'))).toEqual({
      reason: 'provider',
      message: 'the agent refused this request: the model is not available',
      named: true,
    });
    // A blocked sensitive input arrives as a plain namespaced string too (no category), and reads
    // as `provider` — still a refused turn, never an answered one.
    expect(readPromptRefusal(refused('This prompt contains sensitive information.'))).toEqual({
      reason: 'provider',
      message: 'the agent refused this request: This prompt contains sensitive information.',
      named: true,
    });
    // The unnamespaced key is not ours: it does not survive to the wire, and another harness may
    // put anything there.
    expect(
      readPromptRefusal({ stopReason: 'refusal', _meta: { errorMessage: 'local command failed' } })
    ).toEqual({
      reason: 'request',
      message: 'the agent refused this request (stopReason: refusal)',
      named: false,
    });
  });

  it('never turns JSON it cannot read into chat text', () => {
    expect(readPromptRefusal(refused('{"code":-32003,"data":{}}'))).toEqual({
      reason: 'request',
      message: 'the agent refused this request (stopReason: refusal)',
      named: false,
    });
    expect(readPromptRefusal({ stopReason: 'refusal', _meta: 'nonsense' })).toEqual({
      reason: 'request',
      message: 'the agent refused this request (stopReason: refusal)',
      named: false,
    });
  });

  it('ignores every other way a prompt can end', () => {
    expect(readPromptRefusal(undefined)).toBeUndefined();
    expect(readPromptRefusal({ stopReason: 'end_turn' })).toBeUndefined();
    expect(readPromptRefusal({ stopReason: 'cancelled' })).toBeUndefined();
    expect(readPromptRefusal({ stopReason: 'max_tokens' })).toBeUndefined();
  });
});

/**
 * Hyrum's Law guards for a private extension (see session-failure.ts). Each one fails loudly in
 * the case where the gateway would otherwise lose the records without noticing, and a retry loop
 * would read as a hang again.
 */
describe('the installed claude-agent-acp (contract)', () => {
  it('accepts the capability the gateway advertises', () => {
    // The whole object runtime sends at initialize, not just the `_meta` part.
    const capabilities = {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      elicitation: { form: {} },
      _meta: SESSION_FAILURE_CAPABILITY_META,
    };
    expect(supportsAirSessionFailures(capabilities)).toBe(true);
    // ...and only because of it: without the key the adapter keeps its legacy contract.
    expect(supportsAirSessionFailures({ ...capabilities, _meta: undefined })).toBe(false);
  });

  it('encodes records the way the gateway reads them', () => {
    const encoded = sessionFailureMeta({
      id: 'p1:error',
      revision: 4,
      category: 'service',
      severity: 'error',
      title: 'API Error: 503',
      details: 'no available channel',
      actions: ['retry'],
    } as Parameters<typeof sessionFailureMeta>[0]);
    expect(readSessionFailure(encoded)).toEqual({
      id: 'p1:error',
      severity: 'error',
      category: 'service',
      title: 'API Error: 503',
      details: 'no available channel',
    });
  });

  it('still sends retries as records, and settles a failed turn as end_turn with one', () => {
    const dist = readFileSync(
      createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'),
      'utf8'
    );
    // The fix for the false "hung": each api_retry becomes a warning record.
    const retry = dist.indexOf('case "api_retry"');
    expect(retry).toBeGreaterThan(0);
    expect(dist.slice(retry, retry + 2500)).toContain('publishSessionFailure(kind, { title, severity: "warning" })');
    // The reason runTurn must read the prompt response: a failed turn RESOLVES once a client asks
    // for records. If this ever goes back to a rejection, the read is harmless; if the shape moves,
    // failed turns would be reported as successes.
    expect(dist).toContain('settleActive(turnOutcome(session, "end_turn", sessionFailureMeta(failure)), "providerError")');
  });
});

/**
 * The other private contract: CodeBuddy's refusal shape (see session-failure.ts). The installed
 * package lives outside this project's node_modules, so a machine without it skips the suite rather
 * than failing. What it guards is exactly what the reader depends on — that a refusal is still a
 * `stopReason` value, that the cause is still under `codebuddy.ai/errorMessage`, and that a quota
 * rejection still arrives as `category: "quota"`. Renaming any of them would otherwise degrade to
 * the unnamed refusal and read as a model declining.
 */
/**
 * Where the installed CodeBuddy keeps its bundle. Found through the `codebuddy` a PATH lookup would
 * run (the package root is outside this project's node_modules), with the packaged path as a
 * fallback for a machine that did not link the binary. Undefined means "not installed here": the
 * suite says so once and skips, rather than failing on a machine that never had it.
 */
function findCodeBuddyDist(): string | undefined {
  const candidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, 'codebuddy'));
  candidates.push('/opt/ua/codebuddy/current/bin/codebuddy');
  for (const bin of candidates) {
    try {
      // realpath resolves the launcher symlink; the bundle sits one level above bin/.
      const packageRoot = resolve(dirname(realpathSync(bin)), '..');
      const dist = join(packageRoot, 'dist', 'codebuddy-headless.js');
      if (existsSync(dist)) return dist;
    } catch {
      // Not here, or a dangling link: try the next one.
    }
  }
  return undefined;
}

const CODEBUDDY_DIST = findCodeBuddyDist();
if (!CODEBUDDY_DIST) {
  console.log(
    '[session-failure.test] skipping the CodeBuddy contract: no codebuddy on PATH and no install at /opt/ua/codebuddy/current'
  );
}
let codebuddyDist: string | undefined;
const readCodeBuddyDist = (): string => (codebuddyDist ??= readFileSync(CODEBUDDY_DIST!, 'utf8'));

describe.skipIf(!CODEBUDDY_DIST)('the installed CodeBuddy (contract)', () => {
  it('still turns a refusal finish reason into stopReason "refusal"', () => {
    expect(readCodeBuddyDist()).toMatch(/case\s*"content_filter"\s*:\s*case\s*"refusal"\s*:\s*return\s*"refusal"/);
    expect(readCodeBuddyDist()).toMatch(/stopReason\s*:\s*"refusal"/);
  });

  it('still carries the provider error under codebuddy.ai/errorMessage', () => {
    expect(readCodeBuddyDist()).toMatch(/_meta\["codebuddy\.ai\/errorMessage"\]/);
  });

  it('still classifies a quota rejection as category "quota"', () => {
    expect(readCodeBuddyDist()).toMatch(/category\s*:\s*"quota"/);
    expect(readCodeBuddyDist()).toContain('Quota exceeded: ');
  });
});
