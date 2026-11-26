// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { html } from '../../base/html.js';
import { createSegmented, createTabs } from './index.js';

describe('components/tabs', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('supports tab selection, keyboard navigation, dirty dot, close button, and single-tab header mode', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const tabs = createTabs({
      items: [
        { id: 'a', label: 'index.ts', dirty: true, closable: true },
        { id: 'b', label: 'styles.css', closable: true },
      ],
      activeId: 'a',
      onSelect,
      onClose,
    });
    document.body.appendChild(tabs.el);

    expect(tabs.el.querySelector('.fh-tab-dirty')).not.toBeNull();
    const tabA = tabs.el.querySelector<HTMLButtonElement>('[data-tab-id="a"]')!;
    tabA.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith('b');

    const closeBtn = tabs.el.querySelector<HTMLButtonElement>('.fh-tab-close')!;
    closeBtn.click();
    expect(onClose).toHaveBeenCalledWith('a');

    // Single-tab header mode renders v3 title bar
    tabs.update({
      items: [{ id: 'a', label: 'Refactor UI', dirty: true }],
      singleTabMode: 'header',
      headerStatus: html`<span class="st">Running</span>`,
    });
    expect(tabs.el.querySelector('[data-single-tab="true"]')).not.toBeNull();
    expect(tabs.el.querySelector('.fh-tab-header-title')?.textContent).toBe('Refactor UI');
    expect(tabs.el.querySelector('.st')?.textContent).toBe('Running');

    tabs.dispose();
  });

  it('distinguishes nav vs value segmented switches and supports keyboard arrows', () => {
    const onNav = vi.fn();
    const nav = createSegmented({
      kind: 'nav',
      value: 'all',
      options: [
        { value: 'all', label: 'All', badge: 9 },
        { value: 'starred', label: 'Starred', badge: 2 },
      ],
      onChange: onNav,
    });
    document.body.appendChild(nav.el);
    expect(nav.el.querySelector('.fh-seg--nav')?.getAttribute('role')).toBe('tablist');
    const badge = nav.el.querySelector('[data-seg-value="all"] .fh-seg-count');
    expect(badge?.textContent).toBe('9');
    expect(badge?.classList.contains('fh-badge--accent')).toBe(false);

    const first = nav.el.querySelector<HTMLButtonElement>('[data-seg-value="all"]')!;
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(nav.getValue()).toBe('starred');
    expect(onNav).toHaveBeenCalledWith('starred');

    const onVal = vi.fn();
    const valSeg = createSegmented({
      kind: 'value',
      value: 'ask',
      options: [
        { value: 'plan', label: 'plan' },
        { value: 'ask', label: 'ask' },
        { value: 'auto', label: 'auto' },
      ],
      onChange: onVal,
    });
    document.body.appendChild(valSeg.el);
    expect(valSeg.el.querySelector('.fh-seg--value')?.getAttribute('role')).toBe('radiogroup');
    const autoBtn = valSeg.el.querySelector<HTMLButtonElement>('[data-seg-value="auto"]')!;
    autoBtn.click();
    expect(valSeg.getValue()).toBe('auto');
    expect(autoBtn.getAttribute('aria-checked')).toBe('true');

    nav.dispose();
    valSeg.dispose();
  });
});
