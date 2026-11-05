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
 * One turn as the library recorded it: what `task-read --turn last` shows, and the record a cut
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
}

/** What one review reads: a tail of a conversation plus the two facts its trigger decides on. */
export interface ReviewWindow {
  session: HistorySessionRow;
  /** Oldest first, at most `maxChars` characters in total (the newest row is always kept). */
  messages: Array<{ id: number; at: string; role: string; kind: string; text: string }>;
  /** The person's own messages in the span, before any character cut. */
  userMessages: number;
  /** The newest message in the conversation — where the next review starts. */
  lastMessageId: number;
  /** How many older messages the character budget left out. */
  dropped: number;
}

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_LIST_LIMIT = 30;
const DEFAULT_LIST_DAYS = 7;
/** How much of one session `read` returns when no window was asked for. */
const READ_ALL_LIMIT = 500;

/**
 * How many characters of text `read` returns in one answer.
 *
 * The reply row is capped at 200k characters, so a 500-message conversation could otherwise be
 * a hundred-megabyte IPC line. This is the same budget `task-read` uses: enough for the whole of
 * an ordinary conversation, with a note pointing at `--around` when it is not.
 */
const READ_CHAR_BUDGET = 200_000;

/**
 * How many messages `reviewWindow` reads before the character budget is applied. A review runs
 * after a few messages, so this only bounds the pathological case (a conversation nobody reviewed
 * for months): the newest few hundred are what a reviewer can still act on.
 */
const REVIEW_WINDOW_ROWS = 500;

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
          turn INTEGER
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
   * `messages.turn` is the only column a previous version lacks: `CREATE TABLE IF NOT EXISTS`
   * cannot add it to an existing table, and a migration that back-filled it would be inventing
   * turn boundaries nobody recorded. So the column is added NULL and old rows stay NULL — read
   * as "unknown" (see HistoryReadMessage) rather than guessed at.
   */
  private migrate(): void {
    const db = this.db;
    if (!db) return;
    const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'turn')) db.exec('ALTER TABLE messages ADD COLUMN turn INTEGER');
    // (session_id, turn), not (turn): every read starts from one conversation, and a turn number
    // is per-conversation. A bare `turn` index cannot narrow by session, so the planner falls back
    // to messages_session and walks the conversation's whole tail to prove there is no later row.
    db.exec('CREATE INDEX IF NOT EXISTS messages_session_turn ON messages(session_id, turn)');
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
   * looking for), then by BM25, then newest first.
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

  /** The whole conversation, oldest first, bounded by rows and characters. */
  private readAll(session: HistorySessionRow): HistoryReadResult {
    const db = this.requireDb();
    const rows = db
      .prepare('SELECT id, ts, role, kind, text FROM messages WHERE session_id = ? ORDER BY ts, id LIMIT ?')
      .all(session.id, READ_ALL_LIMIT + 1) as Array<Record<string, unknown>>;
    const more = rows.length > READ_ALL_LIMIT;
    const all = (more ? rows.slice(0, READ_ALL_LIMIT) : rows).map(messageRow);
    const { messages, dropped } = capRead(all);
    const notes = [
      more ? `This conversation has more than ${READ_ALL_LIMIT} messages.` : '',
      dropped > 0 ? `${dropped} later message(s) were left out of this answer.` : '',
    ].filter(Boolean);
    return {
      session,
      messages,
      ...(notes.length > 0
        ? { note: `${notes.join(' ')} Read a window with --around <message>.` }
        : {}),
    };
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
    const { messages, more, dropped } = this.selectFiltered(where, params, tail ?? limit, newestFirst, order);
    // Where a since read continues from: the newest row it actually kept, after any cut.
    const resumeFrom = !newestFirst && opts.since !== undefined ? messages[messages.length - 1]?.id : undefined;
    const notes = [scope?.note, readNote(more, dropped, newestFirst, resumeFrom)].filter(
      (n): n is string => n !== undefined
    );
    return { session, messages, ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
  }

  /** Run the filtered query, and cut it from the end the filter is about (see readFiltered). */
  private selectFiltered(
    where: string[],
    params: Array<string | number>,
    cap: number | undefined,
    newestFirst: boolean,
    order: string
  ): { messages: HistoryReadMessage[]; more: boolean; dropped: number } {
    const db = this.requireDb();
    const limit = cap ?? READ_ALL_LIMIT + 1;
    const sql = `
      SELECT m.id AS id, m.ts AS ts, m.role AS role, m.kind AS kind, m.text AS text,
             m.turn AS turn_ref, t.seq AS turn_seq, t.outcome AS turn_outcome, t.agent AS turn_agent
      FROM messages m
      LEFT JOIN turns t ON t.id = m.turn
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit) as Array<Record<string, unknown>>;
    // A cap the caller asked for (`--tail`, `--limit`) is exactly how many rows it wanted, so
    // reaching it is not a cut worth a note. Only the default 500-row bound is reported.
    const more = cap === undefined && rows.length > READ_ALL_LIMIT;
    let selected = (more ? rows.slice(0, READ_ALL_LIMIT) : rows).map(readMessageRow);
    if (newestFirst) selected = selected.reverse();
    const { messages, dropped } = newestFirst ? capTail(selected) : capRead(selected);
    return { messages, more, dropped };
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
   * What a review reads of one conversation: the rows after the last review's watermark, cut to a
   * character budget from the newest end, plus the two facts the trigger needs — how many messages
   * the person sent in that span, and the id a review starts after next time.
   *
   * Scheduled turns and sub-agent turns are left out: they share a topic with a person's
   * conversation but are not what the person said. `review` rows are excluded for the same reason a
   * review is never reviewed. `background` output is kept — the agent said it in this conversation.
   *
   * The window is a TAIL, not a head: when a conversation is longer than the budget, the newest
   * messages are the ones a review can still act on, and `dropped` says how many were left out so
   * the prompt can say so rather than presenting a partial log as whole.
   */
  reviewWindow(key: string, afterId: number, maxChars: number): ReviewWindow | undefined {
    const db = this.requireDb();
    const session = this.findSession(key);
    if (!session) return undefined;
    const excluded = "kind NOT IN ('schedule', 'subagent', 'review')";
    const total = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND id > ? AND ${excluded}`)
          .get(session.id, afterId) as { n: number | bigint }
      ).n
    );
    const lastRow = db.prepare('SELECT MAX(id) AS id FROM messages WHERE session_id = ?').get(session.id) as
      | { id: number | bigint | null }
      | undefined;
    const userMessages = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND id > ? AND role = 'user' AND kind = 'normal'"
          )
          .get(session.id, afterId) as { n: number | bigint }
      ).n
    );
    // Newest first, so a long conversation is cut from its oldest end rather than its newest.
    const rows = db
      .prepare(
        `SELECT id, ts, role, kind, text FROM messages
         WHERE session_id = ? AND id > ? AND ${excluded}
         ORDER BY ts DESC, id DESC LIMIT ?`
      )
      .all(session.id, afterId, REVIEW_WINDOW_ROWS) as Array<Record<string, unknown>>;
    const newestFirst = rows.map(messageRow);
    const kept: typeof newestFirst = [];
    let chars = 0;
    for (const message of newestFirst) {
      if (kept.length > 0 && chars + message.text.length > maxChars) break;
      kept.push(message);
      chars += message.text.length;
    }
    return {
      session,
      messages: kept.reverse(),
      userMessages,
      lastMessageId: Number(lastRow?.id ?? afterId),
      dropped: total - kept.length,
    };
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
    const res = db
      .prepare('INSERT INTO messages (session_id, ts, role, kind, text, turn) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, msg.ts, msg.role, msg.kind, msg.text, msg.turn ?? null);
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
