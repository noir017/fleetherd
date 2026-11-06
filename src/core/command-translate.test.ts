import { describe, expect, it } from 'vitest';
import {
  agentCommandSpecs,
  isCliAnsweredCommand,
  agentForCommand,
  unconfiguredHarnessCommand,
  buildHelpText,
  customOptionFor,
  genericCommandSpecs,
  genericNativeNames,
  harnessCommandName,
  harnessForCommand,
  harnessHasPicker,
  isGenericCommand,
  isSessionQuery,
  needsNestedTopics,
  routeCommandAgent,
  routeCommandSpecs,
  translateCommand,
} from './command-translate.js';
import type { AgentDef, RouteRule } from '../config/schema.js';

/**
 * Pure-function tests for the generic command vocabulary.
 *
 * The values asserted here are the ones captured live from the harnesses this daemon
 * launches (opencode reports exactly customize-opencode/init/review; claude reports
 * compact/context/model/usage/… ), so a table edit that contradicts a real harness
 * fails here rather than in a Telegram thread.
 */

const agent = (id: string, harness: AgentDef['harness']): AgentDef =>
  ({ id, harness, args: [], env: {}, permissions: 'auto' }) as AgentDef;

describe('translateCommand', () => {
  it('translates a generic command to the harness native name', () => {
    expect(translateCommand('compact', 'claude')).toEqual({ kind: 'translated', native: 'compact' });
    // Same meaning, different native spelling — the reason a translation layer exists at all.
    expect(translateCommand('compact', 'gemini')).toEqual({ kind: 'translated', native: 'compress' });
    expect(translateCommand('context', 'gemini')).toEqual({ kind: 'translated', native: 'stats' });
  });

  it('rejects a generic command the harness has no equivalent for', () => {
    // ACP has no compaction method at all (session/cancel|close|fork|list|load|new|prompt|resume|
    // set_config_option|set_mode) and opencode's is TUI-only, so there is nothing to answer with.
    expect(translateCommand('compact', 'opencode')).toEqual({ kind: 'unsupported' });
    expect(translateCommand('mcp', 'opencode')).toEqual({ kind: 'unsupported' });
    // codex keeps two deliberate holes, and they are holes for opposite reasons: it never had a
    // /doctor, and it HAD /init until codex-acp 1.12.0 dropped it. Both stay unsupported rather
    // than being aimed at a near-miss command — see the notes at those keys.
    expect(translateCommand('doctor', 'codex')).toEqual({ kind: 'unsupported' });
    expect(translateCommand('init', 'codex')).toEqual({ kind: 'unsupported' });
  });

  it('answers locally where the capability exists over ACP but not as a slash command', () => {
    // opencode has no `/model` or `/context` command — but it reports usage_update every turn and
    // exposes a `model` config option, so the gateway answers both itself rather than refusing.
    expect(translateCommand('model', 'opencode')).toEqual({ kind: 'local' });
    expect(translateCommand('context', 'opencode')).toEqual({ kind: 'local' });
    // claude is the same case, found the same way: its adapter does not advertise `model` at all
    // (so a forwarded /model is a prompt that costs a turn and prints text you then type against),
    // while the session exposes the selector as a config option the daemon can switch directly.
    expect(translateCommand('model', 'claude')).toEqual({ kind: 'local' });
    // A native spelling still wins where the harness really does own the answer.
    expect(translateCommand('context', 'claude')).toEqual({ kind: 'translated', native: 'context' });
    expect(translateCommand('context', 'gemini')).toEqual({ kind: 'translated', native: 'stats' });
    // agy answers each of these on a channel of its own: the model selector and /context from
    // `agy acp`'s session, and /usage from a one-shot `agy -p=/usage` (daemon/agy-acp.ts).
    expect(translateCommand('model', 'agy')).toEqual({ kind: 'local' });
    expect(translateCommand('usage', 'agy')).toEqual({ kind: 'local' });
    expect(translateCommand('context', 'agy')).toEqual({ kind: 'local' });
  });

  it('answers /effort locally on exactly the harnesses probed to expose a level', () => {
    // claude, codex and opencode all expose a `thought_level` config option that
    // session/set_config_option switches (probed 2026-09-23), so none needs a turn for it; so does
    // `agy acp` for Gemini (1.5.1, 2026-11-06) — answered locally, never forwarded into the session.
    for (const h of ['claude', 'codex', 'opencode', 'agy'] as const) {
      expect(translateCommand('effort', h)).toEqual({ kind: 'local' });
    }
    // dsh/gemini expose none: an explicit refusal, never a forward.
    for (const h of ['dsh', 'gemini'] as const) {
      expect(translateCommand('effort', h)).toEqual({ kind: 'unsupported' });
    }
    expect(translateCommand('effort', 'custom')).toEqual({ kind: 'passthrough' });
  });

  it('passes through anything outside the generic vocabulary', () => {
    // A harness-specific command typed directly still reaches its agent.
    expect(translateCommand('dataviz', 'claude')).toEqual({ kind: 'passthrough' });
    expect(translateCommand('customize-opencode', 'opencode')).toEqual({ kind: 'passthrough' });
  });

  it('passes through for a custom harness (nothing is known about its command set)', () => {
    expect(translateCommand('compact', 'custom')).toEqual({ kind: 'passthrough' });
    expect(translateCommand('compact', undefined)).toEqual({ kind: 'passthrough' });
  });

  describe('a custom harness that declared the option a command is answered from', () => {
    const declares = (opt: string): boolean => opt === 'model';
    const declaresNothing = (): boolean => false;

    it('has /model answered by the gateway, as a preset does', () => {
      expect(translateCommand('model', 'custom', declares)).toEqual({ kind: 'local' });
      expect(translateCommand('MODEL', 'custom', declares)).toEqual({ kind: 'local' });
    });

    it('passes /model through when it declared no such option, or nothing is known', () => {
      expect(translateCommand('model', 'custom', declaresNothing)).toEqual({ kind: 'passthrough' });
      expect(translateCommand('model', 'custom')).toEqual({ kind: 'passthrough' });
    });

    it('passes every other command through, whatever it declared', () => {
      expect(translateCommand('compact', 'custom', () => true)).toEqual({ kind: 'passthrough' });
      expect(translateCommand('effort', 'custom', () => true)).toEqual({ kind: 'passthrough' });
      expect(translateCommand('usage', 'custom', () => true)).toEqual({ kind: 'passthrough' });
    });

    it('leaves the presets as they were: the option is not what decides for them', () => {
      expect(translateCommand('model', 'opencode', declaresNothing)).toEqual({ kind: 'local' });
      expect(translateCommand('model', 'gemini', declares)).toEqual({ kind: 'unsupported' });
    });

    it('names the option only where one decides', () => {
      expect(customOptionFor('model')).toBe('model');
      expect(customOptionFor('compact')).toBeUndefined();
      expect(customOptionFor('dataviz')).toBeUndefined();
    });
  });

  it('is case-insensitive on the generic name', () => {
    expect(translateCommand('COMPACT', 'claude')).toEqual({ kind: 'translated', native: 'compact' });
  });

  it('commands shared by both harnesses translate for each, with no cross-talk', () => {
    // init/review exist on both; each side keeps its own meaning rather than one
    // description winning globally (the pre-existing union bug).
    expect(translateCommand('init', 'claude')).toEqual({ kind: 'translated', native: 'init' });
    expect(translateCommand('init', 'opencode')).toEqual({ kind: 'translated', native: 'init' });
    expect(translateCommand('review', 'opencode')).toEqual({ kind: 'translated', native: 'review' });
  });
});

describe('isGenericCommand', () => {
  it('is true only for the vocabulary', () => {
    expect(isGenericCommand('compact')).toBe(true);
    expect(isGenericCommand('dataviz')).toBe(false);
    // Guards against a prototype key being mistaken for a table entry.
    expect(isGenericCommand('constructor')).toBe(false);
    expect(isGenericCommand('toString')).toBe(false);
  });
});

describe('genericCommandSpecs', () => {
  it('returns a fixed, alphabetically ordered set with descriptions', () => {
    const specs = genericCommandSpecs();
    const names = specs.map((s) => s.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('compact');
    expect(specs.every((s) => s.description.length > 0)).toBe(true);
  });

  it('contains no harness-specific commands', () => {
    // The whole point: these leaked into the global menu before and misrouted.
    const names = genericCommandSpecs().map((s) => s.name);
    expect(names).not.toContain('dataviz');
    expect(names).not.toContain('customize-opencode');
    expect(names).not.toContain('batch');
  });
});

describe('genericNativeNames', () => {
  it('lists the native names already reachable generically', () => {
    expect(genericNativeNames('claude')).toContain('compact');
    expect(genericNativeNames('gemini')).toContain('compress'); // native spelling, not the generic one
    expect(genericNativeNames('opencode')).toEqual(new Set(['init', 'review', 'super']));
    expect(genericNativeNames('custom')).toEqual(new Set());
  });
});

describe('/super', () => {
  it('forwards unchanged to every harness that was probed reading the skill', () => {
    // Probed 2026-11-02 (see the table entry): each read skill-super/ and put up a card.
    for (const h of ['claude', 'codex', 'opencode', 'agy'] as const) {
      expect(translateCommand('super', h)).toEqual({ kind: 'translated', native: 'super' });
    }
  });

  it('is unsupported where no skill is placed, and passes through for custom as everything does', () => {
    // skill-link.ts skillHomes returns nothing for these two: nothing would tell them what it means.
    expect(translateCommand('super', 'gemini')).toEqual({ kind: 'unsupported' });
    expect(translateCommand('super', 'dsh')).toEqual({ kind: 'unsupported' });
    expect(translateCommand('super', 'custom')).toEqual({ kind: 'passthrough' });
  });

  it('is the one generic command that needs nested topics', () => {
    expect(needsNestedTopics('super')).toBe(true);
    expect(needsNestedTopics('SUPER')).toBe(true);
    expect(needsNestedTopics('compact')).toBe(false);
    expect(needsNestedTopics('dataviz')).toBe(false);
  });

  it('is offered only on a surface where topics nest, with its argument named', () => {
    expect(genericCommandSpecs({ nested: false }).map((s) => s.name)).not.toContain('super');
    expect(genericCommandSpecs({ nested: true }).find((s) => s.name === 'super')).toEqual({
      name: 'super',
      description: 'Split a job across agents working in parallel (sub-agents)',
      options: [{ name: 'job', description: 'The job to split up', type: 'string', required: true }],
    });
    // No surface: the whole vocabulary, which is what a reload compares.
    expect(genericCommandSpecs().map((s) => s.name)).toContain('super');
    // Taking nothing away from the rest.
    expect(genericCommandSpecs({ nested: false })).toHaveLength(genericCommandSpecs().length - 1);
  });
});

describe('agentCommandSpecs', () => {
  it('one short command per configured harness, deduped and stably ordered', () => {
    const specs = agentCommandSpecs({
      agents: [agent('a', 'claude'), agent('b', 'opencode'), agent('c', 'claude')],
    });
    // The registered name is the short form, not the harness enum value that used to leak here.
    expect(specs.map((s) => s.name)).toEqual(['cc', 'oc']);
  });

  it('skips custom harnesses (the name would mean nothing to a reader)', () => {
    const specs = agentCommandSpecs({ agents: [agent('x', 'custom'), agent('cc', 'claude')] });
    expect(specs.map((s) => s.name)).toEqual(['cc']);
  });

  it('registers agy, whose command switches agents even though it lists none', () => {
    // The regression this pins: agy was skipped entirely because it reports no command list, so
    // the one harness a user most needs to reach by name had no menu entry at all.
    const specs = agentCommandSpecs({ agents: [agent('g', 'agy'), agent('cc', 'claude')] });
    expect(specs.map((s) => s.name)).toEqual(['agy', 'cc']);
    // …and its description does not promise a command list it cannot show.
    expect(specs.find((s) => s.name === 'agy')!.description).not.toMatch(/lists/);
    expect(specs.find((s) => s.name === 'cc')!.description).toMatch(/lists/);
  });

  it('describes every agent command with one phrasing', () => {
    // agy read "Switch this conversation to agy" while its neighbours read "Switch to claude — …",
    // so one menu described the same action two ways and agy looked like a different kind of entry.
    // The verb itself is "Use" since topics stopped switching agents (2026-09-30).
    const specs = agentCommandSpecs({ agents: [agent('g', 'agy'), agent('cc', 'claude')] });
    for (const spec of specs) expect(spec.description).toMatch(/^Use [a-z]+(?: —|$)/);
  });

  it('every description fits the Discord 100-char cap', () => {
    const specs = agentCommandSpecs({
      agents: [agent('a', 'claude'), agent('b', 'opencode'), agent('c', 'codex'), agent('d', 'gemini'), agent('e', 'agy')],
    });
    expect(specs.map((s) => s.name)).toEqual(['agy', 'cc', 'cx', 'gm', 'oc']);
    expect(specs.every((s) => s.description.length <= 100)).toBe(true);
  });
});

describe('translateCommand — agy', () => {
  it('reports unsupported generic commands as unsupported rather than forwarding them', () => {
    // agy answers /compact itself and doing so aborts its stream-json session, so the daemon
    // must reject the generic name instead of passing it through to the agent.
    expect(translateCommand('compact', 'agy')).toEqual({ kind: 'unsupported' });
    // /model via kill-and-respawn with --model and --conversation; /context from the snapshot agy
    // hands its statusLine command; /usage from a one-shot `agy -p=/usage`.
    expect(translateCommand('model', 'agy')).toEqual({ kind: 'local' });
    expect(translateCommand('context', 'agy')).toEqual({ kind: 'local' });
    expect(translateCommand('usage', 'agy')).toEqual({ kind: 'local' });
  });

  it('still passes through a non-generic name (a skill or plugin command)', () => {
    expect(translateCommand('some-skill', 'agy')).toEqual({ kind: 'passthrough' });
  });
});

describe('harness command names', () => {
  it('maps each harness to its registered short name', () => {
    expect(harnessCommandName('claude')).toBe('cc');
    expect(harnessCommandName('opencode')).toBe('oc');
    expect(harnessCommandName('codex')).toBe('cx');
    expect(harnessCommandName('gemini')).toBe('gm');
    expect(harnessCommandName('agy')).toBe('agy');
    // custom advertises no stable command set, so it gets no name.
    expect(harnessCommandName('custom')).toBeUndefined();
    expect(harnessCommandName(undefined)).toBeUndefined();
  });

  it('still resolves the pre-rename full harness names', () => {
    // Not registered (they would cost a menu slot), but accepted when typed so existing muscle
    // memory and any `when: { command: opencode }` already in a config keep working.
    expect(harnessForCommand('opencode')).toBe('opencode');
    expect(harnessForCommand('claude')).toBe('claude');
    expect(harnessForCommand('oc')).toBe('opencode');
    expect(harnessForCommand('CC')).toBe('claude'); // case-insensitive
    expect(harnessForCommand('compact')).toBeUndefined();
    expect(harnessForCommand('custom')).toBeUndefined();
  });

  it('separates "has a registered command" from "has a command list to show"', () => {
    // agy earns a command (switching to it is useful) but can never fill a menu, so a bare
    // invocation must ack the binding instead of posting an empty picker.
    expect(harnessHasPicker('agy')).toBe(false);
    expect(harnessHasPicker('custom')).toBe(false);
    expect(harnessHasPicker('opencode')).toBe(true);
    expect(harnessHasPicker(undefined)).toBe(false);
  });
});

describe('agentForCommand', () => {
  it('selects the first configured agent of the harness the command names', () => {
    const cfg = { agents: [agent('main', 'claude'), agent('side', 'claude'), agent('o', 'opencode')] };
    expect(agentForCommand(cfg, 'cc')).toBe('main');
    expect(agentForCommand(cfg, 'oc')).toBe('o');
    expect(agentForCommand(cfg, 'opencode')).toBe('o'); // the full name resolves too
  });

  it('resolves nothing when that harness is not configured', () => {
    // The command is registered per CONFIGURED harness, so this only happens for a typed name.
    const cfg = { agents: [agent('cc', 'claude')] };
    expect(agentForCommand(cfg, 'oc')).toBeUndefined();
    expect(agentForCommand(cfg, 'compact')).toBeUndefined();
  });
});

describe('unconfiguredHarnessCommand', () => {
  it('names the harness an agent command points at when nothing configures it', () => {
    const cfg = { agents: [agent('cc', 'claude')] };
    expect(unconfiguredHarnessCommand(cfg, 'agy')).toBe('agy');
    expect(unconfiguredHarnessCommand(cfg, 'opencode')).toBe('opencode'); // the alias too
  });

  it('says nothing about a configured harness, or about any other word', () => {
    const cfg = { agents: [agent('cc', 'claude'), agent('g', 'agy')] };
    expect(unconfiguredHarnessCommand(cfg, 'agy')).toBeUndefined();
    expect(unconfiguredHarnessCommand(cfg, 'cc')).toBeUndefined();
    // Not an agent command at all: the generic vocabulary and a harness's own commands are
    // someone else's business, and treating them as a missing agent would swallow them.
    expect(unconfiguredHarnessCommand(cfg, 'compact')).toBeUndefined();
    expect(unconfiguredHarnessCommand(cfg, 'customize-opencode')).toBeUndefined();
  });
});

describe('buildHelpText', () => {
  const cfg = {
    agents: [agent('cc', 'claude'), agent('oc', 'opencode'), agent('g', 'agy')],
    routing: { default: 'cc', pipeline: [] },
  };

  it('lists the daemon commands and every configured agent command', () => {
    const text = buildHelpText(cfg, { agent: 'cc', harness: 'claude' });
    for (const name of ['/new', '/clear', '/help', '/cc', '/oc', '/agy']) {
      expect(text).toContain(name);
    }
    expect(text).toContain('Answering now: **claude**');
  });

  it('lists only the generic commands the current harness can actually run', () => {
    // Listing /compact to an opencode user who will be told "not supported" the moment they tap
    // it is exactly the silent degradation the help text exists to prevent.
    const text = buildHelpText(cfg, { agent: 'oc', harness: 'opencode' });
    expect(text).toContain('/init');
    expect(text).toContain('/review');
    expect(text).not.toContain('/compact');
    expect(text).not.toContain('/usage');
  });

  it('lists only supported generic commands for agy (all three via local handlers)', () => {
    const text = buildHelpText(cfg, { agent: 'g', harness: 'agy' });
    expect(text).toContain('Works on the current agent');
    // Each of these is answered by the gateway, having been traced to the channel agy publishes
    // it on — so each belongs in the help of an agy conversation, and /compact still does not.
    expect(text).toContain('/model');
    expect(text).toContain('/context');
    expect(text).toContain('/usage');
    expect(text).not.toContain('/compact');
    // The agent commands still list, because switching away is what a stuck user needs.
    expect(text).toContain('/cc');
  });

  it('drops the whole generic section for a harness that supports none of it', () => {
    // codex used to be this case and no longer is, and nothing shipped replaces it: every harness
    // in HARNESS_COMMANDS now claims at least one generic command, and `custom` passes everything
    // through by design. So the empty-section branch is reached here with a harness value that is
    // not in the table — it guards a real code path against the next preset added with nothing
    // probed yet, which is the state every harness here started in.
    const unprobed = 'unprobed' as AgentDef['harness'];
    const cfgNone = { agents: [agent('x', unprobed), agent('cc', 'claude')], routing: { default: 'cc', pipeline: [] } };
    const text = buildHelpText(cfgNone, { agent: 'x', harness: unprobed });
    expect(text).not.toContain('Works on the current agent');
    // The agent commands still list, because switching away is what a stuck user needs.
    expect(text).toContain('/cc');
  });

  it('codex offers the generic commands its adapter was probed to have', () => {
    // Guards the migration off Zed's adapter: that one advertised six commands and no model list,
    // so codex answered "unsupported" to everything here. Probed against
    // @agentclientprotocol/codex-acp 1.12.0 — forwarded natives, plus the two answered locally
    // because they exist over ACP (usage_update, the `model` config option) with no slash command.
    expect(translateCommand('usage', 'codex')).toEqual({ kind: 'translated', native: 'status' });
    expect(translateCommand('compact', 'codex')).toEqual({ kind: 'translated', native: 'compact' });
    expect(translateCommand('mcp', 'codex')).toEqual({ kind: 'translated', native: 'mcp' });
    expect(translateCommand('review', 'codex')).toEqual({ kind: 'translated', native: 'review' });
    expect(translateCommand('context', 'codex')).toEqual({ kind: 'local' });
    expect(translateCommand('model', 'codex')).toEqual({ kind: 'local' });
  });

  it('cannot drift from what gets registered', () => {
    // Every agent command in the menu appears in the help, by construction (same table).
    const text = buildHelpText(cfg);
    for (const spec of agentCommandSpecs(cfg)) expect(text).toContain(`/${spec.name}`);
  });

  it('lists /super, with what it takes, only where the platform can nest its topics', () => {
    const here = { agent: 'cc', harness: 'claude' as const };
    expect(buildHelpText(cfg, here, { nested: true })).toContain('`/super <job>` — Split a job across agents');
    expect(buildHelpText(cfg, here, { nested: false })).not.toContain('/super');
    // And by harness as before: gemini cannot read the skill, so it is not listed even in the web UI.
    const gm = { agents: [agent('gm', 'gemini')], routing: { default: 'gm', pipeline: [] } };
    expect(buildHelpText(gm, { agent: 'gm', harness: 'gemini' }, { nested: true })).not.toContain('/super');
  });

  it('lists the names routing.pipeline gives agents, by the agent they select', () => {
    const withRoutes = {
      agents: [...cfg.agents, { ...agent('oc-a2', 'opencode'), host: 'devbox' }],
      routing: { default: 'cc', pipeline: [{ when: { command: 'oc2' }, use: { agent: 'oc-a2' } }] },
    };
    const text = buildHelpText(withRoutes);
    expect(text).toContain('`/oc2` — oc-a2 (opencode on devbox)');
    for (const spec of routeCommandSpecs(withRoutes)) expect(text).toContain(`/${spec.name}`);
  });
});

describe('routeCommandSpecs', () => {
  const agents = [
    agent('cc', 'claude'),
    agent('oc', 'opencode'),
    { ...agent('oc-a2', 'opencode'), host: 'devbox' },
    { ...agent('ag-a2', 'agy'), host: 'devbox' },
  ];
  const routes = (...pipeline: RouteRule[]) => ({ agents, routing: { default: 'cc', pipeline } });
  const rule = (when: RouteRule['when'], agentId: string): RouteRule => ({ when, use: { agent: agentId } });

  it('registers each name a command-only rule gives an agent, sorted, described by that agent', () => {
    const specs = routeCommandSpecs(routes(rule({ command: 'oc2' }, 'oc-a2'), rule({ command: '/AG2' }, 'ag-a2')));
    // Normalized the way routing matches it: leading slash dropped, lowercased.
    expect(specs.map((s) => s.name)).toEqual(['ag2', 'oc2']);
    // Phrased like an agent command; the bare form's picker is promised only where it exists.
    expect(specs.find((s) => s.name === 'oc2')!.description).toBe(
      'Use oc-a2 (opencode on devbox) — alone, lists its own commands'
    );
    expect(specs.find((s) => s.name === 'ag2')!.description).toBe('Use ag-a2 (agy on devbox)');
    expect(routeCommandAgent(routes(rule({ command: 'oc2' }, 'oc-a2')), 'oc2')).toBe('oc-a2');
  });

  it('skips a rule with another condition: the menu is global, the rule is not', () => {
    // From any other chat the name would reach the bound agent as the literal text `/oc2`.
    const specs = routeCommandSpecs(routes(rule({ command: 'oc2', platform: 'tg' }, 'oc-a2')));
    expect(specs).toEqual([]);
  });

  it('stops at the first rule that does not match on a command, since it answers `/oc2 …` too', () => {
    const specs = routeCommandSpecs(
      routes(rule({ command: 'ag2' }, 'ag-a2'), rule({ platform: 'tg' }, 'cc'), rule({ command: 'oc2' }, 'oc-a2'))
    );
    expect(specs.map((s) => s.name)).toEqual(['ag2']);
  });

  it('leaves names the menu already answers to their own entry', () => {
    // A harness name, short or full (`/opencode` stays unregistered on purpose), a generic command,
    // a daemon command — each already means something in the menu, so a rule naming it adds nothing.
    const specs = routeCommandSpecs(
      routes(
        rule({ command: 'oc' }, 'oc-a2'),
        rule({ command: 'opencode' }, 'oc-a2'),
        rule({ command: 'compact' }, 'oc-a2'),
        rule({ command: 'help' }, 'oc-a2')
      )
    );
    expect(specs).toEqual([]);
  });

  it('lets the first rule for a name decide it, as routing does, and skips names no platform accepts', () => {
    const specs = routeCommandSpecs(
      routes(
        rule({ command: 'oc2', platform: 'tg' }, 'oc'),
        rule({ command: 'oc2' }, 'oc-a2'),
        rule({ command: 'Two Words' }, 'oc-a2')
      )
    );
    expect(specs).toEqual([]);
  });

  it('names a local agent by its harness alone, and a custom one by its id alone', () => {
    const specs = routeCommandSpecs({
      agents: [agent('cc', 'claude'), agent('cc2', 'claude'), agent('tool', 'custom')],
      routing: {
        default: 'cc',
        pipeline: [rule({ command: 'cc2' }, 'cc2'), rule({ command: 'tool' }, 'tool')],
      },
    });
    expect(specs.map((s) => s.description)).toEqual([
      'Use cc2 (claude) — alone, lists its own commands',
      'Use tool',
    ]);
  });
});


describe('dsh harness commands', () => {
  it('registers /dsh as the agent command', () => {
    expect(harnessCommandName('dsh')).toBe('dsh');
    expect(harnessForCommand('dsh')).toBe('dsh');
    expect(harnessHasPicker('dsh')).toBe(true);
  });

  it('dsh answers /model and /context locally (ACP select + usage_update path)', () => {
    expect(translateCommand('model', 'dsh')).toEqual({ kind: 'local' });
    expect(translateCommand('context', 'dsh')).toEqual({ kind: 'local' });
  });

  it('dsh has no native spelling for /compact or /usage', () => {
    expect(translateCommand('compact', 'dsh')).toEqual({ kind: 'unsupported' });
    expect(translateCommand('usage', 'dsh')).toEqual({ kind: 'unsupported' });
  });
});

describe('isCliAnsweredCommand', () => {
  /**
   * The list is what `agy -p /help` prints. Its job is not completeness for its own sake: a name
   * missing from it reaches the resident session, and on agy 1.2.0 that ends the session and every
   * turn queued behind it (status ERROR, process exit 2).
   */
  it('names every command agy’s own CLI intercepts', () => {
    for (const name of [
      'agents', 'changelog', 'config', 'credits', 'effort',
      'help', 'hooks', 'model', 'permissions', 'skills', 'usage',
    ]) {
      expect(isCliAnsweredCommand(name, 'agy')).toBe(true);
    }
  });

  it('leaves skills and unknown names alone — both were probed harmless', () => {
    expect(isCliAnsweredCommand('omp-handoff', 'agy')).toBe(false);
    expect(isCliAnsweredCommand('totally-not-a-real-command-xyz', 'agy')).toBe(false);
  });

  it('is case-insensitive, since a typed command is whatever the user typed', () => {
    expect(isCliAnsweredCommand('Credits', 'agy')).toBe(true);
  });

  it('applies to no other harness: they take these over the protocol, not the CLI', () => {
    expect(isCliAnsweredCommand('model', 'claude')).toBe(false);
    expect(isCliAnsweredCommand('usage', 'opencode')).toBe(false);
    expect(isCliAnsweredCommand('model', undefined)).toBe(false);
  });
});

/**
 * Session queries: the generic commands a busy conversation gets answered by the gateway instead of
 * forwarded — a forwarded one interrupts the turn it asks about (GenericCommand.query).
 */
describe('isSessionQuery', () => {
  it('marks /usage and /context, case-insensitively', () => {
    expect(isSessionQuery('usage')).toBe(true);
    expect(isSessionQuery('context')).toBe(true);
    expect(isSessionQuery('USAGE')).toBe(true);
  });

  it('leaves out commands that do work on the session, and names outside the vocabulary', () => {
    // /compact and /review change or produce something; answering them from a snapshot would be a
    // lie, and delaying them is not the gateway's call. /status is codex's own spelling, not ours.
    for (const name of ['compact', 'review', 'init', 'model', 'effort', 'mcp', 'doctor', 'status', 'cost']) {
      expect(isSessionQuery(name)).toBe(false);
    }
  });
});
