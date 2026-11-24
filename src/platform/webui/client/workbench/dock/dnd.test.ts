// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { OverlayManager } from '../../services/overlays.js';
import {
  computeGroupDropZone,
  computeOverlayRect,
  computePartDropTarget,
  computeTabInsertIndex,
  DockDndController,
  type DockDropZoneSnapshot,
  type DndRect,
  type DragPayload,
  type DropTarget,
  dropTargetToPanelPosition,
  exceedsDragThreshold,
  type PartDropArea,
  pointInRect,
  resolveDropTarget,
} from './dnd.js';

function dispatchPointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: {
    clientX?: number;
    clientY?: number;
    button?: number;
    pointerId?: number;
    pointerType?: string;
  } = {},
): MouseEvent {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
  });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
  Object.defineProperty(ev, 'pointerType', { value: init.pointerType ?? 'mouse' });
  target.dispatchEvent(ev);
  return ev;
}

describe('workbench/dock/dnd pure geometry', () => {
  const groupRect: DndRect = { left: 100, top: 50, width: 400, height: 200 };

  it('computes group drop zones for edges, center, corners, clamping, and tablet no-split mode', () => {
    expect(computeGroupDropZone({ x: 140, y: 150 }, groupRect, true)).toBe('left');
    expect(computeGroupDropZone({ x: 460, y: 150 }, groupRect, true)).toBe('right');
    expect(computeGroupDropZone({ x: 300, y: 70 }, groupRect, true)).toBe('above');
    expect(computeGroupDropZone({ x: 300, y: 230 }, groupRect, true)).toBe('below');
    expect(computeGroupDropZone({ x: 300, y: 150 }, groupRect, true)).toBe('within');

    // Corners resolve to the nearest normalized edge.
    expect(computeGroupDropZone({ x: 104, y: 80 }, groupRect, true)).toBe('left');
    expect(computeGroupDropZone({ x: 160, y: 52 }, groupRect, true)).toBe('above');

    // Out-of-bounds coordinates clamp cleanly to edges.
    expect(computeGroupDropZone({ x: 10, y: 150 }, groupRect, true)).toBe('left');
    expect(computeGroupDropZone({ x: 700, y: 150 }, groupRect, true)).toBe('right');

    // Tablet mode (allowSplit === false) always returns 'within'.
    expect(computeGroupDropZone({ x: 110, y: 150 }, groupRect, false)).toBe('within');
    expect(computeGroupDropZone({ x: 490, y: 60 }, groupRect, false)).toBe('within');

    // Invalid rects or zero ratio fall back safely to 'within'.
    expect(computeGroupDropZone({ x: 110, y: 150 }, { left: 0, top: 0, width: 0, height: 100 }, true)).toBe('within');
    expect(computeGroupDropZone({ x: Number.NaN, y: 150 }, groupRect, true)).toBe('within');
    expect(computeGroupDropZone({ x: 110, y: 150 }, groupRect, true, 0)).toBe('within');
  });

  it('computes tab insertion index and indicator lineX across tab strip positions', () => {
    const tabs: DndRect[] = [
      { left: 100, top: 0, width: 80, height: 32 },
      { left: 180, top: 0, width: 100, height: 32 },
      { left: 280, top: 0, width: 60, height: 32 },
    ];

    expect(computeTabInsertIndex(80, tabs)).toEqual({ index: 0, lineX: 100 });
    expect(computeTabInsertIndex(139, tabs)).toEqual({ index: 0, lineX: 100 });
    expect(computeTabInsertIndex(140, tabs)).toEqual({ index: 1, lineX: 180 });
    expect(computeTabInsertIndex(229, tabs)).toEqual({ index: 1, lineX: 180 });
    expect(computeTabInsertIndex(230, tabs)).toEqual({ index: 2, lineX: 280 });
    expect(computeTabInsertIndex(310, tabs)).toEqual({ index: 3, lineX: 340 });
    expect(computeTabInsertIndex(500, tabs)).toEqual({ index: 3, lineX: 340 });

    // Empty tab bar uses fallbackLineX when supplied.
    expect(computeTabInsertIndex(220, [], 100)).toEqual({ index: 0, lineX: 100 });
    expect(computeTabInsertIndex(220, [])).toEqual({ index: 0, lineX: 220 });
  });

  it('computes part drop targets for sidebar, secondary, and panel with header precedence', () => {
    const parts: PartDropArea[] = [
      { part: 'sidebar', region: 'body', rect: { left: 0, top: 0, width: 240, height: 600 } },
      {
        part: 'sidebar',
        region: 'header',
        rect: { left: 0, top: 0, width: 240, height: 34 },
        tabRects: [
          { left: 8, top: 0, width: 70, height: 34 },
          { left: 78, top: 0, width: 70, height: 34 },
        ],
      },
      { part: 'secondary', region: 'body', rect: { left: 800, top: 0, width: 260, height: 600 } },
      { part: 'panel', region: 'body', rect: { left: 240, top: 420, width: 560, height: 180 } },
    ];

    // Header takes precedence over encompassing body rect and computes tab insert.
    expect(computePartDropTarget({ x: 90, y: 16 }, parts)).toEqual({
      part: 'sidebar',
      region: 'header',
      rect: { left: 0, top: 0, width: 240, height: 34 },
      index: 1,
      lineX: 78,
    });

    expect(computePartDropTarget({ x: 100, y: 200 }, parts)).toEqual({
      part: 'sidebar',
      region: 'body',
      rect: { left: 0, top: 0, width: 240, height: 600 },
    });

    expect(computePartDropTarget({ x: 900, y: 120 }, parts)).toEqual({
      part: 'secondary',
      region: 'body',
      rect: { left: 800, top: 0, width: 260, height: 600 },
    });

    expect(computePartDropTarget({ x: 400, y: 500 }, parts)).toEqual({
      part: 'panel',
      region: 'body',
      rect: { left: 240, top: 420, width: 560, height: 180 },
    });

    expect(computePartDropTarget({ x: 500, y: 200 }, parts)).toBeNull();
  });

  it('computes preview overlay rectangles for all directions and tab insertion indicator', () => {
    expect(computeOverlayRect('left', groupRect)).toEqual({
      left: 100,
      top: 50,
      width: 200,
      height: 200,
    });
    expect(computeOverlayRect('right', groupRect)).toEqual({
      left: 300,
      top: 50,
      width: 200,
      height: 200,
    });
    expect(computeOverlayRect('above', groupRect)).toEqual({
      left: 100,
      top: 50,
      width: 400,
      height: 100,
    });
    expect(computeOverlayRect('below', groupRect)).toEqual({
      left: 100,
      top: 150,
      width: 400,
      height: 100,
    });
    expect(computeOverlayRect('within', groupRect)).toEqual(groupRect);

    const tabBar: DndRect = { left: 100, top: 50, width: 400, height: 32 };
    expect(computeOverlayRect('tab-insert', tabBar, { lineX: 220, lineWidth: 4 })).toEqual({
      left: 218,
      top: 50,
      width: 4,
      height: 32,
    });
    // Out-of-range lineX clamps into tabBar bounds.
    expect(computeOverlayRect('tab-insert', tabBar, { lineX: 999, lineWidth: 2 })).toEqual({
      left: 499,
      top: 50,
      width: 2,
      height: 32,
    });
  });

  it('resolves combined snapshot targets and maps DropTarget to PanelPosition', () => {
    const snapshot: DockDropZoneSnapshot = {
      groups: [
        {
          group: 'g1',
          rect: { left: 200, top: 40, width: 600, height: 400 },
          tabBarRect: { left: 200, top: 40, width: 600, height: 32 },
          tabRects: [
            { left: 200, top: 40, width: 120, height: 32 },
            { left: 320, top: 40, width: 120, height: 32 },
          ],
        },
      ],
      parts: [{ part: 'panel', region: 'body', rect: { left: 200, top: 440, width: 600, height: 160 } }],
    };

    const tabTarget = resolveDropTarget({ x: 390, y: 55 }, snapshot, true);
    expect(tabTarget).toEqual({
      kind: 'tab-bar',
      group: 'g1',
      index: 2,
      lineX: 440,
      rect: { left: 200, top: 40, width: 600, height: 32 },
    });
    expect(dropTargetToPanelPosition(tabTarget!)).toEqual({
      group: 'g1',
      direction: 'within',
      index: 2,
    });

    const splitTarget = resolveDropTarget({ x: 760, y: 240 }, snapshot, true);
    expect(splitTarget?.kind).toBe('group');
    expect(dropTargetToPanelPosition(splitTarget!)).toEqual({ group: 'g1', direction: 'right' });

    const tabletTarget = resolveDropTarget({ x: 760, y: 240 }, snapshot, false);
    expect(dropTargetToPanelPosition(tabletTarget!)).toEqual({ group: 'g1', direction: 'within' });

    const partTarget = resolveDropTarget({ x: 300, y: 500 }, snapshot, true);
    expect(dropTargetToPanelPosition(partTarget!)).toEqual({ part: 'panel' });

    expect(pointInRect({ x: 10, y: 10 }, { left: 0, top: 0, width: 20, height: 20 })).toBe(true);
    expect(exceedsDragThreshold({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toBe(true);
    expect(exceedsDragThreshold({ x: 0, y: 0 }, { x: 2, y: 2 }, 5)).toBe(false);
  });
});

describe('workbench/dock/dnd DockDndController (jsdom pointer lifecycle)', () => {
  const samplePayload: DragPayload = {
    kind: 'tab',
    panelId: 'topic-1',
    title: 'Topic One',
    sourceGroup: 'g1',
  };

  const sampleSnapshot: DockDropZoneSnapshot = {
    groups: [
      {
        group: 'g1',
        rect: { left: 200, top: 40, width: 400, height: 300 },
        tabBarRect: { left: 200, top: 40, width: 400, height: 32 },
        tabRects: [
          { left: 200, top: 40, width: 100, height: 32 },
          { left: 300, top: 40, width: 100, height: 32 },
        ],
      },
    ],
    parts: [{ part: 'secondary', region: 'body', rect: { left: 600, top: 40, width: 240, height: 300 } }],
  };

  function setupHost(): { host: HTMLDivElement; source: HTMLDivElement } {
    const host = document.createElement('div');
    const source = document.createElement('div');
    host.appendChild(source);
    document.body.appendChild(host);
    return { host, source };
  }

  it('does not start a drag when pointer movement stays below threshold', () => {
    const { host, source } = setupHost();
    const onDragStart = vi.fn();
    const onDrop = vi.fn();
    const onDragEnd = vi.fn();

    const controller = new DockDndController({
      doc: document,
      host,
      thresholdPx: 5,
      getDropZones: () => sampleSnapshot,
      onDragStart,
      onDrop,
      onDragEnd,
    });
    controller.attachSource(source, samplePayload);

    dispatchPointer(source, 'pointerdown', { clientX: 220, clientY: 50, pointerId: 7 });
    dispatchPointer(window, 'pointermove', { clientX: 222, clientY: 52, pointerId: 7 });
    expect(controller.isDragging).toBe(false);
    expect(host.querySelector('.wb-dnd-ghost')).toBeNull();
    expect(host.querySelector('.wb-dnd-overlay')).toBeNull();

    dispatchPointer(window, 'pointerup', { clientX: 222, clientY: 52, pointerId: 7 });
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();

    controller.dispose();
    host.remove();
  });

  it('renders ghost and drop overlay past threshold, commits onDrop on release, and cleans up DOM', () => {
    const { host, source } = setupHost();
    const setCapture = vi.fn();
    const releaseCapture = vi.fn();
    source.setPointerCapture = setCapture;
    source.releasePointerCapture = releaseCapture;

    const onDragStart = vi.fn();
    const onDrop = vi.fn();
    const onDragEnd = vi.fn();

    const controller = new DockDndController({
      doc: document,
      host,
      thresholdPx: 5,
      getDropZones: () => sampleSnapshot,
      onDragStart,
      onDrop,
      onDragEnd,
    });
    controller.attachSource(source, samplePayload);

    dispatchPointer(source, 'pointerdown', { clientX: 210, clientY: 50, pointerId: 3 });
    expect(setCapture).toHaveBeenCalledWith(3);

    // Move into right edge of group g1 -> split right.
    dispatchPointer(window, 'pointermove', { clientX: 560, clientY: 200, pointerId: 3 });
    expect(controller.isDragging).toBe(true);
    expect(onDragStart).toHaveBeenCalledWith(samplePayload);
    expect(host.classList.contains('wb-is-dragging')).toBe(true);

    const ghost = host.querySelector('.wb-dnd-ghost') as HTMLDivElement | null;
    const overlay = host.querySelector('.wb-dnd-overlay') as HTMLDivElement | null;
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toBe('Topic One');
    expect(ghost?.style.left).toBe('572px');
    expect(ghost?.style.top).toBe('212px');
    expect(overlay?.hidden).toBe(false);
    expect(overlay?.getAttribute('data-dnd-zone')).toBe('right');
    expect(overlay?.style.left).toBe('400px');
    expect(overlay?.style.width).toBe('200px');

    // Move over tab bar -> insertion indicator line.
    dispatchPointer(window, 'pointermove', { clientX: 360, clientY: 52, pointerId: 3 });
    expect(overlay?.getAttribute('data-dnd-zone')).toBe('tab-insert');
    expect(overlay?.classList.contains('is-line')).toBe(true);

    // Release on secondary sidebar.
    dispatchPointer(window, 'pointerup', { clientX: 650, clientY: 120, pointerId: 3 });
    expect(controller.isDragging).toBe(false);
    expect(releaseCapture).toHaveBeenCalledWith(3);
    expect(host.classList.contains('wb-is-dragging')).toBe(false);
    expect(host.querySelector('.wb-dnd-ghost')).toBeNull();
    expect(host.querySelector('.wb-dnd-overlay')).toBeNull();

    const expectedDrop: DropTarget = {
      kind: 'part',
      part: 'secondary',
      region: 'body',
      rect: { left: 600, top: 40, width: 240, height: 300 },
    };
    expect(onDrop).toHaveBeenCalledWith(samplePayload, expectedDrop);
    expect(onDragEnd).toHaveBeenCalledWith(samplePayload, true);

    controller.dispose();
    host.remove();
  });

  it('cancels on Escape without closing underlying overlays and cleans up DOM/listeners', () => {
    const { host, source } = setupHost();
    const overlays = new OverlayManager();
    const underlyingClose = vi.fn();
    overlays.attach(document);
    overlays.push({ id: 'modal', close: underlyingClose });

    const onDrop = vi.fn();
    const onDragEnd = vi.fn();

    const controller = new DockDndController({
      doc: document,
      host,
      overlays,
      thresholdPx: 4,
      getDropZones: () => sampleSnapshot,
      onDrop,
      onDragEnd,
    });
    controller.attachSource(source, samplePayload);

    dispatchPointer(source, 'pointerdown', { clientX: 210, clientY: 50, pointerId: 1 });
    dispatchPointer(window, 'pointermove', { clientX: 260, clientY: 160, pointerId: 1 });
    expect(controller.isDragging).toBe(true);
    expect(overlays.size).toBe(2);

    // IME Escape should not cancel drag.
    const composingEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    Object.defineProperty(composingEsc, 'isComposing', { value: true });
    document.dispatchEvent(composingEsc);
    expect(controller.isDragging).toBe(true);

    // Real Escape cancels drag only, leaving underlying modal intact.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(controller.isDragging).toBe(false);
    expect(underlyingClose).not.toHaveBeenCalled();
    expect(overlays.size).toBe(1);
    expect(host.querySelector('.wb-dnd-ghost')).toBeNull();
    expect(host.querySelector('.wb-dnd-overlay')).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenCalledWith(samplePayload, false);

    // Subsequent pointerup after cancel is a no-op.
    dispatchPointer(window, 'pointerup', { clientX: 260, clientY: 160, pointerId: 1 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenCalledTimes(1);

    controller.dispose();
    overlays.dispose();
    host.remove();
  });

  it('cancels safely on pointercancel and window blur with zero leftover DOM', () => {
    const { host, source } = setupHost();
    const onDrop = vi.fn();
    const onDragEnd = vi.fn();

    const controller = new DockDndController({
      doc: document,
      host,
      thresholdPx: 4,
      getDropZones: () => sampleSnapshot,
      onDrop,
      onDragEnd,
    });
    controller.attachSource(source, samplePayload);

    // pointercancel
    dispatchPointer(source, 'pointerdown', { clientX: 210, clientY: 50, pointerId: 9 });
    dispatchPointer(window, 'pointermove', { clientX: 250, clientY: 120, pointerId: 9 });
    expect(controller.isDragging).toBe(true);

    dispatchPointer(window, 'pointercancel', { clientX: 250, clientY: 120, pointerId: 9 });
    expect(controller.isDragging).toBe(false);
    expect(host.querySelector('.wb-dnd-ghost')).toBeNull();
    expect(host.querySelector('.wb-dnd-overlay')).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenCalledWith(samplePayload, false);

    // window blur
    dispatchPointer(source, 'pointerdown', { clientX: 210, clientY: 50, pointerId: 10 });
    dispatchPointer(window, 'pointermove', { clientX: 250, clientY: 120, pointerId: 10 });
    expect(controller.isDragging).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(controller.isDragging).toBe(false);
    expect(host.querySelector('.wb-dnd-ghost')).toBeNull();
    expect(host.querySelector('.wb-dnd-overlay')).toBeNull();
    expect(onDragEnd).toHaveBeenCalledTimes(2);

    controller.dispose();
    host.remove();
  });

  it('respects tablet allowSplit=false, mobile enabled=false, non-primary buttons, and data-dnd-ignore', () => {
    const { host, source } = setupHost();
    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('data-dnd-ignore', '');
    source.appendChild(closeBtn);

    // Mobile mode: enabled=false does not attach listeners at all.
    const mobileOnStart = vi.fn();
    const mobile = new DockDndController({
      doc: document,
      host,
      enabled: false,
      onDragStart: mobileOnStart,
    });
    const addSpy = vi.spyOn(source, 'addEventListener');
    mobile.attachSource(source, samplePayload);
    expect(addSpy).not.toHaveBeenCalled();
    addSpy.mockRestore();
    mobile.dispose();

    // Tablet mode: allowSplit=false keeps group drops as 'within'.
    const onDrop = vi.fn();
    const tablet = new DockDndController({
      doc: document,
      host,
      allowSplit: false,
      thresholdPx: 4,
      getDropZones: () => sampleSnapshot,
      onDrop,
    });
    tablet.attachSource(source, samplePayload);

    // Right-click ignored.
    dispatchPointer(source, 'pointerdown', { clientX: 210, clientY: 50, button: 2, pointerId: 1 });
    dispatchPointer(window, 'pointermove', { clientX: 560, clientY: 200, pointerId: 1 });
    expect(tablet.isDragging).toBe(false);

    // data-dnd-ignore child ignored.
    dispatchPointer(closeBtn, 'pointerdown', { clientX: 210, clientY: 50, button: 0, pointerId: 2 });
    dispatchPointer(window, 'pointermove', { clientX: 560, clientY: 200, pointerId: 2 });
    expect(tablet.isDragging).toBe(false);

    // Primary drag onto group right edge resolves to 'within' in tablet mode.
    dispatchPointer(source, 'pointerdown', { clientX: 210, clientY: 50, button: 0, pointerId: 3 });
    dispatchPointer(window, 'pointermove', { clientX: 560, clientY: 200, pointerId: 3 });
    expect(tablet.isDragging).toBe(true);
    dispatchPointer(window, 'pointerup', { clientX: 560, clientY: 200, pointerId: 3 });
    expect(onDrop).toHaveBeenCalledWith(samplePayload, {
      kind: 'group',
      group: 'g1',
      direction: 'within',
      rect: { left: 200, top: 40, width: 400, height: 300 },
    });

    tablet.dispose();
    host.remove();
  });
});
