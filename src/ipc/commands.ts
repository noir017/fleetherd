import type { IpcAction } from './protocol.js';
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_CHANNEL_LIMIT } from './protocol.js';

/**
 * Reverse-command catalog: single source of truth.
 *
 * One spec drives every place a command surfaces, avoiding scattered lists and silent drift:
 *  - `cli.ts`: registers commander subcommands from it.
 *  - `talkcode help <topic>`: renders each spec onto the page its `topic` names.
 *  - `tools.ts`: the few commands an agent gets as native tools take their parameters and their
 *    validation (`build`) from here.
 *  - Execution dispatch stays in `daemon.ts` handleReverse (with exhaustive type guard).
 *
 * Adding a reverse action = one arm in the IpcAction union + one entry here; cli
 * registration and the help page follow automatically, and missing handleReverse fails to compile.
 */

export interface ReverseOption {
  /** Commander option flags, e.g. '-n, --name <name>'. */
  flags: string;
  description?: string;
  /** Value parser (e.g. parse --limit to number). */
  parse?: (value: string) => unknown;
}

export interface ReverseCommandSpec {
  /** Commander command signature, e.g. 'send-file <path>'. */
  usage: string;
  description: string;
  /** Options specific to this command (the shared --channel is added via CHANNEL_OPTION). */
  options: ReverseOption[];
  /** Build one IpcAction from positionals + options. */
  build(positionals: string[], opts: Record<string, unknown>): IpcAction;
  /**
   * Which `talkcode help <topic>` page documents this command. Required, so a new command
   * cannot be added without deciding where an agent will find it — the help pages, reached from the
   * bundled skill, are how every command that is not a native tool gets discovered (see HELP_TOPICS).
   */
  topic: HelpTopicName;
}

/**
 * The pages of `talkcode help`: the reference an agent loads when it needs one.
 *
 * ── Nothing about the gateway is put in the agent's prompt ────────────────────────────────────
 * The gateway aims to be invisible to the agent: no text of its own in the conversation, ever. What
 * an agent can do here reaches it through its harness's own mechanisms instead — the two commands it
 * could not do without are native tools (`tools.ts`), and the rest are behind a skill whose one-line
 * description is all that sits in context (`skill/SKILL.md`, linked into each harness's skill
 * directory by `daemon/skill-link.ts`). The skill's body sends the agent here, so these pages stay
 * the one place a command's usage and rules are written down — rendered from the specs, so they
 * cannot drift from what the CLI accepts.
 *
 * This replaced a `<system-reminder>` prepended to the first turn of every session (2026-10-09). It
 * had already been cut from thirteen lines to three, but three lines opening with "your replies
 * reach the user automatically" still told the model what kind of job this was before it read the
 * job — and no wording of an injected block avoids that, because the injection is the framing.
 */
export type HelpTopicName =
  | 'files'
  | 'schedule'
  | 'channels'
  | 'history'
  | 'sessions'
  | 'messages'
  | 'threads'
  | 'ask'
  | 'voice'
  | 'config'
  | 'pods'
  | 'tasks';

export interface HelpTopic {
  name: HelpTopicName;
  /** One line on the index page. */
  summary: string;
  /** What to know beyond each command's usage line: the rules, the traps, the defaults. */
  notes: string[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    name: 'files',
    summary: 'Send a file or image into the chat',
    notes: [
      'Relative paths and ~ resolve against your working directory. --name overrides the displayed filename.',
      'Where you have a send_file tool, it is this same command.',
    ],
  },
  {
    name: 'schedule',
    summary: 'Scheduled and recurring tasks that survive restarts — an agent prompt or a bash command, output to any chat',
    notes: [
      'Use this rather than a scheduling tool built into your own harness: those live inside your process, which the gateway stops after an idle hour and on every restart. Tasks here are kept on disk by the gateway and run from it.',
      'When the time, the time zone, or where the output should go is not clear from what the user said, ask before adding. The gateway posts a card with the task\'s details when it is registered, changed or deleted; the user can list, pause and delete tasks with /setting schedule.',
      '--prompt with --session fixed (the default): each run is a turn in THIS conversation (or the one --channel names), with the agent answering it — context accumulates and the user can follow up in place. A fixed-session task lives 24h from registration, then expires; anything longer needs --session new.',
      '--prompt with --session new: every run is a fresh session, in a new topic where the platform can open one (web UI, Telegram forum groups, Discord), otherwise posted straight into the chat. --agent picks who answers; --cwd where it starts.',
      '--bash: the gateway runs the command with `bash -lc` in --cwd (default: your working directory) and posts the exit code, duration and the end of the output; long output is attached as a file. --timeout defaults to 10m, at most 6h.',
      '--at takes +30m / +2h / 08:00 (the next time the clock reads that) / "2026-10-01 08:00" / an ISO time with a zone. --cron takes 5 fields (minute hour day month weekday). Both are read in --tz, default the gateway\'s own zone.',
      '--channel is where output goes (ids from `talkcode channels`); default this conversation.',
      'A run missed while the gateway was down is made once if it is less than an hour late, otherwise recorded as missed. A run that comes due while the previous one is still going is skipped.',
      '`add` and `show` print the task id; `list` shows every task with its next run and last result; pause / resume / run (run it now, once) / rm take the id.',
      'Where you have a schedule tool, it is this same command.',
    ],
  },
  {
    name: 'channels',
    summary: 'Post to another chat or topic, on any platform',
    notes: [
      'Every command takes --channel <id>. A bare <channel>[/<thread>] stays on the platform you are answering on; <instance>:<channel>[/<thread>] (what `channels` prints) names any platform.',
      'The list only holds places the gateway has answered in — most platforms cannot enumerate a bot\'s chats. kind=channel rows are chat roots (where a new topic would be opened); current=true is this conversation.',
    ],
  },
  {
    name: 'history',
    summary: 'Read earlier messages in the chat',
    notes: [
      'Use it when the user refers to something outside your context ("the file I sent above"). Content is cut at 500 characters per message; `--fields attachments` adds the attachment URLs.',
      'Page further back with --before <the oldest messageId you have>. count: 0 means the channel really is empty.',
    ],
  },
  {
    name: 'sessions',
    summary: 'Search every earlier conversation the gateway has carried — all agents, all platforms',
    notes: [
      'This is the gateway\'s own library, not the chat you are in: it holds every prompt, reply and tool call that went through talkcode, including topics you cannot see from here. Terminal sessions started directly in a harness are not in it.',
      'search <words> returns the conversation id, the message id, the title, the agent and a matching excerpt. Two-character Chinese words work; a single character falls back to a substring match. Scheduled-task output sorts after ordinary conversations.',
      'read <session> prints the whole conversation (up to 500 messages); read <session> --around <message> --window <n> shows n messages on each side of a hit. list [--days <n>] is the recent conversations.',
      'Pass the ids exactly as printed: session and message are numbers, with or without the leading #.',
    ],
  },
  {
    name: 'messages',
    summary: 'Extra messages, quote-replies, edits, reactions and deletes',
    notes: [
      'A normal reply already appears in the conversation, so re-sending it with send-message shows it twice. These are for something in addition to it: a completion notice from a background job, a status message you keep editing.',
      'send-message, reply and send-file print the messageId; keep it if you will edit, react to or delete that message.',
    ],
  },
  {
    name: 'threads',
    summary: 'Open a thread from a message',
    notes: ['Prints the thread id; pass it as --channel to post inside the thread.'],
  },
  {
    name: 'ask',
    summary: 'A blocking button question — only if you have no question tool of your own',
    notes: [
      'If your harness has a question tool (Claude Code\'s AskUserQuestion), use that: the gateway renders it as the same buttons.',
      'stdout is the chosen label, or the user\'s typed answer. Empty stdout plus a stderr note means nobody answered in time — the question WAS delivered; follow up in plain text.',
    ],
  },
  {
    name: 'config',
    summary: 'Apply an edited config.yaml without restarting the gateway',
    notes: [
      'The config is `config.yaml` in the gateway\'s config directory (`~/.config/talkcode/` unless TALKCODE_CONFIG_FILE or TALKCODE_CONFIG_DIR says otherwise), with secrets in `.env` beside it. Edit the file, then run reload — the user can do the same with /reload.',
      'Nothing is applied when the file does not load: the error says what is wrong and the gateway keeps running on the old config. Fix it and reload again.',
      'Agents, routing, access, session, display, title and voice apply at once. A changed agent restarts its process on the conversation\'s next message and resumes its session — including the agent you are, if you change your own definition. A turn already running finishes on the old definition. A new `model` only applies to new sessions (/new).',
      'platforms (credentials, instances) only change on a daemon restart, which ends every conversation\'s agent process, yours included; reload says when one is needed. Restarting is the user\'s call, not yours.',
    ],
  },
  {
    name: 'pods',
    summary: 'The machines agents run on: add one, remove one, declare its agents, ssh between them',
    notes: [
      'A pod is a machine the gateway reaches over ssh to run agents (the `hosts:` of its config). `pods` lists them with their agents, and prints `gatewayKey` — the line a new machine needs in its ~/.ssh/authorized_keys.',
      'Adding one: on the machine, append `gatewayKey` to ~/.ssh/authorized_keys and read its host key there (`cat /etc/ssh/ssh_host_ed25519_key.pub`, or wherever its sshd keeps it) — read it on the machine, not with ssh-keyscan, since this is what every connection will be checked against. Then `pod-add <name> <user@address[:port]> --host-key "<that line>"`. It answers with the agents found there.',
      'Its agents: ~/.talkcode/pod.yaml on the machine lists them (`agents:`, the fields of a config.yaml agent without `host`); the gateway names them `<id>@<name>`. Without the file it offers each harness command it finds on the login PATH (claude-agent-acp, codex-acp, opencode, agy, codebuddy). After editing the file, `reload`. Values are used as written: ${VAR} is refused.',
      'Pod-to-pod ssh: `peer:` in a machine\'s pod.yaml puts it in the mesh — after a `reload`, every pod with `peer:` can `ssh <name>.pod` (and scp, rsync, git) to every other. `peer: { ssh: user@address:port }` when the others reach it differently from the gateway. Needs the machine\'s sshd to read ~/.talkcode/ssh/authorized_keys and its ssh to include ~/.talkcode/ssh/config (uniagent images do).',
      '`pod-remove <name>` takes a machine out (its agents go with it). Refused while config.yaml itself still names it.',
    ],
  },
  {
    name: 'tasks',
    summary: 'Hand parts of a job to other agents (sub-agents), in parallel, and follow them',
    notes: [
      'Web UI only: each sub-agent gets a topic of its own, nested under this one, where the person can also talk to it directly.',
      'task-new proposes ONE sub-task; call it once per sub-task. Everything proposed before the person answers goes on one card, however far apart the calls are. Nothing starts until the person confirms the card. Then they all start at once and run in parallel. If the person writes instead, they want changes: propose again, and the new card replaces the old one.',
      'A sub-agent sees nothing of this conversation: <text> is all it gets. Make it whole — the goal, the constraints, how to tell it is done — and leave the how to the agent.',
      'The first row of task-agents is the agent answering this conversation; the next ones with here=true are on the same machine. Those are the ones to prefer — they have the same checkouts and tools. Agents on other machines work in their own checkouts.',
      'When a sub-agent finishes, fails or asks something, you are told here in a message beginning `[sub-agent updates]`, which says how many are still working. Its questions are the person\'s to answer in its topic unless they are only about what your task meant.',
      'A topic is the id `tasks` and the updates print. task-send, task-read, task-status and task-stop act only on topics this conversation opened.',
      '`tasks` shows what a working sub-agent is doing now: the tool it is running, its step count, how long the turn has gone and its context. `task-status` is one topic in detail, with its last three tool calls. A long tool list is cut at 1500 characters per message by default; `task-read --tail 20` shows the newest lines, `--full` the whole list.',
      'task-send only reaches a turn that is still running when the harness accepts input mid-turn (claude and codex do; agy does not). The answer says which happened: joined, queued behind the turn, or started. To redirect a harness that is not listening, `--interrupt` stops the turn and sends the message as the next one — its context is kept.',
    ],
  },
  {
    name: 'voice',
    summary: 'What a voice message actually said',
    notes: [
      'Some user messages were spoken: the user saw the transcript (often tidied up from the words as heard) and approved it, so treat it as what they said. This is for the rare message that reads like a mishearing, or like something was lost in the tidying.',
    ],
  },
];

/** `talkcode help`: one line per topic. */
export function renderHelpIndex(): string {
  const width = Math.max(...HELP_TOPICS.map((t) => t.name.length));
  return [
    'talkcode commands, by topic.',
    'Run `talkcode help <topic>` for a topic\'s commands and rules.',
    '',
    ...HELP_TOPICS.map((t) => `  ${t.name.padEnd(width)}  ${t.summary}`),
  ].join('\n');
}

/** `talkcode help <topic>`: its commands, rendered from the specs, then its notes. */
export function renderHelpTopic(name: string): string | undefined {
  const topic = HELP_TOPICS.find((t) => t.name === name.toLowerCase());
  if (!topic) return undefined;
  const lines = [`${topic.name} — ${topic.summary}`, ''];
  for (const spec of REVERSE_COMMANDS.filter((c) => c.topic === topic.name)) {
    lines.push(`  talkcode ${spec.usage}`, `    ${spec.description}`);
    for (const opt of [...spec.options, CHANNEL_OPTION]) lines.push(`      ${opt.flags}${opt.description ? `  ${opt.description}` : ''}`);
    lines.push('');
  }
  if (topic.notes.length) lines.push('Notes:', ...topic.notes.map((n) => `  - ${n}`));
  return lines.join('\n');
}

/**
 * The "target channel" option shared by all reverse commands; empty = current session.
 *
 * The description is short because it is paid for twice over: it is a parameter of both native
 * tools, whose schemas ride along in every request. The id format it used to spell out here is on
 * the `channels` help page, which is where an agent gets an id from anyway.
 */
export const CHANNEL_OPTION: ReverseOption = {
  flags: '-c, --channel <id>',
  description: 'where to post, as an id from `talkcode channels` (default: this conversation)',
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Required positional accessor. Commander enforces `<arg>` presence before build() runs, so a
 * missing positional is a programmer error (catalog usage/build mismatch) — fail fast with a clear
 * message rather than letting `undefined` flow into an IpcAction field typed as string.
 */
const pos = (positionals: string[], i: number, name: string): string => {
  const v = positionals[i];
  if (v === undefined) throw new Error(`missing required argument <${name}>`);
  return v;
};

/**
 * Integer option parser for --limit / --timeout etc. Illegal input (empty,
 * non-numeric, fractional, NaN) throws a usage error instead of yielding NaN:
 * `parseInt('x',10)` returns NaN and `typeof NaN === 'number'` is true, which would
 * let NaN slip silently into numeric fields like action.limit. Fail fast at parse time.
 */
const intArg = (label: string) => (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`${label} must be an integer, got ${JSON.stringify(value)}`);
  }
  return n;
};

/**
 * The task commands name the conversation they act on as a positional, and a `--channel` beside it
 * would be a second, contradicting answer to the same question — refused, not ignored.
 */
const refuseChannel = (command: string, opts: Record<string, unknown>): void => {
  if (str(opts.channel) !== undefined) throw new Error(`${command} names its conversation itself; --channel does not apply`);
};

/** Commander collect parser: accumulate a repeatable option (e.g. -o) into an array. */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/**
 * fetch-messages column catalog. DEFAULT_FETCH_FIELDS is the minimal schema (AXI §2): just
 * enough to identify and read a message. ALLOWED extends it with opt-in scalar columns the
 * agent can request via --fields; `attachments` renders as a count (a nested array would break
 * the tabular TOON form). Shared with the CLI output boundary (reverse.ts) so selection and
 * rendering never drift.
 */
export const DEFAULT_FETCH_FIELDS = ['messageId', 'userId', 'content'] as const;
export const ALLOWED_FETCH_FIELDS = [
  'messageId',
  'userId',
  'content',
  'timestamp',
  'quoteId',
  'platform',
  'channelId',
  'attachments',
] as const;

/**
 * --fields parser: split a comma-separated list, validate against ALLOWED_FETCH_FIELDS, and
 * fail fast on an unknown column (AXI §6 — surface the mistake instead of silently dropping it).
 * Repeatable: accumulates across multiple --fields flags.
 */
const fieldsArg = (value: string, previous: string[] = []): string[] => {
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = parts.filter((p) => !(ALLOWED_FETCH_FIELDS as readonly string[]).includes(p));
  if (invalid.length) {
    throw new Error(
      `--fields: unknown column(s) ${invalid.join(', ')}; allowed: ${ALLOWED_FETCH_FIELDS.join(', ')}`
    );
  }
  return [...previous, ...parts];
};

/**
 * Duration parser for --timeout on schedule: `90s`, `10m`, `1h`, or bare milliseconds. Units
 * because a bash task's limit is minutes, and `--timeout 600000` is a number nobody checks.
 */
const durationArg = (value: string): number => {
  const m = /^(\d+)\s*(ms|s|m|h)?$/i.exec(value.trim());
  if (!m) throw new Error(`--timeout must be a duration like 90s, 10m or 1h, got ${JSON.stringify(value)}`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[(m[2] ?? 'ms').toLowerCase() as 'ms' | 's' | 'm' | 'h'];
  return Number(m[1]) * unit;
};

/** `schedule add`'s own options, by commander's camel-cased key — refused on every other action. */
const SCHEDULE_ADD_KEYS = ['cron', 'at', 'tz', 'name', 'prompt', 'bash', 'agent', 'session', 'cwd', 'timeout'] as const;

function buildScheduleAdd(opts: Record<string, unknown>): IpcAction {
  const session = str(opts.session);
  if (session !== undefined && session !== 'fixed' && session !== 'new') {
    throw new Error(`--session must be fixed or new, got ${JSON.stringify(session)}`);
  }
  return {
    kind: 'schedule-add',
    channelId: str(opts.channel),
    name: str(opts.name),
    cron: str(opts.cron),
    at: str(opts.at),
    tz: str(opts.tz),
    prompt: str(opts.prompt),
    bash: str(opts.bash),
    agent: str(opts.agent),
    session,
    cwd: str(opts.cwd),
    timeoutMs: typeof opts.timeout === 'number' ? opts.timeout : undefined,
  };
}

/** `schedule <action> [id]` → one IpcAction, refusing flags that do not belong to the action. */
function buildSchedule(p: string[], opts: Record<string, unknown>): IpcAction {
  const action = pos(p, 0, 'action').toLowerCase();
  if (action === 'add') {
    if (p[1] !== undefined) throw new Error('schedule add takes no id; its options describe the task');
    return buildScheduleAdd(opts);
  }
  const stray = SCHEDULE_ADD_KEYS.find((k) => opts[k] !== undefined);
  if (stray) throw new Error(`--${stray} only applies to \`schedule add\``);
  if (str(opts.channel) !== undefined) throw new Error(`--channel only applies to \`schedule add\` (where output goes)`);
  const id = (): string => {
    const v = p[1]?.replace(/^#/, '');
    if (!v) throw new Error(`schedule ${action} needs a task id (\`talkcode schedule list\` shows them)`);
    return v;
  };
  switch (action) {
    case 'list':
    case 'ls':
      return { kind: 'schedule-list' };
    case 'show':
      return { kind: 'schedule-list', id: id() };
    case 'pause':
    case 'resume':
    case 'run':
      return { kind: 'schedule-op', id: id(), op: action };
    case 'rm':
    case 'remove':
    case 'delete':
      return { kind: 'schedule-op', id: id(), op: 'remove' };
    default:
      throw new Error(`unknown schedule action "${action}"; use add | list | show | pause | resume | run | rm`);
  }
}

/** `sessions <action> [arg]` → one IpcAction, refusing flags that do not belong to the action. */
function buildSessions(p: string[], opts: Record<string, unknown>): IpcAction {
  const action = pos(p, 0, 'action').toLowerCase();
  // The library is every conversation the gateway has carried, so there is no target to name.
  if (str(opts.channel) !== undefined) {
    throw new Error('sessions searches every conversation; --channel does not apply');
  }
  const num = (key: string): number | undefined => (typeof opts[key] === 'number' ? (opts[key] as number) : undefined);
  const refuse = (allowed: readonly string[]): void => {
    const all = ['agent', 'days', 'limit', 'around', 'window'];
    const stray = all.find((k) => !allowed.includes(k) && opts[k] !== undefined);
    if (stray) throw new Error(`--${stray} does not apply to \`sessions ${action}\``);
  };
  switch (action) {
    case 'search': {
      refuse(['agent', 'days', 'limit']);
      // Unquoted words are joined, so `sessions search git status` works like a search box.
      const query = p.slice(1).join(' ').trim();
      if (!query) throw new Error('sessions search needs a word to look for');
      return {
        kind: 'sessions-search',
        query,
        agent: str(opts.agent),
        days: num('days'),
        limit: num('limit'),
      };
    }
    case 'read': {
      refuse(['around', 'window']);
      if (p.length > 2) throw new Error('sessions read takes one conversation id');
      return {
        kind: 'sessions-read',
        session: pos(p, 1, 'session'),
        around: num('around'),
        window: num('window'),
      };
    }
    case 'list':
    case 'ls': {
      refuse(['days', 'limit']);
      if (p.length > 1) throw new Error('sessions list takes no arguments');
      return { kind: 'sessions-list', days: num('days'), limit: num('limit') };
    }
    default:
      throw new Error(`unknown sessions action "${action}"; use search <words> | read <session> | list`);
  }
}

export const REVERSE_COMMANDS: ReverseCommandSpec[] = [
  {
    usage: 'send-message <text>',
    topic: 'messages',
    description: 'Send a message to the current session',
    options: [],
    build: (p, opts) => ({ kind: 'send-message', text: pos(p, 0, 'text'), channelId: str(opts.channel) }),
  },
  {
    usage: 'reply <messageId> <text>',
    topic: 'messages',
    description: 'Reply to a specific message',
    options: [],
    build: (p, opts) => ({
      kind: 'reply',
      messageId: pos(p, 0, 'messageId'),
      text: pos(p, 1, 'text'),
      channelId: str(opts.channel),
    }),
  },
  {
    usage: 'edit-message <messageId> <text>',
    topic: 'messages',
    description: 'Edit the text of a message you sent earlier (e.g. update a progress/status message)',
    options: [],
    build: (p, opts) => ({
      kind: 'edit-message',
      messageId: pos(p, 0, 'messageId'),
      text: pos(p, 1, 'text'),
      channelId: str(opts.channel),
    }),
  },
  {
    usage: 'send-file <path>',
    topic: 'files',
    description: 'Send a file to the current session',
    options: [
      { flags: '-n, --name <name>', description: 'filename shown to the user (default: the file\'s own)' },
      { flags: '--caption <caption>', description: 'text shown with the file' },
    ],
    build: (p, opts) => ({
      kind: 'send-file',
      path: pos(p, 0, 'path'),
      name: str(opts.name),
      caption: str(opts.caption),
      channelId: str(opts.channel),
    }),
  },
  {
    usage: 'react <messageId> <emoji>',
    topic: 'messages',
    description: 'Add an emoji reaction to a message',
    options: [],
    build: (p, opts) => ({
      kind: 'react',
      messageId: pos(p, 0, 'messageId'),
      emoji: pos(p, 1, 'emoji'),
      channelId: str(opts.channel),
    }),
  },
  {
    usage: 'delete <messageId>',
    topic: 'messages',
    description: 'Delete a message',
    options: [],
    build: (p, opts) => ({ kind: 'delete', messageId: pos(p, 0, 'messageId'), channelId: str(opts.channel) }),
  },
  {
    usage: 'fetch-messages',
    topic: 'history',
    description: 'Fetch channel message history (TOON table written to stdout for the agent to read)',
    options: [
      { flags: '-l, --limit <n>', description: 'number of messages', parse: intArg('--limit') },
      { flags: '--before <messageId>' },
      {
        flags: '-f, --fields <list>',
        description: `comma-separated columns (default ${DEFAULT_FETCH_FIELDS.join(',')}; available ${ALLOWED_FETCH_FIELDS.join(',')})`,
        parse: fieldsArg,
      },
    ],
    build: (_positionals, opts) => ({
      kind: 'fetch-messages',
      channelId: str(opts.channel),
      limit: typeof opts.limit === 'number' ? opts.limit : undefined,
      before: str(opts.before),
      fields: Array.isArray(opts.fields) ? (opts.fields as string[]) : undefined,
    }),
  },
  {
    usage: 'create-thread <messageId> <name>',
    topic: 'threads',
    description: 'Create a thread from a specific message',
    options: [],
    build: (p, opts) => ({
      kind: 'create-thread',
      messageId: pos(p, 0, 'messageId'),
      name: pos(p, 1, 'name'),
      channelId: str(opts.channel),
    }),
  },
  {
    usage: 'ask <prompt>',
    topic: 'ask',
    description: 'Ask a clarifying question (blocking: sends a message with buttons and waits for the user to choose, returning the chosen label text to stdout)',
    options: [
      // -o is repeatable: one button per label, collected into an array.
      { flags: '-o, --option <label>', description: 'an available option (repeatable)', parse: collect },
      { flags: '--timeout <ms>', description: `wait timeout in milliseconds (default ${DEFAULT_ASK_TIMEOUT_MS})`, parse: intArg('--timeout') },
    ],
    build: (p, opts) => ({
      kind: 'ask',
      prompt: pos(p, 0, 'prompt'),
      options: Array.isArray(opts.option) ? (opts.option as string[]) : [],
      timeoutMs: typeof opts.timeout === 'number' ? opts.timeout : undefined,
      channelId: str(opts.channel),
    }),
  },
  {
    usage: 'voice-log',
    topic: 'voice',
    description:
      "List this conversation's recent voice-message transcripts: what the user said, what was sent on, and the saved audio file (TOON table on stdout)",
    options: [{ flags: '-l, --limit <n>', description: 'number of transcripts (default 10)', parse: intArg('--limit') }],
    build: (_positionals, opts) => {
      // The log is keyed by conversation and read for the caller's own; there is no other channel
      // to point it at, so a --channel is refused rather than silently ignored.
      if (str(opts.channel) !== undefined) {
        throw new Error("voice-log reads this conversation's own transcripts; --channel does not apply");
      }
      return { kind: 'voice-log', limit: typeof opts.limit === 'number' ? opts.limit : undefined };
    },
    // Nothing tells an agent up front that some messages were spoken, and nothing should: a
    // confirmed transcript reaches it as the user's own typed words — the user read and approved
    // them — so saying so would only invite second-guessing text that has already been checked.
    // The command is for the rare turn where a message reads like a mishearing.
  },
  {
    usage: 'channels',
    topic: 'channels',
    description:
      'List the chats and topics this gateway can post to, with the ids --channel accepts (TOON table on stdout)',
    options: [
      { flags: '-p, --platform <instance>', description: 'only this platform instance (e.g. tg, web)' },
      { flags: '-q, --query <text>', description: 'filter by id, title or agent' },
      {
        flags: '-l, --limit <n>',
        description: `number of topics (default ${DEFAULT_CHANNEL_LIMIT}, most recent first)`,
        parse: intArg('--limit'),
      },
    ],
    build: (_positionals, opts) => {
      // Lists places rather than acting in one, so a target would mean nothing — refused, not ignored.
      if (str(opts.channel) !== undefined) {
        throw new Error('channels lists places to post to; --channel does not apply');
      }
      return {
        kind: 'list-channels',
        platform: str(opts.platform),
        query: str(opts.query),
        limit: typeof opts.limit === 'number' ? opts.limit : undefined,
      };
    },
  },
  {
    usage: 'sessions <action> [arg]',
    topic: 'sessions',
    description:
      'The gateway\'s library of past conversations: search <words> [--agent] [--days] [--limit] | read <session> [--around <message>] [--window] | list [--days]',
    options: [
      { flags: '-a, --agent <id>', description: 'search: only conversations answered by this agent' },
      { flags: '-d, --days <n>', description: 'search/list: only the last n days', parse: intArg('--days') },
      { flags: '-l, --limit <n>', description: 'search/list: how many rows (search default 10, list 30)', parse: intArg('--limit') },
      { flags: '--around <message>', description: 'read: a message id from a search hit, to read around', parse: intArg('--around') },
      { flags: '--window <n>', description: 'read: messages on each side of --around (default 10)', parse: intArg('--window') },
    ],
    build: buildSessions,
  },
  {
    usage: 'schedule <action> [id]',
    topic: 'schedule',
    description:
      'Scheduled tasks kept by the gateway (they survive restarts): add | list | show <id> | pause <id> | resume <id> | run <id> | rm <id>',
    options: [
      { flags: '--cron <expr>', description: 'add: recurring, 5-field cron, e.g. "0 8 * * *"' },
      { flags: '--at <time>', description: 'add: once — +30m, +2h, 08:00, "2026-10-01 08:00", or ISO with a zone' },
      { flags: '--tz <zone>', description: "add: IANA zone for --cron/--at (default: the gateway's own)" },
      { flags: '--prompt <text>', description: 'add: an agent runs this' },
      { flags: '--bash <command>', description: 'add: the gateway runs this with bash and posts the output' },
      { flags: '--session <mode>', description: 'add: fixed = a turn in this conversation, 24h max (default) | new = a fresh session each run' },
      { flags: '--agent <id>', description: "add: who runs --prompt (default: this conversation's agent)" },
      { flags: '--name <name>', description: 'add: short name for lists and cards' },
      { flags: '--cwd <dir>', description: 'add: working directory for --bash or --session new' },
      { flags: '--timeout <duration>', description: 'add: --bash time limit, e.g. 90s, 10m (default 10m, max 6h)', parse: durationArg },
    ],
    build: buildSchedule,
  },
  {
    usage: 'task-agents',
    topic: 'tasks',
    description: 'The agents a sub-task can go to: the machine each runs on (here=true: yours), its model, and the project directories it can start in',
    options: [],
    build: (_positionals, opts) => {
      refuseChannel('task-agents', opts);
      return { kind: 'task-agents' };
    },
  },
  {
    usage: 'tasks',
    topic: 'tasks',
    description:
      'The sub-agent topics this conversation opened, most recent first: agent, directory, stage (review | answer | failed | retrying | working | idle), one line, and while one works the tool it is running, its step count, elapsed time and context',
    options: [{ flags: '-l, --limit <n>', description: 'how many (default 30)', parse: intArg('--limit') }],
    build: (_positionals, opts) => {
      refuseChannel('tasks', opts);
      return { kind: 'task-list', limit: typeof opts.limit === 'number' ? opts.limit : undefined };
    },
  },
  {
    usage: 'task-new <text>',
    topic: 'tasks',
    description: 'Propose a sub-task: <text> for one agent, in a topic of its own — started once the person confirms',
    options: [
      { flags: '--agent <id>', description: 'who does the work: an id from task-agents (required)' },
      { flags: '--cwd <dir>', description: "where it starts: a directory task-agents lists (default: the agent's own)" },
      { flags: '--title <title>', description: 'the topic’s name (default: named from <text>)' },
    ],
    build: (positionals, opts) => {
      refuseChannel('task-new', opts);
      const agent = str(opts.agent);
      if (!agent) throw new Error('task-new needs --agent <id>; `talkcode task-agents` lists them');
      return {
        kind: 'task-new',
        agent,
        text: pos(positionals, 0, 'text'),
        cwd: str(opts.cwd),
        title: str(opts.title),
      };
    },
  },
  {
    usage: 'task-send <topic> <text>',
    topic: 'tasks',
    description:
      "Send <text> to one of this conversation's sub-agents: into its turn when the harness takes input mid-turn, else as its next turn",
    options: [
      {
        flags: '--interrupt',
        description: 'stop the turn it is running first, then send this as its next one (the only way to redirect a harness with no mid-turn input, such as agy)',
      },
    ],
    build: (positionals, opts) => {
      refuseChannel('task-send', opts);
      return {
        kind: 'task-send',
        topic: pos(positionals, 0, 'topic'),
        text: pos(positionals, 1, 'text'),
        interrupt: opts.interrupt === true ? true : undefined,
      };
    },
  },
  {
    usage: 'task-read <topic>',
    topic: 'tasks',
    description:
      'A sub-agent topic\'s recent messages, oldest first, cut at 1500 characters each; --full raises the cut, --tail shows the end of each',
    options: [
      { flags: '-l, --limit <n>', description: 'how many messages (default 10)', parse: intArg('--limit') },
      { flags: '--full', description: 'up to 20000 characters per message, 80000 in all (the whole command list, not just its start)' },
      { flags: '--tail <n>', description: 'the last n lines of each message — what it is doing now, without the earlier ones' },
    ],
    build: (positionals, opts) => {
      refuseChannel('task-read', opts);
      return {
        kind: 'task-read',
        topic: pos(positionals, 0, 'topic'),
        limit: typeof opts.limit === 'number' ? opts.limit : undefined,
        full: opts.full === true ? true : undefined,
        tail: typeof opts.tail === 'number' ? opts.tail : undefined,
      };
    },
  },
  {
    usage: 'task-status <topic>',
    topic: 'tasks',
    description:
      'One sub-agent topic in detail: stage, current tool, step, elapsed, context and cost, plus the last three tool calls and its last reply',
    options: [],
    build: (positionals, opts) => {
      refuseChannel('task-status', opts);
      return { kind: 'task-status', topic: pos(positionals, 0, 'topic') };
    },
  },
  {
    usage: 'task-stop <topic>',
    topic: 'tasks',
    description: "Stop what one of this conversation's sub-agents is doing; its topic and context stay",
    options: [],
    build: (positionals, opts) => {
      refuseChannel('task-stop', opts);
      return { kind: 'task-stop', topic: pos(positionals, 0, 'topic') };
    },
  },
  {
    usage: 'pods',
    topic: 'pods',
    description: 'The machines agents run on: address, agents (and where they were read from), whether in the ssh mesh, the last read; and the authorized_keys line for a new one',
    options: [],
    build: (_positionals, opts) => {
      refuseChannel('pods', opts);
      return { kind: 'pod-list' };
    },
  },
  {
    usage: 'pod-add <name> <ssh>',
    topic: 'pods',
    description: 'Add a machine: <name> for its agents (<id>@<name>), <ssh> as user@address[:port]; prints what was found there',
    options: [{ flags: '--host-key <line>', description: "the machine's public host key line, read on the machine (required)" }],
    build: (positionals, opts) => {
      refuseChannel('pod-add', opts);
      const hostKey = str(opts.hostKey);
      if (!hostKey) throw new Error('pod-add needs --host-key "<type> <base64>", read on the machine itself (e.g. /etc/ssh/ssh_host_ed25519_key.pub)');
      return { kind: 'pod-add', name: pos(positionals, 0, 'name'), ssh: pos(positionals, 1, 'ssh'), hostKey };
    },
  },
  {
    usage: 'pod-remove <name>',
    topic: 'pods',
    description: 'Remove a machine and its agents from the gateway (the machine itself is not touched)',
    options: [],
    build: (positionals, opts) => {
      refuseChannel('pod-remove', opts);
      return { kind: 'pod-remove', name: pos(positionals, 0, 'name') };
    },
  },
  {
    usage: 'reload',
    topic: 'config',
    description: 'Apply an edited config.yaml (and its .env) to the running gateway, without a restart; prints what changed',
    options: [],
    build: (_positionals, opts) => {
      // About the whole deployment, like `channels`: a target would mean nothing.
      if (str(opts.channel) !== undefined) throw new Error('reload applies to the whole gateway; --channel does not apply');
      return { kind: 'reload-config' };
    },
  },
];
