// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../base/event.js';
import { setLocale } from '../../i18n/index.js';
import type { TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { OverlayManager } from '../../services/overlays.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import type { ComposerController } from './composer/types.js';
import type { TopicEditorHandle, TopicPanelInitContext, TopicPanelRef } from './editor/index.js';
import { createTopicPlugin, TOPIC_COMMANDS, TOPIC_EDITOR_KIND, TOPIC_PLUGIN_ID } from './plugin.js';
import type { TopicStatusController } from './status/index.js';
import type { TranscriptController } from './transcript/index.js';

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

function makePanelInitContext(id: string): {
  ctx: TopicPanelInitContext;
  titles: string[];
  setTitle: ReturnType<typeof vi.fn>;
} {
  const titles: string[] = [];
  const vis = new Emitter<boolean>();
  const dims = new Emitter<{ readonly width: number; readonly height: number }>();
  const setTitle = vi.fn((title: string) => {
    titles.push(title);
  });
  const api: TopicPanelRef = {
    id,
    group: 'main',
    params: undefined,
    onDidVisibilityChange: vis.event,
    onDidDimensionsChange: dims.event,
    setTitle,
    setBadge: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  };
  return { ctx: { id, api }, titles, setTitle };
}

function makeMockSubControllers() {
  const transcriptDispose = vi.fn();
  const resetForTopicSwitch = vi.fn();
  const statusDispose = vi.fn();
  const closeModelPop = vi.fn();
  const composerDispose = vi.fn();
  const stashDraft = vi.fn();
  const loadDraft = vi.fn();
  const grow = vi.fn();
  const suggest = vi.fn();
  const command = vi.fn();
  const copyTopicRef = vi.fn();

  const transcript = {
    resetForTopicSwitch,
    dispose: transcriptDispose,
  } as unknown as TranscriptController;

  const status = {
    closeModelPop,
    dispose: statusDispose,
  } as unknown as TopicStatusController;

  const composer = {
    stashDraft,
    loadDraft,
    grow,
    suggest,
    command,
    copyTopicRef,
    dispose: composerDispose,
  } as unknown as ComposerController;

  return {
    transcript,
    status,
    composer,
    spies: {
      transcriptDispose,
      resetForTopicSwitch,
      statusDispose,
      closeModelPop,
      composerDispose,
      stashDraft,
      loadDraft,
      grow,
      suggest,
      command,
      copyTopicRef,
    },
  };
}

interface TestHarness {
  registry: ContributionRegistry;
  events: WebuiEventBus;
  manager: PluginManager;
  overlays: OverlayManager;
  topics: TopicInfo[];
  activeId: string;
  insertHandler: ((topicId: string, text: string) => boolean) | null;
  topicsBridge: PluginTopicsBridge;
  openEditor: ReturnType<typeof vi.fn>;
  getJson: ReturnType<typeof vi.fn>;
}

function makeHarness(initialTopics: TopicInfo[]): TestHarness {
  const openEditor = vi.fn();
  const registry = new ContributionRegistry({ openEditor });
  const events = new WebuiEventBus();
  const overlays = new OverlayManager();
  const storage = new StorageService('', makeMemoryStorage());
  const getJson = vi.fn();
  const api = {
    getJson,
    postJson: vi.fn(),
  } as unknown as ApiClient;

  const state: TestHarness = {
    registry,
    events,
    overlays,
    topics: [...initialTopics],
    activeId: initialTopics[0]?.id ?? '',
    insertHandler: null,
    openEditor,
    getJson,
    topicsBridge: {
      list: () => state.topics,
      active: () => state.topics.find((t) => t.id === state.activeId),
      open: (id: string) => {
        state.activeId = id;
      },
      insertIntoComposer: (id: string, text: string) => {
        state.insertHandler?.(id, text);
      },
    },
    manager: null as unknown as PluginManager,
  };

  state.manager = new PluginManager({
    registry,
    events,
    topics: state.topicsBridge,
    api,
    storage,
  });
  return state;
}

describe('features/topic/plugin', () => {
  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('registers editor, menus, and commands via PluginManager and opens with live title updates', async () => {
    const t1: TopicInfo = {
      id: 't-alpha',
      title: 'Alpha task',
      lastAt: 1000,
      running: true,
      live: true,
    };
    const h = makeHarness([t1]);
    const created: TopicEditorHandle[] = [];

    h.manager.register(
      createTopicPlugin({
        registry: h.registry,
        overlays: h.overlays,
        onEditorCreated: (ed) => created.push(ed),
      }),
      { builtin: true },
    );

    const ok = await h.manager.activate(TOPIC_PLUGIN_ID);
    expect(ok).toBe(true);

    const editorContrib = h.registry.getEditor(TOPIC_EDITOR_KIND);
    expect(editorContrib).toBeDefined();
    expect(editorContrib?.title({ topicId: 't-alpha' })).toBe('Alpha task');
    expect(editorContrib?.title('t-alpha')).toBe('Alpha task');

    const panel = editorContrib!.component() as TopicEditorHandle;
    document.body.appendChild(panel.element);
    const { ctx, titles } = makePanelInitContext('editor-1');
    panel.init({ topicId: 't-alpha' }, ctx);

    expect(created).toHaveLength(1);
    expect(titles.at(-1)).toBe('Alpha task');
    expect(panel.els.titleEl.textContent).toBe('Alpha task');
    expect(panel.els.statePillEl.hidden).toBe(false);
    expect(panel.els.stopBtn.hidden).toBe(false);
    expect(panel.els.statusDotHost.querySelector('.fh-dot--ok.is-pulsing')).not.toBeNull();

    // Update topic title via event bus -> panel header & tab title update automatically
    h.topics[0] = { ...t1, title: 'Alpha renamed', running: false };
    h.events.emit('topic.list', { topics: h.topics });

    expect(titles.at(-1)).toBe('Alpha renamed');
    expect(panel.els.titleEl.textContent).toBe('Alpha renamed');
    expect(panel.els.statePillEl.hidden).toBe(true);
    expect(panel.els.stopBtn.hidden).toBe(true);
    expect(panel.els.statusDotHost.querySelector('.fh-dot--live')).not.toBeNull();
    expect(panel.els.statusDotHost.querySelector('.fh-dot--ok')).toBeNull();

    // Stream state updates connection indicator
    h.events.emit('stream.state', { state: 'reconnecting' });
    expect(panel.els.connPillEl.hidden).toBe(false);
    h.events.emit('stream.state', { state: 'open' });
    expect(panel.els.connPillEl.hidden).toBe(true);

    panel.dispose();
    h.manager.dispose();
    h.registry.dispose();
    h.events.dispose();
    h.overlays.dispose();
  });

  it('switches topics via update() without recreating root DOM, stashes/loads drafts, and resets transcript', async () => {
    const t1: TopicInfo = { id: 't-1', title: 'First topic', lastAt: 1000, live: true, running: true };
    const t2: TopicInfo = { id: 't-2', title: 'Second topic', lastAt: 2000, asking: true, live: true };
    const h = makeHarness([t1, t2]);
    const mocks = makeMockSubControllers();
    const onTopicChange = vi.fn();

    h.manager.register(
      createTopicPlugin({
        registry: h.registry,
        overlays: h.overlays,
        onTopicChange,
        controllers: {
          createTranscript: () => mocks.transcript,
          createStatus: () => mocks.status,
          createComposer: () => mocks.composer,
        },
      }),
      { builtin: true },
    );
    await h.manager.activate(TOPIC_PLUGIN_ID);

    const panel = h.registry.getEditor(TOPIC_EDITOR_KIND)!.component() as TopicEditorHandle;
    document.body.appendChild(panel.element);
    const { ctx, titles } = makePanelInitContext('editor-switch');
    panel.init({ topicId: 't-1' }, ctx);

    const rootBefore = panel.element;
    expect(mocks.spies.loadDraft).toHaveBeenCalledWith('t-1');
    expect(panel.els.titleEl.textContent).toBe('First topic');

    panel.update!({ topicId: 't-2' });

    expect(panel.element).toBe(rootBefore);
    expect(panel.getTopicId()).toBe('t-2');
    expect(panel.element.dataset.topicId).toBe('t-2');
    expect(mocks.spies.stashDraft).toHaveBeenCalledWith('t-1');
    expect(mocks.spies.closeModelPop).toHaveBeenCalledTimes(1);
    expect(mocks.spies.resetForTopicSwitch).toHaveBeenCalledWith('t-2');
    expect(mocks.spies.loadDraft).toHaveBeenCalledWith('t-2');
    expect(onTopicChange).toHaveBeenCalledWith('t-2', 't-1');
    expect(titles.at(-1)).toBe('Second topic');
    expect(panel.els.statusDotHost.querySelector('.fh-dot--warn')).not.toBeNull();
    expect(panel.els.stopBtn.hidden).toBe(true);

    // Updating with the same topicId does not reset transcript
    panel.update!({ topicId: 't-2' });
    expect(mocks.spies.resetForTopicSwitch).toHaveBeenCalledTimes(1);

    panel.dispose();
    h.manager.dispose();
    h.registry.dispose();
    h.events.dispose();
    h.overlays.dispose();
  });

  it('renders registered topic tools and dynamically builds the title bar menu via ctx.menus', async () => {
    const runningTopic: TopicInfo = {
      id: 't-busy',
      title: 'Busy topic',
      lastAt: 1000,
      running: true,
      live: true,
      term: true,
    };
    const idleTopic: TopicInfo = {
      id: 't-idle',
      title: 'Idle topic',
      lastAt: 900,
      live: true,
      running: false,
    };
    const h = makeHarness([runningTopic, idleTopic]);
    const onToggleTopicTool = vi.fn();
    const onCopyRef = vi.fn();
    const onForkTopic = vi.fn();
    const onKillAgent = vi.fn();
    const onCloseIdle = vi.fn();
    const onDeleteTopic = vi.fn();

    h.registry.registerTopicTool({
      id: 'changes',
      title: 'Changes',
      icon: 'git',
      defaultPart: 'secondary',
      available: () => true,
      component: () => ({ element: document.createElement('div'), init() {}, dispose() {} }),
    });
    h.registry.registerTopicTool({
      id: 'terminal',
      title: 'Terminal',
      icon: 'terminal',
      defaultPart: 'panel',
      available: (topic) => Boolean(topic.term),
      component: () => ({ element: document.createElement('div'), init() {}, dispose() {} }),
    });

    h.manager.register(
      createTopicPlugin({
        registry: h.registry,
        overlays: h.overlays,
        isToolActive: (toolId) => toolId === 'changes',
        getToolBadge: (toolId) => (toolId === 'changes' ? 3 : null),
        onToggleTopicTool,
        onCopyRef,
        onForkTopic,
        onKillAgent,
        onCloseIdle,
        onDeleteTopic,
      }),
      { builtin: true },
    );
    await h.manager.activate(TOPIC_PLUGIN_ID);

    const panel = h.registry.getEditor(TOPIC_EDITOR_KIND)!.component() as TopicEditorHandle;
    document.body.appendChild(panel.element);
    panel.init({ topicId: 't-busy' }, makePanelInitContext('editor-tools').ctx);

    // Dynamic topic tool buttons
    const toolBtns = panel.els.toolsHost.querySelectorAll<HTMLButtonElement>('.wb-topic-tool-btn');
    expect(toolBtns).toHaveLength(2);
    const firstTool = toolBtns[0]!;
    const secondTool = toolBtns[1]!;
    expect(firstTool.dataset.toolId).toBe('changes');
    expect(firstTool.classList.contains('is-active')).toBe(true);
    expect(firstTool.querySelector('.fh-badge')!.textContent).toBe('3');
    secondTool.click();
    expect(onToggleTopicTool).toHaveBeenCalledWith('terminal', 't-busy');

    // Open title bar ⋯ menu
    panel.els.moreBtn.click();
    const menuEl = document.querySelector<HTMLElement>('.wb-topic-title-menu')!;
    expect(menuEl).not.toBeNull();
    expect(menuEl.hidden).toBe(false);

    const menuItem = (id: string): HTMLButtonElement =>
      menuEl.querySelector<HTMLButtonElement>(`[data-menu-id="${id}"]`)!;
    const forkBtn = menuItem('topic.title.fork');
    const endBtn = menuItem('topic.title.endAgent');
    const idleBtn = menuItem('topic.title.closeIdle');
    const delBtn = menuItem('topic.title.delete');
    expect(forkBtn.disabled).toBe(true);
    expect(endBtn.disabled).toBe(false);
    expect(idleBtn).not.toBeNull();
    expect(delBtn.classList.contains('is-danger')).toBe(true);

    // Click copyRef item
    menuItem('topic.title.copyRef').click();
    expect(onCopyRef).toHaveBeenCalledWith('t-busy');

    // Re-open and click closeIdle & delete
    panel.openTitleMenu();
    menuItem('topic.title.closeIdle').click();
    expect(onCloseIdle).toHaveBeenCalledTimes(1);

    panel.openTitleMenu();
    menuItem('topic.title.delete').click();
    expect(onDeleteTopic).not.toHaveBeenCalled();
    const dlgConfirm = document.querySelector<HTMLButtonElement>('.fh-dialog [data-dialog-action="confirm"]');
    expect(dlgConfirm).not.toBeNull();
    dlgConfirm!.click();
    await Promise.resolve();
    expect(onDeleteTopic).toHaveBeenCalledWith('t-busy');

    // Switch to idle topic -> terminal disappears, fork becomes enabled
    panel.update!({ topicId: 't-idle' });
    const idleToolBtns = panel.els.toolsHost.querySelectorAll<HTMLButtonElement>('.wb-topic-tool-btn');
    expect(idleToolBtns).toHaveLength(1);
    expect(idleToolBtns[0]!.dataset.toolId).toBe('changes');

    panel.openTitleMenu();
    const forkOnIdle = menuItem('topic.title.fork');
    expect(forkOnIdle.disabled).toBe(false);
    forkOnIdle.click();
    expect(onForkTopic).toHaveBeenCalledWith('t-idle');

    panel.dispose();
    h.manager.dispose();
    h.registry.dispose();
    h.events.dispose();
    h.overlays.dispose();
  });

  it('supports insertIntoComposer, commands, message context menu, quickPick, and full dispose cleanup', async () => {
    const t1: TopicInfo = { id: 't-main', title: 'Main work', lastAt: 1000, live: true, running: true };
    const h = makeHarness([t1]);
    const mocks = makeMockSubControllers();
    const copied: string[] = [];
    const selectedModels: Array<[string, string]> = [];

    h.manager.register(
      createTopicPlugin({
        registry: h.registry,
        overlays: h.overlays,
        copyText: (text) => copied.push(text),
        onRegisterInsertHandler: (fn) => {
          h.insertHandler = fn;
        },
        controllers: {
          createTranscript: () => mocks.transcript,
          createStatus: () => mocks.status,
          createComposer: () => mocks.composer,
        },
        quickPick: {
          listModels: async () => [
            { value: 'model-a', name: 'Model A', current: true },
            { value: 'model-b', name: 'Model B', configured: true },
          ],
          selectModel: async (topicId, value) => {
            selectedModels.push([topicId, value]);
          },
        },
      }),
      { builtin: true },
    );
    await h.manager.activate(TOPIC_PLUGIN_ID);

    const panel = h.registry.getEditor(TOPIC_EDITOR_KIND)!.component() as TopicEditorHandle;
    document.body.appendChild(panel.element);
    panel.init({ topicId: 't-main' }, makePanelInitContext('editor-main').ctx);

    // insertIntoComposer via topics bridge (simulating git review comments)
    h.topicsBridge.insertIntoComposer('t-main', 'src/app.ts L10-L12: rename helper');
    expect(panel.els.input.value).toBe('src/app.ts L10-L12: rename helper');
    expect(mocks.spies.grow).toHaveBeenCalled();
    expect(mocks.spies.stashDraft).toHaveBeenCalledWith('t-main');
    expect(document.activeElement).toBe(panel.els.input);

    // Second insert appends on a new line
    panel.insertIntoComposer('Also check edge case');
    expect(panel.els.input.value).toBe('src/app.ts L10-L12: rename helper\nAlso check edge case');

    // Commands
    panel.els.input.blur();
    expect(await h.registry.executeCommand(TOPIC_COMMANDS.focusComposer)).toBe(true);
    expect(document.activeElement).toBe(panel.els.input);

    expect(await h.registry.executeCommand(TOPIC_COMMANDS.stopTurn)).toBe(true);
    expect(mocks.spies.command).toHaveBeenCalledWith('/stop');

    expect(await h.registry.executeCommand(TOPIC_COMMANDS.killAgent)).toBe(true);
    expect(mocks.spies.command).toHaveBeenCalledWith('/kill');

    expect(await h.registry.executeCommand(TOPIC_COMMANDS.copyRef)).toBe(true);
    expect(mocks.spies.copyTopicRef).toHaveBeenCalledWith('t-main');

    // Message context menu
    const msgNode = document.createElement('div');
    msgNode.setAttribute('data-k', 'm-1');
    msgNode.textContent = 'Hello from agent';
    panel.els.log.appendChild(msgNode);
    msgNode.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
    const msgMenu = document.querySelector<HTMLElement>('.wb-topic-message-menu');
    expect(msgMenu?.hidden).toBe(false);
    msgMenu?.querySelector<HTMLButtonElement>('[data-menu-id="topic.message.copy"]')?.click();
    expect(copied).toEqual(['Hello from agent']);

    // QuickPick model switch
    const pickPromise = panel.openModelQuickPick(null);
    await Promise.resolve();
    const qpOption = document.querySelector<HTMLElement>('.fh-qp-row[data-qp-id="model-b"]');
    expect(qpOption).not.toBeNull();
    qpOption?.click();
    expect(await pickPromise).toBe(true);
    expect(selectedModels).toEqual([['t-main', 'model-b']]);

    // Dispose cleans up sub-controllers, menus, and DOM
    panel.dispose();
    expect(mocks.spies.transcriptDispose).toHaveBeenCalledTimes(1);
    expect(mocks.spies.statusDispose).toHaveBeenCalledTimes(1);
    expect(mocks.spies.composerDispose).toHaveBeenCalledTimes(1);
    expect(panel.element.isConnected).toBe(false);
    expect(document.querySelector('.wb-topic-title-menu')).toBeNull();
    expect(document.querySelector('.wb-topic-message-menu')).toBeNull();

    // Plugin deactivation removes all registered contributions
    h.manager.deactivate(TOPIC_PLUGIN_ID);
    expect(h.registry.getEditor(TOPIC_EDITOR_KIND)).toBeUndefined();
    expect(h.registry.listMenuItems('topic.title', t1)).toHaveLength(0);
    expect(h.registry.listMenuItems('message', { topicId: 't-main', messageKey: 'm-1', text: 'x', element: msgNode })).toHaveLength(0);

    h.manager.dispose();
    h.registry.dispose();
    h.events.dispose();
    h.overlays.dispose();
  });

  it('opens turn-changes side-by-side diff via command (single & multi-file) and supports quote menu item', async () => {
    const t1: TopicInfo = { id: 't-diff', title: 'Diff topic', lastAt: 1000, live: true };
    const h = makeHarness([t1]);
    h.registry.registerEditor({
      kind: 'diff',
      title: () => 'Diff',
      component: () => ({ element: document.createElement('div'), init() {}, dispose() {} }),
    });

    h.manager.register(
      createTopicPlugin({
        registry: h.registry,
        overlays: h.overlays,
        onRegisterInsertHandler: (fn) => {
          h.insertHandler = fn;
        },
      }),
      { builtin: true },
    );
    await h.manager.activate(TOPIC_PLUGIN_ID);

    const panel = h.registry.getEditor(TOPIC_EDITOR_KIND)!.component() as TopicEditorHandle;
    document.body.appendChild(panel.element);
    panel.init({ topicId: 't-diff' }, makePanelInitContext('topic-ed-42').ctx);

    // Multi-file turn change opens first file to the right of topic-ed-42 and second in that right group.
    h.getJson.mockResolvedValueOnce({
      ok: true,
      files: [
        { path: 'src/one.ts', status: 'modified' },
        { path: 'src/two.ts', status: 'added' },
      ],
    });
    const openedCount = await h.registry.executeCommand(TOPIC_COMMANDS.openTurnDiff, { topicId: 't-diff', turn: 5 });
    expect(openedCount).toBe(2);
    expect(h.getJson).toHaveBeenCalledWith('/api/turn-changes/status?t=t-diff&turn=5');
    expect(h.openEditor).toHaveBeenNthCalledWith(
      1,
      'diff',
      {
        topicId: 't-diff',
        path: 'src/one.ts',
        ref: 'turn 5',
        source: { title: 'Turn 5 changes', fileUrl: '/api/turn-changes/file?t=t-diff&turn=5' },
      },
      { position: { referencePanel: 'topic-ed-42', direction: 'right' }, preview: false },
    );
    expect(h.openEditor).toHaveBeenNthCalledWith(
      2,
      'diff',
      {
        topicId: 't-diff',
        path: 'src/two.ts',
        ref: 'turn 5',
        source: { title: 'Turn 5 changes', fileUrl: '/api/turn-changes/file?t=t-diff&turn=5' },
      },
      { preview: false },
    );

    // Message context menu includes Quote reply and writes blockquote to composer.
    const msgNode = document.createElement('div');
    msgNode.setAttribute('data-k', 'm-q');
    msgNode.textContent = 'Quoted body';
    panel.els.log.appendChild(msgNode);
    msgNode.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const msgMenu = document.querySelector<HTMLElement>('.wb-topic-message-menu')!;
    msgMenu.querySelector<HTMLButtonElement>('[data-menu-id="topic.message.quote"]')?.click();
    expect(panel.els.input.value).toBe('> Quoted body\n\n');

    panel.dispose();
    h.manager.dispose();
    h.registry.dispose();
    h.events.dispose();
    h.overlays.dispose();
  });

  it('does not intercept touch contextmenu, keeps mouse right-click, and copies selected text when inside the message', async () => {
    const t1: TopicInfo = { id: 't-sel', title: 'Selection topic', lastAt: 1000, live: true };
    const h = makeHarness([t1]);
    const copied: string[] = [];

    h.manager.register(
      createTopicPlugin({
        registry: h.registry,
        overlays: h.overlays,
        copyText: (text) => copied.push(text),
      }),
      { builtin: true },
    );
    await h.manager.activate(TOPIC_PLUGIN_ID);

    const panel = h.registry.getEditor(TOPIC_EDITOR_KIND)!.component() as TopicEditorHandle;
    document.body.appendChild(panel.element);
    panel.init({ topicId: 't-sel' }, makePanelInitContext('editor-sel').ctx);

    const msg1 = document.createElement('div');
    msg1.className = 'm';
    msg1.setAttribute('data-k', '1:m1');
    msg1.innerHTML =
      '<div class="b">' +
      '<p>Alpha beta gamma</p>' +
      '<div class="cb">' +
      '<div class="cb-h"><span class="cb-lang">ts</span><button type="button" class="cb-b" data-cb="wrap">Wrap</button><button type="button" class="cb-b" data-cb="copy">Copy</button></div>' +
      '<pre><code>const a = 1;\n  const b = 2;</code></pre>' +
      '</div>' +
      '<p>Delta epsilon</p>' +
      '</div>' +
      '<div class="t">10:00</div>' +
      '<div class="msg-actions" role="toolbar"><button type="button" class="msg-act-btn" data-msg-act="more" data-msg-k="1:m1">More</button></div>';
    panel.els.log.appendChild(msg1);

    const msg2 = document.createElement('div');
    msg2.className = 'm';
    msg2.setAttribute('data-k', '1:m2');
    msg2.innerHTML = '<div class="b"><p>Second message</p></div>';
    panel.els.log.appendChild(msg2);

    const msgMenu = document.querySelector<HTMLElement>('.wb-topic-message-menu')!;

    // 1. Touch contextmenu carrying pointerType='touch' must not be preventDefault'd or open custom menu.
    const touchEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 });
    Object.defineProperty(touchEv, 'pointerType', { value: 'touch' });
    msg1.querySelector('p')!.dispatchEvent(touchEv);
    expect(touchEv.defaultPrevented).toBe(false);
    expect(msgMenu.hidden).toBe(true);

    // 2. Touch contextmenu without pointerType (e.g. Firefox/WebKit) after a touch pointerdown must also pass through.
    const touchDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(touchDown, 'pointerType', { value: 'touch' });
    Object.defineProperty(touchDown, 'pointerId', { value: 7 });
    msg1.querySelector('p')!.dispatchEvent(touchDown);
    const fallbackTouchCtx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 });
    msg1.querySelector('p')!.dispatchEvent(fallbackTouchCtx);
    expect(fallbackTouchCtx.defaultPrevented).toBe(false);
    expect(msgMenu.hidden).toBe(true);

    // 3. Mouse right-click after a touch interaction still opens the custom menu and prevents default.
    const mouseDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(mouseDown, 'pointerType', { value: 'mouse' });
    msg1.querySelector('p')!.dispatchEvent(mouseDown);
    const mouseCtx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 35 });
    Object.defineProperty(mouseCtx, 'pointerType', { value: 'mouse' });
    msg1.querySelector('p')!.dispatchEvent(mouseCtx);
    expect(mouseCtx.defaultPrevented).toBe(true);
    expect(msgMenu.hidden).toBe(false);

    // 4. Without selection, Copy copies the whole message.
    window.getSelection()?.removeAllRanges();
    msgMenu.querySelector<HTMLButtonElement>('[data-menu-id="topic.message.copy"]')?.click();
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('Alpha beta gamma');
    expect(copied[0]).toContain('Delta epsilon');

    // 5. With selection inside a single text node of msg1, Copy copies only that slice.
    const pText = msg1.querySelector('p')!.firstChild!;
    const r1 = document.createRange();
    r1.setStart(pText, 6);
    r1.setEnd(pText, 10); // "beta"
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r1);

    const mouseCtx2 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 35 });
    Object.defineProperty(mouseCtx2, 'pointerType', { value: 'mouse' });
    msg1.querySelector('p')!.dispatchEvent(mouseCtx2);
    expect(mouseCtx2.defaultPrevented).toBe(true);
    expect(msgMenu.hidden).toBe(false);
    // Even if selection is cleared before click runs (e.g. menu focus), the snapshotted selection is copied.
    sel.removeAllRanges();
    msgMenu.querySelector<HTMLButtonElement>('[data-menu-id="topic.message.copy"]')?.click();
    expect(copied[1]).toBe('beta');

    // 6. Selection spanning paragraph + code block + next paragraph keeps newlines/code and strips UI chrome (Wrap/Copy/lang).
    const r2 = document.createRange();
    r2.setStart(msg1.querySelector('p')!.firstChild!, 0);
    r2.setEnd(msg1.querySelectorAll('p')[1]!.firstChild!, 5); // "Delta"
    sel.removeAllRanges();
    sel.addRange(r2);

    const mouseCtx3 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 35 });
    Object.defineProperty(mouseCtx3, 'pointerType', { value: 'mouse' });
    msg1.querySelector('code')!.dispatchEvent(mouseCtx3);
    msgMenu.querySelector<HTMLButtonElement>('[data-menu-id="topic.message.copy"]')?.click();
    expect(copied[2]).toBe('Alpha beta gamma\nconst a = 1;\n  const b = 2;\nDelta');
    expect(copied[2]).not.toContain('Wrap');
    expect(copied[2]).not.toContain('Copy');
    expect(copied[2]).not.toContain('10:00');
    expect(copied[2]).not.toContain('More');

    // 7. Selection inside another message falls back to copying the right-clicked message in full.
    const r3 = document.createRange();
    r3.setStart(msg2.querySelector('p')!.firstChild!, 0);
    r3.setEnd(msg2.querySelector('p')!.firstChild!, 6);
    sel.removeAllRanges();
    sel.addRange(r3);

    const mouseCtx4 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 35 });
    Object.defineProperty(mouseCtx4, 'pointerType', { value: 'mouse' });
    msg1.querySelector('p')!.dispatchEvent(mouseCtx4);
    msgMenu.querySelector<HTMLButtonElement>('[data-menu-id="topic.message.copy"]')?.click();
    expect(copied[3]).toContain('Alpha beta gamma');
    expect(copied[3]).toContain('Delta epsilon');

    // 8. Selection spanning across two messages does not belong to msg1, so falls back to whole msg1.
    const r4 = document.createRange();
    r4.setStart(msg1.querySelector('p')!.firstChild!, 0);
    r4.setEnd(msg2.querySelector('p')!.firstChild!, 6);
    sel.removeAllRanges();
    sel.addRange(r4);

    const mouseCtx5 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 35 });
    Object.defineProperty(mouseCtx5, 'pointerType', { value: 'mouse' });
    msg1.querySelector('p')!.dispatchEvent(mouseCtx5);
    msgMenu.querySelector<HTMLButtonElement>('[data-menu-id="topic.message.copy"]')?.click();
    expect(copied[4]).toContain('Alpha beta gamma');
    expect(copied[4]).toContain('Delta epsilon');

    // 9. Tapping the message action bar's More button still opens the menu even after a touch interaction.
    sel.removeAllRanges();
    const moreBtn = msg1.querySelector<HTMLButtonElement>('[data-msg-act="more"]')!;
    const touchMoreDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(touchMoreDown, 'pointerType', { value: 'touch' });
    moreBtn.dispatchEvent(touchMoreDown);
    // Simulate TranscriptController forwarding [data-msg-act="more"] via openMessageMenu -> _openMessageMenuFromAnchor
    const openViaAnchor = (panel as unknown as { _openMessageMenuFromAnchor: (k: string, a: HTMLElement) => void })
      ._openMessageMenuFromAnchor;
    openViaAnchor.call(panel, '1:m1', moreBtn);
    expect(msgMenu.hidden).toBe(false);

    panel.dispose();
    h.manager.dispose();
    h.registry.dispose();
    h.events.dispose();
    h.overlays.dispose();
  });
});
