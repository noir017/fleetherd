// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import type { LayoutState, PanelComponent, PanelInitContext, PartId } from '../contracts.js';
import { type DockPartHost, type DockTabInfo, DynamicDockEngine, MAIN_GROUP_ID } from './engine.js';
import { LAYOUT_STORAGE_KEY } from './serialize.js';
import { SplitView } from './splitview.js';

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

function createPartHost(part: PartId): DockPartHost & {
  readonly element: HTMLElement;
  readonly header: HTMLElement;
  readonly tabsEl: HTMLElement;
  lastVisible: boolean;
  lastTabs: readonly DockTabInfo[];
  lastActive: string | undefined;
} {
  const element = document.createElement('aside');
  element.className = `wb-${part}`;
  const header = document.createElement('div');
  header.className = 'wb-part-head';
  const tabsEl = document.createElement('div');
  tabsEl.className = 'wb-part-tabs';
  header.appendChild(tabsEl);
  const body = document.createElement('div');
  body.className = 'wb-part-body';
  element.append(header, body);

  const host = {
    element,
    header,
    tabsEl,
    body,
    lastVisible: true,
    lastTabs: [] as readonly DockTabInfo[],
    lastActive: undefined as string | undefined,
    setVisible(visible: boolean) {
      host.lastVisible = visible;
      element.hidden = !visible;
    },
    setTabs(tabs: readonly DockTabInfo[], activeId: string | undefined) {
      host.lastTabs = tabs;
      host.lastActive = activeId;
      tabsEl.replaceChildren();
      for (const tab of tabs) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `wb-part-tab${tab.id === activeId ? ' is-active' : ''}`;
        btn.dataset.panelId = tab.id;
        btn.textContent = tab.title;
        tabsEl.appendChild(btn);
      }
    },
  };
  return host;
}

function mockRect(el: Element, left: number, top: number, width: number, height: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }),
  });
}

function firePointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  pointerId = 1,
): void {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(ev, 'pointerId', { value: pointerId });
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
  target.dispatchEvent(ev);
}

describe('workbench/dock/engine (DynamicDockEngine)', () => {
  it('supports four-direction splits, side-by-side editors, merge, and automatic empty-group cleanup', () => {
    const container = document.createElement('div');
    const engine = new DynamicDockEngine({ doc: document, editorContainer: container });
    engine.registerComponent('editor:topic', () => createStubComponent('topic').component);
    engine.registerComponent('editor:diff', () => createStubComponent('diff').component);

    const p1 = engine.addPanel({
      id: 't1',
      component: 'editor:topic',
      title: 'Topic 1',
      params: { topicId: 't1' },
    });
    const p2 = engine.addPanel({
      id: 't2',
      component: 'editor:topic',
      title: 'Topic 2',
      params: { topicId: 't2' },
      position: { group: MAIN_GROUP_ID, direction: 'right' },
    });
    const p3 = engine.addPanel({
      id: 'd1',
      component: 'editor:diff',
      title: 'Diff 1',
      params: { topicId: 't2' },
      position: { referencePanel: 't2', direction: 'below' },
    });
    const p4 = engine.addPanel({
      id: 'd2',
      component: 'editor:diff',
      title: 'Diff 2',
      position: { group: MAIN_GROUP_ID, direction: 'left' },
    });
    const p5 = engine.addPanel({
      id: 'd3',
      component: 'editor:diff',
      title: 'Diff 3',
      position: { group: MAIN_GROUP_ID, direction: 'above' },
    });

    expect(engine.getGroups().length).toBe(5);
    expect(p1.group).toBe(MAIN_GROUP_ID);
    expect(p2.group).not.toBe(MAIN_GROUP_ID);
    expect(p3.group).not.toBe(p2.group);
    expect(p4.group).not.toBe(MAIN_GROUP_ID);
    expect(p5.group).not.toBe(MAIN_GROUP_ID);

    // Merge p2 into MAIN_GROUP_ID -> p2's old group becomes empty and is removed
    engine.movePanel('t2', { group: MAIN_GROUP_ID, direction: 'within' });
    expect(p2.group).toBe(MAIN_GROUP_ID);
    expect(engine.getGroups().length).toBe(4);
    expect(engine.getGroupPanels(MAIN_GROUP_ID)).toEqual(['t1', 't2']);

    // Removing the sole panel of a split group automatically removes that group
    engine.removePanel('d1');
    engine.removePanel('d2');
    engine.removePanel('d3');
    expect(engine.getGroups().length).toBe(1);
    expect(engine.getGroups()[0]!.id).toBe(MAIN_GROUP_ID);

    engine.dispose();
  });

  it('tracks active topic across side-by-side topic editors, diff editors, and part tool focus', () => {
    const container = document.createElement('div');
    const secondary = createPartHost('secondary');
    const engine = new DynamicDockEngine({
      doc: document,
      editorContainer: container,
      parts: { secondary },
    });
    engine.registerComponent('editor:topic', () => createStubComponent('topic').component);
    engine.registerComponent('editor:diff', () => createStubComponent('diff').component);
    engine.registerComponent('tool:changes', () => createStubComponent('changes').component);

    const topics: Array<string | undefined> = [];
    engine.onDidActiveTopicChange((topicId) => topics.push(topicId));

    const t1 = engine.addPanel({
      id: 'topic:alpha',
      component: 'editor:topic',
      title: 'Alpha',
      params: { topicId: 'alpha' },
    });
    const t2 = engine.addPanel({
      id: 'topic:beta',
      component: 'editor:topic',
      title: 'Beta',
      params: { id: 'beta' },
      position: { group: MAIN_GROUP_ID, direction: 'right' },
    });
    expect(topics).toEqual(['alpha', 'beta']);
    expect(engine.getActiveTopicId()).toBe('beta');

    // Focusing a topic tool in secondary sidebar preserves the active topic
    const changes = engine.addPanel({
      id: 'tool:changes',
      component: 'tool:changes',
      title: 'Changes',
      position: { part: 'secondary' },
    });
    changes.focus();
    expect(engine.getActiveTopicId()).toBe('beta');
    expect(topics).toEqual(['alpha', 'beta']);

    // Focusing Alpha switches active topic back to alpha
    t1.focus();
    expect(engine.getActiveTopicId()).toBe('alpha');
    expect(topics).toEqual(['alpha', 'beta', 'alpha']);

    // Opening a diff editor carrying topicId: 'beta' switches active topic to beta
    engine.addPanel({
      id: 'diff:beta',
      component: 'editor:diff',
      title: 'beta.ts',
      params: { topicId: 'beta', file: 'beta.ts' },
      position: { group: String(t2.group), direction: 'within' },
    });
    expect(engine.getActiveTopicId()).toBe('beta');

    // Closing all editors clears active topic to undefined
    engine.removePanel('diff:beta');
    engine.removePanel('topic:beta');
    engine.removePanel('topic:alpha');
    expect(engine.getActiveTopicId()).toBeUndefined();
    expect(topics[topics.length - 1]).toBeUndefined();

    engine.dispose();
  });

  it('moves views across sidebar, secondary, and panel and remembers part sizes on hide/show', () => {
    const workspace = document.createElement('div');
    const sidebar = createPartHost('sidebar');
    const secondary = createPartHost('secondary');
    const panel = createPartHost('panel');
    const center = document.createElement('div');
    const editorContainer = document.createElement('div');
    center.append(editorContainer, panel.element);

    const splitView = new SplitView({
      container: workspace,
      orientation: 'horizontal',
      panes: [
        { id: 'sidebar', element: sidebar.element, minSize: 180, defaultSize: 280, visible: true },
        { id: 'center', element: center, minSize: 320, defaultSize: 640, visible: true, priority: 'high' },
        { id: 'secondary', element: secondary.element, minSize: 260, defaultSize: 380, visible: false },
      ],
    });

    const engine = new DynamicDockEngine({
      doc: document,
      editorContainer,
      splitView,
      parts: { sidebar, secondary, panel },
      partSizes: { sidebar: 280, secondary: 380, panel: 240 },
      initialVisible: { sidebar: true, secondary: false, panel: false },
    });

    const changesStub = createStubComponent('changes');
    const filesStub = createStubComponent('files');
    const termStub = createStubComponent('terminal');
    engine.registerComponent('tool:changes', () => changesStub.component);
    engine.registerComponent('tool:files', () => filesStub.component);
    engine.registerComponent('tool:terminal', () => termStub.component);

    const cRef = engine.addPanel({
      id: 'tool:changes',
      component: 'tool:changes',
      title: 'Changes',
      position: { part: 'secondary' },
    });
    engine.addPanel({
      id: 'tool:files',
      component: 'tool:files',
      title: 'Files',
      position: { part: 'secondary' },
    });
    engine.addPanel({
      id: 'tool:terminal',
      component: 'tool:terminal',
      title: 'Terminal',
      position: { part: 'panel' },
    });

    // Move terminal from panel -> secondary, and changes from secondary -> sidebar
    engine.movePanel('tool:terminal', { part: 'secondary', index: 0 });
    expect(engine.getPartPanels('secondary')).toEqual(['tool:terminal', 'tool:changes', 'tool:files']);
    expect(engine.getPartPanels('panel')).toEqual([]);
    expect(engine.isPartVisible('secondary')).toBe(true);
    expect(termStub.element.parentElement).toBe(secondary.body);

    engine.movePanel('tool:changes', { part: 'sidebar' });
    expect(cRef.group).toBe('sidebar');
    expect(changesStub.element.parentElement).toBe(sidebar.body);
    expect(engine.getPartPanels('sidebar')).toEqual(['tool:changes']);

    // Resize, hide, and re-show secondary -> size remembered
    engine.setPartSize('secondary', 450);
    expect(engine.getPartSize('secondary')).toBe(450);
    engine.setPartVisible('secondary', false);
    expect(engine.isPartVisible('secondary')).toBe(false);
    expect(engine.getPartSize('secondary')).toBe(450);
    engine.setPartVisible('secondary', true);
    expect(engine.isPartVisible('secondary')).toBe(true);
    expect(engine.getPartSize('secondary')).toBe(450);

    engine.dispose();
    splitView.dispose();
  });

  it('handles pointer drag-and-drop for group split, tab reorder, view move, and tablet allowSplit=false', () => {
    const host = document.createElement('div');
    const editorContainer = document.createElement('div');
    const sidebar = createPartHost('sidebar');
    const secondary = createPartHost('secondary');
    host.append(sidebar.element, editorContainer, secondary.element);
    document.body.appendChild(host);

    const engine = new DynamicDockEngine({
      doc: document,
      editorContainer,
      dndHost: host,
      parts: { sidebar, secondary },
      initialVisible: { sidebar: true, secondary: true, panel: false },
      dndThresholdPx: 4,
    });
    engine.registerComponent('editor:topic', () => createStubComponent('topic').component);
    engine.registerComponent('view:topics', () => createStubComponent('topics').component);

    engine.addPanel({ id: 'e1', component: 'editor:topic', title: 'One', params: { topicId: '1' } });
    engine.addPanel({ id: 'e2', component: 'editor:topic', title: 'Two', params: { topicId: '2' } });
    engine.addPanel({ id: 'v1', component: 'view:topics', title: 'Topics', position: { part: 'sidebar' } });

    const mainGroup = engine.getGroup(MAIN_GROUP_ID)!;
    mockRect(mainGroup.element, 200, 0, 600, 400);
    mockRect(mainGroup.headerElement, 200, 0, 600, 32);
    const tabs = mainGroup.headerElement.querySelectorAll<HTMLElement>('.wb-tab');
    expect(tabs.length).toBe(2);
    mockRect(tabs[0]!, 200, 0, 100, 32);
    mockRect(tabs[1]!, 300, 0, 100, 32);

    // 1. Reorder tab e2 before e1 by dragging onto e1's left half
    firePointer(tabs[1]!, 'pointerdown', 340, 16);
    firePointer(window, 'pointermove', 220, 16);
    firePointer(window, 'pointerup', 220, 16);
    expect(engine.getGroupPanels(MAIN_GROUP_ID)).toEqual(['e2', 'e1']);

    // 2. Tablet mode (allowSplit=false): dragging onto right edge merges instead of splitting
    engine.setAllowSplit(false);
    expect(engine.getAllowSplit()).toBe(false);
    const updatedTabs = mainGroup.headerElement.querySelectorAll<HTMLElement>('.wb-tab');
    mockRect(updatedTabs[0]!, 200, 0, 100, 32);
    mockRect(updatedTabs[1]!, 300, 0, 100, 32);
    firePointer(updatedTabs[1]!, 'pointerdown', 340, 16);
    firePointer(window, 'pointermove', 760, 200);
    firePointer(window, 'pointerup', 760, 200);
    expect(engine.getGroups().length).toBe(1);

    // 3. Desktop mode (allowSplit=true): dragging onto right edge splits the group
    engine.setAllowSplit(true);
    const tabsForSplit = mainGroup.headerElement.querySelectorAll<HTMLElement>('.wb-tab');
    firePointer(tabsForSplit[1]!, 'pointerdown', 340, 16);
    firePointer(window, 'pointermove', 760, 200);
    firePointer(window, 'pointerup', 760, 200);
    expect(engine.getGroups().length).toBe(2);

    // 4. Drag view v1 from sidebar header to secondary body
    mockRect(sidebar.header, 0, 0, 200, 32);
    mockRect(sidebar.body, 0, 32, 200, 368);
    mockRect(secondary.header, 800, 0, 240, 32);
    mockRect(secondary.body, 800, 32, 240, 368);
    const sidebarTab = sidebar.tabsEl.querySelector<HTMLElement>('.wb-part-tab')!;
    firePointer(sidebarTab, 'pointerdown', 40, 16);
    firePointer(window, 'pointermove', 900, 150);
    firePointer(window, 'pointerup', 900, 150);
    expect(engine.getPartPanels('secondary')).toEqual(['v1']);
    expect(engine.getPartPanels('sidebar')).toEqual([]);

    engine.dispose();
    host.remove();
  });

  it('round-trips toJSON/fromJSON, falls back safely on corrupted data, and handles maximize + dispose', () => {
    const container = document.createElement('div');
    const sidebar = createPartHost('sidebar');
    const secondary = createPartHost('secondary');
    const storageMap = new Map<string, string>();
    const storage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageMap.set(k, v);
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
    };

    const created: Array<ReturnType<typeof createStubComponent>> = [];
    const engine = new DynamicDockEngine({
      doc: document,
      editorContainer: container,
      parts: { sidebar, secondary },
      storage,
      partSizes: { sidebar: 250, secondary: 360, panel: 200 },
      initialVisible: { sidebar: true, secondary: false, panel: false },
    });
    engine.registerComponent('editor:topic', () => {
      const c = createStubComponent('topic');
      created.push(c);
      return c.component;
    });
    engine.registerComponent('view:topics', () => {
      const c = createStubComponent('topics');
      created.push(c);
      return c.component;
    });

    engine.addPanel({ id: 'v:topics', component: 'view:topics', title: 'Topics', position: { part: 'sidebar' } });
    engine.addPanel({ id: 't1', component: 'editor:topic', title: 'One', params: { topicId: '1' } });
    const t2 = engine.addPanel({
      id: 't2',
      component: 'editor:topic',
      title: 'Two',
      params: { topicId: '2' },
      position: { group: MAIN_GROUP_ID, direction: 'right' },
    });

    // Maximize t2's group hides sidebar, exitMaximized restores it
    engine.maximizeGroup(String(t2.group));
    expect(engine.isMaximized()).toBe(true);
    expect(engine.isPartVisible('sidebar')).toBe(false);
    engine.exitMaximized();
    expect(engine.isMaximized()).toBe(false);
    expect(engine.isPartVisible('sidebar')).toBe(true);

    // Save to storage and restore into a fresh engine
    expect(engine.saveToStorage()).toBe(true);
    expect(storageMap.has(LAYOUT_STORAGE_KEY)).toBe(true);

    const restoredContainer = document.createElement('div');
    const engine2 = new DynamicDockEngine({
      doc: document,
      editorContainer: restoredContainer,
      storage,
    });
    engine2.registerComponent('editor:topic', () => createStubComponent('topic').component);
    engine2.registerComponent('view:topics', () => createStubComponent('topics').component);

    expect(engine2.restoreFromStorage()).toBe(true);
    expect(engine2.getGroups().length).toBe(2);
    expect(engine2.getPartPanels('sidebar')).toEqual(['v:topics']);
    expect(engine2.getActiveTopicId()).toBe('2');

    // Layout dimensions propagate without error
    const dimLog: Array<{ width: number; height: number }> = [];
    engine2.getPanel('t1')?.onDidDimensionsChange((d) => dimLog.push(d));
    engine2.layout(1200, 800);
    expect(dimLog.length).toBeGreaterThan(0);

    // Corrupted state falls back safely to default layout
    engine2.fromJSON({ v: 99, broken: true } as unknown as LayoutState);
    expect(engine2.getGroups().length).toBe(1);
    expect(engine2.getGroups()[0]!.id).toBe(MAIN_GROUP_ID);
    expect(engine2.getPartPanels('sidebar')).toEqual([]);

    engine2.dispose();
    engine.dispose();
    expect(created.every((c) => c.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('switches to an earlier editor tab on pointerdown/pointerup/click without premature pointer capture', () => {
    const host = document.createElement('div');
    const container = document.createElement('div');
    host.appendChild(container);
    document.body.appendChild(host);

    const engine = new DynamicDockEngine({
      doc: document,
      editorContainer: container,
      dndHost: host,
      alwaysShowTabs: true,
    });

    const c1 = createStubComponent('topic');
    const c2 = createStubComponent('file');
    engine.registerComponent('editor:topic', () => c1.component);
    engine.registerComponent('editor:file', () => c2.component);

    engine.addPanel({ id: 'topic:active', component: 'editor:topic', title: 'Topic', params: { topicId: 't1' } });
    engine.addPanel({ id: 'editor:file:1', component: 'editor:file', title: 'main.ts' });

    const group = engine.getGroup(MAIN_GROUP_ID)!;
    const setCapture = vi.fn();
    group.headerElement.setPointerCapture = setCapture;

    expect(engine.getActiveGroupPanel()).toBe('editor:file:1');
    expect(c1.element.hidden).toBe(true);
    expect(c2.element.hidden).toBe(false);

    const firstTab = group.headerElement.querySelector<HTMLButtonElement>('[data-panel-id="topic:active"]')!;
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 10 });
    Object.defineProperty(down, 'pointerId', { value: 1 });
    Object.defineProperty(down, 'pointerType', { value: 'mouse' });
    firstTab.dispatchEvent(down);

    // Must NOT capture on pointerdown before drag threshold, or browsers swallow the child tab click.
    expect(setCapture).not.toHaveBeenCalled();

    const up = new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 10 });
    Object.defineProperty(up, 'pointerId', { value: 1 });
    Object.defineProperty(up, 'pointerType', { value: 'mouse' });
    firstTab.dispatchEvent(up);
    firstTab.click();

    expect(engine.getActiveGroupPanel()).toBe('topic:active');
    expect(c1.element.hidden).toBe(false);
    expect(c2.element.hidden).toBe(true);

    engine.dispose();
    host.remove();
  });
});
