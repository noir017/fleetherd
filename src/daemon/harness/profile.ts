import { homedir } from 'node:os';
import type { InstructionsAgent, InstructionsHome } from '../../config/instructions.js';
import type { AgentDef } from '../../config/schema.js';
import type { Welcome } from '../../remote/connection.js';
import type { Harness } from '../../types.js';
import { expandHome } from '../agent-common.js';

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

/**
 * Harness seam: everything harness-specific in `daemon/` and `commands/` is funneled here.
 * Adding a harness = one file in `src/daemon/harness/` + one line in `HARNESSES` (`index.ts`).
 */
export interface HarnessProfile {
  readonly id: Harness;
  readonly launch: (def: AgentDef, remote?: boolean) => HarnessLaunch;
  readonly capabilityMeta?: (def: Pick<AgentDef, 'harness' | 'command'>) => Record<string, unknown>;
  readonly startupHint?: string;
  readonly skillHomes: (home: string, command?: string) => SkillHome[];
  readonly skillReaders?: readonly SkillReaderSpec[];
  readonly skillHarnessName?: (def: Pick<AgentDef, 'harness' | 'command'>) => string;
  readonly skillScanDirs: (opts: SkillScanOptions) => string[];
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
