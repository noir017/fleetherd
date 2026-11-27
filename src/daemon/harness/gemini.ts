import { instructionsHome } from '../../config/instructions.js';
import type { HarnessProfile } from './profile.js';

export const geminiProfile: HarnessProfile = {
  id: 'gemini',
  skillHomes: () => [],
  skillScanDirs: () => [],
  instructionsHome,
};
