import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import type {
  PlatformAdapter,
  TurnChangeEntry,
  TurnChangeFile,
  TurnChangeFileResult,
  TurnChangeStatusResult,
} from '../platform/adapter.js';
import { DEFAULT_RUN_TIMEOUT_MS, type Workspace, type WorkspaceRunResult } from './workspace.js';

/**
 * What one turn changed in its workspace, for the web UI's page: a snapshot of the work tree
 * before the prompt and one after it, and the diff between the two trees.
 *
 * ── A repository of its own, never the project's ────────────────────────────
 * The snapshots live in `<that machine's home>/.fleetherd/snapshots/<hash of the repo root>`, a
 * git directory created by `git init` for this purpose alone. The project's own `.git` is never
 * written to: an index of ours inside it would race every `git status` the agent runs, and a
 * failed snapshot must be unable to leave the real repository in a state nobody asked for.
 * `GIT_DIR` + `GIT_WORK_TREE` + a per-snapshot `GIT_INDEX_FILE` are the whole coupling: `add -A`
 * reads the work tree (so every `.gitignore` in it applies as usual) and writes objects into our
 * store, and `write-tree` answers a tree id without creating a commit.
 *
 * ── `sh -c`, twice, and why ─────────────────────────────────────────────────
 * `Workspace.run` takes argv and never a shell, which is what keeps a path with a space or a `;`
 * in it from becoming a command. The cost is that `~` is not expanded: argv is handed to exec as
 * written. So the home directory of the machine the agent runs on is read with a FIXED script —
 * `printf %s "${HOME:-}"` — and a temporary index is removed with `rm -f -- "$1"`, the dynamic
 * part passed as a positional argument rather than spliced into the script. The alternative, one
 * interpolated command string per call, is the thing that rule exists to prevent. A machine with
 * no `sh` (Windows) simply gets no turn changes: the snapshot is skipped and the turn goes on.
 *
 * ── Bounded, always ─────────────────────────────────────────────────────────
 * The start snapshot sits between the person's message and the agent reading it, so it has
 * `SNAPSHOT_START_TIMEOUT_MS` and gives up: a turn whose snapshot failed or was too slow is a
 * turn with no entry, never a turn held behind git. The end snapshot is taken after the turn has
 * already been flushed and reported, and nothing waits on it.
 *
 * ── Two turns in one directory ──────────────────────────────────────────────
 * The diff of a turn is "the work tree before the prompt" against "the work tree after it". When
 * two topics of this page work in the SAME directory at the same time, each one's diff therefore
 * contains the other's edits too. This is not solved here — separating them would need a barrier
 * across agents — and the web UI's README says so where a reader will meet it.
 *
 * ── What is kept, and what is thrown away ───────────────────────────────────
 * Each conversation keeps its last KEEP_TURNS records in `<configDir>/turn-changes.json`; the git
 * objects are kept alive by refs (`refs/turns/<conversation>/<turn>/{start,end}`), because a tree
 * id in a JSON file is not reachability and a `gc` would otherwise delete what those records
 * point at. Dropping a record deletes its refs, and a periodic `git gc --prune=<a day ago>`
 * collects the objects. The date rather than `--prune=now` on purpose: a concurrent snapshot has
 * loose objects written but not yet in a tree, and `now` would delete them between `add` and
 * `write-tree`.
 */

/** The start snapshot's budget, the whole of it — see the header. */
export const SNAPSHOT_START_TIMEOUT_MS = 3_000;
/** How many turns of one conversation keep their trees. */
export const KEEP_TURNS = 50;
/** The file under `configDir()` the records live in. */
export const TURN_CHANGES_FILE = 'turn-changes.json';

/** A file's contents past this are not read back for the diff window — the flags say so instead. */
const FILE_MAX_BYTES = 256 << 10;
/** A unified diff past this is not sent either; the window shows the flags rather than half a patch. */
const PATCH_MAX_BYTES = 512 << 10;
/** The end snapshot is off the turn, so it may take its time — but not forever. */
const END_TIMEOUT_MS = DEFAULT_RUN_TIMEOUT_MS;
/** Most files one answer lists; past it the answer says it is truncated. */
const MAX_FILES = 2_000;
/** How much `git diff` output is read before it is cut (the tail is kept, as everywhere here). */
const DIFF_MAX_BYTES = 8 << 20;
/** `gc` runs after this many finished snapshots in one repository, at most once an hour. */
const GC_EVERY = 20;
const GC_MIN_GAP_MS = 60 * 60 * 1000;
/** Objects younger than this survive a gc — see the header for why not `now`. */
const GC_PRUNE = '1.day.ago';

/** One finished turn, as the file keeps it. Small on purpose: the counts, not the file list. */
interface TurnRecord {
  turn: number;
  at: number;
  /** The repository root on the machine the agent runs on (absolute there). */
  root: string;
  /** The snapshot repository's git directory on that machine. */
  gitDir: string;
  /** `local`, or the host id — for the log and for a person reading the file. */
  host: string;
  branch?: string;
  startTree: string;
  endTree: string;
  files: number;
  additions: number;
  deletions: number;
  truncated?: true;
}

interface State {
  v: 1;
  conversations: Record<string, { turns: TurnRecord[] }>;
}

/** One turn's start snapshot, handed back to the turn so it can take the end one later. */
export interface TurnChangesHandle {
  id: string;
  ref: ConversationRef;
  ws: Workspace;
  platform: PlatformAdapter;
  address: ConversationAddress;
  startTree: string;
  root: string;
  gitDir: string;
  branch?: string;
}

export interface TurnChangesOptions {
  /** `<configDir()>` — where the records are written. */
  dir: string;
  clock: { now(): number };
  /** The conversation's machine and directory, as every workspace window reaches it. */
  workspaceFor(ref: ConversationRef): Workspace | undefined;
  log?: (line: string) => void;
  /** Tests only: override the budgets below so a suite need not wait seconds for them. */
  startTimeoutMs?: number;
  keepTurns?: number;
}

/** One resolved repository: where its work tree is, and where our snapshots of it live. */
interface Repo {
  root: string;
  gitDir: string;
}

export class TurnChanges {
  private readonly store: string;
  private readonly state: State = { v: 1, conversations: {} };
  /** Serialises the writes: two turns ending together must not rename over each other's file. */
  private writing: Promise<void> = Promise.resolve();
  /** gc bookkeeping per snapshot repository, this process's lifetime only. */
  private readonly gcSeen = new Map<string, { count: number; at: number }>();
  /** Directories already reported as "not a git work tree", so the log says it once each. */
  private readonly notGit = new Set<string>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: TurnChangesOptions) {
    this.store = path.join(opts.dir, TURN_CHANGES_FILE);
    this.log = opts.log ?? ((line) => console.warn(line));
    this.load();
  }

  /**
   * Snapshot the work tree, before the prompt. Undefined — the turn is skipped — when this
   * conversation has no workspace, its directory is not a git work tree, or the snapshot did not
   * finish within `SNAPSHOT_START_TIMEOUT_MS`. Never throws.
   */
  async start(
    id: string,
    ref: ConversationRef,
    platform: PlatformAdapter,
    address: ConversationAddress
  ): Promise<TurnChangesHandle | undefined> {
    // Only a page can show the result; a chat platform has nowhere to put it and no file route.
    if (typeof platform.attachTurnChanges !== 'function') return undefined;
    try {
      const ws = this.opts.workspaceFor(ref);
      if (!ws) return undefined;
      const deadline = Date.now() + (this.opts.startTimeoutMs ?? SNAPSHOT_START_TIMEOUT_MS);
      const repo = await this.repoOf(ws, deadline);
      if (!repo) return undefined;
      const startTree = await this.treeOf(ws, repo, deadline);
      if (!startTree) {
        // A timeout or a failing git: skipped, said once, and the turn goes on without an entry.
        this.log(`[changes] ${id}: the start snapshot did not finish; no entry for this turn`);
        return undefined;
      }
      const branch = await this.branchOf(ws, repo, deadline);
      return {
        id,
        ref,
        ws,
        platform,
        address,
        startTree,
        root: repo.root,
        gitDir: repo.gitDir,
        ...(branch ? { branch } : {}),
      };
    } catch (e) {
      this.log(`[changes] ${id}: no start snapshot (${reasonOf(e)})`);
      return undefined;
    }
  }

  /**
   * Take the end snapshot, record the turn and tell the page — in the background, after the turn
   * has been reported. Nothing awaits this and nothing it does can fail a turn.
   */
  finish(handle: TurnChangesHandle): void {
    void this.settle(handle).catch((e) => {
      this.log(`[changes] ${handle.id}: end snapshot failed (${reasonOf(e)})`);
    });
  }

  /** One turn's change list, for the git window's status tab. */
  async status(id: string, ref: ConversationRef, turn: number): Promise<TurnChangeStatusResult> {
    const record = this.record(id, turn);
    if (!record) return { ok: false, reason: 'error', text: `no changes were recorded for turn ${turn}` };
    const ws = this.opts.workspaceFor(ref);
    if (!ws) return { ok: false, reason: 'error', text: 'this conversation has no agent to reach its files' };
    const diff = await this.diffOf(ws, record);
    if (!diff) return { ok: false, reason: 'error', text: 'the repository is no longer reachable on that machine' };
    return {
      ok: true,
      repo: { root: record.root, ...(record.branch ? { branch: record.branch } : {}), base: record.startTree },
      files: diff.files,
      ...(diff.truncated ? { truncated: true as const } : {}),
    };
  }

  /** One changed file of one turn: both sides whole (for a code view) and the unified diff. */
  async file(id: string, ref: ConversationRef, turn: number, rel: string): Promise<TurnChangeFileResult> {
    const record = this.record(id, turn);
    if (!record) return { ok: false, text: `no changes were recorded for turn ${turn}` };
    const ws = this.opts.workspaceFor(ref);
    if (!ws) return { ok: false, text: 'this conversation has no agent to reach its files' };
    const diff = await this.diffOf(ws, record);
    if (!diff) return { ok: false, text: 'the repository is no longer reachable on that machine' };
    const entry = diff.files.find((f) => f.path === rel);
    if (!entry) return { ok: false, text: `${rel} did not change in that turn` };
    const answer: TurnChangeFileResult = {
      ok: true,
      path: entry.path,
      status: entry.status,
      original: '',
      modified: '',
      patch: '',
    };
    if (entry.binary) return { ...answer, binary: true as const };
    const env = { GIT_DIR: record.gitDir };
    const before = entry.status === 'added' ? { text: '' } : await this.blobOf(ws, env, record.startTree, rel);
    const after = entry.status === 'deleted' ? { text: '' } : await this.blobOf(ws, env, record.endTree, rel);
    if (before.tooLarge || after.tooLarge) return { ...answer, tooLarge: true as const };
    const patch = await this.patchOf(ws, env, record, rel);
    if (patch === undefined) return { ...answer, tooLarge: true as const };
    return { ...answer, original: before.text ?? '', modified: after.text ?? '', patch };
  }

  // ── The turn's two snapshots ───────────────────────────────────────────────

  private async settle(handle: TurnChangesHandle): Promise<void> {
    const repo: Repo = { root: handle.root, gitDir: handle.gitDir };
    const endTree = await this.treeOf(handle.ws, repo, Date.now() + END_TIMEOUT_MS);
    if (!endTree) {
      this.log(`[changes] ${handle.id}: the end snapshot did not finish; this turn is not recorded`);
      return;
    }
    const diff = await this.diffOf(handle.ws, {
      startTree: handle.startTree,
      endTree,
      gitDir: handle.gitDir,
    });
    if (!diff) return;
    const turns = (this.state.conversations[handle.id] ??= { turns: [] });
    const turn = (turns.turns[turns.turns.length - 1]?.turn ?? 0) + 1;
    const additions = diff.files.reduce((n, f) => n + f.additions, 0);
    const deletions = diff.files.reduce((n, f) => n + f.deletions, 0);
    const record: TurnRecord = {
      turn,
      at: this.opts.clock.now(),
      root: handle.root,
      gitDir: handle.gitDir,
      host: handle.ws.host,
      ...(handle.branch ? { branch: handle.branch } : {}),
      startTree: handle.startTree,
      endTree,
      files: diff.files.length,
      additions,
      deletions,
      ...(diff.truncated ? { truncated: true as const } : {}),
    };
    turns.turns.push(record);
    this.keepRefs(handle.ws, handle.id, record);
    this.dropOld(handle.ws, handle.id);
    await this.save();
    this.attach(handle, {
      turn,
      files: record.files,
      additions,
      deletions,
      ...(record.truncated ? { truncated: true as const } : {}),
    });
    this.maybeGc(handle.ws, handle.gitDir);
  }

  /** Where this work tree's snapshots live, or undefined when the directory is not a git tree. */
  private async repoOf(ws: Workspace, deadline: number): Promise<Repo | undefined> {
    const top = await git(ws, ['rev-parse', '--show-toplevel'], { timeoutMs: left(deadline) });
    const root = top?.code === 0 ? top.output.toString('utf8').trim().split('\n').pop()?.trim() : '';
    if (!root) {
      if (!this.notGit.has(ws.root)) {
        this.notGit.add(ws.root);
        console.log(`[changes] not a git work tree, so no turn changes here: ${ws.root}`);
      }
      return undefined;
    }
    const home = await shell(ws, 'printf %s "${HOME:-}"', [], left(deadline));
    const dir = home?.code === 0 ? home.output.toString('utf8').trim() : '';
    if (!dir) {
      this.log(`[changes] cannot read $HOME on ${ws.host}; no turn changes for ${ws.root}`);
      return undefined;
    }
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const gitDir = `${dir}/.fleetherd/snapshots/${hash}/.git`;
    // Idempotent, and cheap next to `add -A`; re-running it is what makes a wiped snapshot
    // directory recover without a daemon restart.
    const init = await git(ws, ['init', '-q', `${dir}/.fleetherd/snapshots/${hash}`], {
      cwd: ws.root,
      timeoutMs: left(deadline),
    });
    if (!init || init.code !== 0) return undefined;
    return { root, gitDir };
  }

  /** `add -A` + `write-tree` against a throwaway index; the tree id, or undefined. */
  private async treeOf(ws: Workspace, repo: Repo, deadline: number): Promise<string | undefined> {
    if (left(deadline) <= 0) return undefined;
    // Per snapshot, so two turns of two topics in one directory cannot fight over an index.
    const index = `${path.dirname(repo.gitDir)}/index-${randomUUID()}`;
    const env = { GIT_DIR: repo.gitDir, GIT_WORK_TREE: repo.root, GIT_INDEX_FILE: index };
    try {
      const add = await git(ws, ['add', '-A'], { cwd: repo.root, env, timeoutMs: left(deadline) });
      if (!add || add.code !== 0) return undefined;
      const tree = await git(ws, ['write-tree'], { cwd: repo.root, env, timeoutMs: left(deadline) });
      const id = tree?.code === 0 ? tree.output.toString('utf8').trim() : '';
      return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id) ? id : undefined;
    } finally {
      await shell(ws, 'rm -f -- "$1" "$1.lock"', [index], 5_000);
    }
  }

  private async branchOf(ws: Workspace, repo: Repo, deadline: number): Promise<string | undefined> {
    const r = await git(ws, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      env: { GIT_DIR: repo.gitDir },
      timeoutMs: left(deadline),
    });
    const name = r?.code === 0 ? r.output.toString('utf8').trim() : '';
    // A detached HEAD answers "HEAD", which names no branch; a repository with no commit fails.
    return name && name !== 'HEAD' ? name : undefined;
  }

  // ── Reading the two trees ─────────────────────────────────────────────────

  private async diffOf(
    ws: Workspace,
    t: { startTree: string; endTree: string; gitDir: string }
  ): Promise<{ files: TurnChangeFile[]; truncated: boolean } | undefined> {
    const env = { GIT_DIR: t.gitDir };
    const range = [t.startTree, t.endTree];
    const [numstat, raw] = await Promise.all([
      git(ws, ['diff', '--numstat', '--no-renames', '-z', ...range], { env, maxBytes: DIFF_MAX_BYTES }),
      git(ws, ['diff', '--raw', '--no-renames', '-z', ...range], { env, maxBytes: DIFF_MAX_BYTES }),
    ]);
    if (!numstat || numstat.code !== 0 || !raw || raw.code !== 0) return undefined;
    const counts = parseNumstat(numstat.output.toString('utf8'), numstat.truncated);
    const statuses = parseRaw(raw.output.toString('utf8'), raw.truncated);
    const files: TurnChangeFile[] = [];
    for (const [p, status] of statuses) {
      const n = counts.get(p);
      files.push({
        path: p,
        status,
        additions: n?.additions ?? 0,
        deletions: n?.deletions ?? 0,
        ...(n?.binary ? { binary: true as const } : {}),
      });
    }
    const truncated = numstat.truncated || raw.truncated || files.length > MAX_FILES;
    return { files: files.slice(0, MAX_FILES), truncated };
  }

  /** One side of one file, whole — or that it is too large to be worth sending. */
  private async blobOf(
    ws: Workspace,
    env: Record<string, string>,
    tree: string,
    rel: string
  ): Promise<{ text?: string; tooLarge?: boolean }> {
    const spec = `${tree}:${rel}`;
    const size = await git(ws, ['cat-file', '-s', spec], { env, timeoutMs: END_TIMEOUT_MS });
    if (!size || size.code !== 0) return { text: '' };
    if (Number(size.output.toString('utf8').trim()) > FILE_MAX_BYTES) return { tooLarge: true };
    const out = await git(ws, ['cat-file', '-p', spec], {
      env,
      timeoutMs: END_TIMEOUT_MS,
      maxBytes: FILE_MAX_BYTES,
    });
    if (!out || out.code !== 0) return { text: '' };
    return out.truncated ? { tooLarge: true } : { text: out.output.toString('utf8') };
  }

  /** The unified diff of one file, or undefined when it is too large to send. */
  private async patchOf(
    ws: Workspace,
    env: Record<string, string>,
    record: Pick<TurnRecord, 'startTree' | 'endTree'>,
    rel: string
  ): Promise<string | undefined> {
    const out = await git(
      ws,
      ['diff', '--no-color', '--no-ext-diff', '--no-renames', record.startTree, record.endTree, '--', `:(literal)${rel}`],
      { env, timeoutMs: END_TIMEOUT_MS, maxBytes: PATCH_MAX_BYTES }
    );
    if (!out || out.code !== 0 || out.truncated) return undefined;
    return out.output.toString('utf8');
  }

  // ── Keeping the objects ───────────────────────────────────────────────────

  /** Refs keep the two trees alive: a gc collects trees nobody points at, and our file is not git. */
  private keepRefs(ws: Workspace, id: string, r: TurnRecord): void {
    const head = refHead(id, r);
    const input = `update ${head}/start ${r.startTree}\nupdate ${head}/end ${r.endTree}\n`;
    void git(ws, ['update-ref', '--stdin'], { env: { GIT_DIR: r.gitDir }, stdin: input });
  }

  /** Drop this conversation's oldest turns, records and refs, past KEEP_TURNS. */
  private dropOld(ws: Workspace, id: string): void {
    const keep = this.opts.keepTurns ?? KEEP_TURNS;
    const turns = this.state.conversations[id]?.turns;
    if (!turns || turns.length <= keep) return;
    const gone = turns.splice(0, turns.length - keep);
    const lines = gone.map((r) => `delete ${refHead(id, r)}/start\ndelete ${refHead(id, r)}/end\n`).join('');
    const gitDir = gone[gone.length - 1]?.gitDir;
    if (gitDir) void git(ws, ['update-ref', '--stdin'], { env: { GIT_DIR: gitDir }, stdin: lines });
  }

  private maybeGc(ws: Workspace, gitDir: string): void {
    const seen = this.gcSeen.get(gitDir) ?? { count: 0, at: 0 };
    seen.count += 1;
    const now = Date.now();
    const due = seen.count >= GC_EVERY && now - seen.at >= GC_MIN_GAP_MS;
    if (due) {
      seen.count = 0;
      seen.at = now;
    }
    this.gcSeen.set(gitDir, seen);
    if (!due) return;
    void git(ws, ['gc', `--prune=${GC_PRUNE}`, '--quiet'], {
      env: { GIT_DIR: gitDir },
      timeoutMs: 5 * 60_000,
    }).then((r) => {
      if (!r || r.code !== 0) this.log(`[changes] gc of ${gitDir} did not finish`);
    });
  }

  // ── The records ───────────────────────────────────────────────────────────

  private record(id: string, turn: number): TurnRecord | undefined {
    return this.state.conversations[id]?.turns.find((t) => t.turn === turn);
  }

  private attach(handle: TurnChangesHandle, entry: TurnChangeEntry): void {
    try {
      handle.platform.attachTurnChanges?.(handle.address, entry);
    } catch (e) {
      this.log(`[changes] ${handle.id}: could not attach turn ${entry.turn} to its reply (${reasonOf(e)})`);
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.store, 'utf8')) as Partial<State>;
      if (raw.v !== 1 || !raw.conversations || typeof raw.conversations !== 'object') return;
      for (const [id, value] of Object.entries(raw.conversations)) {
        if (!Array.isArray(value?.turns)) continue;
        this.state.conversations[id] = { turns: value.turns.filter(isRecord) };
      }
    } catch {
      // No file yet, or one we cannot read: every conversation starts with no turns, which is
      // what a fresh install has. Never worth a crash — the same rule topics.ts follows.
    }
  }

  private save(): Promise<void> {
    const body = JSON.stringify(this.state);
    this.writing = this.writing.then(async () => {
      fs.mkdirSync(path.dirname(this.store), { recursive: true });
      const tmp = `${this.store}.tmp`;
      await fs.promises.writeFile(tmp, body, { mode: 0o600 });
      await fs.promises.rename(tmp, this.store);
    });
    // A failed write is logged and the chain continues: the next save may well work, and the
    // alternative is an unhandled rejection per turn.
    this.writing = this.writing.catch((e) => this.log(`[changes] could not write ${this.store}: ${reasonOf(e)}`));
    return this.writing;
  }
}

/** A tree's/objects' identity is all the ref needs; the conversation key may not be a ref name. */
function conversationHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

/**
 * One conversation's refs inside one snapshot repository. Keyed by BOTH: turn numbers restart per
 * conversation, so the repository alone would let topic A's turn 3 overwrite topic B's.
 */
function refHead(id: string, r: Pick<TurnRecord, 'root' | 'turn'>): string {
  return `refs/turns/${conversationHash(`${id}\u0000${r.root}`)}/${r.turn}`;
}

function isRecord(v: unknown): v is TurnRecord {
  const r = v as Partial<TurnRecord> | undefined;
  return (
    typeof r?.turn === 'number' &&
    typeof r.at === 'number' &&
    typeof r.root === 'string' &&
    typeof r.gitDir === 'string' &&
    typeof r.startTree === 'string' &&
    typeof r.endTree === 'string' &&
    typeof r.files === 'number' &&
    typeof r.additions === 'number' &&
    typeof r.deletions === 'number'
  );
}

/** `git diff --numstat -z`: `additions\tdeletions\tpath\0`, `-` for a binary file. */
function parseNumstat(out: string, truncated: boolean): Map<string, { additions: number; deletions: number; binary?: true }> {
  const parts = out.split('\0');
  const map = new Map<string, { additions: number; deletions: number; binary?: true }>();
  // A truncated read keeps the END, so the first fragment may be half a record.
  for (let i = truncated ? 1 : 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    const first = line.indexOf('\t');
    const second = line.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const p = line.slice(second + 1);
    if (!p) continue;
    const a = line.slice(0, first);
    const d = line.slice(first + 1, second);
    map.set(p, a === '-' || d === '-' ? { additions: 0, deletions: 0, binary: true } : { additions: Number(a) || 0, deletions: Number(d) || 0 });
  }
  return map;
}

/** `git diff --raw -z`: `:<modes and shas> <letter>\0path\0`. */
function parseRaw(out: string, truncated: boolean): Map<string, TurnChangeFile['status']> {
  const parts = out.split('\0');
  const map = new Map<string, TurnChangeFile['status']>();
  // A truncated read keeps the END, so the head may be half a record: start at the first field
  // that really is a metadata record (`:`), then step a pair at a time.
  let start = 0;
  if (truncated) while (start < parts.length && !parts[start]?.startsWith(':')) start++;
  for (let i = start; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    const p = parts[i + 1];
    if (!meta || !p) continue;
    const letter = meta.trim().split(' ').pop();
    // `--no-renames` leaves A, D, M and T (a type change: a symlink became a file, say).
    map.set(p, letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified');
  }
  return map;
}

/** How much of a deadline is left, at least a moment — a negative timeout would mean "none". */
function left(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `git`, with the link's failures turned into "no answer" rather than a rejected turn. */
async function git(
  ws: Workspace,
  argv: string[],
  o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxBytes?: number; stdin?: string } = {}
): Promise<WorkspaceRunResult | undefined> {
  try {
    return await ws.run(['git', ...argv], o);
  } catch {
    return undefined;
  }
}

/**
 * A fixed script run through `sh -c`, its dynamic half passed as positional arguments.
 *
 * The only two uses are reading `$HOME` and unlinking a temporary index (see the header). Nothing
 * a person or an agent typed ever lands in the script text: the arguments after `fleetherd` are
 * `$1`, `$2`, …, and the script itself is a constant.
 */
async function shell(
  ws: Workspace,
  script: string,
  args: string[],
  timeoutMs: number
): Promise<WorkspaceRunResult | undefined> {
  try {
    return await ws.run(['sh', '-c', script, 'fleetherd', ...args], { timeoutMs });
  } catch {
    return undefined;
  }
}
