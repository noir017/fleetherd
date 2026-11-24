import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../services/api.js';
import { StorageService, type StorageLike } from '../services/storage.js';
import type { PanelComponent } from '../workbench/contracts.js';
import { definePlugin } from './api.js';
import {
  BUILTIN_PLUGIN_IDS,
  createBuiltinPlugins,
  isBuiltinPluginId,
  registerBuiltinPlugins,
} from './builtin.js';
import { type PluginErrorRecord, PluginManager } from './host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from './registry.js';

function dummyPanel(): PanelComponent {
  return {
    element: {} as HTMLElement,
    init() {
      // noop
    },
    dispose() {
      // noop
    },
  };
}

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

function makeHarness() {
  const registry = new ContributionRegistry({ openEditor: vi.fn() });
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
  const reportedErrors: PluginErrorRecord[] = [];
  const manager = new PluginManager({
    registry,
    events,
    storage,
    api,
    topics,
    now: () => 1700000000000,
    onError: (rec) => reportedErrors.push(rec),
  });
  return { registry, events, storage, api, topics, reportedErrors, manager };
}

describe('PluginManager', () => {
  it('activates, deactivates, and automatically disposes all plugin contributions', async () => {
    const { registry, events, manager } = makeHarness();
    let deactivated = 0;

    const plugin = definePlugin({
      id: 'sample',
      async activate(ctx) {
        await Promise.resolve();
        ctx.views.register({ id: 'sample.view', title: 'Sample', part: 'sidebar', component: dummyPanel });
        ctx.statusBar.register({ id: 'sample.status', align: 'right', render: () => undefined });
        ctx.commands.register('sample.cmd', () => 'ok');
      },
      deactivate() {
        deactivated++;
      },
    });

    manager.register(plugin);
    expect(manager.getStatus('sample')).toBe('registered');

    const activated = await manager.activateAll();
    expect(activated).toEqual(['sample']);
    expect(manager.getStatus('sample')).toBe('active');
    expect(registry.getView('sample.view')).toBeDefined();
    expect(registry.getStatusBar('sample.status')).toBeDefined();
    expect(await registry.executeCommand('sample.cmd')).toBe('ok');

    manager.deactivate('sample');
    expect(deactivated).toBe(1);
    expect(manager.getStatus('sample')).toBe('deactivated');
    expect(registry.getView('sample.view')).toBeUndefined();
    expect(registry.getStatusBar('sample.status')).toBeUndefined();
    expect(registry.commands.has('sample.cmd')).toBe(false);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('isolates synchronous and asynchronous activate() failures and rolls back partial registrations', async () => {
    const { registry, events, reportedErrors, manager } = makeHarness();
    const emittedErrors: PluginErrorRecord[] = [];
    manager.onDidError((rec) => emittedErrors.push(rec));

    manager.register(
      definePlugin({
        id: 'broken-sync',
        activate(ctx) {
          ctx.views.register({ id: 'broken.v1', title: 'Partial', part: 'sidebar', component: dummyPanel });
          throw new Error('sync boom');
        },
      }),
    );

    manager.register(
      definePlugin({
        id: 'broken-async',
        async activate(ctx) {
          ctx.statusBar.register({ id: 'broken.sb', align: 'left', render: () => undefined });
          await Promise.resolve();
          throw new Error('async boom');
        },
      }),
    );

    manager.register(
      definePlugin({
        id: 'healthy',
        activate(ctx) {
          ctx.views.register({ id: 'healthy.v', title: 'Healthy', part: 'sidebar', component: dummyPanel });
        },
      }),
    );

    const activated = await manager.activateAll();
    expect(activated).toEqual(['healthy']);
    expect(manager.getStatus('broken-sync')).toBe('failed');
    expect(manager.getStatus('broken-async')).toBe('failed');
    expect(manager.getStatus('healthy')).toBe('active');

    // Partial registrations from failed plugins must be rolled back.
    expect(registry.getView('broken.v1')).toBeUndefined();
    expect(registry.getStatusBar('broken.sb')).toBeUndefined();
    expect(registry.getView('healthy.v')).toBeDefined();

    expect(reportedErrors).toHaveLength(2);
    expect(emittedErrors).toHaveLength(2);
    expect(manager.getErrors().map((e) => `${e.pluginId}:${e.phase}:${e.message}`)).toEqual([
      'broken-sync:activate:sync boom',
      'broken-async:activate:async boom',
    ]);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('isolates deactivate() failures while still disposing subscriptions and remaining plugins', async () => {
    const { registry, events, reportedErrors, manager } = makeHarness();
    let otherDeactivated = false;

    manager.register(
      definePlugin({
        id: 'bad-deactivate',
        activate(ctx) {
          ctx.views.register({ id: 'bad.v', title: 'Bad', part: 'sidebar', component: dummyPanel });
        },
        deactivate() {
          throw new Error('cleanup boom');
        },
      }),
    );

    manager.register(
      definePlugin({
        id: 'good-deactivate',
        activate(ctx) {
          ctx.views.register({ id: 'good.v', title: 'Good', part: 'sidebar', component: dummyPanel });
        },
        deactivate() {
          otherDeactivated = true;
        },
      }),
    );

    await manager.activateAll();
    manager.deactivateAll();

    expect(otherDeactivated).toBe(true);
    expect(registry.getView('bad.v')).toBeUndefined();
    expect(registry.getView('good.v')).toBeUndefined();
    expect(reportedErrors).toHaveLength(1);
    expect(reportedErrors[0]).toMatchObject({
      pluginId: 'bad-deactivate',
      phase: 'deactivate',
      message: 'cleanup boom',
    });

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('rejects duplicate plugin registrations and removes contributions when registration handle is disposed', async () => {
    const { registry, events, manager } = makeHarness();
    const handle = manager.register(
      definePlugin({
        id: 'dup',
        activate(ctx) {
          ctx.views.register({ id: 'dup.v', title: 'Dup', part: 'sidebar', component: dummyPanel });
        },
      }),
    );

    expect(() => manager.register(definePlugin({ id: 'dup', activate: () => undefined }))).toThrow(
      /already registered/i,
    );

    await manager.activate('dup');
    expect(registry.getView('dup.v')).toBeDefined();

    handle.dispose();
    expect(manager.has('dup')).toBe(false);
    expect(registry.getView('dup.v')).toBeUndefined();

    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});

describe('builtin plugins manifest', () => {
  it('defines all 12 built-in plugin IDs and supports partial factory overrides', async () => {
    expect(BUILTIN_PLUGIN_IDS).toEqual([
      'topics',
      'topic',
      'history',
      'schedules',
      'reviews',
      'skills',
      'settings',
      'changes',
      'files',
      'terminal',
      'reader',
      'status',
    ]);
    expect(isBuiltinPluginId('topics')).toBe(true);
    expect(isBuiltinPluginId('custom-ext')).toBe(false);

    const { registry, events, manager } = makeHarness();
    const regHandle = registerBuiltinPlugins(manager, {
      topics: () =>
        definePlugin({
          id: 'topics',
          async activate(ctx) {
            ctx.views.register({ id: 'builtin.topics', title: 'Topics', part: 'sidebar', component: dummyPanel });
            // Built-in plugins can call standard /api/ endpoints.
            await ctx.api.post('/api/topics', {});
          },
        }),
    });

    const activated = await manager.activateAll();
    expect(activated).toEqual([...BUILTIN_PLUGIN_IDS]);
    expect(registry.getView('builtin.topics')).toBeDefined();
    expect(manager.list().every((item) => item.builtin && item.status === 'active')).toBe(true);

    expect(() =>
      createBuiltinPlugins({
        topics: () => definePlugin({ id: 'wrong-id', activate: () => undefined }),
      }),
    ).toThrow(/mismatched id/i);

    regHandle.dispose();
    expect(registry.getView('builtin.topics')).toBeUndefined();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
