// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createAttachmentsController, formatPastedName } from './attachments.js';

describe('composer/attachments', () => {
  it('formats sequential pasted filenames from MIME types', () => {
    expect(formatPastedName('image/png', 1)).toBe('pasted-1.png');
    expect(formatPastedName('image/svg+xml;charset=utf-8', 2)).toBe('pasted-2.svg');
    expect(formatPastedName('', 3)).toBe('pasted-3.png');
  });

  it('renders chips with thumbnails, reuses DOM nodes, removes chips, and opens lightbox on click', () => {
    const chips = document.createElement('div');
    const picker = document.createElement('input');
    picker.type = 'file';
    const attachBtn = document.createElement('button');
    const note = document.createElement('div');
    document.body.append(chips, picker, attachBtn, note);

    const openShot = vi.fn();
    const ctrl = createAttachmentsController({
      chips,
      picker,
      attachBtn,
      note,
      doc: document,
      getTopic: () => 't1',
      isHistoryOpen: () => false,
      openShot,
      appendDraftFile: vi.fn(),
      onQueuedSendReady: vi.fn(),
    });
    const sub = ctrl.attach();

    const imgFile = { name: 'shot.png', mime: 'image/png', data: 'iVBORw0KGgo=' };
    const txtFile = { name: 'notes.txt', mime: 'text/plain', data: 'aGk=' };
    ctrl.setFiles([imgFile, txtFile]);
    ctrl.renderChips();

    const firstChip = chips.children[0];
    expect(chips.children).toHaveLength(2);
    expect(firstChip?.querySelector('img.thumb')).not.toBeNull();

    // Re-rendering reuses the exact same DOM node for the same attachment object.
    ctrl.renderChips();
    expect(chips.children[0]).toBe(firstChip);

    chips.querySelector<HTMLImageElement>('img.thumb')?.click();
    expect(openShot).toHaveBeenCalledTimes(1);

    chips.querySelector<HTMLButtonElement>('button[data-drop="0"]')?.click();
    expect(ctrl.getFiles()).toEqual([txtFile]);
    expect(chips.children).toHaveLength(1);

    sub.dispose();
  });
});
