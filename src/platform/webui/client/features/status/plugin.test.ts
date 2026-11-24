// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../base/event.js';
import { getLocale, setLocale } from '../../i18n/index.js';
import type { StatusBarContribution, TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { OverlayManager } from '../../services/overlays.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import { getTheme, setTheme } from '../../theme.js';
import {
  computeIdleTopics,
  computeRunningCount,
  createStatusPlugin,
  type ConnectionState,
  type StatusNotifyBridge,
  type StatusNotifyState,
  type StatusPluginDeps,
  type StatusPluginError,
} from './index.js';

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

function makeFakeNotifyBridge(initial: Partial<StatusNotifyState> = {}): StatusNotifyBridge & {
  setState(patch: Partial<StatusNotifyState>): void;
  toggleCalls: number;
  initCalls: number;
} {
  const emitter = new Emitter<StatusNotifyState>();
  let state: StatusNotifyState = {
    supported: true,
    available: true,
    enabled: false,
    blocked: false,
    busy: false,
    ...initial,
  };
  const bridge = {
    toggleCalls: 0,
    initCalls: 0,
    onDidChange: emitter.event,
    getState: () => state,
    setState(patch: Partial<StatusNotifyState>) {
      state = { ...state, ...patch };
      emitter.fire(state);
    },
    async init() {
      bridge.initCalls++;
    },
    async toggle() {
      bridge.toggleCalls++;
      if (!state.supported || !state.available || state.blocked) return;
      state = { ...state, enabled: !state.enabled };
      emitter.fire(state);
    },
    dispose() {
      emitter.dispose();
    },
  };
  return bridge;
}

function mountStatusBarItems(items: readonly StatusBarContribution[]): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  for (const item of items) {
    const el = document.createElement(item.onClick ? 'button' : 'span');
    el.dataset.statusId = item.id;
    if (item.onClick) {
      const click = item.onClick;
      el.addEventListener('click', () => click());
    }
    item.render(el);
    document.body.appendChild(el);
    map.set(item.id, el);
  }
  return map;
}

interface TestHarnessOptions {
  readonly topics?: TopicInfo[];
  readonly deps?: StatusPluginDeps;
  readonly postJson?: ApiClient['postJson'];
}

async function setupHarness(opts: TestHarnessOptions = {}) {
  const registry = new ContributionRegistry({ openEditor: vi.fn() });
  const events = new WebuiEventBus();
  const storage = new StorageService('', makeMemoryStorage());
  const overlays = new OverlayManager();
  let topicList: TopicInfo[] = opts.topics ?? [];

  const postJsonMock = vi.fn(
    opts.postJson ??
      (async <T>(): Promise<T> => ({ closed: [], kept: [] }) as unknown as T),
  );
  const api: ApiClient = {
    post: vi.fn(async () => new Response('{}')),
    get: vi.fn(async () => new Response('{}')),
    async getJson<T>(): Promise<T> {
      return {} as T;
    },
    postJson: postJsonMock as ApiClient['postJson'],
  };
  const topics: PluginTopicsBridge = {
    list: () => topicList,
    active: () => topicList[0],
    open: vi.fn(),
    insertIntoComposer: vi.fn(),
  };

  const appEl = document.createElement('div');
  appEl.id = 'app';
  document.body.appendChild(appEl);

  const manager = new PluginManager({
    registry,
    events,
    storage,
    api,
    topics,
  });

  const plugin = createStatusPlugin({
    storage,
    overlays,
    appElement: appEl,
    version: '3.38.0',
    emitEvent: (k, payload) => events.emit(k, payload),
    ...opts.deps,
  });

  manager.register(plugin, { builtin: true });
  const activated = await manager.activate('status');
  expect(activated).toBe(true);

  const setTopics = (next: TopicInfo[]) => {
    topicList = next;
    events.emit('topic.list', { topics: next });
  };

  const cleanup = () => {
    manager.dispose();
    events.dispose();
    overlays.dispose();
    registry.dispose();
  };

  return {
    registry,
    events,
    storage,
    overlays,
    api,
    postJsonMock,
    appEl,
    manager,
    setTopics,
    cleanup,
  };
}

describe('features/status plugin', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    setLocale('en');
    setTheme('system');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('registers all left and right status bar items in order, device settings section, and commands', async () => {
    const notify = makeFakeNotifyBridge();
    const h = await setupHarness({ deps: { notify } });

    const leftIds = h.registry.listStatusBar('left').map((item) => item.id);
    const rightIds = h.registry.listStatusBar('right').map((item) => item.id);

    expect(leftIds).toEqual(['status.connection', 'status.running', 'status.idle']);
    expect(rightIds).toEqual([
      'status.pluginErrors',
      'status.notify',
      'status.calm',
      'status.locale',
      'status.theme',
      'status.version',
    ]);

    const section = h.registry.getSettingsSection('device-preferences');
    expect(section).toBeDefined();
    expect(section?.scope).toBe('device');

    expect(h.registry.commands.has('status.closeIdle')).toBe(true);
    expect(h.registry.commands.has('status.toggleCalm')).toBe(true);
    expect(h.registry.commands.has('status.cycleTheme')).toBe(true);
    expect(h.registry.commands.has('status.cycleLocale')).toBe(true);
    expect(h.registry.commands.has('status.toggleNotify')).toBe(true);

    h.cleanup();
    notify.dispose();
  });

  it('computes running and idle counts honoring busy descendants and updates on stream/topic events', async () => {
    const topics: TopicInfo[] = [
      { id: 't-run', title: 'Running', lastAt: 1, live: true, running: true },
      { id: 't-parent', title: 'Dispatcher', lastAt: 2, live: true },
      { id: 't-child', title: 'Subtask', lastAt: 3, live: true, running: true, parent: 't-parent' },
      { id: 't-idle-1', title: 'Idle One', lastAt: 4, live: true, starred: false },
      { id: 't-idle-star', title: 'Idle Star', lastAt: 5, live: true, starred: true },
      { id: 't-dead', title: 'Cold', lastAt: 6, live: false },
    ];
    expect(computeRunningCount(topics)).toBe(2);
    expect(computeIdleTopics(topics).map((t) => t.id)).toEqual(['t-idle-star', 't-idle-1']);

    const connEmitter = new Emitter<ConnectionState>();
    const notify = makeFakeNotifyBridge();
    const h = await setupHarness({
      deps: {
        notify,
        onConnectionStateChange: (cb) => connEmitter.event(cb),
      },
    });
    const els = mountStatusBarItems(h.registry.listStatusBar());

    expect(els.get('status.connection')?.dataset.state).toBe('connecting');
    h.events.emit('stream.state', { state: 'open' });
    expect(els.get('status.connection')?.dataset.state).toBe('connected');
    expect(els.get('status.connection')?.textContent).toContain('Connected');

    connEmitter.fire('restarting');
    expect(els.get('status.connection')?.dataset.state).toBe('restarting');
    expect(els.get('status.connection')?.querySelector('.fh-dot.is-pulsing')).not.toBeNull();

    h.setTopics(topics);
    expect(els.get('status.running')?.dataset.count).toBe('2');
    expect(els.get('status.idle')?.dataset.count).toBe('2');

    connEmitter.dispose();
    notify.dispose();
    h.cleanup();
  });

  it('opens close-idle dialog on click, posts snapshot once without retries, and renders row-by-row results', async () => {
    const notify = makeFakeNotifyBridge();
    const postCalls: unknown[] = [];
    const h = await setupHarness({
      topics: [
        {
          id: 'idle-a',
          title: 'Alpha task',
          lastAt: 10,
          live: true,
          dir: { name: 'repo-a', path: '/tmp/repo-a', host: 'node-a' },
        },
        {
          id: 'idle-b',
          title: 'Beta task',
          lastAt: 20,
          live: true,
          starred: true,
          dir: { name: 'repo-b', path: '/tmp/repo-b' },
        },
      ],
      deps: { notify },
      postJson: async <T>(path: string, body: unknown): Promise<T> => {
        postCalls.push({ path, body });
        return { closed: ['idle-b'], kept: ['idle-a'] } as unknown as T;
      },
    });

    const els = mountStatusBarItems(h.registry.listStatusBar());
    const idleEl = els.get('status.idle') as HTMLButtonElement;
    idleEl.click();

    const dialog = document.querySelector('.fh-dialog');
    expect(dialog).not.toBeNull();
    const rows = Array.from(document.querySelectorAll<HTMLLIElement>('.fh-idle-row'));
    expect(rows.map((r) => r.dataset.idle)).toEqual(['idle-b', 'idle-a']);
    expect(rows[1]?.textContent).toContain('node-a · repo-a');

    // A new idle topic appearing while dialog is open must NOT be included in the POST payload.
    h.setTopics([
      ...h.registry.listStatusBar().length ? [
        { id: 'idle-a', title: 'Alpha task', lastAt: 10, live: true },
        { id: 'idle-b', title: 'Beta task', lastAt: 20, live: true, starred: true },
        { id: 'idle-late', title: 'Late arrival', lastAt: 30, live: true },
      ] : [],
    ]);

    const confirmBtn = document.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]');
    expect(confirmBtn).not.toBeNull();
    confirmBtn?.click();

    await vi.waitFor(() => {
      expect(postCalls).toHaveLength(1);
    });
    expect(postCalls[0]).toEqual({
      path: '/api/topics/close-idle',
      body: { topics: ['idle-b', 'idle-a'] },
    });

    await vi.waitFor(() => {
      const outcomes = Array.from(document.querySelectorAll<HTMLElement>('.idle-out')).map((el) =>
        el.textContent?.trim(),
      );
      expect(outcomes).toEqual(['closed', 'left running']);
    });

    // Dialog stays open after showing results; clicking Done closes it without re-posting.
    expect(document.querySelector('.fh-dialog')).not.toBeNull();
    const doneBtn = document.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]');
    doneBtn?.click();
    expect(document.querySelector('.fh-dialog')).toBeNull();
    expect(postCalls).toHaveLength(1);

    notify.dispose();
    h.cleanup();
  });

  it('toggles calm mode, theme, locale, notifications, version reload, and plugin error indicator', async () => {
    const notify = makeFakeNotifyBridge({ supported: true, available: true, enabled: false });
    const updateEmitter = new Emitter<boolean>();
    const errEmitter = new Emitter<StatusPluginError>();
    const onBeforeReload = vi.fn();
    const onReload = vi.fn();

    const h = await setupHarness({
      deps: {
        notify,
        version: '3.38.0',
        onBeforeReload,
        onReload,
        onUpdateAvailable: (cb) => updateEmitter.event(cb),
        onPluginError: (cb) => errEmitter.event(cb),
      },
    });
    const els = mountStatusBarItems(h.registry.listStatusBar());

    // Calm toggle
    expect(h.appEl.classList.contains('calm')).toBe(false);
    await h.registry.executeCommand('status.toggleCalm');
    expect(h.appEl.classList.contains('calm')).toBe(true);
    expect(h.storage.getRaw('aa_calm')).toBe('1');
    expect(els.get('status.calm')?.getAttribute('aria-pressed')).toBe('true');

    // Theme cycle
    expect(getTheme()).toBe('system');
    await h.registry.executeCommand('status.cycleTheme');
    expect(getTheme()).toBe('dark');
    expect(els.get('status.theme')?.textContent).toContain('Dark');

    // Locale cycle
    expect(getLocale()).toBe('en');
    await h.registry.executeCommand('status.cycleLocale');
    expect(getLocale()).toBe('zh-CN');
    expect(els.get('status.locale')?.textContent).toContain('简体中文');
    expect(els.get('status.theme')?.textContent).toContain('深色');

    // Notify toggle
    await h.registry.executeCommand('status.toggleNotify');
    expect(notify.toggleCalls).toBe(1);
    expect(els.get('status.notify')?.getAttribute('aria-pressed')).toBe('true');

    // Version & update available reload
    const versionEl = els.get('status.version') as HTMLButtonElement;
    expect(versionEl.textContent).toContain('v3.38.0');
    versionEl.click();
    expect(onReload).not.toHaveBeenCalled();

    updateEmitter.fire(true);
    expect(versionEl.classList.contains('is-prominent')).toBe(true);
    versionEl.click();
    expect(onBeforeReload).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);

    // Plugin errors indicator & details dialog
    const errEl = els.get('status.pluginErrors') as HTMLButtonElement;
    expect(errEl.hidden).toBe(true);
    errEmitter.fire({ pluginId: 'ext-sample', phase: 'activate', message: 'boom' });
    expect(errEl.hidden).toBe(false);
    errEl.click();
    expect(document.querySelector('.fh-plugin-error-row')?.textContent).toContain('ext-sample');

    updateEmitter.dispose();
    errEmitter.dispose();
    notify.dispose();
    h.cleanup();
  });

  it('hides notify item when unsupported and renders interactive device preferences section', async () => {
    const notify = makeFakeNotifyBridge({ supported: false, available: false });
    const onResetLayout = vi.fn();
    const h = await setupHarness({
      deps: { notify, onResetLayout },
    });
    h.storage.setRaw('aa_layout', '{"v":1}');

    const els = mountStatusBarItems(h.registry.listStatusBar());
    expect(els.get('status.notify')?.hidden).toBe(true);

    const section = h.registry.getSettingsSection('device-preferences')!;
    const panel = section.component();
    document.body.appendChild(panel.element);
    const initCtx = { id: 'device-preferences' } as unknown as Parameters<typeof panel.init>[1];
    panel.init(undefined, initCtx);

    // Switch calm via device preferences form switch
    const calmSwitch = panel.element.querySelector<HTMLButtonElement>('#fh-pref-calm');
    expect(calmSwitch?.getAttribute('aria-checked')).toBe('false');
    calmSwitch?.click();
    expect(h.appEl.classList.contains('calm')).toBe(true);
    expect(calmSwitch?.getAttribute('aria-checked')).toBe('true');

    // Notifications switch is disabled when unsupported
    const notifySwitch = panel.element.querySelector<HTMLButtonElement>('#fh-pref-notify');
    expect(notifySwitch?.disabled).toBe(true);

    // Reset layout clears storage and fires callback
    const resetBtn = panel.element.querySelector<HTMLButtonElement>('[data-action="reset-layout"]');
    resetBtn?.click();
    expect(h.storage.getRaw('aa_layout')).toBeNull();
    expect(onResetLayout).toHaveBeenCalledTimes(1);

    panel.dispose();
    notify.dispose();
    h.cleanup();
  });

  it('cleans up all contributions, dialogs, and listeners on deactivate/dispose', async () => {
    const notify = makeFakeNotifyBridge();
    const h = await setupHarness({
      topics: [{ id: 'idle-1', title: 'Idle', lastAt: 1, live: true }],
      deps: { notify },
    });
    const els = mountStatusBarItems(h.registry.listStatusBar());
    (els.get('status.idle') as HTMLButtonElement).click();
    expect(document.querySelector('.fh-dialog')).not.toBeNull();

    h.manager.deactivate('status');

    expect(h.registry.listStatusBar()).toHaveLength(0);
    expect(h.registry.getSettingsSection('device-preferences')).toBeUndefined();
    expect(h.registry.commands.has('status.closeIdle')).toBe(false);
    expect(h.registry.commands.has('status.toggleCalm')).toBe(false);
    expect(h.registry.commands.has('status.cycleTheme')).toBe(false);
    expect(h.registry.commands.has('status.cycleLocale')).toBe(false);
    expect(h.registry.commands.has('status.toggleNotify')).toBe(false);
    expect(document.querySelector('.fh-dialog')).toBeNull();

    notify.dispose();
    h.cleanup();
  });
});
