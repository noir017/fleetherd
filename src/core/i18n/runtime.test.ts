import { describe, expect, it } from 'vitest';
import {
  RUNTIME_DICTS,
  tRuntime,
  type RuntimeMessageKey,
} from './runtime.js';
import { afterStopMark } from '../tool-renderer.js';
import { busyNote, formatUsageSnapshot } from '../busy-snapshot.js';
import { retryButtons } from '../turn-retry.js';
import { describeFailureReason, undeliveredLine } from '../topic-stage.js';
import { stopInputNote } from '../inbound-merger.js';
import { asideFooter, asideHeader, followUpMarker } from '../../daemon/turn-runner.js';
import { withInputNote } from '../../daemon/conversation-turns.js';
import type { InboundMessage, TurnFailureReason } from '../../types.js';

function makeInbound(content: string, attachments?: Array<{ url: string; type?: 'file' | 'image' | 'audio' }>): InboundMessage {
  return {
    conversation: { platform: 'webui', channel: 'c1', user: 'u1', kind: 'direct' },
    messageId: 'm1',
    content,
    timestamp: Date.now(),
    ...(attachments ? { attachments: attachments.map((a) => ({ type: a.type ?? 'file', url: a.url })) } : {}),
  };
}

describe('core/i18n/runtime', () => {
  it('en and zh-CN dictionaries have identical and non-empty keys', () => {
    const enKeys = Object.keys(RUNTIME_DICTS.en).sort();
    const zhKeys = Object.keys(RUNTIME_DICTS['zh-CN']).sort();

    expect(enKeys).toEqual(zhKeys);
    expect(enKeys.length).toBeGreaterThan(0);

    for (const key of enKeys as RuntimeMessageKey[]) {
      const enVal = RUNTIME_DICTS.en[key];
      const zhVal = RUNTIME_DICTS['zh-CN'][key];
      expect(typeof enVal).toBe('string');
      expect(enVal.length).toBeGreaterThan(0);
      expect(typeof zhVal).toBe('string');
      expect(zhVal.length).toBeGreaterThan(0);

      // Verify that interpolation placeholder names match between en and zh-CN
      const enParams = [...enVal.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
      const zhParams = [...zhVal.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
      expect(zhParams).toEqual(enParams);
    }
  });

  it('translates messages with fallback and interpolation', () => {
    expect(tRuntime('en', 'retryReconnect')).toBe('Reconnect');
    expect(tRuntime('zh-CN', 'retryReconnect')).toBe('重连');
    expect(tRuntime(undefined, 'retryReconnect')).toBe('Reconnect');

    expect(tRuntime('en', 'reconnectingTo', { bound: 'cc' })).toBe('↻ Reconnecting to cc…');
    expect(tRuntime('zh-CN', 'reconnectingTo', { bound: 'cc' })).toBe('↻ 正在重连到 cc…');
  });

  describe('tool-renderer afterStopMark', () => {
    it('returns English marker by default and zh-CN marker when requested', () => {
      expect(afterStopMark()).toBe(' · still running after /stop');
      expect(afterStopMark('en')).toBe(' · still running after /stop');
      expect(afterStopMark('zh-CN')).toBe(' · /stop 后仍在运行');
    });
  });

  describe('busy-snapshot', () => {
    const baseInput = {
      agent: 'cc',
      usage: { used: 1000, size: 200_000 },
      cost: { amount: 1.5, currency: 'USD' },
      runningForMs: 42_000,
    };

    it('formats snapshot in English by default', () => {
      const out = formatUsageSnapshot(baseInput);
      expect(out).toContain('**Usage** — gateway snapshot of cc');
      expect(out).toContain('Cost: $1.50 this session, as of the last finished turn');
      expect(out).toContain('This turn: running 42s');
    });

    it('formats snapshot in zh-CN when requested', () => {
      const out = formatUsageSnapshot(baseInput, 'zh-CN');
      expect(out).toContain('**资源占用** — cc 的网关快照');
      expect(out).toContain('费用：本会话截至上一轮已产生 $1.50');
      expect(out).toContain('本轮：已运行 42s');
    });

    it('formats busy note in en and zh-CN', () => {
      expect(busyNote('usage', 'cc', 'en')).toContain('cc is busy with a turn');
      expect(busyNote('usage', 'cc', 'zh-CN')).toContain('cc 正在忙于处理本轮');
    });
  });

  describe('turn-retry retryButtons', () => {
    it('returns English buttons by default', () => {
      const btns = retryButtons('r1', { anotherAgent: true, reconnect: true });
      expect(btns.map((b) => b.label)).toEqual(['Reconnect', 'Resend', 'Retry with another agent']);

      const standardBtns = retryButtons('r1', { anotherAgent: true });
      expect(standardBtns.map((b) => b.label)).toEqual(['Retry', 'Retry with another agent']);
    });

    it('returns zh-CN buttons when requested', () => {
      const btns = retryButtons('r1', { anotherAgent: true, reconnect: true, locale: 'zh-CN' });
      expect(btns.map((b) => b.label)).toEqual(['重连', '重发', '换个 agent 重试']);

      const standardBtns = retryButtons('r1', { anotherAgent: true, locale: 'zh-CN' });
      expect(standardBtns.map((b) => b.label)).toEqual(['重试', '换个 agent 重试']);
    });
  });

  describe('topic-stage failure reasons and undelivered line', () => {
    const allReasons: TurnFailureReason[] = [
      'service',
      'limit',
      'connection',
      'access',
      'request',
      'provider',
      'hung',
      'startup',
      'preLaunch',
      'restart',
      'other',
    ];

    it('formats all failure reasons in en and zh-CN', () => {
      for (const reason of allReasons) {
        const enText = describeFailureReason(reason, 'en');
        const zhText = describeFailureReason(reason, 'zh-CN');
        expect(enText).toBeTruthy();
        expect(zhText).toBeTruthy();
        expect(enText).not.toBe(zhText);
      }
    });

    it('formats undelivered line in en and zh-CN', () => {
      expect(undeliveredLine(1, 'en')).toBe('The agent did not receive this — it will be sent along with the next message.');
      expect(undeliveredLine(0, 'en')).toBe('The agent did not receive this.');
      expect(undeliveredLine(1, 'zh-CN')).toBe('Agent 未收到此消息 — 将在下一条消息发送时一同带上。');
      expect(undeliveredLine(0, 'zh-CN')).toBe('Agent 未收到此消息。');
    });
  });

  describe('inbound-merger stopInputNote and withInputNote', () => {
    it('formats single and multiple dropped/kept messages in en and zh-CN', () => {
      const keptMsg = makeInbound('hello', [{ url: 'file.txt' }]);
      const droppedMsg1 = makeInbound('test 1');
      const droppedMsg2 = makeInbound('test 2');

      const enNote = stopInputNote([keptMsg], [droppedMsg1, droppedMsg2], 'en');
      expect(enNote).toContain('Dropped these 2 messages — the agent never saw them:');
      expect(enNote).toContain('Kept this message for your next one — the agent has not seen it yet');
      expect(enNote).toContain('[1 attachment]');

      const zhNote = stopInputNote([keptMsg], [droppedMsg1, droppedMsg2], 'zh-CN');
      expect(zhNote).toContain('已丢弃这 2 条消息 — Agent 未曾处理过它们：');
      expect(zhNote).toContain('已保留此消息并在下一条发出 — Agent 尚未处理它');
      expect(zhNote).toContain('[1 个附件]');

      const withNoteZh = withInputNote('⏹ 已停止', [keptMsg], [], 'zh-CN');
      expect(withNoteZh).toContain('⏹ 已停止\n已保留此消息并在下一条发出');
    });
  });

  describe('daemon turn-runner messages', () => {
    it('formats follow-up marker and asides in en and zh-CN', () => {
      expect(followUpMarker('en')).toBe('⏱ background update — picking up where the last reply left off');
      expect(followUpMarker('zh-CN')).toBe('⏱ 后台更新 — 接着上一条回复继续');

      expect(asideHeader('what time is it?')).toBe('↪ btw: what time is it?');
      expect(asideHeader('what time is it?', 'zh-CN')).toBe('↪ btw: what time is it?');

      expect(asideFooter(1, 'cached', 'en')).toBe('side question — not kept in this conversation · 1 tool call · cached');
      expect(asideFooter(2, undefined, 'zh-CN')).toBe('旁白提问 — 不计入当前对话历史 · 2 次工具调用');
    });
  });
});
