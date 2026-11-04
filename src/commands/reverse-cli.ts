import type { Command } from 'commander';
import { CHANNEL_OPTION, type ReverseCommandSpec } from '../ipc/commands.js';
import type { IpcAction } from '../ipc/protocol.js';

/**
 * Register one reverse command from its catalog spec.
 *
 * Split out of `cli.ts` so the parsing entry can be tested without importing the whole CLI —
 * which parses `process.argv` on import.
 *
 * The subtle part is the action's arguments. Commander calls an action as
 * `(positional..., options, command)`, and an OPTIONAL positional that was not typed still
 * occupies a slot, as `undefined`: `sessions list` arrives as `['list', undefined]`, while
 * `sessions read 12` arrives as `['read', '12']`. So the array handed to `build` is filtered to
 * the strings that were really typed — a build()'s length check is about arguments the caller
 * gave, never about how many slots the parser filled. (2.31.0 shipped without this filter and
 * `sessions list` refused itself with "takes no arguments".)
 */
export function registerReverseCommand(
  program: Command,
  spec: ReverseCommandSpec,
  run: (action: IpcAction) => void | Promise<void>
): void {
  const cmd = program.command(spec.usage).description(spec.description);
  for (const opt of [...spec.options, CHANNEL_OPTION]) {
    if (opt.parse) cmd.option(opt.flags, opt.description ?? '', opt.parse);
    else cmd.option(opt.flags, opt.description ?? '');
  }
  cmd.action((...args: unknown[]) => {
    args.pop(); // command object
    const opts = (args.pop() ?? {}) as Record<string, unknown>;
    const positionals = args.filter((a): a is string => typeof a === 'string');
    // Returned, not just called: `cli.ts` runs `parseAsync`, which awaits an action's promise —
    // so a rejection reaches its catch exactly as it did when this loop lived there.
    return run(spec.build(positionals, opts));
  });
}
