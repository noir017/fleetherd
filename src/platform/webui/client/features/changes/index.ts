export {
  CHANGES_PLUGIN_ID,
  CHANGES_TOOL_ID,
  DIFF_EDITOR_KIND,
  createChangesPlugin,
  isChangesAvailable,
} from './plugin.js';
export {
  buildDiffCommentBlock,
  diffEditorPanelId,
  diffEditorTitle,
  gitStatusColorVar,
  openDiffEditor,
} from './diff-helpers.js';
export { CommentDraftStore, formatMergedDiffComments, type StagedDiffComment } from './comment-queue.js';
export {
  computeTextHunks,
  extractPatchHunks,
  resolveNextHunkIndex,
  type DiffHunk,
  type HunkNavState,
} from './hunk-nav.js';
export type { ChangesMode, ChangesPluginDeps, DiffEditorInput } from './types.js';
