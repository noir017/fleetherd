import { describe, expect, it } from 'vitest';
import {
  buildScheduleDeleteConfirm,
  buildScheduleListMenu,
  buildScheduleTaskMenu,
  parseScheduleButtonId,
  scheduleEntryLabel,
  scheduleMenuExpiredText,
  scheduleOpenButtonId,
} from './schedule-menu.js';
import type { ScheduleTask } from './schedule.js';

describe('core/schedule-menu', () => {
  const sampleTask: ScheduleTask = {
    id: '123',
    name: 'Backup logs',
    state: 'active',
    when: { cron: '0 2 * * *', tz: 'UTC' },
    run: { kind: 'bash', command: 'tar -czf backup.tgz logs/', timeoutMs: 60000 },
    target: { platform: 'tg', channel: 'ops' },
    createdBy: { conversation: 'c1', platform: 'tg' },
    createdAt: 1000,
    runs: 5,
  };

  it('formats scheduleEntryLabel in English and Chinese', () => {
    expect(scheduleEntryLabel([sampleTask], 'en')).toContain('1 active');
    expect(scheduleEntryLabel([sampleTask], 'zh-CN')).toContain('1 个活跃');

    const twoTasks: ScheduleTask[] = [
      sampleTask,
      { ...sampleTask, id: '124', state: 'paused' },
    ];
    expect(scheduleEntryLabel(twoTasks, 'en')).toContain('1 active, 1 other');
    expect(scheduleEntryLabel(twoTasks, 'zh-CN')).toContain('1 个活跃，1 个其他');
  });

  it('builds schedule list menu for en and zh-CN', () => {
    const listEn = buildScheduleListMenu('req1', [sampleTask], 2000, 'en');
    expect(listEn.buttons).toHaveLength(2);
    expect(listEn.buttons[1]?.label).toBe('◀ Settings');
    expect(listEn.text).toContain('Tap one to pause, resume or delete it.');

    const listZh = buildScheduleListMenu('req1', [sampleTask], 2000, 'zh-CN');
    expect(listZh.buttons).toHaveLength(2);
    expect(listZh.buttons[1]?.label).toBe('◀ 设置');
    expect(listZh.text).toContain('点击任务可暂停、恢复或删除。');
  });

  it('builds schedule task menu for active and paused states', () => {
    const menuEn = buildScheduleTaskMenu('req2', sampleTask, 2000, 'en');
    expect(menuEn.buttons.map((b) => b.label)).toEqual(['⏸ Pause', '🗑 Delete', '◀ Back']);
    expect(menuEn.text).toContain('• When:');
    expect(menuEn.text).toContain('• Command:');

    const menuZh = buildScheduleTaskMenu('req2', sampleTask, 2000, 'zh-CN');
    expect(menuZh.buttons.map((b) => b.label)).toEqual(['⏸ 暂停', '🗑 删除', '◀ 返回']);
    expect(menuZh.text).toContain('• 执行时间：');
    expect(menuZh.text).toContain('• 命令：');

    const pausedTask: ScheduleTask = { ...sampleTask, state: 'paused' };
    const pausedZh = buildScheduleTaskMenu('req2', pausedTask, 2000, 'zh-CN');
    expect(pausedZh.buttons.map((b) => b.label)).toEqual(['▶ 恢复', '🗑 删除', '◀ 返回']);
  });

  it('builds schedule delete confirmation in en and zh-CN', () => {
    const delEn = buildScheduleDeleteConfirm('req3', sampleTask, 'en');
    expect(delEn.text).toContain('Delete `#123` **Backup logs**?');
    expect(delEn.buttons.map((b) => b.label)).toEqual(['🗑 Yes, delete it', 'Cancel']);

    const delZh = buildScheduleDeleteConfirm('req3', sampleTask, 'zh-CN');
    expect(delZh.text).toContain('确定删除 `#123` **Backup logs**？');
    expect(delZh.buttons.map((b) => b.label)).toEqual(['🗑 是的，删除它', '取消']);
  });

  it('formats expired menu text', () => {
    expect(scheduleMenuExpiredText('en')).toContain('This menu has expired');
    expect(scheduleMenuExpiredText('zh-CN')).toContain('此菜单已过期');
  });

  it('parses button ids', () => {
    expect(scheduleOpenButtonId('req1')).toBe('sco:req1:0');
    expect(parseScheduleButtonId('sco:req1:0')).toEqual({ kind: 'open', reqId: 'req1' });
    expect(parseScheduleButtonId('sct:req1:2')).toEqual({ kind: 'task', reqId: 'req1', index: 2 });
    expect(parseScheduleButtonId('sca:req1:0')).toEqual({ kind: 'action', reqId: 'req1', action: 'pause' });
    expect(parseScheduleButtonId('invalid')).toBeNull();
  });
});
