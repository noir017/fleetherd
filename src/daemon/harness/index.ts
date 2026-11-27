import type { InstructionsAgent } from '../../config/instructions.js';
import type { Harness } from '../../types.js';
import { agyProfile } from './agy.js';
import { claudeProfile } from './claude.js';
import { codexProfile } from './codex.js';
import { customProfile } from './custom.js';
import { dshProfile } from './dsh.js';
import { geminiProfile } from './gemini.js';
import { opencodeProfile } from './opencode.js';
import type { HarnessProfile, HarnessSources, SkillReaderSpec } from './profile.js';

export const HARNESS_PROFILES = {
  claude: claudeProfile,
  codex: codexProfile,
  agy: agyProfile,
  opencode: opencodeProfile,
  gemini: geminiProfile,
  dsh: dshProfile,
  custom: customProfile,
} as const satisfies Record<Harness, HarnessProfile>;

export function harnessProfile(harness: Harness): HarnessProfile {
  return HARNESS_PROFILES[harness];
}

/** Every harness that has a skills directory, in canonical order (`claude`, `codex`, `agy`, `opencode`, `codebuddy`). */
export const SKILL_READERS: readonly SkillReaderSpec[] = Object.values(HARNESS_PROFILES).flatMap((p) => p.skillReaders ?? []);

/**
 * `def`'s harness's own instruction sources under `home`, or undefined for a harness with none known.
 * Paths are POSIX — every machine an agent runs on here is Linux or macOS.
 */
export function harnessSources(def: InstructionsAgent, home: string): HarnessSources | undefined {
  const profile = HARNESS_PROFILES[def.harness];
  const where = profile.instructionsHome(def, home);
  if (!where) return undefined;
  const delivered = home && where.file.startsWith(`${home}/`) ? `~/${where.file.slice(home.length + 1)}` : where.file;
  return profile.instructionSources?.(def, home, delivered, where.file);
}
