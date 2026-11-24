// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachListNavigation, createList, type ListGroup } from './index.js';

const GROUPS: ListGroup<string>[] = [
  {
    id: 'attention',
    label: 'Needs attention',
    items: [
      { id: 't1', label: 'Deploy notes', meta: 'Waiting', hasMenu: true, data: 'd1' },
      { id: 't2', label: 'Disabled row', disabled: true, data: 'd2' },
    ],
  },
  {
    id: 'today',
    label: 'Today',
    items: [
      { id: 't3', label: 'Refactor UI', trailing: '2m', hasMenu: true, data: 'd3' },
      { id: 't4', label: 'Fix tests', indent: 1, data: 'd4' },
    ],
  },
];

describe('components/list', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders grouped headers, selection state, and navigates with keyboard skipping disabled items', () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    const list = createList({
      groups: GROUPS,
      selectedId: 't1',
      ariaLabel: 'Topics',
      onSelect,
      onActivate,
    });
    document.body.appendChild(list.el);

    const heads = Array.from(list.el.querySelectorAll('.fh-list-group-head')).map((el) => el.textContent);
    expect(heads).toEqual(['Needs attention', 'Today']);

    const row1 = list.el.querySelector<HTMLElement>('[data-list-id="t1"]')!;
    expect(row1.classList.contains('is-selected')).toBe(true);
    expect(row1.getAttribute('aria-selected')).toBe('true');

    // ArrowDown from t1 skips disabled t2 and selects t3
    row1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(list.getSelected()).toBe('t3');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 't3' }), expect.any(KeyboardEvent));

    // End moves to t4, Home moves back to t1
    const row3 = list.el.querySelector<HTMLElement>('[data-list-id="t3"]')!;
    row3.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(list.getSelected()).toBe('t4');

    const row4 = list.el.querySelector<HTMLElement>('[data-list-id="t4"]')!;
    row4.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(list.getSelected()).toBe('t1');

    // Enter activates current row
    const row1After = list.el.querySelector<HTMLElement>('[data-list-id="t1"]')!;
    row1After.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.any(KeyboardEvent));

    list.dispose();
  });

  it('triggers row-end menu callback without activating the row', () => {
    const onActivate = vi.fn();
    const onItemMenu = vi.fn();
    const list = createList({
      groups: GROUPS,
      menuIcon: '<svg class="ic"></svg>',
      onActivate,
      onItemMenu,
    });
    document.body.appendChild(list.el);

    const menuBtn = list.el.querySelector<HTMLButtonElement>('[data-list-id="t1"] .fh-list-menu-btn')!;
    menuBtn.click();

    expect(onItemMenu).toHaveBeenCalledTimes(1);
    expect(onItemMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), menuBtn, expect.any(MouseEvent));
    expect(onActivate).not.toHaveBeenCalled();

    list.dispose();
  });

  it('supports empty state and batch multi-select range hook', () => {
    const onSelectionChange = vi.fn();
    const list = createList({
      groups: [],
      empty: { title: 'No topics', description: 'Start a new one' },
      multiSelect: true,
      onSelectionChange,
    });
    document.body.appendChild(list.el);

    expect(list.el.querySelector('.fh-empty-title')?.textContent).toBe('No topics');

    list.setGroups(GROUPS);
    const r1 = list.el.querySelector<HTMLElement>('[data-list-id="t1"]')!;
    const r4 = list.el.querySelector<HTMLElement>('[data-list-id="t4"]')!;
    r1.click();
    expect(Array.from(list.getSelectedIds())).toEqual(['t1']);

    r4.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(Array.from(list.getSelectedIds()).sort()).toEqual(['t1', 't3', 't4']);
    expect(onSelectionChange).toHaveBeenCalledTimes(2);

    list.dispose();
  });

  it('supports Space toggle, Shift+Arrow range select, Mod+A select all, Escape exit, and batch action bar', () => {
    const onSelectionChange = vi.fn();
    const onExitMultiSelect = vi.fn();
    const onBatchDelete = vi.fn();
    const list = createList({
      groups: GROUPS,
      selectedId: 't1',
      onSelectionChange,
      onExitMultiSelect,
      batchActions: [
        {
          id: 'delete',
          label: 'Delete',
          variant: 'danger',
          onAction: onBatchDelete,
        },
      ],
    });
    document.body.appendChild(list.el);

    // No batch bar before selection
    expect(list.el.querySelector('.fh-list-batch')).toBeNull();

    // Space toggles t1 and opens batch bar
    const r1 = list.el.querySelector<HTMLElement>('[data-list-id="t1"]')!;
    r1.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(Array.from(list.getSelectedIds())).toEqual(['t1']);
    expect(list.el.querySelector('.fh-list-batch-count')?.textContent).toBe('1 selected');

    // Shift+ArrowDown extends selection to t3 (skipping disabled t2)
    const r1After = list.el.querySelector<HTMLElement>('[data-list-id="t1"]')!;
    r1After.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    expect(Array.from(list.getSelectedIds()).sort()).toEqual(['t1', 't3']);

    // Mod+A selects all enabled items
    const r3 = list.el.querySelector<HTMLElement>('[data-list-id="t3"]')!;
    r3.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    expect(Array.from(list.getSelectedIds()).sort()).toEqual(['t1', 't3', 't4']);
    expect(list.el.querySelector<HTMLButtonElement>('[data-batch-select-all]')!.disabled).toBe(true);

    // Custom batch action receives selected items & IDs
    list.el.querySelector<HTMLButtonElement>('[data-batch-action="delete"]')!.click();
    expect(onBatchDelete).toHaveBeenCalledTimes(1);
    const [itemsArg, idsArg] = onBatchDelete.mock.calls[0]!;
    expect(itemsArg.map((i: { id: string }) => i.id)).toEqual(['t1', 't3', 't4']);
    expect(Array.from(idsArg as ReadonlySet<string>).sort()).toEqual(['t1', 't3', 't4']);

    // Escape exits multi-select and clears batch bar
    const r3Again = list.el.querySelector<HTMLElement>('[data-list-id="t3"]')!;
    r3Again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(list.getSelectedIds().size).toBe(0);
    expect(list.el.querySelector('.fh-list-batch')).toBeNull();
    expect(onExitMultiSelect).toHaveBeenCalledTimes(1);

    list.dispose();
  });

  it('attachListNavigation provides unified keyboard navigation, Shift+Click range select, Mod+A, and Escape', () => {
    const batchHost = document.createElement('div');
    const container = document.createElement('div');
    container.innerHTML = [
      '<div class="row" data-id="a" tabindex="0">A</div>',
      '<div class="row" data-id="b" tabindex="0">B</div>',
      '<div class="row" data-id="c" tabindex="0">C</div>',
    ].join('');
    document.body.append(batchHost, container);

    const onActivate = vi.fn();
    const onRun = vi.fn();
    const nav = attachListNavigation({
      container,
      batchBarHost: batchHost,
      rowSelector: '.row',
      getRowId: (el) => el.getAttribute('data-id'),
      onActivate,
      getBatchActions: () => [{ id: 'run', label: 'Run', onAction: onRun }],
    });

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.row'));
    rows[0]!.focus();
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(rows[1]);

    rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(rows[2]);

    rows[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(rows[0]);

    // Space selects row a, Shift+Click row c selects a, b, c
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    rows[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(Array.from(nav.getSelectedIds()).sort()).toEqual(['a', 'b', 'c']);
    expect(batchHost.hidden).toBe(false);

    batchHost.querySelector<HTMLButtonElement>('[data-batch-action="run"]')!.click();
    expect(onRun).toHaveBeenCalledTimes(1);

    // Escape clears selection
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(nav.getSelectedIds().size).toBe(0);
    expect(batchHost.hidden).toBe(true);

    // Enter activates focused row
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onActivate).toHaveBeenCalledWith('a', rows[0], expect.any(KeyboardEvent));

    nav.dispose();
  });
});
