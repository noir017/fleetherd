import { describe, expect, it } from 'vitest';

import { clampSize, layoutSplitSizes, resizeSplitAt, type SplitPaneSpec } from './splitview.js';

describe('workbench/dock/splitview (pure math, node)', () => {
  it('clamps sizes within [min, max] and handles non-finite inputs', () => {
    expect(clampSize(100, 180, 480)).toBe(180);
    expect(clampSize(600, 180, 480)).toBe(480);
    expect(clampSize(300, 180, 480)).toBe(300);
    expect(clampSize(Number.NaN, 180, 480)).toBe(180);
    expect(clampSize(300, -10)).toBe(300);
    expect(clampSize(50, 200, 100)).toBe(200);
  });

  it('lays out panes respecting priority, min/max, fixed, and hidden panes', () => {
    const panes: SplitPaneSpec[] = [
      { minSize: 180, maxSize: 480, defaultSize: 264, priority: 'low' },
      { minSize: 320, defaultSize: 640, priority: 'high' },
      { minSize: 280, maxSize: 720, defaultSize: 420, visible: false, priority: 'normal' },
    ];

    const sizes = layoutSplitSizes(panes, 1200);
    expect(sizes).toEqual([264, 936, 0]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1200);
  });

  it('shrinks low-priority panes before high-priority panes on narrow total size', () => {
    const panes: SplitPaneSpec[] = [
      { minSize: 180, maxSize: 480, size: 300, priority: 'low' },
      { minSize: 320, size: 640, priority: 'high' },
    ];

    const sizes = layoutSplitSizes(panes, 860);
    expect(sizes).toEqual([220, 640]);
  });

  it('keeps fixed panes untouched during reflow', () => {
    const panes: SplitPaneSpec[] = [
      { minSize: 52, size: 52, fixed: true },
      { minSize: 200, size: 300 },
      { minSize: 200, size: 400 },
    ];
    const sizes = layoutSplitSizes(panes, 1052);
    expect(sizes[0]).toBe(52);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1052);
  });

  it('returns all zeros when totalSize is 0 or panes is empty', () => {
    expect(layoutSplitSizes([], 1000)).toEqual([]);
    expect(layoutSplitSizes([{ minSize: 100, size: 200 }], 0)).toEqual([0]);
  });

  it('resizes adjacent panes around sashIndex while preserving total size and clamping bounds', () => {
    const panes: SplitPaneSpec[] = [
      { minSize: 180, maxSize: 480, size: 264, priority: 'low' },
      { minSize: 320, size: 600, priority: 'high' },
      { minSize: 280, maxSize: 720, size: 400, priority: 'normal' },
    ];
    const start = [264, 600, 400];

    expect(resizeSplitAt(panes, start, 0, 100)).toEqual([364, 500, 400]);
    expect(resizeSplitAt(panes, start, 0, -200)).toEqual([180, 684, 400]);
    expect(resizeSplitAt(panes, start, 1, -100)).toEqual([264, 500, 500]);

    expect(resizeSplitAt(panes, start, -1, 50)).toEqual(start);
    expect(resizeSplitAt(panes, start, 2, 50)).toEqual(start);
    expect(resizeSplitAt(panes, start, 0, 0)).toEqual(start);
  });

  it('skips hidden panes when dragging a sash', () => {
    const panes: SplitPaneSpec[] = [
      { minSize: 180, maxSize: 480, size: 260, visible: true },
      { minSize: 100, size: 0, visible: false },
      { minSize: 300, size: 600, visible: true },
    ];
    const next = resizeSplitAt(panes, [260, 0, 600], 0, 40);
    expect(next).toEqual([300, 0, 560]);
  });
});
