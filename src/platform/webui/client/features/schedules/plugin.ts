import type { SchedulePanelTask } from '../../../../adapter.js';
import { icon } from '../../../icons.js';
import { toDisposable } from '../../base/lifecycle.js';
import { type MenuEntry, openConfirmDialog } from '../../components/index.js';
import { onLocaleChange, t as tr } from '../../i18n/index.js';
import {
  definePlugin,
  type MenuItem,
  type PluginContext,
  type WebuiPlugin,
} from '../../plugins/api.js';
import { createScheduleEditorComponent, type ScheduleEditorController } from './editor.js';
import { scheduledSessions } from './helpers.js';
import { SchedulesStore } from './store.js';
import type { ScheduleEditorInput, SchedulesPluginDeps } from './types.js';
import { createSchedulesViewComponent, type SchedulesViewController } from './view.js';

const SCHEDULES_EN_STRINGS: Record<string, string> = {
  'wb.sched.activityTitle': 'Tasks',
  'wb.sched.runsAll': 'All',
  'wb.sched.colTime': 'Time',
  'wb.sched.colStatus': 'Status',
  'wb.sched.colDuration': 'Duration',
  'wb.sched.colSummary': 'Summary',
  'wb.sched.colSession': 'Session',
  'wb.sched.noMatchingRuns': 'No runs match this status.',
  'wb.sched.showAllRuns': 'Show all',
  'wb.sched.summaryOk': 'Completed',
  'wb.sched.searchSessions': 'Search sessions',
  'wb.sched.editPrefix': 'Edit · {name}',
  'wb.sched.what': 'What it runs',
  'wb.sched.who': 'Who runs it',
  'wb.sched.recentRuns': 'Recent runs',
  'wb.sched.addTagPlaceholder': '+ tag, Enter to add',
  'wb.sched.quickDaily': 'Daily',
  'wb.sched.quickWeekly': 'Weekly',
  'wb.sched.quickInterval': 'Interval',
  'wb.sched.quickCron': 'Cron',
  'wb.sched.quickEvery': 'Every',
  'wb.sched.quickUnitMin': 'min',
  'wb.sched.quickUnitHour': 'hr',
  'wb.sched.dow0': 'Sun',
  'wb.sched.dow1': 'Mon',
  'wb.sched.dow2': 'Tue',
  'wb.sched.dow3': 'Wed',
  'wb.sched.dow4': 'Thu',
  'wb.sched.dow5': 'Fri',
  'wb.sched.dow6': 'Sat',
};

const SCHEDULES_ZH_STRINGS: Record<string, string> = {
  'wb.sched.activityTitle': '定时',
  'wb.sched.runsAll': '全部',
  'wb.sched.colTime': '时间',
  'wb.sched.colStatus': '状态',
  'wb.sched.colDuration': '耗时',
  'wb.sched.colSummary': '结果 / 摘要',
  'wb.sched.colSession': '会话',
  'wb.sched.noMatchingRuns': '当前状态下没有运行记录。',
  'wb.sched.showAllRuns': '查看全部',
  'wb.sched.summaryOk': '正常完成',
  'wb.sched.searchSessions': '搜索会话',
  'wb.sched.editPrefix': '编辑 · {name}',
  'wb.sched.what': '做什么',
  'wb.sched.who': '谁来跑',
  'wb.sched.recentRuns': '最近运行',
  'wb.sched.addTagPlaceholder': '+ 标签，回车添加',
  'wb.sched.quickDaily': '每天',
  'wb.sched.quickWeekly': '每周',
  'wb.sched.quickInterval': '间隔',
  'wb.sched.quickCron': 'cron',
  'wb.sched.quickEvery': '每',
  'wb.sched.quickUnitMin': '分钟',
  'wb.sched.quickUnitHour': '小时',
  'wb.sched.dow0': '周日',
  'wb.sched.dow1': '周一',
  'wb.sched.dow2': '周二',
  'wb.sched.dow3': '周三',
  'wb.sched.dow4': '周四',
  'wb.sched.dow5': '周五',
  'wb.sched.dow6': '周六',
};

function isScheduleTask(value: unknown): value is SchedulePanelTask {
  return Boolean(value && typeof value === 'object' && typeof (value as SchedulePanelTask).id === 'string');
}

function buildFallbackMenuEntries(items: readonly MenuItem[], target: unknown): MenuEntry[] {
  const entries: MenuEntry[] = [];
  let prevGroup: string | undefined;
  for (const item of items) {
    if (item.when && !item.when(target)) continue;
    const group = item.group ?? 'default';
    if (prevGroup !== undefined && group !== prevGroup) {
      entries.push({ kind: 'separator' });
    }
    prevGroup = group;
    const rawDisabled = item.disabled ? item.disabled(target) : false;
    const disabled = Boolean(rawDisabled);
    const title = typeof rawDisabled === 'string' ? rawDisabled : item.title;
    entries.push({
      id: item.id,
      label: item.label,
      icon: item.icon,
      title,
      danger: item.danger,
      disabled,
      onSelect: () => {
        void item.run(target);
      },
    });
  }
  return entries;
}

function buildTaskRowMenuItems(
  ctx: PluginContext,
  store: SchedulesStore,
  deps: SchedulesPluginDeps,
): MenuItem[] {
  const doc = deps.doc ?? document;
  return [
    {
      id: 'schedules.run',
      label: tr('sched.runNow'),
      icon: icon('play'),
      title: tr('sched.runNowTitle'),
      group: 'action',
      order: 10,
      when: (target) => isScheduleTask(target) && (target.state === 'active' || target.state === 'paused'),
      disabled: (target) => (isScheduleTask(target) && target.running ? tr('sched.runNowBusyTitle') : false),
      run: (target) => {
        if (isScheduleTask(target)) void store.runOp(target.id, 'run');
      },
    },
    {
      id: 'schedules.pause',
      label: tr('sched.pause'),
      icon: icon('pause'),
      title: tr('sched.pauseTitle'),
      group: 'action',
      order: 20,
      when: (target) => isScheduleTask(target) && target.state === 'active',
      run: (target) => {
        if (isScheduleTask(target)) void store.runOp(target.id, 'pause');
      },
    },
    {
      id: 'schedules.resume',
      label: tr('sched.resume'),
      icon: icon('play'),
      title: tr('sched.resumeTitle'),
      group: 'action',
      order: 25,
      when: (target) => isScheduleTask(target) && target.state === 'paused',
      run: (target) => {
        if (isScheduleTask(target)) void store.runOp(target.id, 'resume');
      },
    },
    {
      id: 'schedules.edit',
      label: tr('common.edit'),
      icon: icon('pencil'),
      title: tr('sched.editTitle'),
      group: 'action',
      order: 30,
      when: (target) => isScheduleTask(target) && (target.state === 'active' || target.state === 'paused'),
      disabled: (target) => (isScheduleTask(target) && target.running ? tr('sched.editBusyTitle') : false),
      run: (target) => {
        if (isScheduleTask(target)) {
          ctx.editors.open('schedule', { id: target.id, mode: 'edit', title: target.name }, { id: `schedule:${target.id}` });
        }
      },
    },
    {
      id: 'schedules.delete',
      label: tr('common.delete'),
      icon: icon('trash'),
      group: 'danger',
      order: 40,
      danger: true,
      when: (target) => isScheduleTask(target),
      run: async (target) => {
        if (!isScheduleTask(target)) return;
        const confirmed = await openConfirmDialog({
          title: tr('common.delete'),
          body: tr('sched.confirmDeleteTask', { name: target.name || target.id }),
          confirmLabel: tr('common.delete'),
          danger: true,
          overlays: deps.overlays,
          doc,
        });
        if (confirmed) await store.runOp(target.id, 'remove');
      },
    },
  ];
}

export function createSchedulesPlugin(deps: SchedulesPluginDeps = {}): WebuiPlugin {
  let activeStore: SchedulesStore | null = null;
  const views = new Set<SchedulesViewController>();
  const editors = new Set<ScheduleEditorController>();

  return definePlugin({
    id: 'schedules',
    activate(ctx) {
      ctx.i18n.add('en', SCHEDULES_EN_STRINGS);
      ctx.i18n.add('zh-CN', SCHEDULES_ZH_STRINGS);
      const store = new SchedulesStore(ctx, deps);
      activeStore = store;
      ctx.subscriptions.add(store);

      const menuItems = buildTaskRowMenuItems(ctx, store, deps);
      for (const item of menuItems) {
        ctx.menus.register('task.row', item);
      }

      const resolveTaskMenu = (task: SchedulePanelTask): readonly MenuEntry[] => {
        if (deps.resolveMenuEntries) return deps.resolveMenuEntries('task.row', task);
        return buildFallbackMenuEntries(menuItems, task);
      };

      ctx.activity.register({
        id: 'schedules',
        title: ctx.i18n.t('wb.sched.activityTitle'),
        icon: 'clock',
        view: 'schedules',
        order: 20,
        badge: () => {
          const sessions = scheduledSessions(ctx.topics.list());
          const waiting = sessions.some((t) => t.asking || t.stage === 'answer');
          return waiting || store.hasRunningTask() ? 'dot' : null;
        },
      });

      ctx.views.register({
        id: 'schedules',
        title: tr('sideTasks.tabScheduled'),
        icon: 'clock',
        part: 'sidebar',
        component: () => {
          const view = createSchedulesViewComponent(ctx, store, deps, resolveTaskMenu);
          views.add(view);
          const origDispose = view.dispose.bind(view);
          view.dispose = () => {
            views.delete(view);
            origDispose();
          };
          return view;
        },
      });

      ctx.editors.register({
        kind: 'schedule',
        title: (input) => {
          const rec = input && typeof input === 'object' ? (input as ScheduleEditorInput) : undefined;
          if (rec?.mode === 'new' || (!rec?.id && rec?.mode !== 'edit')) {
            return tr('taskPage.newTitle');
          }
          if (rec?.title) return rec.title;
          return store.getTask(rec?.id)?.name || tr('taskPage.title');
        },
        component: () => {
          const editor = createScheduleEditorComponent(ctx, store, deps);
          editors.add(editor);
          const origDispose = editor.dispose.bind(editor);
          editor.dispose = () => {
            editors.delete(editor);
            origDispose();
          };
          return editor;
        },
      });

      ctx.commands.register(
        'schedules.new',
        () => {
          ctx.editors.open('schedule', { id: null, mode: 'new' });
        },
        { title: tr('sideTasks.newTask') },
      );

      ctx.commands.register(
        'schedules.refresh',
        async () => {
          await store.loadTasks();
        },
        { title: tr('common.refresh') },
      );

      const handleLocaleChange = (): void => {
        for (const v of views) v.refreshLocale();
        for (const e of editors) e.refreshLocale();
      };

      ctx.events.on('locale.change', handleLocaleChange);
      ctx.subscriptions.add(toDisposable(onLocaleChange(handleLocaleChange)));

      ctx.events.on('topic.list', () => {
        for (const v of views) v.refreshTopics();
        for (const e of editors) e.refreshTopics();
        deps.onBadgeChange?.();
      });

      ctx.events.on('stream.state', ({ state }) => {
        if (state === 'open') void store.loadTasks();
      });
    },
    deactivate() {
      views.clear();
      editors.clear();
      activeStore?.dispose();
      activeStore = null;
    },
  });
}
