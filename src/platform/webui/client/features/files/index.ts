export {
  FILES_PLUGIN_ID,
  FILES_TOOL_ID,
  FILE_EDITOR_KIND,
  createFilesPlugin,
  isFilesAvailable,
} from './plugin.js';
export { buildTreeNodes, fileEditorTitle, fromEditorDoc, toEditorDoc } from './helpers.js';
export type { FileEditorInput, FilesPluginDeps, FileTreeItemData } from './types.js';
