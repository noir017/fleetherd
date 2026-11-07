import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_TOPICS, READ_FILTER_OPTIONS, REVERSE_COMMANDS, isBridgedCommand, renderHelpIndex, renderHelpTopic } from './commands.js';
import type { IpcAction } from './protocol.js';

/**
 * The catalog as the agent meets it: through `talkcode help`, and through commander parsing
 * `schedule …` into an action. The help pages are the only place the commands that are not native
 * tools are documented to the agent (the skill points here), so "every command is on a page" is a
 * property worth pinning.
 */

const spec = (usage: string) => REVERSE_COMMANDS.find((c) => c.usage.startsWith(usage))!;
const schedule = (positionals: string[], opts: Record<string, unknown> = {}): IpcAction => spec('schedule').build(positionals, opts);

describe('help topics', () => {
  it('puts every command on a page that exists, and every page has something on it or to say', () => {
    const names = new Set(HELP_TOPICS.map((t) => t.name));
    for (const c of REVERSE_COMMANDS) expect(names.has(c.topic)).toBe(true);
    for (const t of HELP_TOPICS) {
      const commands = REVERSE_COMMANDS.filter((c) => c.topic === t.name);
      expect(commands.length + t.notes.length).toBeGreaterThan(0);
    }
  });

  it('the index names every topic on one line each', () => {
    const index = renderHelpIndex();
    for (const t of HELP_TOPICS) expect(index).toMatch(new RegExp(`^  ${t.name}\\s+${t.summary.slice(0, 20)}`, 'm'));
  });

  it('says nothing about where the agent is running — only what the commands do', () => {
    // The framing the injected hint was removed for ("your replies reach the user automatically")
    // must not come back through the page the skill sends an agent to.
    expect(renderHelpIndex()).not.toMatch(/reach the user|gateway tools/i);
  });

  it('the bundled skill names every topic, since the skill is how an agent finds them', () => {
    // skill/SKILL.md is static markdown, so its topic table is a copy; this keeps it whole.
    const skill = readFileSync(fileURLToPath(new URL('../../skill/SKILL.md', import.meta.url)), 'utf8');
    for (const t of HELP_TOPICS) expect(skill, t.name).toContain(`| \`${t.name}\` |`);
    expect(skill).not.toMatch(/streams back|reach the user automatically|you are running inside/i);
  });

  it('a topic page carries its commands, their flags and its rules', () => {
    const page = renderHelpTopic('schedule')!;
    expect(page).toContain('talkcode schedule <action> [id]');
    expect(page).toContain('--cron <expr>');
    expect(page).toContain('-c, --channel <id>');
    // The rule that makes the whole feature worth having must be on the page the agent reads.
    expect(page).toMatch(/rather than a scheduling tool built into your own harness/);
    expect(page).toMatch(/lives 24h/);
  });

  it('answers undefined for a page that does not exist (the CLI then tries a command name)', () => {
    expect(renderHelpTopic('nope')).toBeUndefined();
    expect(renderHelpTopic('SCHEDULE')).toBeDefined();
  });
});

describe('task commands', () => {
  it('builds task-read’s --full and --tail, task-send’s --interrupt, and task-status', () => {
    expect(spec('task-read').build(['web:main/t1'], { full: true, tail: 20, limit: 5 })).toEqual({
      kind: 'task-read',
      topic: 'web:main/t1',
      limit: 5,
      full: true,
      tail: 20,
    });
    expect(spec('task-send').build(['web:main/t1', 'go'], { interrupt: true })).toEqual({
      kind: 'task-send',
      topic: 'web:main/t1',
      text: 'go',
      interrupt: true,
    });
    expect(spec('task-status').build(['web:main/t1'], {})).toEqual({ kind: 'task-status', topic: 'web:main/t1' });
  });

  it('task-read reuses the sessions-read filters, and its own --tail stays out of them', () => {
    const action = spec('task-read').build(['t'], {
      role: 'tool',
      turn: 'done',
      grep: 'test',
      tail: 5,
    }) as Extract<IpcAction, { kind: 'task-read' }>;
    expect(action).toMatchObject({ role: 'tool', turn: 'done', grep: 'test', tail: 5 });
    expect(spec('task-read').build(['t'], { since: 12 })).toMatchObject({ since: 12 });
    // One `--tail`, two meanings: task-read's is lines of each message, so it must not be taken
    // for the tool-row count sessions read refuses without --role tool.
    expect(() => spec('task-read').build(['t'], { turns: 2, tail: 5 })).not.toThrow();
    expect(spec('task-read').build(['t'], { turns: 2, tail: 5 })).toMatchObject({ turns: 2, tail: 5 });
    // The same validation as sessions read, from the same builder.
    expect(() => spec('task-read').build(['t'], { role: 'bot' })).toThrow(/--role must be user, agent or tool/);
    expect(() => spec('task-read').build(['t'], { turn: 'soon' })).toThrow(/--turn takes last, done/);
    expect(() => spec('task-read').build(['t'], { turn: 'last', turns: 2 })).toThrow(/use one/);
    expect(() => spec('task-read').build(['t'], { since: 3, limit: 5 })).toThrow(/--since reads forward/);
  });

  it('task-read --reply stands alone: it selects the turn itself', () => {
    expect(spec('task-read').build(['t'], { reply: true })).toEqual({ kind: 'task-read', topic: 't', reply: true });
    for (const extra of [{ limit: 5 }, { full: true }, { tail: 3 }, { role: 'agent' }, { turn: 'last' }, { grep: 'x' }]) {
      expect(() => spec('task-read').build(['t'], { reply: true, ...extra })).toThrow(/--reply reads one turn's whole reply/);
    }
  });

  it('refuses --channel: each names its conversation itself', () => {
    for (const usage of ['task-send', 'task-read', 'task-status', 'task-stop']) {
      expect(() => spec(usage).build(['t'], { channel: 'c1' })).toThrow(/names its conversation itself/);
    }
  });
});

describe('skills <action>', () => {
  const skills = (positionals: string[], opts: Record<string, unknown> = {}): IpcAction => spec('skills').build(positionals, opts);

  it('maps the read and write actions onto one IpcAction', () => {
    expect(skills(['list'])).toEqual({ kind: 'skills', action: 'list' });
    expect(skills(['show', 'deploy-check'])).toEqual({ kind: 'skills', action: 'show', name: 'deploy-check' });
    expect(skills(['show', 'deploy-check', 'references/api.md'])).toEqual({
      kind: 'skills',
      action: 'show',
      name: 'deploy-check',
      file: 'references/api.md',
    });
    expect(skills(['create', 'deploy-check'], { description: 'when deploying', body: '# Steps' })).toEqual({
      kind: 'skills',
      action: 'create',
      name: 'deploy-check',
      description: 'when deploying',
      body: '# Steps',
    });
    expect(skills(['patch', 'deploy-check'], { version: 'abc123', content: 'x' })).toEqual({
      kind: 'skills',
      action: 'patch',
      name: 'deploy-check',
      version: 'abc123',
      content: 'x',
    });
    expect(skills(['write-file', 'deploy-check', 'references/api.md'], { content: 'API' })).toEqual({
      kind: 'skills',
      action: 'write-file',
      name: 'deploy-check',
      file: 'references/api.md',
      content: 'API',
    });
    expect(skills(['remove-file', 'deploy-check', 'references/api.md'])).toEqual({
      kind: 'skills',
      action: 'remove-file',
      name: 'deploy-check',
      file: 'references/api.md',
    });
    expect(skills(['revert', 'deploy-check', '001-abc'])).toEqual({ kind: 'skills', action: 'revert', name: 'deploy-check', id: '001-abc' });
    for (const action of ['archive', 'restore', 'pin', 'unpin', 'history']) {
      expect(skills([action, 'deploy-check'])).toEqual({ kind: 'skills', action, name: 'deploy-check' });
    }
  });

  it('refuses a write without the version show printed, and a create without a description', () => {
    expect(() => skills(['patch', 'deploy-check'], { content: 'x' })).toThrow(/needs --version/);
    expect(() => skills(['patch', 'deploy-check'], { version: 'abc123' })).toThrow(/needs --content/);
    expect(() => skills(['create', 'deploy-check'])).toThrow(/needs --description/);
    expect(() => skills(['write-file', 'deploy-check', 'references/a.md'])).toThrow(/needs --content/);
  });

  it('refuses --channel, is gateway-wide, and names an unknown action', () => {
    expect(() => skills(['list'], { channel: 'tg:1' })).toThrow(/--channel does not apply/);
    expect(() => skills(['frobnicate'])).toThrow(/unknown skills action/);
    expect(() => skills(['show'])).toThrow(/needs a <name>/);
  });
});

describe('schedule <action> [id]', () => {
  it('builds an add from its options, --channel as the target', () => {
    expect(
      schedule(['add'], { cron: '0 8 * * *', prompt: 'brief', session: 'new', agent: 'oc', channel: 'tg:586', timeout: undefined })
    ).toEqual({
      kind: 'schedule-add',
      channelId: 'tg:586',
      cron: '0 8 * * *',
      prompt: 'brief',
      session: 'new',
      agent: 'oc',
      name: undefined,
      at: undefined,
      tz: undefined,
      bash: undefined,
      cwd: undefined,
      timeoutMs: undefined,
    });
  });

  it('parses --timeout as a duration', () => {
    const parse = spec('schedule').options.find((o) => o.flags.startsWith('--timeout'))!.parse!;
    expect(parse('90s')).toBe(90_000);
    expect(parse('10m')).toBe(600_000);
    expect(parse('1h')).toBe(3_600_000);
    expect(parse('1500')).toBe(1_500);
    expect(() => parse('soon')).toThrow(/duration like 90s/);
  });

  it.each([
    [['list'], { kind: 'schedule-list' }],
    [['ls'], { kind: 'schedule-list' }],
    [['show', 'a1b2c3'], { kind: 'schedule-list', id: 'a1b2c3' }],
    [['pause', '#a1b2c3'], { kind: 'schedule-op', id: 'a1b2c3', op: 'pause' }],
    [['resume', 'a1b2c3'], { kind: 'schedule-op', id: 'a1b2c3', op: 'resume' }],
    [['run', 'a1b2c3'], { kind: 'schedule-op', id: 'a1b2c3', op: 'run' }],
    [['rm', 'a1b2c3'], { kind: 'schedule-op', id: 'a1b2c3', op: 'remove' }],
    [['delete', 'a1b2c3'], { kind: 'schedule-op', id: 'a1b2c3', op: 'remove' }],
  ])('schedule %j', (positionals, want) => {
    expect(schedule(positionals)).toEqual(want);
  });

  it('builds an edit from its id and options, with no session or channel of its own', () => {
    expect(schedule(['edit', '#a1b2c3'], { agent: 'oc', cwd: '/srv/app', timeout: undefined })).toEqual({
      kind: 'schedule-edit',
      id: 'a1b2c3',
      name: undefined,
      cron: undefined,
      at: undefined,
      tz: undefined,
      prompt: undefined,
      bash: undefined,
      agent: 'oc',
      cwd: '/srv/app',
      model: undefined,
      timeoutMs: undefined,
    });
  });

  it('parses --tag as a comma-separated list, empty pieces dropped, and "" as clearing', () => {
    expect(
      schedule(['add'], { cron: '0 8 * * *', prompt: 'x', tag: ' CI, deploy ,,' })
    ).toMatchObject({ tags: ['CI', 'deploy'] });
    // An empty string is a defined empty list: edit reads it as "clear", not as "not given".
    expect(schedule(['edit', 'a1b2c3'], { tag: '' })).toMatchObject({ tags: [] });
    // A tag alone is something to change.
    expect(schedule(['edit', 'a1b2c3'], { tag: 'ops' })).toMatchObject({ tags: ['ops'] });
    // Not naming it leaves it undefined, so an edit keeps the task's own set.
    const untagged = schedule(['add'], { cron: '0 8 * * *', prompt: 'x' }) as { tags?: string[] };
    expect(untagged.tags).toBeUndefined();
  });

  it.each([
    [['pause'], {}, /needs a task id/],
    [['list'], { tag: 'ci' }, /--tag only applies to `schedule add` and `schedule edit`/],
    [['frobnicate'], {}, /unknown schedule action "frobnicate"/],
    [['list'], { cron: '0 8 * * *' }, /--cron only applies to `schedule add`/],
    [['rm', 'x'], { channel: 'tg:1' }, /--channel only applies to `schedule add`/],
    [['add', 'x'], { cron: '0 8 * * *' }, /takes no id/],
    [['add'], { session: 'forever' }, /--session must be fixed, new or daily/],
    [['edit'], {}, /needs a task id/],
    [['edit', 'a1b2c3'], {}, /needs something to change/],
    [['edit', 'a1b2c3'], { session: 'new' }, /--session cannot be changed by edit.*rm <id>.*add a new one/],
    [['edit', 'a1b2c3'], { channel: 'tg:1' }, /--channel cannot be changed by edit.*rm <id>.*add a new one/],
    [['edit', 'a1b2c3'], { prompt: 'x', bash: 'y' }, /at most one of --prompt/],
    [['edit', 'a1b2c3'], { cron: '0 8 * * *', at: '+1h' }, /at most one of --cron/],
  ])('refuses %j %j', (positionals, opts, why) => {
    expect(() => schedule(positionals, opts)).toThrow(why);
  });
});

describe('sessions <action> [arg]', () => {
  const sessions = (positionals: string[], opts: Record<string, unknown> = {}): IpcAction =>
    spec('sessions').build(positionals, opts);

  it('builds a search, joining unquoted words', () => {
    expect(sessions(['search', 'git', 'status'], { agent: 'cc', days: 30, limit: 5 })).toEqual({
      kind: 'sessions-search',
      query: 'git status',
      agent: 'cc',
      days: 30,
      limit: 5,
    });
  });

  it('takes --tools for a search only', () => {
    expect(sessions(['search', 'git', 'push'], { tools: true })).toMatchObject({ kind: 'sessions-search', tools: true });
    expect(sessions(['search', 'git'])).not.toHaveProperty('tools');
    expect(() => sessions(['read', '#12'], { tools: true })).toThrow(/--tools does not apply to `sessions read`/);
    expect(() => sessions(['list'], { tools: true })).toThrow(/--tools does not apply/);
  });

  it('builds a read with its window', () => {
    expect(sessions(['read', '#12'], { around: 87, window: 3 })).toEqual({
      kind: 'sessions-read',
      session: '#12',
      around: 87,
      window: 3,
    });
  });

  it('builds a read with its filters, and keeps them off every other action', () => {
    expect(
      sessions(['read', '#12'], { role: 'tool', turn: 'done', grep: '查询', tail: 20 })
    ).toMatchObject({
      kind: 'sessions-read',
      session: '#12',
      role: 'tool',
      turn: 'done',
      grep: '查询',
      tail: 20,
    });
    // `--since` reads forward from an id, so it goes with the row filters, not the tail ones.
    expect(sessions(['read', '#12'], { since: 40, grep: '查询' })).toMatchObject({
      kind: 'sessions-read',
      session: '#12',
      since: 40,
      grep: '查询',
    });
    expect(sessions(['read', '12'], { turn: 'last' })).toMatchObject({ kind: 'sessions-read', turn: 'last' });
    expect(sessions(['read', '12'], { turns: 2 })).toMatchObject({ kind: 'sessions-read', turns: 2 });
  });

  it('takes a message id exactly as read prints it, with or without #', () => {
    const parse = (flag: string) => spec('sessions').options.find((o) => o.flags.includes(flag))!.parse!;
    expect(parse('--since')('#87')).toBe(87);
    expect(parse('--since')('87')).toBe(87);
    expect(parse('--around')('#12')).toBe(12);
    expect(() => parse('--since')('#')).toThrow(/positive message id/);
  });

  it('keeps --tail out of the shared filter list task-read will reuse', () => {
    // task-read's own --tail means "the last n lines of each message"; one command cannot carry
    // two --tail options, so the phase-2 reuse is the builder, not this list.
    expect(READ_FILTER_OPTIONS.some((o) => o.flags.includes('--tail'))).toBe(false);
    expect(spec('sessions').options.some((o) => o.flags.includes('--tail'))).toBe(true);
  });

  it('builds a list', () => {
    expect(sessions(['list'], { days: 7, limit: 10 })).toEqual({ kind: 'sessions-list', days: 7, limit: 10 });
    expect(sessions(['ls'])).toEqual({ kind: 'sessions-list', days: undefined, limit: undefined });
  });

  it('ignores the undefined slot commander leaves for an omitted optional positional', () => {
    // `sessions list` reaches build() as ['list', undefined]; length is not "was an argument given".
    const phantom = undefined as unknown as string;
    expect(sessions(['list', phantom])).toEqual({ kind: 'sessions-list', days: undefined, limit: undefined });
    expect(sessions(['ls', phantom], { days: 7 })).toEqual({ kind: 'sessions-list', days: 7, limit: undefined });
    expect(sessions(['read', '#12', phantom])).toEqual({
      kind: 'sessions-read',
      session: '#12',
      around: undefined,
      window: undefined,
    });
    expect(sessions(['search', 'x', phantom])).toMatchObject({ kind: 'sessions-search', query: 'x' });
  });

  it.each([
    [['search'], {}, /needs a word/],
    [['read'], {}, /missing required argument <session>/],
    [['read', '1', '2'], {}, /one conversation id/],
    [['list', 'extra'], {}, /takes no arguments/],
    [['frobnicate'], {}, /unknown sessions action "frobnicate"/],
    [['search', 'x'], { around: 3 }, /--around does not apply/],
    [['read', '1'], { days: 7 }, /--days does not apply/],
    [['list'], { window: 3 }, /--window does not apply/],
    [['search', 'x'], { channel: 'tg:1' }, /--channel does not apply/],
    [['list'], { role: 'tool' }, /--role does not apply/],
    [['read', '1'], { role: 'robot' }, /--role must be user, agent or tool/],
    [['read', '1'], { turn: 'soon' }, /--turn takes last, done/],
    [['read', '1'], { turn: 'last', turns: 2 }, /use one/],
    [['read', '1'], { tail: 5 }, /--tail reads tool lines/],
    [['read', '1'], { around: 3, role: 'tool' }, /--around reads a window of its own/],
  ])('refuses %j %j', (positionals, opts, why) => {
    expect(() => sessions(positionals, opts)).toThrow(why);
  });
});

describe('isBridgedCommand', () => {
  it('lets a remote agent run reverse commands, the tools server and help — nothing else', () => {
    for (const ok of [['send-message', 'hi'], ['send-file', 'x'], ['schedule', 'list'], ['schedule', 'edit', 'a1b2c3', '--name', 'x'], ['mcp'], ['help'], ['--help']]) {
      expect(isBridgedCommand(ok)).toBe(true);
    }
    for (const no of [[], ['start'], ['setup'], ['doctor'], ['--migrate-config']]) {
      expect(isBridgedCommand(no)).toBe(false);
    }
  });

  it('follows the catalog, so a new reverse command is bridged without a second list', () => {
    for (const spec of REVERSE_COMMANDS) expect(isBridgedCommand([spec.usage.split(' ')[0]!])).toBe(true);
  });
});
