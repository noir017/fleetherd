import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { setLocale } from '../../i18n/index.js';
import { makeFilterBar } from './filter-bar.js';
import { createIdleDialogController } from './idle-dialog.js';
import { createTopicsFeature } from './index.js';
import { createTopicPrefetcher, PRE_DEBOUNCE_MS } from './prefetch.js';
import { createRowMenuController } from './row-menu.js';
import type { Topic, TopicIcons } from './types.js';

const ICONS: TopicIcons = {
  more: '<svg>more</svg>',
  star: '<svg>star</svg>',
  chevronRight: '<svg>cr</svg>',
  chevronDown: '<svg>cd</svg>',
  fork: '<svg>fork</svg>',
  offline: '<svg>off</svg>',
  search: '<svg>s</svg>',
  cross: '<svg>x</svg>',
  filter: '<svg>f</svg>',
  sort: '<svg>so</svg>',
  arrowUp: '<svg>u</svg>',
  arrowDown: '<svg>d</svg>',
  copy: '<svg>c</svg>',
  power: '<svg>p</svg>',
  trash: '<svg>t</svg>',
  pause: '<svg>pa</svg>',
  play: '<svg>pl</svg>',
  clock: '<svg>cl</svg>',
  pencil: '<svg>pe</svg>',
};

function makeTopic(overrides: Partial<Topic> & { id: string }): Topic {
  return {
    title: 'Topic',
    lastAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeMemoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe('topics controllers', () => {
  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('makeFilterBar persists search/chips, prunes removed options, handles Escape, and supports Record sort i18n', () => {
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
    const storage = makeMemoryStorage();
    const onChange = vi.fn();

    const bar = makeFilterBar(
      {
        key: 'test_fb',
        placeholder: 'Search',
        groups: [],
        sort: {
          options: [
            { value: 'status', label: 'Status' },
            { value: 'next', label: 'Next' },
          ],
          value: 'status',
          dir: 'asc',
        },
        onChange,
      },
      { icons: ICONS, doc: dom.window.document, storage },
    );
    dom.window.document.getElementById('host')!.appendChild(bar.el);
    bar.setGroups([
      { id: 'state', label: 'State', pinned: true, options: [{ value: 'running', label: 'Running', count: 2 }] },
      { id: 'agent', label: 'Agent', options: [{ value: 'cc', label: 'cc', count: 1 }] },
    ]);

    const chip = bar.el.querySelector<HTMLButtonElement>('[data-fb-value="cc"]')!;
    chip.click();
    expect(bar.active()).toBe(true);
    expect(bar.state().sel.agent).toEqual(['cc']);
    expect(bar.el.querySelector<HTMLElement>('.fb-dot')!.hidden).toBe(false);

    // Pruning drops selections no longer offered
    bar.setGroups([
      { id: 'state', label: 'State', pinned: true, options: [{ value: 'running', label: 'Running', count: 2 }] },
    ]);
    expect(bar.state().sel.agent).toBeUndefined();

    // Record-style refreshI18n (used by schedules panel) updates option labels
    bar.refreshI18n('Find tasks', { status: 'State Label', next: 'Next Label' });
    const opts = Array.from(bar.el.querySelectorAll<HTMLOptionElement>('.fb-sortsel option'));
    expect(opts.map((o) => o.textContent)).toEqual(['State Label', 'Next Label']);

    bar.destroy();
  });

  it('createRowMenuController opens topic menu, navigates with arrow keys, and follows repainted button', () => {
    const dom = new JSDOM(
      '<!doctype html><body><div id="list"><button type="button" data-rm="topic:t1">…</button></div><div id="row-menu" hidden></div></body>',
    );
    const doc = dom.window.document;
    const onStar = vi.fn();
    const onDelete = vi.fn();
    const t1 = makeTopic({ id: 't1', live: true, agent: { id: 'cc', harness: 'claude', canFork: true } });

    const menu = createRowMenuController({
      rowMenu: doc.getElementById('row-menu')!,
      doc,
      win: dom.window as unknown as Window,
      instanceId: 'web',
      getIcons: () => ICONS,
      getTopics: () => [t1],
      topicById: (id) => (id === 't1' ? t1 : null),
      closeOtherMenus: () => {},
      onStarTopic: onStar,
      onCopyTopicRef: () => {},
      onForkTopic: () => {},
      onEndTopic: () => {},
      onDeleteTopic: onDelete,
      getScheduleTask: () => null,
      onOpenTaskPage: () => {},
      onScheduleOp: () => {},
      confirmFn: () => true,
    });
    menu.attach();

    const btn = doc.querySelector<HTMLButtonElement>('[data-rm="topic:t1"]')!;
    menu.openFor(btn);
    expect(menu.isOpen()).toBe(true);
    expect(menu.getKey()).toBe('topic:t1');

    // Keyboard End jumps to Delete
    const menuEl = doc.getElementById('row-menu')!;
    menuEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect((doc.activeElement as HTMLElement)?.getAttribute('data-rmk')).toBe('delete');

    // Repainting list keeps menu open when row still exists, closes when gone
    doc.getElementById('list')!.innerHTML = '<button type="button" data-rm="topic:t1">…</button>';
    menu.follow();
    expect(menu.isOpen()).toBe(true);

    doc.querySelector<HTMLButtonElement>('[data-rmk="star"]')!.click();
    expect(onStar).toHaveBeenCalledWith('t1');
    expect(menu.isOpen()).toBe(false);

    menu.dispose();
  });

  it('createTopicPrefetcher fetches needs-you topics with concurrency cap 3 and skips current versions', async () => {
    vi.useFakeTimers();
    const dom = new JSDOM('<!doctype html><body></body>');
    const inFlight: Array<() => void> = [];
    const fetchedIds: string[] = [];
    const putCache = vi.fn(async () => true);

    const topics: Topic[] = ['a', 'b', 'c', 'd'].map((id, i) =>
      makeTopic({ id, stage: 'review', last: `${id}.1.5`, lastAt: 5000 - i * 100 }),
    );
    const prefetcher = createTopicPrefetcher({
      doc: dom.window.document,
      isDbAvailable: () => true,
      isStreamParked: () => false,
      isStreamOpen: () => true,
      getEpoch: () => 1,
      getActiveTopic: () => 'cur',
      getTopics: () => topics,
      topicById: (id) => topics.find((t) => t.id === id) ?? null,
      getVersion: () => ({ last: '', epoch: 1 }),
      isNewer: (a, b) => a !== b,
      peekCache: async () => {},
      putCache,
      snapshotMsgs: () => [],
      fetchFn: ((url: string) => {
        const id = new URL(url, 'http://localhost').searchParams.get('t')!;
        fetchedIds.push(id);
        return new Promise<Response>((resolve) => {
          inFlight.push(() =>
            resolve({
              ok: true,
              json: async () => ({ topic: id, epoch: 1, last: `${id}.1.5`, stale: false, messages: [] }),
            } as unknown as Response),
          );
        });
      }) as unknown as typeof fetch,
    });

    prefetcher.schedule();
    vi.advanceTimersByTime(PRE_DEBOUNCE_MS);
    await Promise.resolve();
    // Max 3 parallel fetches started
    expect(fetchedIds).toEqual(['a', 'b', 'c']);

    // Completing one slot starts the 4th
    inFlight.shift()!();
    await vi.runOnlyPendingTimersAsync();
    expect(fetchedIds).toEqual(['a', 'b', 'c', 'd']);
    expect(putCache).toHaveBeenCalled();
    prefetcher.dispose();
  });

  it('createIdleDialogController posts close-idle and renders closed vs kept rows', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <button id="idle-btn"></button>
      <div id="idle-dialog" hidden>
        <div id="idle-title"></div>
        <p id="idle-why"></p>
        <ul id="idle-list"></ul>
        <button id="idle-go"></button>
        <button id="idle-cancel"></button>
      </div>
    </body>`);
    const doc = dom.window.document;
    const postFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ closed: ['t1'], kept: ['t2'] }),
    }) as unknown as Response);

    const ctl = createIdleDialogController({
      els: {
        idleBtn: doc.getElementById('idle-btn')!,
        idleDialog: doc.getElementById('idle-dialog')!,
        idleTitle: doc.getElementById('idle-title')!,
        idleWhy: doc.getElementById('idle-why')!,
        idleList: doc.getElementById('idle-list')!,
        idleGo: doc.getElementById('idle-go') as HTMLButtonElement,
        idleCancel: doc.getElementById('idle-cancel') as HTMLButtonElement,
      },
      getIdleTopics: () => [
        makeTopic({ id: 't1', title: 'One', live: true }),
        makeTopic({ id: 't2', title: 'Two', live: true }),
      ],
      closeOtherMenus: () => {},
      postFn,
    });
    ctl.attach();
    ctl.open();
    expect(ctl.isOpen()).toBe(true);
    expect(doc.querySelectorAll('#idle-list li')).toHaveLength(2);

    doc.getElementById('idle-go')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(postFn).toHaveBeenCalledWith('api/topics/close-idle', { topics: ['t1', 't2'] }, 0);
    expect(doc.querySelector('[data-idle="t1"] .idle-out')?.textContent).toBe('closed');
    expect(doc.querySelector('[data-idle="t2"] .idle-out')?.textContent).toBe('left running');
    ctl.dispose();
  });

  it('createTopicsFeature handles optimistic starTopic rollback and switchTopic + enter', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="topics"></div><div id="topics-filter"></div><div id="row-menu" hidden></div>
      <button id="new-topic"></button><button id="read-topics"></button><button id="clear-topics"></button>
      <button id="close-idle"></button><button id="no-idle"></button><span id="idle-count"></span>
      <div id="idle-dialog" hidden><div id="idle-title"></div><p id="idle-why"></p><ul id="idle-list"></ul><button id="idle-go"></button><button id="idle-cancel"></button></div>
      <div id="topic-title"></div><div id="topic-status"></div>
      <button id="kill-agent"></button><button id="stop-turn"></button><div id="note"></div>
    </body>`, { url: 'http://localhost/' });
    const doc = dom.window.document;
    const topics: Topic[] = [
      makeTopic({ id: 't1', title: 'First', live: true }),
      makeTopic({ id: 't2', title: 'Second' }),
    ];
    let active = 't1';
    const alertFn = vi.fn();
    const connectStream = vi.fn();
    const postFn = vi.fn(async () => ({ ok: false }) as unknown as Response);

    const feature = createTopicsFeature({
      els: {
        bar: doc.getElementById('topics')!,
        topicsFilterHost: doc.getElementById('topics-filter')!,
        rowMenu: doc.getElementById('row-menu')!,
        newTopicBtn: doc.getElementById('new-topic')!,
        readBtn: doc.getElementById('read-topics') as HTMLButtonElement,
        clearBtn: doc.getElementById('clear-topics')!,
        idleBtn: doc.getElementById('close-idle')!,
        noIdleBtn: doc.getElementById('no-idle')!,
        idleCount: doc.getElementById('idle-count')!,
        idleDialog: doc.getElementById('idle-dialog')!,
        idleTitle: doc.getElementById('idle-title')!,
        idleWhy: doc.getElementById('idle-why')!,
        idleList: doc.getElementById('idle-list')!,
        idleGo: doc.getElementById('idle-go') as HTMLButtonElement,
        idleCancel: doc.getElementById('idle-cancel') as HTMLButtonElement,
        chatTitle: doc.getElementById('topic-title')!,
        chatStatus: doc.getElementById('topic-status')!,
        killBtn: doc.getElementById('kill-agent')!,
        stopBtn: doc.getElementById('stop-turn')!,
        note: doc.getElementById('note')!,
      },
      doc,
      win: dom.window as unknown as Window,
      storage: makeMemoryStorage(),
      instanceId: 'web',
      termOk: false,
      getIcons: () => ICONS,
      getTopics: () => topics,
      setTopics: () => {},
      getTopic: () => active,
      setTopic: (id) => { active = id; },
      getEpoch: () => 1,
      narrow: () => false,
      setSidebar: () => {},
      setSbTab: () => {},
      getSbTab: () => 'topics',
      closeMenus: () => {},
      closeLib: () => {},
      refreshHistoryReadOnly: () => {},
      closeSettings: () => {},
      closeGit: () => {},
      closeTransientSchedules: () => {},
      onSchedulesTopicsUpdated: () => {},
      getScheduleTask: () => null,
      openTaskPage: () => {},
      scheduleOp: () => {},
      rememberAdoptedReview: () => {},
      unreadOf: () => 0,
      needsRead: () => false,
      syncReads: () => {},
      markTopicReadFromList: () => {},
      removeRead: () => {},
      markAllRead: () => {},
      reportSeen: () => {},
      offSince: () => 0,
      offTitle: () => '',
      paintMachineNote: () => {},
      paintForkNote: () => {},
      syncCopyRef: () => {},
      copyTopicRef: () => {},
      applyTerm: () => {},
      paintFrames: () => {},
      dropTerm: () => {},
      urlNow: () => `?t=${active}`,
      command: () => {},
      saveView: () => {},
      stashDraft: () => {},
      loadDraft: () => {},
      seedDraft: () => {},
      forgetTopic: () => {},
      keepOnlyTopics: () => {},
      resetForSwitch: () => {},
      showSkeleton: () => {},
      setStale: () => {},
      setSettleOnResume: () => {},
      claimMessage: () => {},
      adoptMessages: () => {},
      showUnsent: () => {},
      isDbAvailable: () => false,
      getCacheVersion: () => undefined,
      setCacheVersion: () => {},
      isNewer: () => false,
      memCopy: () => null,
      getCache: async () => null,
      peekCache: async () => {},
      putCache: async () => true,
      dropCache: () => {},
      leaveCache: () => {},
      snapshotMsgs: () => [],
      isStreamParked: () => false,
      isStreamOpen: () => true,
      closeStream: () => {},
      setStreamLastEventId: () => {},
      connectStream,
      postFn,
      alertFn,
      confirmFn: () => true,
    });
    feature.attach();

    feature.starTopic('t1');
    expect(topics[0]!.starred).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(topics[0]!.starred).toBe(false);
    expect(alertFn).toHaveBeenCalled();

    feature.switchTopic('t2');
    expect(active).toBe('t2');
    expect(connectStream).toHaveBeenCalledWith(false);
    expect(doc.getElementById('topic-title')!.textContent).toBe('Second');
    feature.dispose();
  });
});
