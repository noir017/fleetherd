import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../services/api.js';
import { StorageService, type StorageLike } from '../services/storage.js';
import type { PanelComponent } from '../workbench/contracts.js';
import { definePlugin, type PluginContext } from './api.js';
import { PluginManager } from './host.js';
import {
  ExternalPluginLoader,
  extractWebuiPlugin,
  loadExternalPlugins,
  type BootPluginEntry,
  type PluginLoadFailure,
  resolvePluginAssetUrl,
} from './loader.js';
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

function makeDocument(plugins: readonly BootPluginEntry[] = []): Document {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><script type="application/json" id="boot-config">${JSON.stringify({
      instance: 'web',
      plugins,
    })}</script></body></html>`,
    { url: 'http://localhost:3000/' },
  );
  return dom.window.document;
}

function makeHarness() {
  const registry = new ContributionRegistry({ openEditor: vi.fn() });
  const events = new WebuiEventBus();
  const storage = new StorageService('', makeMemoryStorage());
  const apiCalls: string[] = [];
  const api: ApiClient = {
    post: vi.fn(async () => new Response('{}')),
    get: vi.fn(async () => new Response('{}')),
    async getJson<T>(path: string): Promise<T> {
      apiCalls.push(`GET ${path}`);
      return {} as T;
    },
    async postJson<T>(path: string): Promise<T> {
      apiCalls.push(`POST ${path}`);
      return {} as T;
    },
  };
  const topics: PluginTopicsBridge = {
    list: () => [],
    active: () => undefined,
    open: vi.fn(),
    insertIntoComposer: vi.fn(),
  };
  const manager = new PluginManager({
    registry,
    events,
    storage,
    api,
    topics,
    now: () => 1700000000000,
  });
  return { registry, events, storage, api, apiCalls, topics, manager };
}

describe('resolvePluginAssetUrl', () => {
  it('normalizes relative, boot-config, and rooted same-origin plugin paths', () => {
    expect(resolvePluginAssetUrl('hello', 'dist/client.js')).toBe('/plugins/hello/dist/client.js');
    expect(resolvePluginAssetUrl('hello', 'plugins/hello/dist/style.css')).toBe('/plugins/hello/dist/style.css');
    expect(resolvePluginAssetUrl('hello', '/plugins/hello/dist/client.js')).toBe('/plugins/hello/dist/client.js');
    expect(resolvePluginAssetUrl('hello', 'dist/client.js', '/sub/')).toBe('/sub/plugins/hello/dist/client.js');
  });

  it('rejects cross-origin URLs, other plugin namespaces, and path traversal', () => {
    const bad = [
      'https://evil.example/a.js',
      '//evil.example/a.js',
      'javascript:alert(1)',
      '/plugins/other/dist/client.js',
      'plugins/other/dist/client.js',
      '/assets/app.js',
      '../other/client.js',
      'dist/%2e%2e/secret.js',
      'dist\\client.js',
      '',
    ];
    for (const path of bad) {
      expect(() => resolvePluginAssetUrl('hello', path)).toThrow();
    }
  });
});

describe('extractWebuiPlugin', () => {
  it('supports default export, named plugin export, and named activate export', () => {
    const def = extractWebuiPlugin(
      { default: definePlugin({ id: 'alpha', activate: () => undefined }) },
      'alpha',
    );
    expect(def.id).toBe('alpha');

    const named = extractWebuiPlugin(
      { plugin: definePlugin({ id: 'beta', activate: () => undefined }) },
      'beta',
    );
    expect(named.id).toBe('beta');

    const fnOnly = extractWebuiPlugin(
      { activate: () => undefined, deactivate: () => undefined },
      'gamma',
    );
    expect(fnOnly.id).toBe('gamma');
    expect(typeof fnOnly.deactivate).toBe('function');
  });

  it('rejects mismatched id or missing activate function', () => {
    expect(() =>
      extractWebuiPlugin({ default: { id: 'wrong', activate: () => undefined } }, 'alpha'),
    ).toThrow(/mismatch/i);
    expect(() => extractWebuiPlugin({ default: { id: 'alpha' } }, 'alpha')).toThrow(/activate/i);
    expect(() => extractWebuiPlugin({ id: 'wrong', activate: () => undefined }, 'alpha')).toThrow(/mismatch/i);
    expect(() => extractWebuiPlugin({}, 'alpha')).toThrow();
  });
});

describe('ExternalPluginLoader', () => {
  it('loads default/named exports from boot-config, injects stylesheets, and provides restricted external PluginContext', async () => {
    const { registry, events, apiCalls, manager } = makeHarness();
    const doc = makeDocument([
      {
        id: 'hello-default',
        version: '1.0.0',
        client: 'plugins/hello-default/dist/client.js',
        style: 'plugins/hello-default/dist/style.css',
      },
      {
        id: 'hello-named',
        version: '1.1.0',
        client: 'dist/named.js',
      },
      {
        id: 'hello-fn',
        version: '1.2.0',
        client: 'dist/fn.js',
      },
      {
        id: 'theme-only',
        version: '0.1.0',
        style: 'dist/theme.css',
      },
    ]);

    const importedUrls: string[] = [];
    let capturedCtx: PluginContext | undefined;

    const importer = vi.fn(async (url: string) => {
      importedUrls.push(url);
      if (url === '/plugins/hello-default/dist/client.js') {
        return {
          default: definePlugin({
            id: 'hello-default',
            async activate(ctx) {
              capturedCtx = ctx;
              ctx.views.register({ id: 'hello.view', title: 'Hello', part: 'sidebar', component: dummyPanel });
              await ctx.api.get('/api/plugins/hello-default/ping');
              await ctx.api.get('/api/skills');
            },
          }),
        };
      }
      if (url === '/plugins/hello-named/dist/named.js') {
        return {
          plugin: definePlugin({
            id: 'hello-named',
            activate(ctx) {
              ctx.statusBar.register({ id: 'hello.status', align: 'right', render: () => undefined });
            },
          }),
        };
      }
      if (url === '/plugins/hello-fn/dist/fn.js') {
        return {
          id: 'hello-fn',
          activate(ctx: PluginContext) {
            ctx.commands.register('hello.fn.cmd', () => 'ran');
          },
        };
      }
      throw new Error(`Unexpected import: ${url}`);
    });

    const failures: PluginLoadFailure[] = [];
    const result = await loadExternalPlugins({
      manager,
      doc,
      importer,
      onError: (f) => failures.push(f),
      now: () => 1700000000123,
    });

    expect(failures).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.loaded).toEqual(['hello-default', 'hello-named', 'hello-fn']);
    expect(result.styleOnly).toEqual(['theme-only']);
    expect(importedUrls).toEqual([
      '/plugins/hello-default/dist/client.js',
      '/plugins/hello-named/dist/named.js',
      '/plugins/hello-fn/dist/fn.js',
    ]);

    // Verify injected <link> tags in document.head.
    const links = [...doc.head.querySelectorAll('link[rel="stylesheet"]')];
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('data-plugin-id')).toBe('hello-default');
    expect(links[0]?.getAttribute('href')).toBe('/plugins/hello-default/dist/style.css');
    expect(links[1]?.getAttribute('data-plugin-id')).toBe('theme-only');
    expect(links[1]?.getAttribute('href')).toBe('/plugins/theme-only/dist/theme.css');

    // Verify external plugins are registered with builtin: false and restricted API access.
    expect(manager.list().every((item) => item.builtin === false && item.status === 'active')).toBe(true);
    expect(apiCalls).toEqual(['GET /api/plugins/hello-default/ping', 'GET /api/skills']);
    expect(capturedCtx).toBeDefined();
    expect(() => capturedCtx!.api.get('/api/plugins/other/secret')).toThrow(/not allowed/i);
    expect(() => capturedCtx!.api.post('/api/settings', {})).toThrow(/not allowed/i);

    // Verify contributions exist before dispose.
    expect(registry.getView('hello.view')).toBeDefined();
    expect(registry.getStatusBar('hello.status')).toBeDefined();
    expect(await registry.executeCommand('hello.fn.cmd')).toBe('ran');

    // Dispose cleans up injected stylesheets and deactivates external plugins + contributions.
    result.dispose();
    expect(doc.head.querySelectorAll('link[data-plugin-id]')).toHaveLength(0);
    expect(registry.getView('hello.view')).toBeUndefined();
    expect(registry.getStatusBar('hello.status')).toBeUndefined();
    expect(registry.commands.has('hello.fn.cmd')).toBe(false);
    expect(manager.has('hello-default')).toBe(false);
    expect(manager.has('hello-named')).toBe(false);
    expect(manager.has('hello-fn')).toBe(false);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('isolates import errors, id mismatches, and activate throws while keeping healthy plugins active and cleaning failed stylesheets', async () => {
    const { registry, events, manager } = makeHarness();
    const doc = makeDocument();
    const reported: PluginLoadFailure[] = [];

    const importer = vi.fn(async (url: string) => {
      if (url === '/plugins/net-fail/dist/client.js') {
        throw new Error('Failed to fetch dynamically imported module');
      }
      if (url === '/plugins/bad-id/dist/client.js') {
        return {
          default: definePlugin({
            id: 'spoofed-id',
            activate: () => undefined,
          }),
        };
      }
      if (url === '/plugins/crash-activate/dist/client.js') {
        return {
          default: definePlugin({
            id: 'crash-activate',
            async activate(ctx) {
              ctx.views.register({ id: 'crash.partial', title: 'Partial', part: 'sidebar', component: dummyPanel });
              await Promise.resolve();
              throw new Error('boom inside activate');
            },
          }),
        };
      }
      if (url === '/plugins/healthy/dist/client.js') {
        return {
          default: definePlugin({
            id: 'healthy',
            activate(ctx) {
              ctx.views.register({ id: 'healthy.view', title: 'Healthy', part: 'sidebar', component: dummyPanel });
            },
          }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const loader = new ExternalPluginLoader({
      manager,
      doc,
      importer,
      onError: (f) => reported.push(f),
      now: () => 1700000000999,
    });

    const summary = await loader.load([
      { id: 'net-fail', version: '1.0.0', client: 'dist/client.js', style: 'dist/style.css' },
      { id: 'bad-id', version: '1.0.0', client: 'dist/client.js', style: 'dist/style.css' },
      { id: 'crash-activate', version: '1.0.0', client: 'dist/client.js', style: 'dist/style.css' },
      { id: 'healthy', version: '2.0.0', client: 'dist/client.js', style: 'dist/style.css' },
    ]);

    expect(summary.loaded).toEqual(['healthy']);
    expect(summary.failures).toHaveLength(3);
    expect(reported).toEqual(summary.failures);
    expect(summary.failures.map((f) => `${f.pluginId}:${f.phase}`)).toEqual([
      'net-fail:import',
      'bad-id:validate',
      'crash-activate:activate',
    ]);
    expect(summary.failures[0]?.message).toContain('Failed to fetch');
    expect(summary.failures[1]?.message).toMatch(/mismatch/i);
    expect(summary.failures[2]?.message).toBe('boom inside activate');

    // Failed plugins' stylesheets and partial contributions must be cleaned up; healthy plugin stays intact.
    const remainingLinks = [...doc.head.querySelectorAll('link[data-plugin-id]')];
    expect(remainingLinks).toHaveLength(1);
    expect(remainingLinks[0]?.getAttribute('data-plugin-id')).toBe('healthy');
    expect(registry.getView('crash.partial')).toBeUndefined();
    expect(registry.getView('healthy.view')).toBeDefined();
    expect(manager.getStatus('crash-activate')).toBe('failed');
    expect(manager.getStatus('healthy')).toBe('active');

    loader.dispose();
    expect(doc.head.querySelectorAll('link[data-plugin-id]')).toHaveLength(0);
    expect(registry.getView('healthy.view')).toBeUndefined();

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('isolates onError callback throws and rejects collisions with already-registered plugins', async () => {
    const { registry, events, manager } = makeHarness();
    const doc = makeDocument();

    manager.register(definePlugin({ id: 'topics', activate: () => undefined }), { builtin: true });

    const loader = new ExternalPluginLoader({
      manager,
      doc,
      importer: async (url) => {
        if (url === '/plugins/topics/dist/client.js') {
          return { default: definePlugin({ id: 'topics', activate: () => undefined }) };
        }
        return { default: definePlugin({ id: 'ok-ext', activate: () => undefined }) };
      },
      onError: () => {
        throw new Error('broken status bar callback');
      },
    });

    const summary = await loader.load([
      { id: 'topics', version: '1.0.0', client: 'dist/client.js', style: 'dist/style.css' },
      { id: 'ok-ext', version: '1.0.0', client: 'dist/client.js' },
    ]);

    expect(summary.loaded).toEqual(['ok-ext']);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.phase).toBe('register');
    expect(doc.head.querySelectorAll('link[data-plugin-id="topics"]')).toHaveLength(0);

    loader.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
