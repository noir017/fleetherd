import os from 'node:os';
import path from 'node:path';
import type { AgentDef } from './schema.js';

/**
 * Where each harness reads its USER-level instruction file, and the layer of
 * `<configDir>/instructions/` it gets — the table `daemon/instructions.ts` delivers by.
 *
 * It lives here, below the daemon, because config loading has to refuse a configuration two agents
 * would fight over: on one machine, two agents whose instruction files resolve to the same path but
 * whose layers differ repoint that link at each other on every start, so one of them silently reads
 * the other's text. The check runs in ConfigSchema (instructionClashes), which may not reach up
 * into `daemon/` (AGENTS.md, Layering), and it must use the same table delivery does — a second copy
 * here would let a load accept what the daemon then overwrites. Only config.yaml's own agents are
 * refused there: a pod's are filtered by config/pods.ts and daemon/pods.ts, because a host must
 * never be able to keep the gateway from loading.
 *
 * ── Where, per harness ────────────────────────────────────────────────────────────────────────────
 * Probed 2026-11-04 except where said: a symlink at the path below pointing to a file holding a
 * random word, the harness run in print mode from an empty directory outside any project, asked for
 * the word. The symlink is the probe because it is what ships.
 *  - claude   — `~/.claude/CLAUDE.md`, Claude Code's documented user memory file. Not probed.
 *  - codex    — `~/.codex/AGENTS.md` (codex 0.165.0). Its session file records it as an `agents_md`
 *               item. An `AGENTS.override.md` beside it takes precedence (the lookup order is in the
 *               binary), so an operator who has one keeps it — this never touches that name.
 *  - opencode — `~/.config/opencode/AGENTS.md` (opencode 2.2.5): its global rule file.
 *  - agy      — `~/.gemini/config/AGENTS.md` (agy, 2026-11-04 build). `~/.gemini/config` is agy's
 *               global customization root — where it reads skills (skill-link.ts) — and its built-in
 *               docs say a root may hold a standalone `GEMINI.md`/`AGENTS.md`, always active.
 *  - custom   — by command, as skill-link.ts reads it: CodeBuddy Code, `~/.codebuddy/CODEBUDDY.md`
 *               (2.179.2, its USER-scope memory file); AtomCode, `~/.atomcode/ATOMCODE.md` (v5.2.5,
 *               named "global … personal defaults" in its own help). Any other command: nothing,
 *               unless the agent's `instructions` names its file.
 *  - gemini, dsh — none known; nothing is placed rather than a guess, unless the agent's
 *               `instructions` names a file.
 * A harness's own override of its directory (CODEX_HOME, XDG_CONFIG_HOME) is not followed; an
 * `env.HOME` override is, by the caller, as for the skill.
 */

/**
 * The per-harness layers the gateway knows by itself — the `<name>.md` files beside `common.md`
 * that the web UI's editor always offers. A `custom` harness's layer is added from the config
 * instead: its agent's id, or the `layer` its `instructions` names.
 */
export const HARNESS_LAYERS = ['claude', 'codex', 'opencode', 'agy', 'codebuddy', 'atomcode'] as const;
export type HarnessLayer = (typeof HARNESS_LAYERS)[number];

/** The harness a preset or a known `custom` command is, or undefined when nothing is known of it. */
export function harnessKind(harness: AgentDef['harness'], command?: string): HarnessLayer | undefined {
  switch (harness) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'agy':
      return harness;
    case 'custom': {
      const cmd = path.basename(command ?? '');
      return cmd === 'codebuddy' || cmd === 'atomcode' ? cmd : undefined;
    }
    case 'gemini':
    case 'dsh':
      return undefined;
    default: {
      const _exhaustive: never = harness;
      return _exhaustive;
    }
  }
}

/** The agent fields `instructionsHome` reads. */
export type InstructionsAgent = Pick<AgentDef, 'id' | 'harness' | 'command' | 'instructions'>;

/** Where one harness reads its user-level instructions. */
export interface InstructionsHome {
  /** The layer's name: the `<name>.md` composed on the gateway, and the copy's name on the host. */
  name: string;
  /** The harness's own user-level instruction file — where the link goes. */
  file: string;
  /** The harness's config directory: nothing is placed unless it exists. */
  requires: string;
}

/** `~/…` against the agent's home; an absolute path as written (the schema allows nothing else). */
function expandInstructionFile(file: string, home: string): string {
  return file.startsWith('~/') ? path.join(home, file.slice(2)) : file;
}

/** Where `def`'s harness reads its user-level instruction file under `home` (see the header). */
export function instructionsHome(def: InstructionsAgent, home: string): InstructionsHome | undefined {
  if (def.instructions) {
    const file = expandInstructionFile(def.instructions.file, home);
    return { name: def.instructions.layer ?? def.id, file, requires: path.dirname(file) };
  }
  switch (harnessKind(def.harness, def.command)) {
    case 'claude':
      return { name: 'claude', file: path.join(home, '.claude', 'CLAUDE.md'), requires: path.join(home, '.claude') };
    case 'codex':
      return { name: 'codex', file: path.join(home, '.codex', 'AGENTS.md'), requires: path.join(home, '.codex') };
    case 'opencode':
      return {
        name: 'opencode',
        file: path.join(home, '.config', 'opencode', 'AGENTS.md'),
        requires: path.join(home, '.config', 'opencode'),
      };
    case 'agy':
      return {
        name: 'agy',
        file: path.join(home, '.gemini', 'config', 'AGENTS.md'),
        requires: path.join(home, '.gemini', 'antigravity-cli'),
      };
    case 'codebuddy':
      return { name: 'codebuddy', file: path.join(home, '.codebuddy', 'CODEBUDDY.md'), requires: path.join(home, '.codebuddy') };
    case 'atomcode':
      return { name: 'atomcode', file: path.join(home, '.atomcode', 'ATOMCODE.md'), requires: path.join(home, '.atomcode') };
    case undefined:
      return undefined;
  }
}

/** An agent the conflict check reads: its harness and instructions, where it runs, and as whom. */
export type PlacedInstructionsAgent = InstructionsAgent & {
  /** The `hosts:` id it runs on; absent = the gateway's own machine. */
  host?: string;
  /** Its `env` block — `HOME` is the home its `~` resolves against (daemon/agent-common.ts). */
  env?: Record<string, string>;
};

/** `~` and `~/…` against `home`; anything else as written (config/load.ts expandHome's rule). */
function underHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/**
 * The home `def`'s `~` resolves against. Locally that is this account's, as agentHome
 * (daemon/skills-scan.ts) resolves it. On a host the account's home is known only once it answers,
 * so `~` stands for it here: two agents there with the same override still resolve to the same
 * path, which is all the check needs.
 */
function instructionHomeOf(def: PlacedInstructionsAgent): string {
  const override = def.env?.['HOME'];
  if (def.host === undefined) return override ? underHome(override, os.homedir()) : os.homedir();
  return override ? underHome(override, '~') : '~';
}

/** `file` under `home` as `~/…`, which is how the operator wrote it; anything else as it is. */
function displayFile(file: string, home: string): string {
  if (file === home) return '~';
  const sep = file[home.length];
  return file.startsWith(home) && (sep === '/' || sep === '\\') ? `~${file.slice(home.length)}` : file;
}

function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** One file, on one machine, that several agents' instructions resolve to. */
export interface InstructionGroup {
  /** The `hosts:` id, or '' for the gateway's own machine. */
  machine: string;
  /** The file as the operator would write it (`~/…`). */
  file: string;
  /** Every agent resolving to it, in the order the check was given them. */
  members: Array<{ id: string; layer: string }>;
}

/**
 * The files that would take more than one layer. The link can only point at one `<layer>.md`, so
 * the last write wins silently — the other agent reads the wrong text, and every start flips the
 * link back.
 *
 * Same layer is sharing, and allowed: two `claude` agents on one machine are the ordinary case.
 * Two agents with different homes still collide on one absolute file, which is why the group key is
 * the machine and the RESOLVED file — the home is already folded into that resolution.
 */
export function instructionClashes(agents: readonly PlacedInstructionsAgent[]): InstructionGroup[] {
  const groups = new Map<string, InstructionGroup>();
  for (const def of agents) {
    const machine = def.host ?? '';
    const home = instructionHomeOf(def);
    const where = instructionsHome(def, home);
    if (!where) continue;
    const key = `${machine}\u0000${where.file}`;
    const g = groups.get(key);
    if (g) g.members.push({ id: def.id, layer: where.name });
    else groups.set(key, { machine, file: displayFile(where.file, home), members: [{ id: def.id, layer: where.name }] });
  }
  return [...groups.values()].filter((g) => new Set(g.members.map((m) => m.layer)).size > 1);
}

/** A clash as one sentence, naming every agent in it with its layer. */
export function instructionConflictMessage(g: InstructionGroup): string {
  const where = g.machine ? `on host "${g.machine}"` : 'on this machine';
  const members = g.members.map((m) => `"${m.id}" (layer "${m.layer}")`);
  return (
    `agents ${listed(members)} deliver the same file ${g.file} ${where}, but their layers differ; ` +
    'one file can only hold one layer — give them the same instructions.layer, or different files'
  );
}
