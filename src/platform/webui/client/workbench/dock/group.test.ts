// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import type { PanelComponent, PanelInitContext } from '../contracts.js';
import { GridView } from './gridview.js';
import { EditorGroup, pickAdjacentTabId, reorderList } from './group.js';

function createStubComponent(label: string) {
  const element = document.createElement('div');
  element.className = `stub-${label}`;
  const init = vi.fn((_params: unknown, _ctx: PanelInitContext) => {});
  const update = vi.fn((_params: unknown) => {});
  const focus = vi.fn();
  const dispose = vi.fn();
  const component: PanelComponent = { element, init, update, focus, dispose };
  return { component, element, init, update, focus, dispose };
}

describe('workbench/dock/group (EditorGroup)', () => {
  it('switches between single-tab v3 titlebar and multi-tab strip with inline SVG close icons', () => {
    const group = new EditorGroup({ id: 'g1', doc: document });
    const c1 = createStubComponent('chat');
    const c2 = createStubComponent('diff');

    expect(group.headerElement.classList.contains('wb-single-tab')).toBe(true);

    const p1 = group.addPanel({
      id: 'chat-1',
      componentName: 'chat',
      component: c1.component,
      title: 'Topic A',
      params: { topic: 'a' },
    });

    expect(c1.init).toHaveBeenCalledTimes(1);
    expect(group.headerElement.classList.contains('wb-single-tab')).toBe(true);
    expect(group.headerElement.classList.contains('wb-multi-tab')).toBe(false);
    expect(group.headerElement.querySelector('.wb-group-title')?.textContent).toBe('Topic A');

    const p2 = group.addPanel({
      id: 'diff-1',
      componentName: 'diff',
      component: c2.component,
      title: 'main.ts',
    });

    expect(group.headerElement.classList.contains('wb-multi-tab')).toBe(true);
    expect(group.headerElement.classList.contains('wb-single-tab')).toBe(false);
    const tabs = group.headerElement.querySelectorAll('.wb-tab');
    expect(tabs.length).toBe(2);
    expect(tabs[1]!.classList.contains('is-active')).toBe(true);
    expect(tabs[1]!.querySelector('.wb-tab-close svg')).not.toBeNull();
    expect(c1.element.hidden).toBe(true);
    expect(c2.element.hidden).toBe(false);

    p2.setTitle('src/main.ts');
    p2.setBadge(4);
    expect(group.headerElement.textContent).toContain('src/main.ts');
    expect(group.headerElement.querySelector('.wb-badge')?.textContent).toBe('4');

    p2.close();
    expect(c2.dispose).toHaveBeenCalledTimes(1);
    expect(group.activePanelId).toBe('chat-1');
    expect(group.headerElement.classList.contains('wb-single-tab')).toBe(true);
    expect(c1.element.hidden).toBe(false);

    expect(p1.group).toBe('g1');
    group.dispose();
    expect(c1.dispose).toHaveBeenCalledTimes(1);
  });

  it('tracks dirty dots, reorders tabs, and activates adjacent tab when closing active tab', () => {
    expect(reorderList(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(pickAdjacentTabId(['a', 'c'], 1)).toBe('c');
    expect(pickAdjacentTabId(['a', 'b'], 2)).toBe('b');
    expect(pickAdjacentTabId([], 0)).toBeUndefined();

    const dragStarts: Array<{ panelId: string; index: number }> = [];
    const group = new EditorGroup({
      id: 'g1',
      doc: document,
      onTabPointerDown: (info) => dragStarts.push({ panelId: info.panelId, index: info.index }),
    });

    const a = createStubComponent('a');
    const b = createStubComponent('b');
    const c = createStubComponent('c');
    group.addPanel({ id: 'pA', componentName: 'file', component: a.component, title: 'A.ts' });
    group.addPanel({ id: 'pB', componentName: 'file', component: b.component, title: 'B.ts' });
    group.addPanel({ id: 'pC', componentName: 'file', component: c.component, title: 'C.ts' });

    group.setDirty('pB', true);
    expect(group.isDirty('pB')).toBe(true);
    const bTab = group.headerElement.querySelector('[data-panel-id="pB"]')!;
    expect(bTab.classList.contains('is-dirty')).toBe(true);
    expect(bTab.querySelector('.wb-tab-dirty')).not.toBeNull();

    bTab.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    expect(dragStarts).toEqual([{ panelId: 'pB', index: 1 }]);

    const reorderEvents: Array<{ fromIndex: number; toIndex: number; panelId: string }> = [];
    group.onDidReorderTab((ev) => reorderEvents.push(ev));
    expect(group.reorderTab(2, 0)).toBe(true);
    expect(group.getPanelIds()).toEqual(['pC', 'pA', 'pB']);
    expect(reorderEvents).toEqual([{ fromIndex: 2, toIndex: 0, panelId: 'pC' }]);
    expect(group.reorderTab(-1, 0)).toBe(false);

    // Active is pC at index 0; closing it activates adjacent pA.
    group.setActivePanel('pC');
    const closeBtn = group.headerElement.querySelector('[data-panel-id="pC"] .wb-tab-close')!;
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(c.dispose).toHaveBeenCalledTimes(1);
    expect(group.activePanelId).toBe('pA');

    // Middle click closes pB.
    const bTabAfter = group.headerElement.querySelector('[data-panel-id="pB"]')!;
    bTabAfter.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(group.getPanelIds()).toEqual(['pA']);
    expect(group.headerElement.classList.contains('wb-single-tab')).toBe(true);

    group.dispose();
    expect(a.dispose).toHaveBeenCalledTimes(1);
  });

  it('proxies PanelRef focus/visibility/dimensions, supports detach/attach, and cleans up on dispose', () => {
    const g1 = new EditorGroup({ id: 'g1', doc: document });
    const g2 = new EditorGroup({ id: 'g2', doc: document });
    const c1 = createStubComponent('one');
    const c2 = createStubComponent('two');

    const p1 = g1.addPanel({ id: 'p1', componentName: 'ed', component: c1.component, title: 'One' });
    const p2 = g1.addPanel({ id: 'p2', componentName: 'ed', component: c2.component, title: 'Two' });

    const visLog: boolean[] = [];
    const dimLog: Array<{ width: number; height: number }> = [];
    p1.onDidVisibilityChange((v) => visLog.push(v));
    p1.onDidDimensionsChange((d) => dimLog.push(d));

    g1.layout(640, 480);
    p1.focus();
    expect(c1.focus).toHaveBeenCalledTimes(1);
    expect(visLog).toEqual([true]);
    expect(dimLog).toEqual([{ width: 640, height: 480 }]);

    g1.setActive(true);
    expect(g1.isActive).toBe(true);
    expect(g1.element.classList.contains('is-active')).toBe(true);

    const detached = g1.detachPanel('p1')!;
    expect(c1.dispose).not.toHaveBeenCalled();
    expect(visLog).toEqual([true, false]);

    g2.layout(320, 480);
    g2.attachPanel(detached);
    expect(p1.group).toBe('g2');
    expect(visLog).toEqual([true, false, true]);
    expect(dimLog.at(-1)).toEqual({ width: 320, height: 480 });

    const emptyEvents: number[] = [];
    g1.onDidEmpty(() => emptyEvents.push(1));
    p2.close();
    expect(emptyEvents).toEqual([1]);

    g1.dispose();
    g2.dispose();
    expect(c1.dispose).toHaveBeenCalledTimes(1);
    expect(c2.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('workbench/dock/gridview (GridView DOM controller)', () => {
  it('mounts SplitView branches, tracks active group, maximizes/restores, and layouts dimensions', () => {
    const container = document.createElement('div');
    const grid = new GridView({ container, doc: document });
    const activeLog: Array<string | undefined> = [];
    let layoutChanges = 0;
    grid.onDidActiveGroupChange((g) => activeLog.push(g?.id));
    grid.onDidLayoutChange(() => {
      layoutChanges += 1;
    });

    const main = grid.getGroup('main')!;
    const c1 = createStubComponent('main-chat');
    const c2 = createStubComponent('side-diff');
    const p1 = main.addPanel({ id: 'p1', componentName: 'chat', component: c1.component, title: 'Chat' });

    const g2 = grid.splitGroup('main', 'right', 'g2')!;
    const p2 = g2.addPanel({ id: 'p2', componentName: 'diff', component: c2.component, title: 'Diff' });

    expect(grid.getActiveGroupId()).toBe('g2');
    expect(g2.isActive).toBe(true);
    expect(main.isActive).toBe(false);
    expect(container.querySelectorAll('.wb-sash').length).toBe(1);

    const dims1: Array<{ width: number; height: number }> = [];
    const dims2: Array<{ width: number; height: number }> = [];
    p1.onDidDimensionsChange((d) => dims1.push(d));
    p2.onDidDimensionsChange((d) => dims2.push(d));

    grid.layout(1000, 600);
    expect(dims1.at(-1)).toEqual({ width: 500, height: 600 });
    expect(dims2.at(-1)).toEqual({ width: 500, height: 600 });

    grid.maximizeGroup('g2');
    expect(grid.isMaximized()).toBe(true);
    expect(grid.getMaximizedGroup()).toBe('g2');
    expect(container.dataset.maximized).toBe('true');
    expect(dims2.at(-1)).toEqual({ width: 1000, height: 600 });
    expect(main.element.hidden).toBe(true);

    grid.exitMaximized();
    expect(grid.isMaximized()).toBe(false);
    expect(main.element.hidden).toBe(false);
    expect(dims1.at(-1)).toEqual({ width: 500, height: 600 });
    expect(dims2.at(-1)).toEqual({ width: 500, height: 600 });

    main.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(grid.getActiveGroupId()).toBe('main');
    expect(activeLog.at(-1)).toBe('main');

    expect(grid.removeGroup('g2')).toBe(true);
    expect(c2.dispose).toHaveBeenCalledTimes(1);
    expect(grid.getGroups().map((g) => g.id)).toEqual(['main']);
    expect(grid.removeGroup('main')).toBe(false);
    expect(layoutChanges).toBeGreaterThan(0);

    grid.dispose();
    expect(c1.dispose).toHaveBeenCalledTimes(1);
  });
});
