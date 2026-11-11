import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { REVERSE_COMMANDS } from '../ipc/commands.js';
import type { IpcAction } from '../ipc/protocol.js';
import { newProgram } from './program.js';
import { registerReverseCommand } from './reverse-cli.js';

/**
 * The command-line entry itself, not `build()` called with a hand-written array.
 *
 * Commander hands an action `(positional..., options, command)` and fills an omitted optional
 * positional with `undefined`: `sessions list` is `['list', undefined]`. A test that calls
 * `build(['list'])` cannot see that shape, which is how 2.31.0 shipped a `sessions list` that
 * refused itself with "takes no arguments". This parses a real argv through the same
 * registration `cli.ts` uses.
 */

const sessionsSpec = REVERSE_COMMANDS.find((c) => c.usage.startsWith('sessions'))!;
const taskNewSpec = REVERSE_COMMANDS.find((c) => c.usage.startsWith('task-new'))!;
const scheduleSpec = REVERSE_COMMANDS.find((c) => c.usage.startsWith('schedule'))!;
const skillsSpec = REVERSE_COMMANDS.find((c) => c.usage.startsWith('skills'))!;
const fetchSpec = REVERSE_COMMANDS.find((c) => c.usage.startsWith('fetch-messages'))!;

/** Parse one argv and return the action the CLI would hand to `runReverse`. */
function parse(argv: string[], spec = sessionsSpec): IpcAction {
  const program = new Command();
  program.exitOverride(); // a usage error throws instead of exiting the test process
  let action: IpcAction | undefined;
  registerReverseCommand(program, spec, (a) => {
    action = a;
  });
  program.parse(['node', 'fleetherd', ...argv]);
  if (!action) throw new Error('the action was not run');
  return action;
}

describe('sessions on the command line', () => {
  it('builds list when the optional positional is omitted', () => {
    // The exact production shape: ['list', undefined]. Both with and without options.
    expect(parse(['sessions', 'list'])).toEqual({ kind: 'sessions-list', days: undefined, limit: undefined });
    expect(parse(['sessions', 'list', '--days', '7'])).toEqual({ kind: 'sessions-list', days: 7, limit: undefined });
    expect(parse(['sessions', 'ls'])).toEqual({ kind: 'sessions-list', days: undefined, limit: undefined });
  });

  it('builds search and read, which the same phantom slot must not disturb', () => {
    expect(parse(['sessions', 'search', '查询'])).toEqual({
      kind: 'sessions-search',
      query: '查询',
      agent: undefined,
      days: undefined,
      limit: undefined,
    });
    expect(parse(['sessions', 'read', '#12'])).toEqual({
      kind: 'sessions-read',
      session: '#12',
      around: undefined,
      window: undefined,
    });
    expect(parse(['sessions', 'read', '#12', '--around', '3', '--window', '2'])).toEqual({
      kind: 'sessions-read',
      session: '#12',
      around: 3,
      window: 2,
    });
  });

  it('still refuses what is really wrong', () => {
    expect(() => parse(['sessions', 'search'])).toThrow(/needs a word/);
    expect(() => parse(['sessions', 'read'])).toThrow(/missing required argument <session>/);
    expect(() => parse(['sessions', 'frobnicate'])).toThrow(/unknown sessions action/);
    expect(() => parse(['sessions', 'list', '--around', '3'])).toThrow(/--around does not apply/);
    // The range is named, not just "too small".
    expect(() => parse(['sessions', 'read', '#12', '--turns', '0'])).toThrow(/--turns must be at least 1/);
    // One cursor cannot serve a forward resume and a tail read.
    expect(() => parse(['sessions', 'read', '#12', '--since', '5', '--turn', 'done'])).toThrow(
      /cannot be combined/
    );
    expect(() => parse(['sessions', 'read', '#12', '--since', '5', '--turns', '2'])).toThrow(
      /cannot be combined/
    );
    expect(() => parse(['sessions', 'read', '#12', '--since', '5', '--role', 'tool', '--tail', '2'])).toThrow(
      /cannot be combined/
    );
  });
});

describe('task-new on the command line', () => {
  it('allows the agent to be omitted and carries --model through unchanged', () => {
    expect(parse(['task-new', 'review the fix'], taskNewSpec)).toEqual({
      kind: 'task-new',
      agent: undefined,
      text: 'review the fix',
      cwd: undefined,
      title: undefined,
      model: undefined,
    });
    expect(parse(['task-new', 'review the fix', '--model', 'fast-model'], taskNewSpec)).toMatchObject({
      kind: 'task-new',
      model: 'fast-model',
    });
  });
});

describe('schedule edit on the command line', () => {
  it('builds an edit from the id and its options', () => {
    expect(parse(['schedule', 'edit', 'a1b2c3', '--agent', 'oc'], scheduleSpec)).toMatchObject({
      kind: 'schedule-edit',
      id: 'a1b2c3',
      agent: 'oc',
    });
  });
});

describe('global options beside a command\'s own', () => {
  /**
   * Through the real top-level command (program.ts), whose `-c, --config` and `--version` share
   * their names with every command's `-c, --channel` and with `skills patch --version`.
   */
  function parseTop(argv: string[], spec: (typeof REVERSE_COMMANDS)[number]): { action?: IpcAction; out: string; config?: string } {
    const program = newProgram('9.9.9');
    let out = '';
    program.exitOverride().configureOutput({ writeOut: (s) => void (out += s) });
    let action: IpcAction | undefined;
    registerReverseCommand(program, spec, (a) => {
      action = a;
    });
    try {
      program.parse(['node', 'fleetherd', ...argv]);
    } catch (e) {
      if ((e as { code?: string }).code !== 'commander.version') throw e;
    }
    const config = program.opts().config as string | undefined;
    return { ...(action ? { action } : {}), out, ...(config ? { config } : {}) };
  }

  it('gives skills patch its own --version instead of printing the CLI\'s', () => {
    const r = parseTop(['skills', 'patch', 'deploy-check', '--version', 'abc123', '--content', 'x'], skillsSpec);
    expect(r.out).toBe('');
    expect(r.action).toMatchObject({ kind: 'skills', action: 'patch', name: 'deploy-check', version: 'abc123' });
  });

  it('gives -c after a command to that command as --channel, not to the config file', () => {
    const r = parseTop(['fetch-messages', '-c', 'main/abc'], fetchSpec);
    expect(r.config).toBeUndefined();
    expect(r.action).toMatchObject({ kind: 'fetch-messages', channelId: 'main/abc' });
  });

  it('still reads the global options before the command', () => {
    expect(parseTop(['--version'], fetchSpec).out.trim()).toBe('9.9.9');
    const r = parseTop(['-c', '/tmp/x.yaml', 'fetch-messages'], fetchSpec);
    expect(r.config).toBe('/tmp/x.yaml');
    expect(r.action).toMatchObject({ kind: 'fetch-messages', channelId: undefined });
  });
});
