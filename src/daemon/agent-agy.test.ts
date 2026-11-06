import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agyModelId,
  buildAgyArgs,
  consumeNdJsonLines,
  createAgyAgentFactory,
  toolLabel,
  translateAgyEvent,
  type AgyEvent,
  type AgyTurnState,
} from './agent-agy.js';
import {
  fetchAgyModelsFor,
  formatAgyCliOutput,
  formatAgyQuota,
  parseAgyModelsOutput,
  type AgyCliRunner,
} from './agy-cli.js';
import { buildInputPreview } from './agent-common.js';
import { AGY_STATUS_FD, AGY_STATUS_FD_ENV, ensureAgyStatusLine } from './agy-statusline.js';
import { AgentDefSchema, type Config } from '../config/schema.js';
import type { AgentStreamHandlers, AgentUsage } from './agent.js';
import type { QuotaPool } from '../types.js';

// Pass-throughs by default, so every test that never spawns is untouched; the session tests at the
// bottom swap in a scripted child. The status-line install is stubbed so no test can reach the
// operator's agy settings, and so a test can claim it was wired.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('./agy-statusline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agy-statusline.js')>();
  return { ...actual, ensureAgyStatusLine: vi.fn(() => 'skipped' as const) };
});

/**
 * Every event fixture here is a verbatim shape captured from a real `agy 1.1.22` run
 * (`--input-format=stream-json --output-format=stream-json`), so these tests pin the actual wire
 * format rather than an assumed one.
 */

/** Recording TurnState: capture handler calls as an event string for order assertions. */
function recorder(): { st: AgyTurnState; events: string[] } {
  const events: string[] = [];
  const st: AgyTurnState = {
    handlers: {
      onText: (d) => events.push(`text:${d}`),
      onToolStart: (e) => events.push(`start:${e.name}|${e.inputPreview}`),
      onToolFinish: (e) => events.push(`finish:${e.name}|${e.ok}|${e.durationMs}`),
      onSegmentBreak: () => events.push('seg'),
      onAvailableCommands: () => events.push('cmds'),
      onNotice: (t) => events.push(`notice:${t}`),
    },
    agentId: 'ag',
    lastSegment: 'none',
    endsInReply: false,
    sawErrorStep: false,
    toolLedger: new Map(),
    toolIndexSeq: 0,
  };
  return { st, events };
}

const feed = (st: AgyTurnState, u: unknown): boolean => translateAgyEvent(u as AgyEvent, st);

const def = (over: Record<string, unknown> = {}) =>
  AgentDefSchema.parse({ id: 'a', harness: 'agy', ...over });

describe('translateAgyEvent — text streaming', () => {
  it('text_delta is incremental: each delta is pushed through untouched', () => {
    const { st, events } = recorder();
    // Real capture: a long reply arrives as several ACTIVE frames then a final DONE frame.
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'The ocean is ' } });
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'vast and ' } });
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'living.\n' } });
    expect(events).toEqual(['text:The ocean is ', 'text:vast and ', 'text:living.\n']);
    // Concatenation must reproduce the full reply (deltas, not cumulative snapshots).
    expect(events.map((e) => e.slice('text:'.length)).join('')).toBe('The ocean is vast and living.\n');
  });

  it('bookkeeping frames (user_input / checkpoint) render nothing', () => {
    const { st, events } = recorder();
    feed(st, { event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } });
    feed(st, { event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'checkpoint' } });
    expect(events).toEqual([]);
  });

  it('an agent_response frame with no text_delta (usage-only DONE) renders nothing', () => {
    const { st, events } = recorder();
    // Captured verbatim: a tool-using turn emits a DONE agent_response carrying only usage.
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', duration_seconds: 4.36 } });
    expect(events).toEqual([]);
  });
});

describe('translateAgyEvent — tool state machine', () => {
  it('ACTIVE opens the bubble, DONE closes it with agy-reported duration', () => {
    const { st, events } = recorder();
    feed(st, {
      event: 'step_update',
      step_update: {
        step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hello-from-tool' } },
      },
    });
    expect(events).toEqual(['start:Bash|echo hello-from-tool']);
    feed(st, {
      event: 'step_update',
      step_update: {
        step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.110969865,
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hello-from-tool' }, output: 'hello-from-tool\r\n' },
      },
    });
    // 0.110969865s -> 111ms (the bubble shows agy's own timing, not wall clock).
    expect(events).toEqual(['start:Bash|echo hello-from-tool', 'finish:Bash|true|111']);
  });

  it('tool_info.error marks the finish as failed', () => {
    const { st, events } = recorder();
    const info = { name: 'run_command', parameters: { CommandLine: 'cat /nope' }, error: { type: 'EXEC', message: 'No such file' } };
    feed(st, { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: info } });
    feed(st, { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', duration_seconds: 0.05, tool_info: info } });
    expect(events).toEqual(['start:Bash|cat /nope', 'finish:Bash|false|50']);
  });

  it('text -> tool and tool -> text boundaries each emit one onSegmentBreak', () => {
    const { st, events } = recorder();
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: "I'll run it" } });
    feed(st, {
      event: 'step_update',
      step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } },
    });
    feed(st, { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', duration_seconds: 0.1, tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } });
    feed(st, { event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Done.' } });
    expect(events).toEqual([
      "text:I'll run it",
      'seg',
      'start:Bash|ls',
      'finish:Bash|true|100',
      'seg',
      'text:Done.',
    ]);
  });

  it('DONE without a preceding ACTIVE still renders a start then a finish', () => {
    const { st, events } = recorder();
    feed(st, {
      event: 'step_update',
      step_update: { step_index: 2, state: 'DONE', step_type: 'tool', duration_seconds: 0.2, tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/x.txt' } } },
    });
    expect(events).toEqual(['start:Read|/tmp/x.txt', 'finish:Read|true|200']);
  });

  it('distinct step_index values get distinct bubble indices', () => {
    const { st } = recorder();
    const seen: Array<number | undefined> = [];
    st.handlers.onToolStart = (e) => seen.push(e.index);
    feed(st, { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'list_dir', parameters: { DirectoryPath: '/a' } } } });
    feed(st, { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'grep_search', parameters: { Query: 'beta' } } } });
    expect(seen).toEqual([0, 1]);
  });

  it('a repeated ACTIVE frame for the same step does not open a second bubble', () => {
    const { st, events } = recorder();
    const u = { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } };
    feed(st, u);
    feed(st, u);
    expect(events).toEqual(['start:Bash|ls']);
  });
});

describe('translateAgyEvent — turn termination', () => {
  it('result SUCCESS ends the turn', () => {
    const { st } = recorder();
    expect(feed(st, { event: 'result', result: { status: 'SUCCESS', response: 'apple\n' } })).toBe(true);
  });

  it('step_update frames do not end the turn', () => {
    const { st } = recorder();
    expect(feed(st, { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'x' } })).toBe(false);
  });

  it('result ERROR throws with agy\'s own reason (surfaced to the channel as ❌)', () => {
    const { st } = recorder();
    expect(() =>
      feed(st, { event: 'result', result: { status: 'ERROR', response: '', error: 'timeout waiting for response' } })
    ).toThrow(/status ERROR: timeout waiting for response/);
  });

  it('a slash command intercepted by the CLI surfaces its explanation verbatim', () => {
    // This is exactly why buildAgyArgs passes --disable-slash-commands; if it ever regresses, the
    // operator should still see agy's own explanation rather than a bare failure.
    const { st } = recorder();
    expect(() =>
      feed(st, {
        event: 'result',
        result: { status: 'ERROR', error: '/model is answered by the CLI itself and is unavailable with --input-format stream-json' },
      })
    ).toThrow(/answered by the CLI itself/);
  });

  it('a missing status is treated as success (absent field means no failure reported)', () => {
    const { st } = recorder();
    expect(feed(st, { event: 'result', result: { response: 'ok' } })).toBe(true);
  });

  it('the trailing result a SIGINT-ed agy flushes is reported as an error, so it must never reach the next turn', () => {
    // Regression guard for a bug found during live verification: after abort() the dying child
    // emits `status:ERROR, "stream input cancelled: context canceled"`. Translation correctly calls
    // that a failure, so the session must detach the child on abort (see abort(): resetHandles +
    // handleLine's `proc !== from` drop) — otherwise this frame fails the FOLLOWING turn.
    const { st } = recorder();
    expect(() =>
      feed(st, { event: 'result', result: { status: 'ERROR', error: 'stream input cancelled: context canceled' } })
    ).toThrow(/stream input cancelled/);
  });
});

/**
 * agy's `result` is conversation-wide (agy 1.3.2, 2026-10-10): once a conversation has had an API
 * error, every later result says ERROR with it, recovered or not. Frames below are verbatim shapes
 * from that day — the incident's own conversation resumed in isolation, and a probe that injected a
 * mid-stream failure through a local proxy (project-scripts/talkcode-agy-stale-error/).
 */
describe('translateAgyEvent — an ERROR result after the turn already replied', () => {
  const STALE_500 = 'API error (attempt 1): INTERNAL (code 500): Internal error encountered.';
  const errorStep = (i: number) => ({
    event: 'step_update',
    step_update: { step_index: i, state: 'DONE', step_type: 'error_message', duration_seconds: 0.00009888 },
  });
  const text = (i: number, delta: string, state = 'ACTIVE') => ({
    event: 'step_update',
    step_update: { step_index: i, state, step_type: 'agent_response', text_delta: delta },
  });
  const tool = (i: number, state: string) => ({
    event: 'step_update',
    step_update: { step_index: i, state, step_type: 'tool', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } },
  });
  const errorResult = { event: 'result', result: { status: 'ERROR', response: 'RESUMED\n', error: STALE_500 } };

  it('an error step, then the reply: the turn is done, and the recovery is said once', () => {
    // The incident's first turn: a 500 early on, agy retried, worked for 14 minutes, wrote its report.
    const { st, events } = recorder();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    feed(st, errorStep(9));
    feed(st, tool(10, 'ACTIVE'));
    feed(st, tool(10, 'DONE'));
    feed(st, text(11, '### 结论先行'));
    feed(st, text(11, '\n', 'DONE'));
    expect(feed(st, errorResult)).toBe(true);
    expect(events.filter((e) => e.startsWith('notice:'))).toEqual([`notice:⚠️ ag hit an error and recovered: ${STALE_500}`]);
    log.mockRestore();
  });

  it('no error step this turn, yet ERROR: agy repeating an old one — done, logged, not announced', () => {
    // Verbatim from the resumed conversation: user_input, system_message, the reply, then a result
    // naming the 500 from the turn before (num_turns 3, duration 6239s — conversation totals).
    const { st, events } = recorder();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    feed(st, { event: 'step_update', step_update: { step_index: 112, state: 'DONE', step_type: 'user_input' } });
    feed(st, { event: 'step_update', step_update: { step_index: 113, state: 'DONE', step_type: 'system_message', duration_seconds: 0.000185761 } });
    feed(st, text(114, 'RESUMED'));
    feed(st, text(114, '\n', 'DONE'));
    expect(feed(st, errorResult)).toBe(true);
    expect(events).toEqual(['text:RESUMED', 'text:\n']);
    expect(log.mock.calls.some((c) => String(c[0]).includes('repeating an earlier'))).toBe(true);
    log.mockRestore();
  });

  it('reply first, then an error step and nothing after it: retries ran out — still a failure', () => {
    const { st } = recorder();
    feed(st, text(1, "I'll check the logs"));
    feed(st, errorStep(2));
    feed(st, errorStep(3));
    expect(() => feed(st, errorResult)).toThrow(/status ERROR: API error/);
  });

  it('reply first, then a tool, then ERROR: the turn stopped mid-work — still a failure', () => {
    // e.g. "Agent execution terminated due to error" after a tool started.
    const { st } = recorder();
    feed(st, text(1, 'Running it now.'));
    feed(st, tool(2, 'ACTIVE'));
    expect(() =>
      feed(st, { event: 'result', result: { status: 'ERROR', error: 'Agent execution terminated due to error.' } })
    ).toThrow(/terminated due to error/);
  });

  it('only whitespace after the error step is not a reply', () => {
    const { st } = recorder();
    feed(st, text(1, 'Partial answer'));
    feed(st, errorStep(2));
    feed(st, text(3, '\n', 'DONE'));
    expect(() => feed(st, errorResult)).toThrow(/status ERROR/);
  });

  it('a trailing "\\n" frame does not unmake a reply that was already written', () => {
    const { st } = recorder();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    feed(st, text(1, 'Done.'));
    feed(st, text(1, '\n', 'DONE'));
    expect(feed(st, errorResult)).toBe(true);
    vi.restoreAllMocks();
  });

  it('only ERROR is reconsidered: CANCELED after a reply still settles as an error', () => {
    // Our own aborts produce these; runTurn's `aborting` check is what swallows them, not this.
    const { st } = recorder();
    feed(st, text(1, 'Half'));
    expect(() => feed(st, { event: 'result', result: { status: 'CANCELED' } })).toThrow(/status CANCELED/);
  });
});

describe('buildInputPreview — agy PascalCase parameters', () => {
  // agy names its tool parameters in PascalCase, unlike the snake_case ACP harnesses. Without these
  // keys the preview degrades to a full JSON dump of the parameter object.
  it.each([
    [{ CommandLine: 'echo hi', Cwd: '/tmp', WaitMsBeforeAsync: 5000, toolAction: 'Running' }, 'echo hi'],
    [{ AbsolutePath: '/tmp/sample.txt' }, '/tmp/sample.txt'],
    [{ DirectoryPath: '/tmp/agyprobe' }, '/tmp/agyprobe'],
    [{ Query: 'beta', SearchPath: '/tmp' }, 'beta'],
  ])('%o -> %s', (params, expected) => {
    expect(buildInputPreview(params)).toBe(expected);
  });

  it('still prefers the meaningful key over incidental ones agy also sends', () => {
    // Cwd/WaitMsBeforeAsync/toolAction must never win the preview over CommandLine.
    expect(buildInputPreview({ Cwd: '/tmp', toolAction: 'Running echo command', CommandLine: 'echo x' })).toBe('echo x');
  });

  it('keeps working for the snake_case ACP harnesses', () => {
    expect(buildInputPreview({ command: 'gh pr list' })).toBe('gh pr list');
    expect(buildInputPreview({ file_path: 'src/x.ts' })).toBe('src/x.ts');
  });

  it('an unrecognized parameter shape falls back to JSON, and an empty one to ""', () => {
    expect(buildInputPreview({ Unknown: 1 })).toBe('{"Unknown":1}');
    expect(buildInputPreview({})).toBe('');
  });
});

describe('toolLabel', () => {
  it('maps agy tool names onto the default emojiMap keys', () => {
    expect(toolLabel('run_command')).toBe('Bash');
    expect(toolLabel('view_file')).toBe('Read');
    expect(toolLabel('write_to_file')).toBe('Write');
    expect(toolLabel('replace_file_content')).toBe('Edit');
    expect(toolLabel('grep_search')).toBe('Grep');
    expect(toolLabel('find_by_name')).toBe('Glob');
    expect(toolLabel('read_url_content')).toBe('WebFetch');
    expect(toolLabel('search_web')).toBe('WebSearch');
    expect(toolLabel('invoke_subagent')).toBe('Task');
  });

  it('keeps an unmapped tool name (agy ships many specialized ones) and truncates long ones', () => {
    expect(toolLabel('capture_browser_screenshot')).toBe('capture_browser_screenshot');
    expect(toolLabel('a'.repeat(40))).toHaveLength(32);
    expect(toolLabel(undefined)).toBe('Tool');
  });
});

describe('buildAgyArgs', () => {
  it('sets the flags each measured agy behavior requires', () => {
    const args = buildAgyArgs(def(), '/work');
    expect(args).toContain('--input-format=stream-json');
    expect(args).toContain('--output-format=stream-json');
    // Default --print-timeout is 5m and kills long turns; the daemon's own watchdog bounds them.
    expect(args.some((a) => a.startsWith('--print-timeout='))).toBe(true);
    // NOT --disable-slash-commands. Re-probed on agy 1.2.0: a skill slash expands and answers, an
    // unknown slash reaches the model as text, and only the commands `agy -p /help` lists are fatal
    // — those are kept out of the session by name (core/command-translate.ts HARNESS_CLI_ANSWERED),
    // which is what lets agy's skills work here at all.
    expect(args).not.toContain('--disable-slash-commands');
    // The daemon is a headless client: it auto-approves tools for every harness.
    expect(args).toContain('--dangerously-skip-permissions');
    // Trust the agent's own cwd, else file writes are redirected to agy's scratch dir.
    expect(args).toContain('--add-dir=/work');
  });

  it('ends with `-p=` — Go flag parsing makes a bare `-p` swallow the next argument', () => {
    const args = buildAgyArgs(def({ args: ['--effort=high'] }), '/work');
    expect(args[args.length - 1]).toBe('-p=');
  });

  it('appends def.args after the presets so a user can override any default (Go is last-wins)', () => {
    const args = buildAgyArgs(def({ args: ['--print-timeout=30m'] }), '/work');
    expect(args.indexOf('--print-timeout=30m')).toBeGreaterThan(args.indexOf('--print-timeout=8760h'));
  });

  it('passes the model only when configured', () => {
    expect(buildAgyArgs(def({ model: 'claude-sonnet-4-6' }), '/w')).toContain('--model=claude-sonnet-4-6');
    expect(buildAgyArgs(def(), '/w').some((a) => a.startsWith('--model='))).toBe(false);
  });

  it('prefers modelOverride over def.model when provided', () => {
    expect(buildAgyArgs(def({ model: 'claude-sonnet-4-6' }), '/w', undefined, 'gemini-3.8-flash-high')).toContain(
      '--model=gemini-3.8-flash-high'
    );
    expect(buildAgyArgs(def(), '/w', undefined, 'gemini-3.8-flash-high')).toContain(
      '--model=gemini-3.8-flash-high'
    );
  });

  it('resumes a prior conversation only when one was persisted', () => {
    expect(buildAgyArgs(def(), '/w', 'abc-123')).toContain('--conversation=abc-123');
    expect(buildAgyArgs(def(), '/w').some((a) => a.startsWith('--conversation='))).toBe(false);
  });
});

describe('consumeNdJsonLines', () => {
  it('emits complete frames and carries the trailing partial line over', () => {
    const seen: string[] = [];
    const rest = consumeNdJsonLines('{"a":1}\n{"b":2}\n{"c":', (l) => seen.push(l));
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c":');
  });

  it('reassembles a frame split across chunks', () => {
    const seen: string[] = [];
    const rest = consumeNdJsonLines(consumeNdJsonLines('{"a":', (l) => seen.push(l)) + '1}\n', (l) => seen.push(l));
    expect(seen).toEqual(['{"a":1}']);
    expect(rest).toBe('');
  });

  it('skips blank lines', () => {
    const seen: string[] = [];
    consumeNdJsonLines('\n\n{"a":1}\n\n', (l) => seen.push(l));
    expect(seen).toEqual(['{"a":1}']);
  });
});

describe('fetchAgyModelsFor', () => {
  it('never asks this machine for an agy that runs on a host not registered yet', async () => {
    // It used to fall back to a local `agy models`: in a gateway-only container, "spawn agy
    // ENOENT" at every start. Throwing keeps the factory's cache unfilled, so the next read asks
    // the host instead of settling on an empty list.
    await expect(fetchAgyModelsFor({ agents: [def({ host: 'box' })] })).rejects.toThrow('host "box" is not registered yet');
  });
});

describe('parseAgyModelsOutput', () => {
  it('parses tab-separated model ID and display name', () => {
    const raw = [
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    ].join('\n');
    expect(parseAgyModelsOutput(raw)).toEqual([
      { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ]);
  });

  it('parses verbatim stdout captured from a real `agy models` run', () => {
    // Captured 2026-09 from the logged-in CLI (same shape as the AgyEvent fixtures above).
    // The "Fetching available models..." spinner goes to stderr, so stdout is pure TSV.
    const raw = [
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
      'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
      'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
      'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
      'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
      'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
      'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    ].join('\n');
    const models = parseAgyModelsOutput(raw);
    expect(models).toHaveLength(14);
    expect(models[0]).toEqual({ value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' });
    expect(models[13]).toEqual({ value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' });
  });

  it('falls back to value when line contains no tab or has empty display name', () => {
    const raw = 'model-one\nmodel-two\t\nmodel-three\tModel Three';
    expect(parseAgyModelsOutput(raw)).toEqual([
      { value: 'model-one', name: 'model-one' },
      { value: 'model-two', name: 'model-two' },
      { value: 'model-three', name: 'Model Three' },
    ]);
  });

  it('handles empty or whitespace-only output', () => {
    expect(parseAgyModelsOutput('')).toEqual([]);
    expect(parseAgyModelsOutput('  \n\n  \t  \n  ')).toEqual([]);
  });
});

describe('createAgyAgentFactory — model selector and switching', () => {
  const SAMPLE_MODELS = [
    { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  ];

  const cfg = {
    agents: [
      def({ id: 'agy-main', harness: 'agy', model: 'gemini-3.8-flash-high' }),
    ],
  } as unknown as Config;

  it('returns modelSelector with options from fetcher and initial current from def.model', async () => {
    const fetcher = async () => SAMPLE_MODELS;
    const factory = createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, fetcher);
    // Allow eager fetch to resolve
    await Promise.resolve();

    const session = factory.getOrCreate('conv-1', 'agy-main');
    const selector = session.modelSelector?.();
    expect(selector).toBeDefined();
    expect(selector?.options).toEqual(SAMPLE_MODELS);
    expect(selector?.current).toBe('gemini-3.8-flash-high');
  });

  it('setModel records preference and updates modelSelector current', async () => {
    const fetcher = async () => SAMPLE_MODELS;
    const factory = createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, fetcher);
    await Promise.resolve();

    const session = factory.getOrCreate('conv-1', 'agy-main');
    expect(session.setModel).toBeDefined();
    const res = await session.setModel!('claude-sonnet-4-6');
    expect(res).toBe('claude-sonnet-4-6');

    // modelSelector now reports the chosen model as current
    const selector = session.modelSelector?.();
    expect(selector?.current).toBe('claude-sonnet-4-6');
  });

  it('modelSelector returns undefined if model fetcher returns empty or fails', async () => {
    const failingFetcher = async () => {
      throw new Error('command not found: agy');
    };
    const factory = createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, failingFetcher);
    await Promise.resolve();

    const session = factory.getOrCreate('conv-1', 'agy-main');
    expect(session.modelSelector?.()).toBeUndefined();
  });

  it('peek and dispose manage factory sessions', async () => {
    const factory = createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, async () => []);
    expect(factory.peek('conv-1')).toBeUndefined();

    const s = factory.getOrCreate('conv-1', 'agy-main');
    expect(factory.peek('conv-1')).toBe(s);

    factory.dispose('conv-1');
    expect(factory.peek('conv-1')).toBeUndefined();
  });
});

describe('createAgyAgentFactory — refreshing the model list', () => {
  // The list is served by Google, not the binary: on 2026-10-03 an unchanged agy 1.2.13 listed
  // Opus 5.5 while a daemon started days earlier still offered its startup list.
  const BEFORE = [{ value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }];
  const AFTER = [...BEFORE, { value: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' }];
  const cfg = { agents: [def({ id: 'agy-main', harness: 'agy' })] } as unknown as Config;

  /** A fetcher answering from a queue, so each test scripts what successive `agy models` runs say. */
  function scripted(...answers: Array<typeof BEFORE | Error>) {
    const fetcher = vi.fn(async () => {
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next instanceof Error) throw next;
      return next;
    });
    return fetcher;
  }

  async function started(fetcher: ReturnType<typeof scripted>) {
    const factory = createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, fetcher);
    const session = factory.getOrCreate('conv-1', 'agy-main');
    await session.ensureSession?.('sess_x'); // the startup prefetch
    return session;
  }

  it('picks up a model added after the daemon started', async () => {
    const fetcher = scripted(BEFORE, AFTER);
    const session = await started(fetcher);
    expect(session.modelSelector?.()?.options).toEqual(BEFORE);

    await session.refreshModels?.();
    expect(session.modelSelector?.()?.options).toEqual(AFTER);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the known list when a refresh comes back empty', async () => {
    // defaultFetchAgyModels reports every failure as [], so [] must not read as "no models".
    const session = await started(scripted(BEFORE, []));
    await session.refreshModels?.();
    expect(session.modelSelector?.()?.options).toEqual(BEFORE);
  });

  it('keeps the known list when a refresh throws, and does not reject', async () => {
    const session = await started(scripted(BEFORE, new Error('network down')));
    await expect(session.refreshModels?.()).resolves.toBeUndefined();
    expect(session.modelSelector?.()?.options).toEqual(BEFORE);
  });

  it('recovers a startup fetch that came back empty', async () => {
    // Before refreshes existed, an `agy models` that failed at boot left /model saying "no model
    // selector" until the daemon was restarted.
    const session = await started(scripted([], AFTER));
    expect(session.modelSelector?.()).toBeUndefined();
    await session.refreshModels?.();
    expect(session.modelSelector?.()?.options).toEqual(AFTER);
  });

  it('shares one `agy models` run between overlapping refreshes', async () => {
    const fetcher = scripted(BEFORE, AFTER);
    const session = await started(fetcher);
    await Promise.all([session.refreshModels?.(), session.refreshModels?.()]);
    expect(fetcher).toHaveBeenCalledTimes(2); // the prefetch, then ONE refresh
    expect(session.modelSelector?.()?.options).toEqual(AFTER);
  });
});

describe('formatAgyQuota', () => {
  // Verbatim from `agy -p=/usage` on agy 1.2.0 (2026-09-17).
  const raw = [
    'Gemini Models\tWeekly Limit Remaining\t100%\t2026-09-24T06:12:21Z',
    'Claude and GPT models\tWeekly Limit Remaining\t94%\t2026-09-22T01:42:55Z',
  ].join('\n');
  const now = Date.parse('2026-09-17T06:12:21Z');

  it('renders each pool with a bar and a duration until reset', () => {
    const out = formatAgyQuota(raw, now)!;
    expect(out).toContain('**Gemini Models** — Weekly Limit Remaining: 100% [████████]');
    expect(out).toContain('(resets in 7d 0h)');
    // A UTC timestamp is arithmetic; the duration is the part that is actionable.
    expect(out).toContain('**Claude and GPT models**');
    expect(out).toContain('(resets in 4d 19h)');
  });

  it('fills the bar in proportion to what is left', () => {
    expect(formatAgyQuota('Pool\tMetric\t50%\t2026-09-24T06:12:21Z', now)).toContain('50% [████░░░░]');
    expect(formatAgyQuota('Pool\tMetric\t0%\t2026-09-24T06:12:21Z', now)).toContain('0% [░░░░░░░░]');
  });

  it('declines a shape it does not recognize, so the caller can print it verbatim', () => {
    // Dropping an answer that failed to parse would be worse than showing the raw rows.
    expect(formatAgyQuota('some prose agy printed instead', now)).toBeUndefined();
    expect(formatAgyQuota('', now)).toBeUndefined();
  });
});

describe('formatAgyCliOutput', () => {
  it('says so when the CLI printed nothing — that IS its answer for /agents and /hooks', () => {
    expect(formatAgyCliOutput('agents', '')).toContain('agy answered with nothing');
  });

  it('fences output it has no structure for', () => {
    expect(formatAgyCliOutput('effort', 'high')).toBe('```\nhigh\n```');
  });

  it('truncates a long answer and points at the host for the rest', () => {
    // `/changelog` prints the whole release history; no platform takes that in one message.
    const out = formatAgyCliOutput('changelog', 'x'.repeat(9_000));
    expect(out.length).toBeLessThan(3_000);
    expect(out).toContain('agy -p=/changelog');
  });

  it('routes /usage through the quota renderer', () => {
    const out = formatAgyCliOutput('usage', 'Gemini Models\tWeekly\t50%\t2026-09-24T06:12:21Z');
    expect(out).toContain('Quota:');
    expect(out).not.toContain('```');
  });
});

describe('agyModelId', () => {
  const MODELS = [
    { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  ];

  it('respells a display name as the id `agy models` lists, and leaves an id alone', () => {
    expect(agyModelId('Claude Sonnet 4.6 (Thinking)', MODELS)).toBe('claude-sonnet-4-6');
    expect(agyModelId('gemini-3.8-flash-high', MODELS)).toBe('gemini-3.8-flash-high');
  });

  it('passes an unknown name through — a display name beats no model at all', () => {
    expect(agyModelId('Some Future Model', MODELS)).toBe('Some Future Model');
    expect(agyModelId('Claude Sonnet 4.6 (Thinking)')).toBe('Claude Sonnet 4.6 (Thinking)');
  });
});

/**
 * The session driven end to end against a scripted child: `init`, then per turn whatever the status
 * line reports on fd 3, then `result`. `init` shapes are verbatim from agy 1.2.9 (2026-09-23): with
 * no `--model=` it names no model at all, which is the bug these tests were written for — a footer
 * with context numbers and no model, on every conversation left on agy's default.
 */
describe('agy session — what the status pipe tells the footer', () => {
  const MODELS = [
    { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  ];
  const INIT_DEFAULT = { conversation_id: '2a7e949d-7849-4d00-b565-fc062f30e515', init: { cwd: '/tmp', permission_mode: 'always-proceed' } };

  afterEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(ensureAgyStatusLine).mockReturnValue('skipped');
    vi.restoreAllMocks();
  });

  /**
   * A scripted child, in the order agy 1.2.9 was measured to write things: `boot` frames on fd 3
   * from the moment it starts (before `init`, before any prompt), `init`, and per prompt `during`
   * frames, `result`, then `after` frames — the post-turn refresh that carries the turn's tokens.
   */
  function scriptSpawn(
    init: Record<string, unknown>,
    frames: { boot?: string[]; during?: string[]; after?: string[]; turns?: unknown[][] } = {}
  ): void {
    vi.mocked(spawn).mockImplementation(() => {
      const statusPipe = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true),
      });
      Object.assign(child, { stdio: [child.stdin, child.stdout, child.stderr, statusPipe] });
      const report = (lines: string[] = []) => {
        for (const line of lines) statusPipe.write(`${line}\n`);
      };
      report(frames.boot);
      setImmediate(() => child.stdout.write(`${JSON.stringify({ event: 'init', ...init })}\n`));
      // `turns[n]` is what the n-th prompt gets on stdout, its own `result` included; without it, a
      // bare SUCCESS.
      let prompt = 0;
      child.stdin.on('data', () => {
        const stdout = frames.turns?.[prompt++] ?? [{ event: 'result', result: { status: 'SUCCESS' } }];
        report(frames.during);
        setTimeout(() => {
          for (const f of stdout) child.stdout.write(`${JSON.stringify(f)}\n`);
          setTimeout(() => report(frames.after), 30);
        }, 10);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
  }

  function recordingHandlers() {
    const seen: { models: string[]; usage: AgentUsage[]; quota: QuotaPool[][] } = { models: [], usage: [], quota: [] };
    const handlers: AgentStreamHandlers = {
      onText: () => {},
      onToolStart: () => {},
      onToolFinish: () => {},
      onSegmentBreak: () => {},
      onModel: (m) => seen.models.push(m),
      onUsage: (u) => seen.usage.push(u),
      onQuota: (q) => seen.quota.push(q),
    };
    return { seen, handlers };
  }

  /**
   * The one-shots a session runs beside its turns (`agy -p=/model`, `-p=/usage`). Failing by
   * default, which is what an agy older than 1.4.7 tests need — they get everything off the pipe —
   * and what keeps any test from starting the real CLI.
   */
  const noCli: AgyCliRunner = async () => ({ ok: false, error: 'no agy in tests' });

  function makeFactory(over: Record<string, unknown> = {}, cli: AgyCliRunner = noCli) {
    const cfg = { agents: [def({ id: 'ag', cwd: tmpdir(), ...over })] } as unknown as Config;
    return createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, async () => MODELS, cli);
  }

  it('names agy’s default model from the status line when `init` names none', async () => {
    // Verbatim from 1.2.9: the id slot carries the display name when agy is on its default.
    const named = { size: 250000, model: 'Claude Sonnet 4.6 (Thinking)' };
    scriptSpawn(INIT_DEFAULT, {
      boot: [JSON.stringify({ ...named, used: 0 })],
      after: [JSON.stringify({ ...named, used: 22087 })],
    });
    const factory = makeFactory();
    const session = factory.getOrCreate('conv-1', 'ag');
    await session.ensureSession?.('sess_x');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    // Respelled as the id, so it reads the same as a model someone picked from /model.
    expect(seen.models.at(-1)).toBe('claude-sonnet-4-6');
    expect(seen.usage.at(-1)).toEqual({ used: 22087, size: 250000 });
    // And the /model menu can mark it, which it could not while nobody knew the default.
    expect(session.modelSelector?.()?.current).toBe('claude-sonnet-4-6');

    // The pipe is what the shim writes to: fd 3 opened, and named in the environment.
    const opts = vi.mocked(spawn).mock.calls[0]?.[2] as { stdio: unknown[]; env: Record<string, string> };
    expect(opts.stdio).toHaveLength(AGY_STATUS_FD + 1);
    expect(opts.env[AGY_STATUS_FD_ENV]).toBe(String(AGY_STATUS_FD));
    factory.dispose('conv-1');
  });

  it('prefers the model `init` resolved, when there is one', async () => {
    // With --model= passed, `init` names it (agy 1.2.9), and that is the authoritative spelling.
    scriptSpawn(
      { ...INIT_DEFAULT, init: { ...INIT_DEFAULT.init, model: 'gemini-3.8-flash-high' } },
      { after: [JSON.stringify({ used: 1000, size: 1048576, model: 'Something Else' })] }
    );
    const factory = makeFactory({ model: 'gemini-3.8-flash-high' });
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    expect(new Set(seen.models)).toEqual(new Set(['gemini-3.8-flash-high']));
    factory.dispose('conv-1');
  });

  it('waits for the frame agy sends after `result` — the one that carries the turn’s tokens', async () => {
    // Measured on 1.2.9: every frame during a turn still read the pre-turn count (0 on a first
    // turn) and the real number arrived ~260ms after `result`. Read at `result`, the footer lagged
    // a turn behind; this is the order that exposed it.
    const stale = JSON.stringify({ used: 0, size: 1048576, model: 'Gemini 3.8 Flash (High)' });
    const fresh = JSON.stringify({ used: 16926, size: 1048576, model: 'Gemini 3.8 Flash (High)' });
    scriptSpawn(INIT_DEFAULT, { boot: [stale], during: [stale], after: [fresh] });
    const factory = makeFactory();
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    // The footer is built from the LAST reading, so that is the one that must be the fresh frame.
    // Earlier readings are the live ones passed on mid-turn for the web UI's status strip — and if
    // the settle wait were skipped, the fresh frame would land after the turn had stopped
    // listening, leaving the stale one last.
    expect(seen.usage.at(-1)).toEqual({ used: 16926, size: 1048576 });
    expect(seen.usage.slice(0, -1).every((u) => u.used === 0 || u.used === 16926)).toBe(true);
    expect(seen.models.at(-1)).toBe('gemini-3.8-flash-high');
    factory.dispose('conv-1');
  });

  it('gives up waiting after a bound when no fresher frame comes, and reports what it has', async () => {
    const stale = JSON.stringify({ used: 0, size: 1048576 });
    scriptSpawn(INIT_DEFAULT, { boot: [stale] });
    const factory = makeFactory();
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    const started = Date.now();
    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    expect(seen.usage).toEqual([{ used: 0, size: 1048576 }]);
    expect(Date.now() - started).toBeLessThan(3_000);
    factory.dispose('conv-1');
  });

  it('shrugs off lines on the pipe that are not frames — anything agy started can write there', async () => {
    scriptSpawn(INIT_DEFAULT, {
      boot: [JSON.stringify({ used: 0, size: 100 })],
      during: ['garbage from a tool', '[]'],
      after: [JSON.stringify({ used: 5, size: 100 })],
    });
    const factory = makeFactory();
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    expect(seen.usage.at(-1)).toEqual({ used: 5, size: 100 });
    factory.dispose('conv-1');
  });

  it('says so in the log, once, when a turn passes with nothing on the pipe', async () => {
    // What a future agy that closes inherited descriptors would look like: the footer loses its
    // numbers, and the operator is told why instead of finding out by noticing.
    vi.mocked(ensureAgyStatusLine).mockReturnValue('unchanged');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scriptSpawn(INIT_DEFAULT);
    const factory = makeFactory();
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'one', sessionToken: 'sess_x' }, handlers);
    await session.runTurn({ prompt: 'two', sessionToken: 'sess_x' }, handlers);

    const silence = warn.mock.calls.filter((c) => String(c[0]).includes(`fd ${AGY_STATUS_FD}`));
    expect(silence).toHaveLength(1);
    expect(seen.models).toEqual([]);
    factory.dispose('conv-1');
  });

  it('stays quiet about silence when the daemon never wired the status line', async () => {
    // Opted out, or no agy config on this machine: nothing on the pipe is the expected answer.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scriptSpawn(INIT_DEFAULT);
    const factory = makeFactory();
    const session = factory.getOrCreate('conv-1', 'ag');

    await session.runTurn({ prompt: 'one', sessionToken: 'sess_x' }, recordingHandlers().handlers);

    expect(warn.mock.calls.filter((c) => String(c[0]).includes(`fd ${AGY_STATUS_FD}`))).toEqual([]);
    factory.dispose('conv-1');
  });

  it('wires a home at spawn that had no agy config when the daemon started', async () => {
    // A new machine: the daemon comes up before anyone has logged agy in, so the construction-time
    // install finds no directory and skips. Logging in creates it; the next spawn must wire it,
    // rather than leave every agy turn without numbers until the daemon happens to restart.
    vi.mocked(ensureAgyStatusLine).mockReset().mockReturnValueOnce('skipped').mockReturnValue('installed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scriptSpawn(INIT_DEFAULT);
    const factory = makeFactory();
    expect(ensureAgyStatusLine).toHaveBeenCalledTimes(1);
    const session = factory.getOrCreate('conv-1', 'ag');

    await session.runTurn({ prompt: 'one', sessionToken: 'sess_x' }, recordingHandlers().handlers);

    expect(ensureAgyStatusLine).toHaveBeenCalledTimes(2);
    // Wired now, so silence on the pipe is a finding again — the proof the spawn-time answer is
    // the one the session acts on, not the one from construction.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(`fd ${AGY_STATUS_FD}`))).toHaveLength(1);
    factory.dispose('conv-1');
    vi.mocked(ensureAgyStatusLine).mockReset().mockReturnValue('skipped');
  });

  it('passes the quota pools on, marking the ones the serving model spends from', async () => {
    const quota = [
      { id: '3p-5h', remaining: 1, resetsAt: 1791459045263 },
      { id: '3p-weekly', remaining: 0.75, resetsAt: 1791627354000 },
      { id: 'gemini-weekly', remaining: 1 },
    ];
    const frame = JSON.stringify({ used: 100, size: 1000, model: 'Claude Opus 5.5 (Medium)', quota });
    scriptSpawn(INIT_DEFAULT, { boot: [frame], after: [JSON.stringify({ used: 200, size: 1000, quota })] });
    const factory = makeFactory();
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    expect(seen.quota.at(-1)).toEqual([
      { id: '3p-5h', remaining: 1, resetsAt: 1791459045263, active: true },
      { id: '3p-weekly', remaining: 0.75, resetsAt: 1791627354000, active: true },
      { id: 'gemini-weekly', remaining: 1, active: false },
    ]);
    factory.dispose('conv-1');
  });

  it('passes a reading on while the turn is still running, not only at its end', async () => {
    // For the web UI's status strip: a long turn's context grows step by step, and a strip that
    // moved only when the turn ended would show the start of the turn for its whole length. The
    // mid-turn reading differs from the settled one, so only live forwarding can produce it.
    scriptSpawn(INIT_DEFAULT, {
      during: [JSON.stringify({ used: 50, size: 1000 })],
      after: [JSON.stringify({ used: 60, size: 1000 })],
    });
    const factory = makeFactory();
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    expect(seen.usage[0]).toEqual({ used: 50, size: 1000 });
    expect(seen.usage.at(-1)).toEqual({ used: 60, size: 1000 });
    factory.dispose('conv-1');
  });

  it('a conversation whose result keeps saying ERROR still completes the turns that replied', async () => {
    // The 2026-10-10 topic, in order: a 500 retried past, the report, `result` ERROR; then the next
    // turn — no error of its own — gets the very same ERROR. Both used to fail; both replied.
    const STALE = { status: 'ERROR', error: 'API error (attempt 1): INTERNAL (code 500): Internal error encountered.' };
    const reply = (i: number, t: string) => ({ event: 'step_update', step_update: { step_index: i, state: 'DONE', step_type: 'agent_response', text_delta: t } });
    scriptSpawn(INIT_DEFAULT, {
      turns: [
        [{ event: 'step_update', step_update: { step_index: 9, state: 'DONE', step_type: 'error_message' } }, reply(89, 'report'), { event: 'result', result: STALE }],
        [reply(111, 'second answer'), { event: 'result', result: STALE }],
      ],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const factory = makeFactory();
    const session = factory.getOrCreate('conv-1', 'ag');
    const notices: string[] = [];
    const { handlers } = recordingHandlers();
    handlers.onNotice = (t) => notices.push(t);

    await expect(session.runTurn({ prompt: 'one', sessionToken: 'sess_x' }, handlers)).resolves.toBeUndefined();
    await expect(session.runTurn({ prompt: 'two', sessionToken: 'sess_x' }, handlers)).resolves.toBeUndefined();

    // Announced where it happened, and not again for agy repeating it.
    expect(notices).toEqual(['⚠️ ag hit an error and recovered: API error (attempt 1): INTERNAL (code 500): Internal error encountered.']);
    factory.dispose('conv-1');
  });

  // ── agy 1.4.7+: no status line in `-p`, so usage off the stream and the rest off one-shots ──

  /**
   * One turn as agy 1.4.7 wrote it (2026-10-27): a model step that chose a tool, the tool, the
   * reply's step, and a `result` whose usage is the conversation's running total. Nothing on fd 3.
   */
  const turn147 = (first: number, second: number) => [
    { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: first, output_tokens: 129, total_tokens: first + 129 } } },
    { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command' } } },
    { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command' } } },
    { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'done one' } },
    { event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: { input_tokens: second, output_tokens: 16, total_tokens: second + 16 } } },
    { event: 'result', result: { status: 'SUCCESS', response: 'done one\n', usage: { input_tokens: first + second } } },
  ];

  /** The one-shots, answering as agy 1.4.7 did, and counting how often each was asked. */
  function cli147(model = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)') {
    const calls: string[] = [];
    const run: AgyCliRunner = async (name) => {
      calls.push(name);
      if (name === 'model') return { ok: true, output: model };
      if (name === 'usage') {
        return {
          ok: true,
          output: [
            'Gemini Models\tWeekly Limit Remaining\t74%\t2026-10-31T04:24:11Z',
            'Gemini Models\tFive Hour Limit Remaining\t86%\t2026-10-27T06:49:21Z',
            'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-03T06:27:38Z',
            'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-27T11:27:38Z',
          ].join('\n'),
        };
      }
      return { ok: false, error: `unexpected /${name}` };
    };
    return { calls, run };
  }

  it('reads the context off the stream — the last step’s count, never the result’s running total', async () => {
    // Wired, so a silent fd 3 would have been reported before 1.4.7 made it the normal state.
    vi.mocked(ensureAgyStatusLine).mockReturnValue('unchanged');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scriptSpawn(INIT_DEFAULT, { turns: [turn147(7454, 7672)] });
    const { run } = cli147();
    const factory = makeFactory({}, run);
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    const started = Date.now();
    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    expect(seen.usage.at(-1)).toEqual({ used: 7672, size: 1_048_576 });
    expect(seen.usage.some((u) => u.used === 15126)).toBe(false);
    // The status line's settle wait is for a reading that lands after `result`; the stream's does not.
    expect(Date.now() - started).toBeLessThan(USAGE_SETTLE_FLOOR_MS);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(`fd ${AGY_STATUS_FD}`))).toEqual([]);
    factory.dispose('conv-1');
  });

  it('names agy’s default model from `agy -p=/model` when `init` names none', async () => {
    scriptSpawn(INIT_DEFAULT, { turns: [turn147(7454, 7672)] });
    const { calls, run } = cli147('claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)');
    const factory = makeFactory({}, run);
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    expect(seen.models.at(-1)).toBe('claude-sonnet-4-6');
    // And the window follows the model the CLI named.
    expect(seen.usage.at(-1)).toEqual({ used: 7672, size: 250_000 });
    expect(calls.filter((c) => c === 'model')).toHaveLength(1);
    factory.dispose('conv-1');
  });

  it('does not ask for the default when `init` already named the model', async () => {
    scriptSpawn({ ...INIT_DEFAULT, init: { ...INIT_DEFAULT.init, model: 'gpt-oss-120b-medium' } }, { turns: [turn147(100, 200)] });
    const { calls, run } = cli147();
    const factory = makeFactory({ model: 'gpt-oss-120b-medium' }, run);
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    expect(calls).not.toContain('model');
    expect(seen.usage.at(-1)).toEqual({ used: 200, size: 131_072 });
    factory.dispose('conv-1');
  });

  it('reports the quota from `agy -p=/usage`, marked for the serving model, and asks once a minute at most', async () => {
    scriptSpawn(INIT_DEFAULT, { turns: [turn147(7454, 7672), turn147(7700, 7760)] });
    const { calls, run } = cli147();
    const factory = makeFactory({}, run);
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'one', sessionToken: 'sess_x' }, handlers);
    await session.runTurn({ prompt: 'two', sessionToken: 'sess_x' }, handlers);

    expect(seen.quota.at(-1)).toEqual([
      { id: '3p-5h', remaining: 1, resetsAt: Date.parse('2026-10-27T11:27:38Z'), active: false },
      { id: '3p-weekly', remaining: 1, resetsAt: Date.parse('2026-11-03T06:27:38Z'), active: false },
      { id: 'gemini-5h', remaining: 0.86, resetsAt: Date.parse('2026-10-27T06:49:21Z'), active: true },
      { id: 'gemini-weekly', remaining: 0.74, resetsAt: Date.parse('2026-10-31T04:24:11Z'), active: true },
    ]);
    // A round trip to Google each time: the second turn, seconds later, reuses the first reading.
    expect(calls.filter((c) => c === 'usage')).toHaveLength(1);
    expect(seen.usage.at(-1)).toEqual({ used: 7760, size: 1_048_576 });
    factory.dispose('conv-1');
  });

  it('shows no context numbers for a model with no known window, rather than a guessed one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    scriptSpawn({ ...INIT_DEFAULT, init: { ...INIT_DEFAULT.init, model: 'claude-opus-5-5-medium' } }, { turns: [turn147(100, 200)] });
    const factory = makeFactory({ model: 'claude-opus-5-5-medium' }, cli147().run);
    const session = factory.getOrCreate('conv-1', 'ag');
    const { seen, handlers } = recordingHandlers();

    await session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, handlers);

    expect(seen.usage).toEqual([]);
    expect(seen.models.at(-1)).toBe('claude-opus-5-5-medium');
    factory.dispose('conv-1');
  });
});

/** Below the status line's settle bound (USAGE_SETTLE_MS, 1.5s): proof a turn did not sit it out. */
const USAGE_SETTLE_FLOOR_MS = 1_000;

describe('translateAgyEvent — usage on a model step (agy 1.4.7)', () => {
  it('passes a finished step’s input tokens on, including a step that only chose a tool', () => {
    const { st } = recorder();
    const tokens: number[] = [];
    st.onContextTokens = (n) => tokens.push(n);
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 7454 } } });
    feed(st, { event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: { input_tokens: 7672 } } });
    expect(tokens).toEqual([7454, 7672]);
  });

  it('ignores the result’s usage — a running total over the whole conversation', () => {
    const { st } = recorder();
    const tokens: number[] = [];
    st.onContextTokens = (n) => tokens.push(n);
    expect(feed(st, { event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 15126 } } })).toBe(true);
    expect(tokens).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('agy session — the preLaunch hook', () => {
  // The hook runs through the real `bash`; only agy itself is refused, so any spawn of it fails the
  // test loudly. Hook logs go to a scratch config dir, never the operator's.
  const spawned: string[] = [];
  let savedConfigDir: string | undefined;
  beforeEach(async () => {
    savedConfigDir = process.env.TALKCODE_CONFIG_DIR;
    process.env.TALKCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tc-agy-hook-'));
    spawned.length = 0;
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(((command: string, args: string[], opts: object) => {
      spawned.push(command);
      if (command === 'bash') return actual.spawn(command, args, opts);
      throw new Error(`${command} must not be spawned`);
    }) as unknown as typeof spawn);
  });
  afterEach(() => {
    vi.mocked(spawn).mockReset();
    if (savedConfigDir === undefined) delete process.env.TALKCODE_CONFIG_DIR;
    else process.env.TALKCODE_CONFIG_DIR = savedConfigDir;
  });

  function hookedSession(preLaunch: string) {
    const cfg = { agents: [def({ id: 'ag', cwd: tmpdir(), hooks: { preLaunch } })] } as unknown as Config;
    const noCli: AgyCliRunner = async () => ({ ok: false, error: 'no agy in tests' });
    const factory = createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, async () => [], noCli);
    return { factory, session: factory.getOrCreate('conv-1', 'ag') };
  }

  const quiet: AgentStreamHandlers = { onText: () => {}, onToolStart: () => {}, onToolFinish: () => {}, onSegmentBreak: () => {} };

  it('fails the turn on a failing hook, and never starts agy', async () => {
    const { factory, session } = hookedSession('echo "no route to host" >&2; exit 2');
    await expect(session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, quiet)).rejects.toThrow(
      /agent "ag" pre-launch hook failed \(exit 2\): no route to host/
    );
    expect(spawned).toEqual(['bash']);
    factory.dispose('conv-1');
  });

  it('ends a turn stopped during its hook quietly, and never starts agy', async () => {
    const { factory, session } = hookedSession('sleep 5');
    const turn = session.runTurn({ prompt: 'hi', sessionToken: 'sess_x' }, quiet);
    setTimeout(() => session.abort(), 200);
    await expect(turn).resolves.toBeUndefined();
    expect(spawned).toEqual(['bash']);
    factory.dispose('conv-1');
  });
});
