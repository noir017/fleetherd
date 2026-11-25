import { describe, expect, it } from 'vitest';

import { en } from './client/i18n/en.js';
import { STORAGE_KEY } from './client/i18n/index.js';
import { zhCN } from './client/i18n/zh-CN.js';
import { message, open, sync, tick } from './page.dom.test-helpers.js';

describe('webui page: i18n switching', () => {
  const T = 'a1b2c3d4';

  it('defaults to en, switches to zh-CN via status bar without reload, and persists fh_lang', async () => {
    const h = await open({
      replies: {
        'api/schedules': { enabled: true, tasks: [] },
        'api/reviews': { enabled: true, reviews: [], pending: [] },
        'api/skills': { enabled: true, skills: [], misses: { empty: [], unread: [] } },
      },
    });
    await h.emit(sync(T, [message('m1', '<p>hello</p>')], [T]));
    await h.emit({ t: 'topics', topics: [{ id: T, title: 'Demo', running: false, live: true }] });
    await tick();

    const localeBtn = () => h.doc.querySelector<HTMLButtonElement>('[data-status-id="status.locale"]');
    expect(h.doc.documentElement.lang).toBe('en');
    expect(localeBtn()?.textContent).toContain('English');
    expect((h.el('input') as HTMLTextAreaElement).placeholder).toBe(en['composer.placeholder']);
    expect(h.doc.querySelector('#composer button[type="submit"]')?.textContent).toBe(en['composer.send']);

    localeBtn()!.click();
    await tick();

    expect(h.doc.documentElement.lang).toBe('zh-CN');
    expect(h.doc.defaultView?.localStorage.getItem(STORAGE_KEY)).toBe('zh-CN');
    expect(localeBtn()?.textContent).toContain('中文');

    const topicSearch = h.doc.querySelector<HTMLInputElement>('#topics-filter .fh-fb-q')!;
    expect(topicSearch.placeholder).toBe(zhCN['sidebar.searchTopics']);

    localeBtn()!.click();
    await tick();
    expect(h.doc.documentElement.lang).toBe('en');
    expect(h.doc.defaultView?.localStorage.getItem(STORAGE_KEY)).toBe('en');
    expect(localeBtn()?.textContent).toContain('English');
    expect(topicSearch.placeholder).toBe(en['sidebar.searchTopics']);
  });

  it('boots directly in zh-CN when localStorage fh_lang is pre-populated', async () => {
    const h = await open({
      storage: { [STORAGE_KEY]: 'zh-CN' },
    });
    await h.emit(sync(T, [message('m1', '<p>hi</p>')], [T]));
    await tick();

    expect(h.doc.documentElement.lang).toBe('zh-CN');
    expect(h.doc.querySelector('[data-status-id="status.locale"]')?.textContent).toContain('中文');
    expect(h.doc.querySelector('#composer button[type="submit"]')?.textContent).toBe(zhCN['composer.send']);
    expect((h.el('input') as HTMLTextAreaElement).placeholder).toBe(zhCN['composer.placeholder']);
  });

  it('sends the active X-Fleetherd-Locale header on api/send before and after toggling language', async () => {
    const h = await open({
      storage: { [STORAGE_KEY]: 'zh-CN' },
    });
    await h.emit(sync(T, [message('m1', '<p>hello</p>')], [T]));

    const sendText = async (msg: string) => {
      const input = h.el('input') as HTMLTextAreaElement;
      input.value = msg;
      h.el('composer').dispatchEvent(new h.doc.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
      await tick();
    };
    await sendText('你好');
    const firstSend = h.calls.filter((c) => c.path === 'api/send').at(-1);
    expect(firstSend?.headers?.['X-Fleetherd-Locale']).toBe('zh-CN');

    h.doc.querySelector<HTMLButtonElement>('[data-status-id="status.locale"]')!.click();
    await tick();
    expect(h.doc.documentElement.lang).toBe('en');

    await sendText('hello');
    const lastSend = h.calls.filter((c) => c.path === 'api/send').at(-1);
    expect(lastSend?.headers?.['X-Fleetherd-Locale']).toBe('en');
  });
});
