import type { ConversationRef } from '../core/conversation.js';
import type {
  GitBranchesResult,
  GitFileResult,
  GitMode,
  GitPanel,
  GitStatusFile,
  GitStatusResult,
} from '../platform/adapter.js';
import type { Workspace } from './workspace.js';

/**
 * The daemon's side of the web UI's git window: read-only git for a conversation's directory, run
 * through `Workspace` so the same code answers for the gateway's own machine and for a remote host.
 *
 * ── What is read, and what is deliberately not ──────────────────────────────
 * Three comparisons, all of them the browser's read of the repository, never a repository write:
 * `working` is the working tree against HEAD (untracked files included), `branch` is the working
 * tree against the merge base of HEAD and a base branch, and `committed` is HEAD against that same
 * merge base. There is no stage, commit, discard or checkout anywhere in this file.
 *
 * ── The shape of the commands ───────────────────────────────────────────────
 * Every call runs `git` with argv — no shell. Once the repository root is known, commands run
 * THERE rather than in the conversation's directory: a pathspec after `--` is resolved against the
 * working directory, and every path here is repo-relative. Every path a person can name is placed
 * after `--`, and is first checked against the listing git itself returned. Paths in an answer are
 * always relative to the REPOSITORY root: the topic's directory may be a subdirectory, and a diff
 * whose paths changed meaning with the directory would be unusable.
 *
 * Two flags are about correctness rather than taste. `GIT_OPTIONAL_LOCKS=0` because an agent is
 * usually working in this repository at the same moment and `git status` must not take the index
 * lock to refresh it; `LC_ALL=C` so error messages parsed here do not change with the machine's
 * language. `-c core.quotepath=off -c color.ui=never` keep paths readable and patches plain.
 *
 * ── Failure is not an empty change list ─────────────────────────────────────
 * A command that could not run (a timeout, a spawn failure) or exited non-zero is reported as
 * `error` with its own sentence, never as a list of no files. `truncated` means the change LIST
 * itself was cut off — never that one stats command was: the counts are then simply absent, and the
 * files are still the whole list.
 */

/** One side of a file, as a UTF-8 text. The same cap applies to each side; a bigger one is tooLarge. */
const MAX_SIDE_BYTES = 1 << 20;
/** A change list or a branch list may be larger than one file; past this, the window says so. */
const MAX_LIST_BYTES = 4 << 20;
/** The patch is only a fallback for a browser without the code view; keep it from crowding the link. */
const MAX_PATCH_BYTES = 4 << 20;
/** Branch pickers are a menu, not a repository dump. */
const MAX_BRANCHES = 500;
/** Untracked files get one numstat call each; past this many the rest simply show 0/0. */
const MAX_UNTRACKED_STATS = 200;
/** How many of those numstat calls may be in flight at once: one per file would be a storm on a link. */
const UNTRACKED_CONCURRENCY = 4;
/** A file open within this many ms of a listing reuses it; see `buildGitPanel`. */
const LISTING_TTL_MS = 15_000;
/** Listings kept for that reuse, oldest dropped first. */
const LISTING_CACHE_MAX = 16;

const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } as const;

interface GitRun {
  code: number | null;
  output: Buffer;
  text: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  spawnError?: string;
}

/** A command that could not answer; the message is already written for the person. */
class GitFailed extends Error {}

/**
 * Run one git command. `cwd` is the repository ROOT once it is known: a pathspec after `--` is
 * resolved against the working directory, and every path this module passes is repo-relative. The
 * conversation's directory may be a subdirectory of the repository, so a command that accepts a
 * path must not be run from it.
 *
 * A remote workspace rejects a request that passes its deadline rather than answering; that is an
 * answer too, so it comes back as a command that could not run instead of a throw from here.
 */
async function git(
  ws: Workspace,
  args: readonly string[],
  maxBytes = MAX_LIST_BYTES,
  cwd?: string
): Promise<GitRun> {
  let r;
  try {
    r = await ws.run(['git', '--literal-pathspecs', '-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], {
      env: GIT_ENV,
      maxBytes,
      ...(cwd ? { cwd } : {}),
    });
  } catch (e) {
    return {
      code: null,
      output: Buffer.alloc(0),
      text: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      spawnError: e instanceof Error ? e.message : String(e),
    };
  }
  return {
    code: r.code,
    output: r.output,
    text: r.output.toString('utf8'),
    stderr: r.stderr,
    truncated: r.truncated,
    timedOut: r.timedOut,
    ...(r.spawnError ? { spawnError: r.spawnError } : {}),
  };
}

function lastLine(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() ?? '';
}

/** Why a command never answered — a timeout or a spawn failure, which no exit code explains. */
function hardProblem(r: GitRun, what: string): GitFailed | undefined {
  if (r.timedOut) return new GitFailed(`git ${what} timed out.`);
  if (r.spawnError) return new GitFailed(`git ${what} could not run: ${r.spawnError}`);
  return undefined;
}

/** Why a command failed, including a non-zero exit — for the ones where that is not an answer. */
function problemOf(r: GitRun, what: string): GitFailed | undefined {
  const hard = hardProblem(r, what);
  if (hard) return hard;
  if (r.code === 0) return undefined;
  const why = lastLine(r.stderr);
  return new GitFailed(`git ${what} failed${why ? `: ${why}` : '.'}`);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One change, with the bookkeeping the public shapes do not carry. */
interface Entry {
  path: string;
  status: GitStatusFile['status'];
  additions: number;
  deletions: number;
  binary: boolean;
  /** Listed by `git status` as `??` — its diff has to come from `--no-index`. */
  untracked: boolean;
}

interface Listing {
  entries: Entry[];
  truncated: boolean;
}

/** Everything one request needs after the repository and the comparison have been resolved. */
type Prepared =
  | {
      ok: true;
      root: string;
      branch?: string;
      /** The resolved base (the one asked for, else the default), when the repository has one. */
      base?: string;
      /** The commit the old side comes from; absent when HEAD does not exist. */
      from?: string;
      /** The commit the new side comes from; absent means the working tree. */
      to?: string;
      listing: Listing;
    }
  | { ok: false; reason: 'not-git' | 'error'; text: string };

type Rooted = { ok: true; root: string } | { ok: false; reason: 'not-git' | 'error'; text: string };

/**
 * Where the repository is. A directory that is not in one is an answer; a timeout or a spawn
 * failure is not, and must not be worded as one.
 */
async function repoRoot(ws: Workspace): Promise<Rooted> {
  const r = await git(ws, ['rev-parse', '--show-toplevel']);
  const hard = hardProblem(r, 'rev-parse');
  if (hard) return { ok: false, reason: 'error', text: hard.message };
  const root = r.text.trim();
  if (r.code === 0 && root) return { ok: true, root };
  const why = lastLine(r.stderr);
  if (!why || /not a git repository/i.test(why)) {
    return { ok: false, reason: 'not-git', text: 'This directory is not in a git repository.' };
  }
  return { ok: false, reason: 'error', text: `git rev-parse failed: ${why}` };
}

function joinAbs(root: string, rel: string): string {
  return root.endsWith('/') ? `${root}${rel}` : `${root}/${rel}`;
}

function hasNul(b: Buffer): boolean {
  return b.indexOf(0) !== -1;
}

function statusKind(code: string): GitStatusFile['status'] {
  if (code === '??') return 'added';
  // A conflict is a modification, whatever letters git puts beside it.
  if (code.includes('U')) return 'modified';
  // A rename is disabled everywhere here, so A/D come from an add or a delete and never both.
  if (code.includes('A') && !code.includes('D')) return 'added';
  if (code.includes('D') && !code.includes('A')) return 'deleted';
  return 'modified';
}

function nameStatusKind(code: string): GitStatusFile['status'] {
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  return 'modified';
}

/** `git status --porcelain=v1 -z`: `XY path\0` per record, paths unquoted. */
function parseStatus(text: string): Entry[] {
  const out: Entry[] = [];
  for (const rec of text.split('\0')) {
    if (rec.length < 4) continue;
    const path = rec.slice(3);
    if (!path) continue;
    out.push({
      path,
      status: statusKind(rec.slice(0, 2)),
      additions: 0,
      deletions: 0,
      binary: false,
      untracked: rec.slice(0, 2) === '??',
    });
  }
  return out;
}

/** `git diff --name-status -z`: `code\0path\0` per record. */
function parseNameStatus(text: string): Entry[] {
  const parts = text.split('\0');
  const out: Entry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i] ?? '';
    const path = parts[i + 1] ?? '';
    if (!code || !path) continue;
    out.push({ path, status: nameStatusKind(code), additions: 0, deletions: 0, binary: false, untracked: false });
  }
  return out;
}

/** `git diff --numstat -z`: `add\tdel\tpath\0` per record; `-` `-` means binary. */
function applyNumstat(entries: readonly Entry[], text: string): void {
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const rec of text.split('\0')) {
    const a = rec.indexOf('\t');
    const b = rec.indexOf('\t', a + 1);
    if (a < 0 || b < 0) continue;
    const path = rec.slice(b + 1);
    if (!path) continue;
    const add = rec.slice(0, a);
    const del = rec.slice(a + 1, b);
    map.set(path, {
      additions: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
      deletions: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
      binary: add === '-' || del === '-',
    });
  }
  for (const e of entries) {
    const stat = map.get(e.path);
    if (!stat) continue;
    e.additions = stat.additions;
    e.deletions = stat.deletions;
    e.binary = e.binary || stat.binary;
  }
}

/**
 * Line counts for one untracked file.
 *
 * `git diff --no-index --numstat` is what `git add --intent-to-add` would make a plain diff say,
 * without touching an index at all: the gateway has no way to remove a temporary index on a remote
 * host, and leaving one behind in the repository would be worse than one extra command. With `-z`
 * the two paths are NUL-separated as well (`add\tdel\t\0/dev/null\0path\0`), so the file is the
 * last non-empty field, not the field after the second tab.
 */
async function untrackedNumstat(
  ws: Workspace,
  path: string,
  cwd: string
): Promise<{ additions: number; deletions: number; binary: boolean } | null> {
  const r = await git(ws, ['diff', '--no-index', '--numstat', '-z', '--', '/dev/null', path], 64 << 10, cwd);
  if (hardProblem(r, 'diff') || r.truncated || (r.code !== 0 && r.code !== 1)) return null;
  const parts = r.text.split('\0').filter((p) => p.length > 0);
  const first = parts[0];
  if (!first) return null;
  const a = first.indexOf('\t');
  const b = first.indexOf('\t', a + 1);
  if (a < 0 || b < 0) return null;
  const add = first.slice(0, a);
  const del = first.slice(a + 1, b);
  return {
    additions: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
    deletions: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
    binary: add === '-' || del === '-',
  };
}

/** Run `fn` over `items` with at most `limit` in flight — a link, not a process pool. */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      if (at >= items.length) return;
      await fn(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Give the untracked entries their counts, a few at a time. */
async function statUntracked(ws: Workspace, entries: readonly Entry[], cwd: string): Promise<void> {
  const list = entries.filter((e) => e.untracked && !e.path.endsWith('/')).slice(0, MAX_UNTRACKED_STATS);
  await eachLimit(list, UNTRACKED_CONCURRENCY, async (e) => {
    const stat = await untrackedNumstat(ws, e.path, cwd);
    if (!stat) return;
    e.additions = stat.additions;
    e.deletions = stat.deletions;
    e.binary = stat.binary;
  });
}

type Branches = { ok: true; branches: string[] } | { ok: false; text: string };

/** Branches a base may name: local and remote, newest first, a remote HEAD left out. */
async function listBranches(ws: Workspace, cwd: string): Promise<Branches> {
  const r = await git(ws, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:lstrip=2)',
    'refs/heads',
    'refs/remotes',
  ], undefined, cwd);
  const bad = problemOf(r, 'for-each-ref');
  if (bad) return { ok: false, text: bad.message };
  // The END of a cut-off list is not the list: a missing default branch would read as "no base".
  if (r.truncated) return { ok: false, text: 'This repository has too many branches to list.' };
  const seen = new Set<string>();
  for (const raw of r.text.split('\n')) {
    const name = raw.trim();
    if (!name || name.endsWith('/HEAD')) continue;
    seen.add(name);
    if (seen.size >= MAX_BRANCHES) break;
  }
  return { ok: true, branches: [...seen] };
}

/**
 * The base a comparison starts from when the request names none: `origin/HEAD`, then `main`, then
 * `master` — the same order git itself uses to guess a default branch. `origin/HEAD` is read as the
 * symbolic ref it is, so it says `origin/main` and not whatever the remote was called this year.
 */
async function defaultBase(ws: Workspace, branches: readonly string[], cwd: string): Promise<string | undefined> {
  const head = await git(ws, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], undefined, cwd);
  const hard = hardProblem(head, 'symbolic-ref');
  if (hard) throw hard;
  const origin = head.text.trim();
  if (head.code === 0 && origin && branches.includes(origin)) return origin;
  for (const name of ['main', 'master']) {
    if (branches.includes(name)) return name;
    if (branches.includes(`origin/${name}`)) return `origin/${name}`;
  }
  return undefined;
}

async function hasHead(ws: Workspace, cwd: string): Promise<boolean> {
  const r = await git(ws, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, cwd);
  const hard = hardProblem(r, 'rev-parse');
  if (hard) throw hard;
  return r.code === 0;
}

async function currentBranch(ws: Workspace, cwd: string): Promise<string | undefined> {
  const r = await git(ws, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, cwd);
  const hard = hardProblem(r, 'symbolic-ref');
  if (hard) throw hard;
  return r.code === 0 ? r.text.trim() || undefined : undefined;
}

async function mergeBase(ws: Workspace, base: string, cwd: string): Promise<string | null> {
  // `--` before the ref: a branch may be named like an option (`--all` is a legal ref), and
  // without the separator git reads it as one and refuses to compare.
  const r = await git(ws, ['merge-base', '--', base, 'HEAD'], undefined, cwd);
  const hard = hardProblem(r, 'merge-base');
  if (hard) throw hard;
  return r.code === 0 ? r.text.trim() || null : null;
}

/**
 * The working tree against HEAD, untracked files included. `head` false means a repository with
 * no commits: the index still has staged files, and `git diff --cached` counts them against the
 * empty tree, which is what a plain `git diff HEAD` would have done.
 */
async function workingChanges(ws: Workspace, head: boolean, cwd: string): Promise<Listing> {
  const st = await git(ws, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z'], undefined, cwd);
  const bad = problemOf(st, 'status');
  if (bad) throw bad;
  if (st.truncated) return { entries: [], truncated: true };
  const entries = parseStatus(st.text);

  const stats = await git(
    ws,
    head
      ? ['diff', '--no-ext-diff', '--no-renames', '--numstat', '-z', 'HEAD', '--']
      : ['diff', '--cached', '--no-ext-diff', '--no-renames', '--numstat', '-z'],
    undefined,
    cwd
  );
  const badStats = problemOf(stats, 'diff');
  if (badStats) throw badStats;
  // A cut-off stats answer only costs the counts; the list itself is whole, so `truncated` stays
  // false and the files are still shown.
  if (!stats.truncated) applyNumstat(entries, stats.text);
  await statUntracked(ws, entries, cwd);
  return { entries: sortEntries(entries), truncated: false };
}

function sortEntries(entries: Entry[]): Entry[] {
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Everything one mode reports: the list, and the two commits a file's sides come from. */
async function listFor(ws: Workspace, mode: GitMode, head: boolean, mb: string | undefined, cwd: string): Promise<Listing> {
  if (mode === 'working') return workingChanges(ws, head, cwd);
  // An empty repository has no commits to compare: `branch` is then the working tree, and
  // `committed` is honestly empty.
  if (!head || !mb) return mode === 'branch' ? workingChanges(ws, head, cwd) : { entries: [], truncated: false };

  const target = mode === 'committed' ? ['HEAD'] : [];
  const names = await git(ws, ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', mb, ...target, '--'], undefined, cwd);
  const badNames = problemOf(names, 'diff');
  if (badNames) throw badNames;
  if (names.truncated) return { entries: [], truncated: true };
  const entries = parseNameStatus(names.text);

  const stats = await git(ws, ['diff', '--no-ext-diff', '--no-renames', '--numstat', '-z', mb, ...target, '--'], undefined, cwd);
  const badStats = problemOf(stats, 'diff');
  if (badStats) throw badStats;
  // Counts only, as above: a cut-off numstat does not make the list incomplete.
  if (!stats.truncated) applyNumstat(entries, stats.text);

  // A committed comparison is two commits and has no working-tree files. `branch` also shows what
  // is not committed yet, and an untracked file is invisible to `git diff <merge-base>`.
  let truncated = false;
  if (mode === 'branch') {
    const st = await git(ws, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z'], undefined, cwd);
    const bad = problemOf(st, 'status');
    if (bad) throw bad;
    if (st.truncated) truncated = true;
    else {
      const known = new Set(entries.map((e) => e.path));
      for (const e of parseStatus(st.text)) {
        if (e.untracked && !known.has(e.path)) entries.push(e);
      }
      await statUntracked(ws, entries, cwd);
    }
  }
  return { entries: sortEntries(entries), truncated };
}

/** The base a request asks for, or the default — and a branch that does not exist is a refusal. */
async function baseFor(
  ws: Workspace,
  branches: readonly string[],
  requested: string | undefined,
  cwd: string
): Promise<{ ok: true; base?: string } | { ok: false; text: string }> {
  if (requested !== undefined && !branches.includes(requested)) {
    return { ok: false, text: `No branch named ${requested}.` };
  }
  const base = requested ?? (await defaultBase(ws, branches, cwd));
  return { ok: true, ...(base ? { base } : {}) };
}

/** The base and the two commits a comparison needs, or the sentence saying why there is none. */
type Comparison =
  | { ok: true; head: boolean; base?: string; mb?: string }
  | { ok: false; text: string };

async function comparisonFor(
  ws: Workspace,
  mode: GitMode,
  branches: readonly string[],
  requested: string | undefined,
  root: string
): Promise<Comparison> {
  // A base is a branch the list named. Anything else — a flag, a revision expression, a branch
  // deleted between two requests — is refused here, before git is asked to interpret it. The
  // working comparison never uses one, so a stale picker value cannot break it.
  const picked = await baseFor(ws, branches, mode === 'working' ? undefined : requested, root);
  if (!picked.ok) return picked;
  const head = await hasHead(ws, root);
  if (mode === 'working' || !head) return { ok: true, head, ...(picked.base ? { base: picked.base } : {}) };
  if (!picked.base) {
    return { ok: false, text: 'This repository has no base branch to compare with. Choose one, or view the working changes.' };
  }
  const mb = await mergeBase(ws, picked.base, root);
  if (!mb) return { ok: false, text: `There is no merge base between ${picked.base} and HEAD.` };
  return { ok: true, head, base: picked.base, mb };
}

/** Resolve the repository, the base and the listing for one request. */
async function prepare(ws: Workspace, mode: GitMode, requestedBase: string | undefined): Promise<Prepared> {
  const rooted = await repoRoot(ws);
  if (!rooted.ok) return rooted;
  const root = rooted.root;
  const listed = await listBranches(ws, root);
  // The working comparison needs no branch list; a branch list too long to read must not take it
  // down. A comparison that needs a base cannot proceed without one, and says so.
  if (!listed.ok && mode !== 'working') return { ok: false, reason: 'error', text: listed.text };
  const branches = listed.ok ? listed.branches : [];
  const comparison = await comparisonFor(ws, mode, branches, requestedBase, root);
  if (!comparison.ok) return { ok: false, reason: 'error', text: comparison.text };
  const { head, base, mb } = comparison;
  const listing = await listFor(ws, mode, head, mb, root);
  const from = mode === 'working' ? (head ? 'HEAD' : undefined) : mb;
  const to = mode === 'committed' ? 'HEAD' : undefined;
  const branch = await currentBranch(ws, root);
  return {
    ok: true,
    root,
    ...(branch ? { branch } : {}),
    ...(base ? { base } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    listing,
  };
}

/**
 * One file's content at a commit. The path is a literal after `--`; the object id comes back from
 * git, never from the request, so a name that looks like a revision expression cannot pick another
 * object. A path absent there is the empty side of an addition, not an error.
 */
async function blobAt(
  ws: Workspace,
  rev: string,
  path: string,
  cwd: string
): Promise<{ content: Buffer; tooLarge: boolean } | null> {
  const tree = await git(ws, ['ls-tree', '-z', '--full-tree', rev, '--', path], 64 << 10, cwd);
  const badTree = problemOf(tree, 'ls-tree');
  if (badTree) throw badTree;
  if (tree.truncated) return { content: Buffer.alloc(0), tooLarge: true };
  const rec = tree.text.split('\0')[0] ?? '';
  const tab = rec.indexOf('\t');
  if (tab < 0) return null;
  const meta = rec.slice(0, tab).split(' ');
  const oid = meta[2];
  if (!oid || meta[1] !== 'blob') return null;
  const blob = await git(ws, ['cat-file', 'blob', oid], MAX_SIDE_BYTES + 1, cwd);
  const badBlob = problemOf(blob, 'cat-file');
  if (badBlob) throw badBlob;
  if (blob.truncated) return { content: Buffer.alloc(0), tooLarge: true };
  return { content: blob.output, tooLarge: false };
}

/**
 * The working-tree side of one file.
 *
 * A symlink is compared by its TARGET TEXT, as git does, not by what it points at: following it
 * would diff the target file's bytes against a blob that holds a path, and an untracked link could
 * pull a file from outside the repository into the page. `readlink` answers that cheaply; where it
 * is not a program on the machine (Windows), a regular read is the fallback and links are followed.
 */
async function worktreeSide(
  ws: Workspace,
  root: string,
  path: string
): Promise<{ content: Buffer; tooLarge: boolean }> {
  const abs = joinAbs(root, path);
  const link = await ws.run(['readlink', '-n', '--', abs], { maxBytes: 8 << 10 });
  if (link.code === 0 && !link.timedOut && !link.spawnError) {
    return link.truncated ? { content: Buffer.alloc(0), tooLarge: true } : { content: link.output, tooLarge: false };
  }
  const st = await ws.stat(abs);
  if (st.exists && st.dir) throw new GitFailed('That is a directory, not a file.');
  if (!st.exists) return { content: Buffer.alloc(0), tooLarge: false };
  if ((st.size ?? 0) > MAX_SIDE_BYTES) return { content: Buffer.alloc(0), tooLarge: true };
  return { content: await ws.readFile(abs, MAX_SIDE_BYTES), tooLarge: false };
}

/** One changed file's two sides, or the reason there is no text. */
async function sides(
  ws: Workspace,
  root: string,
  from: string | undefined,
  to: string | undefined,
  path: string
): Promise<{ original: Buffer; modified: Buffer; tooLarge: boolean }> {
  let tooLarge = false;
  let original: Buffer = Buffer.alloc(0);
  let modified: Buffer = Buffer.alloc(0);

  if (from) {
    const side = await blobAt(ws, from, path, root);
    if (side) {
      original = side.content;
      tooLarge = tooLarge || side.tooLarge;
    }
  }
  if (to) {
    const side = await blobAt(ws, to, path, root);
    if (side) {
      modified = side.content;
      tooLarge = tooLarge || side.tooLarge;
    }
  } else {
    const side = await worktreeSide(ws, root, path);
    modified = side.content;
    tooLarge = tooLarge || side.tooLarge;
  }
  return { original, modified, tooLarge };
}

function statusOf(prepared: Prepared): GitStatusResult {
  if (!prepared.ok) return { ok: false, reason: prepared.reason, text: prepared.text };
  const files: GitStatusFile[] = prepared.listing.entries.map((e) => ({
    path: e.path,
    status: e.status,
    additions: e.additions,
    deletions: e.deletions,
    ...(e.binary ? { binary: true as const } : {}),
  }));
  return {
    ok: true,
    repo: {
      root: prepared.root,
      ...(prepared.branch ? { branch: prepared.branch } : {}),
      ...(prepared.base ? { base: prepared.base } : {}),
    },
    files,
    ...(prepared.listing.truncated ? { truncated: true as const } : {}),
  };
}

/** A file with no text to show, and why. The three strings are always empty together. */
function noText(path: string, entry: Entry, flags: { binary?: true; tooLarge?: true }): GitFileResult {
  return { ok: true, path, status: entry.status, original: '', modified: '', patch: '', ...flags };
}

/**
 * The argv for one file's patch. A path is always after `--`; an untracked file (or one in a
 * repository with no commits) has nothing to diff against, so `--no-index` against /dev/null is
 * the only form that shows its real lines.
 */
function diffArgs(from: string | undefined, to: string | undefined, untracked: boolean, path: string): string[] {
  if (untracked || !from) {
    return ['diff', '--no-index', '--no-ext-diff', '--no-renames', '--patch', '--unified=3', '--', '/dev/null', path];
  }
  return [
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--patch',
    '--unified=3',
    from,
    ...(to ? [to] : []),
    '--',
    path,
  ];
}

/**
 * One file's two whole sides and its unified diff, from a listing already resolved.
 *
 * `path` is checked against that listing before anything reads it, and is then placed only after
 * `--` in every command. A path the list did not name cannot be read through this function even if
 * a request invents one.
 */
async function fileOf(ws: Workspace, prepared: Prepared, path: string): Promise<GitFileResult> {
  if (!prepared.ok) return { ok: false, text: prepared.text };
  if (prepared.listing.truncated) {
    return { ok: false, text: 'This repository has too many changes to list, so one file cannot be shown.' };
  }
  const entry = prepared.listing.entries.find((e) => e.path === path);
  if (!entry) return { ok: false, text: 'That file is not one of the changes shown.' };
  // The numstat already said there is no text to show; reading a binary file just to prove it
  // again is the one thing this route would spend a megabyte on.
  if (entry.binary) return noText(path, entry, { binary: true });

  let original: Buffer = Buffer.alloc(0);
  let modified: Buffer = Buffer.alloc(0);
  let tooLarge = false;
  try {
    ({ original, modified, tooLarge } = await sides(ws, prepared.root, prepared.from, prepared.to, path));
  } catch (e) {
    if (e instanceof GitFailed) return { ok: false, text: e.message };
    return { ok: false, text: `Could not read this file: ${messageOf(e)}` };
  }

  const binary = hasNul(original) || hasNul(modified);
  if (binary || tooLarge) return noText(path, entry, { ...(binary ? { binary: true as const } : {}), ...(tooLarge ? { tooLarge: true as const } : {}) });

  const patch = await git(ws, diffArgs(prepared.from, prepared.to, entry.untracked || !prepared.from, path), MAX_PATCH_BYTES, prepared.root);
  const hard = hardProblem(patch, 'diff');
  if (hard) return { ok: false, text: hard.message };
  // 1 is `--no-index`'s "the files differ", which is the normal answer here.
  if (patch.code !== 0 && patch.code !== 1) {
    const why = lastLine(patch.stderr);
    return { ok: false, text: `git diff failed${why ? `: ${why}` : '.'}` };
  }
  // A patch that may be the tail of a bigger one is not a patch. The two sides are each under the
  // cap, but a rewrite of a large file can still produce a bigger diff, and showing part of it
  // would read as a diff that lost lines.
  if (patch.truncated) return noText(path, entry, { tooLarge: true });
  return {
    ok: true,
    path,
    status: entry.status,
    original: original.toString('utf8'),
    modified: modified.toString('utf8'),
    patch: patch.text,
  };
}

/**
 * The whole change list for one comparison.
 *
 * `not-git` is answered for a directory that is not inside a repository; everything else that stops
 * a read is `error` with a sentence that names what failed, because "no changes" and "git could not
 * tell" must not look alike in a window a person is using to decide whether work is done.
 */
export async function gitStatus(ws: Workspace, mode: GitMode, base?: string): Promise<GitStatusResult> {
  try {
    return statusOf(await prepare(ws, mode, base));
  } catch (e) {
    return { ok: false, reason: 'error', text: messageOf(e) };
  }
}

/** One file's two whole sides and its unified diff. */
export async function gitFile(
  ws: Workspace,
  mode: GitMode,
  base: string | undefined,
  path: string
): Promise<GitFileResult> {
  try {
    return await fileOf(ws, await prepare(ws, mode, base), path);
  } catch (e) {
    return { ok: false, text: messageOf(e) };
  }
}

/** The branches a base may name, plus the current branch and the default base. */
export async function gitBranches(ws: Workspace): Promise<GitBranchesResult> {
  try {
    const rooted = await repoRoot(ws);
    if (!rooted.ok) return { ok: false, text: rooted.text };
    const listed = await listBranches(ws, rooted.root);
    if (!listed.ok) return { ok: false, text: listed.text };
    const base = await defaultBase(ws, listed.branches, rooted.root);
    const branch = await currentBranch(ws, rooted.root);
    return {
      ok: true,
      ...(branch ? { branch } : {}),
      ...(base ? { base } : {}),
      branches: listed.branches,
    };
  } catch (e) {
    return { ok: false, text: messageOf(e) };
  }
}

/**
 * The panel the daemon hands the web UI, bound to a conversation's workspace.
 *
 * `workspaceOf` is `ConversationRegistry.workspaceForRef`: it answers which machine the agent runs
 * on and which directory its next session would start in, and it starts nothing. A conversation
 * whose agent is no longer configured has no workspace and gets a sentence, not a throw.
 *
 * A LISTING IS KEPT FOR A MOMENT. Opening a file used to resolve the whole comparison again — the
 * repository root, the branch list, the merge base, the diff names, the stats and one numstat per
 * untracked file — for every file clicked, which on a remote host is a round trip per command. A
 * status answer stores its listing here, and the files clicked in the next few seconds reuse it.
 * Its key includes the comparison, so changing mode or base never reads another comparison's list.
 */
export function buildGitPanel(workspaceOf: (ref: ConversationRef) => Workspace | undefined): GitPanel {
  const cache = new Map<string, { at: number; prepared: Prepared }>();
  const keyOf = (ws: Workspace, mode: GitMode, base: string | undefined): string =>
    `${ws.host}\u0000${ws.root}\u0000${mode}\u0000${base ?? ''}`;

  const remember = (key: string, prepared: Prepared): void => {
    if (!prepared.ok) return;
    cache.delete(key);
    cache.set(key, { at: Date.now(), prepared });
    while (cache.size > LISTING_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const cached = (key: string): Prepared | undefined => {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > LISTING_TTL_MS) {
      cache.delete(key);
      return undefined;
    }
    return hit.prepared;
  };

  return {
    async status(ref, mode, base) {
      const ws = workspaceOf(ref);
      if (!ws) return { ok: false, reason: 'error', text: 'This conversation has no workspace on any machine.' };
      try {
        const prepared = await prepare(ws, mode, base);
        remember(keyOf(ws, mode, base), prepared);
        return statusOf(prepared);
      } catch (e) {
        return { ok: false, reason: 'error', text: messageOf(e) };
      }
    },
    async file(ref, mode, base, path) {
      const ws = workspaceOf(ref);
      if (!ws) return { ok: false, text: 'This conversation has no workspace on any machine.' };
      const key = keyOf(ws, mode, base);
      try {
        const prepared = cached(key) ?? (await prepare(ws, mode, base));
        remember(key, prepared);
        return await fileOf(ws, prepared, path);
      } catch (e) {
        return { ok: false, text: messageOf(e) };
      }
    },
    async branches(ref) {
      const ws = workspaceOf(ref);
      if (!ws) return { ok: false, text: 'This conversation has no workspace on any machine.' };
      return gitBranches(ws);
    },
  };
}
