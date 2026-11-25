// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../base/event.js';
import { setLocale } from '../../i18n/index.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { OverlayManager } from '../../services/overlays.js';
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

function setupWorkbenchTopics(
  initialTopics: Topic[],
  activeId = '',
  opts: { mobile?: boolean; extraDeps?: Partial<TopicsPluginDeps> } = {},
) {
  document.body.innerHTML = `<div class="wb-root" data-wb-mode="${opts.mobile ? 'mobile' : 'desktop'}"><div id="mount"></div></div>`;
  const openEditor = vi.fn();
  const registry = new ContributionRegistry({ openEditor });
  registry.registerEditor({
    kind: 'topic',
    title: () => 'Topic',
    component: () => ({ element: document.createElement('div'), init: () => {}, dispose: () => {} }),
  });
  const events = new WebuiEventBus();
  const overlays = new OverlayManager();
  overlays.attach(document);
  const storage = new StorageService('', makeMemoryStorage());
  const api: ApiClient = {
    post: vi.fn(async () => new Response('{}')),
    get: vi.fn(async () => new Response('{}')),
    getJson: vi.fn(async () => ({})) as ApiClient['getJson'],
    postJson: vi.fn(async () => ({})) as ApiClient['postJson'],
  };
  const openTopic = vi.fn();
  const topicsBridge: PluginTopicsBridge = {
    list: () => initialTopics,
    active: () => initialTopics.find((t) => t.id === activeId),
    open: openTopic,
    insertIntoComposer: vi.fn(),
  };

  const manager = new PluginManager({ registry, events, storage, api, topics: topicsBridge });
  const plugin = createTopicsPlugin({
    doc: document,
    win: window,
    registry,
    overlays,
    now: () => 1_700_000_060_000,
    ...opts.extraDeps,
  });
  manager.register(plugin, { builtin: true });

  return {
    registry,
    overlays,
    openEditor,
    openTopic,
    manager,
    mountView: async () => {
      await manager.activate('topics');
      const view = registry.getView('topics')!.component();
      document.getElementById('mount')!.appendChild(view.element);
      view.init(undefined, makePanelInitCtx('topics'));
      return view;
    },
    cleanup() {
      overlays.dispose();
      manager.dispose();
      events.dispose();
      registry.dispose();
      document.body.innerHTML = '';
    },
  };
}

describe('wb2 topics alignment', () => {
  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders group headers (Needs you, New, Running, Starred, Idle) and inline harness pills', async () => {
    const tNeeds = makeTopic({
      id: 'n1',
      title: 'Deploy notes',
      stage: 'answer',
      asking: true,
      line: 'Confirm 2 sub-tasks',
      agent: { id: 'claude', harness: 'claude' },
    });
    const tNew = makeTopic({ id: 'u1', title: '' });
    const tRun = makeTopic({
      id: 'r1',
      title: 'Refactor panels',
      running: true,
      live: true,
      agent: { id: 'codex', harness: 'codex' },
    });
    const tStar = makeTopic({ id: 's1', title: 'Pinned work', live: true, starred: true });
    const tIdle = makeTopic({ id: 'i1', title: 'Old PR', live: false });

    const h = setupWorkbenchTopics([tNeeds, tNew, tRun, tStar, tIdle], '');
    const view = await h.mountView();

    const groups = Array.from(view.element.querySelectorAll('.wb-topics-grp')).map((el) => el.textContent);
    expect(groups).toEqual(['Needs you', 'New', 'Running', 'Starred', 'Idle']);

    const needsRow = view.element.querySelector('[data-topic="n1"]')!;
    expect(needsRow.querySelector('.topic-hc.h-claude')?.textContent).toBe('claude');
    expect(needsRow.textContent).toContain('Confirm 2 sub-tasks');

    const newRow = view.element.querySelector('[data-topic="u1"]')!;
    expect(newRow.classList.contains('is-untitled')).toBe(true);
    expect(newRow.textContent).toContain('New topic');
    expect(newRow.textContent).toContain('Choose an agent');

    const runRow = view.element.querySelector('[data-topic="r1"]')!;
    expect(runRow.querySelector('.topic-hc.h-codex')?.textContent).toBe('codex');

    view.dispose();
    h.cleanup();
  });

  it('renders row menu in 3 separated groups with Open in new tab shortcut and dynamic sub-agent end label', async () => {
    const parent = makeTopic({ id: 'p1', title: 'Parent', live: true });
    const child = makeTopic({ id: 'c1', title: 'Child', parent: 'p1', live: true });
    const h = setupWorkbenchTopics([parent, child], '');
    const view = await h.mountView();

    view.element.querySelector<HTMLButtonElement>('[data-rm="topic:p1"]')!.click();
    const menuEl = document.querySelector<HTMLElement>('.wb-topic-row-menu')!;
    expect(menuEl.hidden).toBe(false);

    const seps = menuEl.querySelectorAll('.fh-menu-sep');
    expect(seps.length).toBe(2);

    const openTab = menuEl.querySelector<HTMLButtonElement>('[data-menu-id="topics.openInNewTab"]')!;
    expect(openTab).not.toBeNull();
    expect(openTab.querySelector('.fh-menu-kbd')?.textContent).toBe('Ctrl');

    const endBtn = menuEl.querySelector<HTMLButtonElement>('[data-menu-id="topics.endAgent"]')!;
    expect(endBtn.textContent).toContain('1 sub-agent');

    openTab.click();
    expect(h.openEditor).toHaveBeenCalledWith('topic', { topicId: 'p1' }, { preview: false });

    view.dispose();
    h.cleanup();
  });

  it('uses openConfirmDialog for delete with mockup copy and respects Cancel vs Confirm', async () => {
    const onDeleteTopic = vi.fn();
    const t = makeTopic({ id: 't1', title: 'Slow cart API', starred: false });
    const h = setupWorkbenchTopics([t], '', { extraDeps: { onDeleteTopic } });
    const view = await h.mountView();

    view.element.querySelector<HTMLButtonElement>('[data-rm="topic:t1"]')!.click();
    document.querySelector<HTMLButtonElement>('.wb-topic-row-menu [data-menu-id="topics.delete"]')!.click();

    const dlg = document.querySelector<HTMLElement>('.wb-topic-confirm-dialog .fh-dialog')!;
    expect(dlg).not.toBeNull();
    expect(dlg.querySelector('.fh-dialog-title')?.textContent).toBe('Delete topic "Slow cart API"?');
    expect(dlg.querySelector('.fh-dialog-body')?.textContent).toContain('History');

    dlg.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(onDeleteTopic).not.toHaveBeenCalled();

    view.element.querySelector<HTMLButtonElement>('[data-rm="topic:t1"]')!.click();
    document.querySelector<HTMLButtonElement>('.wb-topic-row-menu [data-menu-id="topics.delete"]')!.click();
    document
      .querySelector<HTMLButtonElement>('.wb-topic-confirm-dialog [data-dialog-action="confirm"]')!
      .click();
    await new Promise((r) => setTimeout(r, 0));
    expect(onDeleteTopic).toHaveBeenCalledWith('t1');

    view.dispose();
    h.cleanup();
  });

  it('supports mobile left-swipe actions and long-press bottom sheet (?m#sheet-row)', async () => {
    vi.useFakeTimers();
    const onStarTopic = vi.fn();
    const t = makeTopic({
      id: 'm1',
      title: 'Mobile topic',
      agent: { id: 'claude', harness: 'claude' },
      dir: { name: 'shop-api', path: '/work/shop-api' },
      running: true,
      live: true,
    });
    const h = setupWorkbenchTopics([t], '', { mobile: true, extraDeps: { onStarTopic } });
    const view = await h.mountView();

    const row = view.element.querySelector<HTMLElement>('[data-topic="m1"]')!;
    const wrap = row.closest<HTMLElement>('.wb-topic-swipe-wrap')!;

    // Left-swipe reveals swipe actions
    const PointerEv = typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
    row.dispatchEvent(new PointerEv('pointerdown', { bubbles: true, clientX: 300, clientY: 100 }));
    document.dispatchEvent(new PointerEv('pointermove', { bubbles: true, clientX: 140, clientY: 102 }));
    document.dispatchEvent(new PointerEv('pointerup', { bubbles: true, clientX: 140, clientY: 102 }));
    expect(wrap.classList.contains('is-swiped')).toBe(true);

    // Clicking Star swipe action stars the topic and closes swipe
    wrap.querySelector<HTMLButtonElement>('[data-swipe-act="star"]')!.click();
    expect(onStarTopic).toHaveBeenCalledWith('m1', true);
    expect(wrap.classList.contains('is-swiped')).toBe(false);

    // Long-press opens bottom action sheet without Open in new tab
    row.dispatchEvent(new PointerEv('pointerdown', { bubbles: true, clientX: 120, clientY: 100 }));
    vi.advanceTimersByTime(520);
    document.dispatchEvent(new PointerEv('pointerup', { bubbles: true, clientX: 120, clientY: 100 }));

    const sheet = document.querySelector<HTMLElement>('.wb-topic-sheet')!;
    expect(sheet).not.toBeNull();
    expect(sheet.querySelector('.wb-topic-sheet-title')?.textContent).toBe('Mobile topic');
    expect(sheet.querySelector('.wb-topic-sheet-sub')?.textContent).toContain('claude');
    expect(sheet.querySelector('[data-sheet-id="topics.openInNewTab"]')).toBeNull();
    expect(sheet.querySelector('[data-sheet-id="topics.delete"]')).not.toBeNull();

    sheet.querySelector<HTMLButtonElement>('[data-sheet-cancel]')!.click();
    expect(document.querySelector('.wb-topic-sheet')).toBeNull();

    view.dispose();
    h.cleanup();
  });
});
