import { describe, expect, it } from 'vitest';
import type { CreateElicitationRequest, SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk';
import {
  acpMcpServers,
  toolLabel,
  dshModelDisplayValue,
  dshModelSelectorValue,
  effortSelectorOf,
  liveEffortName,
  liveModelName,
  isResultUsage,
  parseFormElicitation,
  promptBlocks,
  resolveHarness,
  translateUpdate,
  type TurnState,
} from './agent-acp.js';
import type { AgentDef } from '../config/schema.js';
import type { AgentUsage } from './agent.js';

/** Recording TurnState: capture handler calls as an event string for order assertions. */
function recorder(): {
  st: TurnState;
  events: string[];
  commands: unknown[];
  usage: AgentUsage[];
  models: string[];
  efforts: Array<string | undefined>;
  configOptions: Array<SessionConfigOption[] | null | undefined>;
} {
  const events: string[] = [];
  const commands: unknown[] = [];
  const usage: AgentUsage[] = [];
  const models: string[] = [];
  const efforts: Array<string | undefined> = [];
  const configOptions: Array<SessionConfigOption[] | null | undefined> = [];
  const st: TurnState = {
    handlers: {
      onText: (d) => events.push(`text:${d}`),
      onToolStart: (e) => events.push(`start:${e.name}|${e.inputPreview}`),
      onToolFinish: (e) => events.push(`finish:${e.name}|${e.ok}`),
      onSegmentBreak: () => events.push('seg'),
      onAvailableCommands: (c) => commands.push(c),
      onUsage: (u) => usage.push(u),
      onModel: (m) => models.push(m),
      onEffort: (e) => efforts.push(e),
    },
    lastSegment: 'none',
    toolLedger: new Map(),
    toolIndexSeq: 0,
    onConfigOptions: (o) => configOptions.push(o),
  };
  return { st, events, commands, usage, models, efforts, configOptions };
}

const feed = (st: TurnState, u: unknown) => translateUpdate(u as SessionUpdate, st);

describe('translateUpdate tool state machine (ACP generic)', () => {
  it('params arrive late: pending empty input not rendered, then rendered once with kind short name + truncated params', () => {
    const { st, events } = recorder();
    // 1) first pending, empty input, placeholder title → not rendered
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Terminal', kind: 'execute', rawInput: {}, status: 'pending' });
    expect(events).toEqual([]);
    // 2) params streamed (same id overwrites) → render: name from kind (execute→Bash), preview from rawInput.command
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: '`gh ...`', kind: 'execute', rawInput: { command: 'gh ...' }, status: 'pending' });
    expect(events).toEqual(['start:Bash|gh ...']);
    // 3) completed
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    expect(events).toEqual(['start:Bash|gh ...', 'finish:Bash|true']);
  });

  it('always-empty input but status advances: still renders, preview degrades to title (does not show "{}")', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Terminal', kind: 'execute', rawInput: {}, status: 'pending' });
    expect(events).toEqual([]);
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' });
    expect(events).toEqual(['start:Bash|Terminal']); // empty rawInput → preview degrades to title
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    expect(events).toEqual(['start:Bash|Terminal', 'finish:Bash|true']);
  });

  it('terminal arrives first (no in_progress): synthesize one start then finish', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read x', kind: 'read', rawInput: { file_path: 'src/x.ts' }, status: 'completed' });
    expect(events).toEqual(['start:Read|src/x.ts', 'finish:Read|true']);
  });

  it('failed → onToolFinish ok=false', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput: { command: 'boom' }, status: 'in_progress' });
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
    expect(events).toEqual(['start:Bash|boom', 'finish:Bash|false']);
  });

  it('text→tool boundary triggers onSegmentBreak once', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll run it" } });
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput: { command: 'ls' }, status: 'in_progress' });
    expect(events).toEqual(["text:I'll run it", 'seg', 'start:Bash|ls']);
  });

  it('falls back to the truncated title (backticks stripped) when there is no kind', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: '`do-thing`', rawInput: { x: 1 }, status: 'in_progress' });
    // no kind → name uses stripCode(title)='do-thing'; preview from rawInput summary
    expect(events[0]).toBe('start:do-thing|{"x":1}');
  });

  /**
   * CodeBuddy Code's own frame order, captured on the wire 2026-11-02 by
   * project-scripts/cbc-acp-probe/probe.mjs (fields shortened, nothing renamed).
   *
   * It opens every call with a placeholder — `title:"Bash"`, `kind:"other"`, empty rawInput, and
   * status ALREADY `in_progress` — which is enough for the readiness rule to draw it, and says
   * nothing: the row read `⚙️ Tool: "Bash"` and the command never appeared. The parameters and the
   * real kind arrive on the frames after, so a drawn row has to be able to follow them.
   */
  it('cbc: a placeholder row is corrected when the parameters stream in', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', kind: 'other', rawInput: {}, status: 'in_progress' });
    // The bare identifier in the title is the tool's name (see toolLabel), the preview repeats it.
    expect(events).toEqual(['start:Bash|Bash']);
    // command streaming: still empty, still nothing better to say
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', rawInput: { command: '' } });
    expect(events).toEqual(['start:Bash|Bash']);
    // the command arrives — same index, rewritten
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', rawInput: { command: 'echo hi', description: 'Print hi' } });
    expect(events).toEqual(['start:Bash|Bash', 'start:Bash|echo hi']);
    // and the call is re-sent whole, this time with the real kind and title — same row still
    feed(st, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      status: 'pending',
      title: '`echo hi`',
      kind: 'execute',
      rawInput: { command: 'echo hi', description: 'Print hi' },
    });
    expect(events).toEqual(['start:Bash|Bash', 'start:Bash|echo hi']);
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    expect(events).toEqual(['start:Bash|Bash', 'start:Bash|echo hi', 'finish:Bash|true']);
  });

  it('cbc: no re-render once the call has finished', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', kind: 'other', rawInput: {}, status: 'in_progress' });
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    const settled = [...events];
    // A stray late frame must not reopen a row that already carries its ✓.
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'execute', rawInput: { command: 'echo hi' } });
    expect(events).toEqual(settled);
  });

  it('available_commands_update normalizes to {name,description,hint} for onAvailableCommands', () => {
    const { st, commands, events } = recorder();
    feed(st, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'create_plan', description: 'Create a plan', input: { hint: 'Describe the goal' } },
        { name: 'review', description: 'Review' }, // no input → hint undefined
      ],
    });
    expect(events).toEqual([]); // doesn't pollute the text/tool event stream
    expect(commands).toEqual([
      [
        { name: 'create_plan', description: 'Create a plan', hint: 'Describe the goal' },
        { name: 'review', description: 'Review', hint: undefined },
      ],
    ]);
  });
});

/**
 * Subagent attribution, from the `claude` adapter's `_meta.claudeCode`.
 *
 * CONTRACT TEST: the fixtures are claude-agent-acp 0.81.2's own updates, captured on the wire
 * 2026-10-10 by project-scripts/subagent-output/probe.mjs (long fields shortened, nothing renamed).
 * Neither `parentToolUseId` nor `subagent` is in the ACP schema; if an adapter upgrade renames
 * them, these fail rather than the bubbles silently losing their owner again.
 */
describe('translateUpdate subagent attribution (claude adapter _meta)', () => {
  const AGENT = 'toolu_01MddhweBrYt8mzCoULZaen4';
  const agentMeta = { claudeCode: { toolName: 'Agent', subagent: true } };
  const subMeta = { claudeCode: { toolName: 'Bash', parentToolUseId: AGENT } };

  /** The spawning Agent call as the adapter streams it: placeholder title first, input field by field. */
  function spawn(st: TurnState, id = AGENT, description = 'probe subagent'): void {
    feed(st, { _meta: agentMeta, toolCallId: id, sessionUpdate: 'tool_call', rawInput: {}, status: 'pending', title: 'Task', kind: 'think' });
    feed(st, { _meta: agentMeta, toolCallId: id, sessionUpdate: 'tool_call_update', rawInput: { subagent_type: 'general-purpose' }, title: 'Task', kind: 'think' });
    feed(st, {
      _meta: agentMeta,
      toolCallId: id,
      sessionUpdate: 'tool_call_update',
      rawInput: { subagent_type: 'general-purpose', description },
      title: description,
      kind: 'think',
    });
    feed(st, {
      _meta: agentMeta,
      toolCallId: id,
      sessionUpdate: 'tool_call_update',
      rawInput: { subagent_type: 'general-purpose', description, prompt: 'Run the Bash command `echo probe-ok`…' },
      title: description,
      kind: 'think',
    });
  }

  function subagentBash(st: TurnState, id: string, command: string, parent = AGENT): void {
    const meta = { claudeCode: { ...subMeta.claudeCode, parentToolUseId: parent } };
    feed(st, { _meta: meta, toolCallId: id, sessionUpdate: 'tool_call', rawInput: { command, description: 'x' }, status: 'pending', title: command, kind: 'execute' });
    feed(st, { _meta: meta, toolCallId: id, sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: 'probe-ok' });
  }

  /** A TurnState that records each started tool as `{name, preview, agent}`; `null` = no session map. */
  function toolRecorder(subagents: Map<string, string> | null = new Map()) {
    const { st, events } = recorder();
    const started: Array<{ name: string; preview: string; agent?: string }> = [];
    st.handlers.onToolStart = (e) => started.push({ name: e.name, preview: e.inputPreview, agent: e.agent });
    if (subagents) st.subagents = subagents;
    return { st, events, started };
  }

  it("marks a subagent's tool with the name of the call that spawned it, and leaves the main agent's unmarked", () => {
    const { st, started } = toolRecorder();
    spawn(st);
    subagentBash(st, 'toolu_018RDD4EE8ecLgv1sapMnjRx', 'echo probe-ok');
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 'main-read', kind: 'read', rawInput: { file_path: 'a.ts' }, status: 'completed' });
    expect(started).toEqual([
      { name: 'Task', preview: 'probe subagent', agent: undefined },
      { name: 'Bash', preview: 'echo probe-ok', agent: 'probe subagent' },
      { name: 'Read', preview: 'a.ts', agent: undefined },
    ]);
  });

  it('draws the spawning call only once its description is in, so it shows the name its subagent will carry', () => {
    const { st, started } = toolRecorder();
    feed(st, { _meta: agentMeta, toolCallId: AGENT, sessionUpdate: 'tool_call', rawInput: {}, status: 'pending', title: 'Task', kind: 'think' });
    feed(st, { _meta: agentMeta, toolCallId: AGENT, sessionUpdate: 'tool_call_update', rawInput: { subagent_type: 'general-purpose' }, title: 'Task', kind: 'think' });
    // Before: this update drew `Task: "{"subagent_type":"general-purpose"}"`.
    expect(started).toEqual([]);
    spawn(st); // the rest of the stream, description included
    expect(started).toEqual([{ name: 'Task', preview: 'probe subagent', agent: undefined }]);
  });

  it('still draws a spawning call whose description never comes, once its status moves', () => {
    const { st, started } = toolRecorder();
    feed(st, { _meta: agentMeta, toolCallId: AGENT, sessionUpdate: 'tool_call', rawInput: { subagent_type: 'general-purpose' }, status: 'pending', title: 'Task', kind: 'think' });
    expect(started).toEqual([]);
    feed(st, { _meta: { claudeCode: { toolName: 'Agent' } }, toolCallId: AGENT, sessionUpdate: 'tool_call_update', status: 'completed' });
    expect(started).toEqual([{ name: 'Task', preview: '{"subagent_type":"general-purpose"}', agent: undefined }]);
  });

  it('names a background subagent whose tools arrive in a later turn, through the session-wide map', () => {
    const names = new Map<string, string>();
    const first = toolRecorder(names);
    spawn(first.st, AGENT, '回测按分红选股的收益与回撤');
    // The call completes as soon as the subagent is launched, and the turn ends with it.
    feed(first.st, { _meta: { claudeCode: { toolName: 'Agent' } }, toolCallId: AGENT, sessionUpdate: 'tool_call_update', status: 'completed' });

    const later = toolRecorder(names); // a fresh TurnState: new ledger, same session
    subagentBash(later.st, 'toolu_01Wbf38cV3mYb9WFfphZ63Lb', 'sleep 5; echo probe-ok');
    expect(later.started).toEqual([{ name: 'Bash', preview: 'sleep 5; echo probe-ok', agent: '回测按分红选股的收益与回撤' }]);
  });

  it('tells two parallel subagents apart', () => {
    const { st, started } = toolRecorder();
    spawn(st, 'agent-a', 'fetch prices');
    spawn(st, 'agent-b', 'build pools');
    subagentBash(st, 'b1', 'python3 pools.py', 'agent-b');
    subagentBash(st, 'a1', 'python3 fetch.py', 'agent-a');
    expect(started.slice(2).map((s) => s.agent)).toEqual(['build pools', 'fetch prices']);
  });

  it('still marks a tool whose spawning call was never seen, as an unnamed subagent', () => {
    const { st, started } = toolRecorder();
    subagentBash(st, 't1', 'ls', 'toolu_never_seen');
    expect(started).toEqual([{ name: 'Bash', preview: 'ls', agent: 'subagent' }]);
  });

  it('without a session map (pure tests, other callers) still marks the tool, unnamed', () => {
    const { st, started } = toolRecorder(null);
    spawn(st);
    subagentBash(st, 't1', 'ls');
    expect(started[1]).toEqual({ name: 'Bash', preview: 'ls', agent: 'subagent' });
  });

  it('forgets the oldest names past its bound rather than growing for the life of the session', () => {
    const names = new Map<string, string>();
    const { st } = toolRecorder(names);
    for (let i = 0; i < 70; i++) spawn(st, `agent-${i}`, `job ${i}`);
    expect(names.size).toBe(64);
    expect(names.has('agent-0')).toBe(false);
    expect(names.get('agent-69')).toBe('job 69');
  });

  it('keeps subagent-attributed text out of the reply body', () => {
    const { st, events } = toolRecorder();
    feed(st, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Launched.' } });
    feed(st, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Raw data dir is gone.' },
      _meta: { claudeCode: { parentToolUseId: AGENT } },
    });
    expect(events).toEqual(['text:Launched.']);
  });

  it('ignores malformed attribution instead of trusting it', () => {
    const { st, started } = toolRecorder();
    for (const _meta of [{ claudeCode: { parentToolUseId: 42 } }, { claudeCode: { parentToolUseId: '' } }, { claudeCode: 'x' }, null]) {
      feed(st, { _meta, sessionUpdate: 'tool_call', toolCallId: `t-${started.length}`, kind: 'execute', rawInput: { command: 'ls' }, status: 'completed' });
    }
    expect(started.map((s) => s.agent)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

/**
 * usage_update → onUsage.
 *
 * These numbers are why the footer can show a real `18k / 1M (2%)`: `used` is the harness's own
 * context tally and `size` the window it learned from the live model. Before this, the update fell
 * into translateUpdate's `default: break` and was silently dropped, which is why the pre-existing
 * `contextPct` footer field could never render.
 */
describe('translateUpdate usage_update (live context numbers)', () => {
  it('forwards used/size to onUsage without touching the text/tool stream', () => {
    const { st, usage, events } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 18_000, size: 1_000_000 });
    expect(usage).toEqual([{ used: 18_000, size: 1_000_000 }]);
    expect(events).toEqual([]);
  });

  it('does not break a text segment: a mid-stream update leaves lastSegment alone', () => {
    // claude-agent-acp emits one usage_update per assistant message, i.e. mid-body. If that counted
    // as a segment the reply would be split into separate bubbles around every update.
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } });
    feed(st, { sessionUpdate: 'usage_update', used: 1, size: 10 });
    feed(st, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } });
    expect(events).toEqual(['text:a', 'text:b']); // no 'seg' between them
    expect(st.lastSegment).toBe('text');
  });

  it('later snapshots are forwarded in order (the consumer keeps the last)', () => {
    const { st, usage } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 100, size: 1_000 });
    feed(st, { sessionUpdate: 'usage_update', used: 250, size: 1_000 });
    expect(usage.map((u) => u.used)).toEqual([100, 250]);
  });

  it('drops a snapshot with a non-positive window instead of forwarding a divide-by-zero', () => {
    const { st, usage } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 100, size: 0 });
    feed(st, { sessionUpdate: 'usage_update', used: 100, size: -1 });
    expect(usage).toEqual([]);
  });

  it('drops a malformed snapshot (missing or non-numeric fields)', () => {
    const { st, usage } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 100 });
    feed(st, { sessionUpdate: 'usage_update', size: 1_000 });
    feed(st, { sessionUpdate: 'usage_update', used: '100', size: '1000' });
    expect(usage).toEqual([]);
  });

  it('a zero-token snapshot IS forwarded (a fresh session legitimately reports 0 used)', () => {
    const { st, usage } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 0, size: 200_000 });
    expect(usage).toEqual([{ used: 0, size: 200_000 }]);
  });

  // The result-tied snapshot carries the session's cumulative cost; a busy `/usage` quotes it.
  it('carries a reported cost along, and only a well-formed one', () => {
    const { st, usage } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 1, size: 10, cost: { amount: 0.3187, currency: 'USD' } });
    feed(st, { sessionUpdate: 'usage_update', used: 2, size: 10, cost: { amount: 'lots', currency: 'USD' } });
    feed(st, { sessionUpdate: 'usage_update', used: 3, size: 10, cost: null });
    expect(usage).toEqual([
      { used: 1, size: 10, cost: { amount: 0.3187, currency: 'USD' } },
      { used: 2, size: 10 }, // the context numbers still count; only the bogus cost is dropped
      { used: 3, size: 10 },
    ]);
  });

  it('contextWindow override replaces the harness window (200k fallback → configured 1M)', () => {
    const { st, usage } = recorder();
    st.contextWindow = 1_000_000;
    feed(st, { sessionUpdate: 'usage_update', used: 201_000, size: 200_000 });
    // Same 201k tokens, but reported against the local 1M window rather than the harness's 200k.
    expect(usage).toEqual([{ used: 201_000, size: 1_000_000 }]);
  });

  it('contextWindow override supplies a window even when the harness reports none', () => {
    const { st, usage } = recorder();
    st.contextWindow = 1_000_000;
    feed(st, { sessionUpdate: 'usage_update', used: 50_000 });
    expect(usage).toEqual([{ used: 50_000, size: 1_000_000 }]);
  });

  it('without an override, a windowless snapshot is still dropped (unchanged behavior)', () => {
    const { st, usage } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 50_000 });
    expect(usage).toEqual([]);
  });
});

/**
 * The live model name.
 *
 * Needed because config can't answer the question: the `claude` harness takes its model from
 * ANTHROPIC_MODEL (the only source that survives Claude Code rewriting settings.model), so
 * `agents[].model` is empty and the alias (`opus[1m]`) is resolved inside the harness. The session's
 * `model` config option is the only place the concrete model surfaces.
 */
describe('liveModelName (model from ACP session config options)', () => {
  const opts = (o: unknown): SessionConfigOption[] => o as SessionConfigOption[];

  it('prefers the selected option\'s human-readable name', () => {
    expect(
      liveModelName(
        opts([
          {
            id: 'model',
            type: 'select',
            name: 'Model',
            currentValue: 'claude-opus-4-5',
            options: [
              { value: 'claude-sonnet-4-5', name: 'Sonnet 4.5' },
              { value: 'claude-opus-4-5', name: 'Opus 4.5' },
            ],
          },
        ]),
      ),
    ).toBe('Opus 4.5');
  });

  it('searches inside grouped options too', () => {
    expect(
      liveModelName(
        opts([
          {
            id: 'model',
            type: 'select',
            name: 'Model',
            currentValue: 'opus-1m',
            options: [
              { group: 'recommended', name: 'Recommended', options: [{ value: 'sonnet', name: 'Sonnet' }] },
              { group: 'long', name: 'Long context', options: [{ value: 'opus-1m', name: 'Opus (1M)' }] },
            ],
          },
        ]),
      ),
    ).toBe('Opus (1M)');
  });

  it('falls back to the raw currentValue when the model is not among the listed options', () => {
    // Real case: an allowlisted-but-unlisted model still reports a currentValue, and that id is
    // more useful than showing nothing.
    expect(
      liveModelName(
        opts([{ id: 'model', type: 'select', name: 'Model', currentValue: 'opus[1m]', options: [] }]),
      ),
    ).toBe('opus[1m]');
  });

  it('reads the concrete model out of the description, dropping the [1m] alias', () => {
    // The claude harness names neither the version in the id (`opus[1m]`) nor in the display name
    // ("Opus"), so a footer built from either never changed when the model behind the alias did.
    // The description is the only place it is stated. Shape probed live against
    // claude-agent-acp 0.58.1. `[1m]` goes with it: the footer's context segment already reads / 1M.
    expect(
      liveModelName(
        opts([
          {
            id: 'model',
            type: 'select',
            name: 'Model',
            currentValue: 'opus[1m]',
            options: [
              {
                value: 'opus[1m]',
                name: 'Opus',
                description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
              },
              { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
              { value: 'haiku', name: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
            ],
          },
        ])
      )
    ).toBe('opus-4-8');
  });

  it('resolves `default` to whatever it currently points at, not to the word "default"', () => {
    expect(
      liveModelName(
        opts([
          {
            id: 'model',
            type: 'select',
            name: 'Model',
            currentValue: 'default',
            options: [
              {
                value: 'default',
                name: 'Default (recommended)',
                description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
              },
            ],
          },
        ])
      )
    ).toBe('opus-4-8');
  });

  it('falls back to the name when the description states no version', () => {
    // opencode writes no description at all, and a prose one must not be mined for a model name.
    expect(
      liveModelName(
        opts([
          {
            id: 'model',
            type: 'select',
            name: 'Model',
            currentValue: 'newapi/GLM-5.2',
            options: [
              { value: 'newapi/GLM-5.2', name: 'GLM-5.2', description: 'Best for everyday tasks' },
            ],
          },
        ])
      )
    ).toBe('GLM-5.2');
  });

  it('ignores the other config options (mode / effort / fast)', () => {
    expect(
      liveModelName(
        opts([
          { id: 'mode', type: 'select', name: 'Mode', currentValue: 'ask', options: [] },
          { id: 'effort', type: 'select', name: 'Effort', currentValue: 'high', options: [] },
          { id: 'model', type: 'select', name: 'Model', currentValue: 'gpt-5', options: [] },
        ]),
      ),
    ).toBe('gpt-5');
  });

  it('returns undefined when there is no model selector at all', () => {
    expect(liveModelName(opts([{ id: 'mode', type: 'select', name: 'Mode', currentValue: 'ask', options: [] }]))).toBeUndefined();
    expect(liveModelName([])).toBeUndefined();
    expect(liveModelName(undefined)).toBeUndefined();
    expect(liveModelName(null)).toBeUndefined();
  });

  it('returns undefined for a boolean option sharing the id, or an empty currentValue', () => {
    expect(liveModelName(opts([{ id: 'model', type: 'boolean', name: 'Model', currentValue: true }]))).toBeUndefined();
    expect(
      liveModelName(opts([{ id: 'model', type: 'select', name: 'Model', currentValue: '', options: [] }])),
    ).toBeUndefined();
  });
});

describe('translateUpdate config_option_update (mid-session model switch)', () => {
  it('reports the newly selected model via onModel', () => {
    const { st, models, events } = recorder();
    feed(st, {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          type: 'select',
          name: 'Model',
          currentValue: 'claude-sonnet-4-5',
          options: [{ value: 'claude-sonnet-4-5', name: 'Sonnet 4.5' }],
        },
      ],
    });
    expect(models).toEqual(['Sonnet 4.5']);
    expect(events).toEqual([]);
  });

  it('hands the whole option list back to the session, not just the model name', () => {
    // onModel alone kept the FOOTER current while modelSelector() went on reporting the value
    // session/new had reported — so a /model menu opened after a mid-session switch marked the
    // wrong model as current and opened on the wrong page.
    const { st, configOptions } = recorder();
    const options: SessionConfigOption[] = [
      {
        id: 'model',
        type: 'select',
        name: 'Model',
        currentValue: 'newapi/GLM-5.2',
        options: [
          { value: 'newapi/GLM-5.2', name: 'GLM-5.2' },
          { value: 'newapi/deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        ],
      },
    ];
    feed(st, { sessionUpdate: 'config_option_update', configOptions: options });
    expect(configOptions).toEqual([options]);
  });

  it('stays silent when the update carries no model selector', () => {
    const { st, models } = recorder();
    feed(st, {
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'effort', type: 'select', name: 'Effort', currentValue: 'high', options: [] }],
    });
    expect(models).toEqual([]);
  });
});

/**
 * Reasoning effort for the footer. The option shapes are the real ones probed on 2026-09-23 — the
 * point being that the ids differ per harness (`effort` / `reasoning_effort`) while the category
 * agrees, so the lookup has to go by category.
 */
describe('liveEffortName (effort from ACP session config options)', () => {
  const opts = (o: unknown): SessionConfigOption[] => o as SessionConfigOption[];
  const effort = (id: string, currentValue: unknown) => ({
    id,
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
  });

  it('finds the level by category, whatever the harness calls the option', () => {
    // claude-agent-acp / opencode
    expect(liveEffortName(opts([effort('effort', 'xhigh')]))).toBe('xhigh');
    // codex-acp
    expect(liveEffortName(opts([effort('reasoning_effort', 'high')]))).toBe('high');
  });

  it('ignores an `effort` id that is not in the thought_level category', () => {
    expect(
      liveEffortName(opts([{ id: 'effort', type: 'select', name: 'Effort', currentValue: 'high', options: [] }])),
    ).toBeUndefined();
  });

  it('omits `default`, which names no level', () => {
    expect(liveEffortName(opts([effort('effort', 'default')]))).toBeUndefined();
  });

  it('is undefined with no such option (opencode on a model without variants, agy, dsh)', () => {
    expect(
      liveEffortName(opts([{ id: 'mode', category: 'mode', type: 'select', name: 'Mode', currentValue: 'build', options: [] }])),
    ).toBeUndefined();
    expect(liveEffortName(undefined)).toBeUndefined();
    expect(liveEffortName(null)).toBeUndefined();
    expect(liveEffortName(opts([effort('effort', true)]))).toBeUndefined();
  });

  it('config_option_update reports the new level, and clears it when the level goes away', () => {
    const { st, efforts } = recorder();
    feed(st, { sessionUpdate: 'config_option_update', configOptions: [effort('effort', 'max')] });
    // e.g. `/effort default`: the option is still there but names no level any more.
    feed(st, { sessionUpdate: 'config_option_update', configOptions: [effort('effort', 'default')] });
    // e.g. opencode switched to a model without reasoning variants: the option vanished.
    feed(st, { sessionUpdate: 'config_option_update', configOptions: [] });
    expect(efforts).toEqual(['max', undefined, undefined]);
  });
});

/**
 * The same option read for `/effort` instead of the footer. The one deliberate difference from
 * liveEffortName is `default`: the footer drops it, a selector must keep it, because on claude and
 * opencode it is a choice and a menu with no ● would leave the user unable to tell where they are.
 */
describe('effortSelectorOf (the /effort menu’s view of the same option)', () => {
  const opts = (o: unknown): SessionConfigOption[] => o as SessionConfigOption[];
  const effort = (id: string, currentValue: unknown, values: string[]) => ({
    id,
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: values.map((v) => ({ value: v, name: v === 'xhigh' ? 'Xhigh' : '' })),
  });

  it('keeps `default` as the current level, where the footer would drop it', () => {
    const o = opts([effort('effort', 'default', ['default', 'low', 'high'])]);
    expect(liveEffortName(o)).toBeUndefined();
    expect(effortSelectorOf(o)?.current).toBe('default');
  });

  it('finds codex’s differently named option, and falls back to the value for a blank name', () => {
    const sel = effortSelectorOf(opts([effort('reasoning_effort', 'high', ['low', 'high', 'xhigh'])]));
    expect(sel).toEqual({
      current: 'high',
      options: [
        { value: 'low', name: 'low' },
        { value: 'high', name: 'high' },
        { value: 'xhigh', name: 'Xhigh' },
      ],
    });
  });

  it('is undefined for no option, a non-select option, or an empty list', () => {
    expect(effortSelectorOf(undefined)).toBeUndefined();
    expect(
      effortSelectorOf(opts([{ id: 'effort', category: 'thought_level', type: 'boolean', name: 'E', currentValue: true }])),
    ).toBeUndefined();
    expect(effortSelectorOf(opts([effort('effort', 'high', [])]))).toBeUndefined();
  });
});

/**
 * Label choice when the harness's own option names are inconsistent.
 *
 * The option list below is the REAL one captured from claude-agent-acp with ANTHROPIC_MODEL=opus[1m]
 * (currentValue "opus[1m]"). Note the inconsistency: `sonnet[1m]` is labelled "Sonnet 5 (1M context)"
 * but `opus[1m]` is labelled plain "Opus". Reporting the bare name would show a 1M-context session as
 * "Opus" while the footer's context segment simultaneously reads `/ 1M` — so the id wins whenever the
 * name drops a bracketed qualifier.
 */
describe('liveModelName label choice (real claude-agent-acp option list)', () => {
  const REAL_OPTIONS = [
    { value: 'default', name: 'Default (recommended)' },
    { value: 'opus[1m]', name: 'Opus' },
    { value: 'sonnet', name: 'Sonnet' },
    { value: 'sonnet[1m]', name: 'Sonnet 5 (1M context)' },
    { value: 'haiku', name: 'Haiku' },
  ];

  const withCurrent = (currentValue: string): SessionConfigOption[] =>
    [{ id: 'model', type: 'select', name: 'Model', currentValue, options: REAL_OPTIONS }] as SessionConfigOption[];

  it('keeps the id when the name silently drops [1m] (the deployed case)', () => {
    expect(liveModelName(withCurrent('opus[1m]'))).toBe('opus[1m]');
  });

  it('uses the friendly name when it already conveys the 1M qualifier', () => {
    expect(liveModelName(withCurrent('sonnet[1m]'))).toBe('Sonnet 5 (1M context)');
  });

  it('uses the friendly name for ids with no qualifier at all', () => {
    expect(liveModelName(withCurrent('sonnet'))).toBe('Sonnet');
    expect(liveModelName(withCurrent('haiku'))).toBe('Haiku');
    expect(liveModelName(withCurrent('default'))).toBe('Default (recommended)');
  });

  it('a name that spells the qualifier differently still counts as carrying it', () => {
    // "[1m]" vs "1M context" vs "1m" — matching is bracket-insensitive and case-insensitive, so a
    // harness rewording its labels does not silently flip us back to raw ids.
    const opts = (name: string): SessionConfigOption[] =>
      [{ id: 'model', type: 'select', name: 'Model', currentValue: 'opus[1m]', options: [{ value: 'opus[1m]', name }] }] as SessionConfigOption[];
    expect(liveModelName(opts('Opus (1M)'))).toBe('Opus (1M)');
    expect(liveModelName(opts('Opus 1m'))).toBe('Opus 1m');
    expect(liveModelName(opts('Opus [1M] context'))).toBe('Opus [1M] context');
  });

  it('a bare version number in the name does not count as a context qualifier', () => {
    // "Opus 5" says which model, not which context window — it must not satisfy [1m].
    const opts = [{ id: 'model', type: 'select', name: 'Model', currentValue: 'opus[1m]', options: [{ value: 'opus[1m]', name: 'Opus 5' }] }] as SessionConfigOption[];
    expect(liveModelName(opts)).toBe('opus[1m]');
  });
});

/**
 * The dsh (DeepSeek Harness) preset and its model-value encoding.
 *
 * DSH's ACP bridge encodes a model selection as JSON.stringify([provider, model]) — see modelValue
 * in @deepseek-ai/dsh-acp lib/types/model-control.js — so talkcode's "provider/model" spelling
 * must be JSON-encoded to cross the wire (a bare "provider/model" is "unknown model option") and
 * decoded again to present a readable /model menu.
 */
describe('codex harness preset', () => {
  const def = (o: Record<string, unknown>): AgentDef => o as AgentDef;

  it('resolveHarness runs codex-acp from PATH, not a bundled dependency', () => {
    // The contract this pins is a packaging decision, not a spelling: codex-acp pulls in
    // @openai/codex's ~284 MB platform binary, so it is installed alongside the daemon (by the
    // image, or by hand) the way gemini/opencode/dsh are — never resolved out of node_modules.
    expect(resolveHarness(def({ id: 'cx', harness: 'codex', args: [] }))).toEqual({
      command: 'codex-acp',
      args: [],
    });
  });

  it('resolveHarness appends def.args', () => {
    expect(resolveHarness(def({ id: 'cx', harness: 'codex', args: ['--foo'] }))).toEqual({
      command: 'codex-acp',
      args: ['--foo'],
    });
  });
});

describe('dsh harness preset', () => {
  const def = (o: Record<string, unknown>): AgentDef => o as AgentDef;

  it('resolveHarness launches dsh through its ACP profile', () => {
    expect(resolveHarness(def({ id: 'ds', harness: 'dsh', args: [] }))).toEqual({ command: 'dsh', args: ['--profile', 'acp'] });
  });

  it('resolveHarness appends def.args after the profile switch', () => {
    expect(resolveHarness(def({ id: 'ds', harness: 'dsh', args: ['--verbose'] }))).toEqual({
      command: 'dsh',
      args: ['--profile', 'acp', '--verbose'],
    });
  });

  it('dshModelSelectorValue: "provider/model" → the JSON string dsh set_config_option accepts', () => {
    expect(dshModelSelectorValue('newapi/deepseek-v4-flash-0731')).toBe('["newapi","deepseek-v4-flash-0731"]');
  });

  it('dshModelSelectorValue: a provider-less model encodes with an empty provider (rejected by the offer check, not by dsh)', () => {
    expect(dshModelSelectorValue('deepseek-v4-flash-0731')).toBe('["","deepseek-v4-flash-0731"]');
  });

  it('dshModelDisplayValue round-trips the wire value back to "provider/model"', () => {
    expect(dshModelDisplayValue('["newapi","deepseek-v4-flash-0731"]')).toBe('newapi/deepseek-v4-flash-0731');
  });

  it('dshModelDisplayValue passes non-array / non-JSON values through unchanged (non-dsh harnesses)', () => {
    expect(dshModelDisplayValue('claude-opus-4-5')).toBe('claude-opus-4-5');
    expect(dshModelDisplayValue('[1,2]')).toBe('[1,2]');
  });
});

/**
 * `session_info_update` — the harness's own name for the conversation, deliberately ignored.
 *
 * The gateway used to follow it and rename the chat lane on every change. It does not any more:
 * claude-agent-acp regenerates the title as a session moves on, so topics drifted to whatever had
 * been discussed most recently. Conversations are now named once from their opening message (see
 * ConversationRegistry.nameConversation), and this notification falls through to `default: break`.
 */
describe('translateUpdate session_info_update (ignored)', () => {
  it('renders nothing and reports nothing', () => {
    const r = recorder();
    feed(r.st, { sessionUpdate: 'session_info_update', title: 'Fix the ask timeout' });
    expect(r.events).toEqual([]);
    expect(r.usage).toEqual([]);
    expect(r.models).toEqual([]);
  });

  // The field is `string | null` in the schema and an update carrying only `updatedAt` is a
  // legitimate partial. Neither shape may reach the default branch as anything but a no-op.
  it('is a no-op for a cleared or absent title too', () => {
    const r = recorder();
    feed(r.st, { sessionUpdate: 'session_info_update', title: null });
    feed(r.st, { sessionUpdate: 'session_info_update', updatedAt: '2026-09-08T00:00:00Z' });
    expect(r.events).toEqual([]);
  });
});

/**
 * `isResultUsage` is how a burst of out-of-turn output knows it is over.
 *
 * claude-agent-acp settles the ACP prompt at a turn's terminal `result` so the client unlocks while
 * background work continues, then keeps streaming that work's output with no prompt in flight. The
 * gateway renders it as a follow-up message — and in the default `once` delivery mode nothing is
 * sent until the buffer completes, so "the background work finished" has to be detectable. The
 * result-tied `usage_update` carries `cost`; the mid-stream snapshots do not.
 */
describe('isResultUsage (end of a burst of background output)', () => {
  it('recognises the usage_update the harness sends with a completed result', () => {
    expect(
      isResultUsage({
        sessionUpdate: 'usage_update',
        used: 1000,
        size: 200_000,
        cost: { amount: 0.12, currency: 'USD' },
      } as SessionUpdate)
    ).toBe(true);
  });

  it('does not mistake a mid-stream snapshot for one', () => {
    expect(
      isResultUsage({ sessionUpdate: 'usage_update', used: 1000, size: 200_000 } as SessionUpdate)
    ).toBe(false);
  });

  // The schema types cost as `Cost | null`, and a harness sending an explicit null is saying
  // "no cost known", not "this is a result".
  it('treats an explicit null cost as not a result', () => {
    expect(
      isResultUsage({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: null } as SessionUpdate)
    ).toBe(false);
  });

  it('ignores every other kind of update', () => {
    expect(
      isResultUsage({ sessionUpdate: 'session_info_update', title: 'anything' } as SessionUpdate)
    ).toBe(false);
    expect(
      isResultUsage({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      } as SessionUpdate)
    ).toBe(false);
  });
});

describe('parseFormElicitation (agent asks the user, ACP elicitation/create)', () => {
  /**
   * Captured live from claude-agent-acp on 2026-09-11 by advertising
   * `clientCapabilities.elicitation.form` and prompting "MySQL or Postgres? ask me first".
   * Kept verbatim (Chinese text and all) because the field layout — `question_<n>` +
   * `question_<n>_custom`, `oneOf` of `{const,title,description}`, question text in `message`
   * rather than in the property — is what the parser reads, and a hand-written fixture would
   * have quietly encoded a guess about it.
   */
  const REAL: CreateElicitationRequest = {
    mode: 'form',
    sessionId: '429f5c2d-f046-4c24-a700-a636ddd5b674',
    toolCallId: 'toolu_01Gt6JuHbhuaX3BRYAh1Gpps',
    message: '这个项目用哪个数据库？',
    requestedSchema: {
      type: 'object',
      properties: {
        question_0: {
          type: 'string',
          title: '数据库',
          oneOf: [
            { const: 'PostgreSQL', title: 'PostgreSQL', description: '你现有基础设施已经在跑 postgresql15 / pgvector。' },
            { const: 'MySQL', title: 'MySQL', description: '生态广泛，但当前没有现成实例。' },
            { const: '先不定，等我看完项目', title: '先不定，等我看完项目' },
          ],
        },
        question_0_custom: {
          type: 'string',
          title: 'Other',
          description: 'Type your own answer instead of choosing an option above (optional).',
        },
      },
    },
  } as unknown as CreateElicitationRequest;

  it('reads one round out of the real single-question payload', () => {
    const e = parseFormElicitation(REAL)!;
    expect(e.message).toBe('这个项目用哪个数据库？');
    expect(e.questions).toHaveLength(1); // the `_custom` free-text box is not a round
    const q = e.questions[0]!;
    expect(q.key).toBe('question_0');
    // Single-question forms leave `description` unset, so the prompt comes from `message`.
    expect(q.prompt).toBe('这个项目用哪个数据库？');
    expect(q.multi).toBe(false);
    expect(q.options.map((o) => o.value)).toEqual(['PostgreSQL', 'MySQL', '先不定，等我看完项目']);
  });

  it('keeps each option\'s reasoning, which is why buttons beat prose', () => {
    const opts = parseFormElicitation(REAL)!.questions[0]!.options;
    expect(opts[0]!.description).toContain('pgvector');
    expect(opts[2]!.description).toBeUndefined(); // absent, not empty string
  });

  it('records the free-text field, which is where a typed reply is sent back', () => {
    // Not a round of its own (a button row cannot collect free text), but not discarded either:
    // this key is the only honest place to put an answer the user typed, and the harness prefers
    // it over the enum field. Without it, honouring a typed reply would mean sending `question_0`
    // a value the agent never offered.
    expect(parseFormElicitation(REAL)!.questions[0]!.customKey).toBe('question_0_custom');
  });

  it('claims no free-text field when the form declared none', () => {
    // An MCP server's own elicitation: enum options, no "Other" box. Such a question can only be
    // answered by tapping, and the daemon leaves a typed message meaning what it always meant.
    const e = parseFormElicitation({
      mode: 'form', sessionId: 's', message: 'pick',
      requestedSchema: { type: 'object', properties: { choice: { type: 'string', oneOf: [{ const: 'a', title: 'A' }] } } },
    } as unknown as CreateElicitationRequest)!;
    expect(e.questions[0]!.customKey).toBeUndefined();
  });

  it('carries the per-question text when a form asks several things', () => {
    const e = parseFormElicitation({
      mode: 'form',
      sessionId: 's',
      message: 'Please answer the following questions.',
      requestedSchema: {
        type: 'object',
        properties: {
          question_0: { type: 'string', description: 'Which database?', oneOf: [{ const: 'pg', title: 'Postgres' }] },
          question_1: { type: 'array', description: 'Which regions?', items: { anyOf: [{ const: 'eu', title: 'EU' }] } },
        },
      },
    } as unknown as CreateElicitationRequest)!;
    expect(e.questions.map((q) => q.prompt)).toEqual(['Which database?', 'Which regions?']);
    expect(e.questions.map((q) => q.multi)).toEqual([false, true]);
    // `title` is display, `const` is the answer — an MCP server may make them differ.
    expect(e.questions[0]!.options[0]).toEqual({ label: 'Postgres', value: 'pg' });
  });

  it('declines what it cannot put in front of a user', () => {
    // url mode: nothing to render as buttons, and no answer to correlate back.
    expect(parseFormElicitation({ mode: 'url', sessionId: 's', message: 'go here', elicitationId: 'e', url: 'https://x' } as unknown as CreateElicitationRequest)).toBeNull();
    // An option with no `const` has no value to send back, so its question has no options left.
    expect(
      parseFormElicitation({
        mode: 'form', sessionId: 's', message: 'pick',
        requestedSchema: { type: 'object', properties: { question_0: { type: 'string', oneOf: [{ title: 'no const here' }] } } },
      } as unknown as CreateElicitationRequest)
    ).toBeNull();
    // A form with only the free-text box: nothing tappable.
    expect(
      parseFormElicitation({
        mode: 'form', sessionId: 's', message: 'pick',
        requestedSchema: { type: 'object', properties: { question_0_custom: { type: 'string', title: 'Other' } } },
      } as unknown as CreateElicitationRequest)
    ).toBeNull();
  });
});

/**
 * What a session is given besides the user's words: tools, and nothing in the prompt. These pin
 * both halves — the prompt is the user's text alone, and every session gets the native-tool server
 * with what it needs spelled out in its environment.
 */
describe('what the agent is given', () => {
  it('sends the user\'s text as the only prompt block — no preamble on any turn', () => {
    expect(promptBlocks({ prompt: 'fix the build' }, true)).toEqual([{ type: 'text', text: 'fix the build' }]);
  });

  const shots = [
    { name: 'a.png', mimeType: 'image/png' as const, data: 'iVBORw0K' },
    { name: 'b.jpg', mimeType: 'image/jpeg' as const, data: '/9j/4AAQ' },
  ];

  it('puts the pictures in as pictures, in order and before the text, when the harness takes them', () => {
    expect(promptBlocks({ prompt: 'what is wrong here?', images: shots }, true)).toEqual([
      { type: 'image', data: 'iVBORw0K', mimeType: 'image/png' },
      { type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' },
      { type: 'text', text: 'what is wrong here?' },
    ]);
  });

  it('sends text only to a harness that did not claim promptCapabilities.image — the prompt still names the paths', () => {
    expect(promptBlocks({ prompt: 'what is wrong here?', images: shots }, false)).toEqual([
      { type: 'text', text: 'what is wrong here?' },
    ]);
  });

  it('hands every session the stdio tool server, with token, socket and cwd in its own env', () => {
    const self = { command: '/usr/bin/node', args: ['--import', 'tsx', '/srv/aa/dist/cli.js'] };
    expect(acpMcpServers('tok-1', '/run/aa.sock', '/work/p', self)).toEqual([
      {
        name: 'chat',
        command: '/usr/bin/node',
        args: ['--import', 'tsx', '/srv/aa/dist/cli.js', 'mcp'],
        env: [
          { name: 'TALKCODE_TURN_TOKEN', value: 'tok-1' },
          { name: 'TALKCODE_SOCKET', value: '/run/aa.sock' },
          { name: 'TALKCODE_CWD', value: '/work/p' },
        ],
      },
    ]);
  });

  it('hands none when this process cannot re-invoke itself (a test worker), rather than a broken entry', () => {
    expect(acpMcpServers('tok-1', '/run/aa.sock', '/work/p', null)).toEqual([]);
    // And the default — this very process — is a vitest worker, so it must take the same path.
    expect(acpMcpServers('tok-1', '/run/aa.sock', '/work/p')).toEqual([]);
  });
});

describe('toolLabel', () => {
  it('names an MCP tool by its own name instead of the bare "Tool" every one would share', () => {
    expect(toolLabel('other', 'mcp__chat__schedule')).toBe('schedule');
    expect(toolLabel(undefined, 'mcp__tackle_twist__send_file')).toBe('send_file');
    expect(toolLabel('other', 'something else')).toBe('Tool');
    expect(toolLabel('execute', 'mcp__chat__x')).toBe('Bash');
  });

  it('takes a bare identifier in the title as the tool name under kind "other"', () => {
    // CodeBuddy Code's shape: the tool's own name, with the kind it always falls back to.
    expect(toolLabel('other', 'ToolSearch')).toBe('ToolSearch');
    expect(toolLabel('other', 'DeferExecuteTool')).toBe('DeferExecuteTool');
    // A sentence is not a name — that stays the generic row.
    expect(toolLabel('other', 'Update todos')).toBe('Tool');
  });
});
