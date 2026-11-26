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

    // Toggle sort direction
    const dirBtn = bar.el.querySelector<HTMLButtonElement>('.fh-fb-dir')!;
    dirBtn.click();
    expect(bar.state().dir).toBe('asc');

    // Pruning drops selections removed from groups
    bar.setGroups([{ id: 'state', label: 'State', pinned: true, options: [{ value: 'run', label: 'Running' }] }]);
    expect(bar.state().sel.agent).toBeUndefined();

    // i18n refresh updates placeholder and sort option labels
    bar.refreshI18n('Find tasks', { recent: 'Latest', name: 'Title' });
    expect(bar.el.querySelector<HTMLInputElement>('.fh-fb-q')!.placeholder).toBe('Find tasks');
    const labels = Array.from(bar.el.querySelectorAll<HTMLOptionElement>('.fh-fb-sortsel option')).map(
      (o) => o.textContent,
    );
    expect(labels).toEqual(['Latest', 'Title']);

    bar.clear();
    expect(bar.active()).toBe(false);
    bar.dispose();
  });
});
