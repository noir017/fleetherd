import { t as tr } from '../../i18n/index.js';
import { definePlugin, type PluginContext, type WebuiPlugin } from '../../plugins/api.js';
import { createSkillEditorPanel } from './editor.js';
import { openNewSkillDialog } from './new-dialog.js';
import { SkillsStore } from './store.js';
import { parseSkillEditorInput, resolveSkillsDeps, type SkillsPluginDeps } from './types.js';
import { createSkillsViewPanel } from './view.js';

export const SKILLS_PLUGIN_ID = 'skills';
export const SKILLS_VIEW_ID = 'skills';
export const SKILLS_ACTIVITY_ID = 'skills';
export const SKILL_EDITOR_KIND = 'skill';
export const CMD_SKILLS_NEW = 'skills.new';
export const CMD_SKILLS_REFRESH = 'skills.refresh';

const SKILLS_EN_STRINGS: Record<string, string> = {
  'wb.skills.diff': 'Diff',
  'wb.skills.hideDiff': 'Hide diff',
  'wb.skills.diffCurrent': 'Current',
  'wb.skills.diffNoChanges': 'No differences from current content.',
  'wb.skills.diffLoading': 'Loading diff\u2026',
  'wb.skills.diffMetadataNote': 'Full snapshot for this older commit is not cached locally; showing version metadata diff.',
  'wb.skills.diffClose': 'Close diff',
};

const SKILLS_ZH_STRINGS: Record<string, string> = {
  'wb.skills.diff': '对比',
  'wb.skills.hideDiff': '收起对比',
  'wb.skills.diffCurrent': '当前内容',
  'wb.skills.diffNoChanges': '与当前内容无差异。',
  'wb.skills.diffLoading': '正在加载差异\u2026',
  'wb.skills.diffMetadataNote': '该历史提交的完整文件内容未在本地缓存，当前展示版本元数据差异。',
  'wb.skills.diffClose': '关闭对比',
};

export function createSkillsPlugin(rawDeps: SkillsPluginDeps = {}): WebuiPlugin {
  const deps = resolveSkillsDeps(rawDeps);

  return definePlugin({
    id: SKILLS_PLUGIN_ID,
    activate(ctx: PluginContext): void {
      ctx.i18n.add('en', SKILLS_EN_STRINGS);
      ctx.i18n.add('zh-CN', SKILLS_ZH_STRINGS);
      const store = new SkillsStore(ctx);
      ctx.subscriptions.add(store);

      ctx.views.register({
        id: SKILLS_VIEW_ID,
        title: tr('skills.title'),
        icon: 'book',
        part: 'sidebar',
        when: deps.enabled,
        component: () => createSkillsViewPanel(ctx, store, deps),
      });

      ctx.activity.register({
        id: SKILLS_ACTIVITY_ID,
        title: tr('skills.title'),
        icon: 'book',
        view: SKILLS_VIEW_ID,
        order: deps.activityOrder,
      });

      ctx.editors.register({
        kind: SKILL_EDITOR_KIND,
        title: (input) => parseSkillEditorInput(input)?.name ?? tr('skills.title'),
        component: () => createSkillEditorPanel(store, deps, ctx),
      });

      ctx.commands.register(
        CMD_SKILLS_NEW,
        () => openNewSkillDialog(ctx, store, deps),
        { title: tr('skills.newTitle') },
      );

      ctx.commands.register(
        CMD_SKILLS_REFRESH,
        () => store.refresh(true),
        { title: tr('skills.refreshTitle') },
      );

      ctx.events.on('locale.change', () => {
        void store.refresh(false);
      });
    },
  });
}
