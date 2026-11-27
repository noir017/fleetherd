// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SchedulePanelRun, SchedulePanelTask, SchedulePanelTaskDetail } from '../../../../workbench.js';
import { Emitter } from '../../base/event.js';
import { setLocale } from '../../i18n/index.js';
import type { TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService } from '../../services/storage.js';
import { createSchedulesPlugin } from './plugin.js';
import { countRunsByStatus, filterRunsByStatus, runBadgeTone } from './runs-table.js';
import type { SchedulePanelInitContext } from './types.js';

const SAMPLE_RUNS: readonly SchedulePanelRun[] = [
  {
    at: 1700000000000,
    atText: '2026-11-24 08:00',
    status: 'ok',
    durationMs: 4200,
    topic: 'sess-1',
  },
  {
    at: 1699990000000,
    atText: '2026-11-23 08:00',
    status: 'failed',
    durationMs: 1200,
    exitCode: 1,
    error: 'Timeout waiting for runner',
    topic: 'sess-gone',
  },
  {
    at: 1699980000000,
    atText: '2026-11-22 08:00',
    status: 'skipped',
    where: 'discord:ops',
  },
];

const SAMPLE_TASK: SchedulePanelTask = {
  id: 'task-1',
  name: 'nightly-ci',
  kind: 'agent',
  when: '0 8 * * *',
  next: 'tomorrow 08:00',
  nextAt: 1700086400000,
  run: 'claude',
  target: 'Alpha',
  targetTopic: 'topic-1',
  detail: 'Check CI.',
  runs: 3,
  state: 'active',
  createdAt: 1699900000000,
  running: false,
  tags: ['ci'],
};

function makeDetail(runs: SchedulePanelRun[]): SchedulePanelTaskDetail {
  return {
    task: SAMPLE_TASK,
    fields: {
      name: 'nightly-ci',
      cron: '0 8 * * *',
      tz: 'UTC',
      prompt: 'Check CI.',
      agent: 'claude',
      session: 'new',
      target: 'Alpha',
    },
    runs,
    agents: ['claude'],
    agent: 'claude',
    agentHosts: {},
    hosts: [],
    channels: [],
    tz: 'UTC',
    shapes: { new: ['agent', 'model', 'cwd', 'timeout', 'at'], daily: ['agent'], fixed: ['agent'], bash: ['host'] },
  };
}

function makePanelInitCtx(id: string): SchedulePanelInitContext {
  const onVis = new Emitter<boolean>();
  const onDim = new Emitter<{ readonly width: number; readonly height: number }>();
  return {
    id,
    api: {
      id,
      group: 'main',
      params: undefined,
      onDidVisibilityChange: onVis.event,
      onDidDimensionsChange: onDim.event,
      setTitle: vi.fn(),
      setBadge: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('features/schedules run history table', () => {
  afterEach(() => {
    setLocale('en');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('counts and filters runs by status and maps badge tones', () => {
    expect(countRunsByStatus(SAMPLE_RUNS)).toEqual({
      all: 3,
      ok: 1,
      failed: 1,
      interrupted: 0,
      skipped: 1,
      missed: 0,
    });
    expect(filterRunsByStatus(SAMPLE_RUNS, 'all').length).toBe(3);
    expect(filterRunsByStatus(SAMPLE_RUNS, 'failed').length).toBe(1);
    expect(filterRunsByStatus(SAMPLE_RUNS, 'interrupted').length).toBe(0);
    expect(runBadgeTone('ok')).toBe('ok');
    expect(runBadgeTone('failed')).toBe('err');
    expect(runBadgeTone('interrupted')).toBe('warn');
    expect(runBadgeTone('skipped')).toBe('idle');
  });

  it('renders structured table with status filter, summary, session jump, and empty state', async () => {
    const registry = new ContributionRegistry();
    const events = new WebuiEventBus();
    const storage = new StorageService();
    const openTopic = vi.fn();
    let activeRuns: SchedulePanelRun[] = [...SAMPLE_RUNS];

    const topicsData: TopicInfo[] = [
      { id: 'topic-1', title: 'Alpha', lastAt: 1700000000000 },
      { id: 'sess-1', title: 'Nightly run #1', lastAt: 1700000000000, scheduled: true, task: 'task-1' },
    ];
    const topics: PluginTopicsBridge = {
      list: () => topicsData,
      active: () => topicsData[0],
      open: openTopic,
      insertIntoComposer: vi.fn(),
    };
    const api: ApiClient = {
      get: vi.fn(async () => new Response('{}')),
      post: vi.fn(async () => new Response('{}')),
      getJson: async <T>(path: string): Promise<T> => {
        if (path === '/api/schedules') return { enabled: true, tasks: [SAMPLE_TASK] } as T;
        if (path.startsWith('/api/schedules/task')) return { ok: true, detail: makeDetail(activeRuns) } as T;
        throw new Error(`Unexpected GET ${path}`);
      },
      postJson: async <T>(): Promise<T> => ({ ok: true }) as T,
    };

    const manager = new PluginManager({ registry, events, storage, api, topics });
    manager.register(createSchedulesPlugin({ now: () => 1700000100000 }), { builtin: true });
    await manager.activateAll();

    const editor = registry.getEditor('schedule')!.component();
    document.body.appendChild(editor.element);
    editor.init({ id: 'task-1', mode: 'view' }, makePanelInitCtx('schedule:task-1'));
    await flushMicrotasks();

    // Renders structured table with all 3 runs.
    const table = editor.element.querySelector<HTMLTableElement>('table.fh-runs-table')!;
    expect(table).not.toBeNull();
    expect(table.querySelectorAll('tbody tr.fh-run-row').length).toBe(3);

    // Filter to failed runs only.
    const failedBtn = editor.element.querySelector<HTMLButtonElement>('[data-run-filter="failed"]')!;
    failedBtn.click();
    const failedRows = editor.element.querySelectorAll<HTMLTableRowElement>('tbody tr.fh-run-row');
    expect(failedRows.length).toBe(1);
    expect(failedRows[0]?.textContent).toContain('Timeout waiting for runner');
    expect(failedRows[0]?.querySelector('.fh-run-summary.is-error')).not.toBeNull();

    // Filter back to ok and click session jump button.
    editor.element.querySelector<HTMLButtonElement>('[data-run-filter="ok"]')!.click();
    const jumpBtn = editor.element.querySelector<HTMLButtonElement>('.fh-run-jump')!;
    jumpBtn.click();
    expect(openTopic).toHaveBeenCalledWith('sess-1');

    // Empty runs list renders empty state without table.
    activeRuns = [];
    editor.update?.({ id: 'task-2', mode: 'view' });
    await flushMicrotasks();
    expect(editor.element.querySelector('table.fh-runs-table')).toBeNull();
    expect(editor.element.querySelector('.fh-runs-empty')).not.toBeNull();

    editor.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
