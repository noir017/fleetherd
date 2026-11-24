import { icon } from '../../../icons.js';
import { definePlugin, type PluginContext, type TopicInfo, type WebuiPlugin } from '../../plugins/api.js';
import { createFileEditorPanel } from './file-editor.js';
import { createFilesToolPanel } from './files-tool.js';
import { fileEditorTitle, isFilesFeatureEnabled } from './helpers.js';
import type { FilesPluginDeps } from './types.js';

export const FILES_PLUGIN_ID = 'files';
export const FILES_TOOL_ID = 'files';
export const FILE_EDITOR_KIND = 'file';

const EN_DICT: Record<string, string> = {
  'files.openInEditor': 'Open in editor',
  'files.noActiveTopic': 'Select a topic with a working directory to browse files.',
  'files.confirmOverwrite': 'Overwrite "{name}" on disk with your version? Newer changes on disk will be lost.',
};

const ZH_DICT: Record<string, string> = {
  'files.openInEditor': '在编辑器中打开',
  'files.noActiveTopic': '选择一个带工作目录的话题以浏览文件。',
  'files.confirmOverwrite': '确定要用当前内容覆盖磁盘上的 "{name}"？磁盘上的较新改动将丢失。',
};

export function isFilesAvailable(topic: TopicInfo, deps: FilesPluginDeps): boolean {
  // Security invariant 9: gate availability strictly on files.enabled.
  return isFilesFeatureEnabled(deps) && Boolean(topic.id && topic.dir?.path);
}

export function createFilesPlugin(deps: FilesPluginDeps = {}): WebuiPlugin {
  return definePlugin({
    id: FILES_PLUGIN_ID,
    activate(ctx: PluginContext): void {
      ctx.i18n.add('en', EN_DICT);
      ctx.i18n.add('zh-CN', ZH_DICT);

      ctx.topicTools.register({
        id: FILES_TOOL_ID,
        title: ctx.i18n.t('files.title'),
        icon: icon('folder'),
        defaultPart: 'secondary',
        available: (topic) => isFilesAvailable(topic, deps),
        component: () => createFilesToolPanel(ctx, deps),
      });

      ctx.editors.register({
        kind: FILE_EDITOR_KIND,
        title: (input) => fileEditorTitle(input, ctx.i18n.t('files.title')),
        component: () => createFileEditorPanel(ctx, deps),
      });

      ctx.commands.register('files.openFile', (input: unknown) => {
        if (!isFilesFeatureEnabled(deps)) return;
        ctx.editors.open(FILE_EDITOR_KIND, input);
      });
    },
  });
}
