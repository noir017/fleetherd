import os from 'node:os';
import path from 'node:path';
import { encode } from '@toon-format/toon';
import { loadConfig, resolveSocketPath } from '../config/load.js';
import { callDaemon, clientTimeoutFor } from '../ipc/client.js';
import { DEFAULT_FETCH_FIELDS } from '../ipc/commands.js';
import type {
  IpcAction,
  ListChannelsResult,
  ScheduleListResult,
  ScheduleTaskView,
  SessionListResult,
  SessionReadResult,
  SessionSearchResult,
  TaskActionResult,
  TaskAgentsResult,
  TaskListResult,
  TaskNewResult,
  TaskReadResult,
  TaskStatusResult,
  VoiceLogResult,
} from '../ipc/protocol.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../ipc/protocol.js';
import type { InboundMessage } from '../types.js';

/**
 * Per-row content truncation for fetch-messages (AXI §3): keeps a history dump token-bounded.
 * 500 chars covers most chat turns while leaving a clear `…` + help marker when clipped.
 */
const CONTENT_LIMIT = 500;

/** Encode a plain JS value to TOON — the format of everything a reverse command prints. */
function toon(value: unknown): string {
  return encode(value);
}

/**
 * What a reverse command answers with: `stdout` is what the agent reads, `stderr` a note that must
 * not corrupt it (see `ask`). Returned rather than printed so the same answer reaches an agent that
 * ran the command in a shell and one that called it as a native tool (commands/mcp.ts).
 */
export interface ReverseOutput {
  stdout: string;
  stderr?: string;
}

/**
 * Normalize a user/agent-supplied path to absolute: expand a leading `~`, then
 * path.resolve against `base` — the agent's working directory. For a shell command that is this
 * process's CWD (the agent spawned it); for a tool call it is the session's directory, handed to the
 * MCP server by the daemon, because a harness starts its MCP servers wherever it likes. The daemon's
 * CWD may differ from both, and the path is later turned into a file:// URL — a relative path or `~`
 * would become a malformed/wrong address like `file://./x.png` on the daemon side, so we must
 * resolve to absolute here.
 */
function resolvePathArg(p: string, base: string): string {
  // An agent on a remote host runs this CLI through the gateway (daemon/remote-hosts.ts), so `~` is
  // that host's home, which the bridge passes in; locally it is ours.
  const home = process.env.TALKCODE_REMOTE_HOME || os.homedir();
  let expanded = p;
  if (p === '~') expanded = home;
  else if (p.startsWith('~/')) expanded = path.posix.join(home, p.slice(2));
  return path.resolve(base, expanded);
}

/**
 * Normalize the relative/`~` path in a send-file action to absolute (see resolvePathArg).
 * Other actions are returned unchanged.
 */
export function normalizeActionPaths(action: IpcAction, base = process.cwd()): IpcAction {
  if (action.kind === 'send-file') {
    return { ...action, path: resolvePathArg(action.path, base) };
  }
  // Same reason: a schedule's --cwd is read by the daemon, whose own CWD is not the agent's.
  if (action.kind === 'schedule-add' && action.cwd !== undefined) {
    return { ...action, cwd: resolvePathArg(action.cwd, base) };
  }
  return action;
}

/**
 * Unified execution for reverse commands: connect back to the daemon. Reused by the
 * cli.ts subcommands. Reached when the agent runs `talkcode send-file ./out.png` in a shell.
 *
 * This function is the AXI output boundary: the daemon speaks plain JSON over IPC, and we
 * convert it to token-efficient TOON on stdout here (errors included, so the agent can read them).
 */
export async function runReverse(rawAction: IpcAction): Promise<void> {
  const socket = resolveSocketPath(loadConfig());

  // Resolve send-file paths to absolute here (CWD == agent CWD) to avoid the daemon building
  // file://./x.png (malformed) or a path relative to the daemon CWD (wrong). For an agent on a
  // remote host this process runs on the gateway, not in the agent's directory; the bridge passes
  // that directory as TALKCODE_CWD (daemon/remote-hosts.ts).
  const action = normalizeActionPaths(rawAction, process.env.TALKCODE_REMOTE_HOME ? process.env.TALKCODE_CWD : undefined);

  // A blocking command needs a longer wait than the client's default: `ask` until the person
  // answers, `schedule add` until a model list is read. See clientTimeoutFor.
  const resp = await callDaemon(socket, action, undefined, clientTimeoutFor(action));
  if (!resp.ok) {
    // AXI §6: errors go to stdout in the same structured format as data, with an actionable hint.
    console.log(toon(friendlyError(resp.error, socket)));
    process.exitCode = 1;
    return;
  }

  const out = renderResult(action, resp.data);
  console.log(out.stdout);
  if (out.stderr) console.error(out.stderr);
}

/**
 * Render a successful response as TOON, shaped per command (AXI §1/§2/§9).
 * `ask` is the one exception: its result is the user's chosen label, printed verbatim so
 * the agent can branch on it directly (an empty line means timeout/no-selection).
 */
export function renderResult(action: IpcAction, data: unknown): ReverseOutput {
  // Commands whose answer depends only on the data, not on the options that asked for it.
  const tabular = DATA_PRINTERS[action.kind];
  if (tabular) return { stdout: tabular(data, action) };
  switch (action.kind) {
    case 'skills':
      return { stdout: renderSkills(action, data) };
    case 'ask': {
      const chosen = (data as { chosen?: string | null } | undefined)?.chosen ?? null;
      // An empty stdout line is a legitimate answer shape, which makes it a poor way to learn that
      // nobody answered at all — the agent sees the same blank either way and reasonably concludes
      // the command is broken. Say so on stderr, where it cannot corrupt the label on stdout.
      if (chosen !== null) return { stdout: chosen };
      const waited = Math.round((action.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS) / 1000);
      return {
        stdout: '',
        stderr:
          `ask: no option was chosen within ${waited}s (the buttons have been withdrawn). ` +
          `The question was delivered — nobody clicked. Ask again in plain text, or retry with ` +
          `--timeout <ms> for longer.`,
      };
    }
    case 'fetch-messages':
      return { stdout: renderFetchMessages(action, data) };
    case 'create-thread': {
      const threadId = (data as { threadId?: string } | undefined)?.threadId;
      // Contextual disclosure (AXI §9): the next step is almost always sending into the thread.
      return {
        stdout: toon({
          threadId: threadId ?? '',
          help: `Send into this thread by passing --channel ${threadId ?? '<threadId>'}.`,
        }),
      };
    }
    case 'send-message':
    case 'reply':
    case 'send-file': {
      // These return a MessageRef; surface messageId so the agent can react/reply/edit/delete it later.
      const messageId = (data as { messageId?: string } | undefined)?.messageId;
      return { stdout: toon(messageId ? { ok: true, messageId } : { ok: true }) };
    }
    default:
      // edit-message / react / delete return nothing actionable — a definitive ack is enough.
      return { stdout: toon({ ok: true }) };
  }
}

/**
 * Shape fetch-messages into a compact TOON table (AXI §1/§2/§3/§4/§5/§9):
 *  - minimal default schema (messageId,userId,content), widenable via --fields;
 *  - per-row content truncation with a count of how many were clipped;
 *  - attachment URLs rendered as a separate `attachments` table (a nested array would break the
 *    main tabular block) when requested, plus a hint when attachments exist but weren't requested;
 *  - a definitive empty state;
 *  - a `count` aggregate plus paging/widening hints when relevant.
 */
function renderFetchMessages(
  action: Extract<IpcAction, { kind: 'fetch-messages' }>,
  data: unknown
): string {
  const messages = (data as { messages?: InboundMessage[] } | undefined)?.messages ?? [];

  // AXI §5: state the zero explicitly so the agent doesn't re-run with different flags to verify.
  if (messages.length === 0) {
    return toon({ count: 0, note: 'no messages found in this channel' });
  }

  const requested = action.fields?.length ? action.fields : [...DEFAULT_FETCH_FIELDS];
  const wantAttachments = requested.includes('attachments');
  // `attachments` is rendered as its own table below, so it's not a main-table column; keep at
  // least messageId there as the key that links a row to its attachments.
  let columns = requested.filter((f) => f !== 'attachments');
  if (columns.length === 0) columns = ['messageId'];

  let truncated = 0;
  const rows = messages.map((m) => {
    const row: Record<string, unknown> = {};
    for (const f of columns) {
      if (f === 'content') {
        const c = m.content ?? '';
        if (c.length > CONTENT_LIMIT) {
          truncated++;
          row.content = `${c.slice(0, CONTENT_LIMIT)}…`;
        } else {
          row.content = c;
        }
      } else {
        const v = (m as unknown as Record<string, unknown>)[f];
        row[f] = v ?? '';
      }
    }
    return row;
  });

  const out: Record<string, unknown> = { count: rows.length, messages: rows };

  // Attachment URLs as a separate table, keyed by messageId (AXI §4: spare the agent a follow-up call).
  if (wantAttachments) {
    const atts = messages.flatMap((m) =>
      (m.attachments ?? []).map((a) => ({
        messageId: m.messageId,
        type: a.type,
        url: a.url,
        name: a.name ?? '',
      }))
    );
    out.attachments = atts.length ? atts : 'none'; // AXI §5: definitive empty state
  }

  const help: string[] = [];
  if (action.limit && rows.length >= action.limit) {
    help.push(
      `Showing the latest ${action.limit}; page further back with --before <the oldest messageId above>.`
    );
  }
  if (truncated > 0) {
    help.push(`${truncated} message(s) had content truncated to ${CONTENT_LIMIT} chars.`);
  }
  if (!wantAttachments) {
    const withAtt = messages.filter((m) => (m.attachments?.length ?? 0) > 0).length;
    if (withAtt > 0) {
      help.push(`${withAtt} message(s) have attachments; add --fields attachments to get their URLs.`);
    }
  }
  if (help.length) out.help = help;
  return toon(out);
}

/**
 * Shape voice-log into a TOON table (AXI §1/§5/§9): one row per transcript, oldest first, with
 * the text in full — the reason to run this is to read exactly what was heard, so clipping it
 * would defeat the command. A definitive empty state, and a different one when the feature is
 * off, so the agent does not go looking for transcripts that were never made.
 */
function renderVoiceLog(data: unknown): string {
  const result = (data as VoiceLogResult | undefined) ?? { enabled: false, entries: [] };
  if (!result.enabled) {
    return toon({ count: 0, note: 'voice transcription is not configured on this gateway (no voice: block in config.yaml)' });
  }
  if (result.entries.length === 0) {
    return toon({ count: 0, note: 'no voice messages have been transcribed in this conversation' });
  }
  const rows = result.entries.map((e) => ({
    at: e.at,
    status: e.status,
    text: e.text,
    cleaned: e.cleaned ?? '',
    model: e.model,
    latencyMs: e.latencyMs ?? '',
    messageId: e.messageId,
    audio: e.audio,
    reason: e.reason ?? '',
  }));
  return toon({
    count: rows.length,
    transcripts: rows,
    help: [
      'text is the words as heard; cleaned is the same message with fillers and self-corrections removed, when there was one.',
      'status: sent/auto = cleaned (or text, when cleaned is empty) reached you as the user message; sent-as-spoken = text did; cancelled/superseded/expired/called-off = nothing did; failed/no-speech = there was no transcript.',
      'audio is the saved recording; you can re-listen or re-transcribe it if a transcript looks misheard.',
    ],
  });
}

/**
 * Shape list-channels into a TOON table (AXI §1/§5/§9): channel roots, then recent topics, each with
 * the id `--channel` takes. The help lines say what an id is for and when the list was cut, because
 * the next step is always "use one of these", and a cut list that looks complete sends an agent
 * looking for a topic it was never shown.
 */
function renderChannels(data: unknown): string {
  const result = (data as ListChannelsResult | undefined) ?? { channels: [], totalTopics: 0, limit: 0 };
  if (result.channels.length === 0) {
    return toon({ count: 0, note: 'no chats or topics match; the list only holds places this gateway has answered in' });
  }
  const shown = result.channels.filter((c) => c.kind === 'topic').length;
  const help = [
    'Pass an id to --channel on any command (send-message, send-file …) to post there.',
    'kind=channel is a chat root: where a new topic would be opened. current=true is this conversation.',
  ];
  if (result.totalTopics > shown) {
    help.push(`Showing the ${shown} most recent of ${result.totalTopics} topics; narrow with --query or raise --limit.`);
  }
  return toon({ count: result.channels.length, channels: result.channels, help });
}

/**
 * schedule-add / schedule-op: the one task, in full, and the next step. The id is the thing to
 * keep, and the card the gateway posted is what the user sees — said so, so the agent does not
 * restate every field in its reply.
 *
 * The next step is worded for both ways in (`schedule pause <id>` in a shell, `action: pause` with
 * `id` as a tool), since this exact text reaches both.
 */
function renderScheduleTask(data: unknown): string {
  const task = (data as { task?: ScheduleTaskView } | undefined)?.task;
  if (!task) return toon({ ok: true });
  return toon({
    task,
    help: [`A card with this task was posted in the conversation. Manage it by its id (${task.id}): pause, resume, run (now, once) or rm.`],
  });
}

/** schedule-list: every task as one table, or one task in full for `show`. */
function renderScheduleList(data: unknown): string {
  const tasks = (data as ScheduleListResult | undefined)?.tasks ?? [];
  if (tasks.length === 0) return toon({ count: 0, note: 'no scheduled tasks' });
  if (tasks.length === 1 && (tasks[0]!.prompt !== undefined || tasks[0]!.command !== undefined)) {
    return toon({ task: tasks[0] });
  }
  return toon({
    count: tasks.length,
    tasks,
    help: ['here=true: registered from, or running in, this conversation. show <id> prints one task with its prompt or command.'],
  });
}

/**
 * sessions search: one row per hit, with the ids that take the agent to the next step. A hit
 * without its conversation id would only be a tease — the excerpt is where to look, and the id
 * is how to read the rest.
 */
function renderSessionSearch(data: unknown): string {
  const hits = (data as SessionSearchResult | undefined)?.hits ?? [];
  if (hits.length === 0) {
    return toon({
      count: 0,
      note: 'nothing matches; the library only holds conversations that went through this gateway, from the upgrade onward',
    });
  }
  return toon({
    count: hits.length,
    hits: hits.map((h) => ({
      session: `#${h.session}`,
      message: `#${h.message}`,
      at: h.at,
      title: h.title || '(unnamed)',
      agent: h.agent,
      platform: h.platform,
      kind: h.kind,
      role: h.role,
      excerpt: h.excerpt,
    })),
    help: [
      'Read the whole conversation with `sessions read <session>`; read around a hit with `--around <message> --window 10`.',
      'kind=schedule rows are scheduled-task output and sort after ordinary conversations; kind=background is work reported after its turn.',
    ],
  });
}

type SessionsReadAction = Extract<IpcAction, { kind: 'sessions-read' }>;

/**
 * sessions read: the conversation header, then its messages oldest first.
 *
 * An unfiltered read prints exactly the fields it always has. A filtered one adds the turn each
 * row belongs to, that turn's outcome and the agent — and says "?" / "unknown" for a row written
 * before turns existed, rather than inventing a number.
 */
function renderSessionRead(action: SessionsReadAction, data: unknown): string {
  const result = data as SessionReadResult | undefined;
  if (!result) return toon({ ok: true });
  if (result.messages.length === 0) {
    // The store's note is the answer when it has one — `--turn done` right after `/new` is
    // empty because nothing has finished yet. Without one, say which kind of empty this is:
    // a conversation with no messages, or a filter that matched none of them.
    const filtered =
      action.role !== undefined ||
      action.turn !== undefined ||
      action.turns !== undefined ||
      action.since !== undefined ||
      action.grep !== undefined ||
      action.tail !== undefined;
    return toon({
      session: { ...result.session, id: `#${result.session.id}` },
      count: 0,
      note: result.note ?? (filtered ? 'no rows match this filter' : 'this conversation has no messages'),
    });
  }
  return toon({
    session: {
      id: `#${result.session.id}`,
      title: result.session.title || '(unnamed)',
      platform: result.session.platform,
      agent: result.session.agent,
      host: result.session.host,
      cwd: result.session.cwd,
      kind: result.session.kind,
      startedAt: result.session.startedAt,
      lastAt: result.session.lastAt,
    },
    count: result.messages.length,
    messages: result.messages.map((m) =>
      m.turn === undefined
        ? { ...m, id: `#${m.id}` }
        : {
            id: `#${m.id}`,
            at: m.at,
            role: m.role,
            turn: m.turn ?? '?',
            outcome: m.outcome ?? 'unknown',
            agent: m.agent ?? '',
            kind: m.kind,
            text: m.text,
          }
    ),
    ...(result.note ? { note: result.note } : {}),
  });
}

/** sessions list: recent conversations, newest first. */
function renderSessionList(data: unknown): string {
  const result = (data as SessionListResult | undefined) ?? { sessions: [], days: 7 };
  if (result.sessions.length === 0) {
    return toon({ count: 0, note: `no conversations in the last ${result.days} day(s)` });
  }
  return toon({
    count: result.sessions.length,
    days: result.days,
    sessions: result.sessions.map((s) => ({
      id: `#${s.id}`,
      at: s.lastAt,
      title: s.title || '(unnamed)',
      agent: s.agent,
      platform: s.platform,
      kind: s.kind,
      messages: s.messages,
    })),
    help: ['`sessions read <id>` opens one; `sessions search <words>` looks inside them.'],
  });
}

/**
 * Printers for the commands whose output is a function of the response alone. A table rather than
 * more switch arms: every gateway query added one, and the switch in renderResult is about the
 * commands whose rendering also depends on what was asked (ask's timeout, fetch's columns).
 */
/** `skills …`: a file read for `show`, TOON for every other action (a table or a record). */
function renderSkills(action: Extract<IpcAction, { kind: 'skills' }>, data: unknown): string {
  return action.action === 'show' ? renderSkillFile(data) : toon(data ?? {});
}

/** `skills show`: metadata a `patch` needs, then the file itself, verbatim. */
function renderSkillFile(data: unknown): string {
  const shown = data as
    | { name?: string; file?: string; version?: string; status?: string; content?: string }
    | undefined;
  if (!shown) return toon({ ok: true });
  return [
    `skill: ${shown.name ?? ''}`,
    `file: ${shown.file ?? 'SKILL.md'}`,
    `version: ${shown.version ?? ''}`,
    `status: ${shown.status ?? ''}`,
    '',
    shown.content ?? '',
  ].join('\n');
}

const DATA_PRINTERS: Partial<Record<IpcAction['kind'], (data: unknown, action: IpcAction) => string>> = {
  'voice-log': renderVoiceLog,
  'list-channels': renderChannels,
  'schedule-add': renderScheduleTask,
  'schedule-op': renderScheduleTask,
  'schedule-list': renderScheduleList,
  // Already a sentence written for a person (it is also the reply to /reload in chat).
  'reload-config': (data) => (data as { summary?: string } | undefined)?.summary ?? '',
  'pod-add': (data) => (data as { summary?: string } | undefined)?.summary ?? '',
  'pod-remove': (data) => (data as { summary?: string } | undefined)?.summary ?? '',
  'pod-list': (data) => toon(data ?? {}),
  'task-agents': renderTaskAgents,
  'task-list': renderTaskList,
  'task-new': renderTaskProposed,
  'task-read': renderTaskRead,
  'task-send': renderTaskAction,
  'task-status': renderTaskStatus,
  'task-stop': renderTaskAction,
  'sessions-search': renderSessionSearch,
  // Needs the action, not just the data: an empty answer says "no messages" for a whole
  // conversation and "no rows match" for a filtered read, and only the request knows which.
  'sessions-read': (data, action) => renderSessionRead(action as SessionsReadAction, data),
  'sessions-list': renderSessionList,
};

/** task-agents: one row per agent; the directories joined, since a nested list breaks the table. */
function renderTaskAgents(data: unknown): string {
  const agents = (data as TaskAgentsResult | undefined)?.agents ?? [];
  if (agents.length === 0) return toon({ count: 0, note: 'no agents are configured' });
  return toon({
    agents: agents.map((a) => ({ ...a, dirs: a.dirs.join(', ') })),
    help: [
      'task-new --agent <id> [--cwd <dir>] "<the task>" proposes a sub-task for one of these; --cwd is the root or one of its dirs.',
      'here=true: on the same machine as you — prefer these. Another machine has its own checkouts and tools; use one only when the work needs that machine.',
    ],
  });
}

/** task-list: the table, and the one thing worth knowing about the stages. */
function renderTaskList(data: unknown): string {
  const result = (data as TaskListResult | undefined) ?? { tasks: [], total: 0 };
  if (result.tasks.length === 0) return toon({ count: 0, note: 'this conversation has opened no sub-agent topics' });
  const help = [
    'review: finished. answer: waiting on a question (the person answers it in that topic). failed, retrying, working, idle.',
    'While a sub-agent works, line is the tool it is running now, step counts this turn\'s tool calls, elapsed is this turn, and context/cost are what its harness last reported (empty when it reports none).',
  ];
  if (result.total > result.tasks.length) help.push(`Showing the ${result.tasks.length} most recent of ${result.total}; raise --limit for more.`);
  return toon({ tasks: result.tasks, help });
}

/** task-new: where it went, and what happens next. */
function renderTaskProposed(data: unknown): string {
  const result = data as TaskNewResult | undefined;
  return toon(result ? { item: result.item, result: result.result } : { ok: true });
}

/** task-read: the messages, as a table. */
function renderTaskRead(data: unknown): string {
  const result = data as TaskReadResult | undefined;
  if (!result || result.messages.length === 0) return toon({ count: 0, note: 'nothing has been said there yet' });
  return toon({ topic: result.topic, messages: result.messages, ...(result.note ? { note: result.note } : {}) });
}

/** task-status: one topic's live row, its last few tool calls, and the head of its last reply. */
function renderTaskStatus(data: unknown): string {
  const result = data as TaskStatusResult | undefined;
  if (!result) return toon({ ok: true });
  return toon({
    ...result.task,
    recent: result.recent,
    ...(result.reply ? { reply: result.reply } : {}),
  });
}

/** task-send / task-stop: what happened. */
function renderTaskAction(data: unknown): string {
  const result = data as TaskActionResult | undefined;
  return toon(result ? { topic: result.topic, result: result.result } : { ok: true });
}

/**
 * Wrap low-level socket errnos like "can't connect to daemon" into an actionable structured
 * error (AXI §6). callDaemon (client.ts) returns only e.message for socket errors (e.g. "connect
 * ENOENT <path>"), dropping the code; so we detect the errno substring in the message — ENOENT
 * (socket missing) / ECONNREFUSED (nobody listening) — and tell the agent how to recover. Other
 * errors pass through as the bare message.
 */
export function friendlyError(error: string, socket: string): { error: string; help?: string } {
  if (error.includes('ENOENT') || error.includes('ECONNREFUSED')) {
    return {
      error: `cannot reach the daemon (socket: ${socket}): ${error}`,
      help: 'Make sure `talkcode start` is running, then retry.',
    };
  }
  return { error };
}
