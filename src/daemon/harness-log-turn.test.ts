import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAcpAgentFactory } from './agent-acp.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { AgentSession, AgentStreamHandlers } from './agent.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();

/**
 * A turn that times out because the harness went quiet, and what the user is told about it.
 *
 * Driven against a real child process rather than a stubbed session, because the thing under test
 * is an ORDER: the harness's log has to be read while the ACP session id still exists, and
 * `dispose()` destroys it. A unit test of the parser cannot catch getting that backwards — it was
 * the one way this change could have shipped looking correct and reporting nothing.
 *
 * The fake agent below is an opencode stand-in: `resolveHarness` hardcodes `opencode acp`, so the
 * only honest way to exercise the opencode path is to put a fake `opencode` first on PATH.
 */

const FAKE_OPENCODE = `#!/usr/bin/env node
const readline = require('node:readline');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
    return;
  }
  // session/prompt: answer nothing, ever. This is what a rate-limited opencode looks like from
  // outside — it neither settles the prompt nor rejects it, it just retries out of sight.
});
`;

/**
 * One opencode log line. Structure is verbatim from the live log (opencode 1.18.30, 2026-09-17);
 * the timestamp and session id MUST be substituted rather than kept, because those two fields are
 * exactly what the reader filters on — a frozen timestamp would be "older than this turn" and a
 * frozen session id would belong to another conversation.
 */
const logLine = (at: Date, sessionId: string, reason: string, small = false): string =>
  `timestamp=${at.toISOString()} level=ERROR run=fc674adf message="stream error" providerID=opencode ` +
  `modelID=muse-spark-1.3-contributor-free session.id=${sessionId} small=${small} agent=build mode=primary ` +
  `error.error="${reason}"`;

const RATE_LIMIT = 'AI_APICallError: Rate limit exceeded. Please try again later.';

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

/** A conversation bound to an `opencode` agent whose binary and log are both ours. */
function rig(log: string[]): { session: AgentSession } {
  const dir = makeTempDir('aa-harness-log-');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'opencode');
  writeFileSync(script, FAKE_OPENCODE);
  chmodSync(script, 0o755);

  const home = join(dir, 'home');
  const logDir = join(home, '.local', 'share', 'opencode', 'log');
  mkdirSync(logDir, { recursive: true });
  // A tail read always discards its first line, so the fixture needs one to spare.
  writeFileSync(join(logDir, 'opencode.log'), ['…earlier output', ...log].join('\n'));

  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      {
        id: 'oc',
        harness: 'opencode',
        cwd: dir,
        // HOME points agentHome at our fake tree; PATH puts our fake binary ahead of any real one.
        env: { HOME: home, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      },
    ],
    routing: { default: 'oc', pipeline: [] },
  });
  // turnTimeoutMs is frozen in EXPERIENCE and not reachable from config.yaml, so the runtime Config
  // is patched directly rather than pretending an operator could set it.
  const cfg: Config = { ...parsed, session: { ...parsed.session, turnTimeoutMs: 400 } };

  const store = {
    agentSession: () => undefined,
    setAgentSession: () => {},
    conversationCwd: () => undefined,
  } as unknown as Parameters<typeof createAcpAgentFactory>[2];

  const session = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store, { provisions: [] }).getOrCreate('conv#1', 'oc');
  live = session;
  return { session };
}

/** The handlers a turn needs, recording only what this test asks about. */
function handlers(): AgentStreamHandlers & { notices: string[] } {
  const notices: string[] = [];
  return {
    notices,
    onText: () => {},
    onToolStart: () => {},
    onToolFinish: () => {},
    onSegmentBreak: () => {},
    onNotice: (text) => notices.push(text),
  };
}

describe('a turn that times out on a silent harness', () => {
  it('reports what opencode logged instead of only "hung"', async () => {
    // Recorded one second into the turn, which is the case that matters: the error belongs to THIS
    // turn, and is the thing the ten-minute wait was actually spent on.
    const { session } = rig([logLine(new Date(Date.now() + 1000), 's1', RATE_LIMIT)]);
    const h = handlers();

    await expect(session.runTurn({ prompt: 'hi', sessionToken: 'tok' }, h)).rejects.toThrow(
      /sent no update for 400ms.*opencode last logged: AI_APICallError: Rate limit exceeded\. Please try again later\./s
    );
  }, 15_000);

  it('still says only "hung" when the harness logged nothing', async () => {
    // No probe hit means the message is exactly what it was before this feature existed — a wrong
    // guess is worse than the honest absence of one.
    const { session } = rig([]);
    const h = handlers();

    const err = await session.runTurn({ prompt: 'hi', sessionToken: 'tok' }, h).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('sent no update for 400ms');
    expect((err as Error).message).not.toContain('last logged');
  }, 15_000);

  it('ignores another conversation failing at the same moment', async () => {
    const { session } = rig([logLine(new Date(Date.now() + 1000), 'some-other-session', RATE_LIMIT)]);
    const h = handlers();

    const err = await session.runTurn({ prompt: 'hi', sessionToken: 'tok' }, h).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('last logged');
  }, 15_000);

  it('does not claim a retry is under way once the turn has already failed', async () => {
    // The final read feeds the failure message; announcing "is retrying" from it would be false by
    // the time it arrived, and would duplicate the reason the same message already carries.
    const { session } = rig([logLine(new Date(Date.now() + 1000), 's1', RATE_LIMIT)]);
    const h = handlers();

    await session.runTurn({ prompt: 'hi', sessionToken: 'tok' }, h).catch(() => {});
    expect(h.notices).toEqual([]);
  }, 15_000);
});
