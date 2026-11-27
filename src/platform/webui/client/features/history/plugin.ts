import { t as tr } from '../../i18n/index.js';
import { definePlugin, type WebuiPlugin } from '../../plugins/api.js';
import { createHistoryEditor, type HistoryEditorInstance } from './editor.js';
import {
  type HistoryEditorInput,
  historyEditorTitle,
  type HistoryPluginDeps,
  normalizeHistoryEditorInput,
} from './helpers.js';
import { createHistoryView, type HistoryViewInstance } from './view.js';

export function createHistoryPlugin(deps: HistoryPluginDeps = {}): WebuiPlugin {
  let activeViews: Set<HistoryViewInstance> | null = null;
  let activeEditors: Set<HistoryEditorInstance> | null = null;

  return definePlugin({
    id: 'history',
    activate(ctx) {
      const views = new Set<HistoryViewInstance>();
      const editors = new Set<HistoryEditorInstance>();
      activeViews = views;
      activeEditors = editors;

      const openHistoryEditor = (input: HistoryEditorInput): void => {
        for (const view of views) view.setActiveId(input.id);
        ctx.editors.open('history', input);
        deps.onOpenSession?.(input);
      };

      ctx.views.register({
        id: 'history',
        title: tr('sidebar.history'),
        icon: 'history',
        part: 'sidebar',
        component: () => {
          const view = createHistoryView(ctx, deps, openHistoryEditor);
          const origInit = view.init.bind(view);
          const origDispose = view.dispose.bind(view);
          view.init = (params, initCtx) => {
            views.add(view);
            origInit(params, initCtx);
          };
          view.dispose = () => {
            views.delete(view);
            origDispose();
          };
          return view;
        },
      });

      ctx.activity.register({
        id: 'history',
        title: tr('sidebar.history'),
        icon: 'history',
        view: 'history',
        order: 50,
      });

      ctx.editors.register({
        kind: 'history',
        title: historyEditorTitle,
        component: () => {
          const editor = createHistoryEditor(ctx, deps, (inst) => {
            editors.delete(inst);
            if (editors.size === 0) {
              for (const view of views) view.setActiveId(null);
            }
          });
          editors.add(editor);
          return editor;
        },
      });

      ctx.commands.register(
        'history.open',
        (raw: unknown) => {
          const parsed = normalizeHistoryEditorInput(raw);
          if (!parsed) return false;
          openHistoryEditor(parsed);
          return true;
        },
        { title: tr('sidebar.history') },
      );

      ctx.commands.register(
        'history.refresh',
        () => {
          for (const view of views) view.refresh();
        },
        { title: tr('common.refresh') },
      );

      ctx.events.on('topic.list', () => {
        for (const editor of editors) editor.refreshReadOnly();
      });

      ctx.events.on('locale.change', () => {
        for (const view of views) view.refreshLocale();
        for (const editor of editors) editor.refreshLocale();
      });
    },
    deactivate() {
      if (activeViews) {
        for (const view of [...activeViews]) view.dispose();
        activeViews.clear();
        activeViews = null;
      }
      if (activeEditors) {
        for (const editor of [...activeEditors]) editor.dispose();
        activeEditors.clear();
        activeEditors = null;
      }
    },
  });
}
