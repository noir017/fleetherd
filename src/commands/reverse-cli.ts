import type { Command } from 'commander';
import { CHANNEL_OPTION, type ReverseCommandSpec, type StdinTarget } from '../ipc/commands.js';
import type { IpcAction } from '../ipc/protocol.js';
import { envOf } from '../legacy-name.js';

/** Hard cap matching the IPC socket line limit so an unbounded pipe cannot OOM the CLI. */
const MAX_STDIN_BYTES = 1024 * 1024;

export interface StdinInput {
  isTTY?: boolean;
  read(): Promise<string>;
}

function matchStdinTargets(
  targets: readonly StdinTarget[],
  positionals: string[],
  opts: Record<string, unknown>
): StdinTarget[] {
  const action = positionals[0]?.toLowerCase();
  return targets.filter((t) => {
    if (t.kind === 'positional') return positionals[t.index] === '-';
    if (t.actions && (!action || !t.actions.includes(action))) return false;
    return opts[t.key] === '-';
  });
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_STDIN_BYTES) {
      throw new Error(`stdin exceeds the ${MAX_STDIN_BYTES / (1024 * 1024)} MiB limit`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveStdin(
  matched: StdinTarget[],
  positionals: string[],
  opts: Record<string, unknown>,
  stdin?: StdinInput
): Promise<{ positionals: string[]; opts: Record<string, unknown> }> {
  if (matched.length > 1) {
    const names = matched.map((t) => (t.kind === 'positional' ? t.label : t.flag)).join(' and ');
    throw new Error(`only one argument may read from stdin ("-"); got ${names}`);
  }
  const target = matched[0]!;
  const label = target.kind === 'positional' ? target.label : target.flag;
  const isTTY = stdin ? Boolean(stdin.isTTY) : Boolean(process.stdin.isTTY) || envOf('STDIN_TTY') === '1';
  if (isTTY) {
    throw new Error(`cannot read ${label} from stdin ("-"): stdin is a terminal; pipe input or use a heredoc (<<'EOF')`);
  }
  const content = await (stdin ? stdin.read() : readProcessStdin());
  if (content.trim().length === 0) {
    throw new Error(`cannot read ${label} from stdin ("-"): stdin is empty`);
  }
  if (target.kind === 'positional') {
    const next = [...positionals];
    next[target.index] = content;
    return { positionals: next, opts };
  }
  return { positionals, opts: { ...opts, [target.key]: content } };
}

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
  run: (action: IpcAction) => void | Promise<void>,
  stdin?: StdinInput
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
    const matched = spec.stdin ? matchStdinTargets(spec.stdin, positionals, opts) : [];
    if (matched.length > 0) {
      return resolveStdin(matched, positionals, opts, stdin).then((r) => run(spec.build(r.positionals, r.opts)));
    }
    // Returned, not just called: `cli.ts` runs `parseAsync`, which awaits an action's promise —
    // so a rejection reaches its catch exactly as it did when this loop lived there.
    return run(spec.build(positionals, opts));
  });
}
