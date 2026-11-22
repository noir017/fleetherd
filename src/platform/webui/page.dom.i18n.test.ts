import { describe, expect, it } from 'vitest';

import { en } from './client/i18n/en.js';
import { STORAGE_KEY } from './client/i18n/index.js';
import { zhCN } from './client/i18n/zh-CN.js';
import { message, open, sync, tick } from './page.dom.test-helpers.js';

describe('webui page: i18n switching', () => {
  const T = 'a1b2c3d4';

  it('defaults to en, switches to zh-CN via #lang-toggle without reload, and persists fh_lang', async () => {
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

    expect(h.doc.documentElement.lang).toBe('en');
    expect(h.el('lang-state').textContent).toBe('English');
    expect(h.el('sb-tab-topics').textContent).toBe(en['sidebar.topics']);
    expect(h.el('sb-tab-history').textContent).toBe(en['sidebar.history']);
    expect((h.el('input') as HTMLTextAreaElement).placeholder).toBe(en['composer.placeholder']);
    expect(h.el('new-topic').getAttribute('title')).toBe(en['sidebar.newTopic']);
    expect(h.doc.querySelector('.sb-tabs')?.getAttribute('aria-label')).toBe(en['sidebar.tabsAria']);

    // Open Menu and click Language toggle -> switches immediately to zh-CN.
    await h.click('#opts-toggle');
    await h.click('#lang-toggle');
    await tick();

    expect(h.doc.documentElement.lang).toBe('zh-CN');
    expect(h.doc.defaultView?.localStorage.getItem(STORAGE_KEY)).toBe('zh-CN');
    expect(h.el('lang-state').textContent).toBe('简体中文');
    expect(h.el('sb-tab-topics').textContent).toBe(zhCN['sidebar.topics']);
    expect(h.el('sb-tab-history').textContent).toBe(zhCN['sidebar.history']);
    expect((h.el('input') as HTMLTextAreaElement).placeholder).toBe(zhCN['composer.placeholder']);
    expect(h.el('new-topic').getAttribute('title')).toBe(zhCN['sidebar.newTopic']);
    expect(h.doc.querySelector('.sb-tabs')?.getAttribute('aria-label')).toBe(zhCN['sidebar.tabsAria']);
    expect(h.doc.querySelector('#composer button[type="submit"]')?.textContent).toBe(zhCN['composer.send']);
    expect(h.doc.querySelector('#schedules-head .panel-title')?.textContent).toBe(zhCN['sideTasks.title']);

    // Dynamic filter bar and side panels reflect zh-CN immediately.
    const topicSearch = h.doc.querySelector('#topics-filter .fb-q') as HTMLInputElement;
    expect(topicSearch.placeholder).toBe(zhCN['sidebar.searchTopics']);
    expect(h.el('close-idle').textContent).toBe('关闭空闲 (1)');

    // Open Schedules panel and verify dynamic panel copy is zh-CN.
    await h.click('#schedules-toggle');
    await tick();
    expect(h.el('schedules-list').textContent).toContain(zhCN['sched.noTasksEnabled']);

    // Toggle again -> returns to en.
    await h.click('#lang-toggle');
    await tick();
    expect(h.doc.documentElement.lang).toBe('en');
    expect(h.doc.defaultView?.localStorage.getItem(STORAGE_KEY)).toBe('en');
    expect(h.el('lang-state').textContent).toBe('English');
    expect(h.el('sb-tab-topics').textContent).toBe(en['sidebar.topics']);
    expect(h.el('schedules-list').textContent).toContain(en['sched.noTasksEnabled']);
  });

  it('boots directly in zh-CN when localStorage fh_lang is pre-populated', async () => {
    const h = await open({
      storage: { [STORAGE_KEY]: 'zh-CN' },
    });
    await h.emit(sync(T, [message('m1', '<p>hi</p>')], [T]));
    await tick();

    expect(h.doc.documentElement.lang).toBe('zh-CN');
    expect(h.el('lang-state').textContent).toBe('简体中文');
    expect(h.el('sb-tab-topics').textContent).toBe(zhCN['sidebar.topics']);
    expect(h.doc.querySelector('#composer button[type="submit"]')?.textContent).toBe(zhCN['composer.send']);
    expect((h.el('input') as HTMLTextAreaElement).placeholder).toBe(zhCN['composer.placeholder']);
  });
});
