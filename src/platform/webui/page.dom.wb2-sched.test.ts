// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewPanelList } from '../workbench.js';
import { Emitter } from './client/base/event.js';
import { groupHistoryByDate, historyAgentClass } from './client/features/history/helpers.js';
import { createHistoryPlugin } from './client/features/history/plugin.js';
import { createReviewsPlugin } from './client/features/reviews/plugin.js';
import type { ReviewPanelInitContext } from './client/features/reviews/types.js';
import { collectScheduledSessionTree, harnessClass } from './client/features/schedules/helpers.js';
import { createSchedulesPlugin } from './client/features/schedules/plugin.js';
import { createSkillsPlugin } from './client/features/skills/plugin.js';
import { setLocale } from './client/i18n/index.js';
import type { TopicInfo } from './client/plugins/api.js';
import { PluginManager } from './client/plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from './client/plugins/registry.js';
import type { ApiClient } from './client/services/api.js';
import { StorageService, type StorageLike } from './client/services/storage.js';
import { WorkbenchShell } from './client/workbench/shell.js';

function makeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function makePanelCtx(id: string): ReviewPanelInitContext {
  const vis = new Emitter<boolean>();
  const dim = new Emitter<{ readonly width: number; readonly height: number }>();
  return {
    id,
    api: {
      id,
      group: 'sidebar',
      params: undefined,
      onDidVisibilityChange: vis.event,
      onDidDimensionsChange: dim.event,
      setTitle: vi.fn(),
      setBadge: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('wb2-sched workbench alignment', () => {
  afterEach(() => {
    setLocale('en');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('collects scheduled session trees with sub-agent depth and harness classes', () => {
    const topics: TopicInfo[] = [
      { id: 'normal', title: 'Normal', lastAt: 500 },
      { id: 'run-1', title: 'nightly-ci', lastAt: 400, scheduled: true, agent: { id: 'codex', harness: 'codex' } },
      { id: 'sub-1', title: 'sub-task', lastAt: 450, parent: 'run-1', agent: { id: 'claude', harness: 'claude' } },
      { id: 'sub-2', title: 'nested', lastAt: 460, parent: 'sub-1' },
    ];
    const tree = collectScheduledSessionTree(topics);
    expect(tree.map((e) => [e.topic.id, e.depth])).toEqual([
      ['run-1', 0],
      ['sub-1', 1],
      ['sub-2', 2],
    ]);
    expect(harnessClass('claude')).toBe('fh-hc fh-hc--claude');
    expect(harnessClass('codex')).toBe('fh-hc fh-hc--codex');
    expect(harnessClass(undefined)).toBe('fh-hc');
  });

  it('groups history records by today, yesterday, and month with agent badges', () => {
    const now = new Date(2026, 10, 25, 14, 0, 0).getTime();
    const items = [
      { id: 1, at: new Date(2026, 10, 25, 10, 24, 0).getTime() },
      { id: 2, at: new Date(2026, 10, 24, 18, 12, 0).getTime() },
      { id: 3, at: new Date(2026, 9, 12, 9, 0, 0).getTime() },
    ];
    const groups = groupHistoryByDate(items, (x) => x.at, now);
    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'm:2026-10']);
    expect(historyAgentClass('claude')).toContain('fh-hc--claude');
    expect(historyAgentClass('codex')).toContain('fh-hc--codex');
  });

  it('renders review detail editor sections and falls back inline when editor kind is unavailable', async () => {
    const sample: ReviewPanelList = {
      enabled: true,
      running: true,
      pending: [
        {
          text: 'Lead with conclusion',
          count: 3,
          at: Date.now(),
          from: [{ title: 'Deploy notes' }],
        },
      ],
      reviews: [
        {
          id: 'r1',
          title: 'Deploy notes',
          at: Date.now(),
          outcome: 'changed',
          summary: 'Updated 1 skill',
          topic: 't1',
          changes: [
            { action: 'patch', name: 'deploy-check', applied: true, reason: 'Added fetch step', undo: 'fleetherd skills revert deploy-check abc' },
            { action: 'patch', name: 'server-ops', applied: false, error: 'Stale version' },
            { action: 'archive', name: 'old-deploy', suggested: true, reason: 'Merged into deploy-check' },
          ],
          preferences: ['Lead with conclusion'],
          invalid: [],
        },
      ],
    };

    const registry = new ContributionRegistry({
      openEditor: () => {
        throw new Error('Unknown editor kind');
      },
    });
    const events = new WebuiEventBus();
    const storage = new StorageService('', makeStorage());
    const api: ApiClient = {
      get: vi.fn(async () => new Response('{}')),
      post: vi.fn(async () => new Response('{}')),
      getJson: vi.fn(async () => structuredClone(sample)) as ApiClient['getJson'],
      postJson: vi.fn(async () => structuredClone(sample)) as ApiClient['postJson'],
    };
    const topics: PluginTopicsBridge = {
      list: () => [{ id: 't1', title: 'Deploy notes', lastAt: Date.now() }],
      active: () => undefined,
      open: vi.fn(),
      insertIntoComposer: vi.fn(),
    };
    const manager = new PluginManager({ registry, events, storage, api, topics });
    manager.register(createReviewsPlugin({}), { builtin: true });
    await manager.activateAll();

    expect(registry.getEditor('review')).toBeDefined();
    expect(registry.getEditor('review-prefs')).toBeDefined();

    const view = registry.getView('reviews')!.component();
    document.body.appendChild(view.element);
    view.init(undefined, makePanelCtx('reviews'));
    await flush();

    // Pending nav falls back to inline pending section when openEditor throws.
    view.element.querySelector<HTMLElement>('[data-rev-prefs-nav="1"]')!.click();
    expect(view.element.querySelector('.rev-pending')).not.toBeNull();

    // Review row falls back to inline expansion when openEditor throws.
    const row = view.element.querySelector<HTMLElement>('[data-rev="r1"]')!;
    row.click();
    expect(row.getAttribute('aria-expanded')).toBe('true');

    // Direct review detail editor renders applied, refused, archive, and preferences cards.
    const detailEd = registry.getEditor('review')!.component();
    document.body.appendChild(detailEd.element);
    detailEd.init({ id: 'r1', title: 'Deploy notes' }, makePanelCtx('review-r1'));
    await flush();
    expect(detailEd.element.textContent).toContain('deploy-check');
    expect(detailEd.element.textContent).toContain('server-ops');
    expect(detailEd.element.textContent).toContain('old-deploy');
    expect(detailEd.element.textContent).toContain('Lead with conclusion');

    detailEd.dispose();
    view.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('hosts History, Schedules, Reviews, and Skills actions in sidebar title bar with no in-view header/count rows', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const registry = new ContributionRegistry();
    const events = new WebuiEventBus();
    const storage = new StorageService('', makeStorage());
    const api: ApiClient = {
      get: vi.fn(async () => new Response('{}')),
      post: vi.fn(async () => new Response('{}')),
      getJson: vi.fn(async (path: string) => {
        if (path.startsWith('/api/history')) return { enabled: true, sessions: [], next: null };
        if (path.startsWith('/api/schedules')) return { enabled: true, tasks: [] };
        if (path.startsWith('/api/reviews')) return { enabled: true, running: false, pending: [], reviews: [] };
        if (path.startsWith('/api/skills')) return { enabled: true, skills: [], searches: null };
        return {};
      }) as ApiClient['getJson'],
      postJson: vi.fn(async () => ({})) as ApiClient['postJson'],
    };
    const topics: PluginTopicsBridge = {
      list: () => [],
      active: () => undefined,
      open: vi.fn(),
      insertIntoComposer: vi.fn(),
    };
    const manager = new PluginManager({ registry, events, storage, api, topics });
    manager.register(createHistoryPlugin({ doc: document }), { builtin: true });
    manager.register(createSchedulesPlugin({ doc: document }), { builtin: true });
    manager.register(createReviewsPlugin({ doc: document }), { builtin: true });
    manager.register(createSkillsPlugin({ doc: document }), { builtin: true });
    await manager.activateAll();

    const shell = new WorkbenchShell({
      root,
      initialWidth: 1280,
      initialHeight: 800,
      autoSaveLayout: false,
    });
    shell.attachRegistry(registry);
    await flush();

    const actionIds = (): string[] =>
      Array.from(root.querySelectorAll<HTMLElement>('.wb-sidebar-head > .wb-part-actions [data-action-id]')).map(
        (el) => el.dataset.actionId ?? '',
      );

    // Schedules shows Refresh + New in title bar, with no in-view header or count row.
    shell.views.reveal('schedules');
    await flush();
    expect(actionIds()).toEqual(['schedules.refresh', 'schedules.new']);
    expect(root.querySelector('.fh-schedules-header')).toBeNull();
    expect(root.querySelector('.sched-summary')).toBeNull();

    // Switching from Schedules to History leaves ONLY History's Refresh button in the title bar.
    shell.views.reveal('history');
    await flush();
    expect(actionIds()).toEqual(['history.refresh']);
    expect(root.querySelector('.wb-history-header')).toBeNull();
    expect(root.querySelector('.wb-history-refresh')).toBeNull();

    // Reviews shows ONLY Reviews' Refresh button, with no in-view header or count row.
    shell.views.reveal('reviews');
    await flush();
    expect(actionIds()).toEqual(['reviews.refresh']);
    expect(root.querySelector('.fh-reviews-header')).toBeNull();

    // Skills shows Refresh + New in title bar, with no in-view header or count badge.
    shell.views.reveal('skills');
    await flush();
    expect(actionIds()).toEqual(['skills.refresh', 'skills.new']);
    expect(root.querySelector('.fh-skills-view-head')).toBeNull();

    // Works on phone (<640px) drawer too when sidebar is visible.
    shell.layout(360, 740);
    shell.setPartVisible('sidebar', true);
    await flush();
    expect(root.dataset.wbMode).toBe('mobile');
    expect(actionIds()).toEqual(['skills.refresh', 'skills.new']);

    // Hiding the sidebar clears title-bar actions.
    shell.setPartVisible('sidebar', false);
    expect(actionIds()).toEqual([]);

    shell.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
