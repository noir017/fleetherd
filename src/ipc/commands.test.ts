import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_TOPICS, REVERSE_COMMANDS, renderHelpIndex, renderHelpTopic } from './commands.js';
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

  it.each([
    [['pause'], {}, /needs a task id/],
    [['frobnicate'], {}, /unknown schedule action "frobnicate"/],
    [['list'], { cron: '0 8 * * *' }, /--cron only applies to `schedule add`/],
    [['rm', 'x'], { channel: 'tg:1' }, /--channel only applies to `schedule add`/],
    [['add', 'x'], { cron: '0 8 * * *' }, /takes no id/],
    [['add'], { session: 'forever' }, /--session must be fixed or new/],
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

  it('builds a read with its window', () => {
    expect(sessions(['read', '#12'], { around: 87, window: 3 })).toEqual({
      kind: 'sessions-read',
      session: '#12',
      around: 87,
      window: 3,
    });
  });

  it('builds a list', () => {
    expect(sessions(['list'], { days: 7, limit: 10 })).toEqual({ kind: 'sessions-list', days: 7, limit: 10 });
    expect(sessions(['ls'])).toEqual({ kind: 'sessions-list', days: undefined, limit: undefined });
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
  ])('refuses %j %j', (positionals, opts, why) => {
    expect(() => sessions(positionals, opts)).toThrow(why);
  });
});
