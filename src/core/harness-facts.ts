import type { Harness, PermissionLevel } from '../types.js';
import type { MenusMessageKey } from './i18n/menus.js';

/** Generic slash commands translated or answered locally per harness. */
export type GenericCommandName =
  | 'compact'
  | 'context'
  | 'model'
  | 'effort'
  | 'usage'
  | 'doctor'
  | 'mcp'
  | 'init'
  | 'review'
  | 'super'
  | 'btw';

export interface HarnessCommand {
  /** Registered name — the short form the platform menu shows. */
  name: string;
  /** Additional spellings that resolve here. Accepted when typed, never registered. */
  aliases: readonly string[];
  /** Whether a bare invocation can offer this harness's own reported commands. */
  picker: boolean;
}

export type EffortNoSelectorKey = Extract<
  MenusMessageKey,
  | 'effort_no_selector_codex'
  | 'effort_no_selector_opencode'
  | 'effort_no_selector_agy'
  | 'effort_no_selector_default'
>;

export interface HarnessFacts {
  /** Project display name (`Claude Code`), or null for `custom` (falls back to command basename / agent id). */
  displayName: string | null;
  /** Registered agent switch command (`/cc`, `/oc`, ...), or null when the harness has none (`custom`). */
  command: HarnessCommand | null;
  /** Native slash name per generic command; absent keys fall back to `localCommands` or unsupported. */
  nativeCommands: Partial<Record<GenericCommandName, string>>;
  /** Generic commands answered locally by the gateway (populated only from live probes). */
  localCommands: readonly GenericCommandName[];
  /** Whether unmapped generic commands pass through untouched and runtime ACP `customOption`s claim `local`. */
  passthroughCommands: boolean;
  /** Slash names intercepted by the harness's own CLI before the model sees them (diverted to one-shot). */
  cliAnsweredCommands: readonly string[];
  /** i18n key explaining why a model offers no effort selector on this harness. */
  effortNoSelectorKey: EffortNoSelectorKey;
  /** Whether the gateway ignores session modes reported by this harness (agy: modes left out, ask/auto still offered). */
  ignoresSessionModes: boolean;
}

/**
 * Exhaustive pure-data facts per `Harness`. Adding a new harness to `src/types.ts` requires an
 * explicit entry here so commands, labels, effort hints, and permission modes stay in sync.
 */
export const HARNESS_FACTS: Readonly<Record<Harness, HarnessFacts>> = {
  claude: {
    displayName: 'Claude Code',
    command: { name: 'cc', aliases: ['claude'], picker: true },
    nativeCommands: {
      compact: 'compact',
      context: 'context',
      usage: 'usage',
      doctor: 'doctor',
      mcp: 'mcp',
      init: 'init',
      review: 'review',
      super: 'super',
    },
    // Probed live: model (claude-agent-acp 0.58.1), effort (0.81.0, 2026-09-23), btw via session/fork (0.81.0, 2026-11-13).
    localCommands: ['model', 'effort', 'btw'],
    passthroughCommands: false,
    cliAnsweredCommands: [],
    effortNoSelectorKey: 'effort_no_selector_default',
    ignoresSessionModes: false,
  },
  codex: {
    displayName: 'Codex',
    command: { name: 'cx', aliases: ['codex'], picker: true },
    // Probed 2026-09-20 (codex-acp 1.12.0): `usage` -> `status` (`doctor` left unmapped so `status` is not double-mapped); `init` dropped in 1.12.0.
    nativeCommands: {
      compact: 'compact',
      usage: 'status',
      mcp: 'mcp',
      review: 'review',
      super: 'super',
    },
    // Probed: context/model (codex-acp 1.12.0), effort (1.13.0, 2026-09-23), btw via session/fork (2.5.0, 2026-11-13).
    // codex-acp rejects effort-suffixed ids with -32602, so `agents[].model` takes the bare id and effort is configured in config.toml.
    // Separate pitfall: `model_reasoning_effort` must sit at top level in config.toml (not inside a table).
    localCommands: ['context', 'model', 'effort', 'btw'],
    passthroughCommands: false,
    cliAnsweredCommands: [],
    // codex-acp builds effort options from codex-cli's model catalog (probed 2026-09-23).
    effortNoSelectorKey: 'effort_no_selector_codex',
    ignoresSessionModes: false,
  },
  opencode: {
    displayName: 'OpenCode',
    command: { name: 'oc', aliases: ['opencode'], picker: true },
    nativeCommands: {
      init: 'init',
      review: 'review',
      super: 'super',
    },
    // Probed: context (opencode 1.18.18/1.18.27), model, effort (2.0.14, 2026-09-23), btw via session/fork (2.2.5, 2026-11-13).
    localCommands: ['context', 'model', 'effort', 'btw'],
    passthroughCommands: false,
    cliAnsweredCommands: [],
    effortNoSelectorKey: 'effort_no_selector_opencode',
    ignoresSessionModes: false,
  },
  agy: {
    displayName: 'Antigravity',
    // `picker: false`: bare `/agy` acks binding; `agy acp` command list is not yet verified for menu forwarding.
    command: { name: 'agy', aliases: [], picker: false },
    nativeCommands: {
      super: 'super',
    },
    // Probed: usage via one-shot `agy -p=/usage` (1.2.0/1.5.1), context/model/effort via `agy acp` (1.5.1, 2026-11-06). No fork in 1.5.7.
    localCommands: ['context', 'model', 'effort', 'usage'],
    passthroughCommands: false,
    // Static copy of `agy -p /help` (1.2.0, 2026-09-17; `/plugin` added in 1.5.1): `agy acp` hands these to the model as prose.
    cliAnsweredCommands: [
      'agents',
      'changelog',
      'config',
      'credits',
      'effort',
      'help',
      'hooks',
      'model',
      'permissions',
      'plugin',
      'skills',
      'usage',
    ],
    // `agy acp` 1.5.1 offers `thought_level` for Gemini models only.
    effortNoSelectorKey: 'effort_no_selector_agy',
    // agy's modes are left out in code (`modesLeftOut`); measured 1.5.1 (2026-11-06): commands ask, writes do not.
    ignoresSessionModes: true,
  },
  gemini: {
    displayName: 'Gemini CLI',
    command: { name: 'gm', aliases: ['gemini'], picker: true },
    // Best-effort / unverified from CLI docs; `super` omitted (cross-file contract: skill-link places no skills for gemini).
    nativeCommands: {
      compact: 'compress',
      context: 'stats',
      mcp: 'mcp',
    },
    localCommands: [],
    passthroughCommands: false,
    cliAnsweredCommands: [],
    effortNoSelectorKey: 'effort_no_selector_default',
    ignoresSessionModes: false,
  },
  dsh: {
    displayName: 'DeepSeek Harness',
    command: { name: 'dsh', aliases: ['deepseek'], picker: true },
    // `super` omitted: cross-file contract with skill-link (places no skills for dsh).
    nativeCommands: {},
    // Model wire encoding lives in `daemon/harness/dsh.ts`.
    localCommands: ['context', 'model'],
    passthroughCommands: false,
    cliAnsweredCommands: [],
    effortNoSelectorKey: 'effort_no_selector_default',
    ignoresSessionModes: false,
  },
  custom: {
    displayName: null,
    command: null,
    nativeCommands: {},
    // `/btw` checks live `sessionCapabilities.fork` at runtime; forwarding would leak a side question into main context.
    localCommands: ['btw'],
    passthroughCommands: true,
    cliAnsweredCommands: [],
    effortNoSelectorKey: 'effort_no_selector_default',
    ignoresSessionModes: false,
  },
} satisfies Record<Harness, HarnessFacts>;

/**
 * Harness modes that answer permission requests inside the harness itself (AGENTS.md security invariant 1).
 * No permission level may ever map to any of these: claude/CodeBuddy `auto`, codex `agent`, CodeBuddy `dontAsk`.
 */
export const FORBIDDEN_SELF_ANSWERING_MODES = ['auto', 'agent', 'dontAsk'] as const;

/**
 * Candidate session mode ids for each permission level, in priority order (first offered wins).
 * Covers preset harnesses and dynamic custom harnesses (e.g. CodeBuddy 2.181.0, measured 2026-11-18).
 * Security invariant 1: none of these lists may contain any entry from `FORBIDDEN_SELF_ANSWERING_MODES`.
 */
export const PERMISSION_LEVEL_MODES = {
  plan: ['plan'],
  ask: ['default', 'read-only'],
  edits: ['acceptEdits', 'workspace-write'],
  // Explicit mode so a session moved to `plan` returns on reload (opencode persists mode across `session/load`).
  auto: ['default', 'workspace-write', 'build'],
  // CodeBuddy also offers `fullAccess`; `bypassPermissions` comes first so both use the same mode when both exist.
  full: ['bypassPermissions', 'agent-full-access'],
} as const satisfies Record<PermissionLevel, readonly string[]>;

/**
 * Modes that mean `full` when no permission level is explicitly set (including CodeBuddy's `fullAccess`).
 */
export const FULL_ACCESS_MODES: readonly string[] = ['bypassPermissions', 'agent-full-access', 'fullAccess'];
