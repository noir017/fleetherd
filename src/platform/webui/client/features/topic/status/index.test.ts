import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '../../../i18n/index.js';
import { createTopicStatusController, PEEK_DEBOUNCE_MS, STATUS_TICK_MS } from './index.js';

function makeEl(): {
  el: HTMLElement;
  writes: () => number;
} {
  let inner = '';
  let writeCount = 0;
  const classes = new Set<string>();
  const stub = {
    hidden: true,
    textContent: '',
    value: '',
    placeholder: '',
    get innerHTML() {
      return inner;
    },
    set innerHTML(v: string) {
      inner = v;
      writeCount += 1;
    },
    classList: {
      contains: (c: string) => classes.has(c),
      toggle: (c: string) => {
        if (classes.has(c)) classes.delete(c);
        else classes.add(c);
      },
      add: (c: string) => classes.add(c),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    focus: () => {},
  };
  return { el: stub as unknown as HTMLElement, writes: () => writeCount };
}

function makeDoc(initialState: DocumentVisibilityState = 'visible'): {
  doc: Document;
  setVisibility: (state: DocumentVisibilityState) => void;
  triggerVisibilityChange: () => void;
} {
  let state = initialState;
  const listeners = new Map<string, Array<() => void>>();
  const doc = {
    get visibilityState() {
      return state;
    },
    addEventListener: (type: string, cb: () => void) => {
      const list = listeners.get(type) ?? [];
      list.push(cb);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, cb: () => void) => {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((fn) => fn !== cb),
      );
    },
  } as unknown as Document;
  return {
    doc,
    setVisibility: (next) => {
      state = next;
    },
    triggerVisibilityChange: () => {
      for (const fn of listeners.get('visibilitychange') ?? []) fn();
    },
  };
}

describe('features/topic/status/index', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setLocale('en');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the countdown ticker only while visible and skips redundant DOM writes', () => {
    const status = makeEl();
    const { doc, setVisibility, triggerVisibilityChange } = makeDoc('visible');
    let now = 1_700_000_000_000;

    const ctl = createTopicStatusController({
      statusEl: status.el,
      pendingQueueEl: null,
      modelPopEls: {
        modelPop: makeEl().el,
        mpList: makeEl().el,
        mpFilter: makeEl().el as unknown as HTMLInputElement,
        mpAgent: makeEl().el,
        mpHeading: makeEl().el,
        mpFoot: makeEl().el,
        mpClose: makeEl().el,
      },
      doc,
      getTopic: () => 't1',
      isSynced: () => true,
      hasLauncher: () => false,
      hasMessages: () => true,
      narrow: () => false,
      getIcons: () => ({ clock: '', bolt: '', undo: '', check: '' }),
      inl: (s) => s,
      setNote: () => {},
      onRetireLocalNonce: () => {},
      onRecallContent: () => {},
      now: () => now,
      fetchFn: vi.fn(),
    });
    ctl.attach();

    ctl.setStatus({ agent: 'cc', model: 'opus', cacheExpiresAt: now + 10 * 60_000 });
    expect(status.writes()).toBe(1);
    expect(status.el.innerHTML).toContain('cache 10m');

    // Half a minute later: still 9m -> writes once; another 10s later: still 9m -> no DOM write.
    now += STATUS_TICK_MS;
    vi.advanceTimersByTime(STATUS_TICK_MS);
    expect(status.writes()).toBe(2);
    expect(status.el.innerHTML).toContain('cache 9m');

    now += 10_000;
    vi.advanceTimersByTime(STATUS_TICK_MS);
    expect(status.writes()).toBe(2);

    // Tab hidden stops the interval; advancing time does not write.
    setVisibility('hidden');
    triggerVisibilityChange();
    now += 2 * 60_000;
    vi.advanceTimersByTime(STATUS_TICK_MS * 4);
    expect(status.writes()).toBe(2);

    // Tab visible again redraws immediately and re-arms the ticker.
    setVisibility('visible');
    triggerVisibilityChange();
    expect(status.writes()).toBe(3);
    expect(status.el.innerHTML).toContain('cache 7m');

    ctl.dispose();
  });

  it('shows the model switch as soon as the launcher is gone and debounces option peek', async () => {
    const status = makeEl();
    const { doc } = makeDoc('visible');
    let launcherOpen = true;
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        agent: 'agy',
        model: 'gemini-2.5',
        options: [{ id: 'acct', name: 'Account', value: 'main' }],
      }),
    });

    const ctl = createTopicStatusController({
      statusEl: status.el,
      pendingQueueEl: null,
      modelPopEls: {
        modelPop: makeEl().el,
        mpList: makeEl().el,
        mpFilter: makeEl().el as unknown as HTMLInputElement,
        mpAgent: makeEl().el,
        mpHeading: makeEl().el,
        mpFoot: makeEl().el,
        mpClose: makeEl().el,
      },
      doc,
      getTopic: () => 't-new',
      isSynced: () => true,
      hasLauncher: () => launcherOpen,
      hasMessages: () => true,
      narrow: () => false,
      getIcons: () => ({ clock: '', bolt: '', undo: '', check: '' }),
      inl: (s) => s,
      setNote: () => {},
      onRetireLocalNonce: () => {},
      onRecallContent: () => {},
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    ctl.paintStatus();
    expect(status.el.hidden).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();

    // Agent chosen on launcher -> launcher disappears -> bare model switch appears immediately.
    launcherOpen = false;
    ctl.paintStatus();
    expect(status.el.hidden).toBe(false);
    expect(status.el.innerHTML).toContain('class="st-model"');
    expect(fetchFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PEEK_DEBOUNCE_MS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('api/options?peek=1&t=t-new', {
      credentials: 'same-origin',
    });
    expect(status.el.innerHTML).toContain('agy');
    expect(status.el.innerHTML).toContain('gemini-2.5');
    expect(status.el.innerHTML).toContain('Account');

    ctl.dispose();
  });
});
