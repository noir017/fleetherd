import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers, FollowUpSink } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * Pictures in an agent's reply (AgentStreamHandlers.onImage): sent as files where they fall in the
 * reply, one at a time, and all of them before the turn is marked done.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const GIF = Buffer.from('GIF89a----', 'latin1');
const png = { data: PNG.toString('base64'), mimeType: 'image/png' };

function inbound(content: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId: 'm1',
    content,
    timestamp: 0,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const WAIT = { timeout: 5_000, interval: 10 };

function rig(runTurn: (h: AgentStreamHandlers) => Promise<void>, opts: { sendFile?: (name: string) => Promise<void> } = {}) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: false } },
  });
  const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  /** Everything that reached the chat, in order: message text, `file:<name>`, `react:<emoji>`. */
  const log: string[] = [];
  /** What each sent file held when it was sent, and where it was. */
  const files: Array<{ name?: string; path: string; bytes: Buffer }> = [];
  let sending = 0;
  let overlapped = false;
  let seq = 0;
  const platform = {
    capabilities: { thread: false, editMessage: true, maxMessageLength: 2000 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: { channel: string }, text: string) => {
      log.push(text);
      return { address, messageId: `m${++seq}` };
    },
    sendFile: async (address: { channel: string }, file: { path: string; name?: string }) => {
      if (++sending > 1) overlapped = true;
      try {
        files.push({ name: file.name, path: file.path, bytes: fs.readFileSync(file.path) });
        await opts.sendFile?.(file.name ?? '');
        log.push(`file:${file.name}`);
        return { address, messageId: `m${++seq}` };
      } finally {
        sending--;
      }
    },
    editMessage: async () => {},
    addReaction: async (_ref: unknown, emoji: string) => {
      log.push(`react:${emoji}`);
    },
    removeReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  let sink: FollowUpSink | undefined;
  const factory: AgentFactory = {
    getOrCreate(conversationId): AgentSession {
      return {
        conversationId,
        runTurn: async (_input, h) => runTurn(h),
        abort: () => {},
        setFollowUpSink: (s) => {
          sink = s;
        },
        dispose: () => {},
      };
    },
    peek: () => undefined,
    dispose: () => {},
  };

  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock);
  return { reg, log, files, overlapped: () => overlapped, sink: () => sink! };
}

describe('a picture in the reply', () => {
  it('is sent between the text before it and the text after it, and its file is gone afterwards', async () => {
    const h = rig(async (t) => {
      t.onText('Here is the chart:');
      t.onImage?.({ ...png, name: 'sales.png' });
      t.onText('Revenue doubled.');
    });
    h.reg.route(inbound('chart it'));
    await vi.waitFor(() => {
      expect(h.log).toContain('react:✅');
    }, WAIT);

    expect(h.log.filter((l) => !l.startsWith('react:'))).toEqual(['Here is the chart:', 'file:sales.png', 'Revenue doubled.']);
    expect(h.files).toHaveLength(1);
    expect(h.files[0]!.bytes).toEqual(PNG);
    expect(fs.existsSync(h.files[0]!.path)).toBe(false);
  });

  it('holds the turn open until every picture is sent, one at a time and in order', async () => {
    const h = rig(
      async (t) => {
        t.onImage?.(png);
        t.onImage?.({ data: GIF.toString('base64'), mimeType: 'image/gif' });
        // The runtime returns at once; the uploads are still going.
      },
      { sendFile: () => sleep(30) }
    );
    h.reg.route(inbound('two pictures'));
    await vi.waitFor(() => {
      expect(h.log).toContain('react:✅');
    }, WAIT);

    const sent = h.log.filter((l) => l.startsWith('file:'));
    expect(sent).toEqual(['file:image-1.png', 'file:image-2.gif']);
    expect(h.overlapped()).toBe(false);
    // ✅ goes on the person's message when the turn ends, which is after the last upload.
    expect(h.log.indexOf('react:✅')).toBeGreaterThan(h.log.indexOf('file:image-2.gif'));
  });

  it('is not sent when the bytes are not a picture, and the text runs on as one message', async () => {
    const h = rig(async (t) => {
      t.onText('Before, ');
      t.onImage?.({ data: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/png' });
      t.onText('after.');
    });
    h.reg.route(inbound('draw it'));
    await vi.waitFor(() => {
      expect(h.log).toContain('react:✅');
    }, WAIT);

    expect(h.files).toEqual([]);
    expect(h.log.filter((l) => !l.startsWith('react:'))).toEqual(['Before, after.']);
  });

  it('that fails to send is logged, and the rest of the reply still arrives', async () => {
    const h = rig(
      async (t) => {
        t.onImage?.(png);
        t.onText('Done.');
      },
      {
        sendFile: () => Promise.reject(new Error('413 Request Entity Too Large')),
      }
    );
    h.reg.route(inbound('chart it'));
    await vi.waitFor(() => {
      expect(h.log).toContain('react:✅');
    }, WAIT);

    expect(h.log).toContain('Done.');
    expect(h.log).toContain('react:✅');
    expect(h.log.some((l) => l.startsWith('❌'))).toBe(false);
    expect(fs.existsSync(h.files[0]!.path)).toBe(false);
  });

  it('arriving after the turn is sent with the background output', async () => {
    const h = rig(async (t) => t.onText('Started it in the background.'));
    h.reg.route(inbound('render it later'));
    await vi.waitFor(() => {
      expect(h.log).toContain('react:✅');
    }, WAIT);

    const burst = h.sink().handlers();
    burst.onImage?.(png);
    await h.sink().close();

    expect(h.log).toContain('file:image-1.png');
  });
});
