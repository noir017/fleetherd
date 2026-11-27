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

  it('re-anchors cleanly via setAnchor, ignores detached reposition, restores focus to new anchor, and calls onClose', () => {
    const overlays = new OverlayManager();
    const onClose = vi.fn();
    const btn1 = document.createElement('button');
    const btn2 = document.createElement('button');
    document.body.append(btn1, btn2);

    const origGetRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === btn1 && this.isConnected) {
        return { left: 200, right: 224, top: 100, bottom: 120, width: 24, height: 20, x: 200, y: 100, toJSON: () => ({}) } as DOMRect;
      }
      if (this === btn2 && this.isConnected) {
        return { left: 200, right: 224, top: 100, bottom: 120, width: 24, height: 20, x: 200, y: 100, toJSON: () => ({}) } as DOMRect;
      }
      return origGetRect.call(this);
    });

    const menu = createMenu({ overlays, onClose });
    try {
      menu.open(btn1, [{ id: 'a', label: 'Action' }]);
      expect(menu.el.style.left).toBe('24px');
      expect(menu.el.style.top).toBe('124px');

      // Detaching btn1 and calling reposition must not jump to (8, 4)
      btn1.remove();
      menu.reposition();
      expect(menu.el.style.left).toBe('24px');
      expect(menu.el.style.top).toBe('124px');

      // Re-anchoring to btn2 sets aria-expanded and keeps position
      const focus2 = vi.spyOn(btn2, 'focus');
      menu.setAnchor(btn2);
      expect(btn2.getAttribute('aria-expanded')).toBe('true');
      expect(menu.el.style.left).toBe('24px');
      expect(menu.el.style.top).toBe('124px');

      // Escape restores focus to the re-anchored btn2 and fires onClose
      expect(overlays.handleEscape()).toBe(true);
      expect(menu.isOpen()).toBe(false);
      expect(btn2.getAttribute('aria-expanded')).toBe('false');
      expect(focus2).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      rectSpy.mockRestore();
      menu.dispose();
      overlays.dispose();
    }
  });

  it('renders checkmark indicator and aria-checked for checkable menu items', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const menu = createMenu();

    menu.open(anchor, [
      { id: 'a', label: 'Alpha', checked: true },
      { id: 'b', label: 'Beta', checked: false },
      { id: 'c', label: 'Gamma' },
    ]);

    const itemA = menu.el.querySelector<HTMLButtonElement>('[data-menu-id="a"]')!;
    const itemB = menu.el.querySelector<HTMLButtonElement>('[data-menu-id="b"]')!;
    const itemC = menu.el.querySelector<HTMLButtonElement>('[data-menu-id="c"]')!;

    expect(itemA.classList.contains('is-checked')).toBe(true);
    expect(itemA.getAttribute('aria-checked')).toBe('true');
    expect(itemA.querySelector('.fh-menu-check svg.ic-check')).not.toBeNull();

    expect(itemB.classList.contains('is-checked')).toBe(false);
    expect(itemB.getAttribute('aria-checked')).toBe('false');
    expect(itemB.querySelector('.fh-menu-check')).toBeNull();

    expect(itemC.hasAttribute('aria-checked')).toBe(false);
    expect(itemC.querySelector('.fh-menu-check')).toBeNull();

    menu.dispose();
  });
});
