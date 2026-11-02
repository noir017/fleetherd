#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { encode } from '@toon-format/toon';
import { runSetup } from './commands/setup.js';
import { runDoctor } from './commands/doctor.js';
import { runReverse } from './commands/reverse.js';
import { REVERSE_COMMANDS, CHANNEL_OPTION, renderHelpIndex, renderHelpTopic } from './ipc/commands.js';

// Note: the start path pulls in the heavy koishi + claude agent sdk stack, so it's
// lazy-loaded to keep --help / setup / doctor / reverse commands lightweight to start.
const runStart = () => import('./commands/start.js').then((m) => m.runStart());

/**
 * The real installed version, read from package.json at runtime.
 *
 * This used to be a string literal, and it stopped being true four minor releases ago: a 0.11.0
 * install answered `--version` with `0.2.0`. That is worse than having no flag — it is the first
 * thing you check when a deployment misbehaves, and it sent an investigation of a live daemon after
 * a phantom stale install. The uniagent image even documents the workaround (assert on the
 * installed package.json instead, since --version "will always pass").
 *
 * `createRequire` rather than a JSON import: `../package.json` sits outside rootDir, so importing
 * it would drag the file into the emitted layout and shift dist/cli.js down a directory. This path
 * is correct in both shapes — dist/cli.js and src/cli.ts are each one level below the package root.
 */
const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const program = new Command();
program
  .name('talkcode')
  .description('Gateway that connects IM platforms to coding agents: messaging via Koishi, handled over ACP')
  .version(version)
  // Global: pick a specific config file (e.g. one per platform). Default is ~/.config/talkcode/config.yaml.
  // We stash it on process.env so it's inherited by the spawned agent — its reverse commands then resolve
  // the same config/socket. Only one daemon runs at a time, so the socket sits next to the chosen file.
  .option('-c, --config <path>', 'path to the config YAML to use (default: ~/.config/talkcode/config.yaml)');

// Set the override before any subcommand action runs (setup/start/doctor/reverse all read it via configPath()).
program.hook('preAction', (thisCommand) => {
  const file = thisCommand.opts().config as string | undefined;
  if (file) process.env.TALKCODE_CONFIG_FILE = file;
});

// AXI §6: agents read stdout, not stderr. Commander writes usage/validation errors to stderr by
// default; route them to stdout so the agent that invoked a reverse command can see what went wrong.
program.configureOutput({ writeErr: (str) => process.stdout.write(str) });

// --- Management commands ---
program.command('setup').description('Interactive configuration wizard').action(runSetup);
// doctor is the default: running `talkcode` with no args shows live state (AXI §8), and being
// read-only it's safe to trigger accidentally — unlike starting a daemon.
program
  .command('doctor', { isDefault: true })
  .description('Run environment self-checks (default when no command is given)')
  .option('--migrate-config', 'rewrite a v0 config file to the v1 `platforms:` map format (backs up to config.yaml.bak first)')
  .action((opts: { migrateConfig?: boolean }) => runDoctor({ migrateConfig: opts.migrateConfig }));
program.command('start').description('Start the daemon').action(runStart);

// --- Reverse commands (run by the agent in a shell; located by TALKCODE_TURN_TOKEN) ---
// All derived from the single REVERSE_COMMANDS source, keeping cli, help pages, tools and IPC protocol consistent.
for (const spec of REVERSE_COMMANDS) {
  const cmd = program.command(spec.usage).description(spec.description);
  for (const opt of [...spec.options, CHANNEL_OPTION]) {
    if (opt.parse) cmd.option(opt.flags, opt.description ?? '', opt.parse);
    else cmd.option(opt.flags, opt.description ?? '');
  }
  // commander passes (positional..., options, command); take the last two as options/command.
  cmd.action((...args: unknown[]) => {
    args.pop(); // command object
    const opts = (args.pop() ?? {}) as Record<string, unknown>;
    const positionals = args as string[];
    return runReverse(spec.build(positionals, opts));
  });
}

// The same commands' native-tool front door: an MCP server on stdio, started by the agent's harness
// because the daemon lists it in every ACP session (see commands/mcp.ts). Hidden — nobody types it —
// and lazy-loaded like `start`, though for a lighter reason: it is spawned once per session.
program
  .command('mcp', { hidden: true })
  .description('MCP server giving an agent session send_file and schedule as tools (started by the daemon)')
  .action(() => import('./commands/mcp.js').then((m) => m.runMcp(version)));

// `help [topic]` replaces commander's implicit `help [command]`: it is where the bundled skill sends an
// agent (see HELP_TOPICS), so it answers by TOPIC — `help schedule` — and still falls back to
// a command's own flags for `help send-file`. `--help` keeps commander's full list for humans.
program.helpCommand(false);
program
  .command('help [topic]')
  .description('talkcode commands by topic (schedule, channels, …); `help <command>` for one command')
  .action((topic?: string) => {
    if (!topic) {
      console.log(renderHelpIndex());
      return;
    }
    const page = renderHelpTopic(topic);
    if (page) {
      console.log(page);
      return;
    }
    const cmd = program.commands.find((c) => c.name() === topic);
    if (cmd) {
      console.log(cmd.helpInformation());
      return;
    }
    console.log(encode({ error: `no help topic or command "${topic}"`, help: 'Run `talkcode help` for the topic list.' }));
    process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((e) => {
  // AXI §6: structured error on stdout (not stderr) so an invoking agent can read and act on it.
  console.log(encode({ error: e instanceof Error ? e.message : String(e) }));
  process.exitCode = 1;
});
