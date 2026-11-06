import { describe, expect, it, vi } from 'vitest';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  agyAcpToolLabel,
  agyRuntime,
  agySplitModel,
  agyTurnWatch,
  agyWarningOf,
  createAgyQuotaMeter,
} from './agy-acp.js';
import { TurnFailure } from './agent.js';
import type { AgentDef } from '../config/schema.js';
import type { AgyCliRunner } from './agy-cli.js';

/** `configOptions` as `agy acp` 1.5.1 reported them for a fresh session (probe, 2026-11-06). */
const OPTIONS: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-3.8-flash',
    options: [
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      { value: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
      { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thinking Level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: ['low', 'medium', 'high'].map((v) => ({ value: v, name: v })),
  },
];

describe('agyRuntime', () => {
  it('is ACP unless the agent’s env names the stream-json fallback', () => {
    expect(agyRuntime({ env: {} })).toBe('acp');
    expect(agyRuntime({ env: { TALKCODE_AGY_RUNTIME: 'acp' } })).toBe('acp');
    expect(agyRuntime({ env: { TALKCODE_AGY_RUNTIME: ' Stream-JSON ' } })).toBe('stream-json');
    expect(agyRuntime({ env: { TALKCODE_AGY_RUNTIME: 'something-else' } })).toBe('acp');
  });
});

describe('agySplitModel', () => {
  it('splits the `agy models` spelling into the offered model and its thinking level', () => {
    expect(agySplitModel('gemini-3.8-flash-high', OPTIONS)).toEqual({ model: 'gemini-3.8-flash', effort: 'high' });
    expect(agySplitModel('gemini-3.8-flash-low', OPTIONS)).toEqual({ model: 'gemini-3.8-flash', effort: 'low' });
  });

  it('leaves an id that is offered as it is, even when it ends like a level', () => {
    expect(agySplitModel('gpt-oss-120b-medium', OPTIONS)).toBeUndefined();
    expect(agySplitModel('gemini-3.8-flash', OPTIONS)).toBeUndefined();
  });

  it('does not invent a model the session does not offer', () => {
    expect(agySplitModel('gemini-9-pro-high', OPTIONS)).toBeUndefined();
    expect(agySplitModel('gemini-3.8-flash-high', undefined)).toBeUndefined();
  });
});

describe('agyWarningOf', () => {
  it('reads agy’s own diagnostic chunk, captured verbatim', () => {
    expect(agyWarningOf('\n⚠ You have exhausted your quota on this model.\n')).toBe(
      'You have exhausted your quota on this model.'
    );
    expect(agyWarningOf('\n⚠ API error (attempt 3): INTERNAL (code 500): Internal error encountered.\n')).toBe(
      'API error (attempt 3): INTERNAL (code 500): Internal error encountered.'
    );
  });

  it('never takes text the model wrote for one', () => {
    expect(agyWarningOf('⚠ careful: this deletes files')).toBeUndefined();
    expect(agyWarningOf('\n⚠ two\nlines\n')).toBeUndefined();
    expect(agyWarningOf('Note:\n⚠ x\n')).toBeUndefined();
  });
});

describe('agyTurnWatch', () => {
  const watch = (inTurn = true) => {
    const notices: string[] = [];
    return { w: agyTurnWatch('agy', (t) => notices.push(t), inTurn), notices };
  };
  const usage = { inputTokens: 230, cachedReadTokens: 5696 };

  it('takes a one-call turn’s usage as its context, input plus cache reads', () => {
    const { w } = watch();
    expect(w.text('SECOND')).toBe(false);
    expect(w.settle(usage)).toEqual({ contextTokens: 5926 });
  });

  it('declines the context of a turn that ran a tool', () => {
    const { w } = watch();
    w.tool();
    w.text('done');
    expect(w.settle(usage)).toEqual({ noContext: 'tools' });
  });

  it('declines a turn with no usage at all', () => {
    const { w } = watch();
    w.text('hi');
    expect(w.settle(undefined)).toEqual({ noContext: 'no-usage' });
  });

  it('fails a turn whose last output was a warning, whatever came before it', () => {
    const { w, notices } = watch();
    w.text('Let me check.');
    expect(w.text('\n⚠ Agent execution terminated due to error.\n')).toBe(true);
    const { failure } = w.settle(undefined);
    expect(failure).toBeInstanceOf(TurnFailure);
    expect(failure?.reason).toBe('provider');
    expect(failure?.message).toBe('agy: Agent execution terminated due to error.');
    expect(notices).toEqual([]);
  });

  it('does not fail a turn that carried on after its warning — by writing or by running a tool', () => {
    for (const after of ['text', 'tool'] as const) {
      const { w, notices } = watch();
      w.text('\n⚠ Model produced invalid output.\n');
      if (after === 'text') w.text('ok');
      else w.tool();
      expect(w.settle(usage).failure).toBeUndefined();
      expect(notices).toEqual(['⚠️ agy hit an error and recovered: Model produced invalid output.']);
    }
  });

  it('says a retry once per kind of error, at once', () => {
    const { w, notices } = watch();
    w.text('\n⚠ API error (attempt 1): INTERNAL (code 500): Internal error encountered.\n');
    w.text('\n⚠ API error (attempt 2): INTERNAL (code 500): Internal error encountered.\n');
    w.text('\n⚠ API error (attempt 3): UNAVAILABLE (code 503): overloaded.\n');
    expect(notices).toEqual([
      '⚠️ agy hit an error and is retrying: API error (attempt 1): INTERNAL (code 500): Internal error encountered.',
      '⚠️ agy hit an error and is retrying: API error (attempt 3): UNAVAILABLE (code 503): overloaded.',
    ]);
  });

  it('out of a turn, says every warning at once — there is no end to hold it for', () => {
    const { w, notices } = watch(false);
    w.text('\n⚠ Our servers are experiencing high traffic right now, please try again in a minute.\n');
    expect(notices).toEqual([
      '⚠️ agy: Our servers are experiencing high traffic right now, please try again in a minute.',
    ]);
  });

  it('a whitespace chunk after a warning does not count as carrying on', () => {
    const { w } = watch();
    w.text('\n⚠ You have exhausted your quota on this model.\n');
    w.text('\n');
    expect(w.settle(undefined).failure).toBeInstanceOf(TurnFailure);
  });
});

describe('agyAcpToolLabel', () => {
  it('names the `other` calls by the tool in their `Run <name>` title', () => {
    expect(agyAcpToolLabel('Run invoke_subagent', 'other')).toBe('Task');
    expect(agyAcpToolLabel('Run mcp_chat_send_file', 'other')).toBe('send_file');
    expect(agyAcpToolLabel('Run mcp_hindsight-mcp_recall', 'other')).toBe('recall');
    expect(agyAcpToolLabel('Run some_new_tool', 'other')).toBe('some_new_tool');
  });

  it('leaves the rest to the generic kind mapping', () => {
    expect(agyAcpToolLabel('echo PROBE-ONE', 'execute')).toBeUndefined();
    expect(agyAcpToolLabel('File probe.txt', 'edit')).toBeUndefined();
    expect(agyAcpToolLabel('Update the plan', 'other')).toBeUndefined();
    expect(agyAcpToolLabel(undefined, 'other')).toBeUndefined();
  });
});

describe('createAgyQuotaMeter', () => {
  const def = (over: Partial<AgentDef> = {}) => ({ id: 'agy', harness: 'agy', env: { HOME: '/h' }, ...over }) as unknown as AgentDef;
  const OUT = 'Gemini Models\tWeekly Limit Remaining\t74%\t2026-11-07T04:24:11Z';

  it('shares one run between callers, and keeps the reading for a minute', async () => {
    const cli = vi.fn<AgyCliRunner>(async () => ({ ok: true, output: OUT }));
    const m = createAgyQuotaMeter(cli);
    await Promise.all([m.refresh(def(), '/w'), m.refresh(def(), '/w')]);
    await m.refresh(def(), '/w');
    expect(cli).toHaveBeenCalledTimes(1);
    expect(m.read(def())).toEqual([{ id: 'gemini-weekly', remaining: 0.74, resetsAt: Date.parse('2026-11-07T04:24:11Z') }]);
  });

  it('keeps the last reading when a run fails', async () => {
    let fail = false;
    const cli: AgyCliRunner = async () => (fail ? { ok: false, error: 'offline' } : { ok: true, output: OUT });
    vi.useFakeTimers({ now: Date.now() });
    try {
      const m = createAgyQuotaMeter(cli);
      await m.refresh(def(), '/w');
      fail = true;
      vi.advanceTimersByTime(61_000);
      await m.refresh(def(), '/w');
      expect(m.read(def())?.[0]?.remaining).toBe(0.74);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads per account: another HOME is another reading', async () => {
    const cli = vi.fn<AgyCliRunner>(async () => ({ ok: true, output: OUT }));
    const m = createAgyQuotaMeter(cli);
    await m.refresh(def(), '/w');
    expect(m.read(def({ env: { HOME: '/other' } }))).toBeUndefined();
  });
});
