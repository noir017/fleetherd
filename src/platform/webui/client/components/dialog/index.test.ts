// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayManager } from '../../services/overlays.js';
import { openConfirmDialog, openDialog } from './index.js';

describe('components/dialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('handles focus trap, OverlayManager Escape, and async loading/error states', async () => {
    const overlays = new OverlayManager();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    let resolveOp: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOp = () => resolve();
        }),
    );

    const dlg = openDialog({
      title: 'Delete topic',
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      overlays,
      onConfirm,
    });

    const confirmBtn = dlg.el.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]')!;
    const closeBtn = dlg.el.querySelector<HTMLButtonElement>('.fh-dialog-close')!;
    expect(confirmBtn.classList.contains('fh-btn--danger')).toBe(true);
    expect(document.activeElement).toBe(confirmBtn);

    // Tab wraps from last focusable (confirmBtn) to first (closeBtn)
    dlg.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(closeBtn);

    // Click confirm enters async loading state and blocks Escape dismissal
    confirmBtn.click();
    expect(confirmBtn.disabled).toBe(true);
    expect(confirmBtn.getAttribute('aria-busy')).toBe('true');
    expect(overlays.handleEscape()).toBe(true);
    expect(dlg.isOpen()).toBe(true);

    // Resolving closes dialog
    resolveOp();
    await Promise.resolve();
    await Promise.resolve();
    expect(dlg.isOpen()).toBe(false);
    overlays.dispose();
  });

  it('surfaces rejected async errors and supports openConfirmDialog promise', async () => {
    const dlg = openDialog({
      title: 'Sync',
      body: 'Push changes?',
      onConfirm: async () => {
        throw new Error('Network offline');
      },
    });
    dlg.el.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(dlg.isOpen()).toBe(true);
    expect(dlg.el.querySelector('.fh-dialog-err')?.textContent).toContain('Network offline');
    dlg.close();

    const overlays = new OverlayManager();
    const p = openConfirmDialog({ title: 'Confirm', body: 'Proceed?', overlays });
    expect(overlays.handleEscape()).toBe(true);
    expect(await p).toBe(false);
    overlays.dispose();
  });
});
