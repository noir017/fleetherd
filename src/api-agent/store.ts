/**
 * Session state on disk: which server-side interaction a conversation continues.
 *
 * ACP hands the agent a `sessionId` and, on a restart, a `session/load` for it; the HTTP API knows
 * the conversation by its own ids. This store is the map between the two, and it is the reason a
 * daemon restart does not lose context — the harness process is gone, but `lastInteractionId` and
 * `environmentId` survive it.
 *
 * It lives under `<configDir>/api-agent/` because that is the only path the gateway's container
 * mounts as a volume (see `docs/agents.md`); anywhere else would be lost on `fleetherd update`,
 * which recreates the container. The file is 0600: an interaction id is a handle to the
 * conversation's content, and on a shared machine that is not public.
 *
 * Records older than seven days are dropped. The API keeps an interaction for a day on the free
 * tier and an environment for seven (probed 2026-11-13, `agent-antigravity-probe`), so a record
 * past that points at something that cannot be resumed anyway — keeping it would only turn the
 * next turn into a failed continuation.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** How long a record may sit unused before it is dropped. Matches the environment TTL. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  sessions: Record<string, Omit<SessionRecord, 'sessionId'>>;
}

export interface SessionStoreOptions {
  /** Absolute path of the JSON file. */
  file: string;
  /** Injected for tests; epoch ms. */
  now?: () => number;
  /** Injected for tests. */
  ttlMs?: number;
  /** Diagnostics go to stderr, never stdout: stdout is the ACP transport. */
  log?: (line: string) => void;
}

/**
 * Read-modify-write over one small JSON file.
 *
 * Writes are synchronous and atomic (temp file + rename). The file holds a handful of ids, and a
 * write happens at most a few times per turn, so the event-loop cost is noise; a queued async
 * writer would buy nothing and add a way for the last write of a dying process to be lost. Rename
 * within the same directory is atomic on POSIX, so a crash leaves either the old file or the new
 * one, never a truncated one.
 */
export class SessionStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly log: (line: string) => void;
  private sessions = new Map<string, SessionRecord>();

  constructor(options: SessionStoreOptions) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    this.log = options.log ?? ((line) => console.error(line));
    this.load();
  }

  get(sessionId: string): SessionRecord | undefined {
    const record = this.sessions.get(sessionId);
    return record ? { ...record } : undefined;
  }

  /** Insert or replace a record and persist. `updatedAt` is stamped here, not by the caller. */
  put(record: Omit<SessionRecord, 'updatedAt'>): SessionRecord {
    const stored: SessionRecord = { ...record, updatedAt: this.now() };
    this.sessions.set(stored.sessionId, stored);
    this.prune();
    this.persist();
    return { ...stored };
  }

  delete(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.persist();
  }

  /** For tests and for `doctor`-style inspection. */
  size(): number {
    return this.sessions.size;
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      // ENOENT is the normal first run; anything else is worth a line but not a failed start.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`[api-agent] cannot read session state ${this.file}: ${messageOf(err)}`);
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      for (const [sessionId, value] of Object.entries(parsed.sessions ?? {})) {
        if (!value || typeof value !== 'object') continue;
        this.sessions.set(sessionId, { ...value, sessionId, updatedAt: Number(value.updatedAt) || 0 });
      }
    } catch (err) {
      // A corrupt file must not keep the agent from starting: the cost is lost context, which the
      // next turn rebuilds, not a broken conversation. It is overwritten on the next write.
      this.log(`[api-agent] session state ${this.file} is not valid JSON (${messageOf(err)}); starting empty`);
      this.sessions.clear();
      return;
    }
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [sessionId, record] of this.sessions) {
      if (record.updatedAt < cutoff) this.sessions.delete(sessionId);
    }
  }

  private persist(): void {
    const sessions: StoreFile['sessions'] = {};
    for (const [sessionId, { sessionId: _ignored, ...rest }] of this.sessions) sessions[sessionId] = rest;
    const body: StoreFile = { version: 1, sessions };
    const dir = path.dirname(this.file);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      // Losing the write costs the next turn its context, not this one its answer — say so and
      // carry on rather than failing a turn that already ran.
      this.log(`[api-agent] cannot write session state ${this.file}: ${messageOf(err)}`);
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
