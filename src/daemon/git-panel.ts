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
 * ── Why the output caps are treated as failures ─────────────────────────────
 * `Workspace.run` answers with the END of output past its cap (the remote host's ring buffer keeps
 * the tail). A tail of a `-z` record list is not a list — the first record may be cut in half — so
 * a truncated listing is reported as `truncated`, and truncated file content or patch is reported
 * as `tooLarge`. Neither is ever parsed as if it were whole.
 */

/** One side of a file, as a UTF-8 text. The same cap applies to each side; a bigger one is tooLarge. */
const MAX_SIDE_BYTES = 1 << 20;
/** A change list or a patch may be larger than one file; past this, the window says so. */
const MAX_LIST_BYTES = 4 << 20;
/** The patch is only a fallback for a browser without the code view; keep it from crowding the link. */
const MAX_PATCH_BYTES = 4 << 20;
/** Branch pickers are a menu, not a repository dump. */
const MAX_BRANCHES = 500;
/** Untracked files get one numstat call each; past this many the rest simply show 0/0. */
const MAX_UNTRACKED_STATS = 200;

const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } as const;

interface GitRun {
  code: number | null;
  output: Buffer;
  text: string;
  stderr: string;
  truncated: boolean;
}

/**
 * Run one git command. `cwd` is the repository ROOT once it is known: a pathspec after `--` is
 * resolved against the working directory, and every path this module passes is repo-relative. The
 * conversation's directory may be a subdirectory of the repository, so a command that accepts a
 * path must not be run from it.
 */
async function git(
  ws: Workspace,
  args: readonly string[],
  maxBytes = MAX_LIST_BYTES,
  cwd?: string
): Promise<GitRun> {
  const r = await ws.run(
    ['git', '--literal-pathspecs', '-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
    { env: GIT_ENV, maxBytes, ...(cwd ? { cwd } : {}) }
  );
  return {
    code: r.code,
    output: r.output,
    text: r.output.toString('utf8'),
    stderr: r.stderr,
    truncated: r.truncated,
  };
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

/** Where the repository is. Not a repository is an answer, not an exception. */
async function repoRoot(ws: Workspace): Promise<string | null> {
  const r = await git(ws, ['rev-parse', '--show-toplevel']);
  const root = r.text.trim();
  return r.code === 0 && root ? root : null;
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
async function untrackedNumstat(ws: Workspace, path: string, cwd: string): Promise<{ additions: number; deletions: number; binary: boolean } | null> {
  const r = await git(ws, ['diff', '--no-index', '--numstat', '-z', '--', '/dev/null', path], 64 << 10, cwd);
  if (r.truncated || (r.code !== 0 && r.code !== 1)) return null;
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

/** Give the untracked entries their counts, a bounded number at a time. */
async function statUntracked(ws: Workspace, entries: readonly Entry[], cwd: string): Promise<void> {
  const list = entries.filter((e) => e.untracked && !e.path.endsWith('/')).slice(0, MAX_UNTRACKED_STATS);
  await Promise.all(
    list.map(async (e) => {
      const stat = await untrackedNumstat(ws, e.path, cwd);
      if (!stat) return;
      e.additions = stat.additions;
      e.deletions = stat.deletions;
      e.binary = stat.binary;
    })
  );
}

/** Branches a base may name: local and remote, newest first, a remote HEAD left out. */
async function listBranches(ws: Workspace, cwd: string): Promise<string[]> {
  const r = await git(ws, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:lstrip=2)',
    'refs/heads',
    'refs/remotes',
  ], undefined, cwd);
  if (r.code !== 0) return [];
  const seen = new Set<string>();
  for (const raw of r.text.split('\n')) {
    const name = raw.trim();
    if (!name || name.endsWith('/HEAD')) continue;
    seen.add(name);
    if (seen.size >= MAX_BRANCHES) break;
  }
  return [...seen];
}

/**
 * The base a comparison starts from when the request names none: `origin/HEAD`, then `main`, then
 * `master` — the same order git itself uses to guess a default branch. `origin/HEAD` is read as the
 * symbolic ref it is, so it says `origin/main` and not whatever the remote was called this year.
 */
async function defaultBase(ws: Workspace, branches: readonly string[], cwd: string): Promise<string | undefined> {
  const head = await git(ws, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], undefined, cwd);
  const origin = head.text.trim();
  if (head.code === 0 && origin && branches.includes(origin)) return origin;
  for (const name of ['main', 'master']) {
    if (branches.includes(name)) return name;
    if (branches.includes(`origin/${name}`)) return `origin/${name}`;
  }
  return undefined;
}

async function hasHead(ws: Workspace, cwd: string): Promise<boolean> {
  return (await git(ws, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, cwd)).code === 0;
}

async function currentBranch(ws: Workspace, cwd: string): Promise<string | undefined> {
  const r = await git(ws, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, cwd);
  return r.code === 0 ? r.text.trim() || undefined : undefined;
}

async function mergeBase(ws: Workspace, base: string, cwd: string): Promise<string | null> {
  const r = await git(ws, ['merge-base', base, 'HEAD'], undefined, cwd);
  return r.code === 0 ? r.text.trim() || null : null;
}

/** The working tree against HEAD, untracked files included. `head` false means an empty repository. */
async function workingChanges(ws: Workspace, head: boolean, cwd: string): Promise<Listing> {
  const st = await git(ws, ['status', '--porcelain=v1', '--untracked-files=normal', '--no-renames', '-z'], undefined, cwd);
  if (st.truncated) return { entries: [], truncated: true };
  const entries = parseStatus(st.text);

  let truncated = false;
  if (head) {
    const stats = await git(ws, ['diff', '--no-ext-diff', '--no-renames', '--numstat', '-z', 'HEAD', '--'], undefined, cwd);
    // The list is whole; a cut-off numstat only costs the counts, so say the answer is partial
    // rather than pretending every file changed by nothing.
    if (stats.truncated) truncated = true;
    else applyNumstat(entries, stats.text);
  }
  await statUntracked(ws, entries, cwd);
  return { entries: sortEntries(entries), truncated };
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
  if (names.truncated) return { entries: [], truncated: true };
  const entries = parseNameStatus(names.text);

  const stats = await git(ws, ['diff', '--no-ext-diff', '--no-renames', '--numstat', '-z', mb, ...target, '--'], undefined, cwd);
  let truncated = stats.truncated;
  if (!truncated) applyNumstat(entries, stats.text);

  // A committed comparison is two commits and has no working-tree files. `branch` also shows what
  // is not committed yet, and an untracked file is invisible to `git diff <merge-base>`.
  if (mode === 'branch') {
    const st = await git(ws, ['status', '--porcelain=v1', '--untracked-files=normal', '--no-renames', '-z'], undefined, cwd);
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
  const root = await repoRoot(ws);
  if (!root) {
    return { ok: false, reason: 'not-git', text: 'This directory is not in a git repository.' };
  }
  const branches = await listBranches(ws, root);
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
  if (tree.truncated || tree.code !== 0) return null;
  const rec = tree.text.split('\0')[0] ?? '';
  const tab = rec.indexOf('\t');
  if (tab < 0) return null;
  const meta = rec.slice(0, tab).split(' ');
  const oid = meta[2];
  if (!oid || meta[1] !== 'blob') return null;
  const blob = await git(ws, ['cat-file', 'blob', oid], MAX_SIDE_BYTES + 1, cwd);
  if (blob.truncated) return { content: Buffer.alloc(0), tooLarge: true };
  return blob.code === 0 ? { content: blob.output, tooLarge: false } : null;
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
    const abs = joinAbs(root, path);
    const st = await ws.stat(abs);
    if (st.exists && st.dir) throw new Error('directory');
    if (st.exists && (st.size ?? 0) > MAX_SIDE_BYTES) tooLarge = true;
    else if (st.exists) modified = await ws.readFile(abs, MAX_SIDE_BYTES);
  }
  return { original, modified, tooLarge };
}

/**
 * The whole change list for one comparison.
 *
 * `not-git` is answered for a directory that is not inside a repository; everything else that stops
 * a read is `error` with a sentence that names what failed, because "no changes" and "git could not
 * tell" must not look alike in a window a person is using to decide whether work is done.
 */
export async function gitStatus(ws: Workspace, mode: GitMode, base?: string): Promise<GitStatusResult> {
  const prepared = await prepare(ws, mode, base);
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
 * repository with no commits) has nothing on the old side, so `--no-index` against /dev/null is
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
 * One file's two whole sides and its unified diff.
 *
 * `path` is checked against the change list for this exact comparison before anything reads it, and
 * it is then placed only after `--` in every command. A path the list did not name cannot be read
 * through this function even if a request invents one.
 */
export async function gitFile(
  ws: Workspace,
  mode: GitMode,
  base: string | undefined,
  path: string
): Promise<GitFileResult> {
  const prepared = await prepare(ws, mode, base);
  if (!prepared.ok) return { ok: false, text: prepared.text };
  if (prepared.listing.truncated) {
    return { ok: false, text: 'This repository has too many changes to list, so one file cannot be shown.' };
  }
  const entry = prepared.listing.entries.find((e) => e.path === path);
  if (!entry) return { ok: false, text: 'That file is not one of the changes shown.' };
  if (path.endsWith('/')) return { ok: false, text: 'That is a directory, not a file.' };
  // The numstat already said there is no text to show; reading a binary file just to prove it
  // again is the one thing this route would spend a megabyte on.
  if (entry.binary) return noText(path, entry, { binary: true });

  let original: Buffer = Buffer.alloc(0);
  let modified: Buffer = Buffer.alloc(0);
  let tooLarge = false;
  try {
    ({ original, modified, tooLarge } = await sides(ws, prepared.root, prepared.from, prepared.to, path));
  } catch (e) {
    return { ok: false, text: e instanceof Error && e.message === 'directory' ? 'That is a directory, not a file.' : 'Could not read this file.' };
  }

  const binary = hasNul(original) || hasNul(modified);
  if (binary || tooLarge) return noText(path, entry, { ...(binary ? { binary: true as const } : {}), ...(tooLarge ? { tooLarge: true as const } : {}) });

  // Untracked files (and every file in a repository with no commits) have nothing to diff against:
  // `--no-index` is the only form that reports them as additions, with their real lines.
  const patch = await git(ws, diffArgs(prepared.from, prepared.to, entry.untracked, path), MAX_PATCH_BYTES, prepared.root);
  // 1 is `--no-index`'s "the files differ", which is the normal answer here. Anything else is a
  // failed command, and a patch that may be the tail of a bigger one is no patch at all.
  if ((patch.code !== 0 && patch.code !== 1) || patch.truncated) {
    return { ok: true, path, status: entry.status, original: original.toString('utf8'), modified: modified.toString('utf8'), patch: '' };
  }
  return {
    ok: true,
    path,
    status: entry.status,
    original: original.toString('utf8'),
    modified: modified.toString('utf8'),
    patch: patch.text,
  };
}

/** The branches a base may name, plus the current branch and the default base. */
export async function gitBranches(ws: Workspace): Promise<GitBranchesResult> {
  const root = await repoRoot(ws);
  if (!root) return { ok: false, text: 'This directory is not in a git repository.' };
  const branches = await listBranches(ws, root);
  const base = await defaultBase(ws, branches, root);
  const branch = await currentBranch(ws, root);
  return {
    ok: true,
    ...(branch ? { branch } : {}),
    ...(base ? { base } : {}),
    branches,
  };
}

/**
 * The panel the daemon hands the web UI, bound to a conversation's workspace.
 *
 * `workspaceOf` is `ConversationRegistry.workspaceForRef`: it answers which machine the agent runs
 * on and which directory its next session would start in, and it starts nothing. A conversation
 * whose agent is no longer configured has no workspace and gets a sentence, not a throw.
 */
export function buildGitPanel(workspaceOf: (ref: ConversationRef) => Workspace | undefined): GitPanel {
  const workspace = (ref: ConversationRef): Workspace | undefined => workspaceOf(ref);
  return {
    async status(ref, mode, base) {
      const ws = workspace(ref);
      if (!ws) return { ok: false, reason: 'error', text: 'This conversation has no workspace on any machine.' };
      return gitStatus(ws, mode, base);
    },
    async file(ref, mode, base, path) {
      const ws = workspace(ref);
      if (!ws) return { ok: false, text: 'This conversation has no workspace on any machine.' };
      return gitFile(ws, mode, base, path);
    },
    async branches(ref) {
      const ws = workspace(ref);
      if (!ws) return { ok: false, text: 'This conversation has no workspace on any machine.' };
      return gitBranches(ws);
    },
  };
}
