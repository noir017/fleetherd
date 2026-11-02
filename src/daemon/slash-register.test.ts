import { describe, expect, it } from 'vitest';
import { agentCommandToSpec, buildRegisteredSpecs, parsePickButtonId } from './daemon.js';
import type { AgentCommand } from '../types.js';
import type { AgentDef, Config } from '../config/schema.js';

/**
 * Pure-function unit tests for slash-command registration.
 *
 * The registered set is fixed and derived from config. It used to be the union of what every agent
 * reported, which could not work on a multi-harness deployment: native slash is global while agents
 * are per-session, so a union menu could neither attribute an entry nor route it (an agent-specific
 * command invoked from the menu fell through to routing.default and ran on the wrong agent).
 */

const agent = (id: string, harness: AgentDef['harness']): AgentDef =>
  ({ id, harness, args: [], env: {}, permissions: 'auto' }) as AgentDef;

const cfg = (...agents: AgentDef[]): Pick<Config, 'agents' | 'routing'> => ({
  agents,
  routing: { default: agents[0]?.id ?? 'cc', pipeline: [] },
});

describe('agentCommandToSpec', () => {
  it('valid name + no hint → plain spec (no options)', () => {
    expect(agentCommandToSpec({ name: 'review', description: 'Review code' })).toEqual({
      name: 'review',
      description: 'Review code',
    });
  });

  it('with hint → carries one optional string param input', () => {
    const spec = agentCommandToSpec({ name: 'create_plan', description: 'Create a plan', hint: 'Goal' });
    expect(spec).toEqual({
      name: 'create_plan',
      description: 'Create a plan',
      options: [{ name: 'input', description: 'Goal', type: 'string', required: false }],
    });
  });

  it('invalid name (uppercase/space/too long) → null', () => {
    expect(agentCommandToSpec({ name: 'Review', description: 'x' })).toBeNull();
    expect(agentCommandToSpec({ name: 'two words', description: 'x' })).toBeNull();
    expect(agentCommandToSpec({ name: 'a'.repeat(33), description: 'x' })).toBeNull();
  });

  it('empty description falls back to the command name; description and hint truncated to 100 chars', () => {
    const long = 'd'.repeat(150);
    const spec = agentCommandToSpec({ name: 'go', description: '', hint: long })!;
    expect(spec.description).toBe('go');
    expect(spec.options![0]!.description).toHaveLength(100);
  });
});

describe('buildRegisteredSpecs', () => {
  it('registers daemon commands, the generic vocabulary, and one agent command per harness', () => {
    const names = buildRegisteredSpecs(cfg(agent('cc', 'claude'), agent('oc', 'opencode'))).map((s) => s.name);
    // Daemon commands lead (intercepted before any agent).
    expect(names.slice(0, 11)).toEqual([
      'new',
      'clear',
      'stop',
      'kill',
      'cd',
      'agent',
      'setting',
      'reload',
      'title',
      'skills',
      'help',
    ]);
    expect(names).toContain('compact'); // generic
    // Agent commands register under their short name, not the harness enum value.
    expect(names).toContain('cc');
    expect(names).toContain('oc');
    expect(names).not.toContain('claude');
    expect(names).not.toContain('opencode');
  });

  it('registers agy, which used to be skipped for having no command list', () => {
    const names = buildRegisteredSpecs(cfg(agent('cc', 'claude'), agent('g', 'agy'))).map((s) => s.name);
    expect(names).toContain('agy');
  });

  it('registers NO harness-specific commands', () => {
    // The concrete regression: these were registered globally from the union, so invoking
    // /customize_opencode ran it on the `claude` agent (routing.default).
    const names = buildRegisteredSpecs(cfg(agent('cc', 'claude'), agent('oc', 'opencode'))).map((s) => s.name);
    expect(names).not.toContain('customize-opencode');
    expect(names).not.toContain('dataviz');
    expect(names).not.toContain('batch');
  });

  it('registers /super only on a platform that can nest topics, with its argument', () => {
    // Telegram's menu is one per bot, and a sub-agent cannot be opened there: an entry whose every
    // tap ends in a refusal is worse than none. The web UI nests them, and shows the argument.
    const c = cfg(agent('cc', 'claude'));
    expect(buildRegisteredSpecs(c, { nested: false }).map((s) => s.name)).not.toContain('super');
    const web = buildRegisteredSpecs(c, { nested: true }).find((s) => s.name === 'super');
    expect(web?.options).toEqual([{ name: 'job', description: 'The job to split up', type: 'string', required: true }]);
  });

  it('does not depend on what agents report, so the menu cannot churn', () => {
    // Same config → same set, whatever any agent has said and however often it says it. Previously
    // the menu was the union of those reports and whichever harness last built a session overwrote
    // it, flipping between 42 and 5 entries on a two-harness deployment.
    const c = cfg(agent('cc', 'claude'), agent('oc', 'opencode'));
    expect(buildRegisteredSpecs(c)).toEqual(buildRegisteredSpecs(c));
  });

  it('emits no duplicate names (a duplicate fails the whole Telegram setMyCommands batch)', () => {
    const names = buildRegisteredSpecs(cfg(agent('cc', 'claude'), agent('c2', 'claude'))).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('stays far below the platform cap (Discord/Telegram allow 100)', () => {
    const specs = buildRegisteredSpecs(
      cfg(agent('cc', 'claude'), agent('oc', 'opencode'), agent('gm', 'gemini'), agent('cx', 'codex'))
    );
    expect(specs.length).toBeLessThan(100);
  });

  it('every spec has a non-empty description', () => {
    const specs = buildRegisteredSpecs(cfg(agent('cc', 'claude')));
    expect(specs.every((s: { description: string }) => s.description.length > 0)).toBe(true);
  });

  it('registers the names routing.pipeline gives agents, after the agent commands', () => {
    // The case that asked for it: a second opencode on another host, reachable only as `/oc2`, which
    // worked when typed but was offered nowhere — the web UI suggested `/oc` and nothing else.
    const c = cfg(agent('cc', 'claude'), agent('oc', 'opencode'), { ...agent('oc-a2', 'opencode'), host: 'devbox' });
    c.routing.pipeline = [{ when: { command: 'oc2' }, use: { agent: 'oc-a2' } }];
    const names = buildRegisteredSpecs(c).map((s) => s.name);
    expect(names.slice(-3)).toEqual(['cc', 'oc', 'oc2']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not register a pipeline name the harness table already answers', () => {
    // `when.command: oc` is a common rule that predates the built-in agent commands; it must not
    // produce a second `/oc` (Telegram rejects the whole batch on a duplicate name).
    const c = cfg(agent('cc', 'claude'), agent('oc', 'opencode'));
    c.routing.pipeline = [{ when: { command: 'oc' }, use: { agent: 'oc' } }];
    expect(buildRegisteredSpecs(c).filter((s) => s.name === 'oc')).toHaveLength(1);
  });
});

describe('parsePickButtonId', () => {
  it('parses cmd:<reqId>:<index>', () => {
    expect(parsePickButtonId('cmd:ab12cd34:0')).toEqual({ reqId: 'ab12cd34', index: 0 });
    expect(parsePickButtonId('cmd:ab12cd34:7')).toEqual({ reqId: 'ab12cd34', index: 7 });
  });

  it('does not collide with the ask prefix or accept malformed ids', () => {
    expect(parsePickButtonId('ask:ab12cd34:0')).toBeNull();
    expect(parsePickButtonId('cmd:ab12:x')).toBeNull();
    expect(parsePickButtonId('cmd::0')).toBeNull();
    expect(parsePickButtonId('')).toBeNull();
  });

  it('stays inside Telegram callback_data limits (64 bytes; longer ids hash lossily)', () => {
    // The id must survive the round trip, so command names are never encoded into it.
    expect(Buffer.byteLength('cmd:ab12cd34:24', 'utf8')).toBeLessThanOrEqual(64);
  });
});

/** The AgentCommand shape is still used by the pickers. */
describe('AgentCommand handling', () => {
  it('accepts a reported command with a hint', () => {
    const cmd: AgentCommand = { name: 'plan', description: 'Plan', hint: 'goal' };
    expect(agentCommandToSpec(cmd)?.options).toHaveLength(1);
  });
});
