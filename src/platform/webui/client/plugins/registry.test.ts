import { describe, expect, it, vi } from 'vitest';
import { html, render } from '../base/html.js';
import type { ApiClient } from '../services/api.js';
import { CommandRegistry } from '../services/commands.js';
import { KeybindingService } from '../services/keybindings.js';
import { StorageService, type StorageLike } from '../services/storage.js';
import type { PanelComponent } from '../workbench/contracts.js';
import type { MenuItem, TopicInfo } from './api.js';
import {
  assertPluginApiPath,
  ContributionRegistry,
  createPluginContext,
  PluginI18nRegistry,
  type PluginTopicsBridge,
  WebuiEventBus,
} from './registry.js';

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
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

function makeMockApi(): { client: ApiClient; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client: ApiClient = {
    post: vi.fn(async () => new Response('{}')),
    get: vi.fn(async () => new Response('{}')),
    async getJson<T>(path: string): Promise<T> {
      calls.push({ method: 'GET', path });
      return { ok: true, path } as T;
    },
    async postJson<T>(path: string, body: unknown): Promise<T> {
      calls.push({ method: 'POST', path, body });
      return { ok: true, path, body } as T;
    },
  };
  return { client, calls };
}

function makeTopic(overrides: Partial<TopicInfo> = {}): TopicInfo {
  return {
    id: 'abcd1234',
    title: 'Sample topic',
    lastAt: 1000,
    ...overrides,
  };
}

function makeTopicsBridge(topics: readonly TopicInfo[] = []): PluginTopicsBridge & {
  opened: string[];
  inserted: Array<{ id: string; text: string }>;
} {
  const opened: string[] = [];
  const inserted: Array<{ id: string; text: string }> = [];
  return {
    opened,
    inserted,
    list: () => topics,
    active: () => topics[0],
    open: (id) => opened.push(id),
    insertIntoComposer: (id, text) => inserted.push({ id, text }),
  };
}

describe('ContributionRegistry', () => {
  it('registers, filters, indexes by PartId, and disposes views', () => {
    const reg = new ContributionRegistry();
    let visible = true;
    const events: string[] = [];
    reg.onDidChangeViews(() => events.push('views'));
    reg.onDidChange((kind) => events.push(`all:${kind}`));

    const d1 = reg.registerView({
      id: 'demo.sidebar',
      title: 'Sidebar View',
      part: 'sidebar',
      component: dummyPanel,
      when: () => visible,
    });
    const d2 = reg.registerView({
      id: 'demo.panel',
      title: 'Panel View',
      part: 'panel',
      component: dummyPanel,
    });

    expect(reg.getView('demo.sidebar')?.title).toBe('Sidebar View');
    expect(reg.listViews('sidebar').map((v) => v.id)).toEqual(['demo.sidebar']);
    expect(reg.listViews('panel').map((v) => v.id)).toEqual(['demo.panel']);
    expect(reg.listViews().map((v) => v.id)).toEqual(['demo.sidebar', 'demo.panel']);

    visible = false;
    expect(reg.listViews('sidebar')).toEqual([]);
    expect(reg.listViews('sidebar', { includeHidden: true }).map((v) => v.id)).toEqual(['demo.sidebar']);

    expect(() =>
      reg.registerView({ id: 'demo.sidebar', title: 'Dup', part: 'sidebar', component: dummyPanel }),
    ).toThrow(/already registered/i);

    d1.dispose();
    d1.dispose(); // idempotent
    expect(reg.getView('demo.sidebar')).toBeUndefined();
    expect(reg.listViews(undefined, { includeHidden: true }).map((v) => v.id)).toEqual(['demo.panel']);
    expect(events.filter((e) => e === 'views')).toHaveLength(3);

    d2.dispose();
    reg.dispose();
  });

  it('registers editors by kind and forwards open() to the editor host', () => {
    const opened: Array<{ kind: string; input: unknown; opts?: unknown }> = [];
    const reg = new ContributionRegistry({
      openEditor: (kind, input, opts) => opened.push({ kind, input, opts }),
    });

    const d = reg.registerEditor({
      kind: 'demo.doc',
      component: dummyPanel,
      title: (input) => `Doc: ${String(input)}`,
    });

    expect(reg.getEditor('demo.doc')?.title('readme')).toBe('Doc: readme');
    expect(reg.listEditors()).toHaveLength(1);
    expect(() =>
      reg.registerEditor({ kind: 'demo.doc', component: dummyPanel, title: () => 'x' }),
    ).toThrow(/already registered/i);

    reg.openEditor('demo.doc', { path: 'a.md' }, { preview: true });
    expect(opened).toEqual([{ kind: 'demo.doc', input: { path: 'a.md' }, opts: { preview: true } }]);

    expect(() => reg.openEditor('missing.kind', {})).toThrow(/unknown editor kind/i);

    reg.setEditorOpener(undefined);
    expect(() => reg.openEditor('demo.doc', {})).toThrow(/not configured/i);

    d.dispose();
    expect(reg.getEditor('demo.doc')).toBeUndefined();
    reg.dispose();
  });

  it('registers topicTools and filters by focused topic availability and defaultPart', () => {
    const reg = new ContributionRegistry();
    let changes = 0;
    reg.onDidChangeTopicTools(() => {
      changes++;
    });

    const d1 = reg.registerTopicTool({
      id: 'tool.git',
      title: 'Changes',
      icon: 'git',
      defaultPart: 'secondary',
      available: (topic) => Boolean(topic.dir),
      component: dummyPanel,
    });
    const d2 = reg.registerTopicTool({
      id: 'tool.term',
      title: 'Terminal',
      icon: 'terminal',
      defaultPart: 'panel',
      available: (topic) => Boolean(topic.term),
      component: dummyPanel,
    });

    expect(reg.listTopicTools().map((t) => t.id)).toEqual(['tool.git', 'tool.term']);
    expect(reg.listTopicTools('secondary').map((t) => t.id)).toEqual(['tool.git']);
    expect(reg.listAvailableTopicTools(undefined)).toEqual([]);

    const withDir = makeTopic({ dir: { name: 'repo', path: '/tmp/repo' }, term: false });
    expect(reg.listAvailableTopicTools(withDir).map((t) => t.id)).toEqual(['tool.git']);
    expect(reg.listAvailableTopicTools(withDir, 'panel')).toEqual([]);

    const withBoth = makeTopic({ dir: { name: 'repo', path: '/tmp/repo' }, term: true });
    expect(reg.listAvailableTopicTools(withBoth).map((t) => t.id)).toEqual(['tool.git', 'tool.term']);
    expect(reg.listAvailableTopicTools(withBoth, 'panel').map((t) => t.id)).toEqual(['tool.term']);

    expect(() =>
      reg.registerTopicTool({
        id: 'tool.git',
        title: 'Dup',
        icon: 'git',
        defaultPart: 'secondary',
        available: () => true,
        component: dummyPanel,
      }),
    ).toThrow(/already registered/i);

    d1.dispose();
    d2.dispose();
    expect(changes).toBe(4);
    reg.dispose();
  });

  it('sorts activity items by order and supports dynamic badge refresh', () => {
    const reg = new ContributionRegistry();
    let unread = 3;
    let badgeRefreshes = 0;
    reg.onDidChangeActivityBadges(() => {
      badgeRefreshes++;
    });

    const d1 = reg.registerActivity({
      id: 'act.settings',
      title: 'Settings',
      icon: 'gear',
      view: 'view.settings',
      order: 50,
    });
    const d2 = reg.registerActivity({
      id: 'act.topics',
      title: 'Topics',
      icon: 'chat',
      view: 'view.topics',
      order: 10,
      badge: () => (unread > 0 ? unread : null),
    });
    const d3 = reg.registerActivity({
      id: 'act.history',
      title: 'History',
      icon: 'history',
      view: 'view.history',
      order: 10,
      badge: () => 'dot',
    });

    expect(reg.listActivities().map((a) => a.id)).toEqual(['act.topics', 'act.history', 'act.settings']);
    expect(reg.getActivityBadge('act.topics')).toBe(3);
    expect(reg.getActivityBadge('act.history')).toBe('dot');
    expect(reg.getActivityBadge('act.settings')).toBeNull();

    unread = 0;
    reg.refreshActivityBadges();
    expect(badgeRefreshes).toBe(1);
    expect(reg.getActivityBadge('act.topics')).toBeNull();

    expect(() =>
      reg.registerActivity({ id: 'act.topics', title: 'Dup', icon: 'chat', view: 'x' }),
    ).toThrow(/already registered/i);

    d1.dispose();
    d2.dispose();
    d3.dispose();
    expect(reg.listActivities()).toEqual([]);
    reg.dispose();
  });

  it('sorts statusBar items by align and order', () => {
    const reg = new ContributionRegistry();
    const noopRender = () => undefined;

    const d1 = reg.registerStatusBar({ id: 'sb.r2', align: 'right', order: 20, render: noopRender });
    const d2 = reg.registerStatusBar({ id: 'sb.l1', align: 'left', order: 5, render: noopRender });
    const d3 = reg.registerStatusBar({ id: 'sb.r1', align: 'right', order: 10, render: noopRender });

    expect(reg.listStatusBar('left').map((s) => s.id)).toEqual(['sb.l1']);
    expect(reg.listStatusBar('right').map((s) => s.id)).toEqual(['sb.r1', 'sb.r2']);
    expect(reg.listStatusBar().map((s) => s.id)).toEqual(['sb.l1', 'sb.r1', 'sb.r2']);

    expect(() =>
      reg.registerStatusBar({ id: 'sb.l1', align: 'left', render: noopRender }),
    ).toThrow(/already registered/i);

    d1.dispose();
    d2.dispose();
    d3.dispose();
    reg.dispose();
  });

  it('wires commands to CommandRegistry and KeybindingService and rolls back on invalid keybinding', async () => {
    const commands = new CommandRegistry();
    const keybindings = new KeybindingService({
      executeCommand: (id, ...args) => commands.execute(id, ...args),
      isMac: false,
    });
    const reg = new ContributionRegistry({ commands, keybindings });

    const ran: unknown[] = [];
    const sub = reg.registerCommand(
      'demo.ping',
      (arg) => {
        ran.push(arg);
        return 'pong';
      },
      { title: 'Ping', keybinding: 'Ctrl+K' },
    );

    expect(await reg.executeCommand('demo.ping', 42)).toBe('pong');
    expect(ran).toEqual([42]);

    const matched = keybindings.handleKeydown({ key: 'k', ctrlKey: true });
    expect(matched).toBe(true);
    expect(ran).toEqual([42, undefined]);

    // Invalid keybinding must not leak the command into CommandRegistry.
    expect(() =>
      reg.registerCommand('demo.badKey', () => undefined, { keybinding: 'Ctrl+' }),
    ).toThrow(/missing key/i);
    expect(commands.has('demo.badKey')).toBe(false);

    sub.dispose();
    expect(commands.has('demo.ping')).toBe(false);
    expect(keybindings.handleKeydown({ key: 'k', ctrlKey: true })).toBe(false);

    reg.dispose();
    keybindings.dispose();
    commands.dispose();
  });

  it('manages menus across all 4 locations with group/order sorting, when() filtering, and disabled() resolution', () => {
    const reg = new ContributionRegistry();
    const menuEvents: string[] = [];
    reg.onDidChangeMenus((where) => menuEvents.push(where));

    const makeItem = (overrides: Partial<MenuItem> & { id: string }): MenuItem => ({
      label: overrides.id,
      run: () => undefined,
      ...overrides,
    });

    const dDel = reg.registerMenu(
      'topic.row',
      makeItem({ id: 'delete', group: '9_danger', order: 1, danger: true }),
    );
    const dStar = reg.registerMenu(
      'topic.row',
      makeItem({ id: 'star', group: '1_primary', order: 1 }),
    );
    const dFork = reg.registerMenu(
      'topic.row',
      makeItem({
        id: 'fork',
        group: '1_primary',
        order: 2,
        when: (t) => Boolean((t as TopicInfo | undefined)?.agent?.canFork),
        disabled: (t) => ((t as TopicInfo | undefined)?.running ? 'Topic is running' : false),
      }),
    );
    const dExtra = reg.registerMenu('topic.row', makeItem({ id: 'extra' }));
    // Same id in a different menu location is allowed.
    const dTaskDel = reg.registerMenu('task.row', makeItem({ id: 'delete', danger: true }));
    const dTitle = reg.registerMenu('topic.title', makeItem({ id: 'rename' }));
    const dMsg = reg.registerMenu('message', makeItem({ id: 'copy' }));

    expect(() => reg.registerMenu('topic.row', makeItem({ id: 'star' }))).toThrow(/already registered/i);
    expect(() => reg.registerMenu('invalid' as any, makeItem({ id: 'x' }))).toThrow(/invalid menu location/i);

    const noForkTopic = makeTopic({ agent: { id: 'a1', harness: 'codex', canFork: false } });
    expect(reg.listMenuItems('topic.row', noForkTopic).map((i) => i.id)).toEqual(['star', 'delete', 'extra']);

    const runningForkTopic = makeTopic({
      running: true,
      agent: { id: 'a1', harness: 'codex', canFork: true },
    });
    const groups = reg.listMenuGroups('topic.row', runningForkTopic);
    expect(groups.map((g) => g.map((x) => x.item.id))).toEqual([
      ['star', 'fork'],
      ['delete'],
      ['extra'],
    ]);
    expect(groups[0]?.[1]).toMatchObject({ disabled: true, disabledReason: 'Topic is running' });
    expect(reg.listMenuItems('task.row').map((i) => i.id)).toEqual(['delete']);
    expect(reg.listMenuItems('topic.title').map((i) => i.id)).toEqual(['rename']);
    expect(reg.listMenuItems('message').map((i) => i.id)).toEqual(['copy']);

    dDel.dispose();
    dStar.dispose();
    dFork.dispose();
    dExtra.dispose();
    dTaskDel.dispose();
    dTitle.dispose();
    dMsg.dispose();
    expect(menuEvents).toContain('topic.row');
    expect(reg.listMenuItems('topic.row')).toEqual([]);
    reg.dispose();
  });

  it('enforces scope "device" on settings sections', () => {
    const reg = new ContributionRegistry();
    const sub = reg.registerSettingsSection({
      id: 'sec.appearance',
      title: 'Appearance',
      scope: 'device',
      component: dummyPanel,
    });
    expect(reg.getSettingsSection('sec.appearance')?.title).toBe('Appearance');
    expect(reg.listSettingsSections()).toHaveLength(1);

    expect(() =>
      reg.registerSettingsSection({
        id: 'sec.gateway',
        title: 'Gateway',
        scope: 'gateway' as any,
        component: dummyPanel,
      }),
    ).toThrow(/scope "device"/i);

    expect(() =>
      reg.registerSettingsSection({
        id: 'sec.appearance',
        title: 'Dup',
        scope: 'device',
        component: dummyPanel,
      }),
    ).toThrow(/already registered/i);

    sub.dispose();
    expect(reg.listSettingsSections()).toEqual([]);
    reg.dispose();
  });
});

describe('assertPluginApiPath & createPluginContext', () => {
  it('enforces external plugin API allowlist and blocks traversal / non-relative URLs', () => {
    const ext = { builtin: false };
    expect(assertPluginApiPath('hello', 'GET', '/api/plugins/hello/status', ext)).toBe('/api/plugins/hello/status');
    expect(assertPluginApiPath('hello', 'POST', '/api/plugins/hello/run?x=1', ext)).toBe('/api/plugins/hello/run?x=1');
    expect(assertPluginApiPath('hello', 'GET', '/api/topic?t=abcd1234', ext)).toBe('/api/topic?t=abcd1234');
    expect(assertPluginApiPath('hello', 'GET', '/api/skills', ext)).toBe('/api/skills');

    // External plugin cannot POST to public read-only endpoints or access other plugins.
    expect(() => assertPluginApiPath('hello', 'POST', '/api/topic', ext)).toThrow(/not allowed/i);
    expect(() => assertPluginApiPath('hello', 'POST', '/api/send', ext)).toThrow(/not allowed/i);
    expect(() => assertPluginApiPath('hello', 'GET', '/api/plugins/other/data', ext)).toThrow(/not allowed/i);
    expect(() => assertPluginApiPath('hello', 'GET', '/api/plugins/hello-2/data', ext)).toThrow(/not allowed/i);
    expect(() => assertPluginApiPath('hello', 'GET', '/api/files/read?path=/etc/hosts', ext)).toThrow(/not allowed/i);
    expect(() => assertPluginApiPath('hello', 'GET', '/api/instructions/read', ext)).toThrow(/not allowed/i);

    // Path traversal & protocol-relative / absolute URLs must be rejected.
    const badPaths = [
      '/api/plugins/hello/../other/secret',
      '/api/plugins/hello/%2e%2e/other/secret',
      '/api/plugins/hello/%252e%252e/other/secret',
      '/api/plugins/hello/a%2fb',
      '/api/plugins/hello/./x',
      '/api/plugins/hello\\..\\other',
      '//evil.example/api/plugins/hello/x',
      'https://evil.example/api/plugins/hello/x',
      'api/plugins/hello/x',
    ];
    for (const p of badPaths) {
      expect(() => assertPluginApiPath('hello', 'GET', p, ext)).toThrow();
    }

    // Built-in plugin can access standard /api/ endpoints, still blocking traversal.
    const builtin = { builtin: true };
    expect(assertPluginApiPath('topics', 'POST', '/api/send', builtin)).toBe('/api/send');
    expect(assertPluginApiPath('files', 'POST', '/api/files/write', builtin)).toBe('/api/files/write');
    expect(() => assertPluginApiPath('topics', 'GET', '/api/topics/../secret', builtin)).toThrow(/traversal/i);
    expect(() => assertPluginApiPath('topics', 'GET', '/other/path', builtin)).toThrow(/must start with "\/api\/"/i);
  });

  it('isolates storage per plugin id, wires i18n/events/topics/html, and disposes all contributions via subscriptions', async () => {
    const reg = new ContributionRegistry({ openEditor: vi.fn() });
    const events = new WebuiEventBus();
    const storage = new StorageService('', makeMemoryStorage());
    const { client: api, calls } = makeMockApi();
    let locale = 'en';
    const i18n = new PluginI18nRegistry(() => locale);
    const topic = makeTopic({ id: 't1', title: 'Alpha' });
    const topics = makeTopicsBridge([topic]);

    const ctxA = createPluginContext('alpha', { registry: reg, events, topics, api, storage, i18n, builtin: false });
    const ctxB = createPluginContext('beta', { registry: reg, events, topics, api, storage, i18n, builtin: true });

    // Storage isolation
    ctxA.storage.set('theme', { mode: 'dark' });
    ctxB.storage.set('theme', { mode: 'light' });
    expect(ctxA.storage.get('theme')).toEqual({ mode: 'dark' });
    expect(ctxB.storage.get('theme')).toEqual({ mode: 'light' });
    ctxA.storage.set('theme', undefined);
    expect(ctxA.storage.get('theme')).toBeUndefined();
    expect(ctxB.storage.get('theme')).toEqual({ mode: 'light' });

    // i18n extension + locale switching + interpolation
    ctxA.i18n.add('en', { 'alpha.greet': 'Hello {name}' });
    ctxA.i18n.add('zh-CN', { 'alpha.greet': '你好 {name}' });
    expect(ctxA.i18n.t('alpha.greet', { name: 'World' })).toBe('Hello World');
    locale = 'zh-CN';
    expect(ctxA.i18n.t('alpha.greet', { name: 'World' })).toBe('你好 World');
    // Unregistered key falls back to key string
    expect(ctxA.i18n.t('alpha.missing')).toBe('alpha.missing');

    // Topics bridge & lit-html pass-through
    expect(ctxA.topics.list()).toEqual([topic]);
    expect(ctxA.topics.active()).toEqual(topic);
    ctxA.topics.open('t1');
    ctxA.topics.insertIntoComposer('t1', 'hello');
    expect(topics.opened).toEqual(['t1']);
    expect(topics.inserted).toEqual([{ id: 't1', text: 'hello' }]);
    expect(ctxA.html).toBe(html);
    expect(ctxA.render).toBe(render);

    // API guard enforcement on context
    await ctxA.api.get('/api/plugins/alpha/info');
    await ctxA.api.get('/api/topic?t=t1');
    expect(() => ctxA.api.post('/api/send', {})).toThrow(/not allowed/i);
    await ctxB.api.post('/api/send', { text: 'ok' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/plugins/alpha/info',
      'GET /api/topic?t=t1',
      'POST /api/send',
    ]);

    // Subscriptions auto-cleanup of contributions & event listeners
    const received: unknown[] = [];
    ctxA.views.register({ id: 'alpha.v', title: 'A', part: 'sidebar', component: dummyPanel });
    ctxA.events.on('plugin:alpha:ping', (payload) => received.push(payload));
    events.emit('plugin:alpha:ping', { n: 1 });
    expect(received).toEqual([{ n: 1 }]);
    expect(reg.getView('alpha.v')).toBeDefined();

    ctxA.subscriptions.dispose();
    expect(reg.getView('alpha.v')).toBeUndefined();
    events.emit('plugin:alpha:ping', { n: 2 });
    expect(received).toEqual([{ n: 1 }]);

    ctxB.subscriptions.dispose();
    events.dispose();
    reg.dispose();
  });
});
