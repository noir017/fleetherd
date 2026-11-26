// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  btwAsked,
  btwOf,
  createBtwController,
  formatBtwPartHtml,
  ownText,
  seqOf,
} from './btw.js';
import type { TranscriptIcons, TranscriptMessage } from './types.js';

const ICONS: TranscriptIcons = {
  icon: { chevronRight: '<svg/>' },
  mark: {},
  reaction: {},
};

describe('btw pure helpers', () => {
  it('extracts ownText from local and server-rendered raw messages', () => {
    expect(ownText({ id: 'p:1', html: '', at: 1, _local: true, _text: '/btw hi' })).toBe('/btw hi');
    expect(
      ownText({ id: 'm1', own: true, html: '<div class="raw">/btw a &lt; b &amp; &quot;c&quot;</div>', at: 1 }),
    ).toBe('/btw a < b & "c"');
    expect(ownText({ id: 'm2', own: true, html: '<p>rendered</p>', at: 1 })).toBeNull();
  });

  it('parses btwAsked and skips history keys and non-own messages', () => {
    const q: TranscriptMessage = { id: 'm1', own: true, html: '<div class="raw"> /btw   what is this? </div>', at: 1 };
    expect(btwAsked('1:m1', q)).toBe('what is this?');
    expect(btwAsked('h:m1', q)).toBeNull();
    expect(btwAsked('1:m1', { ...q, own: false })).toBeNull();
    expect(btwAsked('1:m2', { id: 'm2', own: true, html: '<div class="raw">/btw</div>', at: 1 })).toBe('');
    expect(btwAsked('1:m3', { id: 'm3', own: true, html: '<div class="raw">hello</div>', at: 1 })).toBeNull();
  });

  it('resolves btwOf, seqOf, and formats btw answer HTML', () => {
    expect(btwOf({ id: 'm2', kind: 'aside', html: '', at: 2, quote: { html: '', id: 'm1' } }, 5)).toBe('5:m1');
    expect(btwOf({ id: 'm2', kind: 'aside', html: '', at: 2, _g: 3, quote: { html: '', id: 'm1' } }, 5)).toBe('3:m1');
    expect(btwOf({ id: 'm2', html: '', at: 2 }, 5)).toBeNull();
    expect(seqOf('m42')).toBe(42);
    expect(seqOf('abc')).toBe(0);

    const formatted = formatBtwPartHtml(
      '<p>↪ btw: test</p>\n<p>Answer body</p><p>side question — kept out</p>',
    );
    expect(formatted).toBe('<p>Answer body</p><p class="btw-foot">side question — kept out</p>');
  });
});

describe('createBtwController', () => {
  it('opens on answer arrival, respects manual close, and transfers keys on claim', () => {
    const btwBox = document.createElement('div');
    btwBox.hidden = true;
    const btwQ = document.createElement('div');
    const btwBody = document.createElement('div');
    const data: Record<string, TranscriptMessage | undefined> = {
      '1:m1': { id: 'm1', own: true, html: '<div class="raw">/btw why?</div>', at: 100 },
      '1:m2': {
        id: 'm2',
        kind: 'aside',
        html: '<p>↪ btw: why?</p><p>Because.</p>',
        at: 200,
        quote: { html: '', id: 'm1' },
      },
    };
    const els: Record<string, HTMLElement | undefined> = {};
    const paint = vi.fn();
    const enhanceCodeBlocks = vi.fn();

    const btw = createBtwController({
      btwBox,
      btwQ,
      btwBody,
      getData: () => data,
      getEls: () => els,
      getEpoch: () => 1,
      isHistory: () => false,
      isStuck: () => false,
      renderFailedActions: () => '',
      formatClock: () => '12:00',
      getIcons: () => ICONS,
      paint,
      enhanceCodeBlocks,
    });

    expect(btw.isHeld('1:m2', data['1:m2']!)).toBe(true);
    expect(btw.parts('1:m1')).toEqual(['1:m2']);

    btw.onArrived(data['1:m2']!);
    expect(btw.isOpen()).toBe(true);
    expect(btw.getKey()).toBe('1:m1');
    expect(btwQ.textContent).toBe('why?');
    expect(btwBody.innerHTML).toContain('Because.');
    expect(enhanceCodeBlocks).toHaveBeenCalledWith(btwBody);

    // Closing by hand suppresses auto-reopen on further parts of the same question.
    btw.close(true);
    expect(btw.isOpen()).toBe(false);
    btw.onArrived(data['1:m2']!);
    expect(btw.isOpen()).toBe(false);

    // Transferring local key preserves shut state.
    btw.transferKey('1:m1', '2:m9');
    data['2:m9'] = data['1:m1'];
    btw.open('2:m9');
    expect(btw.getKey()).toBe('2:m9');
    btw.dispose();
  });
});
