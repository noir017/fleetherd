// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n/index.js';
import { createFilterBar } from './index.js';

function makeMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe('components/filterbar', () => {
  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('filters by query and chips, persists state, prunes removed options, and refreshes i18n', () => {
    const storage = makeMemoryStorage();
    const onChange = vi.fn();
    const onPersist = vi.fn();

    const bar = createFilterBar({
      key: 'test_fb',
      placeholder: 'Search items',
      groups: [
        { id: 'state', label: 'State', pinned: true, options: [{ value: 'run', label: 'Running', count: 2 }] },
        { id: 'agent', label: 'Agent', options: [{ value: 'claude', label: 'Claude', count: 1 }] },
      ],
      sort: {
        options: [
          { value: 'recent', label: 'Recent' },
          { value: 'name', label: 'Name' },
        ],
        value: 'recent',
        dir: 'desc',
      },
      storage,
      onChange,
      onPersist,
    });
    document.body.appendChild(bar.el);

    const input = bar.el.querySelector<HTMLInputElement>('.fh-fb-q')!;
    input.value = 'deploy';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(bar.active()).toBe(true);
    expect(bar.state().q).toBe('deploy');
    expect(onPersist).toHaveBeenCalled();

    // Escape clears search input
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bar.state().q).toBe('');

    // Open filter panel and toggle non-pinned chip
    const filterBtn = bar.el.querySelector<HTMLButtonElement>('.fh-fb-filter')!;
    filterBtn.click();
    expect(bar.state().open).toBe(true);

    const agentChip = bar.el.querySelector<HTMLButtonElement>('[data-fb-value="claude"]')!;
    agentChip.click();
    expect(bar.state().sel.agent).toEqual(['claude']);
    expect(bar.el.querySelector<HTMLElement>('.fh-fb-dot')!.hidden).toBe(false);

    // Summary counts and clear
    bar.setCounts(1, 5);
    expect(bar.el.querySelector<HTMLElement>('.fh-fb-sum')!.hidden).toBe(false);
    expect(bar.el.querySelector('.fh-fb-sumtext')?.textContent).toBe('Showing 1 of 5');

    // Opening sort menu closes open filter panel and shows sort options + separator + directions
    const sortBtn = bar.el.querySelector<HTMLButtonElement>('.fh-fb-sort-btn')!;
    expect(sortBtn.getAttribute('aria-haspopup')).toBe('menu');
    expect(sortBtn.getAttribute('aria-expanded')).toBe('false');
    expect(sortBtn.title).toContain('Recent');
    expect(sortBtn.title).toContain('Descending');

    sortBtn.click();
    expect(bar.state().open).toBe(false);
    expect(sortBtn.getAttribute('aria-expanded')).toBe('true');

    const sortMenu = document.querySelector<HTMLElement>('.fh-fb-sort-menu')!;
    expect(sortMenu.hidden).toBe(false);
    expect(sortMenu.querySelector('[role="separator"]')).not.toBeNull();
    expect(sortMenu.querySelector('[data-menu-id="sort:recent"]')?.classList.contains('is-checked')).toBe(true);
    expect(sortMenu.querySelector('[data-menu-id="sort:recent"] .fh-menu-check')).not.toBeNull();
    expect(sortMenu.querySelector('[data-menu-id="dir:desc"]')?.classList.contains('is-checked')).toBe(true);
    expect(sortMenu.querySelector('[data-menu-id="dir:asc"]')?.classList.contains('is-checked')).toBe(false);

    // Selecting direction updates state, persists, and closes menu
    sortMenu.querySelector<HTMLButtonElement>('[data-menu-id="dir:asc"]')!.click();
    expect(bar.state().dir).toBe('asc');
    expect(sortMenu.hidden).toBe(true);
    expect(sortBtn.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(storage.getItem('test_fb')!)).toMatchObject({ sort: 'recent', dir: 'asc' });

    // Selecting sort field updates state and persists
    sortBtn.click();
    expect(sortMenu.querySelector('[data-menu-id="dir:asc"]')?.classList.contains('is-checked')).toBe(true);
    sortMenu.querySelector<HTMLButtonElement>('[data-menu-id="sort:name"]')!.click();
    expect(bar.state().sort).toBe('name');
    expect(JSON.parse(storage.getItem('test_fb')!)).toMatchObject({ sort: 'name', dir: 'asc' });

    // Opening filter panel closes open sort menu; clicking sort button again toggles close
    sortBtn.click();
    expect(sortMenu.hidden).toBe(false);
    filterBtn.click();
    expect(sortMenu.hidden).toBe(true);
    expect(bar.state().open).toBe(true);
    sortBtn.click();
    expect(sortMenu.hidden).toBe(false);
    expect(bar.state().open).toBe(false);
    sortBtn.click();
    expect(sortMenu.hidden).toBe(true);

    // Pruning drops selections removed from groups
    bar.setGroups([{ id: 'state', label: 'State', pinned: true, options: [{ value: 'run', label: 'Running' }] }]);
    expect(bar.state().sel.agent).toBeUndefined();

    // i18n refresh updates placeholder and sort option labels
    bar.refreshI18n('Find tasks', { recent: 'Latest', name: 'Title' });
    expect(bar.el.querySelector<HTMLInputElement>('.fh-fb-q')!.placeholder).toBe('Find tasks');
    sortBtn.click();
    const labels = Array.from(sortMenu.querySelectorAll<HTMLElement>('[data-menu-id^="sort:"] .fh-menu-label')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['Latest', 'Title']);
    sortBtn.click();

    bar.clear();
    expect(bar.active()).toBe(false);
    bar.dispose();
    expect(document.querySelector('.fh-fb-sort-menu')).toBeNull();
  });
});
