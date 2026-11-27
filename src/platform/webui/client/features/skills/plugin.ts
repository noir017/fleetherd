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
  'wb.skills.searchPlaceholder': 'Search skills',
  'wb.skills.uncategorized': 'Other',
  'wb.skills.tierLabel': 'Tier',
  'wb.skills.tierHint': 'Resident skills appear in every agent’s skill list (description max 120 chars).',
  'wb.skills.enabledLabel': 'Enabled',
  'wb.skills.enabledHint': 'Turning off archives this skill and stops sending it to agents.',
  'wb.skills.pinnedLabel': 'Pinned',
  'wb.skills.pinnedHint': 'Pinned skills do not expire when unused.',
  'wb.skills.dirty': 'Modified',
  'wb.skills.unsavedVersion': 'Unsaved changes · saves with version {version}; refused if changed elsewhere',
  'wb.skills.versionNote': 'Version {version}',
  'wb.skills.discard': 'Discard',
  'wb.skills.current': 'Current',
  'wb.skills.categoryLabel': 'Category {category}',
  'wb.skills.categoryField': 'Category',
  'wb.skills.categoryPlaceholder': 'Choose or type a category…',
  'wb.skills.categoryHint': 'Pick an existing group or type a new one; clear to uncategorize.',
  'wb.skills.categoryApply': 'Set',
  'wb.skills.agentsLabel': 'Sent to {agents}',
};

const SKILLS_ZH_STRINGS: Record<string, string> = {
  'wb.skills.diff': '对比',
  'wb.skills.hideDiff': '收起对比',
  'wb.skills.diffCurrent': '当前内容',
  'wb.skills.diffNoChanges': '与当前内容无差异。',
  'wb.skills.diffLoading': '正在加载差异\u2026',
  'wb.skills.diffMetadataNote': '该历史提交的完整文件内容未在本地缓存，当前展示版本元数据差异。',
  'wb.skills.diffClose': '关闭对比',
  'wb.skills.searchPlaceholder': '搜索技能',
  'wb.skills.uncategorized': '其他',
  'wb.skills.tierLabel': '层级',
  'wb.skills.tierHint': '常驻会出现在每个智能体的技能列表里，描述限 120 字',
  'wb.skills.enabledLabel': '启用',
  'wb.skills.enabledHint': '关闭即归档，不再发给任何智能体；再打开就恢复',
  'wb.skills.pinnedLabel': '钉住',
  'wb.skills.pinnedHint': '钉住的技能不会因为久未使用而过期',
  'wb.skills.dirty': '已改动',
  'wb.skills.unsavedVersion': '有未保存的改动 · 保存时带上版本 {version}，别处改过会拒绝',
  'wb.skills.versionNote': '版本 {version}',
  'wb.skills.discard': '撤销',
  'wb.skills.current': '当前',
  'wb.skills.categoryLabel': '分类 {category}',
  'wb.skills.categoryField': '分类',
  'wb.skills.categoryPlaceholder': '选择或输入自定义分类…',
  'wb.skills.categoryHint': '选已有分类或直接输入新分类名；留空则归入其他',
  'wb.skills.categoryApply': '设置',
  'wb.skills.agentsLabel': '发给 {agents}',
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
