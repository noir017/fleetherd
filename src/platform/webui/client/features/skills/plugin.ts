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

export function createSkillsPlugin(rawDeps: SkillsPluginDeps = {}): WebuiPlugin {
  const deps = resolveSkillsDeps(rawDeps);

  return definePlugin({
    id: SKILLS_PLUGIN_ID,
    activate(ctx: PluginContext): void {
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
        component: () => createSkillEditorPanel(store, deps),
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
