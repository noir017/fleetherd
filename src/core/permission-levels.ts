import { PERMISSION_LEVELS, type PermissionLevel } from '../config/schema.js';

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
 * writing when last measured (agent-acp.ts modesLeftOut).
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
 * them: approving is the gateway's alone, whatever modes the harness has.
 */
export function offeredLevels(offered: readonly string[]): PermissionLevel[] {
  return PERMISSION_LEVELS.filter((l) => l === 'auto' || LEVELS[l].modes.some((m) => offered.includes(m)));
}

/** What a level does, in one clause. */
export function levelDetail(level: PermissionLevel): string {
  return LEVELS[level].detail;
}

/** A typed level, or undefined when the word is not one (case-insensitive). */
export function parseLevel(input: string): PermissionLevel | undefined {
  const norm = input.trim().toLowerCase();
  return PERMISSION_LEVELS.find((l) => l === norm);
}
