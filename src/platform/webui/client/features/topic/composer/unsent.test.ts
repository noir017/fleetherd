// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerTopic, LocalBubbleMessage } from './types.js';
import {
  createUnsentController,
  framed,
  localBody,
  parseStoredUnsent,
  shouldQueueOptimistically,
  UNSENT_STORAGE_KEY,
} from './unsent.js';

describe('composer/unsent', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('parses stored unsent records and marks non-failed entries as unsure', () => {
    const raw = JSON.stringify({
      n1: { t: 't1', x: 'hi', n: ['a.png'], at: 100, s: 'sending', g: 2 },
      n2: { t: 't1', x: 'err', n: [], at: 200, s: 'failed', g: 2 },
      bad: { t: 123 },
    });
    expect(parseStoredUnsent(raw)).toEqual({
      n1: { t: 't1', x: 'hi', n: ['a.png'], at: 100, s: 'unsure', g: 2 },
      n2: { t: 't1', x: 'err', n: [], at: 200, s: 'failed', g: 2 },
    });
  });

  it('encodes framed binary payloads with 4-byte big-endian JSON header + raw bytes', () => {
    const bytes = framed({
      topic: 't1',
      text: 'hello',
      nonce: 'abc',
      files: [{ name: 'a.txt', mime: 'text/plain', data: btoa('XYZ') }],
    });
    const headLen = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    const meta = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + headLen))) as {
      topic: string;
      text: string;
      nonce: string;
      files: { name: string; mime: string; size: number }[];
    };
    expect(meta).toEqual({
      topic: 't1',
      text: 'hello',
      nonce: 'abc',
      files: [{ name: 'a.txt', mime: 'text/plain', size: 3 }],
    });
    expect(new TextDecoder().decode(bytes.slice(4 + headLen))).toBe('XYZ');
  });

  it('decides optimistic mid-turn queueing only for non-command text on running non-asking topics', () => {
    expect(shouldQueueOptimistically('next step', { id: 't1', running: true, asking: false })).toBe(true);
    expect(shouldQueueOptimistically('/stop', { id: 't1', running: true, asking: false })).toBe(false);
    expect(shouldQueueOptimistically('answer', { id: 't1', running: true, asking: true })).toBe(false);
    expect(shouldQueueOptimistically('hi', { id: 't1', running: false })).toBe(false);
  });

  it('builds escaped local bubble HTML with file chips', () => {
    const html = localBody('<script>x</script>', ['a<b>.png']);
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('<span class="chip">a&lt;b&gt;.png</span>');
  });

  it('dispatches, fails on network error, settles unsure on matching epoch, and claims echo', async () => {
    const msgs: Record<string, LocalBubbleMessage> = {};
    const els = new Set<string>();
    const pending = new Set<string>();
    const settleAdopted = vi.fn();
    const postFn = vi.fn().mockRejectedValueOnce(new Error('offline'));
    let epoch = 3;
    const topic: ComposerTopic = { id: 't1', running: false };

    const ctrl = createUnsentController({
      doc: document,
      storage: localStorage,
      getTopic: () => 't1',
      topicById: (id) => (id === 't1' ? topic : undefined),
      getEpoch: () => epoch,
      settleAdopted,
      cacheSave: vi.fn(),
      copyText: (_v, done) => done(true),
      topicStatus: {
        addLocalPending: (item) => pending.add(item.nonce),
        hasLocalPending: (nonce) => pending.has(nonce),
        removeLocalPending: (nonce) => pending.delete(nonce),
      },
      transcript: {
        getMessage: (key) => msgs[key],
        setMessage: (key, msg) => {
          msgs[key] = msg;
          els.add(key);
        },
        deleteMessage: (key) => {
          delete msgs[key];
        },
        hasElement: (key) => els.has(key),
        removeElement: (key) => {
          els.delete(key);
        },
        adoptElement: (fromKey, toKey) => {
          els.delete(fromKey);
          els.add(toKey);
        },
        paint: vi.fn(),
        drop: (key) => {
          delete msgs[key];
          els.delete(key);
        },
        sinkLocals: vi.fn(),
        syncEmptyNote: vi.fn(),
        atBottom: () => true,
        toBottom: vi.fn(),
        onBtwAsked: vi.fn(),
        onClaimKeyMoved: vi.fn(),
      },
      postFn,
      now: () => 1000,
    });

    ctrl.dispatch('ping', []);
    await Promise.resolve();
    await Promise.resolve();

    const pk = Object.keys(msgs)[0]!;
    const nonce = pk.slice(2);
    expect(msgs[pk]?._state).toBe('failed');
    expect(ctrl.hasOutbox(nonce)).toBe(true);
    expect(localStorage.getItem(UNSENT_STORAGE_KEY)).toContain(nonce);

    ctrl.claim({ id: '42', nonce, g: 3 });
    expect(ctrl.hasOutbox(nonce)).toBe(false);
    expect(els.has('3:42')).toBe(true);
    expect(settleAdopted).toHaveBeenCalledWith('t1', 'ping');

    // Simulate restored unsure record on same epoch -> transitions to failed.
    localStorage.setItem(
      UNSENT_STORAGE_KEY,
      JSON.stringify({ r1: { t: 't1', x: 'restored', n: [], at: 500, s: 'sending', g: 3 } }),
    );
    const ctrl2 = createUnsentController({
      doc: document,
      storage: localStorage,
      getTopic: () => 't1',
      topicById: () => topic,
      getEpoch: () => epoch,
      settleAdopted: vi.fn(),
      cacheSave: vi.fn(),
      copyText: (_v, done) => done(true),
      topicStatus: {
        addLocalPending: vi.fn(),
        hasLocalPending: () => false,
        removeLocalPending: () => false,
      },
      transcript: {
        getMessage: (key) => msgs[key],
        setMessage: (key, msg) => {
          msgs[key] = msg;
        },
        deleteMessage: (key) => {
          delete msgs[key];
        },
        hasElement: () => false,
        removeElement: vi.fn(),
        adoptElement: vi.fn(),
        paint: vi.fn(),
        drop: vi.fn(),
        sinkLocals: vi.fn(),
        syncEmptyNote: vi.fn(),
        atBottom: () => true,
        toBottom: vi.fn(),
        onBtwAsked: vi.fn(),
        onClaimKeyMoved: vi.fn(),
      },
    });
    ctrl2.showUnsent('t1');
    expect(msgs['p:r1']?._state).toBe('unsure');
    epoch = 3;
    ctrl2.settleUnsure();
    expect(msgs['p:r1']?._state).toBe('failed');
  });
});
