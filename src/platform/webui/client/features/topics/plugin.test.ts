// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../base/event.js';
import { setLocale } from '../../i18n/index.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import { createTopicsPlugin, type TopicsPluginDeps } from './plugin.js';
import type { Topic } from './types.js';

function makeTopic(overrides: Partial<Topic> & { id: string }): Topic {
  return {
    title: 'Sample topic',
    lastAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeMemoryStorage(): StorageLike {
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

function makePanelInitCtx(id: string) {
  const vis = new Emitter<boolean>();
  const dim = new Emitter<{ readonly width: number; readonly height: number }>();
  return {
    id,
    api: {
      id,
      group: 'sidebar' as const,
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

function setupHarness(initialTopics: Topic[], activeId = '', extraDeps: Partial<TopicsPluginDeps> = {}) {
  document.body.innerHTML = '<div id="mount"></div>';
  const doc = document;
  const win = window;

  let topics = initialTopics.slice();
  let currentActiveId = activeId;

  const registry = new ContributionRegistry({ openEditor: vi.fn() });
  const events = new WebuiEventBus();
  const storage = new StorageService('', makeMemoryStorage());
  const postJson = vi.fn(async () => ({}));
  const getJson = vi.fn(async () => ({}));
  const api: ApiClient = {
    post: vi.fn(async () => new Response('{}')),
    get: vi.fn(async () => new Response('{}')),
    getJson: getJson as ApiClient['getJson'],
    postJson: postJson as ApiClient['postJson'],
  };
  const openTopic = vi.fn((id: string) => {
    currentActiveId = id;
  });
  const topicsBridge: PluginTopicsBridge = {
    list: () => topics,
    active: () => topics.find((t) => t.id === currentActiveId),
    open: openTopic,
    insertIntoComposer: vi.fn(),
  };

  const manager = new PluginManager({
    registry,
    events,
    storage,
    api,
    topics: topicsBridge,
  });

  const plugin = createTopicsPlugin({
    doc,
    win,
    registry,
    now: () => 1_700_000_060_000,
    confirmFn: () => true,
    alertFn: vi.fn(),
    ...extraDeps,
  });

  manager.register(plugin, { builtin: true });

  return {
    doc,
    win,
    registry,
    events,
    storage,
    api,
    postJson,
    openTopic,
    manager,
    setTopics(next: Topic[]) {
      topics = next;
      events.emit('topic.list', { topics: next });
    },
    setActive(id: string | undefined) {
      currentActiveId = id ?? '';
      events.emit('topic.active', { id, topic: topics.find((t) => t.id === id) });
    },
    cleanup() {
      manager.dispose();
      events.dispose();
      registry.dispose();
      document.body.innerHTML = '';
    },
  };
}

describe('topics built-in plugin', () => {
  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('activates, registers view/activity/commands/menus, and cleans up on deactivate', async () => {
    const t1 = makeTopic({ id: 't1', title: 'Alpha', stage: 'answer', asking: true });
    const t2 = makeTopic({ id: 't2', title: 'Beta', live: true });
    const h = setupHarness([t1, t2], 't2');

    await h.manager.activate('topics');
    expect(h.manager.getStatus('topics')).toBe('active');

    const view = h.registry.getView('topics');
    expect(view?.part).toBe('sidebar');

    const activity = h.registry.getActivity('topics');
    expect(activity?.view).toBe('topics');
    expect(h.registry.getActivityBadge('topics')).toBe(1);

    expect(h.registry.commands.has('topics.new')).toBe(true);
    expect(h.registry.commands.has('topics.markAllRead')).toBe(true);
    expect(h.registry.commands.has('topics.clearUnstarred')).toBe(true);

    const rowMenus = h.registry.listMenuItems('topic.row', t1);
    expect(rowMenus.map((m) => m.id)).toEqual([
      'topics.star',
      'topics.copyRef',
      'topics.fork',
      'topics.openInNewTab',
      'topics.endAgent',
      'topics.delete',
    ]);

    h.manager.deactivate('topics');
    expect(h.registry.getView('topics')).toBeUndefined();
    expect(h.registry.getActivity('topics')).toBeUndefined();
    expect(h.registry.commands.has('topics.new')).toBe(false);
    expect(h.registry.listMenuItems('topic.row', t1)).toEqual([]);

    h.cleanup();
  });

  it('switches between All and Starred segments, folds subtopics, filters, and opens topics', async () => {
    const parent = makeTopic({ id: 'p1', title: 'Parent task', live: true });
    const child = makeTopic({ id: 'c1', title: 'Subtask', parent: 'p1', live: true });
    const starred = makeTopic({ id: 's1', title: 'Starred note', starred: true });
    const h = setupHarness([parent, child, starred], 'p1');

    await h.manager.activate('topics');
    const view = h.registry.getView('topics')!.component();
    h.doc.getElementById('mount')!.appendChild(view.element);
    view.init(undefined, makePanelInitCtx('topics'));

    // Parent is expanded because active topic is p1? Wait: child is under p1, default folded unless child is active.
    expect(view.element.querySelector('[data-topic="p1"]')).not.toBeNull();
    expect(view.element.querySelector('[data-topic="c1"]')).toBeNull();
    // Unfold p1
    const foldBtn = view.element.querySelector<HTMLButtonElement>('[data-fold="p1"]')!;
    foldBtn.click();
    expect(view.element.querySelector('[data-topic="c1"]')).not.toBeNull();

    // Switch to Starred segment
    const starredSeg = view.element.querySelector<HTMLButtonElement>('[data-seg-value="starred"]')!;
    starredSeg.click();
    expect(view.element.querySelector('[data-topic="s1"]')).not.toBeNull();
    expect(view.element.querySelector('[data-topic="p1"]')).toBeNull();
    expect(view.element.querySelector('[data-action-id="topics.clearUnstarred"]')).toBeNull();

    // Click row to open topic
    view.element.querySelector<HTMLElement>('[data-topic="s1"]')!.click();
    expect(h.openTopic).toHaveBeenCalledWith('s1');

    // Switch back to All segment and filter via filterbar
    view.element.querySelector<HTMLButtonElement>('[data-seg-value="topics"]')!.click();
    const searchInput = view.element.querySelector<HTMLInputElement>('.fh-fb-q')!;
    searchInput.value = 'no-such-topic';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.element.querySelector('.topics-empty')).not.toBeNull();
    view.element.querySelector<HTMLButtonElement>('[data-filter-clear]')!.click();
    expect(view.element.querySelector('[data-topic="p1"]')).not.toBeNull();

    view.dispose();
    h.cleanup();
  });

  it('builds topic.row menu dynamically via ContributionRegistry when/disabled and executes actions', async () => {
    const onStarTopic = vi.fn();
    const onForkTopic = vi.fn();
    const onEndTopic = vi.fn();
    const onDeleteTopic = vi.fn();

    const busyStarred = makeTopic({
      id: 't-busy',
      title: 'Busy starred',
      starred: true,
      running: true,
      live: true,
    });
    const noForkIdle = makeTopic({
      id: 't-nofork',
      title: 'No fork',
      live: false,
      agent: { id: 'worker', harness: 'codex', canFork: false },
    });

    const h = setupHarness([busyStarred, noForkIdle], '', {
      onStarTopic,
      onForkTopic,
      onEndTopic,
      onDeleteTopic,
    });

    await h.manager.activate('topics');
    const view = h.registry.getView('topics')!.component();
    h.doc.getElementById('mount')!.appendChild(view.element);
    view.init(undefined, makePanelInitCtx('topics'));

    // Open menu on busyStarred
    const moreBtn = view.element.querySelector<HTMLButtonElement>('[data-rm="topic:t-busy"]')!;
    moreBtn.click();

    const menuEl = h.doc.querySelector<HTMLElement>('.wb-topic-row-menu')!;
    expect(menuEl.hidden).toBe(false);
    expect(menuEl.querySelector('[data-menu-id="topics.unstar"]')).not.toBeNull();
    expect(menuEl.querySelector('[data-menu-id="topics.star"]')).toBeNull();
    const forkBtn = menuEl.querySelector<HTMLButtonElement>('[data-menu-id="topics.fork"]')!;
    expect(forkBtn.disabled).toBe(true);

    // Click Unstar
    menuEl.querySelector<HTMLButtonElement>('[data-menu-id="topics.unstar"]')!.click();
    expect(onStarTopic).toHaveBeenCalledWith('t-busy', false);

    // Verify menu groups for noForkIdle (hides fork, disables endAgent)
    const groups = h.registry.listMenuGroups('topic.row', noForkIdle);
    const flat = groups.flat();
    expect(flat.some((r) => r.item.id === 'topics.fork')).toBe(false);
    const endEntry = flat.find((r) => r.item.id === 'topics.endAgent');
    expect(endEntry?.disabled).toBe(true);
    expect(endEntry?.disabledReason).toBeTruthy();

    // Execute delete directly via menu contribution
    const delEntry = flat.find((r) => r.item.id === 'topics.delete')!;
    await delEntry.item.run(noForkIdle);
    expect(onDeleteTopic).toHaveBeenCalledWith('t-nofork');

    view.dispose();
    h.cleanup();
  });

  it('responds to topic.list, topic.active, locale.change events and executes commands', async () => {
    const onCreateTopic = vi.fn();
    const onMarkAllRead = vi.fn();
    const onClearUnstarred = vi.fn();
    const t1 = makeTopic({ id: 't1', title: 'First', stage: 'answer', asking: true });
    const h = setupHarness([t1], '', { onCreateTopic, onMarkAllRead, onClearUnstarred });

    const badgeListener = vi.fn();
    h.registry.onDidChangeActivityBadges(badgeListener);

    await h.manager.activate('topics');
    const view = h.registry.getView('topics')!.component();
    h.doc.getElementById('mount')!.appendChild(view.element);
    view.init(undefined, makePanelInitCtx('topics'));

    expect(h.registry.getActivityBadge('topics')).toBe(1);

    // Selecting t1 clears its needsYou badge
    h.setActive('t1');
    expect(h.registry.getActivityBadge('topics')).toBeNull();
    expect(badgeListener).toHaveBeenCalled();

    // Adding a new topic via topic.list event re-renders the view
    const t2 = makeTopic({ id: 't2', title: 'Second', stage: 'failed' });
    h.setTopics([t1, t2]);
    expect(view.element.querySelector('[data-topic="t2"]')).not.toBeNull();
    expect(h.registry.getActivityBadge('topics')).toBe(1);

    // Locale change updates placeholders and menu labels
    setLocale('zh-CN');
    h.events.emit('locale.change', { locale: 'zh-CN' });
    const searchInput = view.element.querySelector<HTMLInputElement>('.fh-fb-q')!;
    expect(searchInput.placeholder).toBe('搜索话题');

    // Commands
    await h.registry.executeCommand('topics.new');
    await h.registry.executeCommand('topics.markAllRead');
    await h.registry.executeCommand('topics.clearUnstarred');
    expect(onCreateTopic).toHaveBeenCalledTimes(1);
    expect(onMarkAllRead).toHaveBeenCalledTimes(1);
    expect(onClearUnstarred).toHaveBeenCalledTimes(1);

    view.dispose();
    h.cleanup();
  });

  it('supports unified keyboard navigation, range multi-select, and batch star/end/delete', async () => {
    const onStarTopic = vi.fn();
    const onEndTopic = vi.fn();
    const onDeleteTopic = vi.fn();
    const t1 = makeTopic({ id: 't1', title: 'Alpha', live: true, starred: false });
    const t2 = makeTopic({ id: 't2', title: 'Beta', live: false, starred: false });
    const t3 = makeTopic({ id: 't3', title: 'Gamma', live: true, starred: false });
    const h = setupHarness([t1, t2, t3], '', { onStarTopic, onEndTopic, onDeleteTopic });

    await h.manager.activate('topics');
    const view = h.registry.getView('topics')!.component();
    h.doc.getElementById('mount')!.appendChild(view.element);
    view.init(undefined, makePanelInitCtx('topics'));

    const rows = Array.from(view.element.querySelectorAll<HTMLElement>('[data-topic]'));
    expect(rows.length).toBe(3);

    // Keyboard navigation: ArrowDown / End / Home
    rows[0]!.focus();
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(h.doc.activeElement).toBe(rows[1]);
    rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(h.doc.activeElement).toBe(rows[2]);
    rows[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(h.doc.activeElement).toBe(rows[0]);

    // Space selects first row, Shift+Click third row selects all 3
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    rows[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(view.element.querySelector('.fh-list-batch-count')?.textContent).toBe('3 selected');

    // Batch Star stars all 3 unstarred topics
    view.element.querySelector<HTMLButtonElement>('[data-batch-action="star"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(onStarTopic).toHaveBeenCalledTimes(3);
    expect(onStarTopic).toHaveBeenCalledWith('t1', true);
    expect(onStarTopic).toHaveBeenCalledWith('t2', true);
    expect(onStarTopic).toHaveBeenCalledWith('t3', true);

    // Mod+A selects all again; Batch End ends only live topics (t1, t3)
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    view.element.querySelector<HTMLButtonElement>('[data-batch-action="end"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(onEndTopic).toHaveBeenCalledTimes(2);
    expect(onEndTopic).toHaveBeenCalledWith('t1');
    expect(onEndTopic).toHaveBeenCalledWith('t3');

    // Select all and Batch Delete
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    view.element.querySelector<HTMLButtonElement>('[data-batch-action="delete"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(onDeleteTopic).toHaveBeenCalledTimes(3);

    // Select then Escape clears selection
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(view.element.querySelector('.fh-list-batch')).not.toBeNull();
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.element.querySelector('.fh-list-batch')).toBeNull();

    view.dispose();
    h.cleanup();
  });

  it('patches only changed topic rows in place and defers paints while hidden', async () => {
    const topics: Topic[] = [
      makeTopic({ id: 't1', title: 'Alpha', lastAt: 300, msgCount: 2, live: true }),
      makeTopic({ id: 't2', title: 'Beta', lastAt: 200, msgCount: 1 }),
      makeTopic({ id: 't3', title: 'Gamma', lastAt: 100, msgCount: 1 }),
    ];
    const h = setupHarness(topics, 't1');
    await h.manager.activate('topics');

    const view = h.registry.getView('topics')!.component();
    h.doc.getElementById('mount')!.appendChild(view.element);
    const visListeners: Array<(visible: boolean) => void> = [];
    const baseCtx = makePanelInitCtx('topics');
    const panelCtx = {
      ...baseCtx,
      api: {
        ...baseCtx.api,
        isVisible: true,
        onDidVisibilityChange: (cb: (visible: boolean) => void) => {
          visListeners.push(cb);
          return { dispose() {} };
        },
      },
    };
    view.init(undefined, panelCtx);

    const row1Before = view.element.querySelector('[data-topic="t1"]')!;
    const row2Before = view.element.querySelector('[data-topic="t2"]')!;
    const row3Before = view.element.querySelector('[data-topic="t3"]')!;

    h.setTopics([topics[0]!, { ...topics[1]!, title: 'Beta updated' }, topics[2]!]);

    expect(view.element.querySelector('[data-topic="t1"]')).toBe(row1Before);
    expect(view.element.querySelector('[data-topic="t3"]')).toBe(row3Before);
    expect(view.element.querySelector('[data-topic="t2"]')).not.toBe(row2Before);
    expect(view.element.querySelector('[data-topic="t2"]')?.textContent).toContain('Beta updated');

    for (const cb of visListeners) cb(false);
    h.setTopics([topics[0]!, { ...topics[1]!, title: 'Beta updated' }, { ...topics[2]!, title: 'Gamma deferred' }]);
    expect(view.element.querySelector('[data-topic="t3"]')?.textContent).not.toContain('Gamma deferred');

    for (const cb of visListeners) cb(true);
    expect(view.element.querySelector('[data-topic="t3"]')?.textContent).toContain('Gamma deferred');

    view.dispose();
    h.cleanup();
  });
});
