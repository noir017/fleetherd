import type { Config, SessionScope } from '../config/schema.js';
import { agentForCommand } from '../core/command-translate.js';
import type { ConversationRef, ConversationKind } from '../core/conversation.js';
import type { InboundMessage } from '../types.js';

/**
 * Routing: map an inbound message to "which agent, in which scope".
 *
 * Split deliberately in two, because the two answers have different lifetimes:
 *  - the SCOPE decides how a conversation is identified, and is a property of config;
 *  - the AGENT is a mutable property of a conversation, and config only chooses its
 *    INITIAL value (plus explicit reassignment via a `/name` command).
 *
 * Conversation identity itself lives in core/conversation.ts — note that no function here
 * builds a key. The agent used to lead the session key, which made `/oc hi` and its plain
 * follow-up two different conversations in one topic.
 */

/** Route-match input (both inbound messages and slash commands normalize to this minimal shape). */
export interface RouteInput {
  platform: string;
  channel: string;
  thread?: string;
  space?: string;
  user: string;
  kind: ConversationKind;
  isBot?: boolean;
  /**
   * Leading `/name` of the message text, if any. Native slash commands also arrive here: the
   * daemon synthesizes them into `/name input` text (daemon.onCommand), so text parsing covers
   * both — `when.command` rules work on every platform, native slash support or not.
   */
  command?: string;
}

export interface AgentChoice {
  agentId: string;
  /**
   * True when the winning rule matched via `when.command` — i.e. the user NAMED this agent
   * (`/oc …`). Only an explicit choice rebinds an existing conversation; a rule matching on
   * platform or channel merely supplies the initial agent, because re-applying it on every
   * message would make binding impossible to change and stickiness meaningless.
   *
   * Also tells the caller the `/name` prefix was consumed and must be stripped, so the target
   * agent doesn't try to run it as one of its own slash commands.
   */
  explicit: boolean;
}

/** Normalize a RouteInput from an InboundMessage. */
export function routeInputFromMessage(msg: InboundMessage): RouteInput {
  const c = msg.conversation;
  return {
    platform: c.platform,
    channel: c.channel,
    ...(c.thread != null ? { thread: c.thread } : {}),
    ...(c.space != null ? { space: c.space } : {}),
    user: c.user,
    kind: c.kind,
    isBot: msg.authorIsBot,
    command: parseTextCommand(msg.content)?.name,
  };
}

/** Normalize a command name: strip leading /, lowercase. */
function normCommand(c: string): string {
  return c.replace(/^\//, '').toLowerCase();
}

/** Leading `/name` + rest-of-text (name of alnum/_/-/:; colon admits MCP names like /mcp:server:cmd). */
const TEXT_COMMAND_RE = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/;

/**
 * Parse a leading `/name` off message text: `{ name, rest }`, or null when the text isn't
 * command-shaped. `rest` is the text after the command (trimmed; '' for a bare `/name`).
 */
export function parseTextCommand(text: string): { name: string; rest: string } | null {
  const m = TEXT_COMMAND_RE.exec(text.trim());
  if (!m) return null;
  const [, name = '', rest = ''] = m;
  return { name, rest: rest.trim() };
}

/**
 * Whether text "looks like a slash command" (starts with `/name`, name of alnum/_/-/:).
 *
 * Rationale: whether the agent (claude-code-acp / SDK) executes input as a native slash command depends
 * on whether the first text block starts with `/`. So when fleetherd assembles the prompt, a message
 * matching this must stay clean `/cmd args` — no quote prefix, no reverse-command hint.
 */
export function looksLikeCommand(text: string): boolean {
  return parseTextCommand(text) !== null;
}

/**
 * Map a conversation kind to the `when.chat` vocabulary.
 *
 * The config says `private` (what an operator writing YAML calls a DM) while the domain type says
 * `direct` (what every adapter calls it). Translating in one place keeps the user-facing word
 * stable without letting the two spellings drift into a silent never-matches.
 */
function chatKindOf(kind: ConversationKind): 'private' | 'group' | 'thread' {
  return kind === 'direct' ? 'private' : kind;
}

/** Whether a rule's `when` fully matches. Provided fields must all match; omitted = unrestricted. */
function matchesWhen(when: Config['routing']['pipeline'][number]['when'], input: RouteInput): boolean {
  if (when.platform !== undefined && when.platform !== input.platform) return false;
  // serverId: a rule with a serverId condition never matches when the message has no space
  // (avoid a false global match).
  if (when.serverId !== undefined && when.serverId !== input.space) return false;
  // channelId matches the channel, ignoring any thread lane: "this channel" naturally covers
  // its topics, which is what an operator writing a channel id means.
  if (when.channelId !== undefined && when.channelId !== input.channel) return false;
  if (when.userId !== undefined && when.userId !== input.user) return false;
  if (when.chat !== undefined && when.chat !== chatKindOf(input.kind)) return false;
  if (when.isBot !== undefined && when.isBot !== Boolean(input.isBot)) return false;
  // command: matches the message's leading /name (native slash commands arrive as `/name input` text too).
  if (when.command !== undefined) {
    if (!input.command) return false;
    if (normCommand(when.command) !== normCommand(input.command)) return false;
  }
  return true;
}

/** The first matching rule, or undefined when the pipeline doesn't match. */
function firstMatch(
  cfg: Config,
  input: RouteInput
): Config['routing']['pipeline'][number] | undefined {
  return cfg.routing.pipeline.find((rule) => matchesWhen(rule.when, input));
}

/**
 * Which scope identifies this message's conversation.
 *
 * Resolved per message rather than stored, so it stays a pure function of config. A rule's
 * `use.scope` override applies whenever that rule matches.
 */
export function resolveScope(cfg: Config, input: RouteInput): SessionScope {
  return firstMatch(cfg, input)?.use.scope ?? cfg.session.scope;
}

/**
 * Which agent this message asks for, and whether it asked EXPLICITLY.
 *
 * The caller (ConversationRegistry) decides what to do with a non-explicit answer: for an
 * existing conversation it is ignored in favour of the bound agent. That is the whole fix for
 * "`/oc hi` answered by opencode, the next message answered by claude".
 *
 * Precedence, and why each step sits where it does:
 *  1. a pipeline rule that matched on `when.command` — the operator wired this name to this agent
 *     by hand, so it outranks the built-in table (and lets a deployment point `/cc` at a second
 *     claude agent, or keep an alias the presets know nothing about);
 *  2. a built-in agent command (`/cc`, `/oc`, `/agy`) — the registered menu entries. Placed ABOVE
 *     a non-command pipeline rule because naming an agent is an explicit instruction, while a
 *     rule matching on platform/channel only supplies that conversation's default answerer;
 *     without this step every registered agent command was inert unless the operator had also
 *     written a matching pipeline rule, and reached the bound agent as the literal text "/oc";
 *  3. whatever rule matched on where the message came from — the initial binding;
 *  4. routing.default.
 */
export function resolveAgent(cfg: Config, input: RouteInput): AgentChoice {
  const rule = firstMatch(cfg, input);
  if (rule?.when.command !== undefined) return { agentId: rule.use.agent, explicit: true };
  const named = input.command ? agentForCommand(cfg, input.command) : undefined;
  if (named) return { agentId: named, explicit: true };
  if (rule) return { agentId: rule.use.agent, explicit: false };
  return { agentId: cfg.routing.default, explicit: false };
}

/** Convenience for callers that need both (one pipeline walk each; the pipeline is tiny). */
export function resolveRoute(
  cfg: Config,
  input: RouteInput
): { agent: AgentChoice; scope: SessionScope } {
  return { agent: resolveAgent(cfg, input), scope: resolveScope(cfg, input) };
}

/** Build a RouteInput straight from a ConversationRef (for paths with no message body). */
export function routeInputFromRef(ref: ConversationRef, command?: string): RouteInput {
  return {
    platform: ref.platform,
    channel: ref.channel,
    ...(ref.thread != null ? { thread: ref.thread } : {}),
    ...(ref.space != null ? { space: ref.space } : {}),
    user: ref.user,
    kind: ref.kind,
    ...(command != null ? { command } : {}),
  };
}
