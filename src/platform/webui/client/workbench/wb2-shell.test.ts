// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { ContributionRegistry } from '../plugins/registry.js';
import { StorageService } from '../services/storage.js';
import type { PanelComponent } from './contracts.js';
import { WorkbenchShell } from './shell.js';

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

function makePanel(tag: string): PanelComponent {
  const element = document.createElement('div');
  element.textContent = tag;
  return {
    element,
    init: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('wb2-shell alignment', () => {
  it('renders permanent editor tab strip with icons and keeps tabs open when switching sidebar views', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const registry = new ContributionRegistry();
    const shell = new WorkbenchShell({
      root,
      doc: document,
      storage: makeMemoryStorage(),
      registry,
      resolveIcon: (name) => `<svg data-icon="${name}"></svg>`,
      initialWidth: 1440,
      initialHeight: 900,
    });

    registry.registerView({ id: 'topics', title: 'Topics', part: 'sidebar', component: () => makePanel('topics') });
    registry.registerView({ id: 'history', title: 'History', part: 'sidebar', component: () => makePanel('history') });
    registry.registerActivity({ id: 'topics', title: 'Topics', icon: 'chat', view: 'topics', order: 10 });
    registry.registerActivity({ id: 'history', title: 'History', icon: 'history', view: 'history', order: 20 });
    registry.registerEditor({ kind: 'topic', title: () => 'Refactor shell', component: () => makePanel('topic-ed') });

    shell.views.reveal('topics');
    expect(root.querySelector('.wb-activity-item[data-activity-id="topics"]')?.classList.contains('is-active')).toBe(true);

    shell.editors.open('topic', { topicId: 't1' }, { id: 'topic:t1' });
    const head = root.querySelector('.wb-editor-group .wb-group-head')!;
    expect(head.classList.contains('wb-tab-bar')).toBe(true);
    expect(head.querySelectorAll('.wb-tab').length).toBe(1);
    expect(head.querySelector('.wb-tab .wb-tab-icon svg')?.getAttribute('data-icon')).toBe('chat');

    // Switch sidebar to history: activity bar updates, no redundant sidebar tabs, editor tab stays open.
    shell.views.reveal('history');
    expect(root.querySelector('.wb-activity-item[data-activity-id="history"]')?.classList.contains('is-active')).toBe(true);
    expect((root.querySelector('.wb-sidebar .wb-part-tabs') as HTMLElement).hidden).toBe(true);
    expect(root.querySelectorAll('.wb-editor-group .wb-tab').length).toBe(1);

    shell.dispose();
    registry.dispose();
    root.remove();
  });

  it('keeps tablet drawers visible when opened, starts collapsed at tablet width, and closes on Escape', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const shell = new WorkbenchShell({
      root,
      doc: document,
      storage: makeMemoryStorage(),
      initialWidth: 820,
      initialHeight: 1100,
    });

    expect(shell.getMode()).toBe('tablet');
    expect(shell.isPartVisible('sidebar')).toBe(false);
    expect((root.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('.wb-drawer-backdrop') as HTMLElement).hidden).toBe(true);

    // Open list drawer
    shell.setPartVisible('sidebar', true);
    expect((root.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('.wb-drawer-backdrop') as HTMLElement).hidden).toBe(false);

    // Press Escape to dismiss
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shell.isPartVisible('sidebar')).toBe(false);
    expect((root.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('.wb-drawer-backdrop') as HTMLElement).hidden).toBe(true);

    // Open secondary drawer
    shell.setPartVisible('secondary', true);
    expect((root.querySelector('.wb-secondary') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('.wb-drawer-backdrop') as HTMLElement).hidden).toBe(false);

    shell.dispose();
    root.remove();
  });

  it('auto-collapses primary sidebar on narrow desktop and restores when widened back', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const shell = new WorkbenchShell({
      root,
      doc: document,
      storage: makeMemoryStorage(),
      initialWidth: 1200,
      initialHeight: 800,
    });

    shell.setPartVisible('secondary', true);
    expect(shell.isPartVisible('sidebar')).toBe(false);

    shell.layout(1440, 900);
    expect(shell.isPartVisible('sidebar')).toBe(true);
    expect(shell.isPartVisible('secondary')).toBe(true);

    shell.dispose();
    root.remove();
  });
});
