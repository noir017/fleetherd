import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { InboundMessage, MessageRef } from '../types.js';

interface RecordedOp {
  op: 'send' | 'edit';
  messageId: string;
  kind?: string;
  text: string;
}

function inbound(content: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId: 'in-1',
    content,
    timestamp: 0,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function rig(
  runTurn: (h: AgentStreamHandlers) => Promise<void>,
  opts: {
    stream?: boolean;
    onPermissionRequest?: (
      platform: PlatformAdapter,
      address: { channel: string }
    ) => Promise<{ kind: 'selected'; optionId: string }>;
  } = {}
) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: false } },
  });
  const cfg: Config = {
    ...parsed,
    inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 },
    stream: { ...parsed.stream, enabled: opts.stream ?? false, charThreshold: 1, flushIntervalMs: 1 },
    tools: { ...parsed.tools, mode: 'all', grouping: 'accumulate' },
  };
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  const ops: RecordedOp[] = [];
  const messages: Array<{ messageId: string; kind?: string; text: string }> = [];
  const byId = new Map<string, { messageId: string; kind?: string; text: string }>();
  let seq = 0;

  const platform = {
    capabilities: { thread: false, editMessage: true, maxMessageLength: 2000 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: { channel: string }, text: string, sendOpts?: { kind?: string }): Promise<MessageRef> => {
      const messageId = `m${++seq}`;
      const entry = { messageId, kind: sendOpts?.kind, text };
      messages.push(entry);
      byId.set(messageId, entry);
      ops.push({ op: 'send', messageId, kind: sendOpts?.kind, text });
      return { address, messageId };
    },
    editMessage: async (ref: MessageRef, text: string): Promise<void> => {
      const entry = byId.get(ref.messageId);
      if (entry) entry.text = text;
      ops.push({ op: 'edit', messageId: ref.messageId, text });
    },
    addReaction: async () => {},
    removeReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  const factory: AgentFactory = {
    getOrCreate(conversationId): AgentSession {
      return {
        conversationId,
        runTurn: async (_input, h) => runTurn(h),
        abort: () => {},
        setFollowUpSink: () => {},
        dispose: () => {},
      };
    },
    peek: () => undefined,
    dispose: () => {},
  };

  const reg = new ConversationRegistry(
    cfg,
    new Map([['discord', platform]]),
    factory,
    clock,
    opts.onPermissionRequest
      ? {
          onPermissionRequest: async (_convId, p, addr) => opts.onPermissionRequest!(p, addr),
        }
      : undefined
  );
  return { reg, ops, messages };
}

describe('mid-turn notices and interactive cards preserve chronological message order', () => {
  it('places post-reconnect tool progress and reply below disconnect/reconnect notices', async () => {
    const h = rig(async (t) => {
      t.onToolStart({ name: 'Read', inputPreview: 'src/a.ts', index: 0, id: 't1' });
      await sleep(20);
      t.onToolFinish({ name: 'Read', index: 0, id: 't1', ok: true, durationMs: 100 });
      t.onToolStart({ name: 'Bash', inputPreview: 'long-cmd', index: 1, id: 't2' });
      await sleep(20);

      t.onNotice?.('⚠️ Remote host disconnected, reconnecting…');
      t.onNotice?.('✅ Remote host reconnected');
      await sleep(20);

      t.onToolFinish({ name: 'Bash', index: 1, id: 't2', ok: true, durationMs: 2500 });
      t.onToolStart({ name: 'Edit', inputPreview: 'src/b.ts', index: 2, id: 't3' });
      await sleep(20);
      t.onToolFinish({ name: 'Edit', index: 2, id: 't3', ok: true, durationMs: 300 });
      t.onSegmentBreak();
      t.onText('All done.');
    });

    h.reg.route(inbound('run checks'));
    await sleep(250);

    expect(h.messages).toHaveLength(5);
    const [oldTools, disconnectNotice, reconnectNotice, newTools, reply] = h.messages;
    expect(oldTools!.kind).toBe('tools');
    expect(oldTools!.text).toContain('Read: "src/a.ts" ✓ 100ms');
    expect(oldTools!.text).toContain('Bash: "long-cmd"');
    expect(disconnectNotice!.text).toBe('⚠️ Remote host disconnected, reconnecting…');
    expect(reconnectNotice!.text).toBe('✅ Remote host reconnected');
    expect(newTools!.kind).toBe('tools');
    expect(newTools!.text).toContain('Bash: "long-cmd" ✓ 2.5s');
    expect(newTools!.text).toContain('Edit: "src/b.ts" ✓ 300ms');
    expect(newTools!.text).not.toContain('Read');
    expect(reply!.text).toBe('All done.');

    const firstNoticeOpIdx = h.ops.findIndex(
      (o) => o.op === 'send' && o.messageId === disconnectNotice!.messageId
    );
    expect(firstNoticeOpIdx).toBeGreaterThan(0);
    const editsToOldToolsAfterNotice = h.ops
      .slice(firstNoticeOpIdx + 1)
      .filter((o) => o.op === 'edit' && o.messageId === oldTools!.messageId);
    expect(editsToOldToolsAfterNotice).toEqual([]);
  });

  it('starts a new streaming text bubble below a mid-turn notice', async () => {
    const h = rig(
      async (t) => {
        t.onText('Before notice.');
        await sleep(30);
        t.onNotice?.('⚠️ Reconnecting…');
        await sleep(20);
        t.onText('After notice.');
      },
      { stream: true }
    );

    h.reg.route(inbound('stream test'));
    await sleep(200);

    expect(h.messages.map((m) => m.text)).toEqual([
      'Before notice.',
      '⚠️ Reconnecting…',
      'After notice.',
    ]);

    const noticeId = h.messages[1]!.messageId;
    const beforeId = h.messages[0]!.messageId;
    const noticeIdx = h.ops.findIndex((o) => o.op === 'send' && o.messageId === noticeId);
    const editsToBeforeAfterNotice = h.ops
      .slice(noticeIdx + 1)
      .filter((o) => o.op === 'edit' && o.messageId === beforeId);
    expect(editsToBeforeAfterNotice).toEqual([]);
  });

  it('places post-permission tool updates and reply below the permission card', async () => {
    const h = rig(
      async (t) => {
        t.onToolStart({ name: 'Bash', inputPreview: 'deploy', index: 0, id: 'p1' });
        await sleep(20);
        await t.onPermission?.({
          title: 'Allow Bash?',
          options: [{ optionId: 'allow', label: 'Allow' }],
        });
        t.onToolFinish({ name: 'Bash', index: 0, id: 'p1', ok: true, durationMs: 400 });
        t.onSegmentBreak();
        t.onText('Deployed.');
      },
      {
        onPermissionRequest: async (platform, address) => {
          await platform.sendMessage(address, '🔐 Permission card');
          return { kind: 'selected', optionId: 'allow' };
        },
      }
    );

    h.reg.route(inbound('deploy'));
    await sleep(200);

    expect(h.messages).toHaveLength(4);
    expect(h.messages[0]!.kind).toBe('tools');
    expect(h.messages[1]!.text).toBe('🔐 Permission card');
    expect(h.messages[2]!.kind).toBe('tools');
    expect(h.messages[2]!.text).toContain('Bash: "deploy" ✓ 400ms');
    expect(h.messages[3]!.text).toBe('Deployed.');
  });
});
