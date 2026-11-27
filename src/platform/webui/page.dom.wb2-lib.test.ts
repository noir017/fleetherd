// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillPanelDetail, SkillPanelEntry } from '../workbench.js';
import { Emitter } from './client/base/event.js';
import { createSettingsPlugin } from './client/features/settings/plugin.js';
import { createSkillsPlugin, SKILL_EDITOR_KIND, SKILLS_VIEW_ID } from './client/features/skills/index.js';
import { createDevicePreferencesPanel } from './client/features/status/device-settings.js';
import { STATUS_I18N_EN } from './client/features/status/i18n.js';
import { PluginManager } from './client/plugins/host.js';
import { ContributionRegistry, WebuiEventBus } from './client/plugins/registry.js';
import { createApiClient, type ApiClient } from './client/services/api.js';
import { StorageService, type StorageLike } from './client/services/storage.js';
import type { PanelInitContext } from './client/workbench/contracts.js';

function makeMemoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

function makeInitCtx(id: string): PanelInitContext {
  const vis = new Emitter<boolean>();
  const dim = new Emitter<{ readonly width: number; readonly height: number }>();
  return {
    id,
    api: {
      id,
      group: 'main',
      params: {},
      onDidVisibilityChange: vis.event,
      onDidDimensionsChange: dim.event,
      setTitle: vi.fn(),
      setBadge: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('wb2-lib: skills, settings, instructions, and device alignment', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('groups skills by category + archived and renders compact skill editor with discard button', async () => {
    const skills: SkillPanelEntry[] = [
      {
        name: 'deploy-check',
        description: 'Release checklist',
        version: 'c4f06d7',
        status: 'active',
        pinned: true,
        createdAt: '2026-11-20T10:00:00.000Z',
        lastUsedAt: '2026-11-24T10:00:00.000Z',
        uses: 4,
        agents: ['claude', 'codex'],
        resident: false,
        category: 'ops',
      },
      {
        name: 'old-deploy',
        description: 'Legacy deploy steps',
        version: '1111111',
        status: 'archived',
        pinned: false,
        createdAt: '2026-10-20T10:00:00.000Z',
        uses: 1,
        agents: [],
        resident: false,
        category: 'ops',
      },
    ];
    const detail: SkillPanelDetail = {
      skill: skills[0]!,
      files: [
        { path: 'SKILL.md', size: 128 },
        { path: 'references/arm64.md', size: 64 },
      ],
      file: { path: 'SKILL.md', content: '# Initial\n', version: 'c4f06d7' },
      history: [
        {
          id: 'c4f06d7abcdef',
          at: '2026-11-24T10:00:00.000Z',
          action: 'patch',
          author: 'fleetherd-review',
          beforeVersion: '9e1a2b0',
          afterVersion: 'c4f06d7',
          note: 'Add git fetch step',
        },
      ],
    };

    const api: ApiClient = {
      post: vi.fn(async () => new Response('{}')),
      get: vi.fn(async () => new Response('{}')),
      async getJson<T>(): Promise<T> {
        return { enabled: true, skills, searches: null } as T;
      },
      async postJson<T>(): Promise<T> {
        return { ok: true, skills, detail } as T;
      },
    };
    const registry = new ContributionRegistry({ openEditor: vi.fn() });
    const events = new WebuiEventBus();
    const storage = new StorageService('', makeMemoryStorage());
    const manager = new PluginManager({
      registry,
      events,
      storage,
      api,
      topics: { list: () => [], active: () => undefined, open: vi.fn(), insertIntoComposer: vi.fn() },
    });
    manager.register(createSkillsPlugin({ doc: document, confirm: () => true, formatAgo: () => '2h' }), {
      builtin: true,
    });
    await manager.activate('skills');

    const view = registry.getView(SKILLS_VIEW_ID)!.component();
    document.body.appendChild(view.element);
    view.init({}, makeInitCtx('view:skills'));
    await flush();

    expect(view.element.querySelector('.fh-skill-pin-icon')).not.toBeNull();
    expect(view.element.querySelector('.fh-skill-row.is-archived')).not.toBeNull();

    const editor = registry.getEditor(SKILL_EDITOR_KIND)!.component();
    document.body.appendChild(editor.element);
    editor.init({ name: 'deploy-check' }, makeInitCtx('ed:skill'));
    await flush();

    expect(editor.element.querySelector('.fh-skill-ed-bar [data-sop="save"]')).not.toBeNull();
    expect(editor.element.querySelectorAll('.fh-skill-ci')).toHaveLength(4);
    expect(editor.element.querySelectorAll('.fh-skill-file-row')).toHaveLength(3);
    expect(editor.element.querySelector('.fh-skill-hist-action code')?.textContent).toBe('c4f06d7');

    const ta = editor.element.querySelector<HTMLTextAreaElement>('textarea.fh-skill-ed-textarea')!;
    ta.value = '# Changed\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const discardBtn = editor.element.querySelector<HTMLButtonElement>('[data-sop="discard"]')!;
    expect(discardBtn).not.toBeNull();
    discardBtn.click();
    expect(ta.value).toBe('# Initial\n');
    expect(editor.element.querySelector('[data-sop="discard"]')).toBeNull();

    view.dispose();
    editor.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('adds Instruction files to settings catalog when instrOk is true and supports Discard in instruction editor', async () => {
    const opened: Array<{ kind: string; input: unknown }> = [];
    const registry = new ContributionRegistry();
    registry.setEditorOpener((kind, input) => opened.push({ kind, input }));
    const events = new WebuiEventBus();
    const storage = new StorageService('', makeMemoryStorage());

    const fetchMock = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s === 'api/instructions') {
        return new Response(
          JSON.stringify({
            on: true,
            dir: '/tmp/instr',
            global: [{ name: 'common.md', layer: 'common', reach: 'all agents', exists: true, agents: ['claude'] }],
            agents: [],
          }),
          { status: 200 },
        );
      }
      if (s.startsWith('api/instructions/read')) {
        return new Response(
          JSON.stringify({ text: '# Common\n', mtimeMs: 100, size: 9, sha256: '7a1c09e1234', eol: 'lf' }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new PluginManager({
      registry,
      events,
      storage,
      api: createApiClient(),
      topics: {
        list: () => [{ id: 't1', title: 'Main', lastAt: 1 }],
        active: () => ({ id: 't1', title: 'Main', lastAt: 1 }),
        open: vi.fn(),
        insertIntoComposer: vi.fn(),
      },
    });
    manager.register(
      createSettingsPlugin({
        instrOk: true,
        listDeviceSections: () => registry.listSettingsSections(),
        onDidChangeDeviceSections: registry.onDidChangeSettings,
      }),
      { builtin: true },
    );
    await manager.activate('settings');

    const catalog = registry.getView('settings')!.component();
    document.body.appendChild(catalog.element);
    catalog.init({}, makeInitCtx('view:settings'));

    const rows = Array.from(catalog.element.querySelectorAll<HTMLElement>('[role="option"]'));
    const instrRow = rows.find((r) => r.textContent?.includes('Instruction files'));
    expect(instrRow).toBeDefined();
    instrRow!.click();
    expect(opened.at(-1)).toEqual({ kind: 'instruction', input: { all: true } });

    const instrEd = registry.getEditor('instruction')!.component();
    document.body.appendChild(instrEd.element);
    instrEd.init({ all: true }, makeInitCtx('ed:instr'));
    await flush();

    const ta = instrEd.element.querySelector<HTMLTextAreaElement>('.wb-instr-text')!;
    expect(ta.value).toBe('# Common\n');
    ta.value = '# Modified\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const discard = instrEd.element.querySelector<HTMLButtonElement>('.wb-instr-discard')!;
    expect(discard.hidden).toBe(false);
    discard.click();
    expect(ta.value).toBe('# Common\n');
    expect(discard.hidden).toBe(true);

    catalog.dispose();
    instrEd.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('orders device preferences rows to match mockup (Notifications, Theme, Language, Low attention, Reset)', () => {
    const emitter = new Emitter<void>();
    const panel = createDevicePreferencesPanel({
      doc: document,
      t: (k) => STATUS_I18N_EN[k] ?? k,
      getSnapshot: () => ({
        theme: 'system',
        locale: 'en',
        calm: false,
        notify: { supported: true, available: true, enabled: true, blocked: false, busy: false },
      }),
      onDidChange: emitter.event,
      setTheme: vi.fn(),
      setLocale: vi.fn(),
      setCalm: vi.fn(),
      toggleNotify: vi.fn(async () => {}),
      resetLayout: vi.fn(),
    });
    document.body.appendChild(panel.element);
    panel.init({}, makeInitCtx('dev'));

    const card = panel.element.querySelector('.fh-device-prefs-card');
    expect(card).not.toBeNull();
    const ids = Array.from(panel.element.querySelectorAll<HTMLElement>('[id^="fh-pref-"]')).map((el) => el.id);
    expect(ids).toEqual(['fh-pref-notify', 'fh-pref-calm', 'fh-pref-reset-layout']);
    const labels = Array.from(panel.element.querySelectorAll('.fh-field-label')).map((el) => el.textContent?.trim());
    expect(labels[0]).toContain('Browser push notifications');
    expect(labels[1]).toContain('Theme');
    expect(labels[2]).toContain('Language');
    expect(labels[3]).toContain('Low attention');

    panel.dispose();
    emitter.dispose();
  });
});
