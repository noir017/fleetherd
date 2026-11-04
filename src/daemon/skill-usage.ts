import type { InboundMessage, ToolEvent } from '../types.js';
import { activeSkillNames, recordSkillUse, type SkillSignal } from './skills-store.js';

/**
 * How a managed skill is counted as used, from events the gateway already receives.
 *
 * The three signals, because harnesses differ in how a skill reaches the model:
 *  - a `Skill` tool call naming it (Claude Code, CodeBuddy) — the tool's input, not its preview;
 *  - a user message that starts with `/name` — the person asked for it by name;
 *  - any tool call whose arguments or path mention `~/.talkcode/skills/<name>/` — Codex, OpenCode,
 *    agy and AtomCode read the file directly, and a reference or script under it counts too.
 *
 * One turn counts a skill once however many times it appears: an agent that reads SKILL.md and
 * then three references used one skill, not four. The per-conversation set is reset by `beginTurn`,
 * which the registry calls before every turn it starts; out-of-turn (follow-up) tool events share
 * the set of the turn they follow.
 *
 * `talkcode skills …` is administration, not use: an agent listing or patching skills is not
 * learning from them, and counting it would keep every skill alive forever.
 */

/** Conversation → the skills already counted in the turn now running there. */
const counted = new Map<string, Set<string>>();

/** Start a turn: forget the previous one's count and take the `/name` signal from what was typed. */
export function beginSkillTurn(conversationId: string, agentId: string | undefined, batch: InboundMessage[], dir?: string): void {
  const seen = new Set<string>();
  counted.set(conversationId, seen);
  const names = new Set(activeSkillNames(dir));
  for (const message of batch) {
    const name = slashSkill(message.content ?? '');
    if (name && names.has(name)) use(name, agentId, 'slash', seen, dir);
  }
}

/** One tool call: a Skill invocation, or a path into a managed skill's directory. */
export function recordToolUse(conversationId: string, agentId: string | undefined, evt: ToolEvent, dir?: string): void {
  const seen = counted.get(conversationId) ?? new Set<string>();
  counted.set(conversationId, seen);
  const names = new Set(activeSkillNames(dir));
  const byTool = skillToolName(evt);
  if (byTool && names.has(byTool)) use(byTool, agentId, 'skill-tool', seen, dir);
  // A Skill tool call is never the management command, whatever its args say; the path signal can
  // be, because `talkcode skills …` often reads a file while it works.
  if (isAdmin(evt)) return;
  for (const name of pathSkillNames(evt)) {
    if (names.has(name)) use(name, agentId, 'path', seen, dir);
  }
}

/** Forget a conversation's turn state (tests, and a conversation that is gone). */
export function forgetSkillTurn(conversationId: string): void {
  counted.delete(conversationId);
}

function use(name: string, agentId: string | undefined, signal: SkillSignal, seen: Set<string>, dir?: string): void {
  if (seen.has(name)) return;
  seen.add(name);
  recordSkillUse(name, agentId, signal, dir);
}

/** `/name` at the very start of what the person sent; `/model` and friends simply are not skills. */
export function slashSkill(text: string): string | undefined {
  return /^\/([a-z0-9][a-z0-9-]*)(?:\s|$)/.exec(text.trim())?.[1];
}

/** The skill a `Skill` tool call names, from whichever field that harness uses. */
export function skillToolName(evt: ToolEvent): string | undefined {
  if (evt.name.toLowerCase() !== 'skill') return undefined;
  const input = evt.input;
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
  const candidates = [
    fields?.['skill'],
    fields?.['skill_name'],
    fields?.['name'],
    fields?.['command'],
    typeof input === 'string' ? input : undefined,
    evt.inputPreview,
  ];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const name = /^\/?([a-z0-9][a-z0-9-]*)(?:\s|$|:)/.exec(value.trim())?.[1];
    if (name) return name;
  }
  return undefined;
}

/**
 * Managed skill names whose directory appears in a tool call's arguments. A file under
 * `references/` or `scripts/` is inside the skill's directory, so the same match covers it.
 */
export function pathSkillNames(evt: ToolEvent): string[] {
  let text: string;
  try {
    text = `${typeof evt.input === 'string' ? evt.input : JSON.stringify(evt.input ?? '')} ${evt.inputPreview}`;
  } catch {
    text = evt.inputPreview;
  }
  const out = new Set<string>();
  for (const match of text.matchAll(/\.talkcode\/skills\/([a-z0-9][a-z0-9-]*)(?=[/\s"'`]|$)/g)) {
    if (match[1]) out.add(match[1]);
  }
  return [...out];
}

/** `talkcode skills …` is the management command, not a use of what it manages. */
export function isAdmin(evt: ToolEvent): boolean {
  let text: string;
  try {
    text = `${typeof evt.input === 'string' ? evt.input : JSON.stringify(evt.input ?? '')} ${evt.inputPreview}`;
  } catch {
    text = evt.inputPreview;
  }
  return /\btalkcode\s+skills(?=[\s"'`;|&)]|$)/.test(text);
}
