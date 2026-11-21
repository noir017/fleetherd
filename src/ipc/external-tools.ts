import type { IpcAction } from './protocol.js';
import type { McpTool, McpToolAnnotations } from './mcp-rpc.js';
import { findNativeTool, SKILLS_TOOL_ACTIONS, toolAction, toolInputSchema, type NativeTool } from './tools.js';

/**
 * The tools the external MCP entrance offers (daemon/external-mcp.ts): what a caller outside the
 * gateway — a web agent behind an MCP proxy — may do here. Two, and both are views of the reverse
 * commands an agent in a conversation already has, so a call is validated exactly as the same
 * command typed into a shell would be (tools.ts "One source"):
 *
 *  - `skills` — the native tool's schema and actions, `search` and `show`, nothing that writes; its
 *    description alone is written for a caller, which has no skill list of its own. A caller reads
 *    the library; it never adds to what every agent reads (invariant 8).
 *  - `tasks` — the sub-agent commands (`task-agents`, `tasks`, `task-new`, `task-read`,
 *    `task-status`, `task-stop`) as one tool with an `action`, plus `open`, which a conversation never
 *    needs: an agent in one already has a topic to nest sub-tasks under, and a caller from outside
 *    has to be given one. `task-send` is not among them, nor is anything that sends a file or
 *    schedules a run: a caller reads untrusted pages and mail, and a prompt injected there must not
 *    be able to reach an agent with a shell without a person tapping Start (security invariant 11).
 *
 * One tool with an action rather than seven: an external caller pays for every definition in
 * every request the same way a harness does (tools.ts "Why three"), and seven near-identical
 * schemas cost more than one with an enum.
 */

/** The sub-agent commands the `tasks` tool fronts. */
export type TaskCommand = Extract<
  IpcAction,
  { kind: 'task-agents' | 'task-list' | 'task-new' | 'task-read' | 'task-status' | 'task-stop' }
>;

/** What one external tool call asks the daemon for. */
export type ExternalAction =
  | { kind: 'skills'; action: Extract<IpcAction, { kind: 'skills' }> }
  /** Open a coordination topic in the web UI, titled for the caller. */
  | { kind: 'open'; title?: string }
  /** The coordination topics this caller opened (`list` without a topic). */
  | { kind: 'topics' }
  /**
   * A sub-agent command. `in` is the coordination topic it acts from, for `new` and `list`; the
   * others name a sub-task's topic in the action itself, and act from that topic's parent.
   */
  | { kind: 'task'; in?: string; action: TaskCommand };

export type ExternalToolName = 'skills' | 'tasks';
export const EXTERNAL_TOOL_NAMES: readonly ExternalToolName[] = ['skills', 'tasks'];

/** One `tasks` action: the reverse command it runs (none for `open`), and the parameters it takes. */
interface TasksAction {
  command?: string;
  params: readonly string[];
}

const TASKS_ACTIONS = {
  open: { params: ['title'] },
  agents: { command: 'task-agents', params: ['agent'] },
  new: { command: 'task-new', params: ['topic', 'text', 'agent', 'cwd', 'title', 'model', 'option'] },
  list: { command: 'tasks', params: ['topic', 'limit'] },
  status: { command: 'task-status', params: ['topic'] },
  read: { command: 'task-read', params: ['topic', 'reply', 'turn', 'full', 'tail', 'limit'] },
  stop: { command: 'task-stop', params: ['topic'] },
} as const satisfies Record<string, TasksAction>;

type TasksActionName = keyof typeof TASKS_ACTIONS;
const TASKS_ACTION_NAMES = Object.keys(TASKS_ACTIONS) as TasksActionName[];

/**
 * The parameters, described for a model that has none of the CLI's context: `topic` in particular
 * means the coordination topic for `new` and `list`, and a sub-task's topic for the rest.
 */
const TASKS_PARAMS: Record<string, { description: string; type?: 'boolean' }> = {
  action: {
    description:
      'open: a topic of your own in the web UI to propose sub-tasks in (returns its topic id). agents: who can take a sub-task; with agent, that one in full. ' +
      'new: propose one sub-task under your topic. list: with topic, its sub-tasks; without, your topics. ' +
      "status / read / stop: one sub-task, by the topic id list printed.",
  },
  topic: {
    description:
      'new, list: the topic id open returned. status, read, stop: a sub-task\'s topic id, as list prints it (web:main/3a9f0c12).',
  },
  text: { description: 'new: the whole task. The agent sees nothing else — say the goal, the constraints and how to tell it is done.' },
  agent: {
    description:
      'agents: one agent in full — its models, every setting with its values and notes, how busy it is (it is started to ask). new: who does the work, an id from agents (required).',
  },
  cwd: { description: 'new: where it starts on that agent\'s machine: a directory name from agents, or an absolute path.' },
  title: { description: 'open: the topic\'s name. new: the sub-task topic\'s name (default: named from text).' },
  model: { description: 'new: the model it runs on, from that agent\'s model list (default: its configured model).' },
  option: {
    description:
      'new: the agent\'s own settings, key=value, comma-separated, e.g. account=alice@example.com. A setting or value it does not offer is refused with the choices.',
  },
  limit: { description: 'list: how many (default 30). read: how many messages (default 10).' },
  reply: { description: 'read: the last turn that ended normally, its reply whole — what a finished sub-task concluded.', type: 'boolean' },
  turn: { description: 'read: one turn, by number (or last, done).' },
  full: { description: 'read: raise the per-message cut from 1500 to 20000 characters.', type: 'boolean' },
  tail: { description: 'read: the last n lines of each message.' },
};

const TASKS_DESCRIPTION =
  'Hand work to the agents behind this gateway, each in a topic of its own in its web UI, and follow it. ' +
  'open a topic first; new proposes one sub-task there, and nothing starts until the person taps Start on the card it ' +
  'puts up. Nobody tells you when a sub-task ends: check with list, then read (reply: true for what it concluded). ' +
  'You see and stop only sub-tasks under topics you opened.';

/** The `tasks` tool's argument schema: `action`, and every parameter some action takes. */
function tasksInputSchema(): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {
    action: { type: 'string', enum: [...TASKS_ACTION_NAMES], description: TASKS_PARAMS.action!.description },
  };
  const names = new Set(TASKS_ACTION_NAMES.flatMap((a) => [...TASKS_ACTIONS[a].params]));
  for (const name of names) {
    const p = TASKS_PARAMS[name];
    if (!p) throw new Error(`internal: tasks parameter "${name}" has no description`);
    properties[name] = { type: p.type ?? 'string', description: p.description };
  }
  return { type: 'object', properties, required: ['action'], additionalProperties: false };
}

/** The native `skills` tool, whose schema and actions the entrance offers as they are. */
function skillsTool(): NativeTool {
  const tool = findNativeTool('skills');
  if (!tool) throw new Error('internal: no native skills tool');
  return tool;
}

/**
 * The `skills` description a caller outside the gateway is given. The native text opens with the
 * agent's own skill list, which a caller has none of, so that opening is replaced; the rest — what
 * search and show return — is `SKILLS_TOOL_ACTIONS`, the native tool's own text rather than a
 * second copy, so a change there still reaches a caller.
 */
const SKILLS_DESCRIPTION_FOR_CALLERS =
  'The skill library. Search it when the task needs a procedure or setup you do not have. ' + SKILLS_TOOL_ACTIONS;

/**
 * MCP clients treat tools without `readOnlyHint: true` as write actions and prompt on every call.
 * `skills` is strictly read-only (`search` / `show`); `tasks` mixes reads with proposing/stopping
 * sub-tasks (`open` / `new` / `stop`), so it cannot claim read-only, though nothing it does is
 * destructive (sub-tasks wait on a confirmation card).
 */
const SKILLS_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const TASKS_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/** One tool as `tools/list` carries it; the `skills` description is extended by the caller. */
export function externalToolDefinition(name: ExternalToolName): McpTool {
  switch (name) {
    case 'skills': {
      const tool = skillsTool();
      return { name, description: SKILLS_DESCRIPTION_FOR_CALLERS, inputSchema: toolInputSchema(tool), annotations: SKILLS_ANNOTATIONS };
    }
    case 'tasks':
      return { name, description: TASKS_DESCRIPTION, inputSchema: tasksInputSchema(), annotations: TASKS_ANNOTATIONS };
    default: {
      const _exhaustive: never = name;
      throw new Error(`unknown external tool ${String(_exhaustive)}`);
    }
  }
}

/**
 * One external tool call's arguments as the action the daemon carries out. Throws a message for
 * the model on anything it refuses — the same words the CLI uses wherever a reverse command builds
 * the action.
 */
export function externalAction(name: ExternalToolName, args: unknown): ExternalAction {
  if (name === 'skills') {
    const action = toolAction(skillsTool(), args);
    // The tool's enum already holds `action` to search and show; this is the second lock, so a
    // change to the native tool cannot quietly hand a caller from outside the writes.
    if (action.kind !== 'skills' || (action.action !== 'search' && action.action !== 'show')) {
      throw new Error('skills: only search and show are offered here');
    }
    return { kind: 'skills', action };
  }
  return tasksAction(args);
}

function tasksAction(args: unknown): ExternalAction {
  const { which, given } = tasksArgs(args);
  const str = (k: string): string | undefined => (given[k] === undefined ? undefined : String(given[k]));
  const spec: TasksAction = TASKS_ACTIONS[which];
  switch (which) {
    case 'open':
      return { kind: 'open', ...(str('title') ? { title: str('title') } : {}) };
    case 'list': {
      const topic = str('topic');
      if (topic === undefined) {
        if (given.limit !== undefined) throw new Error('tasks: limit applies to list with a topic');
        return { kind: 'topics' };
      }
      return { kind: 'task', in: topic, action: build(spec, without(given, 'topic')) };
    }
    case 'new': {
      const topic = str('topic');
      if (topic === undefined) throw new Error('tasks: new needs topic — the id open returned');
      if (str('agent') === undefined) throw new Error('tasks: new needs agent — an id from the agents action');
      return { kind: 'task', in: topic, action: build(spec, without(given, 'topic')) };
    }
    case 'agents':
    case 'status':
    case 'read':
    case 'stop':
      return { kind: 'task', action: build(spec, given) };
    default: {
      const _exhaustive: never = which;
      throw new Error(`tasks: unknown action ${String(_exhaustive)}`);
    }
  }
}

/**
 * The action named, and the parameters given for it — refused when one does not belong to it. A
 * parameter filled with "" or null is not given: models fill every optional one that way.
 */
function tasksArgs(args: unknown): { which: TasksActionName; given: Record<string, unknown> } {
  const raw = args ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tasks: arguments must be an object');
  const { action, ...rest } = raw as Record<string, unknown>;
  if (typeof action !== 'string' || !(TASKS_ACTION_NAMES as string[]).includes(action)) {
    throw new Error(`tasks: action must be one of ${TASKS_ACTION_NAMES.join(', ')}`);
  }
  const which = action as TasksActionName;
  const params: readonly string[] = TASKS_ACTIONS[which].params;
  const present = Object.keys(rest).filter((k) => rest[k] !== undefined && rest[k] !== null && rest[k] !== '');
  const stray = present.filter((k) => !params.includes(k));
  if (stray.length) {
    throw new Error(
      `tasks: ${stray.join(', ')} ${stray.length === 1 ? 'does' : 'do'} not apply to ${which}; it takes ${params.length ? params.join(', ') : 'nothing else'}`
    );
  }
  return { which, given: Object.fromEntries(present.map((k) => [k, rest[k]])) };
}

/** The reverse command's own build, through a tool view offering only this action's options. */
function build(spec: TasksAction, args: Record<string, unknown>): TaskCommand {
  if (!spec.command) throw new Error('internal: this tasks action runs no reverse command');
  const view: NativeTool = {
    name: 'tasks',
    command: spec.command,
    description: '',
    positionals: {},
    // The positional (`text`, or a sub-task's `topic`) is the command's own; the rest are options.
    options: spec.params.filter((p) => p !== 'topic' && p !== 'text'),
  };
  return toolAction(view, args) as TaskCommand;
}

function without(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _drop, ...rest } = args;
  return rest;
}
