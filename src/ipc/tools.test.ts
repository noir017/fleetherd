import { describe, expect, it } from 'vitest';
import { REVERSE_COMMANDS } from './commands.js';
import { NATIVE_TOOLS, findNativeTool, optionKey, toolAction, toolInputSchema } from './tools.js';

/**
 * The native tools are views of REVERSE_COMMANDS entries, so what is pinned here is the mapping:
 * that a tool's schema says what its command accepts, and that a tool call builds the same action
 * the same command typed into a shell would.
 */

const tool = (name: string) => findNativeTool(name)!;
const props = (name: string) => toolInputSchema(tool(name)).properties as Record<string, Record<string, unknown>>;

describe('NATIVE_TOOLS', () => {
  it('stays at the three commands an agent can neither do without nor guess exist', () => {
    // Every tool here is carried in every request on every harness; widening this list is a
    // decision, not a refactor (see the header of tools.ts). The third, `skills`, was added
    // 2026-11-06: a library skill is in no list, so an agent cannot guess it is there.
    expect(NATIVE_TOOLS.map((t) => t.name)).toEqual(['send_file', 'schedule', 'skills']);
  });

  it('offers only search and show of the skills command, and none of its write options', () => {
    const skills = NATIVE_TOOLS.find((t) => t.name === 'skills')!;
    const schema = toolInputSchema(skills) as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(['action', 'file', 'name']);
    expect(schema.properties.action!.enum).toEqual(['search', 'show']);
    expect(toolAction(skills, { action: 'search', name: 'deploy a service' })).toEqual({ kind: 'skills', action: 'search', query: 'deploy a service' });
    expect(toolAction(skills, { action: 'show', name: 'deploy-check', file: 'scripts/check.sh' })).toEqual({
      kind: 'skills',
      action: 'show',
      name: 'deploy-check',
      file: 'scripts/check.sh',
    });
    expect(() => toolAction(skills, { action: 'create', name: 'x' })).toThrow(/must be one of search, show/);
    expect(() => toolAction(skills, { action: 'show', name: 'x', content: 'y' })).toThrow(/unknown parameter/);
  });

  it('names a command that exists, and describes every positional its usage declares', () => {
    for (const t of NATIVE_TOOLS) {
      const spec = REVERSE_COMMANDS.find((s) => s.usage.split(' ')[0] === t.command);
      expect(spec, t.name).toBeDefined();
      const positionals = spec!.usage.split(' ').slice(1).map((p) => p.slice(1, -1));
      expect(Object.keys(t.positionals).sort()).toEqual(positionals.sort());
    }
  });

  it('describes what a tool does, never where the agent is running', () => {
    for (const t of NATIVE_TOOLS) expect(t.description).not.toMatch(/gateway|talkcode|chat bot/i);
  });
});

describe('toolInputSchema', () => {
  it('takes send_file parameters from the command: path required, the options optional', () => {
    const schema = toolInputSchema(tool('send_file'));
    expect(schema.required).toEqual(['path']);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(props('send_file'))).toEqual(['path', 'name', 'caption', 'channel']);
    // Option descriptions come from the spec, so the CLI's --help and the tool say the same thing.
    expect(props('send_file').caption!.description).toBe('text shown with the file');
  });

  it('gives schedule its closed sets and every add option', () => {
    const p = props('schedule');
    expect(p.action!.enum).toEqual(['add', 'list', 'show', 'edit', 'pause', 'resume', 'run', 'rm']);
    expect(p.session!.enum).toEqual(['fixed', 'new', 'daily']);
    for (const key of ['cron', 'at', 'tz', 'prompt', 'bash', 'agent', 'model', 'name', 'tag', 'cwd', 'timeout', 'channel']) {
      expect(p[key], key).toBeDefined();
    }
    expect(toolInputSchema(tool('schedule')).required).toEqual(['action']);
  });

  it('declares every parameter a string, the type every option is parsed from', () => {
    for (const t of NATIVE_TOOLS) {
      for (const [key, p] of Object.entries(toolInputSchema(t).properties as Record<string, { type: string }>)) {
        expect(p.type, `${t.name}.${key}`).toBe('string');
      }
    }
  });
});

describe('optionKey', () => {
  it('is the key commander stores the value under', () => {
    expect(optionKey({ flags: '-c, --channel <id>' })).toBe('channel');
    expect(optionKey({ flags: '--dry-run' })).toBe('dryRun');
    expect(() => optionKey({ flags: '-x' })).toThrow(/no long flag/);
  });
});

describe('toolAction', () => {
  it('builds the same send-file action the shell command would', () => {
    expect(toolAction(tool('send_file'), { path: 'out/report.pdf', caption: 'weekly' })).toEqual({
      kind: 'send-file',
      path: 'out/report.pdf',
      name: undefined,
      caption: 'weekly',
      channelId: undefined,
    });
  });

  it('runs option parsers exactly as commander would (10m → ms)', () => {
    const action = toolAction(tool('schedule'), { action: 'add', at: '+30m', bash: 'backup.sh', timeout: '10m' });
    expect(action).toMatchObject({ kind: 'schedule-add', at: '+30m', bash: 'backup.sh', timeoutMs: 600_000 });
  });

  it('passes --tag through as a list, the same as the shell command', () => {
    const action = toolAction(tool('schedule'), { action: 'add', cron: '0 8 * * *', prompt: 'brief', tag: 'ci, deploy' });
    expect(action).toMatchObject({ kind: 'schedule-add', tags: ['ci', 'deploy'] });
    // An empty tag is not "absent" here: it is the command's way of clearing the set.
    expect(toolAction(tool('schedule'), { action: 'edit', id: 'k3x9', tag: '' })).toMatchObject({
      kind: 'schedule-edit',
      id: 'k3x9',
      tags: [],
    });
  });

  it('passes a model through as the shell command would', () => {
    const action = toolAction(tool('schedule'), { action: 'add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', model: 'fast-model' });
    expect(action).toMatchObject({ kind: 'schedule-add', session: 'daily', model: 'fast-model' });
  });

  it('maps the positional id for the management actions', () => {
    expect(toolAction(tool('schedule'), { action: 'pause', id: 'k3x9' })).toEqual({ kind: 'schedule-op', id: 'k3x9', op: 'pause' });
    expect(toolAction(tool('schedule'), { action: 'list' })).toEqual({ kind: 'schedule-list' });
  });

  it('builds an edit with the task id and only the fields given', () => {
    const action = toolAction(tool('schedule'), { action: 'edit', id: 'k3x9', agent: 'oc', timeout: '5m' });
    expect(action).toMatchObject({ kind: 'schedule-edit', id: 'k3x9', agent: 'oc' });
    // --timeout is a bash-only field, so the tool parses it the way the shell does; the daemon is
    // what refuses it for a prompt task, exactly as it does for add.
    expect((action as { timeoutMs?: number }).timeoutMs).toBe(300_000);
    expect(toolAction(tool('schedule'), { action: 'edit', id: 'k3x9', name: 'renamed' })).toMatchObject({
      kind: 'schedule-edit',
      id: 'k3x9',
      name: 'renamed',
    });
    expect(() => toolAction(tool('schedule'), { action: 'edit', id: 'k3x9', session: 'new', name: 'x' })).toThrow(
      /--session cannot be changed by edit/
    );
  });

  it('treats empty strings and null as absent, the way models fill optional parameters', () => {
    expect(toolAction(tool('schedule'), { action: 'list', cron: '', prompt: null, id: '' })).toEqual({ kind: 'schedule-list' });
  });

  it('stringifies a number the model sends rather than refusing it', () => {
    expect(toolAction(tool('schedule'), { action: 'show', id: 42 })).toEqual({ kind: 'schedule-list', id: '42' });
  });

  it('refuses with a sentence the model can act on', () => {
    expect(() => toolAction(tool('send_file'), {})).toThrow('send_file: path is required');
    expect(() => toolAction(tool('send_file'), { path: 'a', colour: 'red' })).toThrow(/unknown parameter\(s\) colour; accepted: path, name, caption, channel/);
    expect(() => toolAction(tool('schedule'), { action: 'explode' })).toThrow(/action must be one of add, list/);
    expect(() => toolAction(tool('schedule'), { action: 'add', session: 'forever' })).toThrow(/session must be one of fixed, new, daily/);
    expect(() => toolAction(tool('send_file'), { path: { nested: true } })).toThrow('send_file: path must be a string');
    expect(() => toolAction(tool('send_file'), 'a.png')).toThrow('arguments must be an object');
  });

  it('leaves the command its own refusals, so tool and shell reject the same calls the same way', () => {
    expect(() => toolAction(tool('schedule'), { action: 'list', cron: '0 8 * * *' })).toThrow('--cron only applies to `schedule add`');
    expect(() => toolAction(tool('schedule'), { action: 'pause' })).toThrow(/needs a task id/);
  });
});
