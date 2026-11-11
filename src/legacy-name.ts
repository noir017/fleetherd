import fs from 'node:fs';
import path from 'node:path';

/**
 * What 3.0.0 keeps of the name `talkcode`, which this project carried from 2.0.0 until then.
 *
 * The rename was a clean break in the name and not in what already ran: agents on hosts may still
 * call an older CLI, operators still have scripts that read TALKCODE_*, hosts still have
 * ~/.talkcode and the links into it, skills still carry `talkcode-*` keys, and a skills repository
 * still has commits by `talkcode`. Every place the old name is still read or written goes through
 * this file (and remote/legacy.go on the Go side), so the next major removes it by deleting both and
 * fixing what no longer compiles. Nothing here may be imported by `core/`, which needs none of it.
 */
export const LEGACY_NAME = 'talkcode';

/** The CLI's names: the bin entries, the reverse-CLI shim, the host-side link. */
export const CLI_NAMES = ['fleetherd', LEGACY_NAME] as const;

/**
 * The CLI's names and the per-host directory's, as a regex alternation: what an agent ran, or the
 * path it touched, reads either way in a transcript (`talkcode skills show x`, `~/.talkcode/skills/x`).
 */
export const NAME_PATTERN = `(?:${CLI_NAMES.join('|')})`;

type Env = Record<string, string | undefined>;

/** FLEETHERD_<name>, or TALKCODE_<name> when that is unset. */
export function envOf(name: string, env: Env = process.env): string | undefined {
  return env[`FLEETHERD_${name}`] ?? env[`${LEGACY_NAME.toUpperCase()}_${name}`];
}

/**
 * `env` with the TALKCODE_* twin of every FLEETHERD_* key in it, set in place. For an environment an
 * agent gets: on a host it may run a CLI older than 3.0.0, which reads only the old names.
 */
export function withLegacyNames<T extends Env>(env: T): T {
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('FLEETHERD_') && v !== undefined) {
      (env as Env)[`${LEGACY_NAME.toUpperCase()}_${k.slice('FLEETHERD_'.length)}`] = v;
    }
  }
  return env;
}

/** Remove both names of a variable from `env`. */
export function deleteEnv(env: Env, name: string): void {
  delete env[`FLEETHERD_${name}`];
  delete env[`${LEGACY_NAME.toUpperCase()}_${name}`];
}

/**
 * The default config directory under `home`: ~/.config/fleetherd if it exists, else
 * ~/.config/talkcode if THAT exists, else ~/.config/fleetherd (which setup then creates).
 *
 * The old directory is used where it is, never moved: in the container it is a bind mount, and
 * config.yaml may hold absolute paths into it (a terminal socket, a hook's script) that a rename
 * would break without a word. Silent: every reverse command resolves this too, and what it prints
 * reaches the agent that ran it — the daemon says it once, at start (legacyConfigDirNote).
 */
export function defaultConfigDir(home: string): string {
  const current = path.join(home, '.config', 'fleetherd');
  if (fs.existsSync(current)) return current;
  const legacy = path.join(home, '.config', LEGACY_NAME);
  return fs.existsSync(legacy) ? legacy : current;
}

/**
 * What the daemon logs at start when `dir` is the old default directory; undefined otherwise. It
 * must not ask for a plain rename: config.yaml may name paths inside the directory.
 */
export function legacyConfigDirNote(dir: string, home: string): string | undefined {
  if (path.resolve(dir) !== path.join(home, '.config', LEGACY_NAME)) return undefined;
  return (
    `[config] using ${dir}, the config directory's name before 3.0.0, as it is (${path.join(home, '.config', 'fleetherd')} does not exist). ` +
    'Nothing has to move. To move it anyway, change every absolute path in its config.yaml that points into it ' +
    '(terminal.socket, hook commands, identityFile, …) in the same step — or set FLEETHERD_CONFIG_DIR to it, if it is a mount.'
  );
}

/** The per-host directory's old name, relative to the home it is in. */
export const LEGACY_HOST_DIR = `.${LEGACY_NAME}`;

/**
 * Whether `dest` lies inside `dir` — or inside `dir` as it was spelled before 3.0.0, `.fleetherd`
 * read as `.talkcode`. A link made then names `~/.talkcode/skills/foo`; after the move that is the
 * same directory through a link, and the link is just as much the gateway's to repoint or take back
 * (remote/legacy.go does the same on a host).
 */
export function isUnderEitherName(dest: string, dir: string): boolean {
  const inside = (d: string): boolean => path.resolve(dest).startsWith(path.resolve(d) + path.sep);
  const legacy = dir.replace(/([/\\])\.fleetherd(?=[/\\]|$)/, `$1${LEGACY_HOST_DIR}`);
  return inside(dir) || (legacy !== dir && inside(legacy));
}

/**
 * Move `<home>/.talkcode` to `<home>/.fleetherd` and leave a `.talkcode` link to it, when the old one
 * is a real directory and the new one does not exist — the gateway's own machine's twin of the
 * bootstrap step every remote host runs (src/remote/connection.ts). sshd configs, harness skill links
 * and operators' scripts point into the old path, and keep working through the link. A move that
 * fails (the old directory is a mount point) leaves `.fleetherd` as a link to the old one instead.
 * Returns what it did, for the log; undefined when there was nothing to do.
 */
export function migrateHostDir(home: string): string | undefined {
  const legacy = path.join(home, LEGACY_HOST_DIR);
  const current = path.join(home, '.fleetherd');
  try {
    if (!fs.lstatSync(legacy).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  try {
    fs.lstatSync(current);
    return undefined;
  } catch {
    // nothing at the new path: the move is ours to make
  }
  try {
    fs.renameSync(legacy, current);
    fs.symlinkSync('.fleetherd', legacy);
    return `moved ${legacy} to ${current}, and left a link at the old path`;
  } catch (e) {
    if (fs.existsSync(current)) return `moved ${legacy} to ${current}, but could not link the old path: ${(e as Error).message}`;
    try {
      fs.symlinkSync(LEGACY_HOST_DIR, current);
      return `could not move ${legacy} (${(e as Error).message}); linked ${current} to it instead`;
    } catch (e2) {
      return `could not move ${legacy} (${(e as Error).message}) nor link ${current} to it (${(e2 as Error).message})`;
    }
  }
}

/** Every spelling of a skill's frontmatter key under `metadata:` (`fleetherd-resident`, …). */
export function metaKeys(key: string): [string, string] {
  return [key, key.replace(/^fleetherd-/, `${LEGACY_NAME}-`)];
}

/**
 * The skills-repository commit trailers' prefixes, current first. (The commits' authors changed the
 * same way, `talkcode-web` → `fleetherd-web`; the web UI's history, the one place that tells the
 * gateway's commits from a person's, accepts both — platform/webui/page.ts skillHistRow.)
 */
export const TRAILER_PREFIXES = ['Fleetherd-', 'Talkcode-'] as const;

/** The bundled skill's link name before 3.0.0, taken back wherever the new one is made. */
export const LEGACY_SKILL_LINK = LEGACY_NAME;
