import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { en } from './en.js';
import {
  applyDomI18n,
  detectLocale,
  getLocale,
  initLocale,
  localeLabel,
  matchLocale,
  nextLocale,
  onLocaleChange,
  setLocale,
  STORAGE_KEY,
  SUPPORTED_LOCALES,
  t,
  type MessageKey,
} from './index.js';
import { zhCN } from './zh-CN.js';

function placeholdersOf(text: string): string[] {
  const matches = text.match(/\{[a-zA-Z0-9_]+\}/g) ?? [];
  return [...new Set(matches)].sort();
}

describe('webui client i18n', () => {
  const origLocalStorage = globalThis.localStorage;
  const origNavigator = globalThis.navigator;
  const origDocument = globalThis.document;
  const origElement = globalThis.Element;

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: origLocalStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: origNavigator, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'document', { value: origDocument, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'Element', { value: origElement, configurable: true, writable: true });
    setLocale('en');
  });

  it('keeps exact key parity and placeholder parity between en and zh-CN', () => {
    const enKeys = Object.keys(en).sort();
    const zhKeys = Object.keys(zhCN).sort();
    expect(zhKeys).toEqual(enKeys);
    for (const key of enKeys as MessageKey[]) {
      expect(en[key].length).toBeGreaterThan(0);
      expect(zhCN[key].length).toBeGreaterThan(0);
      const enVars = new Set(placeholdersOf(en[key]));
      for (const v of placeholdersOf(zhCN[key])) {
        expect(enVars.has(v)).toBe(true);
      }
    }
  });

  it('registers supported locales and cycles cleanly', () => {
    expect(SUPPORTED_LOCALES.map((l) => l.code)).toEqual(['en', 'zh-CN']);
    expect(localeLabel('en')).toBe('English');
    expect(localeLabel('zh-CN')).toBe('简体中文');
    expect(nextLocale('en')).toBe('zh-CN');
    expect(nextLocale('zh-CN')).toBe('en');
  });

  it('interpolates {param} placeholders and falls back cleanly', () => {
    setLocale('en');
    expect(t('common.showingOf', { shown: 3, total: 10 })).toBe('Showing 3 of 10');
    expect(t('common.showingOf', { shown: 3 })).toBe('Showing 3 of {total}');

    setLocale('zh-CN');
    expect(t('common.showingOf', { shown: 3, total: 10 })).toBe('显示 3 / 10');

    // Unknown key falls back to the key string itself rather than throwing or returning empty.
    expect(t('nonexistent.key' as MessageKey)).toBe('nonexistent.key');
  });

  it('matches browser and stored locale tags', () => {
    expect(matchLocale('zh-CN')).toBe('zh-CN');
    expect(matchLocale('zh_cn')).toBe('zh-CN');
    expect(matchLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(matchLocale('zh')).toBe('zh-CN');
    expect(matchLocale('en')).toBe('en');
    expect(matchLocale('en-US')).toBe('en');
    expect(matchLocale('fr-FR')).toBeNull();
    expect(matchLocale('')).toBeNull();
    expect(matchLocale(null)).toBeNull();
  });

  it('detects locale in priority order: localStorage -> navigator.languages -> en', () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { languages: ['ja-JP', 'zh-CN'], language: 'ja-JP' },
    });

    expect(detectLocale()).toBe('zh-CN');

    store.set(STORAGE_KEY, 'en');
    expect(detectLocale()).toBe('en');

    store.clear();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { languages: ['en-US'], language: 'en-US' },
    });
    expect(detectLocale()).toBe('en');

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { languages: ['fr-FR'], language: 'fr-FR' },
    });
    expect(detectLocale()).toBe('en');
  });

  it('notifies listeners on setLocale and stops after unsubscribe', () => {
    const cb = vi.fn();
    const off = onLocaleChange(cb);
    setLocale('zh-CN');
    expect(getLocale()).toBe('zh-CN');
    expect(cb).toHaveBeenCalledWith('zh-CN');

    off();
    setLocale('en');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('applies data-i18n* attributes and syncs <html lang>', () => {
    const dom = new JSDOM(
      '<!doctype html><html lang="en"><body>'
      + '<button id="b" data-i18n="sidebar.topics" data-i18n-title="sidebar.topicsTitle" data-i18n-aria="sidebar.tabsAria">Topics</button>'
      + '<input id="q" data-i18n-placeholder="composer.placeholder" placeholder="Message">'
      + '</body></html>',
    );
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'Element', { value: dom.window.Element, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'], language: 'en-US' }, configurable: true, writable: true });

    expect(initLocale()).toBe('en');
    expect(dom.window.document.documentElement.lang).toBe('en');

    setLocale('zh-CN');
    applyDomI18n(dom.window.document);

    expect(dom.window.document.documentElement.lang).toBe('zh-CN');
    const btn = dom.window.document.getElementById('b')!;
    const inp = dom.window.document.getElementById('q') as HTMLInputElement;
    expect(btn.textContent).toBe(zhCN['sidebar.topics']);
    expect(btn.getAttribute('title')).toBe(zhCN['sidebar.topicsTitle']);
    expect(btn.getAttribute('aria-label')).toBe(zhCN['sidebar.tabsAria']);
    expect(inp.getAttribute('placeholder')).toBe(zhCN['composer.placeholder']);
  });
});
