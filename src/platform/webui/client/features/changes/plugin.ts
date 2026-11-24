import { icon } from '../../../icons.js';
import { definePlugin, type PluginContext, type TopicInfo, type WebuiPlugin } from '../../plugins/api.js';
import { createChangesToolPanel } from './changes-tool.js';
import { CommentDraftStore } from './comment-queue.js';
import { createDiffEditorPanel } from './diff-editor.js';
import { diffEditorTitle, openDiffEditor } from './diff-helpers.js';
import type { ChangesPluginDeps } from './types.js';

export const CHANGES_PLUGIN_ID = 'changes';
export const CHANGES_TOOL_ID = 'changes';
export const DIFF_EDITOR_KIND = 'diff';

const EN_DICT: Record<string, string> = {
  'changes.openInEditor': 'Open diff in editor',
  'changes.noActiveTopic': 'Select a topic with a working directory to inspect changes.',
  'changes.prevHunk': 'Previous change (Shift+Alt+F5 / [)',
  'changes.nextHunk': 'Next change (Alt+F5 / ])',
  'changes.hunkCounter': '{current}/{total}',
  'changes.stageComment': 'Stage comment',
  'changes.stagedCount': '{count} staged',
  'changes.stagedTitle': 'Staged comments',
  'changes.sendMerged': 'Merge & send ({count})',
  'changes.clearStaged': 'Clear all',
  'changes.saveEdit': 'Save',
  'changes.deleteComment': 'Remove',
  'changes.mergedToMessage': 'Merged {count} comments into the message.',
  'changes.commentStaged': 'Comment staged ({count} pending).',
};

const ZH_DICT: Record<string, string> = {
  'changes.openInEditor': '在编辑器中打开 diff',
  'changes.noActiveTopic': '选择一个带工作目录的话题以查看更改。',
  'changes.prevHunk': '上一个改动 (Shift+Alt+F5 / [)',
  'changes.nextHunk': '下一个改动 (Alt+F5 / ])',
  'changes.hunkCounter': '{current}/{total}',
  'changes.stageComment': '暂存评论',
  'changes.stagedCount': '待发送 {count}',
  'changes.stagedTitle': '已暂存评论',
  'changes.sendMerged': '合并发送 ({count})',
  'changes.clearStaged': '清空',
  'changes.saveEdit': '保存',
  'changes.deleteComment': '删除',
  'changes.mergedToMessage': '已合并 {count} 条评论写入输入框。',
  'changes.commentStaged': '已暂存评论（待发送 {count} 条）。',
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
      const commentQueue = ctx.subscriptions.add(new CommentDraftStore());

      ctx.topicTools.register({
        id: CHANGES_TOOL_ID,
        title: ctx.i18n.t('git.title'),
        icon: icon('git'),
        defaultPart: 'secondary',
        available: isChangesAvailable,
        component: () => createChangesToolPanel(ctx, deps, commentQueue),
      });

      ctx.editors.register({
        kind: DIFF_EDITOR_KIND,
        title: (input) => diffEditorTitle(input, ctx.i18n.t('git.title')),
        component: () => createDiffEditorPanel(ctx, deps, commentQueue),
      });

      ctx.commands.register('changes.openDiff', (input: unknown) => {
        openDiffEditor(ctx, input);
      });
    },
  });
}
