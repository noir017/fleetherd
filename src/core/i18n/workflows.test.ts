import { describe, expect, it } from 'vitest';
import {
  describeLastRun,
  describeRun,
  describeWhen,
  nextSuffix,
  runNoticeText,
  taskCardText,
  taskExpiredText,
  taskListText,
  type ScheduleTask,
} from '../schedule.js';
import {
  voiceButtons,
  voiceCardText,
  voiceFailureText,
  voiceNoSpeechText,
  voiceStaleClickText,
} from '../voice.js';
import { tWorkflows, type WorkflowMessageKey } from './workflows.js';

describe('core/i18n/workflows', () => {
  it('translates workflows keys to English and Simplified Chinese', () => {
    expect(tWorkflows('en', 'schedule.run.fixed')).toBe('fixed session');
    expect(tWorkflows('zh-CN', 'schedule.run.fixed')).toBe('固定会话');

    expect(tWorkflows('en', 'voice.button.send')).toBe('✅ Send');
    expect(tWorkflows('zh-CN', 'voice.button.send')).toBe('✅ 发送');

    expect(tWorkflows('en', 'delegation.confirm.startOne')).toBe('Start it');
    expect(tWorkflows('zh-CN', 'delegation.confirm.startOne')).toBe('启动');

    expect(tWorkflows('en', 'delegation.confirm.startAll', { count: 3 })).toBe('Start all 3');
    expect(tWorkflows('zh-CN', 'delegation.confirm.startAll', { count: 3 })).toBe('全部启动 3');
  });

  it('interpolates parameters correctly for both locales', () => {
    const enNotice = tWorkflows('en', 'schedule.runNotice', {
      id: 'abc',
      name: 'Briefing',
      planned: '08:00',
      body: 'echo hi',
    });
    expect(enNotice).toContain('⏰ Scheduled task `#abc` **Briefing** · 08:00');

    const zhNotice = tWorkflows('zh-CN', 'schedule.runNotice', {
      id: 'abc',
      name: 'Briefing',
      planned: '08:00',
      body: 'echo hi',
    });
    expect(zhNotice).toContain('⏰ 定时任务 `#abc` **Briefing** · 08:00');
  });

  it('renders schedule presentation functions with zh-CN locale', () => {
    const task: ScheduleTask = {
      id: 't1',
      name: 'Morning report',
      state: 'active',
      when: { cron: '0 8 * * *', tz: 'Asia/Shanghai' },
      run: { kind: 'agent', agent: 'cc', prompt: 'give me morning brief', session: 'daily' },
      target: { platform: 'tg', channel: 'c1' },
      createdBy: { conversation: 'conv1', platform: 'tg' },
      createdAt: 1000,
      runs: 2,
    };

    expect(describeWhen(task.when, false, 'zh-CN')).toBe('`0 8 * * *` (Asia/Shanghai)');
    expect(describeWhen({ at: 1727740800000, tz: 'UTC' }, false, 'zh-CN')).toContain('一次性于');
    expect(describeRun(task.run, 'zh-CN')).toBe('cc · 每天一个会话');

    const line = taskListText([task], 1000, 'zh-CN');
    expect(line).toContain('**定时任务**');
    expect(line).toContain('t1');

    const empty = taskListText([], 1000, 'zh-CN');
    expect(empty).toContain('暂无定时任务');

    const card = taskCardText(task, 'registered', 1000, 'zh-CN');
    expect(card).toContain('⏰ 定时任务已注册 — `#t1` **Morning report**');
    expect(card).toContain('• 执行时间：');
    expect(card).toContain('• 运行模式：cc · 每天一个会话');

    const notice = runNoticeText(task, 1000, 'zh-CN');
    expect(notice).toContain('⏰ 定时任务 `#t1` **Morning report**');

    const expired = taskExpiredText(task, 'zh-CN');
    expect(expired).toContain('⌛ 定时任务 `#t1` **Morning report** 已过期');
    expect(expired).toContain('共运行了 2 次');

    expect(describeLastRun({ ...task, lastRun: undefined }, 'zh-CN')).toBe('尚未运行');
    expect(nextSuffix({ ...task, when: { at: 1000, tz: 'UTC' } }, 500, 'zh-CN')).toBe('');
  });

  it('renders voice presentation functions with zh-CN locale', () => {
    const buttons = voiceButtons('req1', true, 'zh-CN');
    expect(buttons).toEqual([
      { id: 'vtx:req1:0', label: '✅ 发送', style: 'success' },
      { id: 'vtx:req1:2', label: '🗣️ 按原样发送', style: 'secondary' },
      { id: 'vtx:req1:1', label: '✖ 取消', style: 'danger' },
    ]);

    const card = voiceCardText(
      {
        text: 'hello world',
        cleaned: 'Hello, world!',
        model: 'gemini-3-flash',
        latencyMs: 1200,
        status: 'pending',
      },
      'zh-CN'
    );
    expect(card).toContain('🎙️ 语音转写 · gemini-3-flash · 1.2s');
    expect(card).toContain('✍️ 整理后：');
    expect(card).toContain('🗣️ 语音原样：');
    expect(card).toContain('是否将整理后的内容发送给 Agent？点击 ✅ 发送');

    expect(voiceFailureText('audio decode error', 'zh-CN')).toBe(
      '🎙️ 无法转写该语音消息：audio decode error。未向 Agent 发送任何内容 — 请直接输入文本或重新发送。'
    );
    expect(voiceNoSpeechText('zh-CN')).toBe('🎙️ 该语音消息中未识别出任何语音。未向 Agent 发送任何内容。');
    expect(voiceStaleClickText('zh-CN')).toContain('该转写已不再处于等待状态');
  });

  it('keeps placeholders identical across en and zh-CN', () => {
    const keys: WorkflowMessageKey[] = [
      'schedule.when.once',
      'schedule.nextSuffix',
      'schedule.card.header',
      'schedule.card.when',
      'schedule.card.runs',
      'schedule.card.until',
      'schedule.card.postsTo',
      'schedule.card.command',
      'schedule.card.tags',
      'schedule.card.state',
      'schedule.line.last',
      'schedule.runNotice',
      'schedule.expired',
      'schedule.bash.timedOut',
      'schedule.bash.attachedNote',
      'schedule.menu.entryLabel',
      'schedule.menu.entryOther',
      'schedule.menu.listOverflow',
      'schedule.menu.taskWhen',
      'schedule.menu.taskRuns',
      'schedule.menu.taskPostsTo',
      'schedule.menu.taskLastRun',
      'schedule.menu.deleteConfirm',
      'schedule.service.failedNotice',
      'schedule.service.missedNotice',
      'voice.card.header',
      'voice.card.notCleaned',
      'voice.card.previewMore',
      'voice.status.expired',
      'voice.status.calledOff',
      'voice.failure',
      'delegation.confirm.startAll',
      'delegation.confirm.ask',
      'delegation.confirm.targetMany',
      'delegation.confirm.review',
      'delegation.confirm.extFooter',
      'delegation.started.head',
      'delegation.started.by',
      'delegation.started.model',
      'delegation.started.reviewedBy',
      'delegation.started.couldNotStart',
      'delegation.started.failedDirect',
      'delegation.stop.by',
      'delegation.stop.withSlash',
      'delegation.stop.held',
      'delegation.limit.exceeded',
      'delegation.report.extra',
      'delegation.notStarted',
    ];

    for (const key of keys) {
      const enTemplate = tWorkflows('en', key);
      const zhTemplate = tWorkflows('zh-CN', key);
      // Chinese does not inflect for grammatical number with plural suffixes like `{s}`
      const enParams = [...enTemplate.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
        .map((m) => m[1])
        .filter((p) => p !== 's')
        .sort();
      const zhParams = [...zhTemplate.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
        .map((m) => m[1])
        .filter((p) => p !== 's')
        .sort();
      expect(zhParams, `key ${key} placeholders mismatch`).toEqual(enParams);
    }
  });
});
