// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import type { PanelComponent, PanelInitContext } from '../contracts.js';
import { MAIN_GROUP_ID, StaticDockEngine } from './static.js';

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

describe('workbench/dock/static (StaticDockEngine)', () => {
  it('registers components, adds panels, renders single-tab vs multi-tab headers, and removes panels', () => {
    const editorContainer = document.createElement('div');
    const engine = new StaticDockEngine({ doc: document, editorContainer });
    const c1 = createStubComponent('chat1');
    const c2 = createStubComponent('chat2');

    const reg1 = engine.registerComponent('chat', () => c1.component);
    expect(() => engine.registerComponent('chat', () => c2.component)).toThrow(/already registered/);

    const activeEvents: Array<string | undefined> = [];
    engine.onDidActivePanelChange((ref) => activeEvents.push(ref?.id));

    const p1 = engine.addPanel({ id: 't1', component: 'chat', title: 'Topic One', params: { id: 1 } });
    expect(c1.init).toHaveBeenCalledTimes(1);
    expect(engine.getPanel('t1')).toBe(p1);
    expect(activeEvents).toEqual(['t1']);

    const head = editorContainer.querySelector('.wb-group-head')!;
    expect(head.classList.contains('wb-single-tab')).toBe(true);
    expect(head.classList.contains('wb-multi-tab')).toBe(false);
    expect(head.textContent).toContain('Topic One');

    engine.registerComponent('diff', () => c2.component);
    const p2 = engine.addPanel({ id: 'd1', component: 'diff', title: 'Changes', position: { group: MAIN_GROUP_ID } });
    expect(head.classList.contains('wb-multi-tab')).toBe(true);
    const tabs = head.querySelectorAll('.wb-tab');
    expect(tabs.length).toBe(2);
    expect(tabs[1]!.classList.contains('is-active')).toBe(true);
    expect(c1.element.hidden).toBe(true);
    expect(c2.element.hidden).toBe(false);

    p2.setTitle('Diff: page.ts');
    p2.setBadge(3);
    expect(head.textContent).toContain('Diff: page.ts');
    expect(head.querySelector('.wb-badge')?.textContent).toBe('3');

    const visLog: boolean[] = [];
    p1.onDidVisibilityChange((v) => visLog.push(v));
    p1.focus();
    expect(c1.focus).toHaveBeenCalledTimes(1);
    expect(c1.element.hidden).toBe(false);
    expect(c2.element.hidden).toBe(true);
    expect(visLog).toEqual([true]);

    p2.close();
    expect(c2.dispose).toHaveBeenCalledTimes(1);
    expect(engine.getPanel('d1')).toBeUndefined();
    expect(head.classList.contains('wb-single-tab')).toBe(true);

    reg1.dispose();
    engine.dispose();
    expect(c1.dispose).toHaveBeenCalledTimes(1);
  });

  it('supports movePanel across parts, setPartVisible, maximizeGroup/exitMaximized, and layout dimensions', () => {
    const sidebarBody = document.createElement('div');
    const secondaryBody = document.createElement('div');
    const editorContainer = document.createElement('div');

    const engine = new StaticDockEngine({
      doc: document,
      editorContainer,
      parts: {
        sidebar: { body: sidebarBody },
        secondary: { body: secondaryBody },
      },
      initialVisible: { sidebar: true, secondary: false, panel: false },
    });

    const tool = createStubComponent('tool');
    const editor = createStubComponent('editor');
    engine.registerComponent('tool', () => tool.component);
    engine.registerComponent('editor', () => editor.component);

    const toolRef = engine.addPanel({ id: 'changes', component: 'tool', title: 'Changes', position: { part: 'secondary' } });
    const edRef = engine.addPanel({ id: 'chat', component: 'editor', title: 'Chat' });

    const toolDims: Array<{ width: number; height: number }> = [];
    toolRef.onDidDimensionsChange((d) => toolDims.push(d));
    const edDims: Array<{ width: number; height: number }> = [];
    edRef.onDidDimensionsChange((d) => edDims.push(d));

    expect(tool.element.hidden).toBe(true);
    engine.setPartVisible('secondary', true);
    expect(tool.element.hidden).toBe(false);

    engine.layout(1200, 800);
    expect(toolDims.at(-1)).toEqual({ width: 420, height: 800 });
    expect(edDims.at(-1)).toEqual({ width: 1200 - 264 - 420, height: 800 });

    engine.maximizeGroup(MAIN_GROUP_ID);
    expect(engine.isMaximized()).toBe(true);
    expect(engine.isPartVisible('sidebar')).toBe(false);
    expect(engine.isPartVisible('secondary')).toBe(false);
    expect(edDims.at(-1)).toEqual({ width: 1200, height: 800 });

    engine.exitMaximized();
    expect(engine.isMaximized()).toBe(false);
    expect(engine.isPartVisible('sidebar')).toBe(true);
    expect(engine.isPartVisible('secondary')).toBe(true);

    engine.movePanel('changes', { part: 'sidebar' });
    expect(toolRef.group).toBe('sidebar');
    expect(tool.element.parentElement).toBe(sidebarBody);
    engine.dispose();
  });

  it('serializes and restores LayoutState v1 while skipping unregistered components', () => {
    const engine = new StaticDockEngine({ doc: document });
    engine.registerComponent('topics', () => createStubComponent('topics').component);
    engine.registerComponent('chat', () => createStubComponent('chat').component);

    engine.addPanel({ id: 'v-topics', component: 'topics', title: 'Topics', position: { part: 'sidebar' } });
    engine.addPanel({ id: 'e-1', component: 'chat', title: 'Main Chat', params: { topic: 'a' } });
    engine.setPartSize('sidebar', 300);

    const snapshot = engine.toJSON();
    expect(snapshot.v).toBe(1);
    expect(snapshot.parts.sidebar.size).toBe(300);
    expect(snapshot.parts.sidebar.panels).toEqual(['v-topics']);
    expect(snapshot.grid).toEqual({
      type: 'leaf',
      group: MAIN_GROUP_ID,
      panels: ['e-1'],
      activePanel: 'e-1',
    });

    const nextEngine = new StaticDockEngine({ doc: document });
    nextEngine.registerComponent('topics', () => createStubComponent('topics').component);
    nextEngine.registerComponent('chat', () => createStubComponent('chat').component);

    nextEngine.fromJSON({
      ...snapshot,
      panels: {
        ...snapshot.panels,
        ghost: { id: 'ghost', component: 'missing-comp', title: 'Ghost' },
      },
      grid: {
        type: 'leaf',
        group: MAIN_GROUP_ID,
        panels: ['e-1', 'ghost'],
        activePanel: 'e-1',
      },
    });

    expect(nextEngine.getPanel('v-topics')).toBeDefined();
    expect(nextEngine.getPanel('e-1')).toBeDefined();
    expect(nextEngine.getPanel('ghost')).toBeUndefined();
    expect(nextEngine.getPartSize('sidebar')).toBe(300);

    engine.dispose();
    nextEngine.dispose();
  });
});
