// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { StorageService } from '../../services/storage.js';
import {
  TERM_H_KEY,
  TERM_MIN,
  computeTermHeight,
  computeTermLimits,
  createTerminalController,
  formatTopicUrl,
} from './index.js';

function makeMemoryStorage(): StorageService {
  const map = new Map<string, string>();
  return new StorageService('', {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  });
}

function makeTermFixture(overrides: { enabled?: boolean; canEnd?: boolean } = {}) {
  const chat = document.createElement('div');
  Object.defineProperty(chat, 'clientHeight', { value: 800, configurable: true });
  const chatHead = document.createElement('div');
  Object.defineProperty(chatHead, 'clientHeight', { value: 48, configurable: true });
  const composer = document.createElement('div');
  Object.defineProperty(composer, 'clientHeight', { value: 60, configurable: true });
  const termBtn = document.createElement('button');
  termBtn.hidden = true;
  const termHost = document.createElement('div');
  const termEl = document.createElement('div');
  const termGrip = document.createElement('div');
  Object.defineProperty(termGrip, 'offsetHeight', { value: 12, configurable: true });
  const termName = document.createElement('span');
  const termMinBtn = document.createElement('button');
  const termEndBtn = document.createElement('button');

  let topic = 't1';
  let overlay = false;
  const storage = makeMemoryStorage();
  const toBottom = vi.fn();
  const post = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
  const confirmFn = vi.fn(() => true);
  const alertFn = vi.fn();

  const ctrl = createTerminalController({
    enabled: overrides.enabled ?? true,
    canEnd: overrides.canEnd ?? true,
    chat,
    chatHead,
    composer,
    termBtn,
    termHost,
    termEl,
    termGrip,
    termName,
    termMinBtn,
    termEndBtn,
    getTopic: () => topic,
    getTopicTitle: (id) => (id === 't1' ? 'Build Topic' : undefined),
    isOverlayCovering: () => overlay,
    atBottom: () => true,
    toBottom,
    post,
    storage,
    confirmFn,
    alertFn,
  });

  return {
    ctrl,
    chat,
    termBtn,
    termHost,
    termEl,
    termGrip,
    termName,
    termEndBtn,
    storage,
    toBottom,
    post,
    confirmFn,
    alertFn,
    setTopic: (next: string) => {
      topic = next;
    },
    setOverlay: (next: boolean) => {
      overlay = next;
    },
  };
}

describe('features/terminal', () => {
  it('computes height limits, clamped height, and topic URL', () => {
    expect(computeTermLimits(0, 48, 60, 12)).toEqual({ min: TERM_MIN, max: TERM_MIN + 40 });
    const lim = computeTermLimits(800, 48, 60, 12);
    expect(lim).toEqual({ min: 120, max: 560 });
    expect(computeTermHeight(0, 800, lim)).toBe(400);
    expect(computeTermHeight(999, 800, lim)).toBe(560);
    expect(computeTermHeight(50, 800, lim)).toBe(120);
    expect(formatTopicUrl('a/b', true)).toBe('?t=a%2Fb&v=term');
    expect(formatTopicUrl('a/b', false)).toBe('?t=a%2Fb');
  });

  it('opens, minimizes, hides under overlay, and prunes topic iframes', () => {
    const f = makeTermFixture();
    expect(f.termBtn.hidden).toBe(false);

    f.ctrl.show();
    expect(f.ctrl.isOpen('t1')).toBe(true);
    expect(f.chat.classList.contains('term')).toBe(true);
    expect(f.termHost.querySelectorAll('iframe')).toHaveLength(1);
    expect(f.termHost.querySelector('iframe')?.getAttribute('src')).toBe('term/?arg=t1');
    expect(f.termName.textContent).toBe('Build Topic');
    expect(f.termEl.style.height).toBe('400px');
    expect(f.toBottom).toHaveBeenCalledTimes(1);

    f.setOverlay(true);
    f.ctrl.paintFrames();
    expect(f.termHost.querySelector('iframe')?.classList.contains('on')).toBe(false);
    expect(f.termEl.hasAttribute('inert')).toBe(true);

    f.setOverlay(false);
    f.ctrl.minimize();
    expect(f.ctrl.getState('t1')).toBe('min');
    expect(f.termHost.querySelectorAll('iframe')).toHaveLength(1);

    f.ctrl.pruneFrames({});
    expect(f.termHost.querySelectorAll('iframe')).toHaveLength(0);
    expect(f.ctrl.getState('t1')).toBeUndefined();
    f.ctrl.dispose();
  });

  it('resizes via keyboard and resets via double-click, persisting to storage', () => {
    const f = makeTermFixture();
    f.ctrl.show();

    f.termGrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(f.termEl.style.height).toBe('424px');
    expect(f.storage.getRaw(TERM_H_KEY)).toBe('424');

    f.termGrip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(f.termEl.style.height).toBe('400px');
    expect(f.storage.getRaw(TERM_H_KEY)).toBeNull();
    f.ctrl.dispose();
  });

  it('ends terminal session on confirmation and drops frame on success', async () => {
    const f = makeTermFixture();
    f.ctrl.show();
    await f.ctrl.end();
    expect(f.confirmFn).toHaveBeenCalledTimes(1);
    expect(f.post).toHaveBeenCalledWith('api/terminal/end', { topic: 't1' }, 0);
    expect(f.ctrl.getState('t1')).toBeUndefined();
    expect(f.termHost.querySelectorAll('iframe')).toHaveLength(0);
    f.ctrl.dispose();
  });
});
