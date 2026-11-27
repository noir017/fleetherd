import { instructionsHome } from '../../config/instructions.js';
import type { HarnessProfile } from './profile.js';

export const dshProfile: HarnessProfile = {
  id: 'dsh',
  launch: (def) => ({ command: 'dsh', args: ['--profile', 'acp', ...def.args] }),
  skillHomes: () => [],
  skillScanDirs: () => [],
  instructionsHome,
};
