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
import type { MessageRef } from '../types.js';
import { DEFAULT_RUN_TIMEOUT_MS, type Workspace, type WorkspaceRunResult, type WorkspaceStat } from './workspace.js';

/**
 * What one turn changed in its workspace, for the web UI's page: a snapshot of the work tree
 * before the prompt and one after it, and the diff between the two trees.
 *
 * ── A repository of its own, never the project's ────────────────────────────
 * The snapshots live in `<that machine's home>/.fleetherd/snapshots/<hash of the repo root>`, a
 * git directory created by `git init` for this purpose alone. The project's own `.git` is never
 * written to: an index of ours inside it would race every `git status` the agent runs, and a
 * failed snapshot must be unable to leave the real repository in a state nobody asked for.
 * `GIT_DIR` + `GIT_WORK_TREE` + a `GIT_INDEX_FILE` of our own are the whole coupling: `add -A`
 * reads the work tree (with `.gitignore` deciding what it takes, minus git's own exception: a
 * file the index has already recorded stays in it even if it is ignored later) and writes objects
 * into our store, and `write-tree` answers a tree id without creating a commit. When the work tree is an
 * ancestor of that store (`$HOME` itself, say), the store's own path is written into its
 * `info/exclude` first: otherwise `git add` refuses the nested repository.
 *
 * ── `sh -c`, for three fixed scripts ────────────────────────────────────────
 * `Workspace.run` takes argv and never a shell, which is what keeps a path with a space or a `;`
 * in it from becoming a command. The cost is that `~` is not expanded: argv is handed to exec as
 * written. So the home directory of the machine the agent runs on is read with a FIXED script —
 * `printf %s "${HOME:-}"` — and a file is removed, or the exclude line written, with a fixed
 * script whose dynamic parts are positional arguments, never spliced into the text. The
 * alternative, one interpolated command string per call, is the thing that rule exists to
 * prevent. A machine with no `sh` (Windows) simply gets no turn changes: the snapshot is skipped
 * and the turn goes on.
 *
 * ── Bounded, always ─────────────────────────────────────────────────────────
 * The start snapshot sits between the person's message and the agent reading it. Its git commands
 * carry a timeout, and `start` races the WHOLE of it against `SNAPSHOT_START_TIMEOUT_MS` as well:
 * a remote host that has gone away leaves `ws.run` waiting for a reconnect that may never come,
 * and no per-command timeout is carried across that link. When the race is lost the turn goes on
 * with no entry, and that directory is remembered as too slow for `SLOW_REPO_MS` so the next
 * turns do not each pay the same wait. The end snapshot is taken after the turn has been flushed
 * and reported, and nothing waits on it.
 *
 * ── Which reply, and which number ───────────────────────────────────────────
 * A turn takes its number when it ends — synchronously, in `finish` — so two turns that end close
 * together cannot swap numbers, and a slow snapshot cannot make a later turn's reply show an
 * earlier turn's diff. The reply it hangs off is the message this turn last posted, captured by
 * the runner at turn end and carried in the handle; "the last message in the topic" would be the
 * NEXT turn's reply whenever this turn's ending snapshot was slower than that turn.
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
 * point at. Dropping a record deletes its refs — through the snapshot repository that record
 * names, which is not necessarily the newest one's — and a periodic `git gc --prune=<a day ago>`
 * collects the objects. The date rather than `--prune=now` on purpose: a concurrent snapshot has
 * loose objects written but not yet in a tree, and `now` would delete them between `add` and
 * `write-tree`. A topic deleted from the page forgets its records and their refs at once.
 */

/** The start snapshot's budget, the whole of it — see the header. */
export const SNAPSHOT_START_TIMEOUT_MS = 3_000;
/** How many turns of one conversation keep their trees. */
export const KEEP_TURNS = 50;
/** The file under `configDir()` the records live in. */
export const TURN_CHANGES_FILE = 'turn-changes.json';
/** After a snapshot that failed or ran out of time, its directory is left alone this long. */
const SLOW_REPO_MS = 10 * 60_000;

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
/** How many turns' diffs are cached. The trees never change, so a hit is always right. */
const DIFF_CACHE = 64;
/**
 * What a queued snapshot needs left to be worth starting: one stat (the stale-lock check) and the
 * start of an `add`. Below it the add would be killed at the deadline, "no answer" would be read
 * as a slow repository, and a directory that was merely busy would lose its entries for ten
 * minutes — the very thing the busy/slow split exists to prevent.
 */
const MIN_QUEUED_BUDGET_MS = 500;

/**
 * An `index.lock` older than this belongs to nobody: a `git add` we killed at the deadline leaves
 * one behind (SIGKILL runs no cleanup), and without this every later snapshot would fall back to a
 * temporary index — a full scan — for ever.
 */
const STALE_LOCK_MS = 5 * 60_000;
/** `gc` runs after this many finished snapshots in one repository, at most once an hour. */
const GC_EVERY = 20;
const GC_MIN_GAP_MS = 60 * 60 * 1000;
/** Objects younger than this survive a gc — see the header for why not `now`. */
const GC_PRUNE = '1.day.ago';
/** `rm -f -- "$1" "$1.lock"`: the dynamic half is a positional argument, never part of the text. */
const RM_SCRIPT = 'rm -f -- "$1" "$1.lock"';

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
  /**
   * The message this turn last posted, as the runner captured it at turn end. The entry is hung
   * off exactly this one — see the header for why not "the last message in the topic".
   */
  reply?: MessageRef;
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
  /** Tests only: the floor below, so a test can leave room for a slow machine on both sides of it. */
  minQueuedBudgetMs?: number;
  keepTurns?: number;
}

/** One resolved repository: where its work tree is, and where our snapshots of it live. */
interface Repo {
  root: string;
  gitDir: string;
}

/**
 * What one `add -A` + `write-tree` said.
 *
 * `answered` is false when git never got to speak — a timeout, a dead link, a child killed at the
 * deadline. That is not the same as a failure it reported: there is nothing to repair and nothing
 * a second run can do, so it must not be read as "the index is broken".
 */
interface TreeAttempt {
  tree?: string;
  locked: boolean;
  answered: boolean;
}

/**
 * One snapshot attempt: the tree, or why there is none.
 *
 * `slow` is the caller's cue to leave the directory alone for a while. A held index is NOT slow —
 * another turn of the same repository is simply using it, which is the documented normal case of
 * two topics sharing a directory; treating it as slow would cost that directory every entry for
 * ten minutes.
 */
interface TreeResult {
  tree?: string;
  slow: boolean;
}

interface Diff {
  files: TurnChangeFile[];
  truncated: boolean;
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
  /** Directories whose snapshots failed or timed out recently, and until when — see SLOW_REPO_MS. */
  private readonly slow = new Map<string, number>();
  /** The next turn number per conversation, so it is taken at turn end rather than after a diff. */
  private readonly numbering = new Map<string, number>();
  /** One snapshot at a time per snapshot repository — see `treeOf`. */
  private readonly treeChains = new Map<string, Promise<void>>();
  /** One `git init` at a time per snapshot directory — see `initSnapshot`. */
  private readonly initChains = new Map<string, Promise<void>>();
  /** How many snapshots are queued or running per repository — see `treeOf`'s budget floor. */
  private readonly treeBusy = new Map<string, number>();
  /** Conversations whose topic the page dropped; an end snapshot still running must not revive them. */
  private readonly forgotten = new Set<string>();
  /**
   * Turns that have a start snapshot and have not settled yet, per conversation. What keeps a
   * `forgotten` mark alive exactly as long as something can still act on it: the mark is dropped
   * when the last of them lands, so this set holds only conversations with work in flight.
   */
  private readonly openHandles = new Map<string, number>();
  /** Diffs already computed, by `<git dir>\0<start tree>\0<end tree>` — the trees never change. */
  private readonly diffs = new Map<string, Diff>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: TurnChangesOptions) {
    this.store = path.join(opts.dir, TURN_CHANGES_FILE);
    this.log = opts.log ?? ((line) => console.warn(line));
    this.load();
  }

  /**
   * Snapshot the work tree, before the prompt. Undefined — the turn is skipped — when this
   * conversation has no workspace, its directory is not a git work tree, the snapshot did not
   * finish within `SNAPSHOT_START_TIMEOUT_MS`, or an earlier one in the same directory did not.
   * Never throws, and never leaves the caller waiting on a machine that went away.
   */
  async start(
    id: string,
    ref: ConversationRef,
    platform: PlatformAdapter,
    address: ConversationAddress
  ): Promise<TurnChangesHandle | undefined> {
    // Only a page can show the result; a chat platform has nowhere to put it and no file route.
    if (typeof platform.attachTurnChanges !== 'function') return undefined;
    const ws = this.opts.workspaceFor(ref);
    if (!ws) return undefined;
    const key = `${ws.host}\u0000${ws.root}`;
    if ((this.slow.get(key) ?? 0) > Date.now()) return undefined;
    const budget = this.opts.startTimeoutMs ?? SNAPSHOT_START_TIMEOUT_MS;
    let timedOut = false;
    const work = this.begin(id, ref, platform, address, ws, key).catch((e) => {
      this.log(`[changes] ${id}: no start snapshot (${reasonOf(e)})`);
      return undefined;
    });
    const handle = await withinDeadline(work, budget, () => {
      timedOut = true;
    });
    if (handle) {
      this.slow.delete(key);
      this.openHandles.set(id, (this.openHandles.get(id) ?? 0) + 1);
      return handle;
    }
    if (timedOut) {
      this.markSlow(key);
      this.log(`[changes] ${id}: the start snapshot took over ${budget} ms; no entry this turn`);
    }
    return undefined;
  }

  /**
   * Take the end snapshot, record the turn and tell the page — in the background, after the turn
   * has been reported. The turn's NUMBER is taken here, synchronously, so it follows the order the
   * turns ended in even when their snapshots finish out of order.
   */
  finish(handle: TurnChangesHandle): void {
    const turn = this.takeNumber(handle.id);
    const done = (): void => this.closeHandle(handle.id);
    void this.settle(handle, turn)
      .catch((e) => {
        this.log(`[changes] ${handle.id}: end snapshot failed (${reasonOf(e)})`);
      })
      .then(done, done);
  }

  /**
   * One turn's work is over. The last one to land takes the conversation's `forgotten` mark with
   * it: from then on nothing can write a record back, and a set that only ever grew would keep
   * ids around for the life of the process.
   */
  private closeHandle(id: string): void {
    const left = (this.openHandles.get(id) ?? 1) - 1;
    if (left > 0) {
      this.openHandles.set(id, left);
      return;
    }
    this.openHandles.delete(id);
    this.forgotten.delete(id);
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

  /**
   * Forget one conversation's records — the page deleted its topic. The refs go too, through the
   * snapshot repository each record names, so the trees become collectable. Best-effort: the file
   * is what the page reads, and it is already forgotten by the time this returns.
   */
  forget(id: string, ref: ConversationRef): void {
    // Marked even when there is nothing to drop yet: an end snapshot may be in flight, and it
    // must not put the conversation back.
    // Only while something can still act on it: a turn that already started will settle later
    // and must not write the record back, while with nothing in flight the mark has no reader.
    if ((this.openHandles.get(id) ?? 0) > 0) this.forgotten.add(id);
    const turns = this.state.conversations[id]?.turns;
    if (!turns) {
      this.clearMarkIfIdle(id);
      return;
    }
    delete this.state.conversations[id];
    this.numbering.delete(id);
    void this.save();
    if (turns.length === 0) return;
    const ws = this.opts.workspaceFor(ref);
    if (!ws) {
      this.log(`[changes] ${id}: forgot its records, but has no workspace to release their refs`);
      return;
    }
    for (const [gitDir, list] of byGitDir(turns)) {
      void this.releaseRefs(ws, gitDir, id, list, 'dropped topic');
    }
    this.clearMarkIfIdle(id);
  }

  /** Drop a `forgotten` mark once no started turn is left that could act on it. */
  private clearMarkIfIdle(id: string): void {
    if ((this.openHandles.get(id) ?? 0) === 0) this.forgotten.delete(id);
  }

  // ── The turn's two snapshots ───────────────────────────────────────────────

  /** Everything `start` waits for, and the half a hard deadline may abandon. */
  private async begin(
    id: string,
    ref: ConversationRef,
    platform: PlatformAdapter,
    address: ConversationAddress,
    ws: Workspace,
    key: string
  ): Promise<TurnChangesHandle | undefined> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? SNAPSHOT_START_TIMEOUT_MS);
    const repo = await this.repoOf(ws, deadline);
    if (!repo) return undefined;
    const start = await this.treeOf(ws, repo, deadline);
    if (!start.tree) {
      // "Slow" (no answer, or git reporting a failure) is remembered; a directory that was merely
      // busy taking its turn elsewhere is not — see TreeResult.
      if (start.slow) this.markSlow(key);
      this.log(`[changes] ${id}: no start snapshot (${start.slow ? 'the directory is not answering' : 'busy'}); no entry this turn`);
      return undefined;
    }
    return { id, ref, ws, platform, address, startTree: start.tree, root: repo.root, gitDir: repo.gitDir };
  }

  private async settle(handle: TurnChangesHandle, turn: number): Promise<void> {
    const repo: Repo = { root: handle.root, gitDir: handle.gitDir };
    const end = await this.treeOf(handle.ws, repo, Date.now() + END_TIMEOUT_MS);
    const endTree = end.tree;
    if (!endTree) {
      this.log(`[changes] ${handle.id}: the end snapshot failed; turn ${turn} is not recorded`);
      return;
    }
    // Read at the end, from the PROJECT's repository: at the start the budget is spent, and our
    // snapshot repository's HEAD would name the wrong branch (and its own, at that).
    const branch = await this.branchOf(handle.ws, repo, Date.now() + END_TIMEOUT_MS);
    const diff = await this.diffOf(handle.ws, { startTree: handle.startTree, endTree, gitDir: handle.gitDir });
    if (!diff) {
      this.log(`[changes] ${handle.id}: could not diff the two trees of turn ${turn}`);
      return;
    }
    // The topic went while this snapshot was running: its records were forgotten on purpose, and
    // writing this one back would recreate them (and their refs) for a page that no longer has it.
    if (this.forgotten.has(handle.id)) {
      this.log(`[changes] ${handle.id}: turn ${turn} finished after its topic was dropped; not recorded`);
      return;
    }
    const additions = diff.files.reduce((n, f) => n + f.additions, 0);
    const deletions = diff.files.reduce((n, f) => n + f.deletions, 0);
    const record: TurnRecord = {
      turn,
      at: this.opts.clock.now(),
      root: handle.root,
      gitDir: handle.gitDir,
      host: handle.ws.host,
      ...(branch ? { branch } : {}),
      startTree: handle.startTree,
      endTree,
      files: diff.files.length,
      additions,
      deletions,
      ...(diff.truncated ? { truncated: true as const } : {}),
    };
    const turns = (this.state.conversations[handle.id] ??= { turns: [] });
    // Kept in turn order even though the snapshots finish in their own: a slow one must not look
    // like a later turn.
    const at = turns.turns.findIndex((t) => t.turn > turn);
    turns.turns.splice(at < 0 ? turns.turns.length : at, 0, record);
    this.keepRefs(handle.ws, handle.id, record);
    this.dropOld(handle.ws, handle.id);
    await this.save();
    // A turn that changed nothing has nothing to open; its record still keeps the numbering.
    if (record.files > 0) {
      this.attach(handle, {
        turn,
        files: record.files,
        additions,
        deletions,
        ...(record.truncated ? { truncated: true as const } : {}),
      });
    }
    this.maybeGc(handle.ws, handle.gitDir);
  }

  /** Where this work tree's snapshots live, or undefined when the directory is not a git tree. */
  private async repoOf(ws: Workspace, deadline: number): Promise<Repo | undefined> {
    const top = await git(ws, ['rev-parse', '--show-toplevel'], { timeoutMs: left(deadline) });
    const root = top?.code === 0 ? top.output.toString('utf8').trim().split('\n').pop()?.trim() : '';
    if (!root) {
      if (!this.notGit.has(ws.root)) {
        this.notGit.add(ws.root);
        this.log(`[changes] not a git work tree, so no turn changes here: ${ws.root}`);
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
    const snapDir = `${dir}/.fleetherd/snapshots/${hash}`;
    const gitDir = `${snapDir}/.git`;
    // Idempotent, and cheap next to `add -A`; re-running it is what makes a wiped snapshot
    // directory recover without a daemon restart. One at a time, though: see `initSnapshot`.
    const init = await this.initSnapshot(ws, root, snapDir, deadline);
    if (!init || init.code !== 0) {
      this.log(`[changes] could not prepare ${snapDir} (${init ? lastLine(init.stderr) ?? `exit ${init.code}` : 'no answer'}); no turn changes for ${root}`);
      return undefined;
    }
    // A work tree that CONTAINS the snapshot repository (`$HOME` as the project root, or a
    // `.fleetherd` somebody keeps inside a checkout) cannot be added to it: git sees a nested
    // repository with no commit and refuses the whole add. Our own `info/exclude` — inside our
    // git dir, never the project's — is enough to keep it out.
    const rel = relativeUnder(root, snapDir);
    if (rel && !(await this.excludeSnapDir(ws, gitDir, rel, deadline))) {
      this.log(`[changes] could not keep ${snapDir} out of ${root}; no turn changes there`);
      return undefined;
    }
    return { root, gitDir };
  }

  /**
   * `git init` for one snapshot directory, one at a time.
   *
   * Re-running it is what recovers a wiped snapshot directory, but running it twice AT ONCE on the
   * same directory is not safe: it takes `.git/config`'s lock and copies the template hooks, and
   * the loser fails with "File exists" — which used to drop that turn's snapshot silently
   * (2026-11-19, the release workflow's Test step). Two topics in one directory is the documented
   * normal case (see the header), and their starts reach this together.
   */
  private initSnapshot(ws: Workspace, root: string, snapDir: string, deadline: number): Promise<WorkspaceRunResult | undefined> {
    const previous = this.initChains.get(snapDir) ?? Promise.resolve();
    const run = previous.then(() => git(ws, ['init', '-q', snapDir], { cwd: root, timeoutMs: left(deadline) }));
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.initChains.set(snapDir, settled);
    // Dropped once it is the last one through: a process that has seen many repositories must not
    // keep one promise per snapshot directory for its lifetime.
    void settled.then(() => {
      if (this.initChains.get(snapDir) === settled) this.initChains.delete(snapDir);
    });
    return run;
  }

  /** Keep the snapshot repository out of its own work tree — see `repoOf`. */
  private async excludeSnapDir(ws: Workspace, gitDir: string, rel: string, deadline: number): Promise<boolean> {
    const r = await shell(ws, `mkdir -p "$(dirname "$1")" && printf '%s\\n' "$2" > "$1"`, [`${gitDir}/info/exclude`, `/${rel}/`], left(deadline));
    return r?.code === 0;
  }

  /**
   * `add -A` + `write-tree` for one repository, one at a time.
   *
   * The queue is not an optimisation. `add` releases git's `index.lock` when it returns, and
   * `write-tree` reads the index after that: without a queue, another turn of the same repository
   * could `add` in that gap and have its state written into THIS turn's tree — a wrong diff, not
   * merely a mixed one. Serialising here costs nothing in the ordinary case (one turn at a time)
   * and is what makes the shared index safe to share.
   *
   * One wait in the chain has no timeout of its own: `clearStaleLock`'s stat is an rpc, and the
   * workspace carries no deadline for it. A host that stops answering therefore stalls this
   * repository's queue — every later start answers "busy" (the turn itself is still bounded by
   * the race in `start`) until the link comes back.
   */
  private treeOf(ws: Workspace, repo: Repo, deadline: number): Promise<TreeResult> {
    const key = repo.gitDir;
    // Somebody is already queued or running here — counted until the work is over, not just until
    // it starts, because the wait is what can eat this call's budget.
    const queued = (this.treeBusy.get(key) ?? 0) > 0;
    this.treeBusy.set(key, (this.treeBusy.get(key) ?? 0) + 1);
    const previous = this.treeChains.get(key) ?? Promise.resolve();
    const run = previous.then(() => {
      // A snapshot that waited its turn may have too little budget left to be worth starting: a
      // scan killed mid-`add` reads as "no answer" and would mark a busy directory as slow. Only
      // a call that actually queued is held to the floor; a fresh budget is never this small.
      if (queued && deadline - Date.now() < (this.opts.minQueuedBudgetMs ?? MIN_QUEUED_BUDGET_MS)) return { slow: false };
      if (Date.now() >= deadline) return { slow: false };
      return this.treeOnce(ws, repo, deadline);
    });
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.treeChains.set(key, settled);
    void settled.then(() => this.treeBusy.set(key, Math.max(0, (this.treeBusy.get(key) ?? 1) - 1)));
    return run;
  }

  /**
   * One repository's snapshot, on a shared index when it is free and a temporary one when it is
   * not.
   *
   * The shared index is the difference between 0.04 s and 0.4 s on a 20k-file tree, and the whole
   * point is fitting inside the start budget. Only one process can hold it (git's `index.lock`),
   * so a second turn in the same directory falls back to a temporary index rather than losing its
   * entry — the fallback is slow, not wrong, and the hard deadline still bounds what the turn
   * pays. A shared index that answered with a failure of its own is thrown away, so the next turn
   * rebuilds it instead of failing the same way twice a turn.
   */
  private async treeOnce(ws: Workspace, repo: Repo, deadline: number): Promise<TreeResult> {
    const dir = path.dirname(repo.gitDir);
    const shared = `${dir}/index`;
    await this.clearStaleLock(ws, dir);
    const first = await this.addTree(ws, repo, shared, deadline);
    if (first.tree) return { tree: first.tree, slow: false };
    // No answer at all — a timeout, a dead link, a child killed at the deadline. A second run
    // cannot fix that, and the shared index is not at fault: it was never written.
    if (!first.answered) return { slow: true };
    if (first.locked) {
      // Another turn of this repository holds the index. A full scan on a temporary one, and no
      // "slow" mark: this is the documented case of two topics in one directory, not a bad repo.
      const busy = await this.tempTree(ws, repo, deadline);
      return { tree: busy.tree, slow: false };
    }
    void shell(ws, RM_SCRIPT, [shared], 5_000);
    const second = await this.tempTree(ws, repo, deadline);
    return { tree: second.tree, slow: !second.tree };
  }

  /** A snapshot on an index of its own, removed whatever happens. */
  private async tempTree(ws: Workspace, repo: Repo, deadline: number): Promise<TreeAttempt> {
    const temp = `${path.dirname(repo.gitDir)}/index-${randomUUID()}`;
    try {
      return await this.addTree(ws, repo, temp, deadline);
    } finally {
      // Off the turn's clock: `start` has already stopped waiting for this whole operation (the
      // race in `start`), so the cleanup gets its own small budget instead of the deadline's
      // leftovers — which would be a millisecond and leave the temporary index behind.
      await shell(ws, RM_SCRIPT, [temp], 5_000);
    }
  }

  /** Remove an `index.lock` a killed snapshot left behind — see STALE_LOCK_MS. */
  private async clearStaleLock(ws: Workspace, dir: string): Promise<void> {
    const lock = `${dir}/index.lock`;
    const st = await ws.stat(lock).catch((): WorkspaceStat => ({ exists: false }));
    if (!st.exists || Date.now() - (st.mtimeMs ?? 0) < STALE_LOCK_MS) return;
    await shell(ws, RM_SCRIPT, [lock], 5_000);
  }

  private async addTree(ws: Workspace, repo: Repo, index: string, deadline: number): Promise<TreeAttempt> {
    const env = { GIT_DIR: repo.gitDir, GIT_WORK_TREE: repo.root, GIT_INDEX_FILE: index };
    const add = await git(ws, ['add', '-A'], { cwd: repo.root, env, timeoutMs: left(deadline) });
    if (!add || add.timedOut) return { locked: false, answered: false };
    if (add.code !== 0) {
      const said = `${add.stderr}\n${add.output.toString('utf8')}`;
      if (/index\.lock/.test(said)) return { locked: true, answered: true };
      this.log(`[changes] add failed in ${repo.root}: ${lastLine(said) ?? `exit ${add.code}`}`);
      return { locked: false, answered: true };
    }
    const tree = await git(ws, ['write-tree'], { cwd: repo.root, env, timeoutMs: left(deadline) });
    // A write-tree that timed out leaves a warm, correct index behind: report "no answer", never a
    // failure, so the caller keeps it rather than throwing away a full scan.
    if (!tree || tree.timedOut) return { locked: false, answered: false };
    const id = tree.code === 0 ? tree.output.toString('utf8').trim() : '';
    return { tree: /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id) ? id : undefined, locked: false, answered: true };
  }

  /**
   * The project's current branch, from the project's own repository — no GIT_DIR, so this is the
   * HEAD an operator would see, not our snapshot store's. Detached and unborn HEADs answer
   * nothing, which is the truth: neither names a branch.
   */
  private async branchOf(ws: Workspace, repo: Repo, deadline: number): Promise<string | undefined> {
    const r = await git(ws, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.root, timeoutMs: left(deadline) });
    const name = r?.code === 0 ? r.output.toString('utf8').trim() : '';
    return name && name !== 'HEAD' ? name : undefined;
  }

  // ── Reading the two trees ─────────────────────────────────────────────────

  /** The diff of two trees, computed once. The trees never change, so a cached answer always holds. */
  private async diffOf(
    ws: Workspace,
    t: { startTree: string; endTree: string; gitDir: string }
  ): Promise<Diff | undefined> {
    const key = `${t.gitDir}\u0000${t.startTree}\u0000${t.endTree}`;
    const hit = this.diffs.get(key);
    if (hit) return hit;
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
    for (const [p, st] of statuses) {
      const n = counts.get(p);
      files.push({
        path: p,
        status: st,
        additions: n?.additions ?? 0,
        deletions: n?.deletions ?? 0,
        ...(n?.binary ? { binary: true as const } : {}),
      });
    }
    const value: Diff = {
      files: files.slice(0, MAX_FILES),
      truncated: numstat.truncated || raw.truncated || files.length > MAX_FILES,
    };
    if (this.diffs.size >= DIFF_CACHE) {
      const oldest = this.diffs.keys().next().value;
      if (oldest !== undefined) this.diffs.delete(oldest);
    }
    this.diffs.set(key, value);
    return value;
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
    void this.checkRefs(ws, r.gitDir, input, `turn ${r.turn}`);
  }

  /** Drop this conversation's oldest turns, records and refs, past KEEP_TURNS. */
  private dropOld(ws: Workspace, id: string): void {
    const keep = this.opts.keepTurns ?? KEEP_TURNS;
    const turns = this.state.conversations[id]?.turns;
    if (!turns || turns.length <= keep) return;
    const gone = turns.splice(0, turns.length - keep);
    // Each record names its own snapshot repository: a conversation may have moved between
    // machines or directories, and deleting only through the newest one would leave the rest.
    for (const [gitDir, list] of byGitDir(gone)) {
      void this.releaseRefs(ws, gitDir, id, list, 'older than the kept turns');
    }
  }

  private releaseRefs(ws: Workspace, gitDir: string, id: string, list: TurnRecord[], why: string): Promise<void> {
    const input = list.map((r) => `delete ${refHead(id, r)}/start\ndelete ${refHead(id, r)}/end\n`).join('');
    return this.checkRefs(ws, gitDir, input, why);
  }

  /**
   * `git update-ref --stdin`, with its answer looked at. A dropped result is how a ref gets lost
   * quietly: the JSON keeps naming trees that the next gc then collects, and the entry turns into
   * "the repository is no longer reachable" a day later.
   */
  private async checkRefs(ws: Workspace, gitDir: string, input: string, why: string): Promise<void> {
    const r = await git(ws, ['update-ref', '--stdin'], { env: { GIT_DIR: gitDir }, stdin: input });
    if (!r || r.code !== 0) {
      const said = r ? `${r.stderr}\n${r.output.toString('utf8')}`.trim().split('\n').pop() : 'no answer';
      this.log(`[changes] could not update the snapshot refs in ${gitDir} (${why}): ${said}`);
    }
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

  /** The next turn number of a conversation, taken synchronously — see the header. */
  private takeNumber(id: string): number {
    const known = this.numbering.get(id);
    if (known !== undefined) {
      this.numbering.set(id, known + 1);
      return known;
    }
    const turns = this.state.conversations[id]?.turns ?? [];
    const turn = turns.reduce((n, t) => Math.max(n, t.turn), 0) + 1;
    this.numbering.set(id, turn + 1);
    return turn;
  }

  private attach(handle: TurnChangesHandle, entry: TurnChangeEntry): void {
    try {
      handle.platform.attachTurnChanges?.(handle.address, entry, handle.reply);
    } catch (e) {
      this.log(`[changes] ${handle.id}: could not attach turn ${entry.turn} to its reply (${reasonOf(e)})`);
    }
  }

  private markSlow(key: string): void {
    this.slow.set(key, Date.now() + SLOW_REPO_MS);
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

/**
 * Resolve with whatever `work` answers, or with undefined after `ms` — whichever comes first.
 *
 * The reason this exists beside the per-command timeouts: a remote host that has gone away makes
 * `ws.run` wait for a reconnect, and no timeout is carried across that link. The abandoned work
 * is left to finish or be killed on its own; nothing of it can reach the turn.
 *
 * What it does NOT do is cancel that abandoned work: its rpc stays open on the link until the host
 * answers or the connection drops, which on a host that has died keeps the gateway trying to
 * reconnect. `workspace.ts` has no signal to hand it yet; a bounded snapshot is worth more than a
 * clean cancellation here, and the leak is one request per turn at worst.
 */
function withinDeadline<T>(work: Promise<T | undefined>, ms: number, onTimeout: () => void): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve(undefined);
    }, ms);
    timer.unref?.();
    const done = (v: T | undefined): void => {
      clearTimeout(timer);
      resolve(v);
    };
    void work.then(done, () => done(undefined));
  });
}

/** Group records by the snapshot repository they belong to, keeping the file's order. */
function byGitDir(records: readonly TurnRecord[]): Map<string, TurnRecord[]> {
  const out = new Map<string, TurnRecord[]>();
  for (const r of records) {
    const list = out.get(r.gitDir);
    if (list) list.push(r);
    else out.set(r.gitDir, [r]);
  }
  return out;
}

/** The path of `p` under `root`, or undefined when it is not under it. POSIX, as the host is. */
function relativeUnder(root: string, p: string): string | undefined {
  const base = root.endsWith('/') ? root : `${root}/`;
  return p.startsWith(base) ? p.slice(base.length) : undefined;
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

/** The last line of a command's output that says anything, for a one-line log. */
function lastLine(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
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
 * The only uses are reading `$HOME`, unlinking a file, and writing the exclude line (see the
 * header). Nothing a person or an agent typed ever lands in the script text: the arguments after
 * `fleetherd` are `$1`, `$2`, …, and the script itself is a constant.
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
