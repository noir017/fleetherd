import type { IpcAction } from './protocol.js';
import { CHANNEL_OPTION, REVERSE_COMMANDS, type ReverseCommandSpec, type ReverseOption } from './commands.js';

/**
 * The reverse commands an agent gets as native tools — served over MCP by `talkcode mcp`
 * (commands/mcp.ts), which the daemon hands to every ACP session in `session/new`.
 *
 * ── Why two, and why these two ────────────────────────────────────────────────────────────────
 * A tool's definition is context the agent pays for whether or not it is used. Measured 2026-10-09:
 * on Claude Code (claude-agent-acp 0.81, which loads MCP tools in full at this size) these two cost
 * about 1,030 input tokens per request — cached after the first, but every request. Codex 0.159.2
 * lazy-loads MCP tools behind its own `tool_search`, and OpenCode 2.0.26 exposes them inside its
 * code tool (`tools.chat.send_file(…)`), so there they cost less and are found less directly. So a
 * tool has to earn its place by being something the agent could neither do without nor guess exists:
 *  - `send_file` — the one thing a text reply cannot carry. A file has to be uploaded.
 *  - `schedule` — the one capability an agent reliably gets wrong without being told: asked for
 *    "every morning at 8", it reaches for its own harness's scheduler, which lives inside the agent
 *    process and dies with it (the gateway stops idle sessions after an hour, and on every restart).
 * Everything else stays a CLI command behind the bundled skill, which costs one line of skill
 * description until it is needed (see HELP_TOPICS). The skill covers these two as well, which is
 * what an agent that does not see the tools up front — codex, agy — ends up using.
 *
 * ── One source ────────────────────────────────────────────────────────────────────────────────
 * A tool is a view of its REVERSE_COMMANDS entry, not a second definition of it: the parameters are
 * the command's positionals and options, their descriptions are the option descriptions, and the
 * arguments go through the spec's own `build` — so a tool call is validated exactly as the same
 * command typed into a shell would be, and a new option reaches the tool without anyone remembering
 * to add it. What a tool adds is only what a shell user does not need spelled out: a description
 * written for a model, and the closed sets a few values are checked against anyway.
 *
 * Every parameter is a string. Values are passed to the option's `parse` exactly as commander would
 * pass them (a number the model sends is stringified first), which keeps one parser per option; none
 * of the options exposed here is repeatable, and a repeatable one would need more than this.
 */
export interface NativeTool {
  /** The name the model calls. snake_case, which every harness's tool namespace accepts. */
  name: string;
  /** The REVERSE_COMMANDS entry this tool runs, by its command word. */
  command: string;
  description: string;
  /** Descriptions for the command's positionals, keyed by the names its usage string gives them. */
  positionals: Record<string, string>;
  /** Closed sets of accepted values, keyed by parameter name (positional or option). */
  enums?: Record<string, readonly string[]>;
}

export const NATIVE_TOOLS: readonly NativeTool[] = [
  {
    name: 'send_file',
    command: 'send-file',
    description:
      'Send a file to the user: it is uploaded into the conversation as an attachment, and images are ' +
      'shown inline. Use it whenever what the user should get is a file (an image, a PDF, a log, an ' +
      'archive) rather than text.',
    positionals: { path: 'the file: absolute, or relative to your working directory (~ allowed)' },
  },
  {
    name: 'schedule',
    command: 'schedule',
    description:
      'Tasks that run later or repeatedly — a prompt an agent answers, or a bash command — kept ' +
      'outside this session, so they survive restarts and idle shutdowns, unlike a session\'s own ' +
      'scheduler. Output goes to this conversation unless channel names another. If the time, time ' +
      'zone or destination is unclear, ask first. add needs cron or at, and prompt or bash; show, ' +
      'pause, resume, run (now, once) and rm take the id that add and list print.',
    positionals: {
      action: 'what to do',
      id: 'the task id, for show / pause / resume / run / rm',
    },
    enums: {
      action: ['add', 'list', 'show', 'pause', 'resume', 'run', 'rm'],
      session: ['fixed', 'new'],
    },
  },
];

/** A positional as the usage string declares it: `<name>` is required, `[name]` is not. */
interface Positional {
  name: string;
  required: boolean;
}

function specOf(tool: NativeTool): ReverseCommandSpec {
  const spec = REVERSE_COMMANDS.find((s) => s.usage.split(' ')[0] === tool.command);
  if (!spec) throw new Error(`internal: tool ${tool.name} names no reverse command "${tool.command}"`);
  return spec;
}

function positionalsOf(spec: ReverseCommandSpec): Positional[] {
  return spec.usage
    .split(' ')
    .slice(1)
    .map((t) => ({ name: t.slice(1, -1), required: t.startsWith('<') }));
}

/**
 * The key commander gives an option's value, which is the key `build` reads: the long flag,
 * camel-cased (`--channel <id>` → `channel`, `--dry-run` → `dryRun`).
 */
export function optionKey(opt: ReverseOption): string {
  const long = /--([a-z0-9-]+)/i.exec(opt.flags)?.[1];
  if (!long) throw new Error(`internal: option "${opt.flags}" has no long flag`);
  return long.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function optionsOf(spec: ReverseCommandSpec): ReverseOption[] {
  return [...spec.options, CHANNEL_OPTION];
}

/** JSON Schema for a tool's arguments, as MCP `tools/list` carries it. */
export function toolInputSchema(tool: NativeTool): Record<string, unknown> {
  const spec = specOf(tool);
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const prop = (name: string, description: string | undefined): Record<string, unknown> => ({
    type: 'string',
    ...(description ? { description } : {}),
    ...(tool.enums?.[name] ? { enum: [...tool.enums[name]] } : {}),
  });
  for (const p of positionalsOf(spec)) {
    properties[p.name] = prop(p.name, tool.positionals[p.name]);
    if (p.required) required.push(p.name);
  }
  for (const opt of optionsOf(spec)) {
    const key = optionKey(opt);
    properties[key] = prop(key, opt.description);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Turn one tool call's arguments into the IpcAction the same command would build from a shell.
 *
 * Throws a message written for the model on anything the schema promised to refuse — an unknown
 * parameter, a missing required one, a value outside its set — and lets `build` refuse the rest
 * (e.g. `cron` on `schedule list`), so the tool and the CLI reject the same calls with the same words.
 *
 * An empty string or null counts as absent: models fill optional parameters with them, and treating
 * `cron: ""` on a `list` as "a cron was given" would refuse a call that asked for nothing wrong.
 */
export function toolAction(tool: NativeTool, args: unknown): IpcAction {
  const spec = specOf(tool);
  const input = args ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error(`${tool.name}: arguments must be an object`);
  const given = input as Record<string, unknown>;

  const positionals = positionalsOf(spec);
  const options = optionsOf(spec);
  const known = new Set([...positionals.map((p) => p.name), ...options.map(optionKey)]);
  const unknown = Object.keys(given).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new Error(`${tool.name}: unknown parameter(s) ${unknown.join(', ')}; accepted: ${[...known].join(', ')}`);
  }

  const value = (name: string): string | undefined => {
    const v = given[name];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new Error(`${tool.name}: ${name} must be a string`);
    }
    const s = String(v);
    const allowed = tool.enums?.[name];
    if (allowed && !allowed.includes(s)) throw new Error(`${tool.name}: ${name} must be one of ${allowed.join(', ')}`);
    return s;
  };

  const pos: string[] = [];
  for (const p of positionals) {
    const v = value(p.name);
    if (v === undefined) {
      if (p.required) throw new Error(`${tool.name}: ${p.name} is required`);
      // A later positional cannot be given without this one; none of the usages here has one.
      break;
    }
    pos.push(v);
  }

  const opts: Record<string, unknown> = {};
  for (const opt of options) {
    const key = optionKey(opt);
    const v = value(key);
    if (v !== undefined) opts[key] = opt.parse ? opt.parse(v) : v;
  }
  return spec.build(pos, opts);
}

export function findNativeTool(name: string): NativeTool | undefined {
  return NATIVE_TOOLS.find((t) => t.name === name);
}
