import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpAgentFactory } from './agent-acp.js';
import { parseConfig } from '../config/schema.js';
import type { AgentSession, AgentStreamHandlers } from './agent.js';

/**
 * The per-machine cold-start cap (agent-acp.ts START_CONCURRENCY).
 *
 * Reproduces 2026-11-07: thirteen sub-agents confirmed together each spawned a cbc child, the
 * 2-core host went into swap, every child missed START_TIMEOUT_MS, and the card reported 13
 * startup timeouts with none of the work done. The fake agent below holds `initialize` open long
 * enough that the children would visibly overlap if the cap were not there.
 */

const FAKE_AGENT = /* js */ `
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.env.SLOT_LOG;
const mark = (kind) => fs.appendFileSync(log, kind + ' ' + process.pid + ' ' + Date.now() + '\\n');
mark('start');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    // A child holds its startup slot from spawn until session/new is answered; holding initialize
    // is what makes a start that should have queued overlap a running one.
    setTimeout(() => { mark('ready'); reply(msg.id, { protocolVersion: 1, agentCapabilities: {} }); }, 300);
    return;
  }
  if (msg.method === 'session/new') { reply(msg.id, { sessionId: 's-' + process.pid }); return; }
  if (msg.method === 'session/prompt') { reply(msg.id, { stopReason: 'end_turn' }); return; }
});
`;

const handlers: AgentStreamHandlers = {
  onText: () => {},
  onToolStart: () => {},
  onToolFinish: () => {},
  onSegmentBreak: () => {},
};

let live: AgentSession[] = [];
afterEach(() => {
  for (const s of live) s.dispose();
  live = [];
});

describe('cold-start concurrency', () => {
  it('starts at most four agents at once on one machine, and every queued one still starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-acp-slots-'));
    const script = join(dir, 'fake-acp-agent.cjs');
    const log = join(dir, 'starts.log');
    writeFileSync(script, FAKE_AGENT);

    const cfg = parseConfig({
      platforms: { discord: { type: 'discord', token: 't' } },
      agents: [
        {
          id: 'fake',
          harness: 'custom',
          command: process.execPath,
          args: [script],
          cwd: dir,
          env: { SLOT_LOG: log },
        },
      ],
      routing: { default: 'fake', pipeline: [] },
    });
    // Only the members the ACP runtime asks of a store on the way up.
    const store = {
      agentSession: () => undefined,
      setAgentSession: () => {},
      conversationCwd: () => undefined,
    } as unknown as Parameters<typeof createAcpAgentFactory>[2];
    const factory = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store);

    const sessions = Array.from({ length: 6 }, (_, i) => factory.getOrCreate(`conv#${i}`, 'fake'));
    live = sessions;
    await Promise.all(sessions.map((s, i) => s.runTurn({ prompt: `go ${i}`, sessionToken: 'tok' }, handlers)));

    const marks = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [kind, pid, at] = line.split(' ');
        return { kind, pid: Number(pid), at: Number(at) };
      });
    const starts = marks.filter((m) => m.kind === 'start');
    const ready = new Map(marks.filter((m) => m.kind === 'ready').map((m) => [m.pid, m.at]));

    // Every queued start did run: six children, each one ready.
    expect(starts).toHaveLength(6);
    expect(ready.size).toBe(6);

    // Overlap of [spawn, session/new answered]: how many children were inside a slot at once.
    const edges = [
      ...starts.map((s) => ({ at: s.at, delta: 1 })),
      ...starts.map((s) => ({ at: ready.get(s.pid)!, delta: -1 })),
    ].sort((a, b) => a.at - b.at || a.delta - b.delta);
    let inFlight = 0;
    let peak = 0;
    for (const edge of edges) {
      inFlight += edge.delta;
      peak = Math.max(peak, inFlight);
    }
    expect(peak).toBeLessThanOrEqual(4);
  }, 20_000);
});
