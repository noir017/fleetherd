import { PERMISSION_LEVELS, type AgentDef, type PermissionLevel } from '../config/schema.js';

/**
 * `agents[].permissions` as data: what each level asks of the harness, and what of the gateway.
 *
 * ── Why one setting for two things ────────────────────────────────────────────
 * How much an agent may do without the person is decided in two places, and neither alone is the
 * answer. The harness decides what it asks about — its session mode: claude in `acceptEdits` asks
 * before a command but not before an edit, codex in `read-only` asks before writing anything — and
 * the gateway decides what becomes of a request that is asked: approved, or put to the person as
 * buttons (daemon/agent-acp.ts answerPermission). A gateway that asks the person about a harness
 * that asks nothing asks nothing; a harness that asks everything, answered by a gateway that
 * approves, is full access with extra steps. So a level names both, and the person picks one word.
 *
 * ── Where the mode ids come from ──────────────────────────────────────────────
 * Each harness reports its modes itself (`modes` on session/new, or the config option of category
 * `mode` — daemon/agent-acp.ts modeControlOf). A level is a list of the ids that mean it, first
 * one the session offers wins, so a level a harness has no mode for is simply not offered for it —
 * never mapped to something close. Measured 2026-11-18, the modes off `session/new` and what each
 * mode asks in a real file-writing turn (project-reports/acp-permission-modes-20261118.md):
 *
 *   claude-agent-acp 0.81.0   default · acceptEdits · plan · auto · bypassPermissions
 *                             (no bypassPermissions when it runs as root outside a sandbox)
 *   codex-acp 2.5.0           read-only · workspace-write · agent (its default) · agent-full-access
 *                             read-only and workspace-write asked before the edit and the command
 *                             (workspace-write too, where its sandbox cannot run); agent asked
 *                             nothing and its own reviewer refused both; agent-full-access ran both
 *   opencode 2.2.5            build (its default) · plan — agent modes, not permission ones: build
 *                             asks nothing unless opencode.json says `permission: ask`, plan only reads
 *   CodeBuddy 2.181.0         default · acceptEdits · plan · auto · dontAsk · bypassPermissions · fullAccess
 *                             default asked before both, acceptEdits before the command only, plan
 *                             before every action (read-only commands too); the rest ask nothing
 *
 * agy is not here: its modes could not be read that day, and its `default` did not ask before
 * writing when last measured (agent-acp.ts modesLeftOut). Its requests still reach the person under
 * a level that asks — the gateway's half does not need a mode — so `ask` is offered to it and to
 * any harness that reports no mode, saying only what that half can promise (levelDetail).
 *
 * The harnesses' own reviewer modes (claude's and CodeBuddy's `auto`, codex's `agent`, CodeBuddy's
 * `dontAsk`) are no level and no level's mode: they answer requests inside the harness — codex's
 * refused the very edit it was asked for — so a level that maps to one would be the gateway
 * promising an answer it never gets to give.
 */

interface LevelSpec {
  /** Whether the gateway puts the harness's permission requests to the person. Otherwise it approves. */
  asks: boolean;
  /** The session modes that mean this level, by the ids harnesses report; the first one offered wins. */
  modes: readonly string[];
  /** What the level does, in the clause a settings screen shows under its name. */
  detail: string;
}

/**
 * Where `auto` puts a session: the mode in which the harness acts on what the gateway answers —
 * asks, and is approved — rather than deciding on its own. claude's and CodeBuddy's standard mode;
 * codex's workspace-write rather than its standard `agent`, whose own reviewer refused the edit and
 * the command (measured above); opencode's standard `build`. An explicit level, so a session that a
 * level moved goes back: opencode keeps a session's mode across `session/load`, and a session left
 * in `plan` would otherwise come back in it.
 */
const AUTO_MODES = ['default', 'workspace-write', 'build'] as const;

/**
 * The modes that mean `full`, for an agent with no level set: they ask nothing at all, so the
 * gateway's approving half never gets to matter. `fullAccess` is CodeBuddy's own spelling of the
 * same thing, kept out of LEVELS.full.modes so `full` means `bypassPermissions` wherever both exist
 * (the comment there), but a pinned `options.mode: fullAccess` is still a session in full access.
 */
const FULL_LEVEL_MODES: readonly string[] = ['bypassPermissions', 'agent-full-access', 'fullAccess'];

const LEVELS: Record<PermissionLevel, LevelSpec> = {
  plan: {
    asks: true,
    modes: ['plan'],
    detail: 'it plans before it acts, and whatever it asks to do waits for your OK',
  },
  ask: {
    asks: true,
    // claude and CodeBuddy start here; codex's read-only asks before every write.
    modes: ['default', 'read-only'],
    detail: 'edits and commands wait for your OK',
  },
  edits: {
    asks: true,
    modes: ['acceptEdits', 'workspace-write'],
    detail: 'edits in its working directory go through; commands wait for your OK',
  },
  auto: {
    asks: false,
    modes: AUTO_MODES,
    detail: 'whatever it asks to do is approved',
  },
  full: {
    asks: false,
    // CodeBuddy offers `fullAccess` too, which also skips its dangerous-command checks; the
    // claude-spelled one comes first so the same word means the same thing on both.
    modes: ['bypassPermissions', 'agent-full-access'],
    detail: 'its no-prompt mode: nothing is asked, and no sandbox',
  },
};

/**
 * Whether the gateway puts a permission request to the person under this level. Unset approves:
 * that is what every agent had before levels existed (AGENTS.md security invariant 1).
 */
export function asksPerson(level: PermissionLevel | undefined): boolean {
  return level !== undefined && LEVELS[level].asks;
}

/**
 * The mode a session should be in under `level`, out of the mode ids it offers; undefined leaves
 * the session's mode as it is — no level set, or none of the level's modes on offer.
 *
 * `pinned` is the agent's `options.mode`: under `auto` it is where the session goes, since an
 * operator who pinned a mode chose the agent's standard one. Every other level outranks it.
 */
export function levelMode(
  level: PermissionLevel | undefined,
  offered: readonly string[],
  pinned?: string
): string | undefined {
  if (level === undefined) return undefined;
  const candidates = level === 'auto' && pinned !== undefined ? [pinned] : LEVELS[level].modes;
  return candidates.find((m) => offered.includes(m));
}

/**
 * The levels a harness offering these modes can honour, most asked first. `auto` is always among
 * them: approving is the gateway's alone, whatever modes the harness has. So is `ask` when the
 * harness reports no mode at all: the gateway can still put every request it does make to the
 * person, and the level says as much about what it cannot stop (levelDetail). A harness that does
 * report modes gets `ask` only where one of them means it — its own report is the whole list.
 */
export function offeredLevels(offered: readonly string[]): PermissionLevel[] {
  return PERMISSION_LEVELS.filter(
    (l) => l === 'auto' || (l === 'ask' && offered.length === 0) || LEVELS[l].modes.some((m) => offered.includes(m))
  );
}

/**
 * The levels one agent can honour: `auto` alone for `fleetherd api-agent`, which never sends a
 * permission request (isApiAgent), else what its harness's modes offer.
 */
export function offeredLevelsFor(def: AgentDef, offered: readonly string[]): PermissionLevel[] {
  return isApiAgent(def) ? ['auto'] : offeredLevels(offered);
}

/**
 * Whether this definition is `fleetherd api-agent <backend>` — the ACP agent over an HTTP API
 * (src/api-agent/). It only calls a cloud API: nothing runs on this machine, and it never sends
 * `session/request_permission`, so no level has anything to gate and `auto` is the only one that
 * means anything (settings.ts refuses the others by name).
 *
 * Read off the shape of the definition rather than a config flag: a preset harness never matches,
 * and `talkcode` is the same binary under its old name.
 */
export function isApiAgent(def: Pick<AgentDef, 'harness' | 'command' | 'args'>): boolean {
  if (def.harness !== 'custom' || !def.command) return false;
  const name = def.command.split(/[\\/]/).at(-1)?.toLowerCase();
  if (name !== 'fleetherd' && name !== 'talkcode') return false;
  return def.args[0] === 'api-agent';
}

/** Why `auto` is the API agent's only level, in the clause its option and refusal both use. */
export const API_AGENT_DETAIL =
  'the only one that applies: it calls a cloud API, runs nothing on this machine and never asks for permission';

/** Where an unset level's mode came from: a session, the agent's pinned `options.mode`, or neither. */
export type UnsetLevelSource = 'session' | 'pin' | 'none';

export interface UnsetLevel {
  level: PermissionLevel;
  from: UnsetLevelSource;
}

/**
 * The level an agent with no `permissions` is effectively at, and where the mode it was read from
 * came from. Unset leaves the harness in the mode it is in and the gateway approves everything, so
 * the only thing that changes what it may do unasked is that mode: a full-access one asks nothing,
 * which is `full`; any other mode asks at most for things the gateway then approves, which is
 * `auto`.
 *
 * `current` is what a session reports; without one the agent's pinned `options.mode` stands in,
 * because that is where the session starts. A pin is not proof — a harness that does not offer the
 * mode skips it with a log line (daemon/agent-acp.ts applyPinnedOptions) — but it is the only
 * answer left when no session is up. A mode the gateway cannot see at all reads `auto`: approving is
 * what the gateway does with whatever is asked, and nothing here says the harness asks nothing.
 */
export function unsetLevel(def: Pick<AgentDef, 'options'>, current?: string): UnsetLevel {
  const pinned = def.options['mode'];
  const mode = current ?? (pinned === undefined ? undefined : String(pinned));
  const from: UnsetLevelSource = current !== undefined ? 'session' : pinned !== undefined ? 'pin' : 'none';
  return { level: mode !== undefined && FULL_LEVEL_MODES.includes(mode) ? 'full' : 'auto', from };
}

/**
 * What a level does, in one clause.
 *
 * `withoutMode` is for a harness with no session mode the gateway can set for the level (`none`),
 * or agy whose modes are left out (`agy`): only the gateway's half holds, so `ask` must promise
 * exactly that and no more — whatever the harness does without asking is not stopped. agy is its
 * own case because what was measured (1.5.1, 2026-11-06) is specific: it asks before a command and
 * writes into its working directory without asking.
 */
export function levelDetail(level: PermissionLevel, withoutMode?: 'none' | 'agy'): string {
  if (level === 'ask' && withoutMode !== undefined) {
    return withoutMode === 'agy'
      ? 'commands wait for your OK; it writes files without asking'
      : 'only what it asks about waits for your OK; what it does without asking is not stopped';
  }
  return LEVELS[level].detail;
}

/** A typed level, or undefined when the word is not one (case-insensitive). */
export function parseLevel(input: string): PermissionLevel | undefined {
  const norm = input.trim().toLowerCase();
  return PERMISSION_LEVELS.find((l) => l === norm);
}
