import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { autonomousResultOrigin, createAcpAgentFactory, TOOL_SILENCE_FACTOR } from './agent-acp.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { AgentSession, AgentStreamHandlers } from './agent.js';

/**
 * The ACP runtime's update reader, driven against a real child process.
 *
 * This is the one test that exercises the reported bug end to end, because the bug is entirely
 * about TIMING between a process and the reader: claude-agent-acp answers `session/prompt` as soon
 * as the turn's own answer is done, and keeps sending `session/update` notifications afterwards for
 * work that outlived the turn ("The consumer keeps draining afterward … forwarding any background
 * output", acp-agent.js 0.58.1). A reader that stops at the prompt response sees none of them, and
 * no amount of unit-testing the translation layer catches that — so the fake agent below reproduces
 * exactly that sequence over the wire.
 *
 * Written as a throwaway script rather than a checked-in fixture so the protocol being faked is
 * readable in one place, right next to the assertions about it.
 */

const FAKE_AGENT = /* js */ `
const readline = require('node:readline');

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (sessionId, update) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });

const text = (sessionId, t) =>
  notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
// The tool a cancel lands on, whether a turn or a background burst opened it.
let openTool = 'doomed-1';
// The usage snapshot the harness ties to a completed result: 'cost' is what marks it (see
// isResultUsage), and it is how the gateway knows a burst of background output has finished.
const resultUsage = (sessionId, used) =>
  notify(sessionId, {
    sessionUpdate: 'usage_update',
    used,
    size: 200000,
    cost: { amount: 0.01, currency: 'USD' },
  });
// The same marker for a cycle Claude Code started ON ITS OWN (a background task reporting in):
// claude-agent-acp 0.81.x forwards the SDK result's origin in _meta — see autonomousResultOrigin.
const autonomousResultUsage = (sessionId, used) =>
  notify(sessionId, {
    sessionUpdate: 'usage_update',
    used,
    size: 200000,
    cost: { amount: 0.01, currency: 'USD' },
    _meta: { '_claude/origin': { kind: 'task-notification' } },
  });
// A prompt the adapter answered but never settled (claude-agent-acp #1145). It stays pending until
// the next prompt arrives, which is when the real adapter hands it off with end_turn — BEFORE that
// next prompt's own output, which is what makes its stale stop dangerous.
let unsettled = null;
// A typed failure record in the shape claude-agent-acp 0.81.x encodes one (see session-failure.ts):
// a retry warning or a failure with no turn, sent as a session_info_update.
const recordMeta = (record) => ({ jetbrains: { air: { version: 1, sessionFailure: { actions: [], ...record } } } });
const failureRecord = (sessionId, record) =>
  notify(sessionId, { sessionUpdate: 'session_info_update', _meta: recordMeta(record) });
// What the client sent at initialize, so a turn can report whether it asked for those records.
let initCaps = null;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    initCaps = msg.params.clientCapabilities;
    reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
    return;
  }
  if (msg.method === 'session/new') {
    // A model and an effort, reported here and never again unless they change — which is exactly
    // why the runtime has to hand them on to every stream itself, a background burst included.
    reply(msg.id, {
      sessionId: 's1',
      configOptions: [
        { id: 'model', type: 'select', name: 'Model', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }] },
        {
          id: 'effort',
          type: 'select',
          name: 'Effort',
          category: 'thought_level',
          currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        },
      ],
    });
    return;
  }
  if (msg.method === 'session/load') {
    // What session/load does: replay the stored conversation as ordinary notifications, BEFORE
    // answering. The client attaches the session first precisely so these land in its queue.
    const sessionId = msg.params.sessionId;
    text(sessionId, 'REPLAYED HISTORY that must not be re-posted to the chat');
    notify(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'old-1',
      title: 'a tool from the previous run',
      kind: 'execute',
      status: 'completed',
      rawInput: { command: 'ls' },
    });
    // A LONG history, on request. Size is the whole point: the gate that suppresses replay used to
    // be a race between the reader draining this and the turn setting its "prompted" flag, so a
    // two-message replay was always won and a real conversation's was not.
    if (sessionId.includes('long')) {
      for (let i = 0; i < 300; i++) text(sessionId, 'REPLAYED LINE ' + i);
    }
    // A usage-limit failure from the stored history, which the real adapter re-publishes on load.
    if (sessionId.includes('failrec')) {
      failureRecord(sessionId, {
        id: sessionId + ':history-error:u1',
        severity: 'error',
        category: 'limit',
        title: 'OLD usage limit from the history',
      });
    }
    reply(msg.id, {});
    return;
  }
  if (msg.method === 'session/cancel') {
    // A cancelled tool still reports in, and it lands after the prompt has settled — or, when
    // what was cancelled was background output, after the gateway has already sealed it.
    const sessionId = msg.params.sessionId;
    const doomed = openTool;
    reply(msg.id, {});
    setTimeout(() => {
      notify(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: doomed,
        status: 'failed',
      });
    }, 40);
    if (doomed === 'bg-1') {
      // A DIFFERENT background task finishing later. Stopping one burst must not blind the
      // gateway to the next: this one's tool has to render as usual.
      setTimeout(() => {
        notify(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'bg-2',
          title: 'a later check',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: './later.sh' },
        });
        text(sessionId, 'the other job finished too');
        resultUsage(sessionId, 1800);
      }, 120);
    }
    return;
  }
  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId;
    const asked = JSON.stringify(msg.params.prompt ?? '');
    if (unsettled !== null) {
      reply(unsettled, { stopReason: 'end_turn' });
      unsettled = null;
    }
    if (asked.includes('FOLD_ME')) {
      // #1145 as seen live 2026-09-29: the prompt is folded into a task-notification cycle, which
      // answers it and ends with a result the adapter files as autonomous — and session/prompt is
      // never answered.
      text(sessionId, 'the bridge is reachable; checking the backend. ');
      notify(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'fold-1',
        title: 'broker status',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: './status.sh' },
      });
      if (!asked.includes('TOOL_OPEN')) {
        notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'fold-1', status: 'completed' });
      }
      text(sessionId, 'the bridge is online');
      autonomousResultUsage(sessionId, 1200);
      unsettled = msg.id;
      return;
    }
    if (asked.includes('QUEUED_BEHIND')) {
      // The look-alike that must NOT be cut short: the prompt was only queued behind an autonomous
      // cycle. That cycle ends first; then, after a pause, the prompt runs as a cycle of its own.
      text(sessionId, 'background check done. ');
      autonomousResultUsage(sessionId, 1100);
      setTimeout(() => {
        text(sessionId, 'and here is your answer');
        resultUsage(sessionId, 1300);
        reply(msg.id, { stopReason: 'end_turn' });
      }, 120);
      return;
    }
    if (asked.includes('NEXT_PROMPT')) {
      // An ordinary turn whose output lands in one burst right before its response — the shape
      // in which a turn that ends on the WRONG stop finishes before its own tail is read. The
      // loss is a race between the reader and the response, so the burst is sized to lose it
      // every time: at forty chunks the unfixed code failed one run in three.
      setTimeout(() => {
        for (let i = 0; i < 400; i++) text(sessionId, 'part' + i + ' ');
        resultUsage(sessionId, 1400);
        reply(msg.id, { stopReason: 'end_turn' });
      }, 50);
      return;
    }
    if (asked.includes('HANG_SILENT')) return;          // never speaks, never answers
    if (asked.includes('RETRY_THEN_ANSWER')) {
      // The 2026-10-06 shape: the API fails and Claude Code retries. Each attempt is a warning
      // record, spaced closer than the test's watchdog but adding up to well past it, and then the
      // provider recovers. A timeout comes first (no HTTP status, so "connection"), then 5xx.
      const steps = [
        ['connection', 'Reconnecting to Claude, attempt 1 of 10.'],
        ['service', 'Retrying Claude, attempt 2 of 10.'],
        ['service', 'Retrying Claude, attempt 3 of 10.'],
        ['service', 'Retrying Claude, attempt 4 of 10.'],
      ];
      steps.forEach(([category, title], i) =>
        setTimeout(
          () => failureRecord(sessionId, { id: 'p1:error', revision: i + 1, severity: 'warning', category, title }),
          150 * i
        )
      );
      setTimeout(() => {
        text(sessionId, 'recovered and answered');
        resultUsage(sessionId, 1000);
        reply(msg.id, { stopReason: 'end_turn' });
      }, 150 * steps.length);
      return;
    }
    if (asked.includes('REFUSE_TOOL_THEN_QUOTA')) {
      // A run that got as far as a tool, then the upstream 429. The tool must not make the refused
      // turn look finished.
      notify(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'q1',
        title: 'Bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: './check.sh' },
      });
      notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'q1', status: 'completed' });
      reply(msg.id, {
        stopReason: 'refusal',
        _meta: {
          'codebuddy.ai/errorMessage': JSON.stringify({
            code: -32003,
            message: 'Quota exceeded: request rejected by the upstream gateway',
            data: { statusCode: 429, category: 'quota' },
          }),
        },
      });
      return;
    }
    if (asked.includes('REFUSE_TEXT_THEN_QUOTA')) {
      // Same, one streamed sentence earlier.
      text(sessionId, 'Checking the deploy now.');
      reply(msg.id, {
        stopReason: 'refusal',
        _meta: {
          'codebuddy.ai/errorMessage': JSON.stringify({
            code: -32003,
            message: 'Quota exceeded: request rejected by the upstream gateway',
            data: { statusCode: 429, category: 'quota' },
          }),
        },
      });
      return;
    }
    if (asked.includes('REFUSE_EXPLAINED')) {
      // claude-agent-acp's refusal shape: lastRefusalExplanation goes out as an ordinary message
      // chunk, then the prompt answers with stopReason refusal (dist/acp-agent.js 0.81.0). The
      // explanation IS the answer, so this turn must end normally.
      text(sessionId, 'I can’t help with that request.');
      reply(msg.id, { stopReason: 'refusal' });
      return;
    }
    if (asked.includes('REFUSE_QUOTA')) {
      // CodeBuddy's refusal when its upstream rejects the call: no answer, no rejection, and the
      // provider's own error JSON under its private _meta key (see session-failure.ts).
      reply(msg.id, {
        stopReason: 'refusal',
        _meta: {
          'codebuddy.ai/errorMessage': JSON.stringify({
            code: -32003,
            message: 'Quota exceeded: request rejected by the upstream gateway',
            data: { statusCode: 429, category: 'quota' },
          }),
        },
      });
      return;
    }
    if (asked.includes('REFUSE_PLAIN')) {
      // A model's own refusal: finish_reason content_filter/refusal maps to the same stopReason,
      // with no provider error to attach.
      reply(msg.id, { stopReason: 'refusal' });
      return;
    }
    if (asked.includes('FAIL_TYPED')) {
      // Retries ran out: the adapter settles the prompt as end_turn and puts the failure in _meta,
      // instead of rejecting it, because the client asked for records.
      text(sessionId, 'checking the deploy script. ');
      failureRecord(sessionId, { id: 'p2:error', revision: 1, severity: 'warning', category: 'service', title: 'Retrying Claude, attempt 1 of 10.' });
      setTimeout(
        () =>
          reply(msg.id, {
            stopReason: 'end_turn',
            _meta: {
              quota: { token_count: {} },
              ...recordMeta({ id: 'p2:error', revision: 2, severity: 'error', category: 'service', title: 'API Error: 503 no available channel' }),
            },
          }),
        40
      );
      return;
    }
    if (asked.includes('BG_FAILURE')) {
      // A background cycle that fails after the turn is over: no turn to attach it to, so the
      // adapter publishes it as a session-scoped record.
      text(sessionId, 'started it in the background');
      resultUsage(sessionId, 1000);
      reply(msg.id, { stopReason: 'end_turn' });
      setTimeout(
        () => failureRecord(sessionId, { id: 's1:session-error:e:1', severity: 'error', category: 'service', title: 'API Error: 500 Database error' }),
        40
      );
      return;
    }
    if (asked.includes('ECHO_CAPS')) {
      text(sessionId, initCaps && initCaps._meta ? 'asked for records' : 'did not ask');
      resultUsage(sessionId, 1000);
      reply(msg.id, { stopReason: 'end_turn' });
      return;
    }
    if (asked.includes('HANG_IN_TOOL')) {
      // Opens a tool and then goes quiet — indistinguishable from a long script.
      notify(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'slow-1',
        title: 'a very long script',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: './very-long.sh' },
      });
      return;
    }
    if (asked.includes('META_ONLY')) {
      // A turn followed by nothing but the post-turn title report — what every conversation looks
      // like between bursts. Metadata opens a follow-up state; it is not background work.
      text(sessionId, 'done');
      resultUsage(sessionId, 1000);
      reply(msg.id, { stopReason: 'end_turn' });
      setTimeout(() => notify(sessionId, { sessionUpdate: 'session_info_update', title: 'Done' }), 20);
      return;
    }
    if (asked.includes('BG_TOOL')) {
      // The shape of the reported bug: the turn ends promptly, and the background report that
      // follows is still busy — text, then a tool left running — when the user asks it to stop.
      text(sessionId, 'waiting on the release in the background');
      resultUsage(sessionId, 1000);
      reply(msg.id, { stopReason: 'end_turn' });
      setTimeout(() => {
        openTool = 'bg-1';
        text(sessionId, 'the release is out; deploying');
        notify(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'bg-1',
          title: 'deploy',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: './deploy.sh' },
        });
      }, 60);
      return;
    }
    // Every block, not just the first: the runtime prepends a reverse-CLI hint block on a
    // session's first turn, so prompt[0] is not the user's text.
    if (JSON.stringify(msg.params.prompt ?? '').includes('SLOW')) {
      // A turn that opens a tool and then waits to be cancelled.
      openTool = 'doomed-1';
      notify(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'doomed-1',
        title: 'a long script',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: './long.sh' },
      });
      setTimeout(() => reply(msg.id, { stopReason: 'cancelled' }), 80);
      return;
    }
    // The turn's own answer, then its result, then the prompt response — in that order, which is
    // what makes 'stop' the only safe signal that a turn's output has all been delivered.
    text(sessionId, 'started the script in the background');
    resultUsage(sessionId, 1000);
    reply(msg.id, { stopReason: 'end_turn' });
    // A trailing notification the gateway does not render, landing between the turn and the
    // background output. Kept in the fake because "an ignored update arrives mid-burst" is exactly
    // the condition under which a reader that dispatches on type can lose the updates after it.
    setTimeout(() => notify(sessionId, { sessionUpdate: 'session_info_update', title: 'The long script' }), 20);
    // ...and then the background work reporting in, with no prompt in flight. THIS is what used to
    // be dropped.
    setTimeout(() => {
      text(sessionId, 'the script finished: all green');
      resultUsage(sessionId, 1500);
    }, 60);
    return;
  }
});
`;

/** Collects everything the runtime reports, in the channels it can report on. */
function collector(): {
  handlers: AgentStreamHandlers;
  turn: string[];
  tools: string[];
  notices: string[];
} {
  const turn: string[] = [];
  const tools: string[] = [];
  const notices: string[] = [];
  return {
    turn,
    tools,
    notices,
    handlers: {
      onText: (d) => void turn.push(d),
      onToolStart: (e) => void tools.push(e.name),
      onToolFinish: () => {},
      onSegmentBreak: () => {},
      onNotice: (t) => void notices.push(t),
    },
  };
}

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

function rig(opts: { resumeFrom?: string; turnTimeoutMs?: number } = {}): { session: AgentSession } {
  const dir = mkdtempSync(join(tmpdir(), 'aa-acp-pump-'));
  const script = join(dir, 'fake-acp-agent.cjs');
  writeFileSync(script, FAKE_AGENT);

  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'fake', harness: 'custom', command: process.execPath, args: [script], cwd: dir }],
    routing: { default: 'fake', pipeline: [] },
  });
  // turnTimeoutMs is frozen in EXPERIENCE and deliberately not reachable from config.yaml, so the
  // test patches the runtime Config directly rather than pretending an operator could set it.
  const cfg: Config = opts.turnTimeoutMs
    ? { ...parsed, session: { ...parsed.session, turnTimeoutMs: opts.turnTimeoutMs } }
    : parsed;

  // Only the two members the ACP runtime asks of a store on the way up: which session to resume,
  // and where to record the new one.
  const store = {
    agentSession: () => opts.resumeFrom,
    setAgentSession: () => {},
    conversationCwd: () => undefined,
  } as unknown as Parameters<typeof createAcpAgentFactory>[2];

  const session = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store).getOrCreate('conv#1', 'fake');
  live = session;
  return { session };
}

/** A sink that records what it is handed, shaped like the real one. */
function sinkSpy(): {
  install(session: AgentSession): void;
  text: string[];
  tools: string[];
  /** Model and effort names each burst was told, in order. */
  facts: string[];
  /** How each tool bubble ended: true for ✓, false for ✗. */
  finishes: boolean[];
  /** Notices sent while no turn was running. */
  notices: string[];
  closes: () => number;
} {
  const text: string[] = [];
  const tools: string[] = [];
  const facts: string[] = [];
  const finishes: boolean[] = [];
  const notices: string[] = [];
  let closes = 0;
  return {
    text,
    tools,
    facts,
    finishes,
    notices,
    closes: () => closes,
    install: (session) =>
      session.setFollowUpSink?.({
        handlers: () => ({
          onText: (d) => void text.push(d),
          onToolStart: (e) => void tools.push(e.name),
          onToolFinish: (e) => void finishes.push(e.ok),
          onSegmentBreak: () => {},
          onModel: (m) => void facts.push(`model:${m}`),
          onEffort: (e) => void facts.push(`effort:${e}`),
          onNotice: (t) => void notices.push(t),
        }),
        close: () => void closes++,
      }),
  };
}

/** Wait for the fake agent's delayed notifications to arrive and be pumped. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

/** ...and then for the post-result grace window to elapse and seal the burst. */
const sealed = (): Promise<void> => new Promise((r) => setTimeout(r, 1_700));

describe('the ACP update reader keeps reading after a turn ends', () => {
  it('delivers post-turn output to the follow-up sink, not into the void', async () => {
    const { session } = rig();
    const captured: { text: string[]; closes: number } = {
      text: [],
      closes: 0,
    };
    session.setFollowUpSink?.({
      handlers: () => ({
        onText: (d) => void captured.text.push(d),
        onToolStart: () => {},
        onToolFinish: () => {},
        onSegmentBreak: () => {},
      }),
      close: () => void captured.closes++,
    });

    const turn = collector();
    await session.runTurn({ prompt: 'run the long script', sessionToken: 'tok' }, turn.handlers);

    // The turn resolved on its own answer only — the background work has not reported yet.
    expect(turn.turn.join('')).toBe('started the script in the background');
    expect(captured.text).toEqual([]);

    await settle();

    // The whole point: output produced after the turn settled reached the conversation.
    expect(captured.text.join('')).toBe('the script finished: all green');
    // Not sealed yet — the result marker only shortens the timer, because `usage_update.cost` is
    // documented as a cumulative total and a harness may report it on every snapshot.
    expect(captured.closes).toBe(0);

    await sealed();

    // And the burst IS eventually closed, which is what makes it visible at all in the default
    // `once` delivery mode (nothing is sent until the buffer completes).
    expect(captured.closes).toBe(1);
  });

  it('routes a later turn\'s output back to that turn, not to the sink', async () => {
    const { session } = rig();
    const strayed: string[] = [];
    session.setFollowUpSink?.({
      handlers: () => ({
        onText: (d) => void strayed.push(d),
        onToolStart: () => {},
        onToolFinish: () => {},
        onSegmentBreak: () => {},
      }),
      close: () => {},
    });

    await session.runTurn({ prompt: 'first', sessionToken: 'tok' }, collector().handlers);
    await settle();
    strayed.length = 0;

    // The handover a between-turns drain could not do safely: the SDK's queue has exactly one
    // reader, and an abandoned waiter still swallows the next value that arrives.
    const second = collector();
    await session.runTurn({ prompt: 'second', sessionToken: 'tok' }, second.handlers);
    expect(second.turn.join('')).toBe('started the script in the background');
    expect(strayed).toEqual([]);
  });
});

/**
 * Two things the old pre-prompt drain was quietly doing, which a permanent reader has to do
 * deliberately instead. Both were caught by review rather than by use, and both would have been
 * embarrassing in production: one re-narrates your previous conversation on every restart, the
 * other answers `/stop` with a bubble for the tool you just stopped.
 */
describe('what must NOT be rendered as background output', () => {
  it('does not re-post the history that session/load replays', async () => {
    const { session } = rig({ resumeFrom: 'stored-session-id' });
    const sink = sinkSpy();
    sink.install(session);

    // The replay is emitted during startup, i.e. before this turn's prompt is even sent.
    const turn = collector();
    await session.runTurn({ prompt: 'carry on', sessionToken: 'tok' }, turn.handlers);
    await settle();

    const everything = [...sink.text, ...turn.turn].join(' ');
    expect(everything).not.toContain('REPLAYED HISTORY');
    expect(sink.tools).not.toContain('Bash'); // the replayed tool_call must not open a bubble either
    // ...and the live turn is unaffected: its own answer still arrives.
    expect(turn.turn.join('')).toBe('started the script in the background');
  });

  it('does not re-post a LONG replayed history either — the case the old gate lost', async () => {
    // The regression, 2026-09-11: on a conversation with hours of history, a daemon restart
    // re-sent the whole thing to Telegram as one turn's reply. The suppression gate was a race —
    // the reader dropped whatever it reached before runTurn set the "prompted" flag (five updates,
    // in the live incident) and rendered everything after. Two replayed messages always won that
    // race, which is why the test above passed throughout. Three hundred do not.
    const { session } = rig({ resumeFrom: 'stored-session-id-long' });
    const sink = sinkSpy();
    sink.install(session);

    const turn = collector();
    await session.runTurn({ prompt: 'carry on', sessionToken: 'tok' }, turn.handlers);
    await settle();

    const everything = [...sink.text, ...turn.turn].join(' ');
    expect(everything).not.toContain('REPLAYED HISTORY');
    expect(everything).not.toContain('REPLAYED LINE');
    // The live turn is still delivered in full — the fence delays the flag, it does not swallow
    // this turn's own output.
    expect(turn.turn.join('')).toBe('started the script in the background');
  });

  it('drops a cancelled tool\'s trailing update instead of opening a follow-up for it', async () => {
    const { session } = rig();
    const sink = sinkSpy();
    sink.install(session);

    const turn = collector();
    const running = session.runTurn({ prompt: 'SLOW: run the long script', sessionToken: 'tok' }, turn.handlers);
    // Wait for the tool to actually be RUNNING rather than for a wall-clock guess: the child has
    // to spawn and handshake first, and a fixed sleep here was long enough to abort before the
    // ledger had anything in it — which is a real window the runtime has to cover too.
    for (let i = 0; i < 200 && turn.tools.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(turn.tools).toEqual(['Bash']); // the turn itself did render the tool it was running
    session.abort();
    await running;
    await settle();

    // The trailing `tool_call_update` for the killed tool arrived with no turn running; rendering
    // it would have posted a "background update" about the tool the user just stopped.
    expect(sink.tools).toEqual([]);
    expect(sink.closes()).toBe(0);
  });
});

/**
 * `/stop` while background work is reporting in. The merger sees no turn, so the runtime answers
 * this itself — and it has to do two things a turn's abort never had to: stop output that has no
 * prompt to cancel, and leave the conversation able to hear the NEXT background report.
 */
describe('stopping background output', () => {
  /** Poll for a condition rather than guessing how long the child takes to get there. */
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('cancels a burst that is still running, seals it, and still hears the next one', async () => {
    const { session } = rig();
    const sink = sinkSpy();
    sink.install(session);

    await session.runTurn({ prompt: 'BG_TOOL: wait for the release', sessionToken: 'tok' }, collector().handlers);
    await until(() => sink.tools.length > 0);
    expect(sink.tools).toEqual(['Bash']);
    expect(sink.closes()).toBe(0);

    expect(session.stopBackground?.()).toBe(true);
    // Sealed at once rather than when the quiet timer gets round to it: the user has just been
    // told it stopped, and in `once` mode an unsealed burst has not even been sent.
    expect(sink.closes()).toBe(1);
    // And the deploy it was running ends as ✗, not as the ✓ an ordinary seal would give it: the
    // harness's own "failed" update for it is about to be dropped, so this is the last word.
    expect(sink.finishes).toEqual([false]);

    await settle();
    // Exactly one more bubble, and it is the LATER job's. The deploy's trailing update was dropped
    // as wreckage rather than opening a burst of its own; the unrelated report that followed was
    // not — which is what reusing the turn's `aborting` flag would have got wrong, and kept wrong
    // until the next turn.
    expect(sink.tools).toEqual(['Bash', 'Bash']);
    expect(sink.text.join('')).toContain('the other job finished too');
  });

  it('claims nothing between bursts, where only metadata has arrived', async () => {
    const { session } = rig();
    const sink = sinkSpy();
    sink.install(session);
    expect(session.stopBackground?.()).toBe(false); // nothing has ever run

    await session.runTurn({ prompt: 'META_ONLY', sessionToken: 'tok' }, collector().handlers);
    await settle();
    // The post-turn title report opened a follow-up state — it does on every conversation after
    // every turn — but nothing is working, so "stopped the background work" would be untrue.
    expect(session.stopBackground?.()).toBe(false);
    expect(sink.closes()).toBe(0);
  });

  it('leaves a running turn to abort()', async () => {
    const { session } = rig();
    sinkSpy().install(session);
    const turn = collector();
    const running = session.runTurn({ prompt: 'SLOW: run the long script', sessionToken: 'tok' }, turn.handlers);
    await until(() => turn.tools.length > 0);
    expect(session.stopBackground?.()).toBe(false);
    await running;
  });

  it('tells a burst the model and effort it is running on', async () => {
    const { session } = rig();
    const sink = sinkSpy();
    sink.install(session);

    await session.runTurn({ prompt: 'run the long script', sessionToken: 'tok' }, collector().handlers);
    await settle();

    expect(sink.text.join('')).toBe('the script finished: all green');
    // Reported by session/new and never again: without the runtime handing them on, the burst's
    // footer fell back to config — which for the `claude` harness names no model at all.
    expect(sink.facts).toEqual(['model:Opus', 'effort:high']);
  });
});

/**
 * The silence watchdog has to separate "wedged" from "running a long script", and those look
 * identical from outside: a tool call emits nothing for exactly as long as it takes. The collision
 * was guaranteed rather than unlucky — Claude Code's Bash tool allows up to 600000ms, which is
 * precisely the watchdog's default — so a tool call at the harness's own limit failed the turn with
 * "sent no update for 600000ms" while the script was still running fine.
 */
describe('the silence watchdog distinguishes a hang from a long tool call', () => {
  const TIMEOUT = 200;

  it('fails a turn that goes quiet with nothing running', async () => {
    const { session } = rig({ turnTimeoutMs: TIMEOUT });
    const started = Date.now();
    await expect(
      session.runTurn({ prompt: 'HANG_SILENT', sessionToken: 'tok' }, collector().handlers)
    ).rejects.toThrow(/sent no update/);
    // Failed on the FIRST deadline: no tool was open, so no grace was owed.
    expect(Date.now() - started).toBeLessThan(TIMEOUT * TOOL_SILENCE_FACTOR);
  });

  it('gives a turn with an open tool call more time, then still fails it', async () => {
    const { session } = rig({ turnTimeoutMs: TIMEOUT });
    const started = Date.now();
    await expect(
      session.runTurn({ prompt: 'HANG_IN_TOOL', sessionToken: 'tok' }, collector().handlers)
    ).rejects.toThrow(/tool call still open/);
    // Past the first deadline — the tool bought it the extension...
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT * (1 + TOOL_SILENCE_FACTOR));
    // ...but the ceiling is finite, which is what keeps a wedged tool from pinning the
    // conversation in `running` forever.
  });
});

/**
 * `stopReason: "refusal"` (see session-failure.ts). Before this the prompt resolved normally and
 * the gateway logged `turn complete`: the sub-agent card said finished with no reply, the chat got
 * no ❌, and `hooks.turnFailed.continue` never saw a failure. Reproduced against CodeBuddy, whose
 * harness reports an upstream 429 exactly this way.
 */
describe('a prompt the agent refused', () => {
  it('fails the turn with the cause the harness attached', async () => {
    const { session } = rig();
    const turn = collector();
    await expect(session.runTurn({ prompt: 'REFUSE_QUOTA', sessionToken: 'tok' }, turn.handlers)).rejects.toMatchObject(
      {
        name: 'TurnFailure',
        reason: 'limit',
        message: 'the agent refused this request: Quota exceeded: request rejected by the upstream gateway',
      }
    );
    expect(turn.turn.join('')).toBe('');
  });

  it('fails an unexplained refusal too, naming the stop reason', async () => {
    const { session } = rig();
    const turn = collector();
    await expect(session.runTurn({ prompt: 'REFUSE_PLAIN', sessionToken: 'tok' }, turn.handlers)).rejects.toMatchObject(
      {
        name: 'TurnFailure',
        reason: 'request',
        message: 'the agent refused this request (stopReason: refusal)',
      }
    );
  });

  it('still fails a refusal that names a cause after a tool bubble', async () => {
    // The reported shape: work got going, then the upstream rejected the turn. A tool bubble is
    // visible output, but it is not an answer — the turn must still fail.
    const { session } = rig();
    const turn = collector();
    await expect(
      session.runTurn({ prompt: 'REFUSE_TOOL_THEN_QUOTA', sessionToken: 'tok' }, turn.handlers)
    ).rejects.toMatchObject({ name: 'TurnFailure', reason: 'limit' });
    expect(turn.tools).toEqual(['Bash']);
  });

  it('still fails a refusal that names a cause after streamed text', async () => {
    // Same for one sentence already on screen: the provider rejected the turn, so what it said
    // before is a partial reply, not an answer.
    const { session } = rig();
    const turn = collector();
    await expect(
      session.runTurn({ prompt: 'REFUSE_TEXT_THEN_QUOTA', sessionToken: 'tok' }, turn.handlers)
    ).rejects.toMatchObject({ name: 'TurnFailure', reason: 'limit' });
    expect(turn.turn.join('')).toBe('Checking the deploy now.');
  });

  it('keeps a refusal that explains itself a normal end, the way Claude sends one', async () => {
    // Claude's safety refusal: the explanation arrives as an agent_message_chunk first, then the
    // prompt reports refusal. The person already has an answer, so no ❌ and no turnFailed.
    const { session } = rig();
    const turn = collector();
    await session.runTurn({ prompt: 'REFUSE_EXPLAINED', sessionToken: 'tok' }, turn.handlers);
    expect(turn.turn.join('')).toBe('I can’t help with that request.');
  });

  it('still ends an ordinary turn normally', async () => {
    // Control: reading the stop reason must not turn every successful turn into a failure.
    const { session } = rig();
    const turn = collector();
    await session.runTurn({ prompt: 'META_ONLY', sessionToken: 'tok' }, turn.handlers);
    expect(turn.turn.join('')).toBe('done');
  });
});

/**
 * claude-agent-acp's typed failure records (see session-failure.ts). Reported 2026-10-06: the API
 * gateway failed, Claude Code retried for ten minutes without the gateway hearing a word, and the
 * turn failed as "hung". Once records are asked for, each retry is an update, so the watchdog
 * measures real silence again, and a failed turn arrives as end_turn and must still fail.
 */
describe('failure records from the harness', () => {
  const TIMEOUT = 200;

  it('keeps a retrying turn alive past the watchdog, and says so once per cause', async () => {
    const { session } = rig({ turnTimeoutMs: TIMEOUT });
    const turn = collector();
    const started = Date.now();
    await session.runTurn({ prompt: 'RETRY_THEN_ANSWER', sessionToken: 'tok' }, turn.handlers);

    // Longer than the watchdog allows any silence, so it was the records that kept it alive.
    expect(Date.now() - started).toBeGreaterThan(TIMEOUT * 2);
    expect(turn.turn.join('')).toBe('recovered and answered');
    // Four attempts, two causes: one notice each, never folded into the reply.
    expect(turn.notices).toEqual([
      '⚠️ fake: Reconnecting to Claude, attempt 1 of 10.',
      '⚠️ fake: Retrying Claude, attempt 2 of 10.',
    ]);
  });

  it('fails a turn the harness settled as end_turn with an error record', async () => {
    const { session } = rig({ turnTimeoutMs: TIMEOUT });
    const turn = collector();
    await expect(session.runTurn({ prompt: 'FAIL_TYPED', sessionToken: 'tok' }, turn.handlers)).rejects.toThrow(
      /^API Error: 503 no available channel$/
    );
    // What it said before failing is still the turn's; turn-runner delivers it ahead of the ❌.
    expect(turn.turn.join('')).toBe('checking the deploy script. ');
    expect(turn.notices).toEqual(['⚠️ fake: Retrying Claude, attempt 1 of 10.']);
  });

  it('announces a background failure without opening a follow-up message for it', async () => {
    const { session } = rig();
    const sink = sinkSpy();
    sink.install(session);
    await session.runTurn({ prompt: 'BG_FAILURE', sessionToken: 'tok' }, collector().handlers);
    await settle();

    expect(sink.notices).toEqual(['❌ fake: API Error: 500 Database error']);
    expect(sink.text).toEqual([]);
    await sealed();
    expect(sink.closes()).toBe(0);
  });

  it('does not announce failures replayed from the history by session/load', async () => {
    const { session } = rig({ resumeFrom: 'failrec-1' });
    const sink = sinkSpy();
    sink.install(session);
    const turn = collector();
    await session.runTurn({ prompt: 'an ordinary question', sessionToken: 'tok' }, turn.handlers);
    await settle();

    expect([...turn.notices, ...sink.notices].join('\n')).not.toContain('OLD usage limit');
  });

  it('asks only the claude harness for records', async () => {
    // The rig's agent is a `custom` harness. Positive coverage of the shape it would send is the
    // contract test in session-failure.test.ts, against the installed adapter.
    const { session } = rig();
    const turn = collector();
    await session.runTurn({ prompt: 'ECHO_CAPS', sessionToken: 'tok' }, turn.handlers);
    expect(turn.turn.join('')).toBe('did not ask');
  });
});

/**
 * claude-agent-acp #1145: a prompt folded into a cycle Claude Code started on its own is answered
 * but never settled, so `session/prompt` does not return. Before the workaround the watchdog failed
 * such a turn ten minutes after its answer had arrived — and the answer's last segment, which in
 * `once` mode is only sent when the turn ends, went down with it (see turn-failure.test.ts).
 *
 * TIMEOUT is chosen so the fold is decided at half of it (see FOLDED_PROMPT_GRACE_MS): every
 * "ended in time" assertion below is therefore also an assertion that the watchdog did not win.
 */
describe('a prompt folded into an autonomous cycle (claude-agent-acp #1145)', () => {
  const TIMEOUT = 600;

  it('ends the turn once that cycle has gone quiet, instead of failing it as hung', async () => {
    const { session } = rig({ turnTimeoutMs: TIMEOUT });
    const turn = collector();
    const started = Date.now();
    await session.runTurn({ prompt: 'FOLD_ME', sessionToken: 'tok' }, turn.handlers);

    expect(turn.turn.join('')).toBe('the bridge is reachable; checking the backend. the bridge is online');
    expect(Date.now() - started).toBeLessThan(TIMEOUT);
  });

  it("does not let that prompt's late stop end the next turn", async () => {
    const { session } = rig({ turnTimeoutMs: TIMEOUT });
    const sink = sinkSpy();
    sink.install(session);
    await session.runTurn({ prompt: 'FOLD_ME', sessionToken: 'tok' }, collector().handlers);

    // The adapter settles the stale prompt the moment the next one arrives, ahead of that prompt's
    // output. A turn that took any `stop` as its own would end right there and leave its reply to
    // be posted as a "background update".
    const next = collector();
    await session.runTurn({ prompt: 'NEXT_PROMPT', sessionToken: 'tok' }, next.handlers);
    await settle();

    const whole = Array.from({ length: 400 }, (_, i) => `part${i} `).join('');
    expect(next.turn.join('')).toBe(whole);
    expect(sink.text).toEqual([]);
  });

  it('waits for a prompt that was only queued behind the cycle', async () => {
    const { session } = rig({ turnTimeoutMs: TIMEOUT });
    const sink = sinkSpy();
    sink.install(session);
    const turn = collector();
    await session.runTurn({ prompt: 'QUEUED_BEHIND', sessionToken: 'tok' }, turn.handlers);

    // Its own output cancelled the wait, and it ended on its own stop — all of it in the turn.
    expect(turn.turn.join('')).toBe('background check done. and here is your answer');
    expect(sink.text).toEqual([]);
  });

  it('leaves a turn with a tool still open to the watchdog', async () => {
    // A cycle that claims to be over while a tool it opened never reported back is not something
    // to guess about: the turn keeps its old outcome rather than ending on a maybe.
    const { session } = rig({ turnTimeoutMs: 200 });
    await expect(
      session.runTurn({ prompt: 'FOLD_ME TOOL_OPEN', sessionToken: 'tok' }, collector().handlers)
    ).rejects.toThrow(/sent no update/);
  });
});

describe('autonomousResultOrigin', () => {
  const usage = (meta?: Record<string, unknown>, cost = true): SessionUpdate =>
    ({
      sessionUpdate: 'usage_update',
      used: 1,
      size: 2,
      ...(cost ? { cost: { amount: 0.01, currency: 'USD' } } : {}),
      ...(meta ? { _meta: meta } : {}),
    }) as SessionUpdate;

  it('names a cycle the harness started on its own', () => {
    expect(autonomousResultOrigin(usage({ '_claude/origin': { kind: 'task-notification' } }))).toBe(
      'task-notification'
    );
    expect(autonomousResultOrigin(usage({ '_claude/origin': { kind: 'peer' } }))).toBe('peer');
  });

  it('says nothing about a prompt’s own cycle, or about anything that is not a result', () => {
    // The user's own origins, as the adapter classifies them — these settle the prompt normally.
    expect(autonomousResultOrigin(usage({ '_claude/origin': { kind: 'human' } }))).toBeUndefined();
    expect(autonomousResultOrigin(usage({ '_claude/origin': { kind: 'channel' } }))).toBeUndefined();
    expect(autonomousResultOrigin(usage())).toBeUndefined();
    // A mid-stream snapshot carries no cost, whatever else it says.
    expect(
      autonomousResultOrigin(usage({ '_claude/origin': { kind: 'task-notification' } }, false))
    ).toBeUndefined();
    expect(autonomousResultOrigin(usage({ '_claude/origin': 'task-notification' }))).toBeUndefined();
  });

  it('reads the field the installed claude-agent-acp actually sends (contract)', () => {
    // Hyrum's Law guard for a private extension: if the adapter stops forwarding the result's
    // origin, folded prompts silently fall back to the ten-minute watchdog. Fail here instead.
    const dist = readFileSync(
      createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'),
      'utf8'
    );
    const send = dist.indexOf('_meta: { "_claude/origin": message.origin }');
    expect(send).toBeGreaterThan(0);
    // ...and it is the result-tied usage_update that carries it, cost and all.
    const before = dist.slice(Math.max(0, send - 600), send);
    expect(before).toContain('sessionUpdate: "usage_update"');
    expect(before).toContain('cost: {');
  });
});
