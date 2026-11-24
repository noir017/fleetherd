import { describe, expect, it } from 'vitest';

import type { GridNodeState } from '../contracts.js';
import {
  computeGroupRects,
  createLeafNode,
  findGroup,
  listGroups,
  normalizeGrid,
  removeGroup,
  resizeBranch,
  splitGroup,
  updateLeaf,
} from './gridview.js';

describe('workbench/dock/gridview (pure tree math, node)', () => {
  it('splits a leaf in all four directions with alternating horizontal/vertical orientations', () => {
    const root = createLeafNode('g1', ['p1'], 'p1');

    const right = splitGroup(root, 'g1', 'g2', 'right');
    expect(right.type).toBe('branch');
    if (right.type === 'branch') {
      expect(right.orientation).toBe('horizontal');
      expect(right.sizes).toEqual([0.5, 0.5]);
      expect(listGroups(right).map((g) => g.group)).toEqual(['g1', 'g2']);
    }

    const left = splitGroup(root, 'g1', 'g0', 'left');
    expect(left.type).toBe('branch');
    if (left.type === 'branch') {
      expect(left.orientation).toBe('horizontal');
      expect(listGroups(left).map((g) => g.group)).toEqual(['g0', 'g1']);
    }

    const below = splitGroup(right, 'g2', 'g3', 'below');
    expect(below.type).toBe('branch');
    if (below.type === 'branch') {
      expect(below.orientation).toBe('horizontal');
      expect(below.children[1]?.type).toBe('branch');
      const nested = below.children[1]!;
      if (nested.type === 'branch') {
        expect(nested.orientation).toBe('vertical');
        expect(listGroups(nested).map((g) => g.group)).toEqual(['g2', 'g3']);
      }
    }

    const above = splitGroup(root, 'g1', 'gTop', 'above');
    expect(above.type).toBe('branch');
    if (above.type === 'branch') {
      expect(above.orientation).toBe('vertical');
      expect(listGroups(above).map((g) => g.group)).toEqual(['gTop', 'g1']);
    }
  });

  it('ignores invalid split targets or duplicate group ids', () => {
    const root = createLeafNode('g1');
    expect(splitGroup(root, 'missing', 'g2', 'right')).toBe(root);
    expect(splitGroup(root, 'g1', 'g1', 'right')).toBe(root);
    const two = splitGroup(root, 'g1', 'g2', 'right');
    expect(splitGroup(two, 'g1', 'g2', 'below')).toBe(two);
  });

  it('flattens same-orientation nested branches and collapses single-child branches', () => {
    const step1 = splitGroup(createLeafNode('g1'), 'g1', 'g2', 'right');
    const step2 = splitGroup(step1, 'g2', 'g3', 'right');
    expect(step2.type).toBe('branch');
    if (step2.type === 'branch') {
      expect(step2.orientation).toBe('horizontal');
      expect(step2.children.length).toBe(3);
      expect(step2.children.map((c) => (c.type === 'leaf' ? c.group : 'branch'))).toEqual([
        'g1',
        'g2',
        'g3',
      ]);
      expect(step2.sizes[0]).toBeCloseTo(0.5, 5);
      expect(step2.sizes[1]).toBeCloseTo(0.25, 5);
      expect(step2.sizes[2]).toBeCloseTo(0.25, 5);
    }

    const manuallyNested: GridNodeState = {
      type: 'branch',
      orientation: 'horizontal',
      sizes: [2, 2],
      children: [
        {
          type: 'branch',
          orientation: 'horizontal',
          sizes: [1, 3],
          children: [createLeafNode('a'), createLeafNode('b')],
        },
        {
          type: 'branch',
          orientation: 'vertical',
          sizes: [1],
          children: [createLeafNode('c')],
        },
      ],
    };

    const normalized = normalizeGrid(manuallyNested);
    expect(normalized.type).toBe('branch');
    if (normalized.type === 'branch') {
      expect(normalized.orientation).toBe('horizontal');
      expect(listGroups(normalized).map((g) => g.group)).toEqual(['a', 'b', 'c']);
      expect(normalized.sizes[0]).toBeCloseTo(0.125, 5);
      expect(normalized.sizes[1]).toBeCloseTo(0.375, 5);
      expect(normalized.sizes[2]).toBeCloseTo(0.5, 5);
    }
  });

  it('removes groups, merges back into parent, flattens, and returns undefined for last leaf', () => {
    let tree: GridNodeState = createLeafNode('g1');
    tree = splitGroup(tree, 'g1', 'g2', 'right');
    tree = splitGroup(tree, 'g2', 'g3', 'below');
    tree = splitGroup(tree, 'g3', 'g4', 'right');

    const afterRemoveG4 = removeGroup(tree, 'g4')!;
    expect(listGroups(afterRemoveG4).map((g) => g.group)).toEqual(['g1', 'g2', 'g3']);
    expect(findGroup(afterRemoveG4, 'g3')?.path).toEqual([1, 1]);

    const afterRemoveG3 = removeGroup(afterRemoveG4, 'g3')!;
    expect(afterRemoveG3.type).toBe('branch');
    if (afterRemoveG3.type === 'branch') {
      expect(afterRemoveG3.orientation).toBe('horizontal');
      expect(afterRemoveG3.children.map((c) => (c.type === 'leaf' ? c.group : 'branch'))).toEqual([
        'g1',
        'g2',
      ]);
    }

    const afterRemoveG2 = removeGroup(afterRemoveG3, 'g2')!;
    expect(afterRemoveG2.type).toBe('leaf');
    if (afterRemoveG2.type === 'leaf') {
      expect(afterRemoveG2.group).toBe('g1');
    }

    expect(removeGroup(afterRemoveG2, 'g1')).toBeUndefined();
    expect(removeGroup(afterRemoveG2, 'nonexistent')).toBe(afterRemoveG2);
  });

  it('finds group locations and updates leaf metadata immutably', () => {
    let tree = splitGroup(createLeafNode('g1'), 'g1', 'g2', 'right');
    tree = splitGroup(tree, 'g2', 'g3', 'below');

    expect(findGroup(tree, 'g1')?.path).toEqual([0]);
    expect(findGroup(tree, 'g2')?.path).toEqual([1, 0]);
    expect(findGroup(tree, 'g3')?.path).toEqual([1, 1]);
    expect(findGroup(tree, 'missing')).toBeUndefined();

    const updated = updateLeaf(tree, 'g3', (leaf) => ({
      ...leaf,
      panels: ['file-a', 'file-b'],
      activePanel: 'file-b',
    }));
    expect(findGroup(updated, 'g3')?.node.panels).toEqual(['file-a', 'file-b']);
    expect(findGroup(updated, 'g3')?.node.activePanel).toBe('file-b');
    expect(findGroup(tree, 'g3')?.node.panels).toEqual([]);
  });

  it('resizes branch children at arbitrary path while clamping to min fraction', () => {
    let tree = splitGroup(createLeafNode('g1'), 'g1', 'g2', 'right');
    tree = splitGroup(tree, 'g2', 'g3', 'below');

    const resizedRoot = resizeBranch(tree, [], 0, 0.2);
    expect(resizedRoot.type).toBe('branch');
    if (resizedRoot.type === 'branch') {
      expect(resizedRoot.sizes[0]).toBeCloseTo(0.7, 5);
      expect(resizedRoot.sizes[1]).toBeCloseTo(0.3, 5);
    }

    const clampedRoot = resizeBranch(tree, [], 0, 0.9, 0.1);
    if (clampedRoot.type === 'branch') {
      expect(clampedRoot.sizes[0]).toBeCloseTo(0.9, 5);
      expect(clampedRoot.sizes[1]).toBeCloseTo(0.1, 5);
    }

    const resizedNested = resizeBranch(tree, [1], 0, -0.15);
    if (resizedNested.type === 'branch') {
      const rightBranch = resizedNested.children[1]!;
      expect(rightBranch.type).toBe('branch');
      if (rightBranch.type === 'branch') {
        expect(rightBranch.sizes[0]).toBeCloseTo(0.35, 5);
        expect(rightBranch.sizes[1]).toBeCloseTo(0.65, 5);
      }
    }

    expect(resizeBranch(tree, [], 5, 0.1)).toBe(tree);
    expect(resizeBranch(tree, [], 0, 0)).toBe(tree);
  });

  it('computes exact integer group rectangles and supports maximized group mode', () => {
    let tree = splitGroup(createLeafNode('g1'), 'g1', 'g2', 'right');
    tree = splitGroup(tree, 'g2', 'g3', 'below');
    tree = resizeBranch(tree, [], 0, -0.1); // 0.4 / 0.6

    const rects = computeGroupRects(tree, 1000, 600);
    expect(rects.get('g1')).toEqual({ x: 0, y: 0, width: 400, height: 600 });
    expect(rects.get('g2')).toEqual({ x: 400, y: 0, width: 600, height: 300 });
    expect(rects.get('g3')).toEqual({ x: 400, y: 300, width: 600, height: 300 });

    const oddRects = computeGroupRects(
      splitGroup(splitGroup(createLeafNode('a'), 'a', 'b', 'right'), 'b', 'c', 'right'),
      100,
      50,
    );
    const totalW =
      (oddRects.get('a')?.width ?? 0) +
      (oddRects.get('b')?.width ?? 0) +
      (oddRects.get('c')?.width ?? 0);
    expect(totalW).toBe(100);

    const maxRects = computeGroupRects(tree, 1000, 600, 'g3');
    expect(maxRects.get('g3')).toEqual({ x: 0, y: 0, width: 1000, height: 600 });
    expect(maxRects.get('g1')).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(maxRects.get('g2')).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
