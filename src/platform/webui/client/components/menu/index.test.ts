// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayManager } from '../../services/overlays.js';
import { computeMenuPosition, createMenu } from './index.js';

describe('components/menu', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clamps menu position inside viewport and flips above when overflowing bottom', () => {
    const flipped = computeMenuPosition(
      { left: 760, right: 790, top: 560, bottom: 585 },
      { width: 200, height: 120 },
      { width: 800, height: 600 },
      'end',
      8,
    );
    expect(flipped.left).toBe(590);
    expect(flipped.top).toBe(436);

    const clampedLeft = computeMenuPosition(
      { left: 2, right: 20, top: 10, bottom: 30 },
      { width: 200, height: 80 },
      { width: 800, height: 600 },
      'end',
      8,
    );
    expect(clampedLeft.left).toBe(8);
    expect(clampedLeft.top).toBe(34);
  });

  it('supports keyboard navigation, separators, shortcuts, and OverlayManager Escape restore', () => {
    const overlays = new OverlayManager();
    const anchor = document.createElement('button');
    anchor.textContent = 'More';
    document.body.appendChild(anchor);
    const focusSpy = vi.spyOn(anchor, 'focus');

    const menu = createMenu({ overlays });
    const onSelect = vi.fn();

    menu.open(
      anchor,
      [
        { id: 'star', label: 'Star', shortcut: 'S' },
        { id: 'disabled', label: 'Disabled', disabled: true },
        { kind: 'separator' },
        { id: 'delete', label: 'Delete', danger: true },
      ],
      onSelect,
    );

    expect(menu.isOpen()).toBe(true);
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    expect(menu.el.querySelector('[role="separator"]')).not.toBeNull();
    expect(menu.el.querySelector('.fh-menu-kbd')?.textContent).toBe('S');

    const starBtn = menu.el.querySelector<HTMLButtonElement>('[data-menu-id="star"]')!;
    const delBtn = menu.el.querySelector<HTMLButtonElement>('[data-menu-id="delete"]')!;
    expect(document.activeElement).toBe(starBtn);

    // ArrowDown skips disabled item and lands on delete
    menu.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(delBtn);

    // Home returns to first item
    menu.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(starBtn);

    // Escape via OverlayManager closes menu and restores focus to anchor
    expect(overlays.handleEscape()).toBe(true);
    expect(menu.isOpen()).toBe(false);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
    expect(focusSpy).toHaveBeenCalled();

    // Selecting an item invokes callback and closes menu
    menu.open({ x: 40, y: 50 }, [{ id: 'copy', label: 'Copy' }], onSelect);
    menu.el.querySelector<HTMLButtonElement>('[data-menu-id="copy"]')!.click();
    expect(onSelect).toHaveBeenCalledWith('copy', expect.objectContaining({ id: 'copy' }));
    expect(menu.isOpen()).toBe(false);

    menu.dispose();
    overlays.dispose();
  });
});
