import { icon } from '../../../icons.js';
import { definePlugin, type PluginContext, type TopicInfo, type WebuiPlugin } from '../../plugins/api.js';
import { createChangesToolPanel } from './changes-tool.js';
import { createDiffEditorPanel } from './diff-editor.js';
import { diffEditorTitle } from './diff-helpers.js';
import type { ChangesPluginDeps } from './types.js';

export const CHANGES_PLUGIN_ID = 'changes';
export const CHANGES_TOOL_ID = 'changes';
export const DIFF_EDITOR_KIND = 'diff';

const EN_DICT: Record<string, string> = {
  'changes.openInEditor': 'Open diff in editor',
  'changes.noActiveTopic': 'Select a topic with a working directory to inspect changes.',
};

const ZH_DICT: Record<string, string> = {
  'changes.openInEditor': '在编辑器中打开 diff',
  'changes.noActiveTopic': '选择一个带工作目录的话题以查看更改。',
};

export function isChangesAvailable(topic: TopicInfo): boolean {
  return Boolean(topic.id && topic.dir?.path);
}

export function createChangesPlugin(deps: ChangesPluginDeps = {}): WebuiPlugin {
  return definePlugin({
    id: CHANGES_PLUGIN_ID,
    activate(ctx: PluginContext): void {
      ctx.i18n.add('en', EN_DICT);
      ctx.i18n.add('zh-CN', ZH_DICT);

      ctx.topicTools.register({
        id: CHANGES_TOOL_ID,
        title: ctx.i18n.t('git.title'),
        icon: icon('git'),
        defaultPart: 'secondary',
        available: isChangesAvailable,
        component: () => createChangesToolPanel(ctx, deps),
      });

      ctx.editors.register({
        kind: DIFF_EDITOR_KIND,
        title: (input) => diffEditorTitle(input, ctx.i18n.t('git.title')),
        component: () => createDiffEditorPanel(ctx, deps),
      });

      ctx.commands.register('changes.openDiff', (input: unknown) => {
        ctx.editors.open(DIFF_EDITOR_KIND, input);
      });
    },
  });
}
