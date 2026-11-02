import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebuiConfigSchema } from '../config-schemas.js';
import { CHANNEL, DISPATCH_TITLE, DISPATCH_TOPIC, WebRoom, type TopicNotice, type WebuiInstance } from './room.js';
import { TopicStore } from './topics.js';

/**
 * What the web UI says needs the operator: the stage each topic is in (core/topic-stage.ts, from the
 * outcome the daemon pushes and when the operator last looked), the dispatcher's pinned topic, and
 * the push notifications that go out when one starts needing them.
 */

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-needs-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function instance(): WebuiInstance {
  return { ...WebuiConfigSchema.parse({ type: 'webui', token: 'secret' }), id: 'webui' };
}

function rig() {
  const file = path.join(dir, 'topics.json');
  const store = new TopicStore(file);
  const room = new WebRoom(instance(), store);
  const topic = store.current().id;
  return { room, store, topic, file, row: (id: string) => room.topicList().find((t) => t.id === id) };
}

describe('WebRoom: the stage of a topic', () => {
  it('a finished reply is "review" until the operator looks, then idle', () => {
    const { room, topic, row } = rig();
    expect(row(topic)?.stage).toBe('idle');
    room.setActivity(topic, { outcome: { kind: 'done', at: Date.now() - 1, line: 'Done: shipped' } });
    expect(row(topic)?.stage).toBe('review');
    expect(row(topic)?.line).toBe('Done: shipped');
    expect(room.markSeen(topic)).toBe(true);
    expect(row(topic)?.stage).toBe('idle');
    expect(room.seenAt(topic)).toBeGreaterThan(0);
  });

  it('a failure stays a failure after it has been seen', () => {
    const { room, topic, row } = rig();
    room.setActivity(topic, { outcome: { kind: 'failed', at: Date.now() - 1, line: 'upstream 503', reason: 'service' } });
    room.markSeen(topic);
    expect(row(topic)?.stage).toBe('failed');
  });

  it('a scheduled continue reads as retrying', () => {
    const { room, topic, row } = rig();
    room.setActivity(topic, {
      outcome: { kind: 'failed', at: 1, reason: 'service' },
      retry: { attempt: 1, max: 3, at: Date.now() + 30_000 },
    });
    expect(row(topic)?.stage).toBe('retrying');
  });

  it('a question on screen is "answer", with the question as its line', () => {
    const { room, topic, row } = rig();
    room.post(topic, { own: false, html: '', buttons: [{ id: 'a', label: 'Yes' }] }, 'Ship 2.18.0 now?\n\nIt has the dispatcher.');
    expect(row(topic)?.stage).toBe('answer');
    expect(row(topic)?.line).toBe('Ship 2.18.0 now?');
  });

  it('keeps the outcome and when it was seen across a restart, but not a scheduled continue', () => {
    const { room, topic, file } = rig();
    room.setActivity(topic, {
      outcome: { kind: 'failed', at: 5, line: 'x', reason: 'hung' },
      retry: { attempt: 1, max: 3, at: 99 },
    });
    room.markSeen(topic);
    const again = new TopicStore(file).get(topic);
    expect(again?.outcome).toEqual({ kind: 'failed', at: 5, line: 'x', reason: 'hung' });
    expect(again?.seenAt).toBeGreaterThan(0);
    expect(again?.retry).toBeUndefined();
  });
});

describe('WebRoom: the dispatcher topic', () => {
  it('is opened with a fixed id and name, pinned against eviction, clearing and deletion', () => {
    const { room, store, row } = rig();
    expect(room.dispatchLane(true)).toEqual({ channel: CHANNEL, thread: DISPATCH_TOPIC });
    expect(row(DISPATCH_TOPIC)).toMatchObject({ title: DISPATCH_TITLE, dispatcher: true });
    expect(room.deleteTopic(DISPATCH_TOPIC)).toBe(false);
    room.clearTopics();
    expect(store.has(DISPATCH_TOPIC)).toBe(true);
    expect(store.evictable(() => false)?.id).not.toBe(DISPATCH_TOPIC);
  });

  it('keeps its name: nothing renames it', () => {
    const { room, row } = rig();
    room.dispatchLane(true);
    expect(room.renameTopic(DISPATCH_TOPIC, '[disp] whatever the first message said')).toBe(false);
    expect(row(DISPATCH_TOPIC)?.title).toBe(DISPATCH_TITLE);
  });

  it('opening it twice is the same topic; retiring it leaves an ordinary topic', () => {
    const { room, row } = rig();
    room.dispatchLane(true);
    room.dispatchLane(true);
    expect(room.topicList().filter((t) => t.dispatcher)).toHaveLength(1);
    expect(room.dispatchLane(false)).toBeUndefined();
    expect(row(DISPATCH_TOPIC)?.dispatcher).toBeUndefined();
    expect(room.deleteTopic(DISPATCH_TOPIC)).toBe(true);
  });
});

describe('WebRoom: push notifications', () => {
  it('notify for a topic that starts needing the operator and still does after the grace', () => {
    vi.useFakeTimers();
    const { room, topic } = rig();
    const sent: TopicNotice[] = [];
    room.useNotifier((n) => sent.push(n));
    room.setActivity(topic, { outcome: { kind: 'done', at: Date.now() + 1, line: 'All green' } });
    vi.advanceTimersByTime(2_999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ topic, title: 'Untitled', body: 'Finished: All green' }]);
  });

  it('do not notify about what the operator read within the grace', () => {
    vi.useFakeTimers();
    const { room, topic } = rig();
    const sent: TopicNotice[] = [];
    room.useNotifier((n) => sent.push(n));
    room.setActivity(topic, { outcome: { kind: 'done', at: Date.now() } });
    vi.advanceTimersByTime(1_000);
    room.markSeen(topic);
    vi.advanceTimersByTime(5_000);
    expect(sent).toEqual([]);
  });

  it('with a dispatcher, notify only for its topic — it is told about the rest', () => {
    vi.useFakeTimers();
    const { room, topic } = rig();
    const sent: TopicNotice[] = [];
    room.useNotifier((n) => sent.push(n));
    room.dispatchLane(true);
    room.setActivity(topic, { outcome: { kind: 'failed', at: Date.now(), line: 'boom', reason: 'other' } });
    room.setActivity(DISPATCH_TOPIC, { outcome: { kind: 'done', at: Date.now() + 1, line: 'cx failed on quantlab' } });
    vi.advanceTimersByTime(3_000);
    expect(sent.map((n) => n.topic)).toEqual([DISPATCH_TOPIC]);
  });
});
