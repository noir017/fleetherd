import { Command } from 'commander';

/**
 * The top-level command and its global options, apart from `cli.ts` so a test can parse through it
 * (`cli.ts` parses `process.argv` on import).
 *
 * Global options count only BEFORE the subcommand (`enablePositionalOptions`). Commander's default
 * reads them anywhere on the line, and two subcommand options share a global's name: every reverse
 * command's `-c, --channel` and `skills patch --version`. Measured on 2.51.2 (2026-11-09):
 * `fleetherd fetch-messages -c <channel>` answered "config not found at /tmp/<channel>", and
 * `fleetherd skills patch <name> --version <v> --content …` printed the CLI's version and exited 0
 * without patching — an agent's patch to a skill was lost that way the day before, and it created a
 * second skill on the same subject instead. `fleetherd -c <file> start` still works;
 * `fleetherd start -c <file>` no longer does.
 */
export function newProgram(version: string): Command {
  return (
    new Command()
      .name('fleetherd')
      .description('Gateway that connects IM platforms to coding agents: messaging via Koishi, handled over ACP')
      .version(version)
      .enablePositionalOptions()
      // Global: pick a specific config file (e.g. one per platform). Default is ~/.config/fleetherd/config.yaml.
      // We stash it on process.env so it's inherited by the spawned agent — its reverse commands then resolve
      // the same config/socket. Only one daemon runs at a time, so the socket sits next to the chosen file.
      .option('-c, --config <path>', 'path to the config YAML to use (default: ~/.config/fleetherd/config.yaml); goes before the command')
  );
}
