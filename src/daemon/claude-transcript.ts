import fs from 'node:fs';
import path from 'node:path';

import type { AgentDef } from '../config/schema.js';
import { expandEnv, expandHome, expandRemoteHome, remoteAgentHome } from './agent-common.js';
import type { Welcome } from '../remote/connection.js';
import type { RemoteHost } from '../remote/host.js';
import { agentHome } from './skills-scan.js';

/**
 * When a Claude Code session's prompt cache expires, read off the session's own transcript.
 *
 * ── Why the transcript ────────────────────────────────────────────────────────
 * It is the only place the answer exists in this deployment. Claude Code's TUI hands its status
 * line a `prompt_cache.expires_at`, but the SDK under claude-agent-acp runs Claude Code headless,
 * and headless it never runs a status line at all: probed on 2.1.291 (2026-10-08) with
 * `-p --output-format stream-json` and a `statusLine` naming a recording script, a whole turn
 * produced zero invocations. ACP carries no TTL either — claude-agent-acp 0.81.0 sends
 * `{used, size, cost}` in `usage_update` and folds cache writes into one number in
 * `PromptResponse._meta.quota`, dropping the 5-minute/1-hour split.
 *
 * The transcript keeps that split. Every assistant entry carries the API's own usage block,
 *
 *   "usage": { "cache_read_input_tokens": 253742, "cache_creation_input_tokens": 718,
 *              "cache_creation": { "ephemeral_1h_input_tokens": 718, "ephemeral_5m_input_tokens": 0 } }
 *
 * and every entry a `timestamp`. That is everything "when does this expire" needs.
 *
 * Hyrum's Law applies, and harder than usual: this is Claude Code's private on-disk format, not an
 * interface. The file is `<config dir>/projects/<cwd with every non-alphanumeric as '-'>/<session
 * id>.jsonl`, and the ACP session id IS that file name (verified 2026-10-08 against all 27 cc
 * sessions in this machine's conversation store, resumed ones included). The day either changes,
 * `readCacheExpiry` finds nothing and the status bar loses its cache segment — it shows nothing
 * rather than something wrong, and claude-transcript.test.ts pins the shape with a captured entry.
 *
 * ── What "expires" means ──────────────────────────────────────────────────────
 * A cached prefix lives one TTL past its last use, and every request either reads it or writes it.
 * So the expiry is the time of the session's LAST REQUEST plus the TTL that prefix was written
 * with. Two details make that more than "last timestamp + 1h":
 *
 *  - The request time is not the assistant entry's timestamp, which is written when the response
 *    ARRIVES. A response that thought for 52 seconds (measured on this machine's own transcript)
 *    would push the expiry 52 seconds past the truth, which on a 5-minute TTL is a sixth of it.
 *    The request went out right after the entry before it — the user's prompt or the tool result
 *    being answered — so that entry's timestamp is used.
 *  - A request that only READ the cache wrote nothing, so its usage names no TTL. It still renewed
 *    the prefix it read, at whatever TTL that prefix was written with, so the TTL is taken from the
 *    most recent request that did write.
 */

/** The two TTLs the API offers for an ephemeral cache entry. */
const TTL_1H_MS = 60 * 60 * 1000;
const TTL_5M_MS = 5 * 60 * 1000;

/**
 * How much of the transcript's end is read. A transcript is append-only and grows to megabytes, and
 * everything this needs is in its last few entries — but one entry can be large (a tool result
 * holding a whole file), so the window is generous rather than tight.
 */
const TAIL_BYTES = 1024 * 1024;

/** What one read of the transcript established. */
export interface CacheReading {
  /** When the cache expires, epoch ms. */
  expiresAt: number;
  /** The TTL it was written with — kept so a request seen live can be projected without a read. */
  ttlMs: number;
}

/** The fields of a transcript entry this reads. Everything else in it is ignored. */
interface Entry {
  type?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  message?: {
    id?: unknown;
    usage?: {
      input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_creation?: { ephemeral_1h_input_tokens?: unknown; ephemeral_5m_input_tokens?: unknown };
    };
  };
}

/**
 * The cache expiry implied by the end of a transcript, from its lines in file order. Pure — the
 * tests drive it with captured entries. Undefined when the tail holds no request that touched the
 * cache, which includes a format this no longer understands.
 */
export function cacheExpiryFromLines(lines: string[]): CacheReading | undefined {
  const entries = lines.map(parseEntry).filter((e): e is Entry => e !== undefined && e.isSidechain !== true);
  const last = findLastRequest(entries);
  if (last === undefined) return undefined;
  const ttlMs = ttlFrom(entries, last);
  if (ttlMs === undefined) return undefined;
  const sentAt = requestTime(entries, last);
  return sentAt === undefined ? undefined : { expiresAt: sentAt + ttlMs, ttlMs };
}

function parseEntry(line: string): Entry | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Entry) : undefined;
  } catch {
    return undefined;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Index of the last assistant entry that came from a real request — one whose usage shows it
 * touched the API. Claude Code also writes assistant entries of its own (an API error reported as a
 * message, model `<synthetic>`) whose usage is all zeros; no request renewed anything there.
 */
function findLastRequest(entries: Entry[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== 'assistant') continue;
    const u = e.message?.usage;
    if (!u) continue;
    if (num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) > 0) return i;
  }
  return undefined;
}

/**
 * The TTL in force after the request at `from`: that of the latest cache WRITE at or before it.
 * Undefined when the request neither read nor wrote the cache (nothing is cached), or when no write
 * is in the window to name the TTL.
 */
function ttlFrom(entries: Entry[], from: number): number | undefined {
  const u = entries[from]!.message!.usage!;
  if (num(u.cache_read_input_tokens) === 0 && num(u.cache_creation_input_tokens) === 0) return undefined;
  for (let i = from; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== 'assistant') continue;
    const split = e.message?.usage?.cache_creation;
    if (num(split?.ephemeral_1h_input_tokens) > 0) return TTL_1H_MS;
    if (num(split?.ephemeral_5m_input_tokens) > 0) return TTL_5M_MS;
  }
  return undefined;
}

/**
 * When the request answered at `at` went out: the timestamp of the entry the request was answering
 * (a prompt or a tool result). One response is often several entries — thinking, text and tool use
 * are written separately under one `message.id` — so the walk first steps back over the response's
 * own entries. Falls back to the response's own time when the window holds nothing earlier.
 */
function requestTime(entries: Entry[], at: number): number | undefined {
  const id = entries[at]!.message?.id;
  let first = at;
  while (first > 0) {
    const prev = entries[first - 1]!;
    if (prev.type !== 'assistant' || id === undefined || prev.message?.id !== id) break;
    first--;
  }
  for (let i = first - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'user') return timeOf(e) ?? timeOf(entries[first]!);
    // Anything else between (attachments, bookkeeping) is not what the request answered; keep looking.
    if (e.type === 'assistant') break;
  }
  return timeOf(entries[first]!);
}

function timeOf(e: Entry): number | undefined {
  if (typeof e.timestamp !== 'string') return undefined;
  const t = Date.parse(e.timestamp);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Claude Code's projects directory for an agent: `CLAUDE_CONFIG_DIR` when the agent's environment
 * sets one (its `env` block first, then the daemon's own), else `.claude` under the agent's home.
 */
export function claudeProjectsDir(def: AgentDef): string {
  const configured = def.env['CLAUDE_CONFIG_DIR'] !== undefined ? expandEnv(def.env['CLAUDE_CONFIG_DIR']) : process.env.CLAUDE_CONFIG_DIR;
  const base = configured ? expandHome(configured) : path.join(agentHome(def), '.claude');
  return path.join(base, 'projects');
}

/**
 * The same directory for an agent on a remote host: its `env` block's CLAUDE_CONFIG_DIR, else
 * `.claude` under its home there. A CLAUDE_CONFIG_DIR exported by the host's own shell rc is not
 * visible from here; the cache segment is then simply absent, the documented way this degrades.
 */
export function remoteClaudeProjectsDir(def: AgentDef, w: Welcome): string {
  const configured = def.env['CLAUDE_CONFIG_DIR'];
  const base = configured ? expandRemoteHome(expandEnv(configured), w.home) : path.posix.join(remoteAgentHome(def, w), '.claude');
  return path.posix.join(base, 'projects');
}

/**
 * The transcript fields cacheExpiryFromLines reads (Entry). Asked of the host by name, so a window
 * that is mostly tool output — a whole file in one result — crosses the network as a few hundred
 * bytes per entry instead of the megabyte it is on disk.
 */
const ENTRY_FIELDS = ['type', 'timestamp', 'isSidechain', 'message.id', 'message.usage'];

/**
 * readCacheExpiry for a session whose Claude Code runs on a remote host. Never rejects, like the
 * local one; and gives up quickly rather than waiting out an outage — a status bar can wait for
 * the next turn.
 */
export async function readRemoteCacheExpiry(
  host: RemoteHost,
  projectsDir: string,
  cwd: string,
  sessionId: string
): Promise<CacheReading | undefined> {
  if (!SESSION_ID.test(sessionId) || !host.isUp) return undefined;
  const file = path.posix.join(projectsDir, projectSlug(cwd), `${sessionId}.jsonl`);
  try {
    const tail = await host.readTail(file, TAIL_BYTES, { fields: ENTRY_FIELDS, timeoutMs: 10_000 });
    return cacheExpiryFromLines(tail.split('\n'));
  } catch (e) {
    console.debug(`[status] could not read the claude transcript for ${sessionId} on ${host.id}:`, e instanceof Error ? e.message : e);
    return undefined;
  }
}

/** The directory name Claude Code files a working directory's transcripts under. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Session ids are only ever this daemon's own (from the conversation store), but one becomes part
 * of a path below, so anything that is not id-shaped is refused rather than joined.
 */
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Where each session's transcript was last found, so the directory scan below runs once per
 * session rather than once per turn. Bounded, as everything kept for the life of the daemon is.
 */
const found = new Map<string, string>();
const MAX_REMEMBERED = 256;

/**
 * Locate a session's transcript. The slug is tried first; when it misses — Claude Code shortens
 * very long directory names, and has changed the rule before — every project directory is asked
 * for the file instead, which still finds it by the one thing that is certainly in the name.
 */
export async function findTranscript(projectsDir: string, cwd: string, sessionId: string): Promise<string | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const key = `${projectsDir}\0${sessionId}`;
  const known = found.get(key);
  if (known && (await exists(known))) return known;

  const name = `${sessionId}.jsonl`;
  const direct = path.join(projectsDir, projectSlug(cwd), name);
  let hit: string | undefined = (await exists(direct)) ? direct : undefined;
  if (!hit) {
    let dirs: string[] = [];
    try {
      dirs = await fs.promises.readdir(projectsDir);
    } catch {
      return undefined;
    }
    for (const dir of dirs) {
      const candidate = path.join(projectsDir, dir, name);
      if (await exists(candidate)) {
        hit = candidate;
        break;
      }
    }
  }
  if (hit) {
    if (found.size >= MAX_REMEMBERED) found.delete(found.keys().next().value!);
    found.set(key, hit);
  }
  return hit;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the cache expiry for one session. Never rejects: an unreadable transcript is the documented
 * way for this to stop working (see the Hyrum's Law note above), and it must cost a segment of a
 * status bar, not a turn.
 */
export async function readCacheExpiry(projectsDir: string, cwd: string, sessionId: string): Promise<CacheReading | undefined> {
  try {
    const file = await findTranscript(projectsDir, cwd, sessionId);
    if (!file) return undefined;
    return cacheExpiryFromLines(await readTailLines(file, TAIL_BYTES));
  } catch (e) {
    console.debug(`[status] could not read the claude transcript for ${sessionId}:`, e instanceof Error ? e.message : e);
    return undefined;
  }
}

/**
 * A file's last `max` bytes as lines — minus the first, which the window may have cut in half. The
 * local twin of RemoteHost.readTail; agy-transcript.ts reads agy's transcript with it too.
 */
export async function readTailLines(file: string, max: number): Promise<string[]> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}
