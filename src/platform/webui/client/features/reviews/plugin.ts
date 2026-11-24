import { toDisposable } from '../../base/lifecycle.js';
import { onLocaleChange, t as tr } from '../../i18n/index.js';
import { definePlugin, type WebuiPlugin } from '../../plugins/api.js';
import { ReviewsStore } from './store.js';
import type { ReviewsPluginDeps } from './types.js';
import { createReviewsViewComponent, type ReviewsViewController } from './view.js';

export function createReviewsPlugin(deps: ReviewsPluginDeps = {}): WebuiPlugin {
  let activeStore: ReviewsStore | null = null;
  const views = new Set<ReviewsViewController>();

  return definePlugin({
    id: 'reviews',
    activate(ctx) {
      const store = new ReviewsStore(ctx, deps);
      activeStore = store;
      ctx.subscriptions.add(store);

      ctx.activity.register({
        id: 'reviews',
        title: tr('sideTasks.tabReviews'),
        icon: 'eye',
        view: 'reviews',
        order: 40,
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

      ctx.commands.register(
        'reviews.refresh',
        async () => {
          await store.load();
        },
        { title: tr('common.refresh') },
      );

      const handleLocaleChange = (): void => {
        for (const v of views) v.refreshLocale();
      };

      ctx.events.on('locale.change', handleLocaleChange);
      ctx.subscriptions.add(toDisposable(onLocaleChange(handleLocaleChange)));

      ctx.events.on('topic.list', () => {
        for (const v of views) v.refreshTopics();
      });

      ctx.events.on('stream.state', ({ state }) => {
        if (state === 'open') void store.load();
      });
    },
    deactivate() {
      views.clear();
      activeStore?.dispose();
      activeStore = null;
    },
  });
}
