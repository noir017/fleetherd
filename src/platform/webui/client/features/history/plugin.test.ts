// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../base/event.js';
import { setLocale } from '../../i18n/index.js';
import type { TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import type { HistoryPluginDeps } from './helpers.js';
import { createHistoryPlugin } from './plugin.js';

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
  const setTitle = vi.fn();
  const close = vi.fn();
  return {
    setTitle,
    close,
    ctx: {
      id,
      api: {
        id,
        group: 'editor-1' as const,
        params: undefined,
        onDidVisibilityChange: vis.event,
        onDidDimensionsChange: dim.event,
        setTitle,
        setBadge: vi.fn(),
        focus: vi.fn(),
        close,
      },
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function setupHistoryHarness(
  getRoutes: Record<string, unknown>,
  initialTopics: TopicInfo[] = [],
  extraDeps: Partial<HistoryPluginDeps> = {},
) {
  document.body.innerHTML = '<div id="mount"></div>';
  const doc = document;
  const win = window;

  let topics = initialTopics.slice();
  const openEditor = vi.fn();
  const registry = new ContributionRegistry({ openEditor });
  const events = new WebuiEventBus();
  const storage = new StorageService('', makeMemoryStorage());
  const getJson = vi.fn(async (path: string) => {
    if (path in getRoutes) {
      const val = getRoutes[path];
      if (val instanceof Error) throw val;
      return val;
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  const api: ApiClient = {
    post: vi.fn(async () => new Response('{}')),
    get: vi.fn(async () => new Response('{}')),
    getJson: getJson as ApiClient['getJson'],
    postJson: vi.fn(async () => ({})) as ApiClient['postJson'],
  };
  const openTopic = vi.fn();
  const topicsBridge: PluginTopicsBridge = {
    list: () => topics,
    active: () => topics[0],
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

  const plugin = createHistoryPlugin({
    doc,
    win,
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
    getJson,
    openEditor,
    openTopic,
    manager,
    setTopics(next: TopicInfo[]) {
      topics = next;
      events.emit('topic.list', { topics: next });
    },
    cleanup() {
      manager.dispose();
      events.dispose();
      registry.dispose();
      document.body.innerHTML = '';
    },
  };
}

describe('history built-in plugin', () => {
  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers sidebar view, activity item, read-only editor, and cleans up on deactivate', async () => {
    const h = setupHistoryHarness({
      '/api/history': { enabled: true, sessions: [] },
    });

    await h.manager.activate('history');
    expect(h.manager.getStatus('history')).toBe('active');
    expect(h.registry.getView('history')?.part).toBe('sidebar');
    expect(h.registry.getActivity('history')?.view).toBe('history');
    expect(h.registry.getEditor('history')).toBeDefined();
    expect(h.registry.getEditor('history')!.title({ id: '42', title: 'Design chat' })).toBe('Design chat');
    expect(h.registry.commands.has('history.open')).toBe(true);

    h.manager.deactivate('history');
    expect(h.registry.getView('history')).toBeUndefined();
    expect(h.registry.getActivity('history')).toBeUndefined();
    expect(h.registry.getEditor('history')).toBeUndefined();
    expect(h.registry.commands.has('history.open')).toBe(false);

    h.cleanup();
  });

  it('loads sessions, supports search & filtering, and opens read-only history editor on click', async () => {
    const h = setupHistoryHarness({
      '/api/history': {
        enabled: true,
        sessions: [
          {
            id: 10,
            key: 'web#main#t1',
            title: 'Build pipeline',
            agent: 'alpha',
            platform: 'web',
            lastAt: 1_700_000_000_000,
            messages: 4,
            topic: 't1',
          },
          {
            id: 11,
            key: 'slack#eng#t2',
            title: 'Incident review',
            agent: 'beta',
            platform: 'slack',
            lastAt: 1_700_000_010_000,
            messages: 2,
          },
        ],
        next: 'cursor-2',
      },
      '/api/history/search?q=pipeline': {
        enabled: true,
        hits: [
          {
            session: 10,
            message: 1,
            at: 1_700_000_000_000,
            title: 'Build pipeline',
            agent: 'alpha',
            platform: 'web',
            role: 'assistant',
            excerpt: 'The pipeline finished cleanly.',
          },
        ],
        more: false,
      },
    });

    await h.manager.activate('history');
    const view = h.registry.getView('history')!.component();
    h.doc.getElementById('mount')!.appendChild(view.element);
    view.init(undefined, makePanelInitCtx('history').ctx);
    await flushPromises();

    expect(view.element.querySelectorAll('[data-hist]').length).toBe(2);
    expect(view.element.querySelector<HTMLButtonElement>('.wb-history-more')!.hidden).toBe(false);

    // Search via /api/history/search
    const searchInput = view.element.querySelector<HTMLInputElement>('.wb-history-q')!;
    searchInput.value = 'pipeline';
    view.element.querySelector<HTMLButtonElement>('.wb-history-go')!.click();
    await flushPromises();

    const rows = view.element.querySelectorAll('[data-hist]');
    expect(rows.length).toBe(1);
    expect(view.element.querySelector('.hist-excerpt')?.textContent).toContain('pipeline finished');

    // Click search hit -> opens read-only editor with query preserved
    (rows[0] as HTMLElement).click();
    expect(h.openEditor).toHaveBeenCalledWith(
      'history',
      { id: '10', title: 'Build pipeline', query: 'pipeline' },
      undefined,
    );

    view.dispose();
    h.cleanup();
  });

  it('renders read-only history editor with banner, copy/back/open-topic, search locate, and codeBlocks hook', async () => {
    const codeBlocks = vi.fn();
    const copied: string[] = [];
    const copyText = vi.fn((s: string, done: (ok: boolean) => void) => {
      copied.push(s);
      done(true);
    });

    const h = setupHistoryHarness(
      {
        '/api/history/read?id=10': {
          session: {
            id: 10,
            key: 'web#main#t1',
            title: 'Build pipeline',
            agent: 'alpha',
            platform: 'web',
            lastAt: 1_700_000_000_000,
            messages: 2,
            topic: 't1',
          },
          messages: [
            { id: 'm1', own: true, html: '<p>Check the pipeline status</p>', at: 1_700_000_000_000, buttons: [] },
            {
              id: 'm2',
              own: false,
              html: '<p>The pipeline passed</p><pre><code>echo ok</code></pre>',
              at: 1_700_000_005_000,
              buttons: [],
            },
          ],
          note: 'Showing latest 2 messages.',
        },
      },
      [{ id: 't1', title: 'Build pipeline', lastAt: 1_700_000_000_000 }],
      { codeBlocks, copyText },
    );

    await h.manager.activate('history');
    const editor = h.registry.getEditor('history')!.component();
    h.doc.getElementById('mount')!.appendChild(editor.element);
    const panel = makePanelInitCtx('history:10');
    editor.init({ id: '10', title: 'Build pipeline', query: 'pipeline' }, panel.ctx);
    await flushPromises();

    expect(panel.setTitle).toHaveBeenCalledWith('Build pipeline');
    expect(codeBlocks).toHaveBeenCalledTimes(1);
    expect(editor.element.querySelector('.wb-history-note')?.textContent).toContain('Showing latest 2 messages.');

    // Initial query highlighted both occurrences of "pipeline"
    const marks = editor.element.querySelectorAll('mark.wb-history-mark');
    expect(marks.length).toBe(2);
    expect(editor.element.querySelector('.wb-history-find-count')?.textContent).toBe('1 / 2');

    // Navigate to next match
    editor.element.querySelector<HTMLButtonElement>('.wb-history-find-next')!.click();
    expect(editor.element.querySelector('.wb-history-find-count')?.textContent).toBe('2 / 2');

    // Copy reference button
    editor.element.querySelector<HTMLButtonElement>('[data-action-id="copy-ref"]')!.click();
    expect(copied).toEqual(['Build pipeline (#10)']);

    // Open topic button works while topic exists
    const openBtn = editor.element.querySelector<HTMLButtonElement>('[data-action-id="open-topic"]')!;
    expect(openBtn).not.toBeNull();
    openBtn.click();
    expect(h.openTopic).toHaveBeenCalledWith('t1');

    // When topic is removed via topic.list event, open-topic disappears and read-only message updates
    h.setTopics([]);
    expect(editor.element.querySelector('[data-action-id="open-topic"]')).toBeNull();
    expect(editor.element.querySelector('.wb-history-ro-bar')?.textContent).toContain('cleared from this page');

    // Back button closes panel
    editor.element.querySelector<HTMLButtonElement>('[data-action-id="back"]')!.click();
    expect(panel.close).toHaveBeenCalledTimes(1);

    // Locale change updates editor labels
    setLocale('zh-CN');
    h.events.emit('locale.change', { locale: 'zh-CN' });
    expect(editor.element.querySelector<HTMLInputElement>('.wb-history-find-input')!.placeholder).toBe('搜索');

    editor.dispose();
    h.cleanup();
  });
});
