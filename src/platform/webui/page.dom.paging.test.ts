import { describe, expect, it, vi } from 'vitest';

import { message, open, saved, sync, until } from './page.dom.test-helpers.js';

function makeMessages(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const n = from + i;
    return { ...message(`m${n}`, `<p>msg-${n}</p>`), at: n * 1000 };
  });
}

describe('webui page: windowed sync and upward history paging', () => {
  it('renders only the initial window, loads older pages on scroll-up without jumping, and stops at the top', async () => {
    const T = 'a1b2c3d4';
    const tail = makeMessages(41, 100);
    const page1 = makeMessages(1, 40);

    const h = await open({
      url: `http://localhost:8787/?t=${T}`,
      replies: {
        [`api/messages?t=${T}&before=41&limit=50`]: {
          topic: T,
          epoch: 1,
          messages: page1,
          hasMore: false,
          oldestSeq: 1,
          totalCount: 100,
        },
      },
    });

    // Simulate a laid-out scrollable container where each message adds 50px height.
    const log = h.el('log');
    Object.defineProperty(log, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(log, 'scrollHeight', {
      get: () => h.doc.querySelectorAll('#log > .m').length * 50,
      configurable: true,
    });

    await h.emit({
      ...sync(T, tail, [T]),
      totalCount: 100,
      hasMore: true,
      oldestSeq: 41,
    });

    expect(h.painted()).toBe(60);
    expect(h.doc.querySelector('.older-bar')).not.toBeNull();
    // Unread count tracks totalCount (100), not window length (60).
    const reads = JSON.parse(h.window.localStorage.getItem('aa_reads') || '{}') as Record<string, number>;
    expect(reads[T]).toBe(100);

    log.scrollTop = 100;
    log.dispatchEvent(new h.window.Event('scroll'));

    await until('older page prepended', () => h.painted() === 100);
    // 40 prepended messages * 50px = +2000px height -> scrollTop shifts from 100 to 2100.
    expect(log.scrollTop).toBe(2100);
    expect(h.doc.querySelector('.older-bar')).toBeNull();
    const firstMsg = h.doc.querySelector('#log > .m');
    expect(firstMsg?.textContent).toContain('msg-1');

    // Scrolling to top again must not trigger another fetch once hasMore is false.
    const callsBefore = h.calls.filter((c) => c.path.startsWith('api/messages')).length;
    log.scrollTop = 0;
    log.dispatchEvent(new h.window.Event('scroll'));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.calls.filter((c) => c.path.startsWith('api/messages')).length).toBe(callsBefore);
  });

  it('preserves out-of-window older messages during partial windowed reconcile', async () => {
    const T = 'a1b2c3d4';
    const tail = makeMessages(41, 100);
    const older = makeMessages(1, 40);

    const h = await open({
      url: `http://localhost:8787/?t=${T}`,
      replies: {
        [`api/messages?t=${T}&before=41&limit=50`]: {
          topic: T,
          epoch: 1,
          messages: older,
          hasMore: false,
          oldestSeq: 1,
          totalCount: 100,
        },
      },
    });

    await h.emit({ ...sync(T, tail, [T]), totalCount: 100, hasMore: true, oldestSeq: 41 });
    await h.click('.older-bar button[data-load-older]');
    await until('older loaded', () => h.painted() === 100);

    // Reconnect windowed sync arrives with only m42..m101 (hasMore: true).
    const nextTail = makeMessages(42, 101);
    await h.emit({ ...sync(T, nextTail, [T]), totalCount: 101, hasMore: true, oldestSeq: 42 });

    // Older messages m1..m41 above the window must remain in DOM.
    expect(h.painted()).toBe(101);
    expect(h.doc.querySelector('#log > .m[data-k="1:m1"]')).not.toBeNull();
    expect(h.doc.querySelector('#log > .m[data-k="1:m101"]')).not.toBeNull();
  });

  it('loads unloaded older pages before scrolling when jumping to an earlier quoted message', async () => {
    const T = 'a1b2c3d4';
    const tail = [
      ...makeMessages(61, 99),
      { ...message('m100', '<p>replying to old</p>'), at: 100_000, quote: { html: '<p>msg-5</p>', id: 'm5' } },
    ];
    const page1 = makeMessages(1, 60);

    const h = await open({
      url: `http://localhost:8787/?t=${T}`,
      replies: {
        [`api/messages?t=${T}&before=61&limit=100`]: {
          topic: T,
          epoch: 1,
          messages: page1,
          hasMore: false,
          oldestSeq: 1,
          totalCount: 100,
        },
      },
    });

    await h.emit({ ...sync(T, tail, [T]), totalCount: 100, hasMore: true, oldestSeq: 61 });
    expect(h.doc.querySelector('#log > .m[data-k="1:m5"]')).toBeNull();

    const scrollSpy = vi.fn();
    h.window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    await h.click('.q[data-jump-msg="m5"]');
    await until('target message loaded and flashed', () => {
      const target = h.doc.querySelector('#log > .m[data-k="1:m5"]');
      return Boolean(target && target.classList.contains('jump-flash'));
    });

    expect(scrollSpy).toHaveBeenCalled();
    expect(h.painted()).toBe(100);
  });

  it('preserves Plan A cache resume and hasMore/oldestSeq cursor across reload', async () => {
    const T = 'a1b2c3d4';
    const tail = makeMessages(41, 100);
    const first = await open({ url: `http://localhost:8787/?t=${T}` });
    first.live().onmessage?.({
      data: JSON.stringify({ ...sync(T, tail, [T], { epoch: 77 }), totalCount: 100, hasMore: true, oldestSeq: 41 }),
      lastEventId: `${T}.25.100`,
    });
    await saved();

    const again = await open({
      url: `http://localhost:8787/?t=${T}`,
      idb: first.idb,
      replies: {
        [`api/messages?t=${T}&before=41&limit=50`]: {
          topic: T,
          epoch: 77,
          messages: makeMessages(1, 40),
          hasMore: false,
          oldestSeq: 1,
          totalCount: 100,
        },
      },
    });

    const streamUrl = new URL(again.live().url, 'http://localhost:8787');
    expect(streamUrl.searchParams.get('last')).toBe(`${T}.25.100`);
    await again.emit({ t: 'resumed', epoch: 77 });
    expect(again.painted()).toBe(60);
    expect(again.doc.querySelector('.older-bar')).not.toBeNull();

    await again.click('.older-bar button[data-load-older]');
    await until('older loaded after cache resume', () => again.painted() === 100);
    expect(again.doc.querySelector('.older-bar')).toBeNull();
  });
});
