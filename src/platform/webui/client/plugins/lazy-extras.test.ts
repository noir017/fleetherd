// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../services/api.js';
import { CommandRegistry } from '../services/commands.js';
import { KeybindingService } from '../services/keybindings.js';
import { StorageService, type StorageLike } from '../services/storage.js';
import type { PanelComponent, PanelInitContext } from '../workbench/contracts.js';
import { definePlugin, type WebuiPlugin } from './api.js';
import { PluginManager } from './host.js';
import {
  createExtrasLoader,
  createLazyHistoryPlugin,
  createLazyPalettePlugin,
  createLazySettingsPlugin,
  type WorkbenchExtrasModule,
} from './lazy-extras.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from './registry.js';

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

function makePanelInitCtx(): PanelInitContext {
  return {
    id: 'test-panel',
    api: {
      id: 'test-panel',
      group: 'sidebar',
      params: undefined,
      onDidVisibilityChange: () => ({ dispose() {} }),
      onDidDimensionsChange: () => ({ dispose() {} }),
      setTitle: vi.fn(),
      setBadge: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    },
  };
}

function makeHarness() {
  const commands = new CommandRegistry();
  const keybindings = new KeybindingService({
    executeCommand: (id, ...a) => commands.execute(id, ...a),
  });
  const registry = new ContributionRegistry({ commands, keybindings, openEditor: vi.fn() });
  const events = new WebuiEventBus();
  const storage = new StorageService('', makeMemoryStorage());
  const api: ApiClient = {
    post: vi.fn(async () => new Response('{}')),
    get: vi.fn(async () => new Response('{}')),
    async getJson<T>(): Promise<T> {
      return {} as T;
    },
    async postJson<T>(): Promise<T> {
      return {} as T;
    },
  };
  const topics: PluginTopicsBridge = {
    list: () => [],
    active: () => undefined,
    open: vi.fn(),
    insertIntoComposer: vi.fn(),
  };
  const manager = new PluginManager({ registry, events, storage, api, topics });
  return { commands, keybindings, registry, events, storage, manager };
}

function dummyExtras(overrides: Partial<WorkbenchExtrasModule> = {}): WorkbenchExtrasModule {
  const noop = (id: string): WebuiPlugin => definePlugin({ id, activate() {} });
  return {
    createChangesPlugin: () => noop('changes'),
    createFilesPlugin: () => noop('files'),
    createHistoryPlugin: () => noop('history'),
    createPalettePlugin: () => noop('palette'),
    createReviewsPlugin: () => noop('reviews'),
    createSchedulesPlugin: () => noop('schedules'),
    createSettingsPlugin: () => noop('settings'),
    createSkillsPlugin: () => noop('skills'),
    ...overrides,
  };
}

describe('lazy-extras', () => {
  it('returns null gracefully when bundleUrl is null (jsdom without asset server)', async () => {
    const loader = createExtrasLoader({ bundleUrl: null });
    expect(await loader()).toBeNull();
  });

  it('deduplicates concurrent imports and syncs locale on load', async () => {
    const initLocale = vi.fn();
    const setLocale = vi.fn();
    const importModule = vi.fn(async () => dummyExtras({ initLocale, setLocale }));
    const loader = createExtrasLoader({
      bundleUrl: 'assets/workbench-extras-test.js',
      importModule,
      doc: document,
    });

    const [a, b] = await Promise.all([loader(), loader()]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(initLocale).toHaveBeenCalledTimes(1);
    expect(setLocale).toHaveBeenCalledTimes(1);
  });

  it('registers palette commands & allowInInput keybindings eagerly and loads real plugin on first trigger', async () => {
    const { commands, keybindings, registry, events, manager } = makeHarness();
    const quickOpenSpy = vi.fn();
    const importModule = vi.fn(async () =>
      dummyExtras({
        createPalettePlugin: (deps) =>
          definePlugin({
            id: 'palette',
            activate(ctx) {
              // Keybindings must be stripped so allowInInput shortcuts are not double-registered.
              expect(deps?.keybindings).toBeUndefined();
              ctx.commands.register('palette.quickOpenTopic', quickOpenSpy);
            },
          }),
      }),
    );
    const loader = createExtrasLoader({
      bundleUrl: 'assets/workbench-extras-test.js',
      importModule,
      doc: document,
    });

    manager.register(createLazyPalettePlugin(loader, { commands, keybindings }), { builtin: true });
    await manager.activateAll();

    // Commands & shortcuts are visible immediately before extras chunk is loaded.
    expect(commands.has('palette.quickOpenTopic')).toBe(true);
    expect(commands.has('palette.commands')).toBe(true);
    expect(commands.has('palette.keybindings')).toBe(true);
    expect(importModule).not.toHaveBeenCalled();

    // First command execution loads the chunk and delegates to the real handler.
    await commands.execute('palette.quickOpenTopic');
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(quickOpenSpy).toHaveBeenCalledTimes(1);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('hydrates lazy view component on first init without re-registering view/activity', async () => {
    const { registry, events, manager } = makeHarness();
    const realInit = vi.fn();
    const importModule = vi.fn(async () =>
      dummyExtras({
        createHistoryPlugin: () =>
          definePlugin({
            id: 'history',
            activate(ctx) {
              ctx.activity.register({ id: 'history', title: 'History', icon: 'history', view: 'history', order: 20 });
              ctx.views.register({
                id: 'history',
                title: 'History',
                icon: 'history',
                part: 'sidebar',
                component: (): PanelComponent => {
                  const el = document.createElement('div');
                  el.className = 'real-history-view';
                  return { element: el, init: realInit, dispose() {} };
                },
              });
            },
          }),
      }),
    );
    const loader = createExtrasLoader({
      bundleUrl: 'assets/workbench-extras-test.js',
      importModule,
      doc: document,
    });

    manager.register(createLazyHistoryPlugin(loader), { builtin: true });
    await manager.activateAll();

    expect(registry.getActivity('history')).toBeDefined();
    expect(importModule).not.toHaveBeenCalled();

    const view = registry.getView('history');
    expect(view).toBeDefined();
    const panel = view!.component();
    panel.init({ from: 'test' }, makePanelInitCtx());

    await vi.waitFor(() => {
      expect(panel.element.querySelector('.real-history-view')).not.toBeNull();
    });
    expect(realInit).toHaveBeenCalledTimes(1);

    panel.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('buffers incoming settings messages until the lazy settings plugin activates', async () => {
    const { registry, events, manager } = makeHarness();
    const received: unknown[] = [];
    const importModule = vi.fn(async () =>
      dummyExtras({
        createSettingsPlugin: (deps) =>
          definePlugin({
            id: 'settings',
            activate() {
              deps.onReady?.({
                handleMessage(msg) {
                  received.push(msg);
                  return true;
                },
                refresh() {},
                getMessage: () => null,
              });
            },
          }),
      }),
    );
    const loader = createExtrasLoader({
      bundleUrl: 'assets/workbench-extras-test.js',
      importModule,
      doc: document,
    });

    let bridge: { handleMessage(m: unknown): boolean } | null = null;
    manager.register(
      createLazySettingsPlugin(loader, {
        instrOk: false,
        listDeviceSections: () => [],
        onReady: (b) => {
          bridge = b;
        },
      }),
      { builtin: true },
    );
    await manager.activateAll();

    expect(bridge).not.toBeNull();
    const fakeSettingsMsg = { id: 'm1', settings: { level: 'list', rows: [] } };
    expect(bridge!.handleMessage(fakeSettingsMsg)).toBe(true);

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toBe(fakeSettingsMsg);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
