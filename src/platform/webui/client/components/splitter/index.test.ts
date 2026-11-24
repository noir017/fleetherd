// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSplitter } from './index.js';

describe('components/splitter', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('tracks pointer drag deltas, supports keyboard micro-adjustments, and resets on dblclick', () => {
    const onDragStart = vi.fn();
    const onDrag = vi.fn();
    const onDragEnd = vi.fn();
    const onStep = vi.fn();
    const onReset = vi.fn();

    const splitter = createSplitter({
      orientation: 'horizontal',
      ariaLabel: 'Resize sidebar',
      step: 12,
      largeStep: 48,
      valueNow: 260,
      valueMin: 180,
      valueMax: 480,
      onDragStart,
      onDrag,
      onDragEnd,
      onStep,
      onReset,
    });
    document.body.appendChild(splitter.el);

    expect(splitter.el.getAttribute('role')).toBe('separator');
    expect(splitter.el.getAttribute('aria-orientation')).toBe('vertical');
    expect(splitter.el.getAttribute('aria-valuenow')).toBe('260');

    // Pointer drag sequence (jsdom lacks PointerEvent constructor; MouseEvent carries clientX)
    const down = new MouseEvent('pointerdown', { clientX: 260, button: 0, bubbles: true });
    Object.defineProperty(down, 'pointerId', { value: 1 });
    splitter.el.dispatchEvent(down);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(splitter.el.classList.contains('is-dragging')).toBe(true);

    const move = new MouseEvent('pointermove', { clientX: 295, bubbles: true });
    Object.defineProperty(move, 'pointerId', { value: 1 });
    document.dispatchEvent(move);
    expect(onDrag).toHaveBeenCalledWith(35, 35);

    const up = new MouseEvent('pointerup', { clientX: 295, bubbles: true });
    Object.defineProperty(up, 'pointerId', { value: 1 });
    document.dispatchEvent(up);
    expect(onDragEnd).toHaveBeenCalledWith(35);
    expect(splitter.el.classList.contains('is-dragging')).toBe(false);

    // Keyboard micro-adjustment (normal + shift)
    splitter.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onStep).toHaveBeenCalledWith(12);
    splitter.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
    expect(onStep).toHaveBeenCalledWith(-48);

    // Double-click reset
    splitter.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onReset).toHaveBeenCalledTimes(1);

    splitter.dispose();
  });
});
