import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { REVERSE_COMMANDS } from '../ipc/commands.js';
import type { IpcAction } from '../ipc/protocol.js';
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

/** Parse one argv and return the action the CLI would hand to `runReverse`. */
function parse(argv: string[]): IpcAction {
  const program = new Command();
  program.exitOverride(); // a usage error throws instead of exiting the test process
  let action: IpcAction | undefined;
  registerReverseCommand(program, sessionsSpec, (a) => {
    action = a;
  });
  program.parse(['node', 'talkcode', ...argv]);
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
