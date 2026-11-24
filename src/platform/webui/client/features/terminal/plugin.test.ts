// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { Emitter } from '../../base/event.js';
import type { TopicInfo, TopicToolContribution } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, WebuiEventBus } from '../../plugins/registry.js';
import { createApiClient } from '../../services/api.js';
import { StorageService } from '../../services/storage.js';
import {
  createTerminalPlugin,
  TERMINAL_CLOSE_TAB_COMMAND,
  TERMINAL_EDITOR_KIND,
  TERMINAL_END_SESSION_COMMAND,
  TERMINAL_MOVE_TO_PANEL_COMMAND,
  TERMINAL_MOVE_TO_SECONDARY_COMMAND,
  TERMINAL_NEW_TAB_COMMAND,
  TERMINAL_OPEN_IN_EDITOR_COMMAND,
  TERMINAL_PLUGIN_ID,
  TERMINAL_RENAME_TAB_COMMAND,
  TERMINAL_TOGGLE_COMMAND,
  TERMINAL_TOOL_ID,
  type TerminalPluginDeps,
} from './plugin.js';

type PanelComponent = ReturnType<TopicToolContribution['component']>;
type PanelInitContext = Parameters<PanelComponent['init']>[1];
type PanelRef = PanelInitContext['api'];

function makeMemoryStorage(): StorageService {
  const map = new Map<string, string>();
  return new StorageService('', {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  });
}

function makePanelContext(
  id = 'tool:terminal',
  initialGroup: string = 'panel',
): {
  readonly ctx: PanelInitContext;
  readonly close: ReturnType<typeof vi.fn>;
  readonly setTitle: ReturnType<typeof vi.fn>;
  readonly setVisibility: (visible: boolean) => void;
  readonly setGroup: (group: string) => void;
} {
  const visibility = new Emitter<boolean>();
  const dimensions = new Emitter<{ readonly width: number; readonly height: number }>();
  const close = vi.fn();
  const setTitle = vi.fn();
  let group = initialGroup;
  const api: PanelRef = {
    id,
    get group() {
      return group;
    },
    params: undefined,
    onDidVisibilityChange: visibility.event,
    onDidDimensionsChange: dimensions.event,
    setTitle,
    setBadge: vi.fn(),
    focus: vi.fn(),
    close,
  };
  return {
    ctx: { id, api },
    close,
    setTitle,
    setVisibility: (visible: boolean) => visibility.fire(visible),
    setGroup: (nextGroup: string) => {
      group = nextGroup;
      dimensions.fire({ width: 320, height: 600 });
    },
  };
}

function makeHarness(
  depsOverrides: TerminalPluginDeps = {},
  initialTopics: TopicInfo[] = [
    { id: 't1', title: 'Alpha Topic', lastAt: 100 },
    { id: 't2', title: 'Beta Topic', lastAt: 200 },
  ],
) {
  let topics = [...initialTopics];
  let activeId: string | undefined = topics[0]?.id;
  const registry = new ContributionRegistry();
  const events = new WebuiEventBus();
  const storage = makeMemoryStorage();
  const post = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
  const confirmFn = vi.fn(() => true);
  const alertFn = vi.fn();

  const manager = new PluginManager({
    registry,
    events,
    topics: {
      list: () => topics,
      active: () => topics.find((t) => t.id === activeId),
      open: (id) => {
        activeId = id;
      },
      insertIntoComposer: vi.fn(),
    },
    api: createApiClient(),
    storage,
  });

  const plugin = createTerminalPlugin({
    boot: { terminal: true, terminalEnd: true },
    post,
    storage,
    confirmFn,
    alertFn,
    ...depsOverrides,
  });

  manager.register(plugin, { builtin: true });

  return {
    manager,
    registry,
    events,
    post,
    confirmFn,
    alertFn,
    setActiveTopic: (id: string | undefined) => {
      activeId = id;
      const topic = topics.find((t) => t.id === id);
      events.emit('topic.active', { id, topic });
    },
    setTopics: (next: TopicInfo[]) => {
      topics = [...next];
      events.emit('topic.list', { topics });
    },
  };
}

describe('features/terminal/plugin', () => {
  it('registers terminal topic tool in panel part and gates availability by boot.terminal and topic', async () => {
    const enabled = makeHarness({ boot: { terminal: true, terminalEnd: true } });
    expect(await enabled.manager.activate(TERMINAL_PLUGIN_ID)).toBe(true);

    const tool = enabled.registry.getTopicTool(TERMINAL_TOOL_ID);
    expect(tool).toBeDefined();
    expect(tool?.defaultPart).toBe('panel');
    expect(tool?.icon).toBe('terminal');
    expect(tool?.available({ id: 't1', title: 'Alpha', lastAt: 1 })).toBe(true);
    expect(tool?.available({ id: '   ', title: 'Blank', lastAt: 1 })).toBe(false);
    enabled.manager.dispose();

    const disabled = makeHarness({ boot: { terminal: false, terminalEnd: false } });
    expect(await disabled.manager.activate(TERMINAL_PLUGIN_ID)).toBe(true);
    const disabledTool = disabled.registry.getTopicTool(TERMINAL_TOOL_ID);
    expect(disabledTool?.available({ id: 't1', title: 'Alpha', lastAt: 1 })).toBe(false);
    expect(await disabled.registry.executeCommand(TERMINAL_TOGGLE_COMMAND)).toBe(false);
    disabled.manager.dispose();
  });

  it('switches per-topic ttyd iframes on topic change without destroying background sessions', async () => {
    const h = makeHarness();
    await h.manager.activate(TERMINAL_PLUGIN_ID);

    const tool = h.registry.getTopicTool(TERMINAL_TOOL_ID)!;
    const comp = tool.component();
    const panel = makePanelContext();
    comp.init(undefined, panel.ctx);

    const framesAfterT1 = comp.element.querySelectorAll('iframe');
    expect(framesAfterT1).toHaveLength(1);
    expect(framesAfterT1[0]?.getAttribute('src')).toBe('term/?arg=t1');
    expect(framesAfterT1[0]?.classList.contains('on')).toBe(true);
    expect(comp.element.querySelector('.term-name')?.textContent).toBe('Alpha Topic');

    h.setActiveTopic('t2');
    const framesAfterT2 = comp.element.querySelectorAll('iframe');
    expect(framesAfterT2).toHaveLength(2);
    expect(framesAfterT2[0]?.getAttribute('src')).toBe('term/?arg=t1');
    expect(framesAfterT2[0]?.classList.contains('on')).toBe(false);
    expect(framesAfterT2[0]?.hasAttribute('inert')).toBe(true);
    expect(framesAfterT2[1]?.getAttribute('src')).toBe('term/?arg=t2');
    expect(framesAfterT2[1]?.classList.contains('on')).toBe(true);
    expect(comp.element.querySelector('.term-name')?.textContent).toBe('Beta Topic');

    // Switching back reuses existing t1 iframe without recreating it.
    const t1Frame = framesAfterT2[0];
    h.setActiveTopic('t1');
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(2);
    expect(t1Frame?.classList.contains('on')).toBe(true);

    // Pruning removed topics drops only deleted topic iframes.
    h.setTopics([{ id: 't1', title: 'Alpha Topic', lastAt: 100 }]);
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(1);
    expect(comp.element.querySelector('iframe')?.getAttribute('src')).toBe('term/?arg=t1');

    comp.dispose();
    h.manager.dispose();
  });

  it('preserves running iframe across minimize and panel close, and cleans up on plugin dispose', async () => {
    const minimizePanel = vi.fn();
    const h = makeHarness({ minimizePanel });
    await h.manager.activate(TERMINAL_PLUGIN_ID);

    const tool = h.registry.getTopicTool(TERMINAL_TOOL_ID)!;
    const comp1 = tool.component();
    const panel1 = makePanelContext();
    comp1.init(undefined, panel1.ctx);

    const minBtn = comp1.element.querySelector<HTMLButtonElement>('.wb-term-min')!;
    expect(minBtn.querySelector('svg')).not.toBeNull();
    minBtn.click();
    expect(minimizePanel).toHaveBeenCalledTimes(1);
    expect(comp1.element.querySelectorAll('iframe')).toHaveLength(1);
    expect(comp1.element.querySelector('iframe')?.classList.contains('on')).toBe(false);

    // Disposing panel component and remounting preserves the same background iframe instance.
    const originalIframe = comp1.element.querySelector('iframe');
    comp1.dispose();

    const comp2 = tool.component();
    const panel2 = makePanelContext();
    comp2.init(undefined, panel2.ctx);
    expect(comp2.element.querySelector('iframe')).toBe(originalIframe);
    expect(originalIframe?.classList.contains('on')).toBe(true);

    panel2.setVisibility(false);
    expect(originalIframe?.classList.contains('on')).toBe(false);
    panel2.setVisibility(true);
    expect(originalIframe?.classList.contains('on')).toBe(true);

    // Deactivating the plugin removes contributions and tears down iframes.
    h.manager.deactivate(TERMINAL_PLUGIN_ID);
    expect(h.registry.getTopicTool(TERMINAL_TOOL_ID)).toBeUndefined();
    expect(comp2.element.querySelectorAll('iframe')).toHaveLength(0);
    h.manager.dispose();
  });

  it('registers terminal.toggle and terminal.endSession commands', async () => {
    const toggleTool = vi.fn(() => true);
    const h = makeHarness({ toggleTool });
    await h.manager.activate(TERMINAL_PLUGIN_ID);

    const tool = h.registry.getTopicTool(TERMINAL_TOOL_ID)!;
    const comp = tool.component();
    comp.init(undefined, makePanelContext().ctx);

    expect(await h.registry.executeCommand(TERMINAL_TOGGLE_COMMAND)).toBe(true);
    expect(toggleTool).toHaveBeenCalledWith('t1');

    const ended = await h.registry.executeCommand(TERMINAL_END_SESSION_COMMAND);
    expect(ended).toBe(true);
    expect(h.confirmFn).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith('api/terminal/end', { topic: 't1' }, 0);
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(0);

    comp.dispose();
    h.manager.dispose();
  });

  it('supports creating, switching, and closing multiple terminal tabs per topic with iframe cleanup', async () => {
    const h = makeHarness();
    await h.manager.activate(TERMINAL_PLUGIN_ID);

    const tool = h.registry.getTopicTool(TERMINAL_TOOL_ID)!;
    const comp = tool.component();
    comp.init(undefined, makePanelContext().ctx);

    // Initial primary tab mounted.
    expect(comp.element.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(1);

    // Create a second tab via toolbar "+" button and a third via command.
    comp.element.querySelector<HTMLButtonElement>('.wb-term-new')!.click();
    expect(comp.element.querySelectorAll('[role="tab"]')).toHaveLength(2);
    const frames2 = comp.element.querySelectorAll('iframe');
    expect(frames2).toHaveLength(2);
    expect(frames2[0]?.getAttribute('src')).toBe('term/?arg=t1');
    expect(frames2[0]?.classList.contains('on')).toBe(false);
    expect(frames2[0]?.hasAttribute('inert')).toBe(true);
    expect(frames2[1]?.getAttribute('src')).toBe('term/?arg=t1&tab=t1%3A2');
    expect(frames2[1]?.classList.contains('on')).toBe(true);

    await h.registry.executeCommand(TERMINAL_NEW_TAB_COMMAND);
    expect(comp.element.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(3);

    // Switch back to first tab by clicking its tab button.
    const firstTabBtn = comp.element.querySelector<HTMLButtonElement>('[data-tab-id="t1:1"]')!;
    firstTabBtn.click();
    expect(firstTabBtn.getAttribute('aria-selected')).toBe('true');
    expect(comp.element.querySelector<HTMLIFrameElement>('iframe[data-tab-id="t1:1"]')?.classList.contains('on')).toBe(true);
    expect(comp.element.querySelector<HTMLIFrameElement>('iframe[data-tab-id="t1:2"]')?.classList.contains('on')).toBe(false);

    // Close second tab via its close button -> its iframe is removed.
    const closeBtns = comp.element.querySelectorAll<HTMLButtonElement>('.fh-tab-close');
    closeBtns[1]!.click();
    expect(comp.element.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(comp.element.querySelector('iframe[data-tab-id="t1:2"]')).toBeNull();
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(2);

    // Close remaining tabs via command -> empty state shown, zero iframes left.
    expect(await h.registry.executeCommand(TERMINAL_CLOSE_TAB_COMMAND, 't1:1')).toBe(true);
    expect(await h.registry.executeCommand(TERMINAL_CLOSE_TAB_COMMAND)).toBe(true);
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(0);
    expect(comp.element.querySelector<HTMLElement>('.wb-term-empty')?.hidden).toBe(false);

    // Clicking empty-state button opens a fresh terminal tab.
    comp.element.querySelector<HTMLButtonElement>('.wb-term-empty-new')!.click();
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(1);
    expect(comp.element.querySelector<HTMLElement>('.wb-term-empty')?.hidden).toBe(true);

    comp.dispose();
    h.manager.dispose();
  });

  it('renames terminal tabs via double-click and context menu, supporting Enter to save and Esc to cancel', async () => {
    const h = makeHarness();
    await h.manager.activate(TERMINAL_PLUGIN_ID);

    const tool = h.registry.getTopicTool(TERMINAL_TOOL_ID)!;
    const comp = tool.component();
    document.body.appendChild(comp.element);
    comp.init(undefined, makePanelContext().ctx);

    // Double-click tab to start inline rename and save with Enter.
    const tabBtn = comp.element.querySelector<HTMLButtonElement>('[data-tab-id="t1:1"]')!;
    tabBtn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input1 = comp.element.querySelector<HTMLInputElement>('.wb-term-rename-input')!;
    expect(input1).not.toBeNull();
    expect(input1.value).toBe('Alpha Topic');
    input1.value = 'Server Logs';
    input1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(comp.element.querySelector('.wb-term-rename-input')).toBeNull();
    expect(comp.element.querySelector('[data-tab-id="t1:1"] .fh-tab-label')?.textContent).toBe('Server Logs');
    expect(comp.element.querySelector('.term-name')?.textContent).toBe('Server Logs');
    expect(comp.element.querySelector('iframe[data-tab-id="t1:1"]')?.getAttribute('title')).toBe('Server Logs');

    // Double-click again and cancel with Escape -> original name preserved.
    comp.element
      .querySelector<HTMLButtonElement>('[data-tab-id="t1:1"]')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input2 = comp.element.querySelector<HTMLInputElement>('.wb-term-rename-input')!;
    input2.value = 'Should Not Save';
    input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(comp.element.querySelector('.wb-term-rename-input')).toBeNull();
    expect(comp.element.querySelector('[data-tab-id="t1:1"] .fh-tab-label')?.textContent).toBe('Server Logs');

    // Right-click opens context menu and Rename item starts inline edit.
    comp.element
      .querySelector<HTMLButtonElement>('[data-tab-id="t1:1"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));
    const renameMenuItem = document.body.querySelector<HTMLButtonElement>('.wb-term-menu [data-menu-id="rename"]')!;
    expect(renameMenuItem).not.toBeNull();
    renameMenuItem.click();
    expect(comp.element.querySelector('.wb-term-rename-input')).not.toBeNull();

    // Command-based rename updates immediately.
    expect(await h.registry.executeCommand(TERMINAL_RENAME_TAB_COMMAND, 't1:1', 'Build Watcher')).toBe(true);
    expect(comp.element.querySelector('[data-tab-id="t1:1"] .fh-tab-label')?.textContent).toBe('Build Watcher');

    comp.dispose();
    comp.element.remove();
    h.manager.dispose();
  });

  it('moves terminal between bottom panel and secondary sidebar and opens in right split editor', async () => {
    const h = makeHarness();
    const moveToSecondary = vi.fn(() => true);
    const moveToPanel = vi.fn(() => true);
    const openEditor = vi.fn();

    h.registry.registerCommand('workbench.action.moveViewToSecondary', moveToSecondary);
    h.registry.registerCommand('workbench.action.moveViewToPanel', moveToPanel);
    h.registry.setEditorOpener(openEditor);

    await h.manager.activate(TERMINAL_PLUGIN_ID);

    const tool = h.registry.getTopicTool(TERMINAL_TOOL_ID)!;
    const comp = tool.component();
    const panel = makePanelContext('tool:terminal', 'panel');
    comp.init(undefined, panel.ctx);

    // Click move-right button -> executes workbench.action.moveViewToSecondary.
    comp.element.querySelector<HTMLButtonElement>('.wb-term-move-right')!.click();
    await Promise.resolve();
    expect(moveToSecondary).toHaveBeenCalledWith('tool:terminal');

    // Simulate DockEngine moving panel to secondary sidebar.
    panel.setGroup('secondary');
    expect(comp.element.getAttribute('data-dock-part')).toBe('secondary');

    // Clicking move button again moves back to bottom panel.
    comp.element.querySelector<HTMLButtonElement>('.wb-term-move-right')!.click();
    await Promise.resolve();
    expect(moveToPanel).toHaveBeenCalledWith('tool:terminal');

    // Direct commands work as well.
    expect(await h.registry.executeCommand(TERMINAL_MOVE_TO_SECONDARY_COMMAND)).toBe(true);
    expect(await h.registry.executeCommand(TERMINAL_MOVE_TO_PANEL_COMMAND)).toBe(true);

    // Open in editor (split right) via toolbar button and command.
    comp.element.querySelector<HTMLButtonElement>('.wb-term-open-editor')!.click();
    expect(openEditor).toHaveBeenCalledWith(
      TERMINAL_EDITOR_KIND,
      { topicId: 't1', tabId: 't1:1', title: 'Alpha Topic', primary: true },
      { position: { group: 'main', direction: 'right' } },
    );

    expect(await h.registry.executeCommand(TERMINAL_OPEN_IN_EDITOR_COMMAND)).toBe(true);
    expect(openEditor).toHaveBeenCalledTimes(2);

    // Verify registered terminal editor component mounts, renames, and disposes cleanly.
    const editorContrib = h.registry.getEditor(TERMINAL_EDITOR_KIND)!;
    expect(editorContrib).toBeDefined();
    expect(editorContrib.title({ topicId: 't1', title: 'Custom Term' })).toBe('Custom Term');
    const editorComp = editorContrib.component();
    const editorPanel = makePanelContext('editor:terminal:1', 'group-2');
    editorComp.init({ topicId: 't1', tabId: 't1:1', title: 'Alpha Topic', primary: true }, editorPanel.ctx);

    const editorFrame = editorComp.element.querySelector('iframe');
    expect(editorFrame?.getAttribute('src')).toBe('term/?arg=t1');
    expect(editorFrame?.classList.contains('on')).toBe(true);

    // Inline rename inside editor updates panel title and syncs back to tab store.
    editorComp.element.querySelector<HTMLButtonElement>('.wb-term-editor-rename')!.click();
    const editorInput = editorComp.element.querySelector<HTMLInputElement>('.wb-term-rename-input')!;
    editorInput.value = 'Split Shell';
    editorInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(editorPanel.setTitle).toHaveBeenCalledWith('Split Shell');
    expect(comp.element.querySelector('[data-tab-id="t1:1"] .fh-tab-label')?.textContent).toBe('Split Shell');

    // Visibility toggle and dispose clean up editor iframe.
    editorPanel.setVisibility(false);
    expect(editorFrame?.classList.contains('on')).toBe(false);
    editorComp.dispose();
    expect(editorComp.element.querySelectorAll('iframe')).toHaveLength(0);

    // Plugin dispose cleans up all DOM, menus, and iframes.
    comp.dispose();
    h.manager.dispose();
    expect(document.body.querySelector('.wb-term-menu')).toBeNull();
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(0);
  });
});
