// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayManager } from '../../services/overlays.js';
import { fuzzyMatch, openQuickPick, type QuickPickItem } from './index.js';

const ITEMS: QuickPickItem<string>[] = [
  { id: 'm1', label: 'claude-sonnet-4.5', group: 'Anthropic', description: 'Fast', data: 'sonnet' },
  { id: 'm2', label: 'claude-opus-4', group: 'Anthropic', description: 'Deep', data: 'opus' },
  { id: 'm3', label: 'gpt-5-codex', group: 'OpenAI', description: 'Coding', data: 'codex' },
];

describe('components/quickpick', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('scores fuzzy matches with matched character indices', () => {
    const hit = fuzzyMatch('cs4', 'claude-sonnet-4.5');
    expect(hit).not.toBeNull();
    expect(hit!.indices).toEqual([0, 7, 14]);
    expect(fuzzyMatch('zzz', 'claude-sonnet-4.5')).toBeNull();
  });

  it('filters live, navigates with keyboard, selects on Enter, and cancels on Escape', async () => {
    const overlays = new OverlayManager();
    const onSelect = vi.fn();
    const qp = openQuickPick({
      items: ITEMS,
      placeholder: 'Switch model',
      emptyText: 'No models found',
      overlays,
      onSelect,
    });

    expect(qp.el.querySelectorAll('.fh-qp-group').length).toBe(2);

    const input = qp.el.querySelector<HTMLInputElement>('.fh-qp-input')!;
    input.value = 'claude';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(qp.el.querySelectorAll('.fh-qp-row').length).toBe(2);
    expect(qp.el.querySelectorAll('.fh-qp-mark').length).toBeGreaterThan(0);

    // Shorter prefix match (m2: claude-opus-4) ranks first; ArrowDown moves to second match (m1)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const picked = await qp.promise;
    expect(picked?.id).toBe('m1');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
    expect(qp.isOpen()).toBe(false);

    // Empty results + Escape dismissal via OverlayManager
    const qp2 = openQuickPick({ items: ITEMS, emptyText: 'Nothing matches', overlays });
    qp2.setQuery('nonexistent-xyz');
    expect(qp2.el.querySelector('.fh-qp-empty')?.textContent).toBe('Nothing matches');
    expect(overlays.handleEscape()).toBe(true);
    expect(await qp2.promise).toBeUndefined();

    overlays.dispose();
  });
});
