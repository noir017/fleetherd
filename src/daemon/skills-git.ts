import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The git underneath the managed skills: every change the store makes is a commit, and a skill's
 * history is `git log` over its two possible places (`skills/<name>`, `archive/<name>`).
 *
 * ── Why git, and why this shape ──────────────────────────────────────────────────────────────────
 * The skills live in a repository people also edit by hand (agent-skills, decided 2026-11-06), so
 * the history has to be the repository's own: a person's commit and an agent's patch belong in one
 * log, and a revert has to be able to undo either. The store's earlier `.history/` snapshots could
 * only ever see the gateway's own writes.
 *
 * ── Isolated from the machine's git configuration ───────────────────────────────────────────────
 * Every call runs with the system and global config switched off (`GIT_CONFIG_NOSYSTEM`,
 * `GIT_CONFIG_GLOBAL=/dev/null`) and hooks pointed at nothing. The gateway commits on the
 * operator's behalf in a directory nobody works in by hand; a global pre-commit hook, a signing
 * requirement or a credential helper that prompts would turn a skill write into a hang or a
 * failure that has nothing to do with the skill. `LC_ALL=C` keeps the messages matched below in
 * English.
 *
 * Local operations are synchronous on purpose. A commit or a rebase over a handful of small files
 * takes milliseconds, and doing it inside one turn of the event loop means a spawn reading the
 * skills to deliver them can never see a tree halfway through one. Only the network (fetch, push)
 * is asynchronous; see `skills-repo.ts`.
 */

export interface GitIdentity {
  name: string;
  email: string;
}

/** Who a commit is from. A separate name per writer, so `git log --author` tells them apart. */
export const SKILL_AUTHORS = {
  agent: { name: 'talkcode', email: 'talkcode@localhost' },
  gateway: { name: 'talkcode', email: 'talkcode@localhost' },
  person: { name: 'talkcode-web', email: 'talkcode-web@localhost' },
  review: { name: 'talkcode-review', email: 'talkcode-review@localhost' },
} as const satisfies Record<string, GitIdentity>;

export type SkillAuthorKind = keyof typeof SKILL_AUTHORS;

/** Who made a change, for the commit's author and its trailers. */
export interface SkillChangeBy {
  kind: SkillAuthorKind;
  /** The agent id, when an agent (or the reviewer) made it. */
  agent?: string;
  /** The conversation it came from, when there is one. */
  conversation?: string;
}

const CONFIG_ARGS = [
  '-c', 'core.quotepath=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=main',
  '-c', 'advice.detachedHead=false',
];

export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    ...extra,
  };
}

/** Run git in `cwd` and return stdout as text. Throws with git's own stderr in the message. */
export function gitSync(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return gitSyncBuffer(cwd, args, env).toString('utf8');
}

export function gitSyncBuffer(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Buffer {
  try {
    return execFileSync('git', [...CONFIG_ARGS, ...args], {
      cwd,
      env: gitEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw gitError(args, e);
  }
}

/** The network half: fetch and push. `timeoutMs` kills a remote that never answers. */
export function gitAsync(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...CONFIG_ARGS, ...args],
      { cwd, env: gitEnv(env), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const killed = (error as { killed?: boolean }).killed;
          const detail = killed ? `timed out after ${Math.round(timeoutMs / 1000)}s` : String(stderr || error.message).trim();
          reject(new Error(`git ${args[0]}: ${detail}`));
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

function gitError(args: string[], e: unknown): Error {
  const err = e as { stderr?: Buffer | string; message?: string; code?: string };
  if (err.code === 'ENOENT') return new Error('git is not installed; the managed skills need it');
  const stderr = err.stderr ? String(err.stderr).trim() : '';
  return new Error(`git ${args[0]}: ${stderr || err.message || String(e)}`);
}

let gitChecked: boolean | undefined;

/** Whether a `git` binary runs here. Asked once per process. */
export function gitAvailable(): boolean {
  if (gitChecked === undefined) {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      gitChecked = true;
    } catch {
      gitChecked = false;
    }
  }
  return gitChecked;
}

export function isRepo(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'));
}

/** An empty repository on `main`. `symbolic-ref` rather than `init -b`, which git < 2.28 lacks. */
export function initRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  gitSync(root, ['init', '-q']);
  gitSync(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
}

/** Whether HEAD points at a commit yet. A fresh repository's does not. */
export function hasHead(root: string): boolean {
  try {
    gitSync(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    return true;
  } catch {
    return false;
  }
}

/** The paths under `paths` that git knows about or that exist — what `git add -A` may be given. */
function addablePaths(root: string, paths: string[]): string[] {
  return paths.filter((p) => {
    if (fs.existsSync(path.join(root, p))) return true;
    return gitSync(root, ['ls-files', '-z', '--', p]).length > 0;
  });
}

export interface CommitInfo {
  /** `create`, `patch`, `write-file`, `remove-file`, `archive`, `restore`, `revert`, `import`. */
  action: string;
  /** The skill the change is about. */
  skill: string;
  /** Free text: the reviewer's reason, the file, `revert <id>`. */
  note?: string;
  beforeVersion?: string;
  afterVersion?: string;
  by: SkillChangeBy;
  /** When, for the commit's dates; the store's `now`. */
  at: number;
}

/**
 * Commit whatever changed under `paths`, with the change described in trailers so `history` can
 * read the action and the versions back. Returns the commit id, or undefined when nothing changed
 * (a write that put the same bytes back).
 */
export function commitPaths(root: string, paths: string[], info: CommitInfo): string | undefined {
  const addable = addablePaths(root, paths);
  if (addable.length === 0) return undefined;
  gitSync(root, ['add', '-A', '--', ...addable]);
  const staged = gitSync(root, ['diff', '--cached', '--name-only', '-z', '--', ...addable]);
  if (!staged) return undefined;
  const author = SKILL_AUTHORS[info.by.kind];
  const date = new Date(info.at).toISOString();
  gitSync(root, ['commit', '-q', '--no-verify', '-m', commitMessage(info), '--', ...addable], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return gitSync(root, ['rev-parse', 'HEAD']).trim();
}

const TRAILER_PREFIX = 'Talkcode-';

function commitMessage(info: CommitInfo): string {
  const subject = `skills: ${info.action} ${info.skill}`;
  const trailers = [
    `${TRAILER_PREFIX}Action: ${info.action}`,
    `${TRAILER_PREFIX}Skill: ${info.skill}`,
    ...(info.beforeVersion ? [`${TRAILER_PREFIX}Before: ${info.beforeVersion}`] : []),
    ...(info.afterVersion ? [`${TRAILER_PREFIX}After: ${info.afterVersion}`] : []),
    `${TRAILER_PREFIX}By: ${[info.by.kind, info.by.agent].filter(Boolean).join(' ')}`,
    ...(info.by.conversation ? [`${TRAILER_PREFIX}Conversation: ${info.by.conversation}`] : []),
  ];
  // A note is free text from an agent or the reviewer: one paragraph, and never a line that could
  // be read back as one of the trailers.
  const note = info.note
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(TRAILER_PREFIX))
    .join(' ');
  return [subject, ...(note ? ['', note] : []), '', ...trailers].join('\n');
}

export interface LogEntry {
  id: string;
  at: string;
  author: string;
  action?: string;
  beforeVersion?: string;
  afterVersion?: string;
  /** The note for a gateway commit; the subject line for anyone else's. */
  note?: string;
}

/** Every commit touching `paths`, newest first. Empty on a repository with no commits yet. */
export function logPaths(root: string, paths: string[]): LogEntry[] {
  if (!hasHead(root)) return [];
  const out = gitSync(root, ['log', '-z', '--format=%H%x1f%aI%x1f%an%x1f%s%x1f%b', 'HEAD', '--', ...paths]);
  return out
    .split('\0')
    .filter((rec) => rec.trim())
    .map((rec) => parseLogRecord(rec));
}

function parseLogRecord(rec: string): LogEntry {
  const [hash = '', at = '', author = '', subject = '', body = ''] = rec.replace(/^\n+/, '').split('\x1f');
  const trailers = new Map<string, string>();
  const noteLines: string[] = [];
  for (const line of body.split('\n')) {
    const m = new RegExp(`^${TRAILER_PREFIX}([A-Za-z]+): (.*)$`).exec(line.trim());
    if (m) trailers.set(m[1]!, m[2]!.trim());
    else if (line.trim()) noteLines.push(line.trim());
  }
  const action = trailers.get('Action');
  const note = action ? noteLines.join(' ') : subject;
  return {
    id: hash.slice(0, 12),
    at: new Date(at).toISOString(),
    author,
    ...(action ? { action } : {}),
    ...(trailers.get('Before') ? { beforeVersion: trailers.get('Before') } : {}),
    ...(trailers.get('After') ? { afterVersion: trailers.get('After') } : {}),
    ...(note ? { note } : {}),
  };
}

/** The full commit id `id` (a prefix) names, or undefined when it names none. */
export function resolveCommit(root: string, id: string): string | undefined {
  if (!/^[0-9a-f]{7,40}$/.test(id)) return undefined;
  try {
    return gitSync(root, ['rev-parse', '--verify', '-q', `${id}^{commit}`]).trim();
  } catch {
    return undefined;
  }
}

/** The first parent of a commit, or undefined for a root commit. */
export function parentOf(root: string, commit: string): string | undefined {
  try {
    return gitSync(root, ['rev-parse', '--verify', '-q', `${commit}^1`]).trim();
  } catch {
    return undefined;
  }
}

/**
 * Every file under `dir/` (a repository path ending without a slash) as it was at `rev`, keyed by
 * its path below `dir`. Empty when `dir` did not exist then.
 */
export function filesAt(root: string, rev: string, dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const listing = gitSync(root, ['ls-tree', '-r', '-z', rev, '--', `${dir}/`]);
  for (const entry of listing.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [, type, object] = entry.slice(0, tab).split(' ');
    const full = entry.slice(tab + 1);
    if (type !== 'blob' || !object || !full.startsWith(`${dir}/`)) continue;
    files.set(full.slice(dir.length + 1), gitSyncBuffer(root, ['cat-file', 'blob', object]));
  }
  return files;
}

/** Paths with uncommitted changes under `paths`, as `git status --porcelain` reports them. */
export function dirtyPaths(root: string, paths: string[]): string[] {
  const out = gitSync(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths]);
  return out
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
}
