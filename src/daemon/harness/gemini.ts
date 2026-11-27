import { instructionsHome } from '../../config/instructions.js';
import type { HarnessProfile } from './profile.js';

export const geminiProfile: HarnessProfile = {
  id: 'gemini',
  launch: (def) => ({ command: 'gemini', args: ['--experimental-acp', ...def.args] }),
  skillHomes: () => [],
  skillScanDirs: () => [],
  instructionsHome,
};
