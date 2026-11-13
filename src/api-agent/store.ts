/**
 * Session state on disk: which server-side interaction a conversation continues.
 *
 * ACP hands the agent a `sessionId` and, on a restart, a `session/load` for it; the HTTP API knows
 * the conversation by its own ids. This store is the map between the two, and it is the reason a
 * daemon restart does not lose context — the harness process is gone, but `lastInteractionId` and
 * `environmentId` survive it.
 *
 * **One file per session**, `<configDir>/api-agent/<backend>/<sessionId>.json`. A single JSON map
 * was the first shape and it was wrong: every agent process of the same backend writes the whole
 * file, so two agents (two conversations, or a second agent id on the same backend) overwrite each
 * other's sessions on every turn. A file per session has no shared state to lose.
 *
 * It lives under `<configDir>` because that is the only path the gateway's container mounts as a
 * volume (see `docs/agents.md`); anywhere else would be lost on `fleetherd update`, which recreates
 * the container. Files are 0600: an interaction id is a handle to the conversation's content, and
 * on a shared machine that is not public.
 *
 * Files older than seven days (by mtime) are removed. The API keeps an interaction for a day on
 * the free tier and an environment for seven (probed 2026-11-13, `agent-antigravity-probe`), so a
 * record past that points at something that cannot be resumed anyway — keeping it would only turn
 * the next turn into a failed continuation.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** How long a record may sit unused before it is dropped. Matches the environment TTL. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Session ids are UUIDs from `session/new`; anything else must not become a path. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SessionRecord {
  /** The ACP session id this record belongs to. */
  sessionId: string;
  /** The last interaction the API created for this conversation; the next turn continues it. */
  lastInteractionId?: string;
  /** The sandbox the interaction ran in. Sent back with the continuation. */
  environmentId?: string;
  /** The `/model` choice, kept per session so a restart does not silently reset it. */
  model?: string;
  /** Epoch ms of the last write, for pruning. */
  updatedAt: number;
}

interface StoreFile {
  version: 1;
  session: SessionRecord;
}

export interface SessionStoreOptions {
  /** Directory holding one JSON file per session. */
  dir: string;
  /** Injected for tests; epoch ms. */
  now?: () => number;
  /** Injected for tests. */
  ttlMs?: number;
  /** Diagnostics go to stderr, never stdout: stdout is the ACP transport. */
  log?: (line: string) => void;
}

/**
 * Read-modify-write over one small file per session.
 *
 * Writes are synchronous and atomic (temp file + rename). A record is a handful of ids, and a
 * write happens at most a few times per turn, so the event-loop cost is noise; a queued async
 * writer would buy nothing and add a way for the last write of a dying process to be lost. Rename
 * within the same directory is atomic on POSIX, so a crash leaves either the old file or the new
 * one, never a truncated one.
 */
export class SessionStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly log: (line: string) => void;
  private readonly cache = new Map<string, SessionRecord>();

  constructor(options: SessionStoreOptions) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    this.log = options.log ?? ((line) => console.error(line));
    this.prune();
  }

  /** Read a session, from the cache or from its file (the `session/load` path after a restart). */
  get(sessionId: string): SessionRecord | undefined {
    const cached = this.cache.get(sessionId);
    if (cached) return { ...cached };
    const loaded = this.read(sessionId);
    if (loaded) this.cache.set(sessionId, loaded);
    return loaded ? { ...loaded } : undefined;
  }

  /** Insert or replace a record and persist. `updatedAt` is stamped here, not by the caller. */
  put(record: Omit<SessionRecord, 'updatedAt'>): SessionRecord {
    const stored: SessionRecord = { ...record, updatedAt: this.now() };
    this.cache.set(stored.sessionId, stored);
    this.write(stored);
    this.prune();
    return { ...stored };
  }

  /**
   * Update only the fields named, keeping the rest — the model in particular.
   *
   * A turn starts with a snapshot of the session (its model among it) and may run while `/model`
   * changes the record. Writing the snapshot back would undo that switch, so every mid-turn write
   * goes through here and names only what it learned.
   */
  patch(sessionId: string, fields: Pick<Partial<SessionRecord>, 'lastInteractionId' | 'environmentId'>): SessionRecord {
    const current = this.get(sessionId);
    return this.put({
      sessionId,
      model: current?.model,
      lastInteractionId: fields.lastInteractionId ?? current?.lastInteractionId,
      environmentId: fields.environmentId ?? current?.environmentId,
    });
  }

  /** Drop the continuation ids after an expired context, keeping the model choice. */
  clearContext(sessionId: string): SessionRecord {
    const current = this.get(sessionId);
    return this.put({ sessionId, model: current?.model });
  }

  /** Remove a session and its file. */
  delete(sessionId: string): void {
    this.cache.delete(sessionId);
    try {
      rmSync(this.fileOf(sessionId), { force: true });
    } catch (err) {
      this.log(`[api-agent] cannot remove session state ${this.fileOf(sessionId)}: ${messageOf(err)}`);
    }
  }

  private fileOf(sessionId: string): string {
    if (!SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
      throw new Error(`invalid session id "${sessionId}"`);
    }
    return path.join(this.dir, `${sessionId}.json`);
  }

  private read(sessionId: string): SessionRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.fileOf(sessionId), 'utf8');
    } catch (err) {
      // ENOENT is normal (a new session, or one pruned after seven days).
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`[api-agent] cannot read session state ${this.fileOf(sessionId)}: ${messageOf(err)}`);
      }
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      const record = parsed.session;
      if (!record || typeof record !== 'object') return undefined;
      return { ...record, sessionId, updatedAt: Number(record.updatedAt) || 0 };
    } catch (err) {
      // A corrupt file must not keep the agent from starting: the cost is lost context, which the
      // next turn rebuilds, not a broken conversation. It is overwritten on the next write.
      this.log(`[api-agent] session state ${this.fileOf(sessionId)} is not valid JSON (${messageOf(err)}); ignoring it`);
      return undefined;
    }
  }

  private write(record: SessionRecord): void {
    const file = this.fileOf(record.sessionId);
    const body: StoreFile = { version: 1, session: record };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      // Losing the write costs the next turn its context, not this one its answer — say so and
      // carry on rather than failing a turn that already ran.
      this.log(`[api-agent] cannot write session state ${file}: ${messageOf(err)}`);
    }
  }

  /** Remove files (and cache entries) whose mtime is past the TTL. */
  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return; // no directory yet
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const sessionId = name.slice(0, -'.json'.length);
      let mtime: number;
      try {
        mtime = statSync(path.join(this.dir, name)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoff) {
        try {
          rmSync(path.join(this.dir, name), { force: true });
          this.cache.delete(sessionId);
        } catch (err) {
          this.log(`[api-agent] cannot prune session state ${name}: ${messageOf(err)}`);
        }
      }
    }
    for (const [sessionId, record] of this.cache) {
      if (record.updatedAt < cutoff) this.cache.delete(sessionId);
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
