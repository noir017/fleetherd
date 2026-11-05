import fs from 'node:fs';
import path from 'node:path';

/**
 * Persistent conversation state (`<configDir>/conversations.json`).
 *
 * Three things are remembered per conversation:
 *  - `agent`: which agent is currently answering it (the sticky binding).
 *  - `agentSessions`: for EACH agent that has ever answered it, that agent's OWN session id
 *    (an ACP sessionId, or agy's conversation id).
 *  - `cwd`: the directory this conversation works in (`/cd`), overriding `agents[].cwd`.
 *
 * ── Why the cwd is persisted here ─────────────────────────────────────────────
 * It is a property of the CONVERSATION, like the binding — "this topic is about quantlab" outlives
 * any one process, and the alternative (in-memory only) would silently move a topic back to the
 * agent's default root on the next daemon restart, which is the class of surprise this file exists
 * to prevent. It rides on the record rather than in a table of its own because it is read on the
 * same lookup as the binding, at spawn time.
 *
 * ── Why agentSessions is keyed by agent ───────────────────────────────────────
 * The agent owns its context; this gateway is just a chat client in front of it. So switching
 * `/oc` → `/cc` → `/oc` must RESUME opencode's existing thread, not start it over — the user's
 * task has to survive being interrupted by a question to another agent. Keeping one id per
 * agent is what makes that true. (The previous store held a single id under an
 * agent-qualified key, which worked only because switching agents also switched keys — and
 * that key switch is precisely the bug that made one topic behave like two conversations.)
 *
 * Nothing here stores conversation CONTENT. The harness (Claude Code, opencode, agy) keeps
 * the actual history on its own disk; this file only remembers which of its sessions belongs
 * where, so a daemon restart can reattach instead of starting blank.
 *
 * Write-through on every change; a missing/corrupt file degrades to empty (bindings lost, not
 * a crash — the agents' own histories are untouched either way).
 */

/** One conversation's persisted state. */
export interface ConversationRecord {
  /** The agent currently bound to this conversation. */
  agent: string;
  /** agentId → that agent's own session/conversation id. Never pruned except by /new. */
  agentSessions: Record<string, string>;
  /** Working directory chosen for this conversation (`/cd`); absent = the agent's configured cwd. */
  cwd?: string;
  /**
   * The title this conversation's chat lane was last renamed TO by us.
   *
   * Not the current title of the lane — nothing can read that back (the Bot API offers no
   * getForumTopic) — but a record of what we last set, which is the only thing needed to answer
   * "has this changed since". Persisted so a daemon restart does not re-issue the same rename to
   * every conversation it reattaches.
   */
  title?: string;
  /**
   * Whether the title was set by hand (`/title <name>`) and should stop following the harness.
   *
   * The one guard the automatic rename does have. Telegram cannot report a topic's current name,
   * so "did a human rename this in the Telegram UI" is unanswerable — but "did a human rename it
   * THROUGH ME" is, and an explicit command that gets silently reverted by the next turn is a bug
   * whatever the rename policy is. Cleared by `/title auto`.
   */
  titlePinned?: boolean;
  /**
   * Where this conversation was last answered: the platform instance and the address its last turn
   * ran at. What `talkcode channels` lists, so an agent can name a place to post to.
   *
   * Persisted rather than parsed back out of the key, because a key is opaque by design (see
   * core/conversation.ts KEY_SEP) and under `per_user` / `shared` it names no place at all.
   * Records written before this field existed have none; channel-list.ts reads their keys as a
   * one-off fallback and says so there.
   */
  lane?: { platform: string; channel: string; thread?: string };
  /** When a turn last started here (epoch ms). Orders the channel list; absent on older records. */
  lastAt?: number;
  /**
   * Set while a turn is running here (epoch ms it started), cleared when it ends. A record still
   * carrying one when the daemon starts is a turn the last daemon never finished — a drain that ran
   * out of time, or a crash — which is the only way that can be found out afterwards: nothing in the
   * harness's own history says the gateway stopped listening. See TurnOutcomes.recoverInterrupted.
   */
  inFlight?: number;
  /**
   * How many times this conversation's agent context has been discarded (`/new`, `/cd`). The
   * history library stamps every turn with it, which is what tells turns on either side of a
   * reset apart: the harness's own session id does not exist yet when a fresh session's first
   * turn starts, and a resumed one is only written after the turn is under way.
   *
   * Survives a restart (it is in this file), because the turns it labels do.
   */
  generation?: number;
}

export class ConversationStore {
  private map = new Map<string, ConversationRecord>();

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        const rec = toRecord(v);
        if (rec) this.map.set(k, rec);
      }
    } catch {
      /* first run or corrupt file: start empty */
    }
  }

  /**
   * Give agents new ids (agent-renames.ts): the binding and each agent's session id move with the
   * agent, so its conversations resume rather than start over. Returns how many records changed.
   */
  renameAgents(renames: ReadonlyMap<string, string>): number {
    let changed = 0;
    for (const rec of this.map.values()) {
      let touched = false;
      const next = renames.get(rec.agent);
      if (next) {
        rec.agent = next;
        touched = true;
      }
      for (const [from, to] of renames) {
        const session = rec.agentSessions[from];
        if (session === undefined) continue;
        delete rec.agentSessions[from];
        rec.agentSessions[to] ??= session;
        touched = true;
      }
      if (touched) changed++;
    }
    if (changed) this.flush();
    return changed;
  }

  /** The agent currently bound to this conversation, if any. */
  boundAgent(key: string): string | undefined {
    return this.map.get(key)?.agent;
  }

  /** Bind (or rebind) a conversation to an agent, preserving every recorded agent session. */
  bind(key: string, agentId: string): void {
    const rec = this.map.get(key);
    if (rec) {
      if (rec.agent === agentId) return;
      rec.agent = agentId;
    } else {
      this.map.set(key, { agent: agentId, agentSessions: {} });
    }
    this.flush();
  }

  /**
   * That agent's own session id in this conversation, if it has one.
   *
   * Keyed by BOTH, so claude is never handed opencode's session id — which would either fail
   * to load or, worse, resume a stranger's conversation.
   */
  agentSession(key: string, agentId: string): string | undefined {
    return this.map.get(key)?.agentSessions[agentId];
  }

  /** Record the agent-side session id for (conversation, agent). */
  setAgentSession(key: string, agentId: string, sessionId: string): void {
    const rec = this.map.get(key) ?? { agent: agentId, agentSessions: {} };
    if (rec.agentSessions[agentId] === sessionId) return;
    rec.agentSessions[agentId] = sessionId;
    this.map.set(key, rec);
    this.flush();
  }

  /**
   * Forget EVERY agent's session id in this conversation, keeping the binding and the cwd.
   *
   * The mechanism behind `/cd`, and the narrow counterpart of clear(): a session is pinned to the
   * directory it was created in (ACP takes `cwd` at `session/new`, agy at spawn), so resuming one
   * from a different directory would either fail to load or — worse — succeed and leave the agent
   * reasoning about a project it is no longer standing in. Dropping the ids is what makes the next
   * turn start a genuinely new session in the new place.
   *
   * Every agent's, not just the bound one's, because the directory belongs to the CONVERSATION:
   * a `/cd` followed later by `/oc` must not resume opencode's thread from the old project just
   * because opencode was not the agent that happened to be answering when the move was made.
   */
  clearAgentSessions(key: string): void {
    const rec = this.map.get(key);
    if (!rec || Object.keys(rec.agentSessions).length === 0) return;
    rec.agentSessions = {};
    this.flush();
  }

  /** The directory this conversation works in, if one was chosen (`/cd`). */
  conversationCwd(key: string): string | undefined {
    return this.map.get(key)?.cwd;
  }

  /** The generation a turn starting now belongs to (`/new` and `/cd` bump it). */
  conversationGeneration(key: string): number {
    return this.map.get(key)?.generation ?? 0;
  }

  /**
   * Record the generation of a conversation whose record was just recreated (`/new` clears it).
   * Takes the agentId for the same reason bind does: without a record there is nowhere to put it.
   */
  setGeneration(key: string, agentId: string, generation: number): void {
    const rec = this.map.get(key) ?? { agent: agentId, agentSessions: {} };
    if (rec.generation === generation) return;
    rec.generation = generation;
    this.map.set(key, rec);
    this.flush();
  }

  /** One more agent context discarded here (`/cd`, whose record is kept). Returns the new value. */
  bumpGeneration(key: string): number {
    const rec = this.map.get(key);
    if (!rec) return 0;
    rec.generation = (rec.generation ?? 0) + 1;
    this.flush();
    return rec.generation;
  }

  /**
   * Record this conversation's working directory. Pass undefined to fall back to `agents[].cwd`.
   *
   * Takes an agentId only to seed a record for a conversation the store has never seen — the cwd
   * belongs to the conversation, not to the agent, and survives a rebind: switching `/cc` → `/oc`
   * asks a different agent about the same project, which is the whole point of asking.
   */
  setConversationCwd(key: string, agentId: string, cwd: string | undefined): void {
    const rec = this.map.get(key) ?? { agent: agentId, agentSessions: {} };
    if (rec.cwd === cwd) return;
    if (cwd === undefined) delete rec.cwd;
    else rec.cwd = cwd;
    this.map.set(key, rec);
    this.flush();
  }

  /**
   * The title we last renamed this conversation's lane to, if we ever did.
   *
   * Load-bearing, not just a cache: a conversation is named once, and "has a title on record" is
   * exactly the condition that says it already happened. It also survives a restart, which is what
   * stops a daemon coming back up and re-naming every conversation it has on disk.
   */
  conversationTitle(key: string): string | undefined {
    return this.map.get(key)?.title;
  }

  /** Record the title this conversation's lane was renamed to. */
  setConversationTitle(key: string, agentId: string, title: string, pinned?: boolean): void {
    const rec = this.map.get(key) ?? { agent: agentId, agentSessions: {} };
    const wantPinned = pinned === true;
    if (rec.title === title && (rec.titlePinned ?? false) === wantPinned) return;
    rec.title = title;
    if (wantPinned) rec.titlePinned = true;
    else delete rec.titlePinned;
    this.map.set(key, rec);
    this.flush();
  }

  /**
   * Whether this conversation's name was typed by the user rather than generated.
   *
   * Reporting only: since naming happens once and only while no title is recorded, a recorded name
   * blocks the next one whoever wrote it. The flag is what lets `/title` say which of the two
   * happened instead of guessing.
   */
  titlePinned(key: string): boolean {
    return this.map.get(key)?.titlePinned === true;
  }

  /**
   * Forget this conversation's name (`/title auto`), so the next message names it afresh.
   *
   * The lane is deliberately NOT renamed here: it keeps the name it has until a new one exists,
   * because a topic briefly called nothing is worse than one briefly called the wrong thing.
   */
  releaseConversationTitle(key: string): void {
    const rec = this.map.get(key);
    if (!rec || (rec.title === undefined && rec.titlePinned === undefined)) return;
    delete rec.title;
    delete rec.titlePinned;
    this.flush();
  }

  /**
   * Record where and when a turn ran (see ConversationRecord.lane). Called once per turn, so it is
   * one write per turn — the same order as the session-id writes already made at spawn.
   */
  recordLane(
    key: string,
    agentId: string,
    platform: string,
    address: { channel: string; thread?: string },
    at: number
  ): void {
    const rec = this.map.get(key) ?? { agent: agentId, agentSessions: {} };
    rec.lane = {
      platform,
      channel: address.channel,
      ...(address.thread != null && address.thread !== '' ? { thread: address.thread } : {}),
    };
    rec.lastAt = at;
    this.map.set(key, rec);
    this.flush();
  }

  /**
   * Mark a turn as running here (`at`) or as over (undefined). See ConversationRecord.inFlight. A
   * no-op for a conversation with no record: a turn never starts before its binding is written.
   */
  setInFlight(key: string, at: number | undefined): void {
    const rec = this.map.get(key);
    if (!rec || rec.inFlight === at) return;
    if (at === undefined) delete rec.inFlight;
    else rec.inFlight = at;
    this.flush();
  }

  /** Every record, in insertion order (oldest conversation first). Read-only use: `channels`. */
  entries(): Array<[string, ConversationRecord]> {
    return [...this.map.entries()];
  }

  /**
   * Forget a conversation entirely — every agent's session id AND the binding.
   *
   * The only context-destroying path in the system, reached solely from an explicit `/new`.
   * It clears every agent's id, not just the bound one, because the topic IS the conversation:
   * "start fresh here" that left another agent's history to resurface on the next `/oc` would
   * be a surprise, not a reset.
   */
  clear(key: string): void {
    if (this.map.delete(key)) this.flush();
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2) + '\n');
    } catch (e) {
      console.warn('[conversations] failed to persist:', e instanceof Error ? e.message : e);
    }
  }
}

/** Validate one on-disk entry; anything malformed is dropped rather than trusted. */
function toRecord(v: unknown): ConversationRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as {
    agent?: unknown;
    agentSessions?: unknown;
    cwd?: unknown;
    title?: unknown;
    titlePinned?: unknown;
    lane?: unknown;
    lastAt?: unknown;
    inFlight?: unknown;
    generation?: unknown;
  };
  if (typeof o.agent !== 'string' || !o.agent) return null;
  const sessions: Record<string, string> = {};
  if (o.agentSessions && typeof o.agentSessions === 'object') {
    for (const [k, val] of Object.entries(o.agentSessions as Record<string, unknown>)) {
      if (typeof val === 'string') sessions[k] = val;
    }
  }
  const lane = toLane(o.lane);
  return {
    agent: o.agent,
    agentSessions: sessions,
    // A malformed cwd is dropped rather than rejecting the whole record: the binding and the
    // session ids are still good, and losing them would restart the user's task over a bad field.
    ...(typeof o.cwd === 'string' && o.cwd ? { cwd: o.cwd } : {}),
    ...titleFields(o.title, o.titlePinned),
    // Listing metadata, same tolerance again: the next turn writes both afresh.
    ...(lane ? { lane } : {}),
    ...(typeof o.lastAt === 'number' && Number.isFinite(o.lastAt) ? { lastAt: o.lastAt } : {}),
    ...(typeof o.inFlight === 'number' && Number.isFinite(o.inFlight) ? { inFlight: o.inFlight } : {}),
    ...generationField(o.generation),
  };
}

/**
 * The title and its pin, validated together. Same tolerance as cwd: a bad title is worth less than
 * the session ids it sits next to, and the cost of dropping it is one redundant rename. Only a pin
 * recorded alongside a real title means anything; a pin on its own would freeze a conversation's
 * naming at a name nobody set.
 */
function titleFields(title: unknown, pinned: unknown): Pick<ConversationRecord, 'title' | 'titlePinned'> {
  if (typeof title !== 'string' || !title) return {};
  return pinned === true ? { title, titlePinned: true } : { title };
}

/** The generation counter, when it is a sane one; anything else is left absent (0 on read). */
function generationField(v: unknown): Pick<ConversationRecord, 'generation'> {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? { generation: v } : {};
}

function toLane(v: unknown): ConversationRecord['lane'] {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { platform?: unknown; channel?: unknown; thread?: unknown };
  if (typeof o.platform !== 'string' || !o.platform || typeof o.channel !== 'string' || !o.channel) {
    return undefined;
  }
  return {
    platform: o.platform,
    channel: o.channel,
    ...(typeof o.thread === 'string' && o.thread ? { thread: o.thread } : {}),
  };
}

/**
 * One-shot migration from the pre-refactor `sessions.json`.
 *
 * The old format was `"<agentId>:<platform>:<c|t|u>:<rest>" -> "<agent session id>"`. Those keys
 * are unambiguously parseable: agent and platform-instance ids are `[a-z0-9][a-z0-9_-]{0,31}`
 * and contain no `:`, and the scope marker is a single letter — so everything after it is the
 * channel part, which for Telegram may itself be the old composite `<chat>:<topic>`.
 *
 * Worth doing rather than starting clean: dropping it would silently restart every in-flight
 * task, which is exactly the "IM must not disturb the agent's context" rule this refactor is
 * built on. Entries that don't parse are skipped, and the old file is left in place.
 *
 * Returns the number of conversations recovered.
 */
export function migrateLegacySessions(
  legacyFile: string,
  store: ConversationStore,
  /** Rebuilds a conversation key from the parsed parts, using the CURRENT scope config. */
  keyFor: (parts: { platform: string; marker: string; rest: string }) => string | null
): number {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return 0; // no legacy file (the normal case after the first run)
  }
  let recovered = 0;
  for (const [oldKey, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !value) continue;
    const parsed = parseLegacyKey(oldKey);
    if (!parsed) continue;
    const key = keyFor(parsed);
    if (!key) continue;
    store.bind(key, parsed.agentId);
    store.setAgentSession(key, parsed.agentId, value);
    recovered++;
  }
  return recovered;
}

/** `<agentId>:<platform>:<marker>:<rest>` or `<agentId>:shared`; null when it doesn't fit. */
export function parseLegacyKey(
  key: string
): { agentId: string; platform: string; marker: string; rest: string } | null {
  const shared = /^([a-z0-9][a-z0-9_-]{0,31}):shared$/i.exec(key);
  if (shared) return { agentId: shared[1]!, platform: '', marker: 'shared', rest: '' };
  // Split off exactly three leading fields; the remainder (which may contain ':') is the rest.
  const m = /^([a-z0-9][a-z0-9_-]{0,31}):([a-z0-9][a-z0-9_-]{0,31}):([ctu]):(.+)$/i.exec(key);
  if (!m) return null;
  return { agentId: m[1]!, platform: m[2]!, marker: m[3]!, rest: m[4]! };
}
