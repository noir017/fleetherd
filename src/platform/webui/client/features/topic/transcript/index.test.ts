// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createTranscriptController } from './index.js';
import type { TranscriptIcons, TranscriptMessage, TranscriptTopicLike } from './types.js';

const ICONS: TranscriptIcons = {
  icon: {
    chevronLeft: '<L>',
    chevronRight: '<R>',
    diff: '<D>',
    folder: '<F>',
    home: '<H>',
    arrowUp: '<U>',
    check: '<C>',
    cross: '<X>',
    copy: '<CP>',
    undo: '<UN>',
    chat: '<CH>',
    more: '<MR>',
    search: '<S>',
    offline: '<O>',
    fork: '<FK>',
  },
  mark: {},
  reaction: {},
};

function makeHarness() {
  const log = document.createElement('div');
  const btwBox = document.createElement('div');
  btwBox.hidden = true;
  const btwQ = document.createElement('div');
  const btwBody = document.createElement('div');
  const btwClose = document.createElement('button');
  const machineNoteEl = document.createElement('div');
  machineNoteEl.hidden = true;
  const forkNote = document.createElement('button');
  forkNote.hidden = true;
  document.body.append(log, btwBox, machineNoteEl, forkNote);

  let data: Record<string, TranscriptMessage | undefined> = {};
  let els: Record<string, HTMLElement | undefined> = {};
  const historyMsgs: Record<string, TranscriptMessage | undefined> = {};
  const topics: TranscriptTopicLike[] = [
    { id: 't1', title: 'Topic 1' },
    { id: 't2', title: 'Topic 2' },
  ];
  let epoch = 2;
  let synced = true;
  let entering = false;

  const repaintHistoryMessage = vi.fn();
  const switchTopic = vi.fn();
  const openShot = vi.fn();
  const sendCommand = vi.fn();
  const openReader = vi.fn();
  const deliverLocal = vi.fn();
  const copyLocal = vi.fn();
  const discardLocal = vi.fn();
  const copied: string[] = [];
  const quoteToComposer = vi.fn();
  const openMessageMenu = vi.fn();
  const openTurnDiffSideBySide = vi.fn(async () => {});

  const controller = createTranscriptController({
    log,
    btwBox,
    btwQ,
    btwBody,
    btwClose,
    machineNoteEl,
    forkNote,
    getExtraCodeRoots: () => [],
    getData: () => data,
    getEls: () => els,
    getTopic: () => 't1',
    getTopics: () => topics,
    topicById: (id) => topics.find((t) => t.id === id),
    getEpoch: () => epoch,
    isSynced: () => synced,
    isStale: () => false,
    isEntering: () => entering,
    getLaunch: () => null,
    keyOf: (m) => (m._local ? m.id : `${m._g || epoch}:${m.id}`),
    isHistory: (m) => Boolean(m && !m._local && epoch !== 0 && m._g !== epoch),
    getIcons: () => ICONS,
    formatStatusClock: () => '12:00',
    codeView: () => Promise.resolve(null),
    copyText: (s, cb) => {
      copied.push(s);
      cb(true);
    },
    hasOutbox: () => true,
    claim: () => {},
    adoptLegacy: () => false,
    showUnsent: () => {},
    cacheSave: () => {},
    getHistoryMessage: (k) => historyMsgs[k],
    repaintHistoryMessage,
    paintTopics: () => {},
    paintStatus: () => {},
    switchTopic,
    isNarrow: () => false,
    setSidebar: () => {},
    openShot,
    sendCommand,
    openReader,
    deliverLocal,
    copyLocal,
    discardLocal,
    quoteToComposer,
    openMessageMenu,
    openTurnDiffSideBySide,
  });

  return {
    log,
    btwBox,
    controller,
    data,
    els,
    historyMsgs,
    setEpoch: (n: number) => {
      epoch = n;
    },
    setSynced: (v: boolean) => {
      synced = v;
    },
    setEntering: (v: boolean) => {
      entering = v;
    },
    resetMaps: () => {
      data = {};
      els = {};
    },
    spies: {
      repaintHistoryMessage,
      switchTopic,
      openShot,
      sendCommand,
      openReader,
      deliverLocal,
      copyLocal,
      discardLocal,
      copied,
      quoteToComposer,
      openMessageMenu,
      openTurnDiffSideBySide,
    },
  };
}

describe('createTranscriptController', () => {
  it('preserves DOM nodes on unchanged repaint (incremental sig check) and routes repaintKey', () => {
    const h = makeHarness();
    h.controller.upsert({ id: 'm1', html: '<p>hello</p>', at: 100 });
    const el = h.els['2:m1']!;
    const child = el.querySelector('p')!;

    // Re-painting identical markup leaves the exact same child node untouched.
    h.controller.paint('2:m1');
    expect(el.querySelector('p')).toBe(child);

    // Updating markup replaces only the changed message.
    h.data['2:m1'] = { id: 'm1', html: '<p>updated</p>', at: 100, _g: 2 };
    h.controller.repaintKey('2:m1');
    expect(el.querySelector('p')?.textContent).toBe('updated');

    // History keys route to historyPanel.repaintMessage instead of painting in #log.
    h.historyMsgs['h:1'] = { id: 'h1', html: '<p>hist</p>', at: 50 };
    h.controller.repaintKey('h:1');
    expect(h.spies.repaintHistoryMessage).toHaveBeenCalledWith('h:1');

    h.controller.dispose();
  });

  it('reconciles messages, keeps history/local messages, and sinks locals to the bottom', () => {
    const h = makeHarness();
    // Pre-existing history message + local pending message + stale current-epoch message.
    h.data['1:old'] = { id: 'old', html: '<p>hist</p>', at: 10, _g: 1 };
    h.controller.paint('1:old');
    h.data['p:n1'] = { id: 'p:n1', own: true, html: '<div class="raw">pending</div>', at: 20, _local: true, _state: 'sending', _nonce: 'n1' };
    h.controller.paint('p:n1');
    h.data['2:gone'] = { id: 'gone', html: '<p>gone</p>', at: 30, _g: 2 };
    h.controller.paint('2:gone');

    h.controller.reconcile([{ id: 'm1', html: '<p>live</p>', at: 40 }]);
    const keys = Array.from(h.log.children).map((c) => c.getAttribute('data-k'));
    expect(keys).toEqual(['1:old', '2:m1', 'p:n1']);
    expect(h.els['2:gone']).toBeUndefined();

    // Transfer local key on claim.
    const localNode = h.els['p:n1']!;
    h.controller.transferLocalKey('p:n1', '2:m2');
    expect(h.els['2:m2']).toBe(localNode);
    expect(localNode.getAttribute('data-k')).toBe('2:m2');
    expect(h.els['p:n1']).toBeUndefined();

    h.controller.dispose();
  });

  it('toggles tool bubble lines and delegates #log click/input/error events', () => {
    const h = makeHarness();
    h.controller.attachEvents(document);

    h.controller.upsert({
      id: 't1',
      kind: 'tools',
      html: '<div class="tl">cmd 1</div><div class="tl">cmd 2</div>',
      at: 100,
    });
    const line0 = h.log.querySelector<HTMLElement>('.tl[data-i="0"]')!;
    line0.click();
    expect(h.log.querySelector('.tl[data-i="0"]')?.classList.contains('open')).toBe(true);

    const allBtn = h.log.querySelector<HTMLElement>('[data-tl-all="2:t1"]')!;
    allBtn.click();
    expect(h.log.querySelectorAll('.tl.open').length).toBe(2);

    // Goto link switches topic; agent card sends /agent command.
    h.controller.upsert({
      id: 'm2',
      html: '<a href="#" data-goto="t2">go</a><button data-agent="codex">codex</button>',
      at: 200,
    });
    h.log.querySelector<HTMLElement>('a[data-goto="t2"]')!.click();
    expect(h.spies.switchTopic).toHaveBeenCalledWith('t2');
    h.log.querySelector<HTMLElement>('button[data-agent="codex"]')!.click();
    expect(h.spies.sendCommand).toHaveBeenCalledWith('/agent codex');

    // Broken shot image is hidden on capture-phase error event.
    h.controller.upsert({
      id: 'm3',
      html: '',
      file: { name: 'pic.png', url: '/pic.png', image: true },
      at: 300,
    });
    const img = h.log.querySelector<HTMLImageElement>('img.shot')!;
    img.dispatchEvent(new Event('error'));
    expect(img.style.display).toBe('none');

    h.controller.dispose();
  });

  it('handles message action bar copy, quote, /btw, more menu, and keyboard navigation', () => {
    const h = makeHarness();
    h.controller.attachEvents(document);
    h.controller.upsert({
      id: 'a1',
      html: '<p>Run <code>npm run lint</code> first.</p>',
      at: 100,
    });

    const toolbar = h.log.querySelector<HTMLElement>('[data-k="2:a1"] .msg-actions')!;
    expect(toolbar).not.toBeNull();
    expect(toolbar.getAttribute('role')).toBe('toolbar');

    const copyBtn = toolbar.querySelector<HTMLButtonElement>('[data-msg-act="copy"]')!;
    copyBtn.click();
    expect(h.spies.copied).toEqual(['Run `npm run lint` first.']);
    expect(copyBtn.classList.contains('is-done')).toBe(true);

    toolbar.querySelector<HTMLButtonElement>('[data-msg-act="quote"]')!.click();
    expect(h.spies.quoteToComposer).toHaveBeenCalledWith('> Run `npm run lint` first.\n\n');

    toolbar.querySelector<HTMLButtonElement>('[data-msg-act="btw"]')!.click();
    expect(h.spies.quoteToComposer).toHaveBeenCalledWith('/btw ');

    const moreBtn = toolbar.querySelector<HTMLButtonElement>('[data-msg-act="more"]')!;
    moreBtn.click();
    expect(h.spies.openMessageMenu).toHaveBeenCalledWith('2:a1', moreBtn);

    copyBtn.focus();
    copyBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(toolbar.querySelector('[data-msg-act="quote"]'));

    h.controller.dispose();
  });

  it('renders turn-changes side-by-side diff button and toggles busy state on click', async () => {
    const h = makeHarness();
    let resolveDiff!: () => void;
    h.spies.openTurnDiffSideBySide.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveDiff = r;
        }),
    );
    h.controller.attachEvents(document);
    h.controller.upsert({
      id: 'tc1',
      html: '<p>Edited files</p>',
      turnChanges: { turn: 4, files: 2, additions: 9, deletions: 3 },
      at: 200,
    });

    const splitBtn = h.log.querySelector<HTMLButtonElement>('button[data-turns-split="4"]')!;
    expect(splitBtn).not.toBeNull();
    splitBtn.click();
    expect(h.spies.openTurnDiffSideBySide).toHaveBeenCalledWith(4);
    expect(splitBtn.disabled).toBe(true);
    expect(splitBtn.classList.contains('busy')).toBe(true);

    resolveDiff();
    await Promise.resolve();
    expect(splitBtn.disabled).toBe(false);
    expect(splitBtn.classList.contains('busy')).toBe(false);

    h.controller.dispose();
  });

  it('preserves incremental rendering on long conversations (220+ messages) when updating only the tail', () => {
    const h = makeHarness();
    const total = 220;
    const initial: TranscriptMessage[] = Array.from({ length: total }, (_, i) => ({
      id: `m${i}`,
      own: i % 2 === 0,
      html: `<p>message ${i}</p>`,
      at: 1000 + i,
    }));
    h.controller.reconcile(initial);
    expect(h.log.children.length).toBe(total);

    const elRefs = initial.map((_, i) => h.els[`2:m${i}`]!);
    const pRefs = elRefs.map((el) => el.querySelector('p')!);

    const appendSpy = vi.spyOn(h.log, 'appendChild');
    const enhanceSpy = vi.spyOn(h.controller.codeBlocks, 'enhance');

    // Stream-update only the last message via upsert & repaintKey.
    h.controller.upsert({
      id: `m${total - 1}`,
      own: false,
      html: `<p>message ${total - 1} streaming…</p>`,
      at: 1000 + total - 1,
    });
    expect(enhanceSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(h.els[`2:m${total - 1}`]?.querySelector('p')?.textContent).toBe(`message ${total - 1} streaming…`);

    // Reconcile the entire 220-message list with only the final message updated.
    const nextList = initial.map((m, i) =>
      i === total - 1 ? { ...m, html: `<p>message ${total - 1} final</p>` } : m,
    );
    h.controller.reconcile(nextList);

    // Every earlier message (0..218) kept its exact DOM wrapper and inner <p> node without re-appending.
    for (let i = 0; i < total - 1; i++) {
      expect(h.els[`2:m${i}`]).toBe(elRefs[i]);
      expect(h.els[`2:m${i}`]?.querySelector('p')).toBe(pRefs[i]);
    }
    expect(enhanceSpy).toHaveBeenCalledTimes(2);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(h.els[`2:m${total - 1}`]?.querySelector('p')?.textContent).toBe(`message ${total - 1} final`);

    h.controller.dispose();
  });

  it('posts api/click for permission button cards and removes buttons once resolved', async () => {
    const h = makeHarness();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      h.controller.attachEvents(document);
      h.controller.upsert({
        id: 'perm1',
        html: '<p>Allow running <code>rm -rf tmp</code>?</p>',
        buttons: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Deny' },
        ],
        at: 100,
      });

      const allowBtn = h.log.querySelector<HTMLButtonElement>('button[data-msg="perm1"][data-btn="allow"]')!;
      expect(allowBtn).not.toBeNull();
      allowBtn.click();
      await Promise.resolve();

      expect(allowBtn.disabled).toBe(true);
      expect(allowBtn.classList.contains('busy')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('api/click');
      expect(JSON.parse(String(init.body))).toEqual({
        topic: 't1',
        messageId: 'perm1',
        buttonId: 'allow',
      });

      // Server edits the message to retire buttons after decision is recorded.
      h.controller.upsert({
        id: 'perm1',
        html: '<p>Allowed.</p>',
        buttons: [],
        at: 100,
      });
      expect(h.log.querySelectorAll('button[data-msg="perm1"]')).toHaveLength(0);
      expect(h.els['2:perm1']?.textContent).toContain('Allowed.');
    } finally {
      globalThis.fetch = origFetch;
      h.controller.dispose();
    }
  });

  it('batches bulk reconcile DOM appends and defers off-screen code highlighting to sweep', async () => {
    const h = makeHarness();
    const codeHtml = (n: number) =>
      `<div class="cb"><div class="cb-h"><span>ts</span></div><pre><code class="language-ts">const v${n} = ${n};</code></pre></div>`;
    const list: TranscriptMessage[] = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      own: false,
      html: codeHtml(i),
      at: 1000 + i,
    }));
    const appendSpy = vi.spyOn(h.log, 'appendChild');
    const enhanceSpy = vi.spyOn(h.controller.codeBlocks, 'enhance');
    h.controller.reconcile(list);

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(h.log.children.length).toBe(20);
    expect(enhanceSpy).toHaveBeenCalledWith(h.els['2:m0'], { defer: true, skipHighlight: true, liveEl: null });
    expect(enhanceSpy).toHaveBeenCalledWith(h.els['2:m19'], { defer: true, skipHighlight: false, liveEl: null });

    h.controller.dispose();
  });

  it('lazily highlights #log code blocks via IntersectionObserver only when intersecting', async () => {
    const origIO = globalThis.IntersectionObserver;
    const observed = new Set<Element>();
    let ioCallback: IntersectionObserverCallback | null = null;
    class FakeIntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = '600px 0px';
      readonly thresholds = [0];
      constructor(cb: IntersectionObserverCallback) {
        ioCallback = cb;
      }
      observe(el: Element) {
        observed.add(el);
      }
      unobserve(el: Element) {
        observed.delete(el);
      }
      disconnect() {
        observed.clear();
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    const hlSpy = vi.fn((src: string) => [[0, src.length, 'tok-kw'] as const]);
    try {
      const { createCodeBlocksController } = await import('./code-blocks.js');
      const log = document.createElement('div');
      document.body.append(log);
      log.innerHTML =
        '<div data-k="2:m0"><div class="cb"><pre><code class="language-ts">const a = 1;</code></pre></div></div>' +
        '<div data-k="2:m1"><div class="cb"><pre><code class="language-ts">const b = 2;</code></pre></div></div>';
      const ctrl = createCodeBlocksController({
        log,
        getExtraRoots: () => [],
        getTopic: () => 't1',
        getTopics: () => [{ id: 't1', title: 'T1' }],
        codeView: () => Promise.resolve({ highlighter: () => Promise.resolve(hlSpy) }),
        getIcons: () => ICONS,
        copyText: (_s, cb) => cb(true),
      });
      const codes = Array.from(log.querySelectorAll('code'));
      ctrl.sweep();
      expect(observed.size).toBe(2);
      expect(hlSpy).not.toHaveBeenCalled();

      // Simulate only the second code block entering the viewport.
      ioCallback!(
        [{ target: codes[1]!, isIntersecting: true } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(codes[1]!.hasAttribute('data-hl')).toBe(true);
      expect(codes[0]!.hasAttribute('data-hl')).toBe(false);
      expect(observed.has(codes[1]!)).toBe(false);
      expect(observed.has(codes[0]!)).toBe(true);

      ctrl.dispose();
      log.remove();
    } finally {
      globalThis.IntersectionObserver = origIO;
    }
  });
});
