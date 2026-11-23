import { readdirSync, statSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import type { WorkdirOption } from '../core/workdir-menu.js';

/**
 * The `/cd` option list: an agent's configured working directory, plus the projects one level
 * inside it.
 *
 * ── Why the root is the whole configuration ───────────────────────────────────
 * `agents[].cwd` already names the place this deployment cares about — on the reference deployment
 * a workspace directory holding one sub-directory per project. So the candidate list is derived
 * from it rather than declared a second time: a new project appears in the menu by existing on
 * disk, and nothing in config.yaml can drift out of date with what is actually there.
 *
 * ── Why exactly one level ─────────────────────────────────────────────────────
 * Depth is the only knob that could reasonably vary, and every deeper answer is worse: recursing
 * turns a menu into a file browser (and walks node_modules on the way), while a flat list of a
 * workspace's children is precisely the "which project is this topic about" question `/cd` exists
 * to answer. A directory deeper than that stays reachable the way it always was — by pointing an
 * agent's own `cwd` at it in config.yaml.
 *
 * The root itself is always the first option, so a conversation that wandered into a project can
 * get back out without an operator editing anything.
 */

/**
 * Ceiling on how many sub-directories are offered.
 *
 * A workspace with hundreds of children would otherwise page forever, and the useful answer there
 * is a typed `/cd <name>` rather than 30 taps. The overflow is REPORTED (see `truncated`) and never
 * silently dropped — a menu that looks complete while hiding half the machine is worse than a menu
 * that says it is showing the first 60.
 */
export const WORKDIR_SCAN_MAX = 60;

/** Directory names never offered: VCS/tooling noise that is never a project of its own. */
const SKIP_NAMES = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'target', 'dist']);

/** What one scan produced. `failed` and an empty list are different answers and must stay so. */export type WorkdirScan =
  | { ok: true; options: WorkdirOption[]; truncated: number }
  /** The root could not be read at all — a deleted directory, or a typo in `agents[].cwd`. */
  | { ok: false; reason: string };

/**
 * List `root` and the directories immediately inside it, alphabetically.
 *
 * Symlinks are followed deliberately (`statSync`, not `dirent.isDirectory()`): a workspace of
 * symlinks into mounted volumes is a normal way to lay one out, and refusing those would make the
 * menu quietly incomplete on exactly the machines this gateway runs on. A broken link fails its
 * stat and is skipped.
 */
export function scanWorkdirs(dir: string, rootDir?: string): WorkdirScan {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const listed = entries
    .filter((name) => !name.startsWith('.') && !SKIP_NAMES.has(name))
    .map((name) => {
      try {
        return { name, dir: statSync(join(dir, name)).isDirectory() };
      } catch {
        return { name, dir: false }; // broken symlink, or vanished between readdir and stat
      }
    });
  return workdirScanFrom(dir, listed, false, rootDir);
}

/**
 * The same list from entries already read — what an agent on a remote host gets, whose directory is
 * listed over there (remote/ops.go opListDir, which follows symlinks the same way). POSIX joins,
 * because a remote host is Linux whatever this machine is.
 */
export function workdirScanFrom(
  dir: string,
  entries: ReadonlyArray<{ name: string; dir: boolean }>,
  posixPaths = false,
  rootDir?: string
): WorkdirScan {
  const dirs = entries
    .filter((e) => e.dir && !e.name.startsWith('.') && !SKIP_NAMES.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const joinPath = posixPaths ? posix.join : join;
  const base = posixPaths ? posix.basename : basename;
  const home = rootDir ?? dir;

  const shown = dirs.slice(0, WORKDIR_SCAN_MAX);
  return {
    ok: true,
    options: [
      { path: dir, name: base(dir) || dir, ...(dir === home ? { root: true } : {}) },
      ...shown.map((name) => {
        const full = joinPath(dir, name);
        return { path: full, name, ...(full === home ? { root: true } : {}) };
      }),
    ],
    truncated: dirs.length - shown.length,
  };
}

/**
 * Whether this path is still a directory.
 *
 * Exported so fs knowledge stays in this module. Its caller is a menu click handler re-checking a
 * path it offered a moment ago — a menu is a snapshot, and directories get renamed between the tap
 * and the offer — and it has no other reason to touch the filesystem.
 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
