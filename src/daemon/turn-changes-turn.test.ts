import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter, TurnChangeEntry } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { InboundMessage } from '../types.js';

/**
 * The turn flow around the snapshots: a turn's answer must be unaffected by them.
 *
 * These run the real registry (so the real `TurnChanges` and a real `git`), against a scratch
 * repository: what is being checked is the seam the runner added — the "before" snapshot awaited
 * with a budget, the "after" one fired and forgotten — not the git plumbing, which
 * turn-changes.test.ts covers.
 */

function inbound(content: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId: 'm1',
    content,
    timestamp: 0,
  };
}

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

async function within(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('never happened');
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-changes-turn-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  return dir;
}

function rig(cwd: string, runTurn: (h: AgentStreamHandlers) => Promise<void>) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude', cwd }],
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

  const sent: string[] = [];
  const entries: TurnChangeEntry[] = [];
  const addresses: ConversationAddress[] = [];
  let seq = 0;
  const platform = {
    capabilities: { thread: false, editMessage: true, maxMessageLength: 2000 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: ConversationAddress, text: string) => {
      sent.push(text);
      return { address, messageId: `m${++seq}` };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    attachTurnChanges: (address: ConversationAddress, entry: TurnChangeEntry) => {
      addresses.push(address);
      entries.push(entry);
    },
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

  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock);
  return { reg, sent, entries, addresses };
}

describe('a turn’s snapshots and the turn', () => {
  it('records what the turn changed, after the reply has gone out', async () => {
    const dir = repo();
    const h = rig(dir, async (t) => {
      t.onText('Done.');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
    });
    h.reg.route(inbound('change two files'));
    // The start snapshot is real git in a real directory, so the reply comes after it.
    await within(() => h.sent.length > 0);
    expect(h.sent).toEqual(['Done.']);

    await within(() => h.entries.length === 1);
    expect(h.entries[0]).toEqual({ turn: 1, files: 2, additions: 2, deletions: 0 });
    // The entry is attached to the lane the person wrote in — the topic it is drawn in.
    expect(h.addresses[0]).toMatchObject({ channel: 'c1' });
  });

  it('runs the turn untouched when the snapshot cannot be taken', async () => {
    const dir = repo();
    // No HOME on that machine: the service cannot name the snapshot directory, so it skips the
    // turn entirely — and the reply goes out exactly as it would have.
    vi.stubEnv('HOME', '');
    try {
      const h = rig(dir, async (t) => {
        t.onText('Done anyway.');
      });
      h.reg.route(inbound('change nothing'));
      await drain();
      expect(h.sent).toEqual(['Done anyway.']);
      expect(h.entries).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('runs the turn untouched in a directory that is not a git work tree', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-changes-plain-'));
    const h = rig(plain, async (t) => {
      t.onText('Fine.');
    });
    h.reg.route(inbound('hello'));
    await drain();
    expect(h.sent).toEqual(['Fine.']);
    expect(h.entries).toEqual([]);
  });

  it('still takes the end snapshot of a turn whose agent failed', async () => {
    const dir = repo();
    const h = rig(dir, async (t) => {
      t.onText('Partial.');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
      throw new Error('boom');
    });
    h.reg.route(inbound('do it'));
    await within(() => h.sent.length > 0);
    expect(h.sent[0]).toBe('Partial.');
    await within(() => h.entries.length === 1);
    expect(h.entries[0]?.files).toBe(1);
  });
});
