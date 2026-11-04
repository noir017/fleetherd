import { z } from 'zod';
import type { InboundMessage } from '../types.js';

/**
 * IPC protocol for reverse commands (daemon <-> short-lived CLI process, unix
 * socket, newline-delimited JSON).
 *
 * Reverse commands (send-file / reply / react / fetch-messages …) don't connect to
 * the platform directly; they connect back to the daemon, which resolves them via
 * "turn token -> current session channel" and executes.
 *
 * Trust boundary: the peer is an arbitrary short-lived process (the agent subprocess)
 * and its JSON is untrusted. So before dispatch in server.ts we must validate
 * structure at runtime with this file's zod schema (parseIpcRequest), never
 * `as IpcRequest` blindly — a malformed/missing-field action would otherwise carry
 * undefined all the way down to the platform call layer.
 */

/** Optional channel: empty = current session. Empty string is illegal (treated as unset), hence min(1). */
const channelId = z.string().min(1).optional();

/**
 * How long an unanswered `ask` waits before giving up, when the caller names no `--timeout`.
 *
 * Lives in the protocol rather than in either side because BOTH sides need it and they need the
 * same number: the daemon arms its timer with it, and the CLI sizes its own socket deadline as this
 * plus a margin. Default is 1 hour (3,600,000ms), matching session.idleTimeoutMs.
 */
export const DEFAULT_ASK_TIMEOUT_MS = 3_600_000;

/**
 * How long an unanswered `ask` waits before sending an intermediate reminder notice.
 * Default is 30 minutes (1,800,000ms).
 */
export const DEFAULT_ASK_REMINDER_MS = 1_800_000;

/**
 * Intermediate reminder message sent when a question has been pending with no answer for 30 minutes.
 */
export const DEFAULT_ASK_REMINDER_TEXT =
  '⏳ Still waiting for a response to the question above (30 minutes elapsed). Click an option or type a reply; the question will automatically close after 1 hour.';

/** Extra socket-deadline headroom the CLI adds on top of the ask timeout, so the daemon gives up first. */
export const ASK_CLIENT_TIMEOUT_MARGIN_MS = 10_000;

/**
 * How many topic rows `channels` returns when the caller names no `--limit`. Here for the reason the
 * ask timeout is: the CLI prints it in its help line and the daemon applies it, and they must agree.
 * Thirty is a screenful of recent work; the live deployment had 335 conversations on 2026-09-30.
 */
export const DEFAULT_CHANNEL_LIMIT = 30;

/**
 * Zod schema per action kind. Each arm maps one-to-one to the IpcAction union below;
 * a new action must be added in both, kept aligned at compile time via z.infer.
 * strict() rejects extra fields, narrowing the trusted input surface.
 */
const IpcActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('send-message'), channelId, text: z.string() }).strict(),
  z
    .object({ kind: z.literal('reply'), messageId: z.string().min(1), channelId, text: z.string() })
    .strict(),
  z
    .object({ kind: z.literal('edit-message'), messageId: z.string().min(1), channelId, text: z.string() })
    .strict(),
  z
    .object({
      kind: z.literal('send-file'),
      path: z.string().min(1),
      name: z.string().optional(),
      caption: z.string().optional(),
      channelId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('react'),
      messageId: z.string().min(1),
      emoji: z.string().min(1),
      channelId,
    })
    .strict(),
  z.object({ kind: z.literal('delete'), messageId: z.string().min(1), channelId }).strict(),
  z
    .object({
      kind: z.literal('fetch-messages'),
      channelId,
      limit: z.number().int().positive().optional(),
      before: z.string().min(1).optional(),
      // Presentation-only: which columns the CLI renders to stdout. The daemon returns full
      // messages regardless; field selection + truncation + TOON happen at the CLI boundary.
      fields: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('create-thread'),
      messageId: z.string().min(1),
      name: z.string().min(1),
      channelId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ask'),
      prompt: z.string(),
      options: z.array(z.string()),
      channelId,
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  // Reads the calling conversation's own transcripts only — there is no channel override, because
  // the log is keyed by conversation, and another conversation's voice notes are not this agent's.
  z.object({ kind: z.literal('voice-log'), limit: z.number().int().positive().optional() }).strict(),
  // Lists places, so it has no target of its own — no channelId, for the same reason voice-log has none.
  z
    .object({
      kind: z.literal('list-channels'),
      platform: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  // channelId here is where the task's output goes (and, for a fixed session, the conversation it
  // runs in). Which of prompt/bash, cron/at is present — and every rule linking them — is checked by
  // core/schedule.ts buildTask, which can say which flag is wrong; the boundary checks shape only.
  z
    .object({
      kind: z.literal('schedule-add'),
      channelId,
      name: z.string().min(1).max(200).optional(),
      cron: z.string().min(1).max(200).optional(),
      at: z.string().min(1).max(100).optional(),
      tz: z.string().min(1).max(64).optional(),
      prompt: z.string().min(1).max(20_000).optional(),
      bash: z.string().min(1).max(20_000).optional(),
      agent: z.string().min(1).optional(),
      session: z.enum(['fixed', 'new', 'daily']).optional(),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('schedule-list'), id: z.string().min(1).optional() }).strict(),
  // About the whole deployment: no target, so no channelId.
  z.object({ kind: z.literal('reload-config') }).strict(),
  // The hosts (pods) agents run on (daemon/pod-admin.ts). The daemon validates the values in full;
  // these bounds only keep a malformed request from carrying a megabyte.
  z.object({ kind: z.literal('pod-list') }).strict(),
  z
    .object({
      kind: z.literal('pod-add'),
      name: z.string().min(1).max(32),
      ssh: z.string().min(1).max(300),
      hostKey: z.string().min(1).max(16_000),
    })
    .strict(),
  z.object({ kind: z.literal('pod-remove'), name: z.string().min(1).max(32) }).strict(),
  // The gateway's own skills (daemon/skills-store.ts). `action` decides which of the optional
  // fields matter; the store validates names, paths, versions and content in full, with a message
  // that says what is wrong. Bounds here only keep a malformed request from carrying a megabyte.
  z
    .object({
      kind: z.literal('skills'),
      action: z.enum([
        'list',
        'show',
        'create',
        'patch',
        'write-file',
        'remove-file',
        'archive',
        'restore',
        'pin',
        'unpin',
        'history',
        'revert',
      ]),
      name: z.string().min(1).max(64).optional(),
      file: z.string().min(1).max(300).optional(),
      version: z.string().min(1).max(64).optional(),
      content: z.string().max(1_048_576).optional(),
      description: z.string().min(1).max(2_000).optional(),
      body: z.string().max(32_000).optional(),
      id: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('schedule-op'), id: z.string().min(1), op: z.enum(['remove', 'pause', 'resume', 'run']) })
    .strict(),
  // Sub-agents (daemon/delegation.ts). None takes a channelId: they act from the asking conversation
  // on the topics it opened, each named as `topic`, and the daemon refuses any other. Bounds are
  // generous but present — `text` is a whole task, written for an agent that has seen nothing else.
  z.object({ kind: z.literal('task-agents') }).strict(),
  z.object({ kind: z.literal('task-list'), limit: z.number().int().positive().max(200).optional() }).strict(),
  z
    .object({
      kind: z.literal('task-new'),
      agent: z.string().min(1).max(100),
      text: z.string().min(1).max(20_000),
      cwd: z.string().min(1).max(4_096).optional(),
      title: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task-send'),
      topic: z.string().min(1).max(200),
      text: z.string().min(1).max(20_000),
      interrupt: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task-read'),
      topic: z.string().min(1).max(200),
      limit: z.number().int().positive().max(100).optional(),
      full: z.boolean().optional(),
      tail: z.number().int().positive().max(500).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('task-status'), topic: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('task-stop'), topic: z.string().min(1).max(200) }).strict(),
  // The conversation library (history/store.ts). A search query is words, not SQL; the bounds
  // only keep a malformed request from carrying a megabyte. None takes a channel: the library is
  // every conversation the gateway has carried, and a target would mean "search somewhere else".
  z
    .object({
      kind: z.literal('sessions-search'),
      query: z.string().min(1).max(2_000),
      agent: z.string().min(1).max(100).optional(),
      days: z.number().int().positive().max(3_650).optional(),
      limit: z.number().int().positive().max(100).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('sessions-read'),
      session: z.string().min(1).max(200),
      around: z.number().int().positive().optional(),
      window: z.number().int().min(0).max(100).optional(),
      // The read filters. `turn` is a word (`last`/`done`) or a turn number as text, so one field
      // carries both without a second flag; the store validates which it is and says so.
      role: z.enum(['user', 'agent', 'tool']).optional(),
      turn: z.string().min(1).max(20).optional(),
      // No upper bound here: the store keeps the newest 100 and says so in the answer's note,
      // which is more useful to an agent than a schema rejection naming a number it cannot see.
      // The lower bound is stated for the same reason — "too small" alone does not say what to
      // ask for.
      turns: z.number().int().positive('must be at least 1 (the store keeps the newest 100)').optional(),
      since: z.number().int().positive().optional(),
      grep: z.string().min(1).max(200).optional(),
      tail: z.number().int().positive().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('sessions-list'),
      days: z.number().int().positive().max(3_650).optional(),
      limit: z.number().int().positive().max(200).optional(),
    })
    .strict(),
]);

const IpcRequestSchema = z
  .object({
    token: z.string().min(1),
    action: IpcActionSchema,
  })
  .strict();

/**
 * Validate one IPC request from the peer. On success returns a type-safe IpcRequest;
 * on failure returns an error with the offending path (for the server to reply { ok:false }).
 */
export function parseIpcRequest(
  raw: unknown
): { ok: true; req: IpcRequest } | { ok: false; error: string } {
  const result = IpcRequestSchema.safeParse(raw);
  if (result.success) return { ok: true, req: result.data };
  const first = result.error.issues[0];
  const where = first?.path.join('.') || '(root)';
  return { ok: false, error: `malformed action: ${where} ${first?.message ?? ''}`.trim() };
}

export type IpcAction =
  | { kind: 'send-message'; channelId?: string; text: string }
  | { kind: 'reply'; messageId: string; channelId?: string; text: string }
  | { kind: 'edit-message'; messageId: string; channelId?: string; text: string }
  | { kind: 'send-file'; path: string; name?: string; caption?: string; channelId?: string }
  | { kind: 'react'; messageId: string; emoji: string; channelId?: string }
  | { kind: 'delete'; messageId: string; channelId?: string }
  | { kind: 'fetch-messages'; channelId?: string; limit?: number; before?: string; fields?: string[] }
  | { kind: 'create-thread'; messageId: string; name: string; channelId?: string }
  | { kind: 'ask'; prompt: string; options: string[]; channelId?: string; timeoutMs?: number }
  | { kind: 'voice-log'; limit?: number }
  | { kind: 'list-channels'; platform?: string; query?: string; limit?: number }
  | {
      kind: 'schedule-add';
      channelId?: string;
      name?: string;
      cron?: string;
      at?: string;
      tz?: string;
      prompt?: string;
      bash?: string;
      agent?: string;
      session?: 'fixed' | 'new' | 'daily';
      cwd?: string;
      timeoutMs?: number;
    }
  | { kind: 'schedule-list'; id?: string }
  | { kind: 'reload-config' }
  | { kind: 'pod-list' }
  | { kind: 'pod-add'; name: string; ssh: string; hostKey: string }
  | { kind: 'pod-remove'; name: string }
  | {
      kind: 'skills';
      action:
        | 'list'
        | 'show'
        | 'create'
        | 'patch'
        | 'write-file'
        | 'remove-file'
        | 'archive'
        | 'restore'
        | 'pin'
        | 'unpin'
        | 'history'
        | 'revert';
      name?: string;
      file?: string;
      version?: string;
      content?: string;
      description?: string;
      body?: string;
      id?: string;
    }
  | { kind: 'schedule-op'; id: string; op: 'remove' | 'pause' | 'resume' | 'run' }
  | { kind: 'task-agents' }
  | { kind: 'task-list'; limit?: number }
  | { kind: 'task-new'; agent: string; text: string; cwd?: string; title?: string }
  | { kind: 'task-send'; topic: string; text: string; interrupt?: boolean }
  | { kind: 'task-read'; topic: string; limit?: number; full?: boolean; tail?: number }
  | { kind: 'task-status'; topic: string }
  | { kind: 'task-stop'; topic: string }
  | { kind: 'sessions-search'; query: string; agent?: string; days?: number; limit?: number }
  | {
      kind: 'sessions-read';
      session: string;
      around?: number;
      window?: number;
      role?: 'user' | 'agent' | 'tool';
      turn?: string;
      turns?: number;
      since?: number;
      grep?: string;
      tail?: number;
    }
  | { kind: 'sessions-list'; days?: number; limit?: number };

// Compile-time alignment: the zod-inferred type must equal the hand-written union;
// if either side drifts, this type errors.
type _AssertActionAligned = [
  IpcAction extends z.infer<typeof IpcActionSchema> ? true : never,
  z.infer<typeof IpcActionSchema> extends IpcAction ? true : never,
];
const _assertActionAligned: _AssertActionAligned = [true, true];

export interface IpcRequest {
  /** From TALKCODE_TURN_TOKEN; used to authenticate and locate the current session/channel. */
  token: string;
  action: IpcAction;
}

export type IpcResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

/** Response body for fetch-messages. */
export interface FetchMessagesResult {
  messages: InboundMessage[];
}

/** Response body for create-thread (the data field). */
export interface CreateThreadResult {
  threadId: string;
}

/** Response body for ask (blocking clarify): chosen = selected label; null = timeout/unselected. */
export interface AskResult {
  chosen: string | null;
}

/**
 * Response body for voice-log: the calling conversation's recent voice transcripts, newest last.
 * Shaped like core/voice.ts VoiceHistoryItem, restated here because ipc/ imports nothing but types.ts.
 */
export interface VoiceLogResult {
  /** False when voice transcription is not configured on this daemon at all. */
  enabled: boolean;
  entries: Array<{
    id: string;
    at: string;
    status: string;
    /** The words as heard. */
    text: string;
    /** The cleaned-up message, when there was one. */
    cleaned?: string;
    model: string;
    latencyMs?: number;
    messageId: string;
    audio: string;
    reason?: string;
  }>;
}

/**
 * Response body for list-channels. Shaped like core/channel-list.ts ChannelRow, restated here because
 * ipc/ imports nothing but types.ts (the same arrangement VoiceLogResult has).
 */
export interface ListChannelsResult {
  channels: Array<{
    id: string;
    kind: 'channel' | 'topic';
    platform: string;
    title: string;
    agent: string;
    lastAt: string;
    current: boolean;
  }>;
  /** Topic rows that matched before `limit` cut them. */
  totalTopics: number;
  limit: number;
}

/**
 * One scheduled task as the CLI prints it (core/schedule.ts taskView). Flat, so a list renders as
 * one TOON table; the detail fields appear only on `schedule show` and `schedule add`.
 */
export interface ScheduleTaskView {
  id: string;
  name: string;
  state: string;
  when: string;
  next: string;
  runs: string;
  target: string;
  last: string;
  count: number;
  expires: string;
  here: boolean;
  prompt?: string;
  command?: string;
  timeout?: string;
  cwd?: string;
}

/** Response body for schedule-list. */
export interface ScheduleListResult {
  tasks: ScheduleTaskView[];
}

/**
 * One sub-agent's topic as the agent that opened it sees it (`tasks`, and the updates it is sent).
 * Flat, so a list renders as one TOON table.
 */
export interface TaskRow {
  /** What every other task command takes as `topic`: the conversation's `--channel` id. */
  topic: string;
  title: string;
  agent: string;
  /** The directory it works in, short (`~/workspace/talkcode`); empty when unknown. */
  cwd: string;
  /** TopicStage: answer | failed | review | retrying | working | idle. */
  stage: string;
  /**
   * The line beside it: the question, the failure, the reply's first line — or, while it works,
   * the tool it is running now (`Bash: sed -n …`). The live half is why this is not empty during a
   * long turn, which is exactly when the agent that opened the topic needs to know what it is doing.
   */
  line: string;
  /** Tool calls in the turn now running; 0 when it is not working. */
  step: number;
  /** How long the running turn has been going (`4m 12s`); empty when it is not working. */
  elapsed: string;
  /** Context used, as the footer prints it (`18k / 1M (2%)`); empty when the harness reports none. */
  context: string;
  /** Cumulative session cost (`$0.42`); empty when the harness reports none. */
  cost: string;
  /** When it last did anything, ISO. */
  lastAt: string;
  /** A link that opens it on the platform it is on, where there is one (the web UI's `?t=<topic>`). */
  link?: string;
}

/** Response body for task-list. */
export interface TaskListResult {
  tasks: TaskRow[];
  /** How many conversations there were before `limit`. */
  total: number;
}

/** One agent a sub-task can be handed to (task-agents). */
export interface TaskAgentRow {
  id: string;
  harness: string;
  /** The machine it runs on: its `host`, or `gateway` for the gateway's own. */
  where: string;
  /**
   * Whether it runs on the same machine as the agent asking. Listed first, and the ones to prefer:
   * the same checkouts, the same tools, and no second copy of a repository to keep in step.
   */
  here: boolean;
  model: string;
  /** Its configured working directory. */
  root: string;
  /** Projects one level inside it, most used first (what `/cd` offers). */
  dirs: string[];
}

/** Response body for task-agents. */
export interface TaskAgentsResult {
  agents: TaskAgentRow[];
}

/** Response body for task-read: one conversation's recent messages, oldest first. */
export interface TaskReadResult {
  topic: string;
  messages: Array<{ from: 'person' | 'agent'; at: string; text: string }>;
  /** What was left out, when a budget cut it (`full` or `--tail`): said so nobody reads it as whole. */
  note?: string;
}

/** Response body for task-status: one sub-agent topic, in detail. */
export interface TaskStatusResult {
  task: TaskRow;
  /** The last few tool calls of the running turn (or the last one), oldest first. */
  recent: Array<{ at: string; tool: string; detail: string }>;
  /** The head of its last finished reply, when that is the last thing it did; empty otherwise. */
  reply: string;
}

/** Response body for task-new: which line of the confirmation card it is, and what happens next. */
export interface TaskNewResult {
  item: number;
  result: string;
}

/** Response body for task-send and task-stop: what happened, in a sentence for the agent that asked. */
export interface TaskActionResult {
  topic: string;
  result: string;
}

/**
 * One conversation as the library lists it. Flat, so a list renders as one TOON table.
 * Shaped like history/store.ts HistorySessionRow, restated here because ipc/ imports nothing but
 * types.ts (the same arrangement ListChannelsResult has).
 */
export interface SessionRow {
  /** What `sessions read` takes: the id, printed as `#<id>`. */
  id: number;
  key: string;
  platform: string;
  title: string;
  agent: string;
  /** The machine the agent runs on; empty for the gateway's own. */
  host: string;
  cwd: string;
  kind: string;
  startedAt: string;
  lastAt: string;
  messages: number;
}

/** Response body for sessions-search: one row per hit, best first. */
export interface SessionSearchResult {
  hits: Array<{
    /** The conversation to read: `sessions read <session>`. */
    session: number;
    /** The message to read around: `sessions read <session> --around <message>`. */
    message: number;
    at: string;
    title: string;
    agent: string;
    platform: string;
    /** The turn kind: normal | schedule | subagent | background. */
    kind: string;
    role: string;
    excerpt: string;
  }>;
}

/** Response body for sessions-list. */
export interface SessionListResult {
  sessions: SessionRow[];
  /** The window that was applied, so the CLI can say what it left out. */
  days: number;
}

/** Response body for sessions-read. */
export interface SessionReadResult {
  session: SessionRow;
  /**
   * The rows read. `turn`/`outcome`/`agent` are present only on a filtered read: the unfiltered
   * `sessions read <id>` prints exactly what it always has.
   */
  messages: Array<{
    id: number;
    at: string;
    role: string;
    kind: string;
    text: string;
    turn?: number | null;
    outcome?: string | null;
    agent?: string;
  }>;
  note?: string;
}
