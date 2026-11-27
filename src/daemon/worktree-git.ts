import path from 'node:path';
import type { Workspace } from './workspace.js';
import type { ManagedWorktree } from './worktree-store.js';

/** Planned worktree resolved at proposal time (read-only); created only when the sub-task starts. */
export interface WorktreePlan {
  name: string;
  branch: string;
  repoRoot: string;
  path: string;
  baseBranch?: string;
  baseSha: string;
  host?: string;
}

export type WorktreeCleanupDecision =
  | { action: 'remove' }
  | { action: 'prune-missing' }
  | { action: 'keep'; reason: string };

/** Minimum idle age after a sub-agent's last turn ends before its merged worktree may be removed. */
export const WORKTREE_CLEANUP_AGE_MS = 60 * 60 * 1000;

/** How often the daemon checks tracked worktrees for automatic cleanup. */
export const WORKTREE_SWEEP_MS = 15 * 60 * 1000;

const GIT_TIMEOUT_MS = 15_000;
const GIT_ENV_RO = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
const GIT_ENV_RW = { LC_ALL: 'C' };
const WORKTREE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SLUG_MAX = 60;

/** Turn a `--title` string into a safe worktree/branch slug; empty if no ASCII alphanumerics exist. */
export function slugifyWorktreeName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

/** Validate an explicit worktree/branch name; refuses path traversal, slashes, and invalid git refs. */
export function validateWorktreeName(raw: string): string {
  const name = raw.trim();
  if (!name || !WORKTREE_NAME_RE.test(name) || name.includes('..') || name.endsWith('.') || name.endsWith('.lock')) {
    throw new Error(
      `invalid --worktree name "${raw}": use 1–80 letters, digits, ".", "_" or "-", starting with a letter or digit, with no ".." or trailing ".lock"`
    );
  }
  return name;
}

/** Resolve the worktree name from `--worktree [<name>]` and optional `--title`. */
export function resolveWorktreeName(worktree: true | string, title?: string): string {
  if (typeof worktree === 'string') return validateWorktreeName(worktree);
  if (!title?.trim()) {
    throw new Error('--worktree without a name requires --title to derive the name from, or pass --worktree <name>');
  }
  const slug = slugifyWorktreeName(title);
  if (!slug) {
    throw new Error(`could not derive a worktree name from --title "${title}"; pass --worktree <name>`);
  }
  return validateWorktreeName(slug);
}

/** Join paths in POSIX style (used on both local POSIX and remote hosts; git returns forward slashes). */
function posixJoin(base: string, ...parts: string[]): string {
  return path.posix.join(base.replace(/\\/g, '/'), ...parts);
}

async function runGit(
  ws: Workspace,
  args: readonly string[],
  opts: { cwd?: string; readonly?: boolean } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null; error?: string }> {
  const r = await ws.run(['git', ...args], {
    cwd: opts.cwd,
    env: opts.readonly ? GIT_ENV_RO : GIT_ENV_RW,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: 64 * 1024,
  });
  const stdout = r.output.toString('utf8');
  if (r.timedOut) return { ok: false, stdout, stderr: r.stderr, code: null, error: 'git command timed out' };
  if (r.spawnError) return { ok: false, stdout, stderr: r.stderr, code: null, error: r.spawnError };
  return { ok: r.code === 0, stdout, stderr: r.stderr, code: r.code };
}

async function readRepoHead(ws: Workspace, cwd: string): Promise<{ sha: string; branch?: string }> {
  const head = await runGit(ws, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], { cwd, readonly: true });
  if (!head.ok) {
    throw new Error(`cannot use --worktree: repository at ${cwd} has no commits yet (${head.error ?? (head.stderr.trim() || 'unborn HEAD')})`);
  }
  const [sha, branch] = head.stdout.trim().split('\n').map((l) => l.trim());
  if (!sha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) {
    throw new Error(`cannot use --worktree: could not read HEAD commit in ${cwd}`);
  }
  return { sha, ...(branch && branch !== 'HEAD' ? { branch } : {}) };
}

async function assertWorktreeAvailable(ws: Workspace, repoRoot: string, wtPath: string, name: string, branch: string): Promise<void> {
  const st = await ws.stat(wtPath);
  if (st.exists) {
    throw new Error(`worktree "${name}" already exists at ${wtPath}; choose a different --worktree name`);
  }
  const ref = await runGit(ws, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, readonly: true });
  if (ref.code === 0) {
    throw new Error(`branch "${branch}" already exists in ${repoRoot}; choose a different --worktree name`);
  }
}

/**
 * Read-only validation at proposal time: verifies `ws.root` is inside a git repository with a valid
 * HEAD and that neither `.worktrees/<name>` nor branch `<name>` exists yet. Creates nothing.
 */
export async function inspectWorktreePlan(ws: Workspace, name: string, host?: string): Promise<WorktreePlan> {
  const top = await runGit(ws, ['rev-parse', '--show-toplevel'], { readonly: true });
  if (!top.ok) {
    const why = top.error ?? (top.stderr.trim() || 'not a git repository');
    throw new Error(`cannot use --worktree: "${ws.root}" is not inside a git repository (${why})`);
  }
  const repoRoot = top.stdout.trim();
  if (!repoRoot) throw new Error(`cannot use --worktree: could not determine git repository root for "${ws.root}"`);
  const head = await readRepoHead(ws, repoRoot);
  const wtPath = posixJoin(repoRoot, '.worktrees', name);
  await assertWorktreeAvailable(ws, repoRoot, wtPath, name, name);
  return {
    name,
    branch: name,
    repoRoot,
    path: wtPath,
    ...(head.branch ? { baseBranch: head.branch } : {}),
    baseSha: head.sha,
    ...(host ? { host } : {}),
  };
}

/** Ensure `.worktrees/` is ignored via `.git/info/exclude` (never touches tracked `.gitignore`). */
async function ensureWorktreesExcluded(ws: Workspace, repoRoot: string): Promise<void> {
  const ignored = await runGit(ws, ['check-ignore', '-q', '.worktrees/'], { cwd: repoRoot, readonly: true });
  if (ignored.code === 0) return;
  if (ignored.code !== 1) return; // unexpected git error; do not corrupt exclude
  const common = await runGit(ws, ['rev-parse', '--git-common-dir'], { cwd: repoRoot, readonly: true });
  if (!common.ok) return;
  const rawCommon = common.stdout.trim();
  const gitCommonDir = rawCommon.startsWith('/') ? rawCommon : posixJoin(repoRoot, rawCommon);
  const infoDir = posixJoin(gitCommonDir, 'info');
  const excludeFile = posixJoin(infoDir, 'exclude');
  let current = '';
  try {
    current = (await ws.readFile(excludeFile, 1 << 20)).toString('utf8');
  } catch {
    current = '';
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes('.worktrees/') || lines.includes('.worktrees')) return;
  await ws.mkdirp(infoDir);
  const prefix = current.length === 0 || current.endsWith('\n') ? current : `${current}\n`;
  await ws.writeFile(excludeFile, Buffer.from(`${prefix}.worktrees/\n`, 'utf8'), { force: true });
}

/**
 * Create the planned worktree when the sub-task actually starts: re-checks availability and current
 * HEAD, ensures `.worktrees/` is excluded in `.git/info/exclude`, and runs `git worktree add`.
 */
export async function createWorktree(
  ws: Workspace,
  plan: WorktreePlan
): Promise<{ path: string; branch: string; repoRoot: string; baseBranch?: string; baseSha: string }> {
  await assertWorktreeAvailable(ws, plan.repoRoot, plan.path, plan.name, plan.branch);
  const head = await readRepoHead(ws, plan.repoRoot);
  await ensureWorktreesExcluded(ws, plan.repoRoot);
  const add = await runGit(ws, ['worktree', 'add', '-b', plan.branch, plan.path, 'HEAD'], { cwd: plan.repoRoot });
  if (!add.ok) {
    const why = add.error ?? (add.stderr.trim() || add.stdout.trim() || `exit ${add.code}`);
    throw new Error(`could not create worktree ${plan.path} (branch ${plan.branch}): ${why}`);
  }
  return {
    path: plan.path,
    branch: plan.branch,
    repoRoot: plan.repoRoot,
    ...(head.branch ? { baseBranch: head.branch } : {}),
    baseSha: head.sha,
  };
}

/** Best-effort rollback when `openTask` fails immediately after creating a fresh worktree. */
export async function rollbackWorktree(ws: Workspace, repoRoot: string, wtPath: string, branch: string): Promise<void> {
  const rm = await runGit(ws, ['worktree', 'remove', wtPath], { cwd: repoRoot });
  if (rm.ok) {
    await runGit(ws, ['branch', '-d', branch], { cwd: repoRoot });
  }
}

/**
 * Decide whether a tracked worktree is eligible for automatic removal.
 * Removes ONLY when ALL hold: branch merged into baseBranch, clean tree (no uncommitted or untracked
 * changes), no turn running/asking, and at least 1 h since the last turn ended.
 */
export async function checkWorktreeCleanup(
  ws: Workspace,
  wt: ManagedWorktree,
  state: { busy: boolean; asking: boolean; lastEndedAt?: number; now: number }
): Promise<WorktreeCleanupDecision> {
  if (state.busy || state.asking) return { action: 'keep', reason: 'turn running' };
  const endedAt = state.lastEndedAt ?? wt.lastEndedAt;
  if (endedAt === undefined || state.now - endedAt < WORKTREE_CLEANUP_AGE_MS) {
    return { action: 'keep', reason: 'less than 1h since last turn ended' };
  }
  let st;
  try {
    st = await ws.stat(wt.path);
  } catch {
    return { action: 'keep', reason: 'machine unreachable' };
  }
  if (!st.exists) return { action: 'prune-missing' };
  if (!wt.baseBranch) return { action: 'keep', reason: 'created from detached HEAD' };
  const merged = await runGit(
    ws,
    ['merge-base', '--is-ancestor', `refs/heads/${wt.branch}`, `refs/heads/${wt.baseBranch}`],
    { cwd: wt.repoRoot, readonly: true }
  );
  if (merged.code !== 0) {
    return { action: 'keep', reason: `branch ${wt.branch} not merged into ${wt.baseBranch}` };
  }
  const dirty = await runGit(ws, ['status', '--porcelain'], { cwd: wt.path, readonly: true });
  if (!dirty.ok || dirty.stdout.trim().length > 0) {
    return { action: 'keep', reason: 'uncommitted or untracked changes' };
  }
  return { action: 'remove' };
}

/** Remove an eligible worktree (`git worktree remove`, no `--force`) and delete its branch (`-d`, never `-D`). */
export async function removeWorktree(
  ws: Workspace,
  wt: ManagedWorktree
): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
  const rm = await runGit(ws, ['worktree', 'remove', wt.path], { cwd: wt.repoRoot });
  if (!rm.ok) {
    return { removed: false, branchDeleted: false, error: rm.error ?? (rm.stderr.trim() || `exit ${rm.code}`) };
  }
  const br = await runGit(ws, ['branch', '-d', wt.branch], { cwd: wt.repoRoot });
  return {
    removed: true,
    branchDeleted: br.ok,
    ...(!br.ok ? { error: br.error ?? (br.stderr.trim() || `exit ${br.code}`) } : {}),
  };
}
