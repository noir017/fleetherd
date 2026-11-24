import { icon } from '../../../icons.js';
import { addDisposableListener } from '../../base/dom.js';
import { definePlugin, type PluginContext, type TopicInfo, type WebuiPlugin } from '../../plugins/api.js';
import { createFileEditorPanel } from './file-editor.js';
import { createFilesToolPanel } from './files-tool.js';
import { canonicalFileKey, fileEditorTitle, isFileEditorInput, isFilesFeatureEnabled } from './helpers.js';
import { FileTabStore } from './tab-store.js';
import type { FilesPluginDeps } from './types.js';

export const FILES_PLUGIN_ID = 'files';
export const FILES_TOOL_ID = 'files';
export const FILE_EDITOR_KIND = 'file';

const EN_DICT: Record<string, string> = {
  'files.openInEditor': 'Open in editor',
  'files.noActiveTopic': 'Select a topic with a working directory to browse files.',
  'files.confirmOverwrite': 'Overwrite "{name}" on disk with your version? Newer changes on disk will be lost.',
  'files.revealInTree': 'Reveal in file tree',
  'files.closeTab': 'Close file',
  'files.discardAndClose': 'Discard & close',
  'files.keepLocalOverwrite': 'Keep local & overwrite',
  'files.conflictTitle': 'File write conflict',
  'files.unsavedDotAria': 'Unsaved changes',
};

const ZH_DICT: Record<string, string> = {
  'files.openInEditor': '在编辑器中打开',
  'files.noActiveTopic': '选择一个带工作目录的话题以浏览文件。',
  'files.confirmOverwrite': '确定要用当前内容覆盖磁盘上的 "{name}"？磁盘上的较新改动将丢失。',
  'files.revealInTree': '在文件树中定位',
  'files.closeTab': '关闭文件',
  'files.discardAndClose': '放弃并关闭',
  'files.keepLocalOverwrite': '保留本地修改并覆盖',
  'files.conflictTitle': '文件写入冲突',
  'files.unsavedDotAria': '有未保存的更改',
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
      const tabStore = ctx.subscriptions.add(new FileTabStore());
      const win = deps.doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);
      if (win) {
        ctx.subscriptions.add(
          addDisposableListener(win, 'beforeunload', (ev: BeforeUnloadEvent) => {
            if (!tabStore.hasDirtyTabs()) return;
            ev.preventDefault();
            ev.returnValue = '';
          }),
        );
      }

      ctx.topicTools.register({
        id: FILES_TOOL_ID,
        title: ctx.i18n.t('files.title'),
        icon: icon('folder'),
        defaultPart: 'secondary',
        available: (topic) => isFilesAvailable(topic, deps),
        component: () => createFilesToolPanel(ctx, deps, tabStore),
      });

      ctx.editors.register({
        kind: FILE_EDITOR_KIND,
        title: (input) => fileEditorTitle(input, ctx.i18n.t('files.title')),
        component: () => createFileEditorPanel(ctx, deps, tabStore),
      });

      ctx.commands.register('files.openFile', (input: unknown) => {
        if (!isFilesFeatureEnabled(deps)) return;
        if (isFileEditorInput(input)) {
          tabStore.openOrFocus(input, (next) => ctx.editors.open(FILE_EDITOR_KIND, next));
          return;
        }
        ctx.editors.open(FILE_EDITOR_KIND, input);
      });

      ctx.commands.register(
        'files.revealInTree',
        (input?: unknown) => {
          if (!isFilesFeatureEnabled(deps)) return;
          const target = isFileEditorInput(input) ? input : tabStore.getActive()?.input;
          if (!target) return;
          tabStore.requestReveal({ topicId: target.topicId, path: target.path });
        },
        { title: ctx.i18n.t('files.revealInTree') },
      );

      ctx.commands.register(
        'files.closeFile',
        async (input?: unknown) => {
          if (!isFilesFeatureEnabled(deps)) return false;
          const key = isFileEditorInput(input)
            ? canonicalFileKey(input)
            : typeof input === 'string' && input
              ? input
              : tabStore.getActive()?.key;
          if (!key) return false;
          return tabStore.requestClose(key);
        },
        { title: ctx.i18n.t('files.closeTab') },
      );
    },
  });
}
