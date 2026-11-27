import { instructionsHome } from '../../config/instructions.js';
import type { HarnessProfile } from './profile.js';

export const dshProfile: HarnessProfile = {
  id: 'dsh',
  skillHomes: () => [],
  skillScanDirs: () => [],
  instructionsHome,
};
