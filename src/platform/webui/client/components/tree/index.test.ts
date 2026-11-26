// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTree, type TreeNode } from './index.js';

const TREE_DATA: TreeNode<string>[] = [
  {
    id: 'src',
    label: 'src',
    children: [
      { id: 'src/index.ts', label: 'index.ts', data: 'file' },
      {
        id: 'src/ui',
        label: 'ui',
        children: [{ id: 'src/ui/app.ts', label: 'app.ts', data: 'file' }],
      },
    ],
  },
  { id: 'README.md', label: 'README.md', data: 'file' },
];

describe('components/tree', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('expands/collapses branches via keyboard ArrowRight/ArrowLeft and navigates levels', () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const tree = createTree({
      nodes: TREE_DATA,
      selectedId: 'src',
      onToggle,
      onSelect,
    });
    document.body.appendChild(tree.el);

    expect(tree.el.querySelectorAll('[role="treeitem"]').length).toBe(2);

    // ArrowRight expands src
    const srcRow = tree.el.querySelector<HTMLElement>('[data-tree-id="src"]')!;
    srcRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tree.getExpandedIds().has('src')).toBe(true);
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'src' }), true);
    expect(tree.el.querySelectorAll('[role="treeitem"]').length).toBe(4);

    // Second ArrowRight moves into first child
    tree.el
      .querySelector<HTMLElement>('[data-tree-id="src"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tree.getSelected()).toBe('src/index.ts');

    // ArrowLeft on leaf moves back to parent
    tree.el
      .querySelector<HTMLElement>('[data-tree-id="src/index.ts"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(tree.getSelected()).toBe('src');

    // ArrowLeft on expanded branch collapses it
    tree.el
      .querySelector<HTMLElement>('[data-tree-id="src"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(tree.getExpandedIds().has('src')).toBe(false);
    expect(tree.el.querySelectorAll('[role="treeitem"]').length).toBe(2);

    tree.expandAll();
    expect(tree.el.querySelectorAll('[role="treeitem"]').length).toBe(5);
    tree.collapseAll();
    expect(tree.el.querySelectorAll('[role="treeitem"]').length).toBe(2);

    tree.dispose();
  });
});
