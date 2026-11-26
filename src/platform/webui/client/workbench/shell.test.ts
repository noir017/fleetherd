// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { ContributionRegistry } from '../plugins/registry.js';
import { CommandRegistry } from '../services/commands.js';
import { KeybindingService } from '../services/keybindings.js';
import { StorageService } from '../services/storage.js';
import type { PanelComponent } from './contracts.js';
import { LAYOUT_COMMAND_IDS } from './dock/layout-commands.js';
import {
  LAYOUT_STORAGE_KEY,
  mountWorkbench,
  resolveShellMode,
  WorkbenchShell,
} from './shell.js';

function makeMemoryStorage(initial: Record<string, string> = {}): StorageService {
  const map = new Map<string, string>(Object.entries(initial));
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

function makePanel(tag: string): PanelComponent {
  const element = document.createElement('div');
  element.textContent = tag;
  return {
    element,
    init: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('workbench/shell', () => {
  it('resolves three width breakpoints accurately', () => {
    expect(resolveShellMode(1440)).toBe('desktop');
    expect(resolveShellMode(1024)).toBe('desktop');
    expect(resolveShellMode(1023)).toBe('tablet');
    expect(resolveShellMode(640)).toBe('tablet');
    expect(resolveShellMode(639)).toBe('mobile');
    expect(resolveShellMode(390)).toBe('mobile');
  });

  it('mounts workbench directly into #workbench-root without any dev flag and binds ContributionRegistry', () => {
    document.body.innerHTML = '<div id="workbench-root"></div>';
    const registry = new ContributionRegistry();
    const shell = mountWorkbench(document, {
      storage: makeMemoryStorage(),
      registry,
      initialWidth: 1400,
      initialHeight: 900,
    });
    expect(shell).not.toBeNull();

    registry.registerView({
      id: 'topics',
      title: 'Topics',
      part: 'sidebar',
      component: () => makePanel('topics-view'),
    });
    registry.registerActivity({
      id: 'topics',
      title: 'Topics',
      icon: 'chat',
      view: 'topics',
      order: 10,
      badge: () => 3,
    });
    registry.registerEditor({
      kind: 'topic',
      title: (input) => `Chat ${(input as { id: string }).id}`,
      component: () => makePanel('topic-editor'),
    });
    registry.registerStatusBar({
      id: 'conn',
      align: 'left',
      order: 1,
      render: (el) => {
        el.textContent = 'Connected';
      },
    });

    expect(document.querySelector('.wb-activity-item .wb-badge')?.textContent).toBe('3');
    expect(document.querySelector('[data-status-id="conn"]')?.textContent).toBe('Connected');
    registry.openEditor('topic', { id: 't1' });
    expect(shell?.editors.active()?.id).toContain('editor:topic:');

    shell?.dispose();
    registry.dispose();
  });

  it('auto-collapses primary sidebar on desktop when opening secondary would leave editor < 640px and restores on close', () => {
    const root = document.createElement('div');
    const storage = makeMemoryStorage();
    const shell = new WorkbenchShell({
      root,
      doc: document,
      storage,
      initialWidth: 1200,
      initialHeight: 800,
    });

    expect(shell.getMode()).toBe('desktop');
    expect(shell.isPartVisible('sidebar')).toBe(true);
    expect(shell.isPartVisible('secondary')).toBe(false);

    shell.setPartVisible('secondary', true);
    expect(shell.isPartVisible('secondary')).toBe(true);
    expect(shell.isPartVisible('sidebar')).toBe(false);

    shell.setPartVisible('secondary', false);
    expect(shell.isPartVisible('secondary')).toBe(false);
    expect(shell.isPartVisible('sidebar')).toBe(true);

    shell.layout(1500, 800);
    shell.setPartVisible('secondary', true);
    expect(shell.isPartVisible('sidebar')).toBe(true);
    expect(shell.isPartVisible('secondary')).toBe(true);

    shell.dispose();
  });

  it('switches cleanly between desktop, tablet drawers, and mobile slide-out drawer', () => {
    const root = document.createElement('div');
    const storage = makeMemoryStorage();
    const shell = new WorkbenchShell({
      root,
      doc: document,
      storage,
      initialWidth: 1400,
      initialHeight: 900,
    });

    const modes: string[] = [];
    shell.onDidModeChange((m) => modes.push(m));

    shell.layout(800, 900);
    expect(shell.getMode()).toBe('tablet');
    expect(root.dataset.wbMode).toBe('tablet');
    const backdrop = root.querySelector('.wb-drawer-backdrop') as HTMLElement;
    expect(shell.isPartVisible('sidebar')).toBe(false);
    expect(backdrop.hidden).toBe(true);

    shell.setPartVisible('sidebar', true);
    expect(backdrop.hidden).toBe(false);

    backdrop.click();
    expect(shell.isPartVisible('sidebar')).toBe(false);
    expect(backdrop.hidden).toBe(true);

    shell.layout(390, 844);
    expect(shell.getMode()).toBe('mobile');
    expect(root.dataset.wbMode).toBe('mobile');
    const desktopShell = root.querySelector('.wb-shell') as HTMLElement;
    expect(desktopShell.hidden).toBe(false);
    expect(root.querySelector('.wb-stack')).toBeNull();
    expect(shell.isPartVisible('sidebar')).toBe(false);
    expect(backdrop.hidden).toBe(true);

    shell.setPartVisible('sidebar', true);
    expect(desktopShell.classList.contains('is-sidebar-open')).toBe(true);
    expect(backdrop.hidden).toBe(false);
    expect(shell.mobileTabBar.element.hidden).toBe(false);
    expect(shell.activityBar.element.inert).toBe(true);

    const moreTab = root.querySelector<HTMLButtonElement>('.wb-stack-tab[data-tab-id="more"]');
    moreTab?.click();
    expect(shell.views.active('sidebar')).toBe('more');

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(shell.isPartVisible('sidebar')).toBe(false);
    expect(desktopShell.classList.contains('is-sidebar-open')).toBe(false);
    expect(backdrop.hidden).toBe(true);

    shell.layout(1400, 900);
    expect(desktopShell.hidden).toBe(false);
    expect(shell.mobileTabBar.element.hidden).toBe(true);
    expect(shell.activityBar.element.inert).toBe(false);
    expect(modes).toEqual(['tablet', 'mobile', 'desktop']);

    shell.dispose();
  });

  it('exposes high-level views, editors, tools, activity bar, and status bar APIs', () => {
    const root = document.createElement('div');
    const shell = new WorkbenchShell({
      root,
      doc: document,
      storage: makeMemoryStorage(),
      initialWidth: 1500,
      initialHeight: 900,
    });

    shell.views.register({
      id: 'topics',
      title: 'Topics',
      part: 'sidebar',
      component: () => makePanel('topics-list'),
    });
    shell.activity.register({
      id: 'act-topics',
      title: 'Topics',
      icon: 'chat',
      view: 'topics',
      badge: () => 2,
    });
    shell.editors.register({
      kind: 'topic',
      title: (input) => `Topic ${(input as { name: string }).name}`,
      component: () => makePanel('topic-editor'),
    });
    shell.tools.register({
      id: 'changes',
      title: 'Changes',
      icon: 'git',
      defaultPart: 'secondary',
      available: () => true,
      component: () => makePanel('changes-tool'),
    });
    const statusClick = vi.fn();
    shell.statusBarApi.register({
      id: 'conn',
      align: 'left',
      order: 1,
      render: (el) => {
        el.textContent = 'Connected';
      },
      onClick: statusClick,
    });

    const viewRef = shell.views.reveal('topics');
    expect(viewRef?.id).toBe('topics');
    expect(root.querySelector('.wb-activity-item .wb-badge')?.textContent).toBe('2');

    const edRef = shell.editors.open('topic', { name: 'Alpha' }, { id: 'topic:alpha' });
    expect(edRef?.id).toBe('topic:alpha');
    expect(shell.editors.active()?.id).toBe('topic:alpha');

    expect(shell.tools.toggle('changes')).toBe(true);
    expect(shell.isPartVisible('secondary')).toBe(true);
    expect(shell.tools.toggle('changes')).toBe(false);
    expect(shell.isPartVisible('secondary')).toBe(false);

    const statusBtn = root.querySelector('[data-status-id="conn"]') as HTMLButtonElement;
    expect(statusBtn.textContent).toBe('Connected');
    statusBtn.click();
    expect(statusClick).toHaveBeenCalledTimes(1);

    shell.dispose();
  });

  it('uses DynamicDockEngine, forwards onDidActiveTopicChange, and persists/restores aa_layout with corrupt fallback', async () => {
    const storage = makeMemoryStorage({ [LAYOUT_STORAGE_KEY]: '{not-valid-json' });
    const root = document.createElement('div');
    const commands = new CommandRegistry();
    const keybindings = new KeybindingService({
      executeCommand: (id, ...args) => commands.execute(id, ...args),
      isMac: false,
    });
    const shell = new WorkbenchShell({
      root,
      doc: document,
      storage,
      commands,
      keybindings,
      initialWidth: 1440,
      initialHeight: 900,
    });

    // Corrupt aa_layout was cleaned up on init and default layout kept.
    expect(storage.getRaw(LAYOUT_STORAGE_KEY)).toBeNull();
    expect(shell.isPartVisible('sidebar')).toBe(true);
    expect(shell.dock.getAllowSplit()).toBe(true);

    const activeTopics: Array<string | undefined> = [];
    shell.onDidActiveTopicChange((id) => activeTopics.push(id));

    shell.views.register({
      id: 'topics',
      title: 'Topics',
      part: 'sidebar',
      component: () => makePanel('topics-view'),
    });
    shell.editors.register({
      kind: 'topic',
      title: (input) => `Topic ${(input as { topicId: string }).topicId}`,
      component: () => makePanel('topic-editor'),
    });

    shell.views.reveal('topics');
    shell.editors.open('topic', { topicId: 't1' }, { id: 'ed:t1' });
    shell.editors.open('topic', { topicId: 't2' }, { id: 'ed:t2' });
    expect(activeTopics).toEqual(['t1', 't2']);
    expect(shell.getActiveTopicId()).toBe('t2');

    // Split editor right via Ctrl+\ shortcut.
    expect(keybindings.handleKeydown({ key: '\\', ctrlKey: true })).toBe(true);
    await Promise.resolve();
    expect(shell.dock.getGroups().length).toBe(2);
    expect(storage.getRaw(LAYOUT_STORAGE_KEY)).not.toBeNull();

    // Focus group 1 via Ctrl+1 -> active topic switches back to t1.
    expect(keybindings.handleKeydown({ key: '1', ctrlKey: true })).toBe(true);
    await Promise.resolve();
    expect(shell.getActiveTopicId()).toBe('t1');

    shell.dispose();

    // New shell instance with same storage auto-restores split groups and panels.
    const root2 = document.createElement('div');
    const shell2 = new WorkbenchShell({
      root: root2,
      doc: document,
      storage,
      initialWidth: 1440,
      initialHeight: 900,
    });
    shell2.views.register({
      id: 'topics',
      title: 'Topics',
      part: 'sidebar',
      component: () => makePanel('topics-view-2'),
    });
    shell2.editors.register({
      kind: 'topic',
      title: (input) => `Topic ${(input as { topicId: string }).topicId}`,
      component: () => makePanel('topic-editor-2'),
    });
    shell2.views.reveal('topics');

    expect(shell2.dock.getGroups().length).toBe(2);
    expect(shell2.dock.getPanel('ed:t1')).toBeDefined();
    expect(shell2.dock.getPanel('ed:t2')).toBeDefined();

    shell2.dispose();
    commands.dispose();
  });

  it('enforces tablet mode (<1024px) by disabling splits, collapsing split groups, and keeping tab ordering', async () => {
    const notices: string[] = [];
    const commands = new CommandRegistry();
    const keybindings = new KeybindingService({
      executeCommand: (id, ...args) => commands.execute(id, ...args),
      isMac: false,
    });
    const registry = new ContributionRegistry({ commands, keybindings });
    const root = document.createElement('div');
    const shell = new WorkbenchShell({
      root,
      doc: document,
      storage: makeMemoryStorage(),
      registry,
      notify: (msg) => notices.push(msg),
      initialWidth: 1440,
      initialHeight: 900,
    });

    shell.editors.register({
      kind: 'topic',
      title: (input) => `Topic ${(input as { topicId: string }).topicId}`,
      component: () => makePanel('topic-editor'),
    });
    shell.editors.open('topic', { topicId: 'a' }, { id: 'ed:a' });
    shell.editors.open('topic', { topicId: 'b' }, { id: 'ed:b' });

    expect(await commands.execute(LAYOUT_COMMAND_IDS.splitEditor)).toBe(true);
    expect(shell.dock.getGroups().length).toBe(2);

    // Resize to tablet (<1024px): splits disabled and groups collapsed into one.
    shell.layout(800, 900);
    expect(shell.getMode()).toBe('tablet');
    expect(shell.dock.getAllowSplit()).toBe(false);
    expect(shell.dock.getGroups().length).toBe(1);

    // Split command is blocked with a notice in tablet mode.
    expect(await commands.execute(LAYOUT_COMMAND_IDS.splitEditor)).toBe(false);
    expect(shell.dock.getGroups().length).toBe(1);
    expect(notices.length).toBe(1);

    // Tab reordering still works in tablet mode.
    const group = shell.dock.getGroups()[0]!;
    const before = [...group.getPanelIds()];
    shell.dock.movePanel(before[0]!, { group: group.id, direction: 'within', index: 2 });
    expect([...group.getPanelIds()]).toEqual([before[1], before[0]]);

    shell.dispose();
    registry.dispose();
    commands.dispose();
  });

  it('wires Move to... view menu on part headers and resets moved views and splits via resetLayout', async () => {
    document.body.innerHTML = '';
    const commands = new CommandRegistry();
    const keybindings = new KeybindingService({
      executeCommand: (id, ...args) => commands.execute(id, ...args),
      isMac: false,
    });
    const registry = new ContributionRegistry({ commands, keybindings });
    const storage = makeMemoryStorage();
    const root = document.createElement('div');
    document.body.appendChild(root);

    const shell = new WorkbenchShell({
      root,
      doc: document,
      storage,
      registry,
      initialWidth: 1440,
      initialHeight: 900,
    });

    shell.views.register({
      id: 'topics',
      title: 'Topics',
      part: 'sidebar',
      component: () => makePanel('topics-view'),
    });
    shell.views.reveal('topics');

    const moreBtn = root.querySelector<HTMLButtonElement>('.wb-sidebar .wb-part-more');
    expect(moreBtn).not.toBeNull();
    expect(moreBtn!.hidden).toBe(false);

    moreBtn!.click();
    const menu = document.querySelector<HTMLElement>('.wb-view-move-menu');
    expect(menu).not.toBeNull();
    expect(menu!.hidden).toBe(false);

    const movePanelBtn = menu!.querySelector<HTMLButtonElement>(
      `[data-menu-id="${LAYOUT_COMMAND_IDS.moveViewToPanel}"]`,
    );
    expect(movePanelBtn).not.toBeNull();
    movePanelBtn!.click();
    await Promise.resolve();

    expect(shell.dock.getPanel('topics')?.group).toBe('panel');
    expect(shell.isPartVisible('panel')).toBe(true);

    // Reset layout command clears aa_layout and restores view back to sidebar.
    expect(await commands.execute(LAYOUT_COMMAND_IDS.resetLayout)).toBe(true);
    expect(storage.getRaw(LAYOUT_STORAGE_KEY)).toBeNull();
    expect(shell.dock.getPanel('topics')?.group).toBe('sidebar');
    expect(shell.isPartVisible('sidebar')).toBe(true);
    expect(shell.isPartVisible('panel')).toBe(false);

    shell.dispose();
    registry.dispose();
    commands.dispose();
  });

  it('opens secondary pane at 480px default width', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const storage = makeMemoryStorage();
    const shell = new WorkbenchShell({ root, storage, initialWidth: 1440, initialHeight: 900 });

    shell.setPartVisible('secondary', true);
    expect(shell.secondary.element.style.width).toBe('480px');

    shell.dispose();
  });

  it('remembers sidebar, secondary, and bottom panel sizes across hide/show toggles and reload', () => {
    const storage = makeMemoryStorage();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const shell = new WorkbenchShell({ root, storage, initialWidth: 1440, initialHeight: 900 });
    shell.views.register({
      id: 'topics',
      title: 'Topics',
      part: 'sidebar',
      component: () => makePanel('topics-view'),
    });
    shell.views.reveal('topics');

    shell.dock.setPartSize('sidebar', 380);
    expect(shell.sidebar.element.style.width).toBe('380px');

    // Hide then re-show sidebar -> must restore 380px rather than shrinking to minSize (180px).
    shell.setPartVisible('sidebar', false);
    expect(shell.isPartVisible('sidebar')).toBe(false);
    shell.setPartVisible('sidebar', true);
    expect(shell.sidebar.element.style.width).toBe('380px');
    expect(shell.dock.getPartSize('sidebar')).toBe(380);

    // Same for secondary sidebar.
    shell.setPartVisible('secondary', true);
    shell.dock.setPartSize('secondary', 410);
    expect(shell.secondary.element.style.width).toBe('410px');
    shell.setPartVisible('secondary', false);
    shell.setPartVisible('secondary', true);
    expect(shell.secondary.element.style.width).toBe('410px');
    expect(shell.dock.getPartSize('secondary')).toBe(410);

    // Same for bottom panel height.
    shell.setPartVisible('panel', true);
    shell.panel.setHeight(310);
    shell.setPartVisible('panel', false);
    shell.setPartVisible('panel', true);
    expect(shell.panel.element.style.height).toBe('310px');
    expect(shell.dock.getPartSize('panel')).toBe(310);

    // Collapse sidebar, reload into a fresh shell, then re-expand -> still 380px.
    shell.setPartVisible('sidebar', false);
    shell.dispose();
    root.remove();

    const root2 = document.createElement('div');
    document.body.appendChild(root2);
    const shell2 = new WorkbenchShell({ root: root2, storage, initialWidth: 1440, initialHeight: 900 });
    shell2.views.register({
      id: 'topics',
      title: 'Topics',
      part: 'sidebar',
      component: () => makePanel('topics-view-2'),
    });
    const restored = shell2.restoreLayout();
    expect(restored).toBe(true);
    shell2.views.reveal('topics', { openPart: !restored && shell2.getMode() !== 'tablet' });
    expect(shell2.isPartVisible('sidebar')).toBe(false);
    expect(shell2.panel.element.style.height).toBe('310px');
    shell2.setPartVisible('sidebar', true);
    expect(shell2.sidebar.element.style.width).toBe('380px');

    shell2.dispose();
    root2.remove();
  });
});
