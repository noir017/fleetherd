import { describe, expect, it, vi } from 'vitest';

import { message, open, saved, sync, until, within } from './page.dom.test-helpers.js';

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

  it('paints the status bar permission chip and pending queue on direct cached resume without live AgentStatus', async () => {
    const T = 'a1b2c3d4';
    const first = await open({ url: `http://localhost:8787/?t=${T}` });
    first.live().onmessage?.({
      data: JSON.stringify(sync(T, [message('m1', '<p>hello</p>')], [T], { epoch: 77 })),
      lastEventId: `${T}.25.5`,
    });
    await saved();

    const again = await open({
      url: `http://localhost:8787/?t=${T}`,
      idb: first.idb,
      replies: {
        [`api/options?peek=1&t=${T}`]: {
          agent: 'alpha',
          model: 'm1',
          permissions: { level: 'auto', unset: false, configurable: true },
        },
      },
    });

    const streamUrl = new URL(again.live().url, 'http://localhost:8787');
    expect(streamUrl.searchParams.get('last')).toBe(`${T}.25.5`);

    // Mirror deliverResume() order when room.status is undefined: status/pending/globals arrive before resumed.
    await again.emit({ t: 'status' });
    await again.emit({
      t: 'pending',
      items: [{ id: 'p1', content: 'queued msg', at: 2000, canSendNow: true, reason: 'turn' }],
    });
    await again.emit({ t: 'machines', offline: [] });
    await again.emit({ t: 'commands', commands: [{ name: 'help', description: 'Help' }] });
    await again.emit({
      t: 'topics',
      topics: [
        {
          id: T,
          title: 'Active',
          lastAt: 1000,
          msgCount: 1,
          dir: { name: 'app', path: '/home/me/projects/app' },
        },
      ],
      tv: 2,
    });
    await again.emit({ t: 'resumed', epoch: 77 });

    expect(again.el('status').hidden).toBe(false);
    await within('permission chip rendered after resume', 1500, () =>
      Boolean(again.doc.querySelector('#status .st-perm')),
    );
    expect(again.el('status').hidden).toBe(false);
    expect(again.doc.querySelector('#status .st-perm')?.textContent).toContain('auto');
    expect(again.doc.querySelector('#status .st-model')?.textContent).toContain('m1');
    expect(again.el('pending-queue').hidden).toBe(false);
    expect(again.el('pending-queue').textContent).toContain('queued msg');
  });

  it('resets disconnected old messages and restores paging cursor when a windowed sync jumps past prior messages', async () => {
    const T = 'a1b2c3d4';
    const initial = makeMessages(1, 2);
    const tail = makeMessages(45, 104);
    const older = makeMessages(1, 44);

    const h = await open({
      url: `http://localhost:8787/?t=${T}`,
      replies: {
        [`api/messages?t=${T}&before=45&limit=50`]: {
          topic: T,
          epoch: 1,
          messages: older,
          hasMore: false,
          oldestSeq: 1,
          totalCount: 104,
        },
      },
    });

    // Topic starts small (1..2): roomState sends oldestSeq: 1, hasMore omitted.
    await h.emit({ ...sync(T, initial, [T]), totalCount: 2, oldestSeq: 1 });
    expect(h.painted()).toBe(2);
    expect(h.doc.querySelector('.older-bar')).toBeNull();

    // After sleeping/switching away during a long turn, backlog overflowed -> windowed sync (45..104).
    await h.emit({ ...sync(T, tail, [T]), totalCount: 104, hasMore: true, oldestSeq: 45 });

    // Disconnected m1..m2 are pruned rather than leaving a permanent 3..44 hole, and paging is enabled.
    expect(h.painted()).toBe(60);
    expect(h.doc.querySelector('#log > .m[data-k="1:m1"]')).toBeNull();
    expect(h.doc.querySelector('.older-bar')).not.toBeNull();

    await h.click('.older-bar button[data-load-older]');
    await until('older execution record loaded in order', () => h.painted() === 104);
    const keys = Array.from(h.doc.querySelectorAll('#log > .m')).map((el) => el.getAttribute('data-k'));
    expect(keys[0]).toBe('1:m1');
    expect(keys[1]).toBe('1:m2');
    expect(keys[44]).toBe('1:m45');
    expect(keys[103]).toBe('1:m104');
  });

  it('self-heals a cached transcript missing hasMore/oldestSeq when resumed reports more visible messages', async () => {
    const T = 'a1b2c3d4';
    const tail = makeMessages(41, 100);
    const older = makeMessages(1, 40);

    // Seed IndexedDB as pre-fix sw.ts wrote it: windowed tail with last+epoch, but no hasMore/oldestSeq.
    const first = await open({ url: `http://localhost:8787/?t=${T}` });
    first.live().onmessage?.({
      data: JSON.stringify({ ...sync(T, tail, [T], { epoch: 77 }), totalCount: 60 }),
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
          messages: older,
          hasMore: false,
          oldestSeq: 1,
          totalCount: 100,
        },
      },
    });

    expect(again.painted()).toBe(60);
    expect(again.doc.querySelector('.older-bar')).toBeNull();

    // Server resumes and reports 100 visible messages while client only has 60 and no paging cursor.
    await again.emit({ t: 'resumed', epoch: 77, visibleCount: 100 });

    // Client clears lastEventId and reconnects without ?last= to get an authoritative windowed sync.
    const healedUrl = new URL(again.live().url, 'http://localhost:8787');
    expect(healedUrl.searchParams.get('last')).toBeNull();

    await again.emit({ ...sync(T, tail, [T], { epoch: 77 }), totalCount: 100, hasMore: true, oldestSeq: 41 });
    expect(again.doc.querySelector('.older-bar')).not.toBeNull();

    await again.click('.older-bar button[data-load-older]');
    await until('older messages loaded after self-heal', () => again.painted() === 100);
  });

  it('auto-backfills older pages when the initial window does not fill a tall portrait viewport', async () => {
    const T = 'a1b2c3d4';
    const tail = makeMessages(91, 100);
    const page1 = makeMessages(41, 90);

    const h = await open({
      url: `http://localhost:8787/?t=${T}`,
      replies: {
        [`api/messages?t=${T}&before=91&limit=50`]: {
          topic: T,
          epoch: 1,
          messages: page1,
          hasMore: true,
          oldestSeq: 41,
          totalCount: 100,
        },
      },
    });

    // Portrait viewport: 750px tall, while 10 compact/collapsed messages render only 250px total (25px each).
    const log = h.el('log');
    Object.defineProperty(log, 'clientHeight', { value: 750, configurable: true });
    Object.defineProperty(log, 'scrollHeight', {
      get: () => h.doc.querySelectorAll('#log > .m').length * 25,
      configurable: true,
    });

    await h.emit({
      ...sync(T, tail, [T]),
      totalCount: 100,
      hasMore: true,
      oldestSeq: 91,
    });

    // Should auto-load page1 (60 * 25 = 1500px > 750 + 240) without needing a manual scroll event.
    await until('short portrait viewport auto-backfilled', () => h.painted() === 60);
    expect(h.doc.querySelector('.older-bar')).not.toBeNull();
    expect(h.calls.filter((c) => c.path.startsWith('api/messages'))).toHaveLength(1);
  });
});
