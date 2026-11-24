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
    copyText: (_s, cb) => cb(true),
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
});
