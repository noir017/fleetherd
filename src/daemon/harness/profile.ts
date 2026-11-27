import { homedir } from 'node:os';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { InstructionsAgent, InstructionsHome } from '../../config/instructions.js';
import type { AgentDef, Config } from '../../config/schema.js';
import type { Locale } from '../../core/i18n/index.js';
import type { Welcome } from '../../remote/connection.js';
import type { RemoteHost } from '../../remote/host.js';
import type { Harness } from '../../types.js';
import { expandEnv, expandHome } from '../agent-common.js';
import type { HarnessRelay } from '../relay-types.js';

/** A skills (or plugins) directory to link into, and the harness config directory that must exist first. */
export interface SkillHome {
  dir: string;
  requires: string;
}

/** One entry in the union of skill directories used by `allSkillDirs` and `skillReaders`. */
export interface SkillReaderSpec {
  /** Harness name as `fleetherd-harnesses` names it (e.g. `claude`, `codebuddy`). */
  name: string;
  homes: (home: string) => SkillHome[];
}

/** Inputs for scanning installed skills on disk (`skills-scan.ts`). */
export interface SkillScanOptions {
  home: string;
  cwd: string;
  configured?: readonly string[];
}

/** A harness's syntax for one instruction file pulling in another. */
export interface RefSyntax {
  references: (text: string) => string[];
  resolve: (ref: string, file: { path: string; real: string }, home: string) => string | undefined;
  hops: number;
}

/** Everything a harness reads at user level besides what the gateway places, and how to find it. */
export interface HarnessSources {
  delivered: string;
  summary: string;
  files: Array<{ path: string; note?: string }>;
  ruleDirs: string[];
  ruleNote?: (text: string) => string | undefined;
  syntax?: RefSyntax;
  lists?: { configs: string[]; entries: (text: string) => string[] };
}

/** What one read of a prompt-cache transcript established. */
export interface CacheReading {
  expiresAt: number;
  ttlMs: number;
}

/** Transcript locations and readers owned by a harness profile. */
export interface HarnessTranscript {
  projectsDir?: (def: AgentDef) => string;
  remoteProjectsDir?: (def: AgentDef, w: Welcome) => string;
  transcriptPath?: (home: string, sessionId: string, join?: (...p: string[]) => string) => string;
  readContext?: (def: AgentDef, sessionId: string) => Promise<number | undefined>;
}

/** Resolved executable and argument list for launching an ACP harness child. */
export interface HarnessLaunch {
  command: string;
  args: string[];
}

/** How one review's ACP child is started: the harness's own launch with review isolation switches. */
export interface AcpReviewLaunch {
  command: string;
  args: string[];
  /** Laid over the agent's environment, after its own `env:` block, so these win. */
  env: Record<string, string>;
  /** `session/new` `_meta`. */
  meta?: Record<string, unknown>;
}

/**
 * How a harness's automatic review run is isolated from tools/writes (AGENTS.md security invariant 8).
 * Required on every `HarnessProfile` so adding a harness forces an explicit isolation decision.
 */
export type ReviewIsolation =
  | {
      readonly kind: 'acp';
      readonly build: (def: AgentDef, base: HarnessLaunch) => AcpReviewLaunch;
    }
  | {
      readonly kind: 'agy-print';
      readonly settingsJson: string;
    }
  | 'operator-args';

/** Parse a JSON object from an env value, or `{}` if absent/malformed. */
export function parseEnvJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(expandEnv(raw));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One self-check item returned by `fleetherd doctor`. */
export interface DoctorCheck {
  name: string;
  run: () => Promise<{ ok: boolean; level?: 'warn'; detail?: string }>;
}

/** Per-harness self-check hooks consumed by `commands/doctor.ts`. */
export interface HarnessDoctor {
  /** Command name shown by doctor and probed on PATH / remote hosts. */
  readonly command: (def: AgentDef) => string;
  /** Local availability check override (defaults to `Boolean(locate(cmd))` when omitted). */
  readonly checkLocal?: (cmd: string, locate: (c: string) => string | null) => boolean;
  /** Authentication hint appended to the agent's doctor line when available. */
  readonly authNote?: (def: AgentDef, locale: Locale) => string;
  /** Remediation hint appended when the harness binary/adapter is missing locally. */
  readonly missingNote?: (locale: Locale) => string;
  /** Additional harness-specific doctor checks (e.g. Claude transcripts directory). */
  readonly extraChecks?: (ctx: { cfg: Config | null; locale: Locale }) => DoctorCheck[];
}

/** One error a harness logged against a session (`harness-log.ts`). */
export interface HarnessLogEvent {
  at: Date;
  reason: string;
}

/** How to ask one harness's own log file what went wrong during a silent turn. */
export interface HarnessLogProbe {
  logPath: (home: string, env: NodeJS.ProcessEnv) => string;
  parse: (tail: string, sessionId: string, since: Date) => HarnessLogEvent[];
}

/** Setup wizard defaults for a harness (`commands/setup.ts`). */
export interface HarnessSetup {
  readonly promptCommand?: boolean;
  readonly defaultModel?: string;
}

/**
 * Harness seam: everything harness-specific in `daemon/` and `commands/` is funneled here.
 * Adding a harness = one file in `src/daemon/harness/` + one line in `HARNESSES` (`index.ts`).
 */
export interface HarnessProfile {
  readonly id: Harness;
  readonly launch: (def: AgentDef, remote?: boolean) => HarnessLaunch;
  readonly capabilityMeta?: (def: Pick<AgentDef, 'harness' | 'command'>) => Record<string, unknown>;
  readonly startupHint?: string;
  /** Required review-isolation strategy (AGENTS.md invariant 8). */
  readonly reviewIsolation: ReviewIsolation;
  /** Required self-check hooks for `fleetherd doctor`. */
  readonly doctor: HarnessDoctor;
  /** Setup wizard defaults (`commands/setup.ts`). */
  readonly setup?: HarnessSetup;
  /** Encode a config/chat model id into the wire value the harness's ACP selector expects (e.g. DSH JSON tuple). */
  readonly encodeModelWire?: (model: string) => string;
  /** Decode a wire selector value back to the human-readable model id. */
  readonly decodeModelDisplay?: (wire: string) => string;
  /** Split a combined model+effort config spelling into separate ACP model and effort values (e.g. agy). */
  readonly splitModelOption?: (
    want: string,
    options: SessionConfigOption[] | undefined
  ) => { model: string; effort: string } | undefined;
  /** True when `session/load` resets to the harness's default model so the configured model must be re-applied. */
  readonly forgetsModelOnLoad?: boolean;
  /** True when the harness's session modes are excluded from permission-level mapping (ask/auto only). */
  readonly omitPermissionModes?: boolean;
  /** True when the harness accepts a second `session/prompt` mid-turn without advertising it in `initialize`. */
  readonly takesPromptMidTurn?: boolean;
  /** True when the ACP runtime attaches `agyTurnWatch` for inline warning/context handling. */
  readonly usesAgyTurnWatch?: boolean;
  /** True when the harness provides a built-in quota source even without `quotaCommand`. */
  readonly hasBuiltinQuota?: boolean;
  /** True when the harness supports one-shot CLI commands (e.g. `/usage` via `agy -p`). */
  readonly hasBuiltinCli?: boolean;
  /** True when unknown slash commands that map to an ACP option defer until session options are known. */
  readonly deferUnknownOptions?: boolean;
  /** Extra hint appended to `/context` when a turn completed without reporting context numbers. */
  readonly contextMissingHint?: string;
  /** Log probe for diagnosing silent turns (e.g. opencode rate-limit retries). */
  readonly logProbe?: HarnessLogProbe;
  /** Loopback API relay transform for this harness, if the agent's settings require one. */
  readonly relay?: (def: AgentDef) => HarnessRelay | undefined;
  readonly skillHomes: (home: string, command?: string) => SkillHome[];
  readonly skillReaders?: readonly SkillReaderSpec[];
  readonly skillHarnessName?: (def: Pick<AgentDef, 'harness' | 'command'>) => string;
  readonly skillScanDirs: (opts: SkillScanOptions) => string[];
  readonly configuredSkillDirs?: (home: string, env: NodeJS.ProcessEnv) => Promise<string[]>;
  readonly remoteConfiguredSkillDirs?: (
    host: RemoteHost,
    home: string,
    env: Record<string, string>
  ) => Promise<string[]>;
  readonly pluginHome?: (home: string) => SkillHome | undefined;
  readonly instructionsHome: (def: InstructionsAgent, home: string) => InstructionsHome | undefined;
  readonly instructionSources?: (
    def: InstructionsAgent,
    home: string,
    delivered: string,
    file: string
  ) => HarnessSources | undefined;
  readonly instructionDisplayHarness?: (layer: string | undefined) => string;
  readonly transcript?: HarnessTranscript;
}

/**
 * The agent's HOME, honouring a `HOME` override in its `env` block.
 * An agent running as another identity keeps its skills, transcripts and logs under that home.
 */
export function agentHome(def: AgentDef | undefined): string {
  const override = def?.env?.['HOME'];
  return override && override.length > 0 ? expandHome(override) : homedir();
}
