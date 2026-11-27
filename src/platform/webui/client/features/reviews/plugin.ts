import { toDisposable } from '../../base/lifecycle.js';
import { onLocaleChange, t as tr } from '../../i18n/index.js';
import { definePlugin, type WebuiPlugin } from '../../plugins/api.js';
import {
  createReviewDetailEditorComponent,
  createReviewPrefsEditorComponent,
  type ReviewEditorController,
  type ReviewEditorInput,
} from './editor.js';
import { ReviewsStore } from './store.js';
import type { ReviewsPluginDeps } from './types.js';
import { createReviewsViewComponent, type ReviewsViewController } from './view.js';

const REVIEWS_EN_STRINGS: Record<string, string> = {
  'wb.reviews.pendingTitle': 'Pending preference suggestions',
  'wb.reviews.pendingTab': 'Preference suggestions',
  'wb.reviews.fromAutoReview': 'From auto-review',
  'wb.reviews.noPending': 'No pending suggestions.',
  'wb.reviews.appliedChanges': 'Applied changes',
  'wb.reviews.suggestedArchive': 'Suggested archives',
  'wb.reviews.openOrigTopic': 'Open original topic',
  'wb.reviews.adoptHint': 'Adopt opens a new topic with a draft for you to review before sending.',
};

const REVIEWS_ZH_STRINGS: Record<string, string> = {
  'wb.reviews.pendingTitle': '待处理的偏好建议',
  'wb.reviews.pendingTab': '偏好建议',
  'wb.reviews.fromAutoReview': '来自自动复盘',
  'wb.reviews.noPending': '暂无待处理建议。',
  'wb.reviews.appliedChanges': '已做的改动',
  'wb.reviews.suggestedArchive': '建议归档',
  'wb.reviews.openOrigTopic': '打开原对话',
  'wb.reviews.adoptHint': '采纳会新开一个话题、放好草稿，你确认后再发。',
};

export function createReviewsPlugin(deps: ReviewsPluginDeps = {}): WebuiPlugin {
  let activeStore: ReviewsStore | null = null;
  const views = new Set<ReviewsViewController>();
  const editors = new Set<ReviewEditorController>();

  return definePlugin({
    id: 'reviews',
    activate(ctx) {
      ctx.i18n.add('en', REVIEWS_EN_STRINGS);
      ctx.i18n.add('zh-CN', REVIEWS_ZH_STRINGS);
      const store = new ReviewsStore(ctx, deps);
      activeStore = store;
      ctx.subscriptions.add(store);

      ctx.activity.register({
        id: 'reviews',
        title: tr('sideTasks.tabReviews'),
        icon: 'eye',
        view: 'reviews',
        order: 30,
        badge: () => store.pendingCount(),
      });

      ctx.views.register({
        id: 'reviews',
        title: tr('sideTasks.tabReviews'),
        icon: 'eye',
        part: 'sidebar',
        component: () => {
          const view = createReviewsViewComponent(ctx, store, deps);
          views.add(view);
          const origDispose = view.dispose.bind(view);
          view.dispose = () => {
            views.delete(view);
            origDispose();
          };
          return view;
        },
      });

      ctx.editors.register({
        kind: 'review',
        title: (input) => {
          const rec = input && typeof input === 'object' ? (input as ReviewEditorInput) : undefined;
          if (rec?.title) return `${tr('sideTasks.tabReviews')} · ${rec.title}`;
          return tr('sideTasks.tabReviews');
        },
        component: () => {
          const editor = createReviewDetailEditorComponent(ctx, store, deps);
          editors.add(editor);
          const origDispose = editor.dispose.bind(editor);
          editor.dispose = () => {
            editors.delete(editor);
            origDispose();
          };
          return editor;
        },
      });

      ctx.editors.register({
        kind: 'review-prefs',
        title: () => ctx.i18n.t('wb.reviews.pendingTab'),
        component: () => {
          const editor = createReviewPrefsEditorComponent(ctx, store, deps);
          editors.add(editor);
          const origDispose = editor.dispose.bind(editor);
          editor.dispose = () => {
            editors.delete(editor);
            origDispose();
          };
          return editor;
        },
      });

      ctx.commands.register(
        'reviews.refresh',
        async () => {
          await store.load();
        },
        { title: tr('common.refresh') },
      );

      const handleLocaleChange = (): void => {
        for (const v of views) v.refreshLocale();
        for (const e of editors) e.refreshLocale();
      };

      ctx.events.on('locale.change', handleLocaleChange);
      ctx.subscriptions.add(toDisposable(onLocaleChange(handleLocaleChange)));

      ctx.events.on('topic.list', () => {
        for (const v of views) v.refreshTopics();
        for (const e of editors) e.refreshTopics();
      });

      ctx.events.on('stream.state', ({ state }) => {
        if (state === 'open') void store.load();
      });
    },
    deactivate() {
      views.clear();
      editors.clear();
      activeStore?.dispose();
      activeStore = null;
    },
  });
}
