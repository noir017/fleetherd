// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { StorageService } from '../services/storage.js';
import type { PanelComponent } from './contracts.js';
import {
  isWorkbenchEnabled,
  mountWorkbenchIfEnabled,
  resolveShellMode,
  WORKBENCH_FLAG_KEY,
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

  it('respects aa_workbench dev flag and leaves DOM untouched when off', () => {
    document.body.innerHTML = '<main id="app"></main><div id="workbench-root" hidden></div>';
    delete document.documentElement.dataset.workbench;

    const offStorage = makeMemoryStorage();
    expect(isWorkbenchEnabled(offStorage)).toBe(false);
    expect(mountWorkbenchIfEnabled(document, { storage: offStorage })).toBeNull();
    expect(document.documentElement.dataset.workbench).toBeUndefined();
    expect(document.getElementById('workbench-root')?.hidden).toBe(true);
    expect(document.getElementById('app')?.hidden).toBe(false);

    const onStorage = makeMemoryStorage({ [WORKBENCH_FLAG_KEY]: '1' });
    expect(isWorkbenchEnabled(onStorage)).toBe(true);
    const shell = mountWorkbenchIfEnabled(document, { storage: onStorage, initialWidth: 1400, initialHeight: 900 });
    expect(shell).not.toBeNull();
    expect(document.documentElement.dataset.workbench).toBe('1');
    expect(document.getElementById('workbench-root')?.hidden).toBe(false);
    expect(document.getElementById('app')?.hidden).toBe(true);

    shell?.dispose();
    delete document.documentElement.dataset.workbench;
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

  it('switches cleanly between desktop, tablet drawers, and mobile StackShell', () => {
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
    expect(backdrop.hidden).toBe(false);

    backdrop.click();
    expect(shell.isPartVisible('sidebar')).toBe(false);
    expect(backdrop.hidden).toBe(true);

    shell.layout(390, 844);
    expect(shell.getMode()).toBe('mobile');
    expect((root.querySelector('.wb-shell') as HTMLElement).hidden).toBe(true);
    const stackEl = root.querySelector('.wb-stack') as HTMLElement;
    expect(stackEl).not.toBeNull();
    expect(stackEl.hidden).toBe(false);
    expect(stackEl.querySelectorAll('.wb-stack-tab').length).toBe(4);

    const chatComp = makePanel('chat');
    const changesComp = makePanel('changes');
    shell.openMobileDetail('Refactor shell', [
      { id: 'chat', title: 'Chat', component: chatComp },
      { id: 'changes', title: 'Changes', badge: 2, component: changesComp },
    ]);
    const stack = shell.getStackShell();
    expect(stack.getMode()).toBe('detail');
    expect(chatComp.init).toHaveBeenCalledTimes(1);
    expect(stackEl.querySelector('.wb-stack-detail-body')?.textContent).toContain('chat');

    stack.selectTool('changes');
    expect(changesComp.init).toHaveBeenCalledTimes(1);
    expect(stackEl.querySelector('.wb-stack-detail-body')?.textContent).toContain('changes');

    (stackEl.querySelector('.wb-stack-back') as HTMLButtonElement).click();
    expect(stack.getMode()).toBe('list');

    shell.layout(1400, 900);
    expect(stackEl.hidden).toBe(true);
    expect((root.querySelector('.wb-shell') as HTMLElement).hidden).toBe(false);
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
});
