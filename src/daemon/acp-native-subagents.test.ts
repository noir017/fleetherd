import { describe, expect, it } from 'vitest';
import type { SessionUpdate, Stream } from '@agentclientprotocol/sdk';
import { NativeSubagentRelay, readSubagentStamp, relayNativeSubagents } from './acp-native-subagents.js';
import { translateUpdate, type TurnState } from './agent-acp-translate.js';
import type { ToolEvent } from '../types.js';

type Message = Stream['readable'] extends ReadableStream<infer M> ? M : never;

const ROOT = '73f8eb14-3abd-45fc-9525-4972ba0d7e8a';
const SHORT = 'acf11286f4288b701';
const LONG = 'a399f4b9c568bb801';
const SHORT_CALL = 'toolu_011shSuBoc94fURetpQ3F9Lj';
const LONG_CALL = 'toolu_01137oiVhGKRhqDQTexA6HCg';

const note = (sessionId: string, update: Record<string, unknown>): Message => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update },
});

/**
 * CONTRACT: what claude-agent-acp 0.81.0 sent a client declaring `nativeSubagentSessions`, for a
 * main agent that put two subagents in the background (project-scripts/fleetherd-subagent-end/
 * probe.mjs, 2026-11-28; long fields shortened, nothing renamed). If the adapter changes these
 * shapes, this is where it shows.
 */
const RECORDED: Message[] = [
  note(ROOT, { sessionUpdate: 'subagent_spawned', subagentSessionId: SHORT, name: 'short one', task: 'Run `sleep 3`…', capabilities: {} }),
  note(ROOT, {
    sessionUpdate: 'tool_call_update',
    toolCallId: SHORT_CALL,
    _meta: { claudeCode: { toolName: 'Agent', toolResponse: { isAsync: true, status: 'async_launched', agentId: SHORT } } },
  }),
  note(ROOT, { sessionUpdate: 'subagent_spawned', subagentSessionId: LONG, name: 'long one', task: 'Run `sleep 40`…', capabilities: {} }),
  note(SHORT, {
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_short_bash',
    status: 'pending',
    kind: 'execute',
    title: 'sleep 3; echo short-ok',
    rawInput: { command: 'sleep 3; echo short-ok', description: 'Run sleep' },
    _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: SHORT_CALL } },
  }),
  note(LONG, {
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_long_bash',
    status: 'pending',
    kind: 'execute',
    title: 'sleep 40; echo long-ok',
    rawInput: { command: 'sleep 40; echo long-ok', description: 'Run sleep' },
    _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: LONG_CALL } },
  }),
  note(ROOT, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'launched' } }),
  note(SHORT, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_short_bash',
    status: 'completed',
    _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: SHORT_CALL } },
  }),
  note(SHORT, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'short-ok' },
    _meta: { claudeCode: { parentToolUseId: SHORT_CALL } },
  }),
  note(ROOT, { sessionUpdate: 'subagent_state_update', subagentSessionId: SHORT, state: 'completed' }),
  note(LONG, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_long_bash',
    status: 'failed',
    _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: LONG_CALL } },
  }),
  note(ROOT, { sessionUpdate: 'subagent_state_update', subagentSessionId: LONG, state: 'failed' }),
];

function relayAll(msgs: readonly Message[]): Message[] {
  const relay = new NativeSubagentRelay();
  return msgs.flatMap((m) => relay.inbound(m) ?? []);
}

const sessionOf = (m: Message): unknown => ('method' in m ? (m.params as { sessionId?: unknown }).sessionId : undefined);
const updateOf = (m: Message): Record<string, unknown> => (m as { params: { update: Record<string, unknown> } }).params.update;

describe('NativeSubagentRelay', () => {
  it('puts everything back on the conversation’s own session, and drops what the SDK cannot read', () => {
    const out = relayAll(RECORDED);
    expect(out.map(sessionOf).every((s) => s === ROOT)).toBe(true);
    expect(out.map((m) => updateOf(m).sessionUpdate)).toEqual([
      'tool_call_update',
      'tool_call',
      'tool_call',
      'agent_message_chunk',
      'tool_call_update',
      'agent_message_chunk',
      'session_info_update',
      'tool_call_update',
      'session_info_update',
    ]);
  });

  it('keeps the attribution a subagent’s update carried, and stamps its name beside it', () => {
    const [, bash] = relayAll(RECORDED);
    const meta = updateOf(bash!)._meta as Record<string, unknown>;
    expect(meta.claudeCode).toEqual({ toolName: 'Bash', parentToolUseId: SHORT_CALL });
    expect(readSubagentStamp(meta)).toEqual({ name: 'short one' });
  });

  it('turns each subagent’s end into a record naming the call that started it', () => {
    const ends = relayAll(RECORDED)
      .map((m) => readSubagentStamp(updateOf(m)._meta)?.ended)
      .filter(Boolean);
    expect(ends).toEqual([
      { parent: SHORT_CALL, state: 'completed' },
      { parent: LONG_CALL, state: 'failed' },
    ]);
  });

  it('drops the end of a subagent that never ran a tool: it has no card', () => {
    const out = relayAll([
      note(ROOT, { sessionUpdate: 'subagent_spawned', subagentSessionId: SHORT, name: 'quiet', capabilities: {} }),
      note(ROOT, { sessionUpdate: 'subagent_state_update', subagentSessionId: SHORT, state: 'completed' }),
    ]);
    expect(out).toEqual([]);
  });

  it('follows a subagent’s own subagent up to the conversation', () => {
    const nested = 'nested-session';
    const out = relayAll([
      note(ROOT, { sessionUpdate: 'subagent_spawned', subagentSessionId: SHORT, name: 'outer', capabilities: {} }),
      note(SHORT, { sessionUpdate: 'subagent_spawned', subagentSessionId: nested, name: 'inner', capabilities: {} }),
      note(nested, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        kind: 'read',
        rawInput: { file_path: 'a.ts' },
        _meta: { claudeCode: { parentToolUseId: 'inner-call' } },
      }),
      note(SHORT, { sessionUpdate: 'subagent_state_update', subagentSessionId: nested, state: 'cancelled' }),
    ]);
    expect(out.map(sessionOf)).toEqual([ROOT, ROOT]);
    expect(readSubagentStamp(updateOf(out[0]!)._meta)).toEqual({ name: 'inner' });
    expect(readSubagentStamp(updateOf(out[1]!)._meta)?.ended).toEqual({ parent: 'inner-call', state: 'cancelled' });
  });

  it('answers a subagent’s permission request as the conversation’s', () => {
    const relay = new NativeSubagentRelay();
    relay.inbound(note(ROOT, { sessionUpdate: 'subagent_spawned', subagentSessionId: SHORT, name: 'x', capabilities: {} }));
    const ask: Message = { jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: SHORT, options: [] } };
    expect(relay.inbound(ask)).toEqual({ ...ask, params: { sessionId: ROOT, options: [] } });
  });

  it('passes everything else through untouched', () => {
    const relay = new NativeSubagentRelay();
    const plain = note(ROOT, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
    const reply: Message = { jsonrpc: '2.0', id: 1, result: { sessionId: ROOT } };
    expect(relay.inbound(plain)).toBe(plain);
    expect(relay.inbound(reply)).toBe(reply);
  });
});

describe('relayNativeSubagents', () => {
  it('rewrites the stream a connection reads, leaving what it writes alone', async () => {
    const source = new ReadableStream<Message>({
      start(c) {
        for (const m of RECORDED.slice(0, 4)) c.enqueue(m);
        c.close();
      },
    });
    const writable = new WritableStream<Message>();
    const relayed = relayNativeSubagents({ readable: source, writable });
    expect(relayed.writable).toBe(writable);
    const got: Message[] = [];
    for await (const m of relayed.readable as unknown as AsyncIterable<Message>) got.push(m);
    expect(got.map((m) => updateOf(m).sessionUpdate)).toEqual(['tool_call_update', 'tool_call']);
  });
});

/** The relay's output, as the translator reads it: names on the cards, and each card's own end. */
describe('native subagent sessions, through the translator', () => {
  function run(): { starts: ToolEvent[]; ends: Array<[string, boolean]>; text: string[] } {
    const starts: ToolEvent[] = [];
    const ends: Array<[string, boolean]> = [];
    const text: string[] = [];
    const st: TurnState = {
      handlers: {
        onText: (d) => text.push(d),
        onToolStart: (e) => starts.push(e),
        onToolFinish: () => {},
        onSegmentBreak: () => {},
        onSubagentEnd: (parent, ok) => ends.push([parent, ok]),
      },
      lastSegment: 'none',
      toolLedger: new Map(),
      toolIndexSeq: 0,
      subagents: new Map(),
    };
    for (const m of relayAll(RECORDED)) translateUpdate(updateOf(m) as unknown as SessionUpdate, st);
    return { starts, ends, text };
  }

  it('names each subagent’s tools though the call that started it never arrived', () => {
    expect(run().starts.map((e) => [e.parent, e.agent, e.inputPreview])).toEqual([
      [SHORT_CALL, 'short one', 'sleep 3; echo short-ok'],
      [LONG_CALL, 'long one', 'sleep 40; echo long-ok'],
    ]);
  });

  it('ends each subagent when it ends, not when the turn does', () => {
    expect(run().ends).toEqual([
      [SHORT_CALL, true],
      [LONG_CALL, false],
    ]);
  });

  it('keeps a subagent’s own words out of the reply', () => {
    expect(run().text).toEqual(['launched']);
  });
});
