// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SettingsScreen } from '../../../../../types.js';
import { Emitter } from '../../base/event.js';
import type { SettingsSectionContribution, TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, WebuiEventBus } from '../../plugins/registry.js';
import { createApiClient } from '../../services/api.js';
import { StorageService } from '../../services/storage.js';
import {
  createSettingsPlugin,
  SETTINGS_EDITOR_ID,
  type SettingsPluginBridge,
  type SettingsPluginDeps,
} from './plugin.js';
import type { SettingsWebMessage } from './types.js';
import type { WorkbenchPanelInitContext } from './workbench-types.js';

function makePanelInitCtx(id: string): {
  ctx: WorkbenchPanelInitContext;
  setTitle: ReturnType<typeof vi.fn>;
  setBadge: ReturnType<typeof vi.fn>;
} {
  const onVis = new Emitter<boolean>();
  const onDim = new Emitter<{ readonly width: number; readonly height: number }>();
  const setTitle = vi.fn();
  const setBadge = vi.fn();
  return {
    setTitle,
    setBadge,
    ctx: {
      id,
      api: {
        id,
        group: 'main',
        params: undefined,
        onDidVisibilityChange: onVis.event,
        onDidDimensionsChange: onDim.event,
        setTitle,
        setBadge,
        focus: vi.fn(),
        close: vi.fn(),
      },
    },
  };
}

function baseMsg(overrides: Partial<SettingsWebMessage> & { id: string }): SettingsWebMessage {
  return { own: false, html: '', at: 0, buttons: [], reactions: [], ...overrides };
}

function listMessage(id = 'm1'): SettingsWebMessage {
  const settings: SettingsScreen = {
    level: 'list',
    groups: [{ name: 'General' }, { name: 'Agents' }],
    rows: [
      {
        group: 'General',
        label: 'Feature',
        buttonId: 'sw:1',
        control: { kind: 'switch', on: false, set: 'sts:1:1' },
      },
      {
        group: 'Agents',
        label: 'agent-alpha',
        target: 'agent-alpha',
        targetKind: 'Claude Code',
        buttonId: 'stg:agent-alpha',
        control: {
          kind: 'agent',
          fields: [{ label: 'Model', buttonId: 'stg:agent-alpha:m', value: 'sonnet', control: { kind: 'list' } }],
        },
      },
    ],
  };
  return baseMsg({ id, settings });
}

interface TestHarnessOptions {
  readonly instrOk?: boolean;
  readonly topics?: readonly TopicInfo[];
  readonly activeTopic?: TopicInfo;
  readonly listDeviceSections?: () => readonly SettingsSectionContribution[];
}

async function makeHarness(options: TestHarnessOptions = {}) {
  const registry = new ContributionRegistry();
  const events = new WebuiEventBus();
  const storage = new StorageService();
  const openedEditors: Array<{ kind: string; input: unknown; opts?: unknown }> = [];
  registry.setEditorOpener((kind, input, opts) => {
    openedEditors.push({ kind, input, opts });
  });

  const topics: readonly TopicInfo[] = options.topics ?? [
    { id: 'topic-1', title: 'Alpha', lastAt: 1000 },
  ];
  const activeTopic = options.activeTopic ?? topics[0];

  const postCalls: Array<{ path: string; body: unknown; tries?: number; limit?: number }> = [];
  let postImpl = async (_path: string, _body: unknown): Promise<Response> =>
    new Response('{}', { status: 200 });

  let bridge: SettingsPluginBridge | undefined;

  const manager = new PluginManager({
    registry,
    events,
    storage,
    api: createApiClient(),
    topics: {
      list: () => topics,
      active: () => activeTopic,
      open: vi.fn(),
      insertIntoComposer: vi.fn(),
    },
  });

  const deps: SettingsPluginDeps = {
    instrOk: options.instrOk ?? false,
    listDeviceSections: options.listDeviceSections ?? (() => registry.listSettingsSections()),
    onDidChangeDeviceSections: registry.onDidChangeSettings,
    post: (path, body, tries, limit) => {
      postCalls.push({ path, body, tries, limit });
      return postImpl(path, body);
    },
    fadeMs: 50,
    waitMs: 100,
    onReady: (b) => {
      bridge = b;
    },
  };

  const pluginReg = manager.register(createSettingsPlugin(deps), { builtin: true });
  await manager.activate('settings');

  return {
    registry,
    events,
    manager,
    pluginReg,
    openedEditors,
    postCalls,
    getBridge: () => bridge!,
    setPostImpl: (fn: (path: string, body: unknown) => Promise<Response>) => {
      postImpl = fn;
    },
    cleanup: () => {
      pluginReg.dispose();
      manager.dispose();
      registry.dispose();
      events.dispose();
    },
  };
}

describe('features/settings/plugin', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('registers activity, sidebar view, settings & instruction editors, command, and cleans up on dispose', async () => {
    const h = await makeHarness();

    expect(h.registry.getActivity('settings')).toMatchObject({
      id: 'settings',
      icon: 'gear',
      view: 'settings',
    });
    expect(h.registry.getView('settings')).toMatchObject({
      id: 'settings',
      part: 'sidebar',
    });
    expect(h.registry.getEditor('settings')?.kind).toBe('settings');
    expect(h.registry.getEditor('instruction')?.kind).toBe('instruction');

    await h.registry.executeCommand('settings.open', { scope: 'gateway', sectionId: 'Agents' });
    expect(h.openedEditors).toEqual([
      { kind: 'settings', input: { scope: 'gateway', sectionId: 'Agents' }, opts: { id: SETTINGS_EDITOR_ID } },
    ]);

    h.pluginReg.dispose();
    expect(h.registry.getActivity('settings')).toBeUndefined();
    expect(h.registry.getView('settings')).toBeUndefined();
    expect(h.registry.getEditor('settings')).toBeUndefined();
    expect(h.registry.getEditor('instruction')).toBeUndefined();

    h.cleanup();
  });

  it('renders gateway and device sections in catalog view, filters them, and opens editor on click', async () => {
    const h = await makeHarness();
    const devDisp = h.registry.registerSettingsSection({
      id: 'device-notify',
      title: 'Notifications',
      scope: 'device',
      component: () => ({
        element: document.createElement('div'),
        init() {},
        dispose() {},
      }),
    });

    const view = h.registry.getView('settings')!;
    const catalog = view.component();
    document.body.appendChild(catalog.element);
    catalog.init(undefined, makePanelInitCtx('view:settings').ctx);

    // Before gateway screen arrives, fallback "All settings" + device section appear.
    expect(catalog.element.textContent).toContain('Notifications');

    // Once gateway settings message arrives, gateway groups and agent count badge populate.
    h.getBridge().handleMessage(listMessage('m1'));
    expect(catalog.element.textContent).toContain('General');
    expect(catalog.element.textContent).toContain('Agents');
    expect(catalog.element.textContent).toContain('Notifications');

    // Click device section -> opens settings editor targeting that device section.
    const rows = Array.from(catalog.element.querySelectorAll<HTMLElement>('[role="option"]'));
    const notifyRow = rows.find((r) => r.textContent?.includes('Notifications'));
    expect(notifyRow).toBeDefined();
    notifyRow!.click();
    expect(h.openedEditors[h.openedEditors.length - 1]).toEqual({
      kind: 'settings',
      input: { scope: 'device', sectionId: 'device-notify' },
      opts: { id: SETTINGS_EDITOR_ID },
    });

    // Click gateway section -> opens settings editor targeting Agents.
    const agentsRow = rows.find((r) => r.textContent?.includes('Agents'));
    expect(agentsRow).toBeDefined();
    agentsRow!.click();
    expect(h.openedEditors[h.openedEditors.length - 1]).toEqual({
      kind: 'settings',
      input: { scope: 'gateway', sectionId: 'Agents' },
      opts: { id: SETTINGS_EDITOR_ID },
    });

    // Search filters catalog rows locally.
    const input = catalog.element.querySelector<HTMLInputElement>('.wb-set-cat-input')!;
    input.value = 'notif';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const filtered = catalog.element.querySelectorAll('[role="option"]');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.textContent).toContain('Notifications');

    catalog.dispose();
    devDisp.dispose();
    h.cleanup();
  });

  it('reuses gateway settingsScreen, accordion, optimistic rollback, locale reload, and mounts device sections', async () => {
    const devDispose = vi.fn();
    const devInit = vi.fn();
    const h = await makeHarness();

    const devSecDisp = h.registry.registerSettingsSection({
      id: 'device-appearance',
      title: 'Appearance',
      scope: 'device',
      component: () => {
        const el = document.createElement('div');
        el.className = 'dev-appearance-body';
        el.textContent = 'Theme controls';
        return {
          element: el,
          init: devInit,
          dispose: devDispose,
        };
      },
    });

    const editor = h.registry.getEditor('settings')!.component();
    document.body.appendChild(editor.element);
    editor.init({ scope: 'device', sectionId: 'device-appearance' }, makePanelInitCtx('editor:settings:1').ctx);

    // Requested quiet /setting from daemon on init.
    expect(h.postCalls).toHaveLength(1);
    expect(h.postCalls[0]!.path).toBe('api/send');
    expect(h.postCalls[0]!.body).toMatchObject({ topic: 'topic-1', text: '/setting', quiet: true });

    // Device section mounted and initialized.
    expect(devInit).toHaveBeenCalledTimes(1);
    expect(editor.element.querySelector('.dev-appearance-body')?.textContent).toBe('Theme controls');
    expect(editor.element.querySelector('[data-section-id="device-appearance"]')?.classList.contains('is-target')).toBe(
      true,
    );

    // Deliver gateway SettingsScreen via topic.message event.
    h.events.emit('topic.message', { topicId: 'topic-1', message: listMessage('m1') });
    expect(editor.element.querySelector('.set-switch')).not.toBeNull();

    // Agent accordion toggle works.
    const agTop = editor.element.querySelector<HTMLButtonElement>('.ag-top')!;
    expect(agTop.getAttribute('aria-expanded')).toBe('false');
    agTop.click();
    expect(agTop.getAttribute('aria-expanded')).toBe('true');

    // Optimistic toggle and rollback on 409.
    h.setPostImpl(async () => new Response('', { status: 409 }));
    const sw = editor.element.querySelector<HTMLButtonElement>('.set-switch')!;
    sw.click();
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await vi.waitFor(() => {
      expect(editor.element.querySelector('.set-notice.error')).not.toBeNull();
    });
    expect(editor.element.querySelector('.set-switch')!.getAttribute('aria-checked')).toBe('false');

    // Locale change triggers settings reload.
    const beforeLocaleCalls = h.postCalls.length;
    h.events.emit('locale.change', { locale: 'zh-CN' });
    expect(h.postCalls.length).toBe(beforeLocaleCalls + 1);
    expect(h.postCalls[h.postCalls.length - 1]!.path).toBe('api/send');

    // Unregistering device section disposes its mounted component.
    devSecDisp.dispose();
    expect(devDispose).toHaveBeenCalledTimes(1);
    expect(editor.element.querySelector('.dev-appearance-body')).toBeNull();

    editor.dispose();
    h.cleanup();
  });

  it('ignores non-device sections defensively and blocks instruction requests when instrOk is false', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const fakeGatewaySection = {
      id: 'evil-gateway',
      title: 'Gateway Hack',
      scope: 'gateway',
      component: () => ({
        element: document.createElement('div'),
        init() {},
        dispose() {},
      }),
    } as unknown as SettingsSectionContribution;

    const h = await makeHarness({
      instrOk: false,
      listDeviceSections: () => [fakeGatewaySection],
    });

    const settingsEditor = h.registry.getEditor('settings')!.component();
    document.body.appendChild(settingsEditor.element);
    settingsEditor.init({}, makePanelInitCtx('editor:settings:guard').ctx);
    expect(settingsEditor.element.querySelector('[data-section-id="evil-gateway"]')).toBeNull();

    const instrEditor = h.registry.getEditor('instruction')!.component();
    document.body.appendChild(instrEditor.element);
    instrEditor.init({ agent: 'agent-alpha' }, makePanelInitCtx('editor:instruction:off').ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(instrEditor.element.querySelector<HTMLTextAreaElement>('.wb-instr-text')!.hidden).toBe(true);
    expect(instrEditor.element.querySelector<HTMLButtonElement>('.wb-instr-save')!.disabled).toBe(true);

    settingsEditor.dispose();
    instrEditor.dispose();
    h.cleanup();
  });

  it('opens instruction editor from agent card, marks delivered copies read-only, and enforces version check + explicit force on conflict', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s === 'api/instructions') {
        return new Response(
          JSON.stringify({
            on: true,
            dir: '/tmp/instr',
            global: [{ name: 'common.md', layer: 'common', reach: 'all agents', exists: true, agents: ['agent-alpha'] }],
            agents: [{ id: 'agent-alpha', own: 'AGENTS.md', host: 'local' }],
          }),
          { status: 200 },
        );
      }
      if (s.startsWith('api/instructions/refs?agent=agent-alpha')) {
        return new Response(
          JSON.stringify({
            host: 'local',
            summary: 'AGENTS.md',
            root: 'AGENTS.md',
            rootState: 'own',
            refs: [
              {
                path: '/home/dev/AGENTS.md',
                shown: 'AGENTS.md',
                exists: true,
                editable: false,
                note: 'delivered copy',
                depth: 1,
                kind: 'rule',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (s.startsWith('api/instructions/read?scope=global&name=common.md')) {
        return new Response(
          JSON.stringify({
            text: '# Common\nInitial',
            mtimeMs: 12345,
            size: 16,
            sha256: 'abc123',
            eol: 'lf',
            missing: false,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const h = await makeHarness({ instrOk: true });
    const settingsEditor = h.registry.getEditor('settings')!.component();
    document.body.appendChild(settingsEditor.element);
    settingsEditor.init({}, makePanelInitCtx('editor:settings:instr').ctx);
    h.events.emit('topic.message', { topicId: 'topic-1', message: listMessage('m1') });

    // Wait for instructions list to load and render into agent card.
    await vi.waitFor(() => {
      expect(settingsEditor.element.querySelector('[data-instr-file="g:common.md"]')).not.toBeNull();
    });

    // Click instruction file entry in agent card -> opens 'instruction' editor via ctx.editors.open.
    settingsEditor.element.querySelector<HTMLButtonElement>('[data-instr-file="g:common.md"]')!.click();
    expect(h.openedEditors).toHaveLength(1);
    expect(h.openedEditors[0]!.kind).toBe('instruction');

    // Mount the instruction editor with the opened input.
    const instrEditor = h.registry.getEditor('instruction')!.component();
    document.body.appendChild(instrEditor.element);
    instrEditor.init(h.openedEditors[0]!.input, makePanelInitCtx('editor:instruction:1').ctx);

    await vi.waitFor(() => {
      const ta = instrEditor.element.querySelector<HTMLTextAreaElement>('.wb-instr-text')!;
      expect(ta.hidden).toBe(false);
      expect(ta.value).toBe('# Common\nInitial');
    });

    // Delivered copy (editable: false) is rendered as read-only .fx-off (not a button[data-fx-file]).
    const roRow = instrEditor.element.querySelector('.wb-instr-tree .fx-row.fx-off');
    expect(roRow).not.toBeNull();
    expect(roRow!.textContent).toContain('AGENTS.md');
    expect(instrEditor.element.querySelector('button[data-fx-file="a:/home/dev/AGENTS.md"]')).toBeNull();

    // Edit content and save -> first response is 409 conflict.
    const ta = instrEditor.element.querySelector<HTMLTextAreaElement>('.wb-instr-text')!;
    ta.value = '# Common\nUpdated';
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    h.setPostImpl(async () => new Response(JSON.stringify({ conflict: true, exists: true }), { status: 409 }));
    instrEditor.element.querySelector<HTMLButtonElement>('.wb-instr-save')!.click();

    await vi.waitFor(() => {
      expect(instrEditor.element.querySelector<HTMLElement>('.wb-instr-conflict')!.hidden).toBe(false);
    });

    // Normal save MUST send version check fields and MUST NOT send force: true.
    const firstWrite = h.postCalls.find((c) => c.path === 'api/instructions/write');
    expect(firstWrite?.body).toEqual({
      scope: 'global',
      name: 'common.md',
      text: '# Common\nUpdated',
      mtimeMs: 12345,
      size: 16,
      sha256: 'abc123',
    });

    // Clicking explicit Overwrite sends force: true and clears conflict banner on success.
    h.setPostImpl(async () =>
      new Response(
        JSON.stringify({
          mtimeMs: 67890,
          size: 16,
          sha256: 'def456',
          delivery: [{ host: 'local', agents: ['agent-alpha'], outcome: 'linked' }],
        }),
        { status: 200 },
      ),
    );
    instrEditor.element.querySelector<HTMLButtonElement>('.wb-instr-overwrite')!.click();

    await vi.waitFor(() => {
      expect(instrEditor.element.querySelector<HTMLElement>('.wb-instr-conflict')!.hidden).toBe(true);
    });
    const writes = h.postCalls.filter((c) => c.path === 'api/instructions/write');
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual({
      scope: 'global',
      name: 'common.md',
      text: '# Common\nUpdated',
      force: true,
    });
    expect(instrEditor.element.querySelector<HTMLElement>('.wb-instr-note')!.textContent).toContain('common.md');

    instrEditor.dispose();
    settingsEditor.dispose();
    h.cleanup();
  });

  it('reuses singleton editor id, shows gateway and device together, and deduplicates update scrolling', async () => {
    const h = await makeHarness();
    const devDisp = h.registry.registerSettingsSection({
      id: 'device-prefs',
      title: 'Preferences',
      scope: 'device',
      component: () => {
        const el = document.createElement('div');
        el.textContent = 'Device prefs body';
        return { element: el, init() {}, dispose() {} };
      },
    });

    const editorDef = h.registry.getEditor('settings')!;
    expect(editorDef.title({ scope: 'gateway', sectionId: 'Agents' })).toBe(
      editorDef.title({ scope: 'device', sectionId: 'device-prefs' }),
    );

    const editor = editorDef.component();
    document.body.appendChild(editor.element);
    const panelInit = makePanelInitCtx(SETTINGS_EDITOR_ID);
    editor.init({ scope: 'device', sectionId: 'device-prefs' }, panelInit.ctx);
    h.events.emit('topic.message', { topicId: 'topic-1', message: listMessage('m1') });

    // Unified page displays both gateway and device sections and keeps refresh button visible.
    expect(editor.element.querySelector<HTMLElement>('.wb-set-gateway')!.hidden).toBe(false);
    expect(editor.element.querySelector<HTMLElement>('.wb-set-device')!.hidden).toBe(false);
    expect(editor.element.querySelector<HTMLButtonElement>('.wb-set-refresh')!.hidden).toBe(false);
    expect(editor.element.dataset.settingsScope).toBeUndefined();

    // Simulate DynamicDockEngine reusing the singleton panel and calling editor.update(input).
    const pageEl = editor.element.querySelector<HTMLElement>('.wb-set-page')!;
    const scrollToSpy = vi.fn();
    pageEl.scrollTo = scrollToSpy;
    h.registry.setEditorOpener((kind, input, opts) => {
      h.openedEditors.push({ kind, input, opts });
      if (kind === 'settings') editor.update?.(input);
    });

    await h.registry.executeCommand('settings.open', { scope: 'gateway', sectionId: 'Agents' });
    expect(h.openedEditors[h.openedEditors.length - 1]).toEqual({
      kind: 'settings',
      input: { scope: 'gateway', sectionId: 'Agents' },
      opts: { id: SETTINGS_EDITOR_ID },
    });
    // update() already scrolled once; openSettings() must not trigger a duplicate scroll.
    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    editor.dispose();
    devDisp.dispose();
    h.cleanup();
  });

  it('retains pending scroll target until gateway loads and clears active filters when jumping to hidden section', async () => {
    const h = await makeHarness();
    const devDisp = h.registry.registerSettingsSection({
      id: 'device-prefs',
      title: 'Preferences',
      scope: 'device',
      component: () => {
        const el = document.createElement('div');
        el.textContent = 'Device prefs body';
        return { element: el, init() {}, dispose() {} };
      },
    });

    const editor = h.registry.getEditor('settings')!.component();
    document.body.appendChild(editor.element);
    const pageEl = editor.element.querySelector<HTMLElement>('.wb-set-page')!;
    const scrollToSpy = vi.fn();
    pageEl.scrollTo = scrollToSpy;

    // Open targeting a gateway section before gateway data arrives.
    editor.init({ scope: 'gateway', sectionId: 'Agents' }, makePanelInitCtx(SETTINGS_EDITOR_ID).ctx);
    expect(scrollToSpy).not.toHaveBeenCalled();

    // Once gateway message arrives, editor scrolls to Agents and clears pending target.
    h.events.emit('topic.message', { topicId: 'topic-1', message: listMessage('m1') });
    expect(scrollToSpy).toHaveBeenCalledTimes(1);
    const agentsSec = Array.from(editor.element.querySelectorAll<HTMLElement>('.set-sec')).find(
      (sec) => sec.querySelector('.set-group')?.textContent?.trim() === 'Agents',
    )!;
    expect(agentsSec.classList.contains('is-target')).toBe(true);

    // Subsequent gateway message does not re-scroll because pending target was cleared.
    h.events.emit('topic.message', { topicId: 'topic-1', message: listMessage('m1') });
    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    // Filter hides device section; jumping to device section clears filter and scrolls to it.
    const searchInput = editor.element.querySelector<HTMLInputElement>('.wb-set-search-input')!;
    searchInput.value = 'Feature';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editor.element.querySelector<HTMLElement>('.wb-set-device')!.hidden).toBe(true);

    editor.update?.({ scope: 'device', sectionId: 'device-prefs' });
    expect(searchInput.value).toBe('');
    expect(editor.element.querySelector<HTMLElement>('.wb-set-device')!.hidden).toBe(false);
    expect(editor.element.querySelector('[data-section-id="device-prefs"]')?.classList.contains('is-target')).toBe(
      true,
    );
    expect(scrollToSpy).toHaveBeenCalledTimes(2);

    editor.dispose();
    devDisp.dispose();
    h.cleanup();
  });

  it('syncs catalog selection via scroll-spy, handles bottom reach and click lock, without rebuilding catalog DOM', async () => {
    vi.useFakeTimers();
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const flushRaf = (): void => {
      while (rafQueue.length > 0) rafQueue.shift()?.(0);
    };

    const h = await makeHarness();
    const devDisp = h.registry.registerSettingsSection({
      id: 'device-prefs',
      title: 'Preferences',
      scope: 'device',
      component: () => {
        const el = document.createElement('div');
        el.textContent = 'Device prefs body';
        return { element: el, init() {}, dispose() {} };
      },
    });

    const catalog = h.registry.getView('settings')!.component();
    document.body.appendChild(catalog.element);
    catalog.init(undefined, makePanelInitCtx('view:settings').ctx);

    const editor = h.registry.getEditor('settings')!.component();
    document.body.appendChild(editor.element);
    editor.init({}, makePanelInitCtx(SETTINGS_EDITOR_ID).ctx);
    h.events.emit('topic.message', { topicId: 'topic-1', message: listMessage('m1') });

    // Default initial highlight selects the first visible section (General).
    const getSelectedText = (): string | null =>
      catalog.element.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.textContent?.trim() ?? null;
    expect(getSelectedText()).toContain('General');

    // Capture existing DOM node reference to verify scroll-spy does not rebuild the list.
    const agentsRowBefore = Array.from(catalog.element.querySelectorAll<HTMLElement>('[role="option"]')).find((r) =>
      r.textContent?.includes('Agents'),
    )!;

    const pageEl = editor.element.querySelector<HTMLElement>('.wb-set-page')!;
    const sections = Array.from(editor.element.querySelectorAll<HTMLElement>('.set-sec'));
    const generalSec = sections[0]!;
    const agentsSec = sections[1]!;
    const deviceSec = editor.element.querySelector<HTMLElement>('.wb-set-device-sec')!;

    let scrollTop = 0;
    const clientHeight = 400;
    const scrollHeight = 1000;
    Object.defineProperty(pageEl, 'scrollTop', { get: () => scrollTop, set: (v: number) => { scrollTop = v; }, configurable: true });
    Object.defineProperty(pageEl, 'clientHeight', { get: () => clientHeight, configurable: true });
    Object.defineProperty(pageEl, 'scrollHeight', { get: () => scrollHeight, configurable: true });
    const makeRect = (top: number, height: number): DOMRect =>
      ({ x: 0, y: top, top, left: 0, right: 800, bottom: top + height, width: 800, height, toJSON: () => ({}) }) as DOMRect;
    pageEl.getBoundingClientRect = () => makeRect(0, clientHeight);

    let generalTop = 0;
    let agentsTop = 300;
    let deviceTop = 700;
    generalSec.getBoundingClientRect = () => makeRect(generalTop, 280);
    agentsSec.getBoundingClientRect = () => makeRect(agentsTop, 380);
    deviceSec.getBoundingClientRect = () => makeRect(deviceTop, 120);

    // Scroll down to Agents -> catalog highlights Agents without recreating row DOM.
    scrollTop = 300;
    generalTop = -300;
    agentsTop = 0;
    deviceTop = 400;
    pageEl.dispatchEvent(new Event('scroll'));
    flushRaf();
    expect(getSelectedText()).toContain('Agents');
    const agentsRowAfter = Array.from(catalog.element.querySelectorAll<HTMLElement>('[role="option"]')).find((r) =>
      r.textContent?.includes('Agents'),
    )!;
    expect(agentsRowAfter).toBe(agentsRowBefore);

    // Scroll to bottom -> highlights last visible section (Preferences) even if top > threshold.
    scrollTop = 600;
    generalTop = -600;
    agentsTop = -300;
    deviceTop = 280;
    pageEl.dispatchEvent(new Event('scroll'));
    flushRaf();
    expect(getSelectedText()).toContain('Preferences');

    // Clicking General engages programmatic scroll lock (450ms) so intermediate scroll does not flicker highlight back.
    const generalRow = Array.from(catalog.element.querySelectorAll<HTMLElement>('[role="option"]')).find((r) =>
      r.textContent?.includes('General'),
    )!;
    generalRow.click();
    expect(getSelectedText()).toContain('General');

    // Scroll event while locked is ignored.
    pageEl.dispatchEvent(new Event('scroll'));
    flushRaf();
    expect(getSelectedText()).toContain('General');

    // Manual wheel immediately unlocks scroll-spy.
    pageEl.dispatchEvent(new Event('wheel'));
    pageEl.dispatchEvent(new Event('scroll'));
    flushRaf();
    expect(getSelectedText()).toContain('Preferences');

    // Lock expires automatically after 450ms as well.
    generalRow.click();
    expect(getSelectedText()).toContain('General');
    vi.advanceTimersByTime(460);
    pageEl.dispatchEvent(new Event('scroll'));
    flushRaf();
    expect(getSelectedText()).toContain('Preferences');

    editor.dispose();
    catalog.dispose();
    devDisp.dispose();
    h.cleanup();
  });
});
