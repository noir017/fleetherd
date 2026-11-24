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
    expect(h.el('sb-tab-starred').textContent).toBe(en['sidebar.starred']);
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
    expect(h.el('sb-tab-starred').textContent).toBe(zhCN['sidebar.starred']);
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

  it('renders settings screen in zh-CN with localized groups, fields and badges, and refetches on language toggle', async () => {
    const h = await open({
      storage: { [STORAGE_KEY]: 'zh-CN' },
    });
    const zhSettingsMsg = {
      ...message('m_stg', '<p>Settings</p>'),
      settings: {
        level: 'list',
        about: '这些设置对所有会话生效。',
        groups: [{ name: '代理设置' }, { name: '通用' }],
        rows: [
          {
            buttonId: 'stg:r:0',
            label: 'cc',
            target: 'cc',
            targetKind: 'Claude Code',
            group: '代理设置',
            here: true,
            control: {
              kind: 'agent',
              fields: [
                { label: '模型', buttonId: 'stg:r:1', value: '宿主默认', unset: true },
                { label: '权限档位', buttonId: 'stg:r:2', value: 'auto' },
              ],
            },
          },
        ],
      },
    };
    await h.emit(sync(T, [message('m1', '<p>hello</p>')], [T]));
    await h.emit({ t: 'msg', msg: zhSettingsMsg });
    await tick();

    // Verify settings page is visible and rendered
    const page = h.el('settings-page');
    expect(page.hidden).toBe(false);

    // Group name '代理设置' recognized and rendered
    expect(h.doc.querySelector('.set-group')?.textContent).toBe('代理设置');

    // Badge '当前话题' with localized title
    const hereBadge = h.doc.querySelector('.set-badge.here');
    expect(hereBadge?.textContent).toBe(zhCN['settings.thisTopic']);
    expect(hereBadge?.getAttribute('title')).toContain('负责回复话题');

    // Field '模型' has class 'ag-mono'
    const modelPill = h.doc.querySelector('.ag-mono');
    expect(modelPill).not.toBeNull();
    expect(modelPill?.textContent).toBe('宿主默认');

    // While settings page is open, click #opts-toggle and #lang-toggle -> switches to en
    // and automatically triggers a quiet /setting command with X-Fleetherd-Locale
    await h.click('#opts-toggle');
    await h.click('#lang-toggle');
    await tick();

    expect(h.doc.documentElement.lang).toBe('en');
    const sendCalls = h.calls.filter((c) => c.path === 'api/send');
    const lastSend = sendCalls[sendCalls.length - 1];
    expect(lastSend).toBeDefined();
    expect(lastSend?.body.text).toBe('/setting');
    expect(lastSend?.body.quiet).toBe(true);
    expect(lastSend?.headers?.['X-Fleetherd-Locale']).toBe('en');
  });
});
