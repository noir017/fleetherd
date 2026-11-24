// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createList, type ListGroup } from './index.js';

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
});
