/**
 * The web UI's conversations: topics, their messages, their subscribers, and both directions
 * of traffic.
 *
 * ── Topics ───────────────────────────────────────────────────────────────────
 * Each topic is a LANE on the one channel — `{ channel: 'main', thread: '<topic id>' }` — so
 * each is its own conversation with its own agent session and its own harness-generated name.
 * See `index.ts` for why a lane rather than a channel of its own, and why the `kind` stays
 * `'direct'` even though a lane is set.
 *
 * Messages live in a bounded in-memory ring PER TOPIC, replayed to a browser that connects
 * without a resumable position, and written to disk within seconds of changing (see
 * `TranscriptStore`) so a daemon restart does not empty the page while the agent keeps its
 * context. The topic LIST is persisted separately (see `topics.ts`): without the ids, those
 * contexts would still be running and no longer reachable.
 *
 * ── Built for a weak link ────────────────────────────────────────────────────
 * Three things here exist because this is expected to be read over a bad connection, and each
 * would be simpler without that constraint:
 *
 * 1. **Edits are held, not broadcast.** Every streaming flush re-renders the whole message, so
 *    naively announcing each one sends the same growing body over and over. An edit is queued
 *    and emitted once the message stops changing (or after a cap, so a long reply still shows
 *    progress). See `enqueue`.
 * 2. **Every event carries a sequence number**, so a stream that drops and reconnects is
 *    caught up with what it missed instead of being re-sent the whole conversation.
 * 3. **The stream is per topic.** A client reading one topic is not billed for traffic in
 *    another. Only the topic LIST crosses rooms.
 *
 * Deliberately free of HTTP: everything here is exercisable without opening a port, which is
 * what `room.test.ts` drives.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import {
  addressListed,
  addressOf,
  describeConversation,
  type ConversationRef,
} from '../../core/conversation.js';
import { MessageNotEditableError } from '../../core/outbound-errors.js';
import { needsPerson, replyLine, topicStage } from '../../core/topic-stage.js';
import { parseWorkdirButtonId } from '../../core/workdir-menu.js';
import type {
  AgentCatalog,
  AgentStatus,
  ButtonInteraction,
  InboundMessage,
  SettingsScreen,
  SlashCommandSpec,
  TopicActivity,
  TopicStage,
} from '../../types.js';
import type {
  ButtonSpec,
  ConversationWorkdir,
  SchedulePanel,
  ModelPicker,
  ModelPickerList,
  ModelPickerResult,
  SchedulePanelAction,
  SchedulePanelResult,
  SchedulePanelTask,
  SkillPanelEntry,
  SkillPanelOp,
  SkillPanelResult,
  SkillsPanel,
} from '../adapter.js';
import type { WebuiPlatformConfig } from '../config-schemas.js';
import { escapeHtml, renderWebMarkdown, renderWebToolLines } from '../web-markdown.js';
import type { ClickRequest, SendRequest, WebEvent, WebMessage } from './protocol.js';
import type { TerminalSessions } from './terminal-sessions.js';
import { MAX_TOPICS, TopicStore, type Topic } from './topics.js';

/** A `platforms.<id>` entry of type `webui`, plus its map key. */
export type WebuiInstance = WebuiPlatformConfig & { id: string };

/**
 * The one channel, and the one operator.
 *
 * Constants rather than config: they are not addresses of anything real, they are the names
 * this platform answers to. `access.allowFrom` matches `<instance id>:owner`, and a reverse
 * command reaches one topic as `--channel main/<topic id>`.
 */
export const CHANNEL = 'main';
export const OWNER = 'owner';

/**
 * How long a topic must stay in a needs-you stage before a push notification goes out for it. The
 * page reports what the operator is looking at (`api/seen`), and a reply that lands in the topic on
 * screen is seen within a round trip — so the grace is what keeps the phone from buzzing about what
 * the operator just read.
 */
const NOTIFY_GRACE_MS = 3_000;

/** One push notification, before it is addressed (see `useNotifier`). */
export interface TopicNotice {
  topic: string;
  title: string;
  body: string;
}

/** How many messages a topic remembers across a page reload. Memory in a daemon that runs for weeks. */
const MAX_MESSAGES = 500;

/** How many emitted events a topic keeps so a reconnect can be caught up rather than re-synced. */
const MAX_BACKLOG = 300;

/**
 * How many files stay downloadable, across all topics: the agent's sent files and the operator's
 * own pictures (see `submit`) share the one table.
 */
const MAX_DOWNLOADS = 200;

/**
 * How long a topic's working directory is reused before it is looked up again.
 *
 * The lookup is not free — it crosses into the daemon, which resolves a conversation key, finds
 * the bound agent and stats the recorded directory — and `topicList()` is rebuilt on every
 * message posted into any topic, so a streamed answer would ask the same question a hundred
 * times a turn. The answer only changes when someone runs `/cd`, so a few seconds of staleness
 * costs a label that is briefly out of date on a sidebar and saves the rest.
 *
 * Exported only so `room.test.ts` can assert the bound by name instead of restating the number.
 */
export const DIR_TTL_MS = 5000;

/**
 * How long a message must stop changing before its edit is announced.
 *
 * A debounce, not a throttle, and that is the whole point: a reply being streamed is rewritten
 * every flush, and announcing each one re-sends the entire rendered body.
 *
 * ⚠️ The number is chosen RELATIVE to another module's constant and cannot be read on its own.
 * `EXPERIENCE.stream.flushIntervalMs` is 1200ms (`config/schema.ts`), so an edit arrives at
 * most every ~1.2s while a reply streams. Anything BELOW that and the debounce expires between
 * every pair of edits — each one is announced separately, a fixed delay is added to all of
 * them, and nothing is saved at all. Above it, a stream in progress keeps re-arming the timer
 * and is emitted on the cap below instead; the settle then only fires once the stream stops.
 * If that 1200 ever changes, this has to move with it.
 *
 * The trailing cost is smaller than it looks: a turn ends with a lifecycle reaction, and a
 * reaction flushes the queue (see `flush`), so the final text of a reply goes out with the ✅
 * rather than waiting this out.
 */
const SETTLE_MS = 1_500;

/**
 * …but never hold one longer than this.
 *
 * Without a cap, a reply that streams continuously for a minute would show nothing for a
 * minute, which reads as a hung daemon — the exact failure the buffering is supposed to avoid
 * on a slow link, arrived at from the other side.
 */
const MAX_HOLD_MS = 8_000;

/** How many recent send-nonces are remembered, so a retry on a flaky link cannot double-send. */
const MAX_NONCES = 64;

/**
 * How often the switcher re-checks whether each topic's agent process is still up.
 *
 * A poll, which nothing else in this file is, because a child going away announces nothing: the
 * idle sweeper reclaims on a timer, in a conversation that by definition nobody is touching, and
 * a child that crashed is quieter still. Everything that turns the flag ON already announces (a
 * turn starting sets typing, which redraws the list), so this only has to catch it going off —
 * and being a few seconds late to say "that one is asleep now" costs nothing.
 *
 * Cheap enough to leave running: a map lookup per topic, skipped entirely while no browser is
 * attached, and it sends only when a flag actually changed.
 */
const LIVENESS_POLL_MS = 15_000;

/** One message as a topic holds it: what the page renders, plus what produced it. */
interface Stored {
  msg: WebMessage;
  /** The markdown the html was rendered from — what `fetch-messages` must hand back. */
  text: string;
}

/** Where an event goes. `id` is the SSE event id a reconnect may resume from. */
export type Sink = (id: string, ev: WebEvent) => void;

/**
 * Where the files this room serves from a copy of its own are kept: the operator's pictures, so the
 * message they sent can show them, and every file the agent sends (`publishCopy`).
 *
 * Injected (`useUploads`) rather than written here, so this file stays free of the disk the way it
 * is free of HTTP — `index.ts` owns the directory. Absent in a test that does not care, which then
 * renders sent pictures as names, as every message did before.
 */
export interface UploadStore {
  /**
   * Start writing one upload; returns where it will be and when it is there. `ready` never
   * rejects: a write that failed is logged by the store, and the download it backs answers 404,
   * which the page already turns into "show the name, hide the frame".
   */
  save(name: string, base64: string): { path: string; ready: Promise<void> };
  /**
   * Copy a file the agent sent; resolves with where the copy is, once all of it is there. Unlike
   * `save` this one rejects: the agent is still waiting on its `send-file`, and a file that cannot
   * be read is its error to hear, not a link that will 404.
   */
  copy(source: string): Promise<string>;
  /** Delete one the download table has let go of. Best-effort. */
  discard(path: string): void;
}

/**
 * Where every topic's transcript is kept, so a restart does not take it.
 *
 * A transcript otherwise lives in this process only, and the browser's copy is no substitute: it
 * holds what that browser received, and nothing it did not. A page on a phone goes quiet the moment
 * the phone is put down, so whatever the agent said after that existed only here — and a restart
 * then took it, under a page that went on showing a turn stopped halfway. Reported on 2026-10-31,
 * for a reply finished seven minutes before an update. This used to be starred topics only (2.5.0),
 * on the grounds that writing every topic's ring was a cost nobody asked for; but the write is paid
 * per topic that is CHANGING, not per topic, and the topics changing are the ones being read. A star
 * now only keeps a topic from being evicted or swept. Injected (`useTranscripts`) for the same reason
 * `UploadStore` is: `index.ts` owns the disk.
 *
 * Every message in and out of here carries `g`, the run it was said in (see `WebMessage.g`).
 */
export interface TranscriptStore {
  /** Every topic an earlier run kept, oldest message first. Malformed entries are dropped, not thrown. */
  load(): Map<string, Kept[]>;
  /** Replace one topic's kept transcript. Best-effort: a failure is logged by the store. */
  save(topicId: string, messages: Kept[]): void;
  /** Forget one topic's kept transcript. Best-effort. */
  drop(topicId: string): void;
}

/** One message as a topic keeps it across a restart: the ring entry, with its run. */
export interface Kept {
  msg: WebMessage & { g: number };
  text: string;
}

/**
 * How long a topic's changes are gathered before they are written. Not a settle: the first
 * change arms it and later ones ride along, so a reply that streams for minutes is still written
 * every few seconds rather than once at the end — a crash mid-reply costs at most this much.
 */
const KEEP_MS = 3_000;

/** One entry of the download table. `ready`/`owned` only on a file this room wrote itself. */
interface Download {
  path: string;
  name: string;
  ready?: Promise<void>;
  /** The file is ours to delete once nothing can reach it — never true of a path handed to `publish`. */
  owned?: boolean;
}

interface Client {
  topic: string;
  send: Sink;
}

/** One topic's live state. Created on demand for any topic the store knows. */
interface Room {
  stored: Map<string, Stored>;
  typing: boolean;
  seq: number;
  backlog: Array<{ seq: number; ev: WebEvent }>;
  /** Message ids whose edits are waiting to go out, in the order they were first held. */
  queue: string[];
  timer: NodeJS.Timeout | null;
  /** When the current hold must end regardless of further edits; 0 when nothing is held. */
  holdUntil: number;
  msgCount: number;
  /**
   * Message ids currently showing buttons — every message this topic could be answered through,
   * questions and menus alike (a directory menu is the one kind that is not a question; see
   * `awaitingQuestion`).
   *
   * A set rather than a scan of `stored` on demand, because the topic list is rebuilt on every
   * message posted into any topic and scanning 500 messages × 64 topics for one boolean is work
   * per keystroke of a streamed reply. Maintained wherever buttons appear or are stripped.
   */
  awaiting: Set<string>;
  /**
   * The agent status the daemon last pushed for this topic (see `setStatus`), and its serialized
   * form for the repeat check. Lives and dies with the room, like the transcript: after a restart
   * there is nothing to show until the agent next reports, which is what an absent status says.
   */
  status?: AgentStatus;
  statusKey?: string;
}

export class WebRoom {
  private seqId = 0;
  /**
   * When this object was built, i.e. when the daemon came up.
   *
   * Only ever compared against a topic's persisted `lastAt`, to answer "is this room empty
   * because it is new, or because the restart took its transcript". See `isStale`.
   */
  private readonly startedAt = Date.now();
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Set<Client>();
  private readonly downloads = new Map<string, Download>();
  /** See `UploadStore`; set once by `useUploads`. */
  private uploads: UploadStore | null = null;
  /** See `TranscriptStore`; set once by `useTranscripts`. */
  private transcripts: TranscriptStore | null = null;
  /** Starred topics changed since they were last written, and the timer that will write them. */
  private readonly unsaved = new Set<string>();
  private keepTimer: NodeJS.Timeout | null = null;
  private readonly nonces = new Set<string>();
  private commands: SlashCommandSpec[] = [];

  private onMsg: ((m: InboundMessage) => void) | null = null;
  private onBtn: ((ev: ButtonInteraction) => void) | null = null;
  /** Injected by the daemon; absent in a deployment (or a test) that never offered one. */
  private workdir: ((ref: ConversationRef) => ConversationWorkdir | undefined) | null = null;
  /** Likewise, and read the same way — see `useLivenessLookup`. */
  private liveness: ((ref: ConversationRef) => boolean) | null = null;
  /** Likewise — see `useScheduleLookup`. Only ever read when the store is full. */
  private scheduled: ((ref: ConversationRef) => boolean) | null = null;
  /** The daemon's task list and its four operations — see `useSchedulePanel`. */
  private schedulePanel: SchedulePanel | null = null;
  /** The model switch for a topic's conversation — see `useModelPicker`. */
  private modelPicker: ModelPicker | null = null;
  /** The daemon's managed skills and every operation on them — see `useSkillsPanel`. */
  private skillsPanel: SkillsPanel | null = null;
  /** Likewise, but it acts: ends an idle topic's agent process. See `closeIdle`. */
  private idleReclaim: ((ref: ConversationRef) => boolean) | null = null;
  /** Likewise — see `useAgentCatalog`. Only ever read for a sync of an empty room. */
  private catalog: ((ref: ConversationRef) => AgentCatalog | undefined) | null = null;
  /** The poll that keeps `liveness` honest; only ever running once a lookup exists. */
  private liveTimer: NodeJS.Timeout | null = null;
  /** Sends a push notification (index.ts, webpush.ts); absent = nobody to notify. See `useNotifier`. */
  private notifier: ((notice: TopicNotice) => void) | null = null;
  /** The stage each topic was last announced in, to notice the moment one starts needing the operator. */
  private readonly lastStage = new Map<string, TopicStage>();
  /** Notifications waiting out NOTIFY_GRACE_MS, by topic. */
  private readonly notifyTimers = new Map<string, NodeJS.Timeout>();
  /**
   * The flags of the last topic list actually sent, so the poll can stay silent when nothing
   * moved. Not a cache of the list itself: everything else announces unconditionally, because a
   * title, an order or an unread count changed and the poll is not what noticed.
   */
  private lastFlags = '';
  private readonly dirCache = new Map<string, { at: number; dir?: Topic['dir'] }>();
  /**
   * Who has a terminal pane attached. Absent when the feature is off, and in every test that
   * does not care — which is why `topicList` reads it through `?.` rather than requiring one.
   */
  private terminal: Pick<TerminalSessions, 'has'> | null = null;

  constructor(
    private readonly instance: WebuiInstance,
    readonly topics: TopicStore
  ) {}

  // ── Topics ─────────────────────────────────────────────────────────────────

  /**
   * Create a topic and tell every client about it, giving up the oldest topic first when the
   * store is full.
   *
   * Throws only when nothing can be given up — every topic starred or in use — and the message
   * says so, because the server hands it to the page verbatim and it is the only explanation the
   * operator will get for a + that did nothing.
   *
   * `parent` nests it under the topic whose agent opened it (Topic.parent), and `scheduled` marks
   * a lane a scheduled run opened for itself (Topic.scheduled).
   */
  createTopic(title = '', parent?: string, opts: { scheduled?: boolean } = {}): Topic {
    if (this.topics.full()) this.makeRoom();
    const topic = this.topics.create(title, parent, opts);
    this.announceTopics();
    return topic;
  }

  /**
   * Evict the least recently active topic nothing is holding on to.
   *
   * Not announced here: the caller is about to create a topic and announce the list once, and two
   * lists a millisecond apart would only redraw the switcher twice.
   */
  private makeRoom(): void {
    const victim = this.topics.evictable((t) => this.inUse(t.id));
    if (!victim) {
      // No `[webui]` prefix, unlike the store's own refusal: this sentence is shown to the operator
      // as it is (server.ts → the page's alert), and the server's log line adds the prefix.
      throw new Error(
        `every one of the ${MAX_TOPICS} topics is starred or in use; unstar or delete one before opening another`
      );
    }
    this.disposeRoom(victim.id);
    this.forgetKept(victim.id);
    this.topics.delete(victim.id);
    // The one record of which topic went, and what it was called. The daemon's binding for it
    // stays in conversations.json (as it does for a ×), so this line is how its session id can
    // still be found by hand.
    console.log(
      `[webui] topic limit (${MAX_TOPICS}) reached: evicted ${victim.id} "${victim.title}", last active ${new Date(victim.lastAt).toISOString()}`
    );
  }

  /**
   * Whether a topic is busy enough that evicting it would cost something it is in the middle of.
   *
   * Each condition is something an eviction would break, not just orphan: a turn would keep
   * writing into a topic nobody can open, a question would be left unanswerable, a resident agent
   * would be cut off from the context it is holding in memory, an attached terminal window would
   * vanish under the person typing in it, and a scheduled task would fail every run from then on
   * — its target is an address, and nothing renames that address when the topic goes.
   */
  private inUse(topicId: string): boolean {
    const room = this.rooms.get(topicId);
    return (
      Boolean(room?.typing) ||
      Boolean(room?.awaiting.size) ||
      this.liveOf(topicId) ||
      Boolean(this.terminal?.has(topicId)) ||
      this.scheduledOf(topicId)
    );
  }

  /**
   * Star or unstar a topic and announce it. False when there is no such topic.
   *
   * A star keeps a topic from being evicted or swept, and that is all it does now: its transcript is
   * kept on disk either way (see `TranscriptStore`).
   */
  starTopic(id: string, on: boolean): boolean {
    if (!this.topics.star(id, on)) return false;
    this.announceTopics();
    return true;
  }

  /** Name a topic — what `renameThread` lands on, i.e. what the harness decided it is about. */
  renameTopic(id: string, title: string): boolean {
    if (!this.topics.rename(id, title)) return false;
    this.announceTopics();
    return true;
  }

  /** Delete a topic, disposing its room state and announcing the new list. */
  deleteTopic(id: string): boolean {
    this.disposeRoom(id);
    // A star defers to the ×, kept transcript and all.
    this.forgetKept(id);
    if (!this.topics.delete(id)) return false;
    this.announceTopics();
    return true;
  }

  /**
   * Forget every topic that is not starred and open a fresh one, announcing once rather than once
   * per topic.
   *
   * The sweep for a sidebar grown long: before every topic kept its transcript, every topic older
   * than this process opened onto nothing (see `syncEvent`'s `stale`), and some from before that
   * still do. Deliberately the same reach as `deleteTopic` repeated — the rooms and kept transcripts
   * go, the daemon's conversation bindings for those ids do not. It clears the list; it does not end
   * the agent sessions behind it.
   *
   * Returns the replacement topic, which is always a NEW one even when starred topics survive:
   * the page lands in it, and landing in a starred topic would read as though the sweep had not
   * happened. The exception is a list that is all stars, where there is no room to open one.
   */
  clearTopics(): Topic {
    // The rooms as well as the list: a room is made on demand, so one can outlive its topic's row.
    for (const id of new Set([...this.rooms.keys(), ...this.topics.list().map((t) => t.id)])) {
      const kept = this.topics.get(id);
      if (kept?.starred) continue;
      this.disposeRoom(id);
      this.forgetKept(id);
    }
    this.topics.clear();
    const fresh = this.topics.full() ? this.topics.current() : this.topics.create();
    this.announceTopics();
    return fresh;
  }

  /** Drop one topic's live state, stopping its hold timer so nothing fires into a dead room. */
  private disposeRoom(id: string): void {
    const room = this.rooms.get(id);
    if (room) {
      if (room.timer) clearTimeout(room.timer);
      this.rooms.delete(id);
    }
    this.dirCache.delete(id);
  }

  // ── What needs the operator ─────────────────────────────────────────────────────────────────

  /** The topic that opened this one (Topic.parent), if it is still here. */
  parentOf(topicId: string): string | undefined {
    const parent = this.topics.get(topicId)?.parent;
    return parent !== undefined && this.topics.has(parent) ? parent : undefined;
  }

  /** The topics this one opened (PlatformAdapter.childrenOf). */
  childrenOf(topicId: string): string[] {
    return this.topics.children(topicId).map((t) => t.id);
  }

  /** How a topic's last turn ended (PlatformAdapter.setActivity). */
  setActivity(topicId: string, activity: TopicActivity | undefined): void {
    if (!this.topics.setActivity(topicId, activity?.outcome, activity?.retry)) return;
    this.announceTopics();
  }

  /**
   * The operator is looking at a topic now (`api/seen`). Stamped with THIS clock, not the page's:
   * it is compared against when a turn ended, which is this clock's too, and a phone's idea of the
   * time is nothing to compare a server's with.
   */
  markSeen(topicId: string): boolean {
    if (!this.topics.markSeen(topicId, Date.now())) return false;
    this.announceTopics();
    return true;
  }

  /** When the operator last looked at a topic (PlatformAdapter.seenAt). */
  seenAt(topicId: string): number | undefined {
    return this.topics.get(topicId)?.seenAt;
  }

  /**
   * Accept a way to send a push notification. Without one the page is still told everything (the
   * Needs-you list); nothing reaches a device whose page is not open.
   */
  useNotifier(notify: (notice: TopicNotice) => void): void {
    this.notifier = notify;
  }

  /**
   * Notice topics that have just started needing the operator, and notify for each that still does
   * after NOTIFY_GRACE_MS (operatorStage: a sub-agent's topic only for a question of its own — the
   * rest of what it does is its parent agent's to read).
   */
  private watchStages(topics: Topic[]): void {
    for (const t of topics) {
      const stage = operatorStage(t);
      const was = this.lastStage.get(t.id);
      this.lastStage.set(t.id, stage);
      if (stage === was || !needsPerson(stage)) continue;
      if (!this.notifier || this.notifyTimers.has(t.id)) continue;
      const timer = setTimeout(() => {
        this.notifyTimers.delete(t.id);
        const now = this.topicList().find((x) => x.id === t.id);
        const nowStage = now ? operatorStage(now) : 'idle';
        if (!now || !needsPerson(nowStage)) return;
        try {
          this.notifier?.({ topic: now.id, title: now.title || 'Untitled', body: noticeBody(nowStage, now.line) });
        } catch (e) {
          console.warn('[webui] could not send a notification:', e instanceof Error ? e.message : e);
        }
      }, NOTIFY_GRACE_MS);
      timer.unref?.();
      this.notifyTimers.set(t.id, timer);
    }
  }

  /** The first line of the question a topic is waiting on, for the Needs-you list. */
  private questionLine(room: Room | undefined): string | undefined {
    if (!room) return undefined;
    let last: string | undefined;
    for (const id of room.awaiting) last = id;
    const text = last ? room.stored.get(last)?.text : undefined;
    return text ? replyLine(text) : undefined;
  }

  /**
   * Accept the daemon's way of asking where a topic's conversation is working.
   *
   * Pull, not push — see `PlatformAdapter.useWorkdirLookup` for why the daemon does not simply
   * tell us. Everything cached under a previous lookup is dropped, since the new one is by
   * definition a different daemon's answer.
   */
  useWorkdirLookup(lookup: (ref: ConversationRef) => ConversationWorkdir | undefined): void {
    this.workdir = lookup;
    this.dirCache.clear();
  }

  /**
   * Accept the daemon's way of asking whether a topic's agent child is still resident, and start
   * the poll that watches it (see LIVENESS_POLL_MS for why this one is polled and the rest is not).
   *
   * Unreferenced: a sidebar dot going grey is never a reason for the process to stay up.
   */
  useLivenessLookup(lookup: (ref: ConversationRef) => boolean): void {
    this.liveness = lookup;
    // What the list says NOW is the poll's baseline, so installing a lookup does not itself look
    // like a change. Nothing is lost by it: a client is handed the whole list on subscribe.
    this.lastFlags = flagsOf(this.topicList());
    if (this.liveTimer) return;
    this.liveTimer = setInterval(() => this.sweepLiveness(), LIVENESS_POLL_MS);
    this.liveTimer.unref?.();
  }

  /** Redraw the switcher if — and only if — a topic's flags changed since the last one sent. */
  private sweepLiveness(): void {
    if (this.clients.size === 0) return;
    const topics = this.topicList();
    const flags = flagsOf(topics);
    if (flags === this.lastFlags) return;
    this.sendTopics(topics, flags);
  }

  /**
   * Accept the daemon's way of asking whether a scheduled task posts into a topic, which is what
   * keeps that topic from being evicted (see `inUse`).
   *
   * Not drawn anywhere and not polled, unlike its two siblings: it is read only at the moment a
   * full store has to choose a topic to give up, which is the one moment the answer matters.
   */
  useScheduleLookup(lookup: (ref: ConversationRef) => boolean): void {
    this.scheduled = lookup;
  }

  /**
   * Accept the daemon's scheduled tasks and the four operations on them, which the page draws in
   * a panel of its own rather than in the topic list.
   *
   * A facade rather than a copy: the list is read on every request and every operation goes
   * through `ScheduleService.op`, so a change made in the panel is the same change the agent's
   * `schedule` commands and `/setting schedule` make, with the same state checks.
   */
  useSchedulePanel(panel: SchedulePanel): void {
    this.schedulePanel = panel;
  }

  /**
   * Accept the daemon's model switch: what a topic's conversation can switch to, and the switch,
   * which is `/model`'s (ConversationRegistry.modelPickerForRef / chooseModelForRef).
   */
  useModelPicker(picker: ModelPicker): void {
    this.modelPicker = picker;
  }

  /** What a topic can switch its model to, or why not. */
  async models(topic: string): Promise<ModelPickerList | { ok: false; reason: 'off'; text: string }> {
    if (!this.modelPicker) return { ok: false, reason: 'off', text: 'This daemon offers no model switch.' };
    if (!this.topics.has(topic)) return { ok: false, reason: 'off', text: 'No such topic.' };
    return this.modelPicker.list(this.conversation(topic));
  }

  /** Switch a topic's model, as `/model <id>` would. */
  async chooseModel(topic: string, value: string): Promise<ModelPickerResult> {
    if (!this.modelPicker) return { ok: false, text: 'This daemon offers no model switch.' };
    if (!this.topics.has(topic)) return { ok: false, text: 'No such topic.' };
    return this.modelPicker.choose(this.conversation(topic), value);
  }

  /** Every task, for the panel. `enabled: false` when the daemon offered none (a test daemon). */
  schedules(): { enabled: boolean; tasks: SchedulePanelTask[] } {
    if (!this.schedulePanel) return { enabled: false, tasks: [] };
    return { enabled: true, tasks: this.schedulePanel.list() };
  }

  /** Carry out one action on a task, with the fresh list when it worked. */
  scheduleOp(id: string, action: SchedulePanelAction): SchedulePanelResult {
    if (!this.schedulePanel) return { ok: false, error: 'scheduled tasks are not enabled in this daemon' };
    return this.schedulePanel.op(id, action);
  }

  /**
   * Accept the daemon's managed skills and every operation on them, which the page draws in a
   * window of its own rather than as a chat command.
   *
   * A facade, like the schedule panel above: every write is `daemon/skills-store.ts`'s, so the
   * page gets the same name/path validation, the same version guard on `patch`, the same
   * `.history/` snapshot, and the same archive-instead-of-delete as `talkcode skills`.
   */
  useSkillsPanel(panel: SkillsPanel): void {
    this.skillsPanel = panel;
  }

  /** Every managed skill, for the page. `enabled: false` when the daemon offered none. */
  skills(): { enabled: boolean; skills: SkillPanelEntry[] } {
    if (!this.skillsPanel) return { enabled: false, skills: [] };
    return { enabled: true, skills: this.skillsPanel.list() };
  }

  /** Carry out one skills operation, with the fresh list (and detail, for `show`). */
  skillOp(op: SkillPanelOp): SkillPanelResult {
    if (!this.skillsPanel) return { ok: false, error: 'skills are not enabled in this daemon' };
    return this.skillsPanel.op(op);
  }

  /** Accept the daemon's way of ending an idle topic's agent process — see `closeIdle`. */
  useIdleReclaim(reclaim: (ref: ConversationRef) => boolean): void {
    this.idleReclaim = reclaim;
  }

  /**
   * Accept the daemon's way of asking which agents a topic could be given to, which the page lays
   * out over an empty transcript. Not polled and not announced: it is read when an empty room is
   * synced, which is when that page is drawn, and nothing about it is worth a push — the first
   * message replaces it, and a `/reload` shows on the next empty topic opened.
   */
  useAgentCatalog(lookup: (ref: ConversationRef) => AgentCatalog | undefined): void {
    this.catalog = lookup;
  }

  /**
   * The agents for an empty room's sync, or nothing. Best-effort like the directory: a lookup that
   * throws costs the page its choice of agent, never the sync that carries the transcript.
   */
  private catalogFor(topicId: string, room: Room): AgentCatalog | undefined {
    if (!this.catalog || room.stored.size > 0) return undefined;
    try {
      return this.catalog(this.conversation(topicId));
    } catch (e) {
      console.warn(`[webui] agent catalog lookup failed for ${topicId}:`, e instanceof Error ? e.message : e);
      return undefined;
    }
  }

  /**
   * End the agent process behind each of these topics that is still idle, and say which were
   * ended. The page's "Close idle agents": `topicIds` is the list the operator confirmed, not a
   * fresh scan, so nothing is closed that they were not shown.
   *
   * Idle is checked twice, and neither check is the page's. Here: the topic exists and shows no
   * turn and no question right now (`typing` covers a background burst after a turn, which the
   * daemon's merger does not). Then the daemon's own gates (`reclaimIdleForRef`), which are the
   * idle sweeper's. A topic that began working after the dialog was drawn fails one of them and is
   * left alone — it comes back in `kept`, as does one whose runtime cannot resume a session, so the
   * page can say how many it could not close. The conversations themselves are untouched: the next
   * message in a topic starts its agent again where it left off.
   */
  closeIdle(topicIds: readonly string[]): { closed: string[]; kept: string[] } {
    const closed: string[] = [];
    const kept: string[] = [];
    for (const id of new Set(topicIds)) {
      if (!this.topics.has(id)) continue;
      const room = this.rooms.get(id);
      let ended = false;
      if (this.idleReclaim && !room?.typing && !room?.awaiting.size) {
        try {
          ended = this.idleReclaim(this.conversation(id));
        } catch (e) {
          console.warn(`[webui] could not close the agent of topic ${id}:`, e instanceof Error ? e.message : e);
        }
      }
      (ended ? closed : kept).push(id);
    }
    console.log(`[webui] "${this.instance.id}": closed ${closed.length} idle agent(s)${kept.length ? `, ${kept.length} left running` : ''}`);
    // The dots go grey now rather than at the next liveness poll, up to 15 s later.
    if (closed.length) this.announceTopics();
    return { closed, kept };
  }

  /** `scheduled`, swallowing a failing lookup for the same reason `liveOf` does. */
  private scheduledOf(topicId: string): boolean {
    if (!this.scheduled) return false;
    try {
      return this.scheduled(this.conversation(topicId));
    } catch (e) {
      // Read as "in use": a lookup that failed cannot say this topic is safe to throw away, and
      // keeping one topic too many costs a row where guessing wrong costs a task.
      console.warn('[webui] could not resolve whether a topic has scheduled tasks:', e instanceof Error ? e.message : e);
      return true;
    }
  }

  /**
   * Accept the terminal's attendance register, and redraw the switcher whenever it changes.
   *
   * Both halves matter and they pull in opposite directions. `topicList` reads it (pull, like
   * the workdir lookup), so a list built for any other reason is current without asking. But a
   * pane opening is not otherwise an event in this room — nothing is said, no message arrives —
   * so without the subscription the marker would appear only the next time something else
   * happened to announce the list, which on an idle topic is never.
   */
  useTerminalSessions(sessions: Pick<TerminalSessions, 'has' | 'onChange'>): void {
    this.terminal = sessions;
    sessions.onChange(() => this.announceTopics());
  }

  /**
   * The directory label for one topic, memoised for `DIR_TTL_MS`.
   *
   * Swallows a failing lookup rather than letting it out: this runs inside the path that
   * announces a topic list, which runs inside the path that posts a message, and a sidebar
   * label is not worth losing an answer over.
   */
  private dirOf(topicId: string): Topic['dir'] {
    if (!this.workdir) return undefined;
    const now = Date.now();
    const hit = this.dirCache.get(topicId);
    if (hit && now - hit.at < DIR_TTL_MS) return hit.dir;
    let found: ConversationWorkdir | undefined;
    try {
      found = this.workdir(this.conversation(topicId));
    } catch (e) {
      console.warn('[webui] could not resolve a topic working directory:', e instanceof Error ? e.message : e);
    }
    // basename('/') is '', and a directory with no last segment has no short name to show — the
    // full path is then both the label and the tooltip, which is honest and still fits.
    const full = found?.path;
    const dir = full
      ? { name: basename(full) || full, path: full, ...(found?.host ? { host: found.host } : {}) }
      : undefined;
    this.dirCache.set(topicId, { at: now, dir });
    return dir;
  }

  /**
   * Whether one topic still has an agent child behind it, swallowing a failing lookup for the
   * same reason `dirOf` does: this runs inside the path that announces a topic list, which runs
   * inside the path that posts a message. Unmemoised because the daemon answers it from a map —
   * it is the filesystem stat behind the directory that needed a TTL, not the crossing itself.
   */
  private liveOf(topicId: string): boolean {
    if (!this.liveness) return false;
    try {
      return this.liveness(this.conversation(topicId));
    } catch (e) {
      console.warn('[webui] could not resolve a topic agent state:', e instanceof Error ? e.message : e);
      return false;
    }
  }

  topicList(): Topic[] {
    return this.topics.list().map((t) => {
      const room = this.rooms.get(t.id);
      const dir = this.dirOf(t.id);
      const running = Boolean(room?.typing);
      const asking = this.awaitingQuestion(room);
      const stage = topicStage({
        running,
        asking,
        activity: { ...(t.outcome ? { outcome: t.outcome } : {}), ...(t.retry ? { retry: t.retry } : {}) },
        ...(t.seenAt !== undefined ? { seenAt: t.seenAt } : {}),
      });
      const line = stage === 'answer' ? this.questionLine(room) : t.outcome?.line;
      return {
        ...t,
        running,
        // Before `running` in meaning, not just in this object: a question on screen holds the
        // turn open, so both are true at once and only this one says what is actually happening.
        asking,
        live: this.liveOf(t.id),
        term: Boolean(this.terminal?.has(t.id)),
        msgCount: room?.msgCount ?? 0,
        stage,
        ...(line ? { line } : {}),
        ...(dir ? { dir } : {}),
      };
    });
  }

  /**
   * Whether a topic is waiting on the operator — as opposed to holding a menu they opened.
   *
   * `awaiting` means "a message with live buttons", which was the same thing while every such
   * message was a question. It is not: the directory menu is a control for the operator's own next
   * step (which project to work in), and since a new topic's choice of agent is a tap that types
   * `/agent` (2026-11-02), the daemon posts that menu into a conversation that has not started.
   * Counted as a question, a topic left mid-setup pinned itself to the top of the switcher in green
   * and pushed "Waiting on your answer" — about a conversation with no agent in it, which the
   * operator had just been looking at (reported 2026-11-03). It also turned the dot amber, saying
   * something was blocked when nothing was: no session exists until the menu is answered or a
   * message is sent, and the message is an answer of its own.
   *
   * `awaiting` itself is left alone, because the other two readers want the menu counted: `inUse`
   * will not evict a topic holding a clickable menu, and idle reclaim will not close an agent under
   * one. Those ask "would throwing this away lose something", not "is someone blocked".
   *
   * Fails safe: buttons this file does not recognise are a question, so a new kind of ask is
   * announced rather than silently missed.
   */
  private awaitingQuestion(room: Room | undefined): boolean {
    if (!room) return false;
    for (const id of room.awaiting) {
      const rec = room.stored.get(id);
      if (rec && isWorkdirMenu(rec.msg.buttons)) continue;
      return true;
    }
    return false;
  }

  private announceTopics(): void {
    const topics = this.topicList();
    this.watchStages(topics);
    this.sendTopics(topics, flagsOf(topics));
  }

  /** The one place a topic list reaches a client, so `lastFlags` cannot drift from what was sent. */
  private sendTopics(topics: Topic[], flags: string): void {
    this.lastFlags = flags;
    // The one event that crosses rooms: the switcher has to stay current without every client
    // subscribing to topics nobody is reading.
    for (const client of this.clients) this.deliver(client, { t: 'topics', topics });
  }

  // ── Subscribers ────────────────────────────────────────────────────────────

  /**
   * Attach a client to one topic, resuming from `lastEventId` when it can.
   *
   * The resume is the single biggest saving on a bad connection. `EventSource` reconnects by
   * itself after any blip and sends back the last id it saw; if the backlog still reaches that
   * far, the client is handed only what it missed. Re-sending the whole conversation every
   * time the radio hiccuped was what this protocol did before, and on a long topic that is
   * hundreds of kilobytes per hiccup.
   *
   * The id carries its topic (`<topic>.<seq>`), so a tab that switched topics cannot resume
   * against the wrong room's numbering — it falls back to a full sync, which is correct.
   */
  subscribe(topicId: string, send: Sink, lastEventId?: string): () => void {
    const client: Client = { topic: topicId, send };
    this.clients.add(client);
    const room = this.roomOf(topicId);
    const missed = this.replayFrom(room, topicId, lastEventId);
    const ok = missed
      ? missed.every((entry) => this.deliver(client, entry.ev, entry.seq)) &&
        // Status is state and is not in the backlog (see the `status` event), so a resumed stream
        // is told the current one outright — it may have changed, or been cleared, during the gap.
        this.deliver(client, { t: 'status', ...(room.status ? { status: room.status } : {}) })
      : this.deliver(client, this.syncEvent(topicId, room));
    if (ok) {
      console.log(
        `[webui] client attached to ${topicId}${missed ? ` (resumed, ${missed.length} missed)` : ' (full sync)'}; ${this.clients.size} watching`
      );
    }
    return () => {
      if (this.clients.delete(client)) console.log(`[webui] client left (${this.clients.size} watching)`);
    };
  }

  /** Events after `lastEventId`, or undefined when a full sync is the only honest answer. */
  private replayFrom(
    room: Room,
    topicId: string,
    lastEventId: string | undefined
  ): Array<{ seq: number; ev: WebEvent }> | undefined {
    if (!lastEventId) return undefined;
    const dot = lastEventId.lastIndexOf('.');
    if (dot < 0 || lastEventId.slice(0, dot) !== topicId) return undefined;
    const from = Number(lastEventId.slice(dot + 1));
    if (!Number.isFinite(from)) return undefined;
    const oldest = room.backlog[0];
    // Nothing kept that far back: the gap cannot be filled, so say so by re-syncing rather
    // than silently handing over a transcript with a hole in it.
    if (room.backlog.length > 0 && oldest && oldest.seq > from + 1) return undefined;
    return room.backlog.filter((entry) => entry.seq > from);
  }

  private syncEvent(topicId: string, room: Room): WebEvent {
    const agents = this.catalogFor(topicId, room);
    return {
      t: 'sync',
      topic: topicId,
      messages: [...room.stored.values()].map((s) => s.msg),
      commands: this.commands,
      topics: this.topicList(),
      // Which run of the daemon the ids in `messages` belong to. The page caches transcripts
      // and `nextId` restarts at `w1` every process, so without this a cached `w3` and a fresh
      // `w3` are indistinguishable to it — see the field's comment in `protocol.ts`.
      epoch: this.startedAt,
      ...(this.isStale(topicId, room) ? { stale: true } : {}),
      ...(room.status ? { status: room.status } : {}),
      ...(agents ? { agents } : {}),
    };
  }

  /**
   * Whether an empty room is empty because this process is younger than the topic.
   *
   * A kept transcript comes back non-empty and never reaches this; what does is a topic from before
   * every topic kept one (2.13.0), or one whose file could not be read, and a restart turns those
   * into rows that open onto nothing. The page needs to be able to tell that apart from a
   * topic that is simply new, because rendered identically they look like a broken page — which
   * is what they were reported as. `lastAt` is the persisted mark of activity, so a topic whose
   * last message predates this object is one whose transcript we no longer have.
   */
  private isStale(topicId: string, room: Room): boolean {
    if (room.stored.size > 0) return false;
    const topic = this.topics.get(topicId);
    return topic !== undefined && topic.lastAt < this.startedAt;
  }

  get watchers(): number {
    return this.clients.size;
  }

  // ── Emitting ───────────────────────────────────────────────────────────────

  /**
   * Announce an event in a topic: record it in that topic's backlog, then fan it out.
   *
   * Everything a client ever receives except the topic list goes through here, so the
   * sequence numbering and the backlog cannot disagree with what was actually sent.
   */
  private emit(topicId: string, ev: WebEvent): void {
    const room = this.roomOf(topicId);
    room.seq += 1;
    room.backlog.push({ seq: room.seq, ev });
    if (room.backlog.length > MAX_BACKLOG) room.backlog.shift();
    for (const client of this.clients) {
      if (client.topic === topicId) this.deliver(client, ev, room.seq);
    }
  }

  /**
   * Write to one client, dropping it if it fails. Returns whether it is still attached.
   *
   * The only place an event reaches a client, so one wedged socket can never take a turn down
   * with it — a failure here is a browser that went away, not a problem with the message.
   */
  private deliver(client: Client, ev: WebEvent, seq?: number): boolean {
    try {
      client.send(seq === undefined ? '' : `${client.topic}.${seq}`, ev);
      return true;
    } catch (e) {
      console.warn('[webui] dropping a client that failed to receive:', e instanceof Error ? e.message : e);
      this.clients.delete(client);
      return false;
    }
  }

  // ── The hold queue ─────────────────────────────────────────────────────────

  /**
   * Hold a message's edit instead of announcing it.
   *
   * Coalesced by message id, and the queue stores the ID rather than a snapshot on purpose:
   * the payload is materialised at flush time, so a held message is always sent at its newest
   * state and can never disagree with what a concurrent `sync` just handed someone.
   */
  private enqueue(room: Room, topicId: string, id: string): void {
    if (!room.queue.includes(id)) room.queue.push(id);
    const now = Date.now();
    if (room.holdUntil === 0) room.holdUntil = now + MAX_HOLD_MS;
    if (room.timer) clearTimeout(room.timer);
    const wait = Math.max(0, Math.min(SETTLE_MS, room.holdUntil - now));
    room.timer = setTimeout(() => this.flush(room, topicId), wait);
    // Never the reason the process stays alive: `daemon.stop()` is called directly by several
    // tests, and a live timer there hangs the runner.
    room.timer.unref();
  }

  /**
   * Send everything being held, oldest first.
   *
   * Called before any NON-edit event as well as on the timer, and that ordering rule is what
   * keeps the page readable: a tool bubble is a new message (which flushes), its progress is
   * an edit (which is held), and the text of the next segment is another new message (which
   * flushes again) — so the bubble's final state always arrives above the text that followed
   * it. Getting that backwards is the bug `daemon/render-order.test.ts` exists for, one layer
   * further up.
   */
  private flush(room: Room, topicId: string): void {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    room.holdUntil = 0;
    const queued = room.queue.splice(0);
    for (const id of queued) {
      const rec = room.stored.get(id);
      if (rec) this.emit(topicId, { t: 'msg', msg: rec.msg });
    }
  }

  // ── Outbound (daemon → page) ───────────────────────────────────────────────

  /**
   * Add a message to a topic.
   *
   * Resolves whether or not anybody is connected, deliberately: the ring is the conversation
   * and the clients are a fan-out of it. An adapter that failed when no browser was open would
   * fail every turn started before someone opened the page — and the daemon would report that
   * failure by posting into the same empty room.
   */
  post(
    topicId: string,
    part: Omit<WebMessage, 'id' | 'at' | 'buttons' | 'reactions'> & { buttons?: ButtonSpec[] },
    text: string
  ): WebMessage {
    const room = this.roomOf(topicId);
    this.flush(room, topicId);
    const msg: WebMessage = {
      ...part,
      // Ids are global and never reused, not per topic: the outbound pacer coalesces edits
      // into `edit:<channel>:<messageId>`, and every topic shares the one channel, so an id
      // restarting per topic would let one topic's edits supersede another's.
      id: this.nextId(),
      at: Date.now(),
      buttons: part.buttons ?? [],
      reactions: [],
    };
    if (room.stored.size >= MAX_MESSAGES) {
      const oldest = room.stored.keys().next().value;
      if (oldest !== undefined) {
        room.stored.delete(oldest);
        // A question that aged out of the ring is off screen, so it no longer holds the topic in
        // "waiting for you" — the buttons went with it.
        room.awaiting.delete(oldest);
      }
    }
    room.stored.set(msg.id, { msg, text });
    // The operator writing into the topic ends every wait that was on screen. Buttons alone could
    // not say that: a `/cd` or `/model` menu is never retired when it is ignored — the user types
    // `hello` instead of tapping, gets an answer, and the menu keeps its buttons (still clickable,
    // correctly) while the dot went on pulsing amber over a topic that was waiting on nobody. A
    // real question is not lost by this: text sent while an ask is pending IS its answer
    // (ConversationRegistry.route → answersPendingQuestion), so that ask is retired anyway, and a
    // follow-up question arrives as a new post or a button edit after this one, which marks the
    // topic again. The one gap is a daemon command typed mid-question (`/context`), which route
    // answers before the ask gets its turn: the question stays up with the dot back to running
    // blue. Accepted — the question is still on screen above the reply, and `/stop` / `/new`, the
    // commands a user actually reaches for there, end the ask themselves.
    if (msg.own) room.awaiting.clear();
    if (msg.buttons.length > 0) room.awaiting.add(msg.id);
    room.msgCount += 1;
    this.emit(topicId, { t: 'msg', msg });
    this.topics.touch(topicId, msg.at);
    this.keep(topicId);
    this.announceTopics();
    return msg;
  }

  /**
   * Replace a message's body and buttons in place.
   *
   * A text-only edit is HELD (see `enqueue`) — that is streaming progress, and coalescing it is
   * the whole point of the queue. An edit that carries BUTTONS is sent at once instead, because
   * every one of them is the acknowledgement of a tap: a menu page turn, a question being retired,
   * a multi-select tick. The page disables a button the moment it is clicked and re-enables it
   * only when the message repaints, so holding that repaint for the settle window leaves the
   * control the user just pressed greyed out and unpressable for a second and a half — which on a
   * multi-select (tap, untap, tap again) is not a delay but a broken control.
   *
   * `screen` follows the buttons: given, it is the message's new screen; absent, the message is no
   * longer that screen. Retiring a menu or handing its message to the scheduled-task list both go
   * through here without one, and either would otherwise leave a settings screen whose controls no
   * longer exist.
   */
  revise(
    topicId: string,
    id: string,
    text: string,
    buttons?: ButtonSpec[],
    screen?: SettingsScreen
  ): void {
    const room = this.roomOf(topicId);
    const rec = this.mustFind(room, id, 'edit');
    rec.text = text;
    // A tool bubble stays one: its kind was given on the send, and every edit after it is the
    // same bubble with another line or another ✓ (see SendOptions in adapter.ts).
    const html = rec.msg.kind === 'tools' ? renderWebToolLines(text) : renderWebMarkdown(text);
    rec.msg = { ...rec.msg, html, ...(buttons ? { buttons } : {}) };
    if (screen) {
      rec.msg.settings = screen;
      delete rec.msg.wasSettings;
    } else {
      // Retired rather than handed to another menu (the scheduled-task list keeps its buttons and
      // is a menu again). The page draws settings screens in a page of their own, so the record
      // has to say this message used to be one — otherwise a reload would put its farewell line
      // into the transcript.
      if (rec.msg.settings && (!buttons || buttons.length === 0)) rec.msg.wasSettings = true;
      delete rec.msg.settings;
    }
    room.stored.set(id, rec);
    this.enqueue(room, topicId, id);
    this.keep(topicId);
    if (buttons) this.flush(room, topicId);
    // An edit carrying buttons is how a question is both posted and retired (an empty array is
    // `retireAsk` stripping them), so it is also where the switcher stops or starts saying this
    // topic is waiting on the user. Announced only when the set actually changed: a menu turning
    // its page edits buttons too, and the sidebar has nothing to redraw for that.
    if (buttons && this.setAwaiting(room, id, buttons.length > 0)) this.announceTopics();
  }

  /** Record whether a message is holding live buttons. Returns whether that changed. */
  private setAwaiting(room: Room, id: string, on: boolean): boolean {
    if (on === room.awaiting.has(id)) return false;
    if (on) room.awaiting.add(id);
    else room.awaiting.delete(id);
    return true;
  }

  /** Remove a message. Removing one that is already gone is success, not an error. */
  remove(topicId: string, id: string): void {
    const room = this.roomOf(topicId);
    this.flush(room, topicId);
    if (!room.stored.delete(id)) return;
    this.emit(topicId, { t: 'del', id });
    this.keep(topicId);
    // Deleting the message deletes its buttons with it — the commonest way an unanswered menu
    // leaves the screen (`/new` sweeping a topic), and it must not leave the dot waiting forever.
    if (this.setAwaiting(room, id, false)) this.announceTopics();
  }

  /**
   * Add or remove a lifecycle reaction (👀 / ✅ / ❌).
   *
   * Silent on an unknown id rather than throwing, unlike an edit: reactions are best-effort
   * decoration that every caller already wraps in a catch, and one that cannot land costs the
   * user nothing — whereas an edit that cannot land costs them the text.
   */
  react(topicId: string, id: string, emoji: string, on: boolean): void {
    const room = this.roomOf(topicId);
    const rec = room.stored.get(id);
    if (!rec) return;
    this.flush(room, topicId);
    const kept = rec.msg.reactions.filter((e) => e !== emoji);
    rec.msg = { ...rec.msg, reactions: on ? [...kept, emoji] : kept };
    room.stored.set(id, rec);
    this.emit(topicId, { t: 'react', id, emoji, on });
    this.keep(topicId);
  }

  setTyping(topicId: string, on: boolean): void {
    const room = this.roomOf(topicId);
    if (room.typing === on) return;
    room.typing = on;
    this.flush(room, topicId);
    this.emit(topicId, { t: 'typing', on });
    this.announceTopics();
  }

  /**
   * Replace a topic's agent status, and tell whoever is reading that topic.
   *
   * Delivered rather than emitted: it bypasses the backlog and its sequence numbers (see the
   * `status` event for why), so it reaches the clients on this topic and nobody else — a status is
   * as per-topic as a message, and only the topic LIST crosses rooms. A repeat is dropped here as
   * well as by the daemon's board, because a topic can be re-pushed the same status by a reset that
   * found nothing to clear.
   */
  setStatus(topicId: string, status: AgentStatus | undefined): void {
    const room = this.roomOf(topicId);
    const key = status ? JSON.stringify(status) : undefined;
    if (key === room.statusKey) return;
    room.status = status;
    room.statusKey = key;
    const ev: WebEvent = { t: 'status', ...(status ? { status } : {}) };
    for (const client of [...this.clients]) {
      if (client.topic === topicId) this.deliver(client, ev);
    }
  }

  /** The registered slash vocabulary, for the page's autocomplete. Not per topic. */
  setCommands(commands: SlashCommandSpec[]): void {
    this.commands = commands;
    for (const client of this.clients) this.deliver(client, { t: 'commands', commands });
  }

  /** The rendered body of a message, for quoting it. Empty when it is no longer held. */
  htmlOf(topicId: string, id: string): string {
    return this.roomOf(topicId).stored.get(id)?.msg.html ?? '';
  }

  /**
   * Register a file, and return the page-relative URL that serves it.
   *
   * The path never reaches the browser and the browser never names one: it gets an opaque
   * token this map alone can resolve. Relative (`f/<token>`, no leading slash) so the page
   * works unchanged when a reverse proxy mounts it under a sub-path.
   *
   * `upload` marks a file this room wrote itself (see `submit`, `publishCopy`): the download waits
   * for its write, and when the table lets it go nothing else can reach it, so it is deleted then.
   * A path published without it is someone else's and is never touched.
   */
  publish(path: string, name: string, upload?: { ready: Promise<void> }): string {
    if (this.downloads.size >= MAX_DOWNLOADS) {
      const oldest = this.downloads.keys().next().value;
      if (oldest !== undefined) {
        const gone = this.downloads.get(oldest);
        this.downloads.delete(oldest);
        if (gone?.owned) void gone.ready?.then(() => this.uploads?.discard(gone.path));
      }
    }
    const token = randomUUID().replace(/-/g, '');
    this.downloads.set(token, { path, name, ...(upload ? { ready: upload.ready, owned: true } : {}) });
    return `f/${token}`;
  }

  /**
   * Publish a file the agent sent, from a copy taken now rather than from where it lies.
   *
   * Every other platform uploads the bytes inside `sendFile`; this one reads them when someone
   * clicks, which can be days later, and by then the path may name nothing. It names nothing at
   * once for an agent on a remote host: the daemon fetches that file into a temporary one and
   * removes it as soon as `sendFile` returns (`daemon.ts` sendAgentFile), so every such link was a
   * 404 — which a browser following a `download` link saves as `<token>.json`. A local agent's
   * `/tmp` is no better, and a report rewritten since would be served as its newer self. So the copy
   * is complete before this resolves, and like an upload it is deleted when the table lets it go.
   *
   * Without a store (a test that does not care) the path itself is published, as before.
   */
  async publishCopy(path: string, name: string): Promise<string> {
    const store = this.uploads;
    if (!store) return this.publish(path, name);
    return this.publish(await store.copy(path), name, { ready: Promise.resolve() });
  }

  resolveDownload(token: string): Download | undefined {
    return this.downloads.get(token);
  }

  /**
   * Where the page fetches a published file rendered for reading: the same token, under the route
   * that renders it (`server.ts` `view`) instead of the one that hands over the bytes. Here because
   * this is where `f/<token>` is minted.
   */
  viewUrl(url: string): string {
    return url.replace(/^f\//, 'view/');
  }

  useUploads(store: UploadStore): void {
    this.uploads = store;
  }

  /**
   * Take the kept transcripts back into their rooms, and keep every topic from here on.
   *
   * Called once, before anyone can attach. A kept topic the store no longer has — evicted, deleted
   * or swept by a run that failed to remove its file — is dropped: nothing will write it again, and
   * nothing should read it.
   *
   * Restored messages keep their ids and their run (`g`), which is what lets the page match them to
   * what its own cache already holds — and add what it never received, which is the point (see
   * `TranscriptStore`). Two things follow. The id counter starts past every restored id, because
   * `nextId` restarts at w1 each run and a new w5 in the same ring would overwrite a kept one. And
   * buttons are stripped: the process that would answer them is gone, and the ids they carry mean
   * nothing to the new one — the same reason the page strips them from history.
   */
  useTranscripts(store: TranscriptStore): void {
    this.transcripts = store;
    let top = this.seqId;
    for (const [topicId, kept] of store.load()) {
      if (!this.topics.has(topicId)) {
        store.drop(topicId);
        continue;
      }
      const room = this.roomOf(topicId);
      for (const k of kept.slice(-MAX_MESSAGES)) {
        room.stored.set(k.msg.id, { text: k.text, msg: { ...k.msg, buttons: [] } });
        const n = /^w(\d+)$/.exec(k.msg.id);
        if (n) top = Math.max(top, Number(n[1]));
      }
      room.msgCount = room.stored.size;
    }
    this.seqId = top;
  }

  /** Note that a topic's ring changed; it is written within `KEEP_MS`. */
  private keep(topicId: string): void {
    if (!this.transcripts || !this.topics.has(topicId)) return;
    this.unsaved.add(topicId);
    if (this.keepTimer) return;
    this.keepTimer = setTimeout(() => this.writeKept(), KEEP_MS);
    // Never what keeps the process alive; `dispose` writes whatever is still pending.
    this.keepTimer.unref();
  }

  /** Write every topic changed since the last write. */
  private writeKept(): void {
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
    const store = this.transcripts;
    if (!store) return;
    for (const topicId of this.unsaved) {
      const room = this.rooms.get(topicId);
      if (!room || !this.topics.has(topicId)) continue;
      store.save(
        topicId,
        [...room.stored.values()].map((s) => ({ text: s.text, msg: { ...s.msg, g: s.msg.g ?? this.startedAt } }))
      );
    }
    this.unsaved.clear();
  }

  private forgetKept(topicId: string): void {
    this.unsaved.delete(topicId);
    this.transcripts?.drop(topicId);
  }

  /** Send everything being held, write what topics have not, and stop every timer. Called on shutdown. */
  dispose(): void {
    for (const [topicId, room] of this.rooms) this.flush(room, topicId);
    this.writeKept();
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.liveTimer = null;
    for (const t of this.notifyTimers.values()) clearTimeout(t);
    this.notifyTimers.clear();
  }

  // ── Inbound (page → daemon) ────────────────────────────────────────────────

  onMessage(handler: (m: InboundMessage) => void): void {
    this.onMsg = handler;
  }

  onButton(handler: (ev: ButtonInteraction) => void): void {
    this.onBtn = handler;
  }

  /**
   * The operator sent something. Echo it into the topic, then hand it to the daemon.
   *
   * Idempotent on `nonce`, which is what lets the page retry a request that timed out on a bad
   * link. Without it the honest choices are "retry and risk sending twice" or "do not retry",
   * and both are worse than remembering 64 strings.
   */
  submit(req: SendRequest): 'accepted' | 'duplicate' | 'unknown-topic' {
    if (!this.topics.has(req.topic)) return 'unknown-topic';
    if (req.nonce !== undefined) {
      if (this.nonces.has(req.nonce)) return 'duplicate';
      if (this.nonces.size >= MAX_NONCES) {
        const oldest = this.nonces.values().next().value;
        if (oldest !== undefined) this.nonces.delete(oldest);
      }
      this.nonces.add(req.nonce);
    }
    const attachments = (req.files ?? []).map(toAttachment);
    const text = req.text.trim();
    // The inbound gate drops an empty message anyway; stopping here keeps an accidental Enter
    // from appearing in the transcript as a blank bubble the agent never saw.
    if (!text && attachments.length === 0) return 'accepted';
    const msg = this.record(req, attachments);
    const inbound: InboundMessage = {
      conversation: this.conversation(req.topic),
      platformType: 'webui',
      messageId: msg.id,
      content: req.text,
      timestamp: msg.at,
      ...(attachments.length > 0 ? { attachments } : {}),
      authorIsBot: false,
    };
    // The listen allowlist, which `satori-core` applies for every other platform and this
    // adapter therefore has to apply for itself. `main` covers every topic, `main/<id>` names
    // one — the matching `addressSelects` already implements.
    if (!this.channelAllowed(inbound.conversation)) {
      console.log(`[webui] "${this.instance.id}": dropped a message — chat.channels does not list ${CHANNEL}/${req.topic}`);
      return 'accepted';
    }
    // The attachment count is in the line because this is where "did it arrive with its file" gets
    // answered: the preview is the first 50 characters of the text, which says nothing of what
    // rode along, and a file sent alone would otherwise log an empty line.
    const files = attachments.length > 0 ? ` (+${attachments.length} file${attachments.length === 1 ? '' : 's'})` : '';
    console.log(`[in] ${describeConversation(inbound.conversation)} @${OWNER}: ${text.slice(0, 50).replace(/\n/g, ' ')}${files}`);
    this.onMsg?.(inbound);
    // What the operator says is what moves a topic — `/agent`, `/cd`, `/new`, a bare `/cc` — so the
    // memoised directory label is let go here, and the announcement the daemon's answer makes reads
    // the new one. Without this a new topic's first choice was answered under a row still naming the
    // default agent's machine for the rest of the TTL, and nothing announced the list after it.
    this.dirCache.delete(req.topic);
    return 'accepted';
  }

  /**
   * Put the operator's message into the topic, or — for the one request that is allowed to be
   * quiet — hand back an id without one.
   *
   * A quiet request is the page asking the daemon for the settings screen it draws itself: the
   * daemon still needs a message id for the inbound, but the conversation gets no row, no echo,
   * and no title seeded from a command nobody typed. It is deliberately narrow — a bare
   * `/setting` with no attachments. Any other text that carries the flag is delivered as an
   * ordinary message: a client must not be able to make something it sent disappear from the
   * conversation by asking.
   */
  private record(
    req: SendRequest,
    attachments: Array<NonNullable<InboundMessage['attachments']>[number]>
  ): { id: string; at: number } {
    const quiet = req.quiet === true && attachments.length === 0 && req.text.trim() === '/setting';
    if (quiet) return { id: this.nextId(), at: Date.now() };
    if (this.topics.seed(req.topic, req.text)) this.announceTopics();
    // The nonce rides back out on the echo: the page has already shown this message locally, and
    // that placeholder is retired by the echo that claims it. Absent when the client did not send
    // one, in which case the page had no placeholder to retire either.
    return this.post(
      req.topic,
      {
        own: true,
        html: renderBody(req.text, attachments, this.keepPictures(req.files ?? [])),
        ...(req.nonce !== undefined ? { nonce: req.nonce } : {}),
      },
      req.text
    );
  }

  /**
   * A button was clicked.
   *
   * The message id is checked against the topic's ring before it is forwarded: it arrives from
   * the page, and the daemon's click handlers go on to EDIT the message it names, so an id
   * nothing here holds is a stale tab or a hand-made request and neither should reach a writer.
   */
  click(req: ClickRequest): boolean {
    if (!this.topics.has(req.topic) || !this.roomOf(req.topic).stored.has(req.messageId)) return false;
    this.onBtn?.({
      conversation: this.conversation(req.topic),
      messageId: req.messageId,
      buttonId: req.buttonId,
      ...(req.value !== undefined ? { value: req.value } : {}),
    });
    // A tap moves a topic as typing does (a `/cd` or `/agent` menu pick), so the same as `submit`.
    this.dirCache.delete(req.topic);
    return true;
  }

  /** Replay for `talkcode fetch-messages`, oldest first, in the shape history has. */
  history(topicId: string, opts: { limit?: number; before?: string }): InboundMessage[] {
    const all = [...this.roomOf(topicId).stored.values()];
    const cut = opts.before ? all.findIndex((s) => s.msg.id === opts.before) : -1;
    const upto = cut >= 0 ? all.slice(0, cut) : all;
    const limited = opts.limit !== undefined ? upto.slice(-opts.limit) : upto;
    return limited.map((s) => ({
      conversation: this.conversation(topicId),
      platformType: 'webui',
      messageId: s.msg.id,
      content: s.text,
      timestamp: s.msg.at,
      authorIsBot: !s.msg.own,
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Keep each picture the operator sent and publish it, so their message can show what it showed
   * the agent instead of a file name.
   *
   * It has to be kept HERE: the page drops the bytes once they are sent (they are base64 in a
   * request body, not something to put in its transcript cache), and the copy the daemon saves for
   * the agent is written later, by the turn, and named for the agent. Pictures only, by the same
   * closed list that decides what may be served as itself (`inlineImageType`); anything else stays
   * a name, as before.
   */
  private keepPictures(files: NonNullable<SendRequest['files']>): Array<{ name: string; url: string }> {
    const store = this.uploads;
    if (!store) return [];
    return files
      .filter((f) => inlineImageType(f.name) !== undefined)
      .map((f) => {
        const { path, ready } = store.save(f.name, f.data);
        return { name: f.name, url: this.publish(path, f.name, { ready }) };
      });
  }
  private roomOf(topicId: string): Room {
    let room = this.rooms.get(topicId);
    if (!room) {
      room = {
        stored: new Map(),
        typing: false,
        seq: 0,
        backlog: [],
        queue: [],
        timer: null,
        holdUntil: 0,
        msgCount: 0,
        awaiting: new Set(),
      };
      this.rooms.set(topicId, room);
    }
    return room;
  }

  private nextId(): string {
    this.seqId += 1;
    return `w${this.seqId}`;
  }

  private mustFind(room: Room, id: string, op: string): Stored {
    const rec = room.stored.get(id);
    if (rec) return rec;
    // MessageNotEditableError, specifically: it means "this message will never accept another
    // edit", which is exactly true of one the ring has evicted. StreamBuffer answers it by
    // sealing and continuing in a fresh message; a silent success would instead have it record
    // text as delivered that nobody can see.
    throw new MessageNotEditableError(`[webui] cannot ${op} message ${id}: it is no longer on screen`);
  }

  private conversation(topicId: string): ConversationRef {
    // `kind: 'direct'` even though a lane is set, and that is load-bearing rather than lazy:
    // with `'thread'` the inbound gate would fall through to its mention requirement, and a
    // brand-new topic — no DM, no active session, no @ — would have its FIRST message silently
    // dropped. A DM that has lanes is a shape the gateway already knows (a Telegram DM topic).
    return { platform: this.instance.id, channel: CHANNEL, thread: topicId, kind: 'direct', user: OWNER };
  }

  private channelAllowed(ref: ConversationRef): boolean {
    const allow = this.instance.chat.channels;
    return allow.length === 0 || addressListed(allow, addressOf(ref));
  }
}

/**
 * The part of a topic list the liveness poll is allowed to redraw for.
 *
 * Only the three derived states the switcher paints a dot from, deliberately: the poll must not
 * notice a title, an order or an unread count, because whatever changed those already announced.
 */
/**
 * What a topic asks of the operator: its stage, except that a sub-agent's topic (one with a parent)
 * asks only with a question of its own. Its reply and its failures go to the agent that opened it
 * (daemon/delegation.ts), which says what comes of them; notifying for them as well would have the
 * operator read every sub-agent's reply after all, which is the reading a parent agent is there to do.
 * The page's Needs-you list applies the same rule (page.ts needsYou).
 */
export function operatorStage(t: Pick<Topic, 'stage' | 'parent'>): TopicStage {
  const stage = t.stage ?? 'idle';
  return t.parent !== undefined && stage !== 'answer' && needsPerson(stage) ? 'idle' : stage;
}

/** What a notification says under a topic's name. */
function noticeBody(stage: TopicStage, line: string | undefined): string {
  const what = stage === 'answer' ? 'Waiting on your answer' : stage === 'failed' ? 'Failed' : 'Finished';
  return line ? `${what}: ${line}` : what;
}

/**
 * Whether a message's buttons are a directory menu's rather than a question's.
 *
 * `core/workdir-menu.ts` owns the id grammar; this only asks it. A menu whose page turn and pick
 * buttons both parse is one of its own, and no other menu or ask in the gateway uses those ids.
 */
function isWorkdirMenu(buttons: ButtonSpec[]): boolean {
  return buttons.length > 0 && buttons.every((b) => parseWorkdirButtonId(b.id) !== null);
}

function flagsOf(topics: Topic[]): string {
  // The directory too, so the poll is also what corrects a row whose move landed after the
  // announcement that followed it (a `/cd` on a host lists the directory over the link first):
  // the label is memoised for DIR_TTL_MS, shorter than the poll, so each poll reads it fresh.
  return topics
    .map((t) => `${t.id}${t.live ? 'L' : ''}${t.asking ? 'A' : ''}${t.running ? 'R' : ''}${t.dir ? `@${t.dir.host ?? ''}:${t.dir.path}` : ''}`)
    .join(',');
}

/**
 * The image types a published file may be served as itself, instead of as an opaque download.
 *
 * Every other file leaves this daemon as `application/octet-stream; attachment` so that an
 * agent-sent `.html` cannot render on the origin holding this session's cookie — see
 * `server.ts` `download()`. An image has to break that rule to be visible at all, so the set
 * is a closed list of RASTER formats and the decision is made in exactly one place.
 *
 * Two things make the exception safe, and both are load-bearing:
 *
 * - **No SVG.** An `.svg` is XML with `<script>` in it and a browser runs it as a document.
 *   It is the one image format that is also code, and it stays a download.
 * - **The extension is trusted only because `nosniff` pins it.** A file *named* `.png` whose
 *   bytes are HTML is served as `image/png`, and `X-Content-Type-Options: nosniff` forbids the
 *   browser from sniffing a document back out of it. It renders as a broken image, which is
 *   the correct outcome; without `nosniff` the same file would be a stored XSS.
 *
 * Deliberately absent: PDF (a document format with its own scripting, which browsers render),
 * and TIFF (which no browser displays — an inline TIFF would be a broken image where a
 * download was useful).
 */
export function inlineImageType(name: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    default:
      return undefined;
  }
}

/** A browser upload, as the attachment pipeline wants it. */
function toAttachment(file: { name: string; mime: string; data: string }): NonNullable<InboundMessage['attachments']>[number] {
  return {
    // `audio` for the page's own voice recordings (and any uploaded audio file): it is what makes a
    // recording sent on its own a voice message the daemon transcribes (see core/voice.ts).
    type: file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('audio/') ? 'audio' : 'file',
    // A `data:` URL, the shape `adapter-telegram` already hands over for every inbound photo —
    // so `daemon/attachment-io.ts` has a branch for it, and the SSRF guard it would otherwise
    // apply has nothing to act on (no host to resolve, no request to make). Writing the bytes
    // to a temp file and passing `file://` was the obvious alternative and is refused outright
    // by that same guard, which admits http(s) only.
    url: `data:${file.mime || 'application/octet-stream'};base64,${file.data}`,
    name: file.name,
    ...(file.mime ? { mime: file.mime } : {}),
  };
}

/**
 * The operator's own message: their text verbatim, the pictures they sent, and a line naming
 * whatever they attached.
 *
 * Verbatim, NOT through `renderWebMarkdown` the way the agent's side is. What the operator
 * typed is a prompt, and a prompt is the one text on this page whose exact characters matter:
 * it is what the agent received, and this echo is where you check that. Rendering it swallowed
 * the difference — a list written "1. … 2. …" and interrupted by a line the parser did not read
 * as an item came back "1. … 1. …", so the transcript disagreed with the compose box about what
 * had been sent. Every other platform in this directory shows the user's own message as their
 * client typed it; this is that same behaviour, arrived at from a bug report.
 *
 * `escapeHtml` still runs, and must: verbatim means the characters, not the markup.
 *
 * A picture is an `img.shot` — the class the page already opens full-screen on a tap and hides
 * when it 404s — and its name chip stays below it either way. That chip is what is left once the
 * download table forgets the file or a restart empties it, exactly as with a picture the agent sent.
 */
function renderBody(
  text: string,
  attachments: ReadonlyArray<{ name?: string }>,
  shots: ReadonlyArray<{ name: string; url: string }> = []
): string {
  const body = `<div class="raw">${escapeHtml(text)}</div>`;
  if (attachments.length === 0) return body;
  const pictures = shots.length
    ? `<div class="shots">${shots
        .map((s) => `<img class="shot" src="${escapeHtml(s.url)}" alt="${escapeHtml(s.name)}" loading="lazy">`)
        .join('')}</div>`
    : '';
  const names = attachments.map((a) => `<span class="chip">${escapeHtml(a.name ?? 'file')}</span>`).join('');
  return `${body}${pictures}<div class="files">${names}</div>`;
}

export { TopicStore, type Topic } from './topics.js';
