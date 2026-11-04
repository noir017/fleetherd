/**
 * The web UI's topics: the list of parallel conversations the page can switch between.
 *
 * Modelled on a Telegram forum / a Feishu topic group — each topic is a lane on the one
 * channel, so each is its own conversation with its own agent session and its own
 * harness-generated name (see `room.ts` for the addressing, and `index.ts` for why the lane
 * rather than a separate channel).
 *
 * ── Why this is persisted, and why it is a file of its own ───────────────────
 * Losing this list is not "the page looks empty after a restart". The daemon's
 * `conversations.json` still holds the agent binding and the per-agent session id under
 * `<instance>#main#<topic id>`, so every one of those contexts would still be alive — just
 * unreachable, because nothing would know the ids any more.
 *
 * It duplicates one field the daemon already stores: `ConversationStore.conversationTitle`
 * keeps a title too. That duplication is forced by the layering rather than chosen —
 * `platform/` may not import `daemon/` — and the two answer different questions. The daemon's
 * is "what is this conversation called", and it does not exist until a turn has run; this one
 * is "which rooms does the page have", and a topic created a second ago with nothing said in
 * it has to be in it. Do not try to merge them.
 *
 * Shape and failure behaviour copied from `daemon/workdir-usage.ts`: write-through, a missing
 * or corrupt file degrades to empty, and it is never worth a crash.
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { TopicStage, TurnOutcome } from '../../types.js';

/** One topic, as the page lists it. */
export interface Topic {
  id: string;
  /** Empty until something names it — the first message seeds it, the harness replaces it. */
  title: string;
  /** Epoch ms of the last message either way; the switcher orders by it. */
  lastAt: number;
  /**
   * The operator starred it: never given up to make room, and spared by "Clear all topics".
   *
   * Persisted, unlike every flag below it, because it is the operator's decision rather than a
   * reading of the daemon — and written only when true, so the file of someone who never stars
   * anything is byte-for-byte what it was before this existed. Starring is the ONLY way to keep a
   * quiet topic past the cap; see `evictable` for everything else that holds one.
   */
  starred?: boolean;
  /**
   * True while the agent is working in this topic: a turn, or background work reporting in after
   * one. Both hold the typing indicator, which is what this is read from (see daemon TurnRunner).
   */
  running?: boolean;
  /**
   * A question is on screen here and nothing will move until it is answered.
   *
   * Derived from the room itself — a message still carrying live buttons — rather than asked of
   * the daemon, because that is both the same fact and the only one the page can act on: every
   * ask, elicitation round and menu is posted as buttons and retired by stripping them. Note that
   * `running` is usually true at the same time (the turn the question belongs to is still open,
   * typing and all), so a renderer that wants to say "waiting for you" has to check this FIRST.
   */
  asking?: boolean;
  /**
   * An agent child process is resident for this topic's conversation, whether or not a turn is
   * running. Derived like `running` and never persisted; absent when no daemon offered the
   * lookup (`PlatformAdapter.useLivenessLookup`), which is every platform but this one.
   *
   * The distinction it exists for: a turn ending does not end the agent, so "quiet for a minute
   * with its context in memory" and "reclaimed an hour ago, nothing left running" are the same
   * row without it — and they answer the next message very differently.
   */
  live?: boolean;
  /** Monotonic count of messages posted into this topic. */
  msgCount?: number;
  /**
   * A terminal pane is attached to this topic right now — some page has it open, minimized or
   * not. Derived like `running` and never persisted, and NOT the same claim as "a shell is
   * alive over there": the daemon only ever sees the connection (see `terminal-sessions.ts`),
   * so a session left running with every tab closed reports false here. Read it as "a page is
   * attached", which is what the switcher's marker says.
   */
  term?: boolean;
  /**
   * Where this topic's conversation is working, when the daemon gave the adapter a way to ask
   * (`PlatformAdapter.useWorkdirLookup`). Both halves are sent because they answer different
   * questions: `name` is the project you recognise at a glance in a 240px column, and `path` is
   * the one that tells two checkouts of the same name apart, so the page hangs it off the title
   * attribute. Derived on every render like `running` and `msgCount` — never persisted, because
   * the daemon's answer is the only true one and a stale copy of it would outlive a `/cd`.
   *
   * `host` names the machine the directory is on (`ConversationWorkdir`), absent for the
   * gateway's own. It sits on this object rather than beside it because a path is only half an
   * address: two agents of one harness on two hosts both work in `workspace`.
   */
  dir?: { name: string; path: string; host?: string };
  /**
   * The topic whose agent opened this one (`talkcode task-new`, started once the operator confirmed
   * it — daemon/delegation.ts). The switcher nests it there, and the daemon reads it back to know
   * whom to tell when this topic's agent finishes (`PlatformAdapter.parentOf`), so this field is the
   * one record of the relation. Persisted, and dropped when the parent goes — deleted, evicted or
   * swept — so a child is never nested under nothing, and keeps its work as a topic of its own.
   */
  parent?: string;
  /**
   * Opened by a scheduled task's new-session run, not by the person (`createThread`'s `scheduled`
   * option). Persisted, because it is what keeps such a topic out of the switcher on every later
   * reload — the title is not a record: it is editable, and a run can be renamed.
   *
   * The page leaves these out of the topic list and draws them in the scheduled panel's Sessions
   * tab instead. They are still ordinary conversations in every other way: the daemon binds an
   * agent to them, they count towards `MAX_TOPICS`, and they are evicted by age like anything else.
   */
  scheduled?: boolean;
  /**
   * When the operator last looked at this topic, by this server's clock (`api/seen`). Persisted:
   * "you have not read this reply" has to survive the restart that an update is.
   */
  seenAt?: number;
  /** How its last turn ended, as the daemon pushed it (TopicActivity.outcome). Persisted, for the same reason. */
  outcome?: TurnOutcome;
  /** An automatic continue is scheduled (TopicActivity.retry). Not persisted: the timer dies with the daemon. */
  retry?: { attempt: number; max: number; at: number };
  /**
   * Where it stands for the operator (core/topic-stage.ts) and the line that goes with it — derived on
   * every list, never persisted. The page's "Needs you" list is the topics whose stage needs a person.
   */
  stage?: TopicStage;
  line?: string;
}

/**
 * Ceiling on concurrent topics.
 *
 * `create` still refuses past it; what changed is that the caller makes room first (`evictable`,
 * driven from `WebRoom.createTopic`). It used to be a refusal and nothing else, on the grounds
 * that dropping the oldest topic orphans its agent session the way losing this file would. That
 * held up in theory and failed in use: two weeks of ordinary work (plus a topic per new-session
 * scheduled run) reached 64, after which the + button did nothing at all — the 409 never reached
 * the screen — and every scheduled run fell back to posting into the chat. What orphaning costs
 * is the same as the × costs, which people press all the time; a topic worth keeping is starred.
 *
 * 64 rooms is already far past the point where a one-line switcher is readable, so the number
 * did not move.
 */
export const MAX_TOPICS = 64;

/** How much of a first message becomes the placeholder name before the harness names it. */
const SEED_CHARS = 32;

export class TopicStore {
  private readonly topics = new Map<string, Topic>();

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [id, value] of Object.entries(raw)) {
        const topic = toTopic(id, value);
        if (topic) this.topics.set(id, topic);
      }
      this.orphan();
      this.adoptScheduledRuns();
    } catch {
      /* first run or corrupt file: start with no topics, and create() makes the first one */
    }
  }

  /**
   * Recognise the scheduled runs a file written before `Topic.scheduled` existed cannot mark.
   *
   * `openScheduledConversation` names a run `[agent] ⏰ <task> · <time>` and records that title
   * as the conversation's own, so the automatic namer never replaces it (conversation.ts). That
   * makes the title a reliable one-time trace for those topics; from this start on the flag is
   * what the page reads. A topic renamed with `/title` before the upgrade is missed — nothing
   * here can tell it from a conversation the person named themselves, and guessing from a clock
   * glyph anywhere else in the name would move ordinary topics out of the switcher.
   */
  private adoptScheduledRuns(): void {
    let changed = false;
    for (const topic of this.topics.values()) {
      if (topic.scheduled || !/^\[[^\]]+\]\s+⏰\s/.test(topic.title)) continue;
      topic.scheduled = true;
      changed = true;
    }
    if (changed) this.flush();
  }

  /** Most recently active first — the order the switcher reads in. */
  list(): Topic[] {
    return [...this.topics.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  get(id: string): Topic | undefined {
    return this.topics.get(id);
  }

  has(id: string): boolean {
    return this.topics.has(id);
  }

  /**
   * The topic a client should land on when it named none: the most recent, creating one if
   * this is a brand-new install. The page is never without a room to be in.
   */
  current(): Topic {
    return this.list()[0] ?? this.create();
  }

  /** Whether `create` would refuse, i.e. whether the caller has to make room first. */
  full(): boolean {
    return this.topics.size >= MAX_TOPICS;
  }

  /**
   * The topic to give up to make room for a new one: the least recently active that is neither
   * starred nor claimed by `inUse`. Undefined when every topic is one or the other.
   *
   * Only CHOOSES — the caller deletes, because the caller also holds the topic's live state
   * (`WebRoom`'s room, its hold timer) and that has to go with it. `inUse` is the caller's for the
   * same reason: whether an agent is mid-turn, asking, resident, or the target of a scheduled task
   * is nothing this file can see. Starred is checked here rather than left to it, because it is
   * this file's own field and no caller should be able to forget it.
   */
  evictable(inUse: (topic: Topic) => boolean): Topic | undefined {
    let oldest: Topic | undefined;
    for (const topic of this.topics.values()) {
      if (topic.starred || (oldest && topic.lastAt >= oldest.lastAt)) continue;
      if (!inUse(topic)) oldest = topic;
    }
    return oldest;
  }

  create(title = '', parent?: string, opts: { scheduled?: boolean } = {}): Topic {
    if (this.full()) {
      throw new Error(`[webui] this instance already has ${MAX_TOPICS} topics; close one before opening another`);
    }
    // Hex, and never a character `formatAddress` gives meaning to: the id travels as the lane
    // half of `main/<id>`, which `parseAddress` splits on `/` and refuses to see twice.
    const topic: Topic = {
      id: randomBytes(4).toString('hex'),
      title,
      lastAt: Date.now(),
      ...(parent !== undefined && this.topics.has(parent) ? { parent } : {}),
      ...(opts.scheduled ? { scheduled: true } : {}),
    };
    this.topics.set(topic.id, topic);
    this.flush();
    return topic;
  }

  /** The topics `id` opened (their `parent`), most recently active first. */
  children(id: string): Topic[] {
    return this.list().filter((t) => t.parent === id);
  }

  /** Record how a topic's last turn ended, and any scheduled continue. Persists the outcome only. */
  setActivity(id: string, outcome: TurnOutcome | undefined, retry: Topic['retry']): boolean {
    const topic = this.topics.get(id);
    if (!topic) return false;
    const changed = JSON.stringify(topic.outcome) !== JSON.stringify(outcome);
    if (outcome) topic.outcome = outcome;
    else delete topic.outcome;
    if (retry) topic.retry = retry;
    else delete topic.retry;
    if (changed) this.flush();
    return true;
  }

  /** The operator looked at a topic now (`at`, this server's clock). Never moves backwards. */
  markSeen(id: string, at: number): boolean {
    const topic = this.topics.get(id);
    if (!topic || (topic.seenAt ?? 0) >= at) return false;
    topic.seenAt = at;
    this.flush();
    return true;
  }

  /** Name a topic. This is what `renameThread` lands on, i.e. what the harness decided. */
  rename(id: string, title: string): boolean {
    const topic = this.topics.get(id);
    if (!topic || !title.trim()) return false;
    topic.title = title.trim();
    this.flush();
    return true;
  }

  /** Star or unstar a topic. False when there is no such topic. */
  star(id: string, on: boolean): boolean {
    const topic = this.topics.get(id);
    if (!topic) return false;
    if (Boolean(topic.starred) === on) return true;
    if (on) topic.starred = true;
    else delete topic.starred;
    this.flush();
    return true;
  }

  /**
   * Delete a topic from the store and persist the list. The topics it opened stay, as topics of
   * their own: their work is not this one's to throw away, and the × on a parent is not a promise
   * about anything nested under it.
   */
  delete(id: string): boolean {
    const topic = this.topics.get(id);
    if (!topic) return false;
    this.topics.delete(id);
    this.orphan();
    this.flush();
    return true;
  }

  /** Drop every `parent` that names a topic no longer here. Does not persist; its callers do. */
  private orphan(): void {
    for (const t of this.topics.values()) {
      if (t.parent !== undefined && !this.topics.has(t.parent)) delete t.parent;
    }
  }

  /**
   * Forget every topic that is not starred, in one write. Returns how many went.
   *
   * Starred ones stay because a star means "never clean this up", and the sweep is the most
   * thorough cleaning there is — one that also took the starred topics would make the star a
   * promise that holds against everything except the button labelled for it.
   *
   * Leaves the store EMPTY when nothing was starred rather than seeding a replacement: `current()`
   * already creates one when the list is empty, and having two places that decide "the page is
   * never without a room to be in" is how they come to disagree. Note what this does not reach —
   * the daemon's `conversations.json` still holds the agent binding and session id for every id
   * dropped here, exactly as `delete` leaves them. This clears the list, it does not end the
   * sessions.
   */
  clear(): number {
    let gone = 0;
    for (const [id, topic] of this.topics) {
      if (topic.starred) continue;
      this.topics.delete(id);
      gone += 1;
    }
    if (gone > 0) {
      this.orphan();
      this.flush();
    }
    return gone;
  }

  /**
   * Give an unnamed topic a placeholder from the first thing said in it.
   *
   * Without it a run of new topics reads as several identical blanks in the switcher, and the
   * harness's own name does not arrive until a turn has finished (and never at all when
   * `title.llm` is unconfigured). Only ever fills a blank — it must not overwrite a real name.
   *
   * Not from a slash command: `/agent oc2`, `/cd quantlab` and a bare `/cc` say what the topic is
   * set up WITH, not what it is about, and since a new topic's choice of agent is a tap that types
   * `/agent <id>` (2026-11-02), seeding from them named most new topics after a command. The next
   * thing said seeds it instead.
   */
  seed(id: string, text: string): boolean {
    const topic = this.topics.get(id);
    if (!topic || topic.title) return false;
    const line = text.replace(/\s+/g, ' ').trim();
    if (!line || line.startsWith('/')) return false;
    topic.title = line.length > SEED_CHARS ? `${line.slice(0, SEED_CHARS)}…` : line;
    this.flush();
    return true;
  }

  /** Record activity, so the switcher's order means something. */
  touch(id: string, at = Date.now()): void {
    const topic = this.topics.get(id);
    if (!topic || topic.lastAt === at) return;
    topic.lastAt = at;
    this.flush();
  }

  private flush(): void {
    const out: Record<string, Omit<Topic, 'id'>> = {};
    for (const [id, t] of this.topics) {
      out[id] = {
        title: t.title,
        lastAt: t.lastAt,
        ...(t.starred ? { starred: true } : {}),
        ...(t.scheduled ? { scheduled: true } : {}),
        ...(t.parent !== undefined ? { parent: t.parent } : {}),
        ...(t.seenAt !== undefined ? { seenAt: t.seenAt } : {}),
        ...(t.outcome ? { outcome: t.outcome } : {}),
      };
    }
    try {
      fs.mkdirSync(dirOf(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
    } catch (e) {
      // Losing the write costs the topic list on the next restart, which is bad but survivable;
      // throwing here would take down the message that triggered it, which is worse.
      console.warn('[webui] could not save the topic list:', e instanceof Error ? e.message : e);
    }
  }
}

function dirOf(file: string): string {
  const at = file.lastIndexOf('/');
  return at <= 0 ? '.' : file.slice(0, at);
}

/** Validate one persisted entry; anything malformed is dropped rather than trusted. */
function toTopic(id: string, value: unknown): Topic | undefined {
  if (!/^[0-9a-f]{8}$/.test(id) || typeof value !== 'object' || value === null) return undefined;
  const rec = value as {
    title?: unknown;
    lastAt?: unknown;
    starred?: unknown;
    scheduled?: unknown;
    parent?: unknown;
    seenAt?: unknown;
    outcome?: unknown;
  };
  const title = typeof rec.title === 'string' ? rec.title : '';
  const lastAt = typeof rec.lastAt === 'number' && Number.isFinite(rec.lastAt) ? rec.lastAt : 0;
  const outcome = toOutcome(rec.outcome);
  // `=== true` and nothing looser: a star is what exempts a topic from every sweep, so a file
  // that says `"starred": "no"` must not be read as one.
  return {
    id,
    title,
    lastAt,
    ...(rec.starred === true ? { starred: true } : {}),
    ...(rec.scheduled === true ? { scheduled: true } : {}),
    ...(typeof rec.parent === 'string' && /^[0-9a-f]{8}$/.test(rec.parent) && rec.parent !== id ? { parent: rec.parent } : {}),
    ...(typeof rec.seenAt === 'number' && Number.isFinite(rec.seenAt) ? { seenAt: rec.seenAt } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

/** A persisted outcome, field by field; anything malformed is dropped (the next turn writes one afresh). */
function toOutcome(v: unknown): TurnOutcome | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { kind?: unknown; at?: unknown; line?: unknown; reason?: unknown };
  if ((o.kind !== 'done' && o.kind !== 'failed') || typeof o.at !== 'number' || !Number.isFinite(o.at)) return undefined;
  return {
    kind: o.kind,
    at: o.at,
    ...(typeof o.line === 'string' ? { line: o.line.slice(0, 200) } : {}),
    // Not checked against the reason list: platform/ cannot import the config's, and the page only
    // ever shows the line, never the reason.
    ...(typeof o.reason === 'string' ? { reason: o.reason as TurnOutcome['reason'] } : {}),
  };
}
