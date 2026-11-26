export {
  FILES_PLUGIN_ID,
  FILES_TOOL_ID,
  FILE_EDITOR_KIND,
  createFilesPlugin,
  isFilesAvailable,
} from './plugin.js';
export {
  ancestorDirs,
  buildTreeNodes,
  canonicalFileKey,
  fileEditorTitle,
  fromEditorDoc,
  normalizePathSlashes,
  relativePath,
  toEditorDoc,
} from './helpers.js';
export { FileTabStore, type FileTabRecord, type OpenOrFocusResult } from './tab-store.js';
export type { FileEditorInput, FilesPluginDeps, FileTreeItemData, RevealInTreeRequest } from './types.js';
