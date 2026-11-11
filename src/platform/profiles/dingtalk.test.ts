import { describe, it, expect, vi } from 'vitest';
import type { Bot, Session } from '@satorijs/core';
import { createDingtalkProfile, deriveNotificationTitle } from './dingtalk.js';

// ── Delivery-contract tests ───────────────────────────────────────────────────
// DingTalk's adapter encoder escapes markdown-active characters, so the profile
// bypasses it and calls internal.batchSendOTO (DM) / orgGroupSend (group, 'cid'
// prefix) directly with msgKey 'sampleMarkdown'. These tests capture exactly what
// hits those internal routes: route selection, msgParam shape (title + converted
// markdown), and the missing-processQueryKey error contract.

const MD = '# Result\n\n**bold** line\n\n| Name | Score |\n|------|-------|\n| Ada | 95 |';

function fakeBot(result: { processQueryKey?: string } = { processQueryKey: 'pqk-1' }): {
  bot: Bot;
  batchSendOTO: ReturnType<typeof vi.fn>;
  orgGroupSend: ReturnType<typeof vi.fn>;
} {
  const batchSendOTO = vi.fn(() => Promise.resolve(result));
  const orgGroupSend = vi.fn(() => Promise.resolve(result));
  const bot = {
    selfId: 'appkey-1',
    internal: { batchSendOTO, orgGroupSend },
  } as unknown as Bot;
  return { bot, batchSendOTO, orgGroupSend };
}

describe('dingtalk profile capabilities', () => {
  const profile = createDingtalkProfile();

  it('declares the honest degraded set (markdown send + recall only)', () => {
    expect(profile.capabilities).toMatchObject({
      editMessage: false,
      reaction: false,
      typing: false,
      reply: false,
      thread: false,
      buttons: false,
      slashCommands: false,
    });
    expect(typeof profile.sendMessage).toBe('function');
  });

  it('measureRendered counts the converted string (block regrouping expands \\n to \\n\\n)', () => {
    expect(profile.measureRendered!('a\nb')).toBe('a\n\nb'.length);
  });
});

describe('dingtalk profile inbound normalization', () => {
  const profile = createDingtalkProfile();

  it('treats any group message as a mention (DingTalk only delivers group messages when @-ed)', () => {
    expect(profile.detectMention({ isDirect: false } as Session, 'self')).toBe(true);
    expect(profile.detectMention({ isDirect: true } as Session, 'self')).toBe(false);
  });

  it('resolveConversation mirrors session.isDirect and reports no thread lane', () => {
    expect(profile.resolveConversation({ isDirect: true, channelId: 'u1' } as Session)).toEqual({
      channel: 'u1',
      kind: 'direct',
    });
    expect(profile.resolveConversation({ channelId: 'cid7' } as Session)).toEqual({
      channel: 'cid7',
      kind: 'group',
    });
  });
});

describe('dingtalk profile delivery contract (encoder bypass)', () => {
  const profile = createDingtalkProfile();

  it('DM channel → batchSendOTO with sampleMarkdown, converted text, robotCode=selfId', async () => {
    const { bot, batchSendOTO, orgGroupSend } = fakeBot();
    const ref = await profile.sendMessage!(bot, { channel: 'staff123' }, MD);

    expect(orgGroupSend).not.toHaveBeenCalled();
    expect(batchSendOTO).toHaveBeenCalledTimes(1);
    const arg = batchSendOTO.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.msgKey).toBe('sampleMarkdown');
    expect(arg.robotCode).toBe('appkey-1');
    expect(arg.userIds).toEqual(['staff123']);
    const param = JSON.parse(arg.msgParam as string) as { title: string; text: string };
    expect(param.title).toBe('Result'); // first line, flattened (no '#')
    expect(param.text).toContain('# Result'); // headings are in DingTalk's subset
    expect(param.text).not.toContain('|'); // table degraded to bullets
    expect(param.text).toContain('• Score: 95');
    expect(ref).toEqual({ address: { channel: 'staff123' }, messageId: 'pqk-1' });
  });

  it("group channel ('cid' prefix) → orgGroupSend with openConversationId", async () => {
    const { bot, batchSendOTO, orgGroupSend } = fakeBot();
    const ref = await profile.sendMessage!(bot, { channel: 'cidABC==' }, 'hello');

    expect(batchSendOTO).not.toHaveBeenCalled();
    expect(orgGroupSend).toHaveBeenCalledTimes(1);
    const arg = orgGroupSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.openConversationId).toBe('cidABC==');
    expect(arg.userIds).toBeUndefined();
    expect(ref.messageId).toBe('pqk-1');
  });

  it('missing processQueryKey → throws the shared "did not return a message id" contract', async () => {
    const { bot } = fakeBot({});
    await expect(profile.sendMessage!(bot, { channel: 'staff123' }, 'x')).rejects.toThrow(
      'did not return a message id'
    );
  });
});

describe('deriveNotificationTitle', () => {
  it('uses the first non-empty line, flattened and truncated', () => {
    expect(deriveNotificationTitle('\n\n# **Big** news\nrest')).toBe('Big news');
    expect(deriveNotificationTitle('x'.repeat(100))).toHaveLength(32);
  });

  it('falls back to a static name for empty input', () => {
    expect(deriveNotificationTitle('')).toBe('fleetherd');
  });
});
