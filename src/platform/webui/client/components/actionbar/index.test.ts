// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionBar } from './index.js';

describe('components/actionbar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders variants, tooltips, disabled/active states, and dispatches click callbacks', () => {
    const onSave = vi.fn();
    const onAction = vi.fn();
    const bar = createActionBar({
      ariaLabel: 'Editor actions',
      items: [
        { id: 'save', label: 'Save', variant: 'primary', title: 'Save file', onClick: onSave },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
        { id: 'more', icon: '<svg class="ic"></svg>', title: 'More' },
      ],
      onAction,
    });
    document.body.appendChild(bar.el);

    const saveBtn = bar.el.querySelector<HTMLButtonElement>('[data-action-id="save"]')!;
    const moreBtn = bar.el.querySelector<HTMLButtonElement>('[data-action-id="more"]')!;
    expect(saveBtn.classList.contains('fh-btn--primary')).toBe(true);
    expect(moreBtn.classList.contains('fh-btn--icon')).toBe(true);
    expect(moreBtn.getAttribute('aria-label')).toBe('More');

    saveBtn.click();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('save', expect.objectContaining({ type: 'click' }));

    bar.setDisabled('save', true);
    expect(saveBtn.disabled).toBe(true);

    bar.setActive('more', true);
    expect(moreBtn.classList.contains('is-active')).toBe(true);
    expect(moreBtn.getAttribute('aria-pressed')).toBe('true');

    bar.dispose();
  });
});
