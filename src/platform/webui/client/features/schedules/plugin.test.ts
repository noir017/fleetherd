// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SchedulePanelFormContext,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
} from '../../../../adapter.js';
import { Emitter } from '../../base/event.js';
import { setLocale } from '../../i18n/index.js';
import type { TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import { createSchedulesPlugin } from './plugin.js';
import type { SchedulePanelInitContext } from './types.js';

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

function makePanelInitContext(id: string): {
  ctx: SchedulePanelInitContext;
  setTitle: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  visibility: Emitter<boolean>;
} {
  const visibility = new Emitter<boolean>();
  const dims = new Emitter<{ readonly width: number; readonly height: number }>();
  const setTitle = vi.fn();
  const close = vi.fn();
  return {
    ctx: {
      id,
      api: {
        id,
        group: 'sidebar',
        params: undefined,
        onDidVisibilityChange: visibility.event,
        onDidDimensionsChange: dims.event,
        setTitle,
        setBadge: vi.fn(),
        focus: vi.fn(),
        close,
      },
    },
    setTitle,
    close,
    visibility,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const SAMPLE_SHAPES: SchedulePanelFormContext['shapes'] = {
  new: ['agent', 'model', 'cwd', 'timeout', 'at'],
  daily: ['agent', 'model', 'cwd', 'timeout'],
  fixed: ['agent', 'timeout', 'at'],
  bash: ['host', 'cwd', 'timeout', 'at'],
};

const SAMPLE_TASK: SchedulePanelTask = {
  id: 'task-1',
  name: 'nightly-ci-report',
  tags: ['ci'],
  createdAt: 1700000000000,
  state: 'active',
  when: '0 2 * * * (UTC)',
  nextAt: 1700003600000,
  next: 'tomorrow 02:00',
  run: 'agent coder · new session',
  target: 'web:topic-main',
  targetTopic: 'topic-main',
  last: { at: 1699999000000, atText: 'today 02:00', status: 'ok', durationMs: 4200 },
  runs: 3,
  running: false,
  detail: 'Summarize failing CI jobs.',
  kind: 'agent',
};

const SAMPLE_DETAIL: SchedulePanelTaskDetail = {
  task: SAMPLE_TASK,
  agents: ['coder', 'reviewer'],
  agentHosts: { coder: 'box-a' },
  hosts: ['box-a'],
  channels: [{ id: 'chat:ops', title: 'Ops Channel' }],
  shapes: SAMPLE_SHAPES,
  tz: 'UTC',
  agent: 'coder',
  fields: {
    name: 'nightly-ci-report',
    cron: '0 2 * * *',
    tz: 'UTC',
    prompt: 'Summarize failing CI jobs.',
    agent: 'coder',
    session: 'new',
    target: 'web:topic-main',
  },
  runs: [
    {
      at: 1699999000000,
      atText: 'today 02:00',
      status: 'ok',
      durationMs: 4200,
      topic: 'sess-1',
    },
  ],
};

function makeHarness(options?: {
  topicsList?: TopicInfo[];
  getJson?: (path: string) => Promise<unknown>;
  postJson?: (path: string, body: unknown) => Promise<unknown>;
}) {
  const openEditor = vi.fn();
  const openTopic = vi.fn();
  const registry = new ContributionRegistry({ openEditor });
  const events = new WebuiEventBus();
  const storage = new StorageService('', makeMemoryStorage());
  const topicsData: TopicInfo[] = options?.topicsList ?? [
    { id: 'topic-main', title: 'Main Workspace', lastAt: 1700000000000 },
    {
      id: 'sess-1',
      title: 'nightly-ci-report #3',
      lastAt: 1700000000000,
      scheduled: true,
      task: 'task-1',
      msgCount: 4,
    },
  ];
  const getJson = vi.fn(
    options?.getJson ??
      (async (path: string) => {
        if (path === '/api/schedules') return { enabled: true, tasks: [SAMPLE_TASK] };
        if (path.startsWith('/api/schedules/task?')) return { ok: true, detail: structuredClone(SAMPLE_DETAIL) };
        if (path === '/api/schedules/form') {
          return {
            ok: true,
            form: {
              agents: ['coder'],
              agentHosts: {},
              hosts: ['box-a'],
              channels: [{ id: 'chat:ops', title: 'Ops' }],
              shapes: SAMPLE_SHAPES,
              tz: 'UTC',
              agent: 'coder',
            },
          };
        }
        return {};
      }),
  );
  const postJson = vi.fn(
    options?.postJson ??
      (async (path: string, body: unknown) => {
        if (path === '/api/schedules/op') {
          const req = body as { id: string; action: string; tags?: string[] };
          if (req.action === 'remove') return { ok: true, tasks: [] };
          const updated: SchedulePanelTask = {
            ...SAMPLE_TASK,
            state: req.action === 'pause' ? 'paused' : req.action === 'resume' ? 'active' : SAMPLE_TASK.state,
            tags: req.tags ?? SAMPLE_TASK.tags,
          };
          return { ok: true, tasks: [updated] };
        }
        if (path === '/api/schedules/edit' || path === '/api/schedules/add') {
          const updatedTask: SchedulePanelTask = { ...SAMPLE_TASK, id: 'task-2', name: 'disk-check' };
          return {
            ok: true,
            detail: { ...structuredClone(SAMPLE_DETAIL), task: updatedTask },
            tasks: [SAMPLE_TASK, updatedTask],
          };
        }
        return { ok: true };
      }),
  );
  const api: ApiClient = {
    get: vi.fn(async () => new Response('{}')),
    post: vi.fn(async () => new Response('{}')),
    getJson: getJson as ApiClient['getJson'],
    postJson: postJson as ApiClient['postJson'],
  };
  const topics: PluginTopicsBridge = {
    list: () => topicsData,
    active: () => topicsData[0],
    open: openTopic,
    insertIntoComposer: vi.fn(),
  };
  const manager = new PluginManager({ registry, events, storage, api, topics });
  return { registry, events, storage, api, getJson, postJson, topics, topicsData, openEditor, openTopic, manager };
}

describe('features/schedules plugin', () => {
  afterEach(() => {
    setLocale('en');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('registers activity, sidebar view, schedule editor, task.row menus, and commands, and disposes cleanly', async () => {
    const { registry, events, manager, openEditor } = makeHarness();
    const plugin = createSchedulesPlugin({ now: () => 1700000100000 });

    manager.register(plugin, { builtin: true });
    const active = await manager.activateAll();
    expect(active).toEqual(['schedules']);

    expect(registry.getActivity('schedules')?.icon).toBe('clock');
    expect(registry.getView('schedules')?.part).toBe('sidebar');
    expect(registry.getEditor('schedule')).toBeDefined();
    expect(registry.commands.has('schedules.new')).toBe(true);
    expect(registry.commands.has('schedules.refresh')).toBe(true);

    const activeMenus = registry.listMenuItems('task.row', SAMPLE_TASK).map((m) => m.id);
    expect(activeMenus).toEqual(['schedules.run', 'schedules.pause', 'schedules.edit', 'schedules.delete']);

    const pausedTask: SchedulePanelTask = { ...SAMPLE_TASK, state: 'paused' };
    const pausedMenus = registry.listMenuItems('task.row', pausedTask).map((m) => m.id);
    expect(pausedMenus).toEqual(['schedules.run', 'schedules.resume', 'schedules.edit', 'schedules.delete']);

    await registry.executeCommand('schedules.new');
    expect(openEditor).toHaveBeenCalledWith('schedule', { id: null, mode: 'new' }, undefined);

    manager.deactivate('schedules');
    expect(registry.getActivity('schedules')).toBeUndefined();
    expect(registry.getView('schedules')).toBeUndefined();
    expect(registry.getEditor('schedule')).toBeUndefined();
    expect(registry.listMenuItems('task.row', SAMPLE_TASK)).toEqual([]);
    expect(registry.commands.has('schedules.new')).toBe(false);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('renders sidebar tasks/sessions segmented tabs, opens editor on row click, and supports task.row context menu + delete confirm', async () => {
    const { registry, events, manager, openEditor, openTopic, postJson } = makeHarness();
    manager.register(createSchedulesPlugin({ now: () => 1700000100000 }), { builtin: true });
    await manager.activateAll();

    const viewContrib = registry.getView('schedules')!;
    const view = viewContrib.component();
    document.body.appendChild(view.element);
    view.init(undefined, makePanelInitContext('schedules').ctx);
    await flushMicrotasks();

    // Renders loaded task row and clicking it opens the schedule editor.
    const row = view.element.querySelector<HTMLElement>('.sched-row');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('nightly-ci-report');
    row?.click();
    expect(openEditor).toHaveBeenCalledWith(
      'schedule',
      { id: 'task-1', mode: 'view', title: 'nightly-ci-report' },
      { id: 'schedule:task-1' },
    );

    // Opens context menu via ⋯ button and confirms delete via components/dialog.
    const moreBtn = view.element.querySelector<HTMLButtonElement>('[data-task-menu="task-1"]')!;
    moreBtn.click();
    const deleteMenuBtn = document.body.querySelector<HTMLButtonElement>('[data-menu-id="schedules.delete"]')!;
    expect(deleteMenuBtn).not.toBeNull();
    deleteMenuBtn.click();
    await flushMicrotasks();

    const confirmBtn = document.body.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]')!;
    expect(confirmBtn).not.toBeNull();
    confirmBtn.click();
    await flushMicrotasks();
    expect(postJson).toHaveBeenCalledWith('/api/schedules/op', { id: 'task-1', action: 'remove' });

    // Switches segmented tab to Sessions and opens scheduled session topic.
    const sessionsSeg = view.element.querySelector<HTMLButtonElement>('[data-seg-value="sessions"]')!;
    sessionsSeg.click();
    const sessRow = view.element.querySelector<HTMLElement>('[data-sess="sess-1"]')!;
    expect(sessRow).not.toBeNull();
    sessRow.click();
    expect(openTopic).toHaveBeenCalledWith('sess-1');

    view.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('renders schedule editor in view, edit, and new modes and supports session jump & form save', async () => {
    const { registry, events, manager, openTopic, postJson } = makeHarness();
    manager.register(createSchedulesPlugin({ now: () => 1700000100000 }), { builtin: true });
    await manager.activateAll();

    const editorContrib = registry.getEditor('schedule')!;
    expect(editorContrib.title({ id: null, mode: 'new' })).toBe('New task');
    expect(editorContrib.title({ id: 'task-1', mode: 'view', title: 'nightly-ci-report' })).toBe('nightly-ci-report');

    const editor = editorContrib.component();
    document.body.appendChild(editor.element);
    const panel = makePanelInitContext('schedule:task-1');
    editor.init({ id: 'task-1', mode: 'view' }, panel.ctx);
    await flushMicrotasks();

    expect(panel.setTitle).toHaveBeenCalledWith('nightly-ci-report');
    expect(editor.element.textContent).toContain('Summarize failing CI jobs.');

    // Clicking a run's Open button jumps to the session topic.
    const runOpenBtn = editor.element.querySelector<HTMLButtonElement>('.tp-run-open')!;
    runOpenBtn.click();
    expect(openTopic).toHaveBeenCalledWith('sess-1');

    // Switch to new task form and submit.
    editor.update?.({ id: null, mode: 'new' });
    await flushMicrotasks();
    const nameInput = editor.element.querySelector<HTMLInputElement>('#tp-name')!;
    const cronInput = editor.element.querySelector<HTMLInputElement>('#tp-cron')!;
    const promptInput = editor.element.querySelector<HTMLTextAreaElement>('#tp-text')!;
    nameInput.value = 'disk-check';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    cronInput.value = '*/30 * * * *';
    cronInput.dispatchEvent(new Event('input', { bubbles: true }));
    promptInput.value = 'Check disk usage.';
    promptInput.dispatchEvent(new Event('input', { bubbles: true }));

    const form = editor.element.querySelector<HTMLFormElement>('#tp-form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(postJson).toHaveBeenCalledWith(
      '/api/schedules/add',
      expect.objectContaining({
        task: expect.objectContaining({
          name: 'disk-check',
          cron: '*/30 * * * *',
          prompt: 'Check disk usage.',
        }),
      }),
    );

    // Locale change re-renders editor labels cleanly.
    setLocale('zh-CN');
    events.emit('locale.change', { locale: 'zh-CN' });
    expect(editor.element.querySelector('[data-tp-act="edit"]')?.textContent).toContain('编辑');

    editor.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('computes activity badge dot when a scheduled session is awaiting user or a task is running', async () => {
    const { registry, events, manager, topicsData } = makeHarness();
    manager.register(createSchedulesPlugin(), { builtin: true });
    await manager.activateAll();

    expect(registry.getActivityBadge('schedules')).toBeNull();
    topicsData.push({ id: 'sess-ask', title: 'Needs reply', lastAt: 1700000000000, scheduled: true, asking: true });
    expect(registry.getActivityBadge('schedules')).toBe('dot');

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('generates cron expressions from daily, weekly, and interval quick presets', async () => {
    const { registry, events, manager } = makeHarness();
    manager.register(createSchedulesPlugin(), { builtin: true });
    await manager.activateAll();

    const editorEntry = registry.getEditor('schedule')!;
    const editor = editorEntry.component();
    document.body.appendChild(editor.element);
    editor.init({ id: null, mode: 'new' }, makePanelInitContext('schedule:new').ctx);
    await flushMicrotasks();

    const pickSeg = (val: string): void => {
      const group = editor.element.querySelector<HTMLElement>('[aria-label="Repeats or once"]')!;
      const btn = group.querySelector<HTMLButtonElement>(`[data-seg-value="${val}"]`)!;
      btn.click();
    };
    const cronVal = (): string => editor.element.querySelector<HTMLInputElement>('#tp-cron')!.value;

    pickSeg('daily');
    const timeEl = editor.element.querySelector<HTMLInputElement>('#tp-quick-time')!;
    timeEl.value = '02:30';
    timeEl.dispatchEvent(new Event('input', { bubbles: true }));
    expect(cronVal()).toBe('30 2 * * *');

    pickSeg('weekly');
    const dowEl = editor.element.querySelector<HTMLSelectElement>('#tp-quick-dow')!;
    dowEl.value = '5';
    dowEl.dispatchEvent(new Event('change', { bubbles: true }));
    expect(cronVal()).toBe('30 2 * * 5');

    pickSeg('interval');
    const everyEl = editor.element.querySelector<HTMLInputElement>('#tp-quick-every')!;
    everyEl.value = '15';
    everyEl.dispatchEvent(new Event('input', { bubbles: true }));
    expect(cronVal()).toBe('*/15 * * * *');

    const unitEl = editor.element.querySelector<HTMLSelectElement>('#tp-quick-unit')!;
    unitEl.value = 'h';
    unitEl.dispatchEvent(new Event('change', { bubbles: true }));
    expect(cronVal()).toBe('0 */15 * * *');

    editor.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
