import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import { excerpt, ftsQuery, indexText, queryTerms } from './tokenize.js';

/**
 * Loaded through `createRequire` rather than a static import, and this is not a style choice:
 * Vite (which runs the tests) strips the `node:` prefix before asking its builtin list, and Node
 * 24 lists this module only in the prefixed form — so `import … from 'node:sqlite'` fails to
 * resolve in vitest before a single test runs. At runtime, under Node, the two are identical.
 *
 * The load is guarded because the package still declares Node ≥20: a gateway on a Node without
 * `node:sqlite` runs without a library rather than failing to start. See the constructor.
 */
function loadSqlite(): (new (file: string) => Database) | undefined {
  try {
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: new (file: string) => Database })
      .DatabaseSync;
  } catch {
    return undefined;
  }
}
const DatabaseSync = loadSqlite();

/**
 * The gateway's long-term conversation library: every turn that went through it, in
 * `<configDir>/history.db`, searchable by keyword.
 *
 * Four tables: `sessions` (one per conversation, with platform, title, agent, host,
 * directory, kind and its span), `turns` (one per turn: the agent, the conversation generation
 * that tells `/new` apart, the trigger, the span and how it ended), `messages` (one row per
 * prompt, reply or tool call, carrying the turn it belongs to), and `messages_fts` (the same
 * text, tokenised for search — see tokenize.ts for why Chinese is split in JS first).
 * `imported` records the web UI transcripts already folded in, so the import runs once per file
 * rather than once per start.
 *
 * **Recording never throws.** A write failure is logged and dropped: the turn it describes
 * is the thing worth keeping, and a full disk must not fail an answer. Queries do throw —
 * a broken search is something the agent asked for and must be told about.
 *
 * The file is 0600 and lives beside `conversations.json`; it holds the same kind of text the
 * harnesses' own session files do, which is why the permission is not optional.
 */

/** What a conversation, or one turn in it, was. `background` is only ever a turn kind. */
export type HistoryKind = 'normal' | 'schedule' | 'subagent' | 'background' | 'review';

export type HistoryRole = 'user' | 'agent' | 'tool';

/**
 * What started a turn — the sender the daemon put on the batch that opened it, or `background`
 * for output the agent produced after its turn (a follow-up burst). `update` is the gateway's
 * own `[sub-agent updates]` card, `delegate` a task handed to a sub-agent: both are `subagent`
 * message kinds, and telling them apart is the reason a trigger exists beside the kind.
 */
export type HistoryTrigger = 'person' | 'schedule' | 'delegate' | 'update' | 'continue' | 'background';

/**
 * How a turn ended. `restart` is only written at startup, for a turn still marked running in the
 * file: the process that opened the library is new, so the previous one never finished it. A turn
 * that is running right now has no outcome at all.
 */
export type HistoryOutcome = 'done' | 'stopped' | 'failed' | 'restart';

/** What the daemon knows when a turn starts. The library adds the row and its sequence number. */
export interface HistoryTurnStart {
  /** The agent answering this turn (the binding at the moment it started). */
  agent: string;
  trigger: HistoryTrigger;
  at: number;
}

/**
 * What the store writes: the start plus the conversation's generation — a counter bumped by
 * `/new` and `/cd`, the two commands that destroy the agent's session. It is what tells turns on
 * either side of a reset apart without consulting the harness's own session ids, which a new
 * session does not have yet.
 */
export interface HistoryTurnRecord extends HistoryTurnStart {
  generation: number;
}

/** How a turn ended, when it ends. */
export interface HistoryTurnEnd {
  outcome: HistoryOutcome;
  at: number;
  /** Why it failed, whole (bounded at 200k characters); empty for every other outcome. */
  detail?: string;
}

/**
 * What a turn filter selected: the turn ids, and — when the selection is empty or was cut — the
 * sentence that says why. An empty selection is a legitimate answer (`--turn done` after `/new`),
 * so it is returned rather than thrown.
 */
interface TurnSelection {
  ids: number[];
  note?: string;
}

export interface HistorySessionMeta {
  /** The conversation id — the same key `conversations.json` uses. */
  key: string;
  platform: string;
  title?: string;
  agent?: string;
  host?: string;
  cwd?: string;
  /** The conversation's kind. Only the first value recorded for a key is kept. */
  kind?: HistoryKind;
  /** Epoch ms of the event that opened or last touched the session. */
  at: number;
  /** Last activity, when it is not the same event (an imported transcript spans both ends). */
  lastAt?: number;
}

export interface HistoryMessage {
  ts: number;
  role: HistoryRole;
  kind: HistoryKind;
  text: string;
  /** The turn this row belongs to (turns.id); absent for an import or a row from before turns. */
  turn?: number;
  /**
   * A tool row's call id (the harness's `toolCallId`). A second write with the same id in the same
   * conversation and turn rewrites that row instead of adding one: the harness streams a call's
   * arguments as a run of updates, and before this every update was a row of its own — one
   * CodeBuddy Write was twelve identical lines, and 14k of 55k tool rows in two days were copies.
   */
  call?: string;
}

export interface HistorySessionRow {
  id: number;
  key: string;
  platform: string;
  title: string;
  agent: string;
  host: string;
  cwd: string;
  kind: string;
  startedAt: string;
  lastAt: string;
  messages: number;
}

export interface HistoryHit {
  /** The session id `read` takes. */
  session: number;
  /** The message id `read --around` takes. */
  message: number;
  at: string;
  title: string;
  agent: string;
  platform: string;
  kind: string;
  role: string;
  excerpt: string;
}

/**
 * One skill change an automatic review's answer carried, and what became of it.
 *
 * `applied` is deliberately three-state: true (the store took it), false with `error` (the store
 * refused it, and why), and absent on a review recorded before results were kept — that answer was
 * never compared with the skill library, and saying either way would be a guess.
 */
export interface HistoryReviewChange {
  action: 'create' | 'patch' | 'write-file';
  name: string;
  file?: string;
  /** The reviewer's own sentence about why. */
  reason?: string;
  applied?: boolean;
  /** Why the store refused it, or why its shape was rejected. */
  error?: string;
  /** The `.history/` entry `talkcode skills revert` names, when there is one. */
  revertId?: string;
}

/**
 * What a review produced, as the Reviews tab names it.
 *
 * `proposed` exists only for a review recorded before results were kept: the raw answer lists
 * changes, but whether any was applied was never written down. It is shown as inferred rather than
 * folded into `changed`, which would claim something the library does not know.
 */
export type HistoryReviewOutcome = 'changed' | 'preferences' | 'refused' | 'proposed' | 'nothing' | 'failed';

/** The result row of one review, stored beside its session (table `reviews`). */
export interface HistoryReviewRecord {
  /** The conversation that was reviewed — the key `conversations.json` uses. */
  reviewedKey: string;
  /** That conversation's title at review time, so a rename does not erase what was reviewed. */
  reviewedTitle: string;
  /** Its lane, so the web UI can offer a link back to the topic. */
  platform: string;
  channel?: string;
  thread?: string;
  outcome: HistoryReviewOutcome;
  changes: HistoryReviewChange[];
  preferences: string[];
  /** Changes the answer carried that did not pass the shape check, one line each. */
  invalid: string[];
  /** Why the whole review failed. Empty for every other outcome. */
  error?: string;
  at: number;
}

/** One review session with the result it recorded, when it recorded one. */
export interface HistoryReviewRow {
  session: HistorySessionRow;
  record?: HistoryReviewRecord;
}

/**
 * One row of a read. The last three fields are present only on a FILTERED read: adding them to
 * the unfiltered one would change what `sessions read` prints for everyone, which this feature
 * deliberately does not do.
 */
export interface HistoryReadMessage {
  id: number;
  at: string;
  role: string;
  kind: string;
  text: string;
  /** The turn's number in this conversation; null for a row written before turns existed. */
  turn?: number | null;
  /** That turn's outcome, or `running`; null when the row has no turn. */
  outcome?: string | null;
  /** The agent that ran that turn. */
  agent?: string;
}

export interface HistoryReadResult {
  session: HistorySessionRow;
  messages: HistoryReadMessage[];
  /** What was left out, when a bound cut it — said so nobody reads a partial log as whole. */
  note?: string;
}

/**
 * A turn just opened: the row id its messages carry, and the number `--turn <n>` takes.
 *
 * `seq` is optional because a store that failed between the insert and the lookup still owns the
 * row; the turn is recorded, only its number is unknown, and a card then falls back to a
 * positional pointer rather than naming a turn it cannot.
 */
export interface HistoryTurnRef {
  id: number;
  seq?: number;
}

/**
 * One turn as the library recorded it: what `task-read --turn <n>` shows, and the record a cut
 * update card points at when its quote was not the whole of what the sub-agent said.
 */
export interface HistoryTurnRow {
  /** 1-based within the conversation (turns.seq), the number printed beside every row. */
  turn: number;
  /** When it ended; its start while it is still running. */
  at: string;
  /** `done` | `stopped` | `failed` | `restart`, or `running` while it has no outcome yet. */
  outcome: string;
  agent: string;
  /** Why it failed, whole; empty for every other outcome. */
  detail: string;
}

/**
 * How `read` narrows one conversation. `around` is the old window and is refused beside the
 * filters (it defines a window of its own); the rest combine with AND.
 */
export interface HistoryReadOptions {
  around?: number;
  window?: number;
  /** Only rows of this role. */
  role?: HistoryRole;
  /** `last` | `done` (the newest turn that ended normally) | a turn number, 1-based. */
  turn?: string;
  /** The last n turns. */
  turns?: number;
  /** Rows after this message id (exclusive). */
  since?: number;
  /** Rows whose text contains this word or phrase. */
  grep?: string;
  /** With `role: 'tool'`, the newest n tool lines. */
  tail?: number;
  /**
   * The newest n rows, oldest first — `task-read`'s `--limit`, about how much of a log to return
   * rather than which rows match. Not combinable with `since`: that resumes forward from a cursor
   * while this keeps the newest end (see assertSinceDirection).
   */
  limit?: number;
  /**
   * The conversation's live context, keyed by its own key: the agent bound to it now and the
   * generation `/new`/`/cd` last set.
   *
   * `--turn done` is defined against this, and only the daemon knows it. The library cannot infer
   * it from its own rows: after `/new` the newest turn row still belongs to the previous
   * generation, because the new context has not run a turn yet — inferring from it answers with
   * the answer `/new` was asked to discard. A store used without this (tests, a direct caller)
   * falls back to the newest turn's agent and generation.
   */
  current?: (key: string) => { agent: string; generation: number } | undefined;
}

export interface HistorySearchOptions {
  agent?: string;
  days?: number;
  limit?: number;
  /**
   * Include tool calls. Off by default: they are 94% of the rows (72k of 76k recorded 11-04 to
   * 11-06), so a word the person and the agent used is buried under every command that happened
   * to contain it.
   */
  tools?: boolean;
}

/** What one review reads: a tail of a conversation plus the two facts its trigger decides on. */
export interface ReviewWindow {
  session: HistorySessionRow;
  /**
   * What the person and the agent said, oldest first, at most `maxChars` characters in total (the
   * newest row is always kept). No tool calls: see `reviewWindow`.
   */
  messages: Array<{ id: number; at: string; role: string; kind: string; text: string }>;
  /** The person's own messages in the span, before any character cut. */
  userMessages: number;
  /** The newest message in the conversation — where the next review starts. */
  lastMessageId: number;
  /** How many of the person's and the agent's messages the character budget left out. */
  dropped: number;
  /** The span's tool calls that named a skill path or the Skill tool, oldest first — whole rows. */
  skillCalls: string[];
}

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_LIST_LIMIT = 30;
const DEFAULT_LIST_DAYS = 7;
/** How much of one session `read` returns when no window was asked for. */
const READ_ALL_LIMIT = 500;

/**
 * How many rows a folding read scans before folding. The 500-row bound counts FOLDED rows, so SQL
 * cannot apply it; this bounds the scan instead. The longest conversation on 2026-11-06 had 3,196
 * rows, almost all of them tool calls.
 */
const READ_FOLD_SCAN = 20_000;

/** How much of a tool row a folding read takes: its first line is all it shows. */
const TOOL_HEAD_CHARS = 300;

/** Said once when a read folded tool calls, so an agent knows the rows are there and how to see them. */
const FOLD_NOTE = 'Each run of tool calls is folded into one line; --role tool lists them with their arguments.';

/**
 * How many characters of text `read` returns in one answer.
 *
 * The reply row is capped at 200k characters, so a 500-message conversation could otherwise be
 * a hundred-megabyte IPC line. Exported because `task-read --turn <n> --full` answers with one
 * turn and the update card that points there promises the whole of one reply: this bound is what
 * that read may return, not the 20k that keeps a `--full` log readable.
 */
export const READ_CHAR_BUDGET = 200_000;

/**
 * How many messages `reviewWindow` reads before the character budget is applied. A review runs
 * after a few messages, so this only bounds the pathological case (a conversation nobody reviewed
 * for months): the newest few hundred are what a reviewer can still act on.
 */
const REVIEW_WINDOW_ROWS = 500;

/**
 * How much of one message a review gets. Most are far shorter; this is for the pasted log or the
 * long report, which would otherwise spend a fifth of the budget on itself. Head and tail are kept,
 * because a reply's conclusion is at its end and a paste's question is usually at its start.
 */
const REVIEW_MESSAGE_CHARS = 8_000;

/** How many skill-touching calls one review is given. They are signals, not a log. */
const REVIEW_SKILL_CALLS = 200;

function clipForReview(text: string): string {
  if (text.length <= REVIEW_MESSAGE_CHARS) return text;
  const head = text.slice(0, 6_000);
  const tail = text.slice(-2_000);
  return `${head}\n[… ${text.length - 8_000} characters cut …]\n${tail}`;
}

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

/** SQLite LIKE with `\` as the escape character. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The library. Construct once at startup; absent or unopenable degrades to a store whose
 * recording methods do nothing (a gateway without a history file still answers).
 */
export class HistoryStore {
  private db: Database | undefined;
  /** Why the file could not be opened, for the one warning at startup and for queries. */
  private readonly failure: string | undefined;

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = (m) => console.warn(m)
  ) {
    if (!DatabaseSync) {
      this.failure = 'node:sqlite is not available in this Node build (the gateway image has it)';
      this.log(`[history] ${this.failure}; conversations are not being recorded`);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(file);
      // WAL keeps a write from blocking a search; NORMAL is the right durability for an
      // index that is rebuilt from nothing worse than a lost turn.
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL UNIQUE,
          platform TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          agent TEXT NOT NULL DEFAULT '',
          host TEXT NOT NULL DEFAULT '',
          cwd TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'normal',
          started_at INTEGER NOT NULL,
          last_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          ts INTEGER NOT NULL,
          role TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'normal',
          text TEXT NOT NULL,
          turn INTEGER,
          call TEXT
        );
        CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, ts, id);
        CREATE TABLE IF NOT EXISTS turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          agent TEXT NOT NULL DEFAULT '',
          generation INTEGER NOT NULL DEFAULT 0,
          trigger TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          outcome TEXT,
          detail TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, seq);
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, tokenize = 'unicode61');
        CREATE TABLE IF NOT EXISTS imported (
          source TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          session_id INTEGER NOT NULL,
          messages INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reviews (
          session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          reviewed_key TEXT NOT NULL DEFAULT '',
          reviewed_title TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL DEFAULT '',
          channel TEXT NOT NULL DEFAULT '',
          thread TEXT NOT NULL DEFAULT '',
          outcome TEXT NOT NULL DEFAULT 'nothing',
          changes TEXT NOT NULL DEFAULT '[]',
          preferences TEXT NOT NULL DEFAULT '[]',
          invalid TEXT NOT NULL DEFAULT '[]',
          error TEXT NOT NULL DEFAULT '',
          at INTEGER NOT NULL
        );
      `);
      this.migrate();
      this.closeInterruptedTurns();
      this.lockDown();
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e);
      this.db = undefined;
      this.log(`[history] could not open ${file}: ${this.failure}; conversations are not being recorded`);
    }
  }

  /**
   * Bring an older file up to the current schema, in place, without rewriting a row.
   *
   * `messages.turn` and `messages.call` are the columns a previous version lacks: `CREATE TABLE IF
   * NOT EXISTS` cannot add them to an existing table, and a migration that back-filled them would be
   * inventing what nobody recorded. So both are added NULL and old rows stay NULL — a turn reads as
   * "unknown" (see HistoryReadMessage), and an old tool row simply has no call to be rewritten by.
   */
  private migrate(): void {
    const db = this.db;
    if (!db) return;
    const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'turn')) db.exec('ALTER TABLE messages ADD COLUMN turn INTEGER');
    if (!columns.some((c) => c.name === 'call')) db.exec('ALTER TABLE messages ADD COLUMN call TEXT');
    // (session_id, turn), not (turn): every read starts from one conversation, and a turn number
    // is per-conversation. A bare `turn` index cannot narrow by session, so the planner falls back
    // to messages_session and walks the conversation's whole tail to prove there is no later row.
    db.exec('CREATE INDEX IF NOT EXISTS messages_session_turn ON messages(session_id, turn)');
    // Partial: only tool rows written since calls were kept have one, and every lookup names one.
    db.exec('CREATE INDEX IF NOT EXISTS messages_call ON messages(session_id, call) WHERE call IS NOT NULL');
  }

  /**
   * A turn still marked running when this library is opened was cut off by the process that
   * wrote it — a drain that ran out of time, a crash, a kill. The gateway is one process per
   * config directory, so there is no other way to read it, and nothing in the harness's own
   * history says the gateway stopped listening. This is the turns-table counterpart of
   * ConversationRecord.inFlight, and it runs at open for the same reason: it is the only moment
   * that knows the previous process is gone.
   *
   * Its end time is a LOWER BOUND: the newest message it managed to write, else its start.
   */
  private closeInterruptedTurns(): void {
    this.db?.exec(`
      UPDATE turns SET outcome = 'restart',
        ended_at = COALESCE((SELECT MAX(ts) FROM messages WHERE messages.turn = turns.id), started_at)
      WHERE outcome IS NULL
    `);
  }

  /**
   * The database file and its WAL companions are 0600. `DatabaseSync` creates the file under
   * the process umask, and the WAL is created on the first write, so both are set here and
   * again after the schema (which writes).
   */
  private lockDown(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.chmodSync(`${this.file}${suffix}`, 0o600);
      } catch {
        // Not there yet (the WAL appears on the first write) or not ours to chmod — either way
        // the next call after a write gets it.
      }
    }
  }

  /** The file this store was opened on, for logs and tests. */
  get path(): string {
    return this.file;
  }

  /** Whether the database opened at all. */
  get available(): boolean {
    return this.db !== undefined;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // Already closed, or a process that is going away anyway.
    }
    this.db = undefined;
  }

  /**
   * Insert or update one conversation, returning its id. The first `kind` recorded wins: a
   * normal topic that a fixed-session scheduled task later speaks into stays a normal topic,
   * while the scheduled turn itself is marked on its messages.
   */
  session(meta: HistorySessionMeta): number | undefined {
    return this.guard('session', () => this.upsertSession(meta));
  }

  /** Record one prompt, reply or tool line. */
  message(sessionId: number | undefined, msg: HistoryMessage): void {
    if (sessionId === undefined) return;
    this.guard('message', () => {
      this.insertMessage(sessionId, msg);
    });
  }

  /**
   * Open one turn, returning its id for the rows it will own. Numbered per conversation, so
   * `--turn 3` means the third turn of THAT conversation and matches the number printed beside
   * every row. A failure is logged and dropped like every other recording write.
   */
  startTurn(sessionId: number, start: HistoryTurnRecord): number | undefined {
    return this.guard('turn', () => {
      const db = this.requireDb();
      const row = db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM turns WHERE session_id = ?')
        .get(sessionId) as { seq: number | bigint };
      const res = db
        .prepare(
          'INSERT INTO turns (session_id, seq, agent, generation, trigger, started_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(sessionId, Number(row.seq), start.agent, start.generation, start.trigger, start.at);
      return Number(res.lastInsertRowid);
    });
  }

  /**
   * The 1-based number `--turn <n>` takes, for the row id `startTurn` returned.
   *
   * The id is what every message of the turn carries; the number is what an agent reads and passes
   * back. A card that quotes a turn has to name the second: "the last one" is a different turn by
   * the time the parent reads it whenever the topic runs again (a background burst, most often).
   */
  turnSeq(turnId: number): number | undefined {
    return this.guard('turn seq', () => {
      const row = this.requireDb().prepare('SELECT seq FROM turns WHERE id = ?').get(turnId) as
        | { seq: number | bigint }
        | undefined;
      return row ? Number(row.seq) : undefined;
    });
  }

  /** Close a turn with how it ended. A missing id (recording failed at the start) is a no-op. */
  endTurn(turnId: number | undefined, end: HistoryTurnEnd): void {
    if (turnId === undefined) return;
    this.guard('turn end', () => {
      this.db
        ?.prepare('UPDATE turns SET outcome = ?, ended_at = ?, detail = ? WHERE id = ?')
        .run(end.outcome, end.at, end.detail ?? '', turnId);
    });
  }

  /** The title a conversation was renamed to, once the namer knows it. */
  setTitle(key: string, title: string): void {
    this.guard('title', () => {
      this.db?.prepare('UPDATE sessions SET title = ? WHERE key = ?').run(title, key);
    });
  }

  /**
   * Fold one web UI transcript in, once. `source` names the file (instance + topic id); a
   * second call with the same source is a no-op, which is what makes the startup import
   * idempotent even though the transcript files are rewritten every few seconds.
   *
   * One transaction per transcript: a process that dies halfway leaves no half-imported
   * topic, and the next start does it again.
   */
  importSession(
    source: string,
    meta: HistorySessionMeta,
    messages: HistoryMessage[]
  ): 'imported' | 'skipped' {
    const db = this.db;
    if (!db) return 'skipped';
    try {
      const done = db.prepare('SELECT 1 AS yes FROM imported WHERE source = ?').get(source);
      if (done) return 'skipped';
      db.exec('BEGIN');
      try {
        const id = this.upsertSession(meta);
        for (const msg of messages) this.insertMessage(id, msg);
        db.prepare('INSERT INTO imported (source, at, session_id, messages) VALUES (?, ?, ?, ?)').run(
          source,
          Date.now(),
          id,
          messages.length
        );
        db.exec('COMMIT');
        this.lockDown();
        return 'imported';
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    } catch (e) {
      this.log(`[history] could not import ${source}: ${e instanceof Error ? e.message : e}`);
      return 'skipped';
    }
  }

  /** Whether this transcript file was already imported. */
  imported(source: string): boolean {
    try {
      return this.db?.prepare('SELECT 1 AS yes FROM imported WHERE source = ?').get(source) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Keyword search over every recorded turn. Scheduled results sort after everything else
   * (the trap Hermes hit: a noisy every-minute task buries the conversation someone is
   * looking for), then by BM25, then newest first. Tool calls are left out unless asked for
   * (HistorySearchOptions.tools).
   */
  search(query: string, opts: HistorySearchOptions = {}): HistoryHit[] {
    const db = this.requireDb();
    const terms = queryTerms(query);
    const match = ftsQuery(terms.fts);
    if (!match && terms.single.length === 0) {
      throw new Error('search needs a word to look for');
    }
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (match) {
      where.push('messages_fts MATCH ?');
      params.push(match);
    }
    where.push("m.kind != 'review'");
    if (!opts.tools) where.push("m.role != 'tool'");
    if (opts.agent) {
      where.push('s.agent = ?');
      params.push(opts.agent);
    }
    if (opts.days !== undefined && opts.days > 0) {
      where.push('m.ts >= ?');
      params.push(Date.now() - opts.days * 86_400_000);
    }
    for (const term of terms.single) {
      where.push("m.text LIKE ? ESCAPE '\\'");
      params.push(likePattern(term));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_SEARCH_LIMIT, 100));
    params.push(limit);
    const sql = `
      SELECT m.id AS message, m.ts AS ts, m.role AS role, m.kind AS kind, m.text AS text,
             s.id AS session, s.title AS title, s.agent AS agent, s.platform AS platform
      FROM ${match ? 'messages_fts JOIN messages m ON m.id = messages_fts.rowid' : 'messages m'}
      JOIN sessions s ON s.id = m.session_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN m.kind = 'schedule' THEN 1 ELSE 0 END,
               ${match ? 'bm25(messages_fts),' : ''} m.ts DESC
      LIMIT ?`;
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const wanted = [...terms.fts, ...terms.single];
    return rows.map((row) => ({
      session: Number(row.session),
      message: Number(row.message),
      at: iso(Number(row.ts)),
      title: String(row.title ?? ''),
      agent: String(row.agent ?? ''),
      platform: String(row.platform ?? ''),
      kind: String(row.kind ?? ''),
      role: String(row.role ?? ''),
      excerpt: excerpt(String(row.text ?? ''), wanted),
    }));
  }

  /**
   * One conversation: all of it, a window around one message, or the rows a filter selects.
   *
   * `around` is the old window (`--around`/`--window`) and is refused beside the filters, which
   * define a selection of their own. Without a filter the answer is exactly what it has always
   * been — same rows, same fields — because `sessions read <id>` must not change under anyone.
   */
  read(sessionRef: string, opts: HistoryReadOptions = {}): HistoryReadResult {
    const session = this.findSession(sessionRef);
    if (!session) throw new Error(`no conversation "${sessionRef}"; \`talkcode sessions list\` shows the ids`);
    if (opts.around !== undefined) {
      if (hasReadFilter(opts)) {
        throw new Error('--around reads a window of its own; drop it to use --role/--turn/--turns/--since/--grep/--tail');
      }
      return this.readWindow(session, opts);
    }
    if (!hasReadFilter(opts)) return this.readAll(session);
    return this.readFiltered(session, opts);
  }

  /**
   * One turn as the library recorded it — the record an update card points at when its quote was
   * cut. The card carries at most CARD_ITEM_CHARS of an error; the turn keeps the whole message the
   * failure was thrown with, which is the only copy of it anywhere.
   *
   * Undefined when there is no such turn to show: the conversation has no turns at all (nothing has
   * run there yet), or `done` found none that ended normally. A turn NUMBER that names no turn
   * still throws, like `read` — that is a wrong request, not an answer with nothing in it.
   */
  turnRecord(key: string, which: string, current?: HistoryReadOptions['current']): HistoryTurnRow | undefined {
    const session = this.findSession(key);
    if (!session) throw new Error(`no conversation "${key}"; \`talkcode sessions list\` shows the ids`);
    // `turnScope` throws for a conversation with no turns at all, which for a sub-agent topic just
    // means nothing has run yet — an empty answer, not a broken request.
    if (this.turnCount(session) === 0) return undefined;
    const id = this.turnScope(session, { turn: which, current })?.ids[0];
    if (id === undefined) return undefined;
    const row = this.requireDb()
      .prepare('SELECT seq, agent, started_at, ended_at, outcome, detail FROM turns WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      turn: Number(row.seq),
      at: iso(Number(row.ended_at ?? row.started_at)),
      outcome: row.outcome === null || row.outcome === undefined ? 'running' : String(row.outcome),
      agent: String(row.agent ?? ''),
      detail: String(row.detail ?? ''),
    };
  }

  /**
   * The whole conversation, oldest first, bounded by rows and characters, with each run of tool
   * calls folded into one line (see foldToolRuns) — the 500-row bound counts the folded rows.
   */
  private readAll(session: HistorySessionRow): HistoryReadResult {
    const db = this.requireDb();
    const rows = db
      .prepare(
        `SELECT id, ts, role, kind, ${foldTextColumn()} AS text, turn AS turn_ref FROM messages
         WHERE session_id = ? ORDER BY ts, id LIMIT ?`
      )
      .all(session.id, READ_FOLD_SCAN + 1) as Array<Record<string, unknown>>;
    const scanned = rows.length > READ_FOLD_SCAN;
    const folded = foldToolRuns(scanned ? rows.slice(0, READ_FOLD_SCAN) : rows);
    const more = scanned || folded.length > READ_ALL_LIMIT;
    const picked = folded.slice(0, READ_ALL_LIMIT);
    const { messages, dropped } = capRead(picked.map(messageRow));
    const notes = [
      more ? `This conversation has more than ${READ_ALL_LIMIT} messages.` : '',
      dropped > 0 ? `${dropped} later message(s) were left out of this answer.` : '',
    ].filter(Boolean);
    const tail = notes.length > 0 ? `${notes.join(' ')} Read a window with --around <message>.` : '';
    const note = [tail, anyFolded(picked.slice(0, messages.length)) ? FOLD_NOTE : ''].filter(Boolean).join(' ');
    return { session, messages, ...(note ? { note } : {}) };
  }

  /** Messages on both sides of one id (`--around`), oldest first. */
  private readWindow(session: HistorySessionRow, opts: HistoryReadOptions): HistoryReadResult {
    const db = this.requireDb();
    const around = opts.around;
    if (around === undefined) throw new Error('--around needs a message id');
    const anchor = db
      .prepare('SELECT id, ts FROM messages WHERE id = ? AND session_id = ?')
      .get(around, session.id) as { id: number; ts: number } | undefined;
    if (!anchor) throw new Error(`message ${around} is not in conversation ${session.id}`);
    const window = Math.max(0, Math.min(opts.window ?? 10, 100));
    const before = db
      .prepare(
        'SELECT id, ts, role, kind, text FROM messages WHERE session_id = ? AND (ts < ? OR (ts = ? AND id <= ?)) ORDER BY ts DESC, id DESC LIMIT ?'
      )
      .all(session.id, anchor.ts, anchor.ts, anchor.id, window + 1) as Array<Record<string, unknown>>;
    const after = db
      .prepare(
        'SELECT id, ts, role, kind, text FROM messages WHERE session_id = ? AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts, id LIMIT ?'
      )
      .all(session.id, anchor.ts, anchor.ts, anchor.id, window) as Array<Record<string, unknown>>;
    const all = [...before.reverse().map(messageRow), ...after.map(messageRow)];
    const { messages, dropped } = capRead(all);
    return {
      session,
      messages,
      ...(dropped > 0
        ? { note: `${dropped} message(s) of this window were left out to keep the answer under ${READ_CHAR_BUDGET} characters; narrow --window.` }
        : {}),
    };
  }

  /**
   * The filtered read: role, turn selection, watermark and text, combined with AND. Every row it
   * returns carries its turn's number, outcome and agent, because a filtered answer is about the
   * shape of the work, not just the words.
   *
   * Direction matters, and it follows what the filter is FOR. A turn/tail/turns/limit read is a
   * TAIL: when a bound cuts it, the newest rows are the ones worth keeping, so the cut is made from
   * the oldest end and the note says so. A `--since` read is a HEAD: it resumes from a watermark, so
   * the earliest rows after it are the ones the next read continues from, and the note names the
   * id to pass back. A role/grep read of the whole conversation also keeps the oldest and drops
   * later, like `readAll`.
   *
   * A since read orders by `id`, not by time. The cursor IS an id, and rows are not guaranteed to
   * arrive in time order: a web UI transcript imported later has high ids and old timestamps, so
   * ordering by (ts, id) while resuming by id skips rows on one page and repeats them on the
   * next. `--since` and the tail filters are therefore refused together — they read in opposite
   * directions, and one cursor cannot serve both.
   */
  private readFiltered(session: HistorySessionRow, opts: HistoryReadOptions): HistoryReadResult {
    assertSinceDirection(opts);
    const scope = this.turnScope(session, opts);
    // A selection that matches no turn is an answer, not an error: `--turn done` right after
    // `/new` is a legitimate question with nothing to show yet. The note says why.
    if (scope?.ids.length === 0) {
      return { session, messages: [], ...(scope.note ? { note: scope.note } : {}) };
    }
    const { where, params } = this.readWhere(session, opts, scope?.ids);
    const tail = opts.tail !== undefined ? Math.max(1, Math.min(opts.tail, 500)) : undefined;
    const limit = opts.limit !== undefined ? Math.max(1, Math.min(opts.limit, READ_ALL_LIMIT)) : undefined;
    const newestFirst =
      tail !== undefined || limit !== undefined || opts.turn !== undefined || opts.turns !== undefined;
    // A since read must be in the cursor's own coordinate system (see above); everything else
    // keeps the order it has always had.
    const order = opts.since !== undefined ? 'm.id' : newestFirst ? 'm.ts DESC, m.id DESC' : 'm.ts, m.id';
    const fold = foldsTools(opts);
    const { messages, more, dropped, resumeFrom: last, folded } = this.selectFiltered(where, params, {
      cap: tail ?? limit,
      newestFirst,
      order,
      fold,
    });
    // Where a since read continues from: the newest row it actually kept, after any cut — the
    // last call of a folded run, not its first, or the next page would repeat the run.
    const resumeFrom = !newestFirst && opts.since !== undefined ? last : undefined;
    const notes = [scope?.note, readNote(more, dropped, newestFirst, resumeFrom), folded ? FOLD_NOTE : undefined].filter(
      (n): n is string => n !== undefined
    );
    return { session, messages, ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
  }

  /**
   * Run the filtered query, fold its tool runs when the read does (foldsTools), and cut it from
   * the end the filter is about (see readFiltered). A folding read cannot let SQL apply the row
   * bound — the bound counts folded rows — so it scans up to READ_FOLD_SCAN and bounds after.
   */
  private selectFiltered(
    where: string[],
    params: Array<string | number>,
    how: { cap: number | undefined; newestFirst: boolean; order: string; fold: boolean }
  ): { messages: HistoryReadMessage[]; more: boolean; dropped: number; resumeFrom?: number; folded: boolean } {
    const db = this.requireDb();
    const { cap, newestFirst, order, fold } = how;
    const bound = cap ?? READ_ALL_LIMIT + 1;
    const sql = `
      SELECT m.id AS id, m.ts AS ts, m.role AS role, m.kind AS kind,
             ${fold ? foldTextColumn('m.') : 'm.text'} AS text,
             m.turn AS turn_ref, t.seq AS turn_seq, t.outcome AS turn_outcome, t.agent AS turn_agent
      FROM messages m
      LEFT JOIN turns t ON t.id = m.turn
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ?`;
    let rows = db.prepare(sql).all(...params, fold ? READ_FOLD_SCAN + 1 : bound) as Array<Record<string, unknown>>;
    const scanned = fold && rows.length > READ_FOLD_SCAN;
    if (fold) rows = foldToolRuns(scanned ? rows.slice(0, READ_FOLD_SCAN) : rows).slice(0, bound);
    // A cap the caller asked for (`--tail`, `--limit`) is exactly how many rows it wanted, so
    // reaching it is not a cut worth a note. Only the default 500-row bound is reported.
    const more = cap === undefined && (scanned || rows.length > READ_ALL_LIMIT);
    let picked = more ? rows.slice(0, READ_ALL_LIMIT) : rows;
    if (newestFirst) picked = picked.reverse();
    const selected = picked.map((row) => ({ row, message: readMessageRow(row) }));
    const cut = newestFirst ? capTail(selected.map((s) => s.message)) : capRead(selected.map((s) => s.message));
    const keptRows = newestFirst ? selected.slice(selected.length - cut.messages.length) : selected.slice(0, cut.messages.length);
    const lastRow = keptRows[keptRows.length - 1]?.row;
    return {
      messages: cut.messages,
      more,
      dropped: cut.dropped,
      ...(lastRow ? { resumeFrom: Number(lastRow.last_id ?? lastRow.id) } : {}),
      folded: anyFolded(keptRows.map((k) => k.row)),
    };
  }

  /** The WHERE a filtered read selects, and its parameters. Split out to keep readFiltered short. */
  private readWhere(
    session: HistorySessionRow,
    opts: HistoryReadOptions,
    turnIds: number[] | undefined
  ): { where: string[]; params: Array<string | number> } {
    const db = this.requireDb();
    // The CLI refuses this too; the store is the second wall for a hand-written IPC request.
    if (opts.tail !== undefined && opts.role !== 'tool') {
      throw new Error('--tail reads tool lines; use it with --role tool');
    }
    const where = ['m.session_id = ?'];
    const params: Array<string | number> = [session.id];
    if (opts.role) {
      where.push('m.role = ?');
      params.push(opts.role);
    }
    if (opts.grep) {
      where.push("m.text LIKE ? ESCAPE '\\'");
      params.push(likePattern(opts.grep));
    }
    if (turnIds) {
      where.push(`m.turn IN (${turnIds.map(() => '?').join(', ')})`);
      params.push(...turnIds);
    }
    if (opts.since !== undefined) {
      const exists = db
        .prepare('SELECT 1 AS yes FROM messages WHERE id = ? AND session_id = ?')
        .get(opts.since, session.id);
      if (!exists) throw new Error(`message ${opts.since} is not in conversation ${session.id}`);
      where.push('m.id > ?');
      params.push(opts.since);
    }
    return { where, params };
  }

  /**
   * Which turns a read selects, as ids — or undefined when it selects every turn (no turn filter).
   * A selected set may be empty, with a note saying why; an id or number that names no turn still
   * throws, because that is a wrong request rather than an answer with nothing in it.
   */
  private turnScope(session: HistorySessionRow, opts: HistoryReadOptions): TurnSelection | undefined {
    if (opts.turn === undefined && opts.turns === undefined) return undefined;
    if (opts.turn !== undefined && opts.turns !== undefined) {
      throw new Error('--turn and --turns select turns in different ways; use one');
    }
    const count = this.turnCount(session);
    if (count === 0) {
      throw new Error(
        `conversation ${session.id} has no recorded turns — it predates turn tracking; read it without --turn`
      );
    }
    if (opts.turns !== undefined) return this.lastTurns(session, opts.turns, count);
    const which = opts.turn ?? '';
    if (which === 'last') return this.lastTurn(session);
    if (which === 'done') return this.doneTurn(session, opts.current);
    return this.numberedTurn(session, which, count);
  }

  private turnCount(session: HistorySessionRow): number {
    return Number(
      (this.requireDb().prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?').get(session.id) as {
        n: number | bigint;
      }).n
    );
  }

  /** The newest `asked` turns, capped at 100 with a note when the cap actually dropped turns. */
  private lastTurns(session: HistorySessionRow, asked: number, count: number): TurnSelection {
    const db = this.requireDb();
    const n = Math.max(1, Math.min(asked, 100));
    const max = Number(
      (db.prepare('SELECT MAX(seq) AS seq FROM turns WHERE session_id = ?').get(session.id) as { seq: number | bigint })
        .seq
    );
    const ids = (
      db.prepare('SELECT id FROM turns WHERE session_id = ? AND seq > ? ORDER BY seq').all(session.id, max - n) as Array<{
        id: number | bigint;
      }>
    ).map((r) => Number(r.id));
    // Said rather than refused: 150 turns is a reasonable thing to ask for, and the newest 100
    // are the half an agent reads first anyway. Only when the cap really dropped turns — a
    // three-turn conversation asked for 150 shows all three, and a note about 100 would be false.
    return {
      ids,
      ...(count > n ? { note: `--turns takes at most ${n}; the newest ${n} are shown.` } : {}),
    };
  }

  private lastTurn(session: HistorySessionRow): TurnSelection {
    const row = this.requireDb()
      .prepare('SELECT id FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1')
      .get(session.id) as { id: number | bigint } | undefined;
    if (!row) throw new Error(`conversation ${session.id} has no recorded turns`);
    return { ids: [Number(row.id)] };
  }

  private doneTurn(
    session: HistorySessionRow,
    current: HistoryReadOptions['current']
  ): TurnSelection {
    const db = this.requireDb();
    // Scoped to the conversation's CURRENT context — the agent bound now and the generation
    // `/new`/`/cd` last set, which the daemon passes in (see HistoryReadOptions.current).
    // Inferring it from the newest turn row is wrong exactly after `/new`: that row still
    // belongs to the generation the person just discarded, so "the last turn that ended
    // normally" would reach back past the reset. (Explicit turn numbers and --turns still
    // reach the older ones, because those ask for a turn rather than for "the last one".)
    const newest = db
      .prepare('SELECT agent, generation FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1')
      .get(session.id) as { agent: string; generation: number | bigint } | undefined;
    if (!newest) throw new Error(`conversation ${session.id} has no recorded turns`);
    const live = current?.(session.key);
    const agent = live?.agent ?? newest.agent;
    const generation = live?.generation ?? Number(newest.generation);
    const row = db
      .prepare(
        "SELECT id FROM turns WHERE session_id = ? AND agent = ? AND generation = ? AND outcome = 'done' ORDER BY seq DESC LIMIT 1"
      )
      .get(session.id, agent, generation) as { id: number | bigint } | undefined;
    if (!row) {
      // Nothing has finished here yet — a fresh `/new` is the normal case. An empty answer with
      // this note tells the agent that, where an error would read as a broken request.
      const behind =
        Number(newest.generation) !== generation
          ? `; the newest recorded turn is from generation ${Number(newest.generation)}`
          : '';
      return {
        ids: [],
        note: `no turn of conversation ${session.id} has ended normally for agent ${agent} in generation ${generation} yet${behind}`,
      };
    }
    return { ids: [Number(row.id)] };
  }

  private numberedTurn(session: HistorySessionRow, which: string, count: number): TurnSelection {
    const seq = Number(which);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new Error(`--turn takes last, done, or a turn number (1 = the first), got ${JSON.stringify(which)}`);
    }
    const row = this.requireDb()
      .prepare('SELECT id FROM turns WHERE session_id = ? AND seq = ?')
      .get(session.id, seq) as { id: number | bigint } | undefined;
    if (!row) throw new Error(`conversation ${session.id} has ${count} turn(s); there is no turn ${seq}`);
    return { ids: [Number(row.id)] };
  }

  /** The most recently active conversations, newest first. */
  list(opts: { days?: number; limit?: number } = {}): HistorySessionRow[] {
    const db = this.requireDb();
    const days = opts.days !== undefined && opts.days > 0 ? opts.days : DEFAULT_LIST_DAYS;
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, 200));
    const rows = db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages
         FROM sessions s
         WHERE s.last_at >= ? AND s.kind != 'review'
         ORDER BY s.last_at DESC
         LIMIT ?`
      )
      .all(Date.now() - days * 86_400_000, limit) as Array<Record<string, unknown>>;
    return rows.map(sessionRow);
  }

  /**
   * One conversation's row by the key `conversations.json` uses, without reading its messages —
   * what the review sweep asks before deciding whether a quiet conversation is worth reviewing.
   */
  sessionOf(key: string): HistorySessionRow | undefined {
    try {
      return this.findSession(key);
    } catch {
      // No database: the sweep has nothing to read, and says so once at startup instead.
      return undefined;
    }
  }

  /**
   * What a review reads of one conversation: what the person and the agent said after the last
   * review's watermark, cut to a character budget, plus the facts the trigger needs — how many
   * messages the person sent in that span, and the id a review starts after next time — and the
   * tool calls that touched a skill.
   *
   * Tool calls are not in `messages`. Measured over 42 reviews on 2026-11-06, they were 76% of what
   * the reviewer was given and the person's own words 0.6%: the budget filled newest-first with
   * calls, and only 262 of the 577 messages the person sent in those spans reached the reviewer —
   * five reviews saw none. What the agent did is in its replies (every fact behind the five skills
   * those reviews created appeared there too), so the window is the conversation without them; the
   * calls that read or wrote a skill come separately, as `skillCalls`, because the prompt needs
   * those two facts and nothing else of the calls.
   *
   * Within the budget the person comes first: every message they sent is kept (each cut at
   * REVIEW_MESSAGE_CHARS), then the agent's replies newest-first in what is left, so a long
   * conversation loses its oldest replies rather than what the person asked or corrected.
   *
   * Scheduled turns and sub-agent turns are left out: they share a topic with a person's
   * conversation but are not what the person said. `review` rows are excluded for the same reason a
   * review is never reviewed. `background` output is kept — the agent said it in this conversation.
   */
  reviewWindow(key: string, afterId: number, maxChars: number): ReviewWindow | undefined {
    const db = this.requireDb();
    const session = this.findSession(key);
    if (!session) return undefined;
    const excluded = "kind NOT IN ('schedule', 'subagent', 'review')";
    const said = `${excluded} AND role != 'tool'`;
    const count = (sql: string): number =>
      Number((db.prepare(sql).get(session.id, afterId) as { n: number | bigint }).n);
    const total = count(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND id > ? AND ${said}`);
    const lastRow = db.prepare('SELECT MAX(id) AS id FROM messages WHERE session_id = ?').get(session.id) as
      | { id: number | bigint | null }
      | undefined;
    const userMessages = count(
      "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND id > ? AND role = 'user' AND kind = 'normal'"
    );
    const rows = db
      .prepare(
        `SELECT id, ts, role, kind, text FROM messages
         WHERE session_id = ? AND id > ? AND ${said}
         ORDER BY ts DESC, id DESC LIMIT ?`
      )
      .all(session.id, afterId, REVIEW_WINDOW_ROWS) as Array<Record<string, unknown>>;
    const newestFirst = rows.map(messageRow).map((m) => ({ ...m, text: clipForReview(m.text) }));
    const kept = new Set<number>();
    let chars = 0;
    // The person's messages first, then the agent's, each newest-first; the newest row is always
    // kept, so a single oversized answer is still something to review.
    for (const role of ['user', 'agent']) {
      for (const message of newestFirst) {
        if (message.role !== role) continue;
        if (kept.size > 0 && chars + message.text.length > maxChars) break;
        kept.add(message.id);
        chars += message.text.length;
      }
    }
    const skillCalls = (
      db
        .prepare(
          `SELECT text FROM messages
           WHERE session_id = ? AND id > ? AND ${excluded} AND role = 'tool'
             AND (text LIKE '%skills/%' OR text LIKE '%Skill%' OR text LIKE '%"skill"%')
           ORDER BY id LIMIT ?`
        )
        .all(session.id, afterId, REVIEW_SKILL_CALLS) as Array<{ text: string }>
    ).map((r) => String(r.text));
    return {
      session,
      messages: newestFirst.filter((m) => kept.has(m.id)).reverse(),
      userMessages,
      lastMessageId: Number(lastRow?.id ?? afterId),
      dropped: total - kept.size,
      skillCalls,
    };
  }

  /**
   * File one review's result beside its session. A review whose result could not be written is
   * still a review — the raw answer is already in `messages` — so this is a guarded write like
   * every other one: a failure is logged and the sweep carries on.
   */
  recordReview(sessionId: number | undefined, record: HistoryReviewRecord): void {
    if (sessionId === undefined) return;
    this.guard('review result', () => {
      this.requireDb()
        .prepare(
          `INSERT INTO reviews
             (session_id, reviewed_key, reviewed_title, platform, channel, thread, outcome, changes, preferences, invalid, error, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             reviewed_key = excluded.reviewed_key,
             reviewed_title = excluded.reviewed_title,
             platform = excluded.platform,
             channel = excluded.channel,
             thread = excluded.thread,
             outcome = excluded.outcome,
             changes = excluded.changes,
             preferences = excluded.preferences,
             invalid = excluded.invalid,
             error = excluded.error,
             at = excluded.at`
        )
        .run(
          sessionId,
          record.reviewedKey,
          record.reviewedTitle,
          record.platform,
          record.channel ?? '',
          record.thread ?? '',
          record.outcome,
          JSON.stringify(record.changes),
          JSON.stringify(record.preferences),
          JSON.stringify(record.invalid),
          record.error ?? '',
          record.at
        );
    });
  }

  /**
   * The newest review sessions, each with the result it recorded when it recorded one.
   *
   * A review recorded before the `reviews` table existed has no row here: the caller reads its raw
   * answer (`reviewAnswer`) and says it is inferred. That is why `record` is optional rather than
   * back-filled — inventing which changes took effect would be a guess wearing a fact's clothes.
   */
  reviewSessions(limit = 50): HistoryReviewRow[] {
    const db = this.requireDb();
    const rows = db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages,
                r.session_id AS review_session, r.reviewed_key, r.reviewed_title,
                r.platform AS review_platform, r.channel AS review_channel, r.thread AS review_thread,
                r.outcome AS review_outcome, r.changes AS review_changes,
                r.preferences AS review_preferences, r.invalid AS review_invalid,
                r.error AS review_error, r.at AS review_at
         FROM sessions s
         LEFT JOIN reviews r ON r.session_id = s.id
         WHERE s.kind = 'review'
         ORDER BY s.started_at DESC, s.id DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const session = sessionRow(row);
      if (row.review_session === null || row.review_session === undefined) return { session };
      return { session, record: reviewRecordRow(row) };
    });
  }

  /**
   * The last thing the reviewer answered in one review session — the raw output an old review is
   * inferred from. A failed run has no agent row, so this is `undefined` there.
   */
  reviewAnswer(sessionId: number): string | undefined {
    const row = this.requireDb()
      .prepare("SELECT text FROM messages WHERE session_id = ? AND role = 'agent' ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { text: string } | undefined;
    return row?.text;
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private requireDb(): Database {
    if (!this.db) {
      throw new Error(`the conversation history database is unavailable${this.failure ? `: ${this.failure}` : ''}`);
    }
    return this.db;
  }

  /** Run a write, swallowing its failure into the log (see the class doc). */
  private guard<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      this.log(`[history] could not record ${what}: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  private upsertSession(meta: HistorySessionMeta): number {
    const db = this.requireDb();
    const row = db
      .prepare(
        `INSERT INTO sessions (key, platform, title, agent, host, cwd, kind, started_at, last_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           platform = CASE WHEN excluded.platform != '' THEN excluded.platform ELSE sessions.platform END,
           title = CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
           agent = CASE WHEN excluded.agent != '' THEN excluded.agent ELSE sessions.agent END,
           host = CASE WHEN excluded.host != '' THEN excluded.host ELSE sessions.host END,
           cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE sessions.cwd END,
           last_at = MAX(sessions.last_at, excluded.last_at)
         RETURNING id`
      )
      .get(
        meta.key,
        meta.platform,
        meta.title ?? '',
        meta.agent ?? '',
        meta.host ?? '',
        meta.cwd ?? '',
        meta.kind ?? 'normal',
        meta.at,
        meta.lastAt ?? meta.at
      ) as { id: number | bigint } | undefined;
    if (!row) throw new Error(`could not record conversation ${meta.key}`);
    return Number(row.id);
  }

  private insertMessage(sessionId: number, msg: HistoryMessage): void {
    const db = this.requireDb();
    if (msg.call !== undefined) {
      // The same call again: the newer text replaces the older one, and the row keeps the time
      // the call started. Scoped to the turn too, so a harness that reuses ids across turns cannot
      // overwrite an older turn's record.
      const existing = db
        .prepare('SELECT id FROM messages WHERE session_id = ? AND call = ? AND turn IS ?')
        .get(sessionId, msg.call, msg.turn ?? null) as { id: number | bigint } | undefined;
      if (existing) {
        const id = Number(existing.id);
        db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(msg.text, id);
        db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id);
        db.prepare('INSERT INTO messages_fts (rowid, body) VALUES (?, ?)').run(id, indexText(msg.text));
        return;
      }
    }
    const res = db
      .prepare('INSERT INTO messages (session_id, ts, role, kind, text, turn, call) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, msg.ts, msg.role, msg.kind, msg.text, msg.turn ?? null, msg.call ?? null);
    const id = Number(res.lastInsertRowid);
    db.prepare('INSERT INTO messages_fts (rowid, body) VALUES (?, ?)').run(id, indexText(msg.text));
  }

  private findSession(ref: string): HistorySessionRow | undefined {
    const db = this.requireDb();
    const id = Number(ref.replace(/^#/, ''));
    const row = Number.isInteger(id)
      ? (db.prepare('SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages FROM sessions s WHERE s.id = ?').get(id) as
          | Record<string, unknown>
          | undefined)
      : (db.prepare('SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages FROM sessions s WHERE s.key = ?').get(ref) as
          | Record<string, unknown>
          | undefined);
    return row ? sessionRow(row) : undefined;
  }
}

function messageRow(row: Record<string, unknown>): HistoryReadMessage {
  return {
    id: Number(row.id),
    at: iso(Number(row.ts)),
    role: String(row.role ?? ''),
    kind: String(row.kind ?? ''),
    text: String(row.text ?? ''),
  };
}

/** A filtered row, with its turn's number, outcome and agent. */
function readMessageRow(row: Record<string, unknown>): HistoryReadMessage {
  const base = messageRow(row);
  // Three states, deliberately distinct: no turn at all (a row recorded before turns), a turn
  // whose row is missing, and a turn that exists but has not ended yet (`running`).
  if (row.turn_ref === null || row.turn_ref === undefined || row.turn_seq === null || row.turn_seq === undefined) {
    return { ...base, turn: null, outcome: null, agent: '' };
  }
  return {
    ...base,
    turn: Number(row.turn_seq),
    outcome: row.turn_outcome === null || row.turn_outcome === undefined ? 'running' : String(row.turn_outcome),
    agent: String(row.turn_agent ?? ''),
  };
}

/**
 * Whether a read folds tool calls: every read that does not choose rows by role or by text. A
 * `--role tool` read is asking for the calls themselves, and a `--grep` hit inside a call must be
 * shown, not counted.
 */
function foldsTools(opts: HistoryReadOptions): boolean {
  return opts.role === undefined && opts.grep === undefined;
}

/** The text column a folding read selects: a tool row's head, any other row whole. */
function foldTextColumn(alias = ''): string {
  return `CASE WHEN ${alias}role = 'tool' THEN substr(${alias}text, 1, ${TOOL_HEAD_CHARS}) ELSE ${alias}text END`;
}

/**
 * Fold each run of consecutive tool rows into one row, in whichever order the rows came.
 *
 * Why the default read folds: a conversation's tool calls outnumber everything else in it — 94% of
 * the rows recorded 11-04 to 11-06 — so an unfolded read of a working session is a page of commands
 * with the person's words somewhere in it, and the 500-row bound was usually spent before the
 * conversation got going. A run breaks at any other row and where the turn or kind changes, so a
 * fold never hides a turn boundary. One call stays one row, cut to its first line; a longer run
 * becomes `[37 tool calls: Bash ×20, Edit ×12, Write ×5]`, carrying the run's oldest id (what
 * `--around` takes) and, as `last_id`, its newest (what a `--since` read resumes after). Every
 * folded row is marked `folded_run`, so a read says it folded only when it returns one.
 */
function foldToolRuns(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let run: Array<Record<string, unknown>> = [];
  const flush = (): void => {
    if (run.length === 0) return;
    out.push(foldedRun(run));
    run = [];
  };
  for (const row of rows) {
    if (row.role !== 'tool') {
      flush();
      out.push(row);
      continue;
    }
    const prev = run[run.length - 1];
    if (prev && (prev.turn_ref !== row.turn_ref || prev.kind !== row.kind)) flush();
    run.push(row);
  }
  flush();
  return out;
}

/** Whether any row a read is returning is a folded run — the only time FOLD_NOTE is said. */
function anyFolded(rows: Array<Record<string, unknown>>): boolean {
  return rows.some((r) => r.folded_run === 1);
}

/** One run as one row: its oldest row's fields, its newest id, and a line naming what ran. */
function foldedRun(run: Array<Record<string, unknown>>): Record<string, unknown> {
  const ids = run.map((r) => Number(r.id));
  const first = run.reduce((a, b) => (Number(b.id) < Number(a.id) ? b : a));
  const last = Math.max(...ids);
  if (run.length === 1) return { ...first, text: firstLine(String(first.text ?? '')), last_id: last, folded_run: 1 };
  const counts = new Map<string, number>();
  for (const row of [...run].sort((a, b) => Number(a.id) - Number(b.id))) {
    const name = toolNameOf(String(row.text ?? ''));
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const named = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = named.slice(0, FOLD_NAMES).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  const rest = named.length > FOLD_NAMES ? `, +${named.length - FOLD_NAMES} more` : '';
  return { ...first, text: `[${run.length} tool calls: ${shown.join(', ')}${rest}]`, last_id: last, folded_run: 1 };
}

/** How many tool names a folded line spells out. */
const FOLD_NAMES = 6;

function firstLine(text: string): string {
  const end = text.indexOf('\n');
  return end < 0 ? text : text.slice(0, end);
}

/** `Bash` from `Bash: git status`, and from a sub-agent's `reviewer · Bash: …`. */
function toolNameOf(text: string): string {
  const line = firstLine(text);
  const colon = line.indexOf(': ');
  const who = colon < 0 ? line : line.slice(0, colon);
  const dot = who.lastIndexOf(' · ');
  const name = (dot < 0 ? who : who.slice(dot + 3)).trim();
  return name.length > 40 ? `${name.slice(0, 39)}…` : name || 'tool';
}

/** Whether any of the read filters that select rows was given. */
function hasReadFilter(opts: HistoryReadOptions): boolean {
  return (
    opts.role !== undefined ||
    opts.turn !== undefined ||
    opts.turns !== undefined ||
    opts.since !== undefined ||
    opts.grep !== undefined ||
    opts.tail !== undefined ||
    opts.limit !== undefined
  );
}

/**
 * Refuse `--since` beside the newest-end filters. They read from the newest end while a since read
 * resumes forward from an id; answering one of the two would silently drop the other.
 */
function assertSinceDirection(opts: HistoryReadOptions): void {
  if (
    opts.since !== undefined &&
    (opts.turn !== undefined || opts.turns !== undefined || opts.tail !== undefined || opts.limit !== undefined)
  ) {
    throw new Error(
      '--since resumes forward from a message id; it cannot be combined with --turn, --turns, --tail or --limit, which read from the newest end'
    );
  }
}

/**
 * The sentence a filtered read adds when a bound cut it — said, never silent. A since read also
 * gets the id to pass back: it resumes from a watermark, so its cut is only safe to make if the
 * next call can pick up exactly where this one stopped.
 */
function readNote(more: boolean, dropped: number, newestFirst: boolean, resumeFrom?: number): string | undefined {
  const notes: string[] = [];
  if (more) {
    notes.push(
      `More than ${READ_ALL_LIMIT} messages match; the ${newestFirst ? 'newest' : 'oldest'} ${READ_ALL_LIMIT} are shown.`
    );
  }
  if (dropped > 0) {
    notes.push(
      `${dropped} ${newestFirst ? 'older' : 'later'} message(s) were left out to keep the answer under ${READ_CHAR_BUDGET} characters.`
    );
  }
  if (notes.length === 0) return undefined;
  if (resumeFrom !== undefined) return `${notes.join(' ')} Continue with --since ${resumeFrom}.`;
  return `${notes.join(' ')} Narrow the read with --turn, --turns, --since, --grep or --tail.`;
}

/**
 * Stop at the character budget from the NEWEST end (the input is oldest-first), so a tail read
 * keeps the rows nearest now. Always keeps one row, for the reason capRead does.
 */
function capTail<T extends { text: string }>(messages: T[]): { messages: T[]; dropped: number } {
  let total = 0;
  const kept: T[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (kept.length > 0 && total + message.text.length > READ_CHAR_BUDGET) break;
    kept.push(message);
    total += message.text.length;
  }
  kept.reverse();
  return { messages: kept, dropped: messages.length - kept.length };
}

/**
 * Stop at the character budget, always keeping the first row (a single long reply is the answer
 * the caller asked for, not a reason to return nothing). Returns how many were dropped so the
 * caller can say so.
 */
function capRead<T extends { text: string }>(messages: T[]): { messages: T[]; dropped: number } {
  let total = 0;
  const kept: T[] = [];
  for (const message of messages) {
    if (kept.length > 0 && total + message.text.length > READ_CHAR_BUDGET) break;
    kept.push(message);
    total += message.text.length;
  }
  return { messages: kept, dropped: messages.length - kept.length };
}

function sessionRow(row: Record<string, unknown>): HistorySessionRow {
  return {
    id: Number(row.id),
    key: String(row.key ?? ''),
    platform: String(row.platform ?? ''),
    title: String(row.title ?? ''),
    agent: String(row.agent ?? ''),
    host: String(row.host ?? ''),
    cwd: String(row.cwd ?? ''),
    kind: String(row.kind ?? 'normal'),
    startedAt: iso(Number(row.started_at)),
    lastAt: iso(Number(row.last_at)),
    messages: Number(row.messages ?? 0),
  };
}

/** One `reviews` row, as the LEFT JOIN above aliases it. Corrupt JSON degrades to an empty list. */
function reviewRecordRow(row: Record<string, unknown>): HistoryReviewRecord {
  return {
    reviewedKey: String(row.reviewed_key ?? ''),
    reviewedTitle: String(row.reviewed_title ?? ''),
    platform: String(row.review_platform ?? ''),
    ...(row.review_channel ? { channel: String(row.review_channel) } : {}),
    ...(row.review_thread ? { thread: String(row.review_thread) } : {}),
    outcome: String(row.review_outcome ?? 'nothing') as HistoryReviewOutcome,
    changes: jsonArray<HistoryReviewChange>(row.review_changes),
    preferences: jsonArray<string>(row.review_preferences),
    invalid: jsonArray<string>(row.review_invalid),
    ...(row.review_error ? { error: String(row.review_error) } : {}),
    at: Number(row.review_at ?? 0),
  };
}

function jsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
