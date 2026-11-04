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
 * Three tables: `sessions` (one per conversation, with platform, title, agent, host,
 * directory, kind and its span), `messages` (one row per prompt, reply or tool call), and
 * `messages_fts` (the same text, tokenised for search — see tokenize.ts for why Chinese is
 * split in JS first). `imported` records the web UI transcripts already folded in, so the
 * import runs once per file rather than once per start.
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

export interface HistoryReadResult {
  session: HistorySessionRow;
  messages: Array<{ id: number; at: string; role: string; kind: string; text: string }>;
  /** What was left out, when a bound cut it — said so nobody reads a partial log as whole. */
  note?: string;
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
          text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, ts, id);
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, tokenize = 'unicode61');
        CREATE TABLE IF NOT EXISTS imported (
          source TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          session_id INTEGER NOT NULL,
          messages INTEGER NOT NULL
        );
      `);
      this.lockDown();
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e);
      this.db = undefined;
      this.log(`[history] could not open ${file}: ${this.failure}; conversations are not being recorded`);
    }
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
   * One conversation: all of it, or a window around one message. `around` is a message id
   * from a search hit; `window` is how many messages on each side (default 10).
   */
  read(sessionRef: string, opts: { around?: number; window?: number } = {}): HistoryReadResult {
    const db = this.requireDb();
    const session = this.findSession(sessionRef);
    if (!session) throw new Error(`no conversation "${sessionRef}"; \`talkcode sessions list\` shows the ids`);
    if (opts.around === undefined) {
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
    const anchor = db
      .prepare('SELECT id, ts FROM messages WHERE id = ? AND session_id = ?')
      .get(opts.around, session.id) as { id: number; ts: number } | undefined;
    if (!anchor) throw new Error(`message ${opts.around} is not in conversation ${session.id}`);
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
      .prepare('INSERT INTO messages (session_id, ts, role, kind, text) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, msg.ts, msg.role, msg.kind, msg.text);
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

function messageRow(row: Record<string, unknown>): { id: number; at: string; role: string; kind: string; text: string } {
  return {
    id: Number(row.id),
    at: iso(Number(row.ts)),
    role: String(row.role ?? ''),
    kind: String(row.kind ?? ''),
    text: String(row.text ?? ''),
  };
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
