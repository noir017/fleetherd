// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewPanelList } from '../../../../adapter.js';
import { Emitter } from '../../base/event.js';
import { setLocale } from '../../i18n/index.js';
import type { TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import { createReviewsPlugin } from './plugin.js';
import type { ReviewPanelInitContext } from './types.js';

function makeMemoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

function makePanelInitContext(id: string): ReviewPanelInitContext {
  const visibility = new Emitter<boolean>();
  const dims = new Emitter<{ readonly width: number; readonly height: number }>();
  return {
    id,
    api: {
      id,
      group: 'sidebar',
      params: undefined,
      onDidVisibilityChange: visibility.event,
      onDidDimensionsChange: dims.event,
      setTitle: vi.fn(),
      setBadge: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const SAMPLE_REVIEWS: ReviewPanelList = {
  enabled: true,
  running: true,
  pending: [
    {
      text: 'Prefer concise commit messages',
      reason: 'Repeated across 2 conversations',
      count: 2,
      at: 1700000000000,
      from: [{ title: 'Refactor webui' }],
    },
    {
      text: 'Archive obsolete-helper',
      archive: { name: 'obsolete-helper', into: 'modern-helper' },
      reason: 'Superseded by modern-helper',
      count: 1,
      at: 1700000000000,
      from: [{ title: 'Cleanup skills' }],
    },
  ],
  reviews: [
    {
      id: 'rev-1',
      title: 'Refactor webui',
      at: 1700000000000,
      outcome: 'changed',
      summary: 'Updated 1 skill',
      topic: 'topic-reviewed',
      changes: [
        {
          action: 'patch',
          name: 'webui-dev',
          applied: true,
          reason: 'Documented new component API',
        },
      ],
      preferences: ['Prefer concise commit messages'],
      invalid: [],
    },
  ],
};

function makeHarness() {
  const openTopic = vi.fn();
  const insertIntoComposer = vi.fn();
  const registry = new ContributionRegistry({ openEditor: vi.fn() });
  const events = new WebuiEventBus();
  const storage = new StorageService('', makeMemoryStorage());
  const topicsData: TopicInfo[] = [
    { id: 'topic-reviewed', title: 'Refactor webui', lastAt: 1700000000000 },
  ];

  let currentReviews: ReviewPanelList = structuredClone(SAMPLE_REVIEWS);

  const getJson = vi.fn(async (path: string) => {
    if (path === '/api/reviews') return structuredClone(currentReviews);
    return {};
  });
  const postJson = vi.fn(async (path: string, body: unknown) => {
    if (path === '/api/reviews/op') {
      const req = body as { action: string; text: string };
      currentReviews = {
        ...currentReviews,
        pending: currentReviews.pending.filter((p) => p.text !== req.text),
      };
      return structuredClone(currentReviews);
    }
    if (path === '/api/skills/op') {
      currentReviews = {
        ...currentReviews,
        pending: currentReviews.pending.filter((p) => !p.archive),
      };
      return { ok: true };
    }
    return { ok: true };
  });

  const api: ApiClient = {
    get: vi.fn(async () => new Response('{}')),
    post: vi.fn(async () => new Response('{}')),
    getJson: getJson as ApiClient['getJson'],
    postJson: postJson as ApiClient['postJson'],
  };
  const topics: PluginTopicsBridge = {
    list: () => topicsData,
    active: () => topicsData[0],
    open: openTopic,
    insertIntoComposer,
  };
  const manager = new PluginManager({ registry, events, storage, api, topics });
  return { registry, events, storage, api, getJson, postJson, openTopic, insertIntoComposer, manager };
}

describe('features/reviews plugin', () => {
  afterEach(() => {
    setLocale('en');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('registers activity with pending badge, sidebar view, and refresh command, and disposes cleanly', async () => {
    const { registry, events, manager } = makeHarness();
    const onBadgeChange = vi.fn();

    manager.register(createReviewsPlugin({ onBadgeChange, now: () => 1700000100000 }), { builtin: true });
    const active = await manager.activateAll();
    expect(active).toEqual(['reviews']);

    expect(registry.getActivity('reviews')?.icon).toBe('eye');
    expect(registry.getActivity('reviews')?.order).toBe(30);
    expect(registry.getView('reviews')?.part).toBe('sidebar');
    expect(registry.commands.has('reviews.refresh')).toBe(true);
    expect(registry.getActivityBadge('reviews')).toBeNull();

    await registry.executeCommand('reviews.refresh');
    expect(registry.getActivityBadge('reviews')).toBe(2);
    expect(onBadgeChange).toHaveBeenCalled();

    manager.deactivate('reviews');
    expect(registry.getActivity('reviews')).toBeUndefined();
    expect(registry.getView('reviews')).toBeUndefined();
    expect(registry.commands.has('reviews.refresh')).toBe(false);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('supports adopt, archive, dismiss, expandable detail, topic jump, and locale change', async () => {
    const { registry, events, manager, postJson, openTopic } = makeHarness();
    const createTopic = vi.fn(async () => true);
    const beforeSkillArchive = vi.fn();
    const afterSkillArchive = vi.fn();

    manager.register(
      createReviewsPlugin({
        createTopic,
        beforeSkillArchive,
        afterSkillArchive,
        now: () => 1700000100000,
      }),
      { builtin: true },
    );
    await manager.activateAll();

    const view = registry.getView('reviews')!.component();
    document.body.appendChild(view.element);
    view.init(undefined, makePanelInitContext('reviews'));
    await flushMicrotasks();

    // Pending badge reflects 2 suggestions.
    expect(registry.getActivityBadge('reviews')).toBe(2);

    // Clicking the pending suggestions nav opens the review-prefs editor.
    const prefsNav = view.element.querySelector<HTMLElement>('[data-rev-prefs-nav="1"]')!;
    prefsNav.click();
    const prefsEd = registry.getEditor('review-prefs')!.component();
    document.body.appendChild(prefsEd.element);
    prefsEd.init(undefined, makePanelInitContext('review-prefs'));
    await flushMicrotasks();

    // Adopt triggers createTopic with suggestion text & draft.
    const adoptBtn = prefsEd.element.querySelector<HTMLButtonElement>('[data-rev-adopt="0"]')!;
    adoptBtn.click();
    await flushMicrotasks();
    expect(createTopic).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Prefer concise commit messages' }),
    );

    // Dismiss removes first pending suggestion and updates badge to 1.
    const dismissBtn = prefsEd.element.querySelector<HTMLButtonElement>('[data-rev-dismiss="0"]')!;
    dismissBtn.click();
    await flushMicrotasks();
    expect(postJson).toHaveBeenCalledWith('/api/reviews/op', {
      action: 'dismiss',
      text: 'Prefer concise commit messages',
    });
    expect(registry.getActivityBadge('reviews')).toBe(1);

    // Archive posts to /api/skills/op and triggers archive lifecycle hooks.
    const archiveBtn = prefsEd.element.querySelector<HTMLButtonElement>('[data-rev-archive="0"]')!;
    archiveBtn.click();
    await flushMicrotasks();
    expect(beforeSkillArchive).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledWith('/api/skills/op', { action: 'archive', name: 'obsolete-helper' });
    expect(afterSkillArchive).toHaveBeenCalledWith(true);
    expect(registry.getActivityBadge('reviews')).toBeNull();
    prefsEd.dispose();

    // Open review detail editor and click "Open original topic".
    const item = view.element.querySelector<HTMLElement>('[data-rev="rev-1"]')!;
    item.click();
    const detailEd = registry.getEditor('review')!.component();
    document.body.appendChild(detailEd.element);
    detailEd.init({ id: 'rev-1', title: 'Refactor webui' }, makePanelInitContext('review-1'));
    await flushMicrotasks();
    const openBtn = detailEd.element.querySelector<HTMLButtonElement>('[data-rev-topic="topic-reviewed"]')!;
    openBtn.click();
    expect(openTopic).toHaveBeenCalledWith('topic-reviewed');
    detailEd.dispose();

    // Locale change updates rendered labels.
    setLocale('zh-CN');
    events.emit('locale.change', { locale: 'zh-CN' });
    expect(view.element.querySelector('.fh-reviews-header')).toBeNull();
    expect(view.element.querySelector('.fh-rev-nv-label')?.textContent).toBe('待处理的偏好建议');

    view.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('supports unified keyboard navigation, multi-select, and batch mark-read/archive', async () => {
    const { registry, events, manager, getJson } = makeHarness();
    const twoReviews: ReviewPanelList = {
      ...structuredClone(SAMPLE_REVIEWS),
      pending: [],
      reviews: [
        SAMPLE_REVIEWS.reviews[0]!,
        {
          id: 'rev-2',
          title: 'Second review',
          at: 1700000050000,
          outcome: 'changed',
          summary: 'No changes needed',
          changes: [],
          preferences: [],
          invalid: [],
        },
      ],
    };
    getJson.mockImplementation(async () => structuredClone(twoReviews));

    manager.register(createReviewsPlugin({ now: () => 1700000100000 }), { builtin: true });
    await manager.activateAll();

    const view = registry.getView('reviews')!.component();
    document.body.appendChild(view.element);
    view.init(undefined, makePanelInitContext('reviews'));
    await flushMicrotasks();

    const rows = Array.from(view.element.querySelectorAll<HTMLElement>('[data-rev]'));
    expect(rows.length).toBe(2);

    // ArrowDown moves focus from rev-1 to rev-2
    rows[0]!.focus();
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(rows[1]);

    // Mod+A selects both reviews
    rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    expect(view.element.querySelector('.fh-list-batch-count')?.textContent).toBe('2 selected');

    // Batch Mark Read marks both as read
    view.element.querySelector<HTMLButtonElement>('[data-batch-action="mark-read"]')!.click();
    const updatedRows = Array.from(view.element.querySelectorAll<HTMLElement>('[data-rev]'));
    expect(updatedRows.every((r) => r.getAttribute('data-rev-read') === 'true')).toBe(true);
    expect(view.element.querySelector('.fh-list-batch')).toBeNull();

    // Space selects rev-1, Batch Archive hides rev-1 leaving only rev-2
    updatedRows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    view.element.querySelector<HTMLButtonElement>('[data-batch-action="archive"]')!.click();
    const remaining = Array.from(view.element.querySelectorAll<HTMLElement>('[data-rev]'));
    expect(remaining.map((r) => r.getAttribute('data-rev'))).toEqual(['rev-2']);

    view.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
