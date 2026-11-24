export {
  CHANGES_PLUGIN_ID,
  CHANGES_TOOL_ID,
  DIFF_EDITOR_KIND,
  createChangesPlugin,
  isChangesAvailable,
} from './plugin.js';
export { buildDiffCommentBlock, diffEditorTitle, gitStatusColorVar } from './diff-helpers.js';
export type { ChangesMode, ChangesPluginDeps, DiffEditorInput } from './types.js';
