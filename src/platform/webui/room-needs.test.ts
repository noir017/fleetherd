import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebuiConfigSchema } from '../config-schemas.js';
import { WebRoom, type TopicNotice, type WebuiInstance } from './room.js';
import { TopicStore } from './topics.js';

/**
 * What the web UI says needs the operator: the stage each topic is in (core/topic-stage.ts, from the
 * outcome the daemon pushes and when the operator last looked), sub-agent topics nested under the
 * topic that opened them, and the push notifications that go out when one starts needing them.
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

  /**
   * The menu a new topic gets right after its agent is chosen — a tap on a card types `/agent`,
   * and the daemon answers with where that agent should work. Nobody is blocked on it: no session
   * exists until it is answered (or until a message is sent, which is an answer of its own), so a
   * topic left mid-setup must not pin itself to the top in green or push "Waiting on your answer".
   */
  it('a directory menu is a control, not a question: it neither asks nor notifies', () => {
    vi.useFakeTimers();
    const { room, topic, row } = rig();
    const sent: TopicNotice[] = [];
    room.useNotifier((n) => sent.push(n));
    room.post(
      topic,
      {
        own: false,
        html: '',
        buttons: [
          { id: 'wdr:ab12cd34:0', label: '● workspace' },
          { id: 'wdr:ab12cd34:1', label: 'quantlab' },
        ],
      },
      'Working dir: /home/user/workspace\n2 available — tap one to work there'
    );
    expect(row(topic)?.asking).toBe(false);
    expect(row(topic)?.stage).toBe('idle');
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
  });

  it('settings and schedule menus are controls, not questions: they neither ask nor notify', () => {
    vi.useFakeTimers();
    const { room, topic, row } = rig();
    const sent: TopicNotice[] = [];
    room.useNotifier((n) => sent.push(n));

    room.post(
      topic,
      {
        own: false,
        html: '',
        buttons: [{ id: 'stg:ab12cd34:0', label: 'Default model' }],
      },
      'Settings'
    );
    expect(row(topic)?.asking).toBe(false);
    expect(row(topic)?.stage).toBe('idle');

    room.post(
      topic,
      {
        own: false,
        html: '',
        buttons: [{ id: 'sct:ab12cd34:0', label: 'Morning CI' }],
      },
      'Scheduled tasks'
    );
    expect(row(topic)?.asking).toBe(false);
    expect(row(topic)?.stage).toBe('idle');

    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
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

describe('WebRoom: sub-agent topics (Topic.parent)', () => {
  it('nests a topic under the one that opened it, and lists the children', () => {
    const { room, topic } = rig();
    const child = room.createTopic('[cx] part', topic);
    expect(room.parentOf(child.id)).toBe(topic);
    expect(room.childrenOf(topic)).toEqual([child.id]);
    expect(room.topicList().find((t) => t.id === child.id)?.parent).toBe(topic);
  });

  it('keeps the children as topics of their own when the parent is deleted, or swept', () => {
    const { room, store, topic } = rig();
    const child = room.createTopic('[cx] part', topic);
    store.star(child.id, true);
    room.deleteTopic(topic);
    expect(store.get(child.id)?.parent).toBeUndefined();
    const parent = room.createTopic('again');
    const second = room.createTopic('[oc] part', parent.id);
    store.star(second.id, true);
    room.clearTopics();
    expect(store.get(second.id)?.parent).toBeUndefined();
  });

  it('persists the relation, and drops one that names a topic no longer there', () => {
    const { room, store, topic, file } = rig();
    const child = room.createTopic('[cx] part', topic);
    expect(new TopicStore(file).get(child.id)?.parent).toBe(topic);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { parent?: string }>;
    raw[child.id]!.parent = 'deadbeef';
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(new TopicStore(file).get(child.id)?.parent).toBeUndefined();
    expect(store.get(child.id)?.parent).toBe(topic);
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

  it('for a sub-agent’s topic, only a question of its own — its reply goes to the agent that opened it', () => {
    vi.useFakeTimers();
    const { room, topic } = rig();
    const sent: TopicNotice[] = [];
    room.useNotifier((n) => sent.push(n));
    const child = room.createTopic('[cx] part', topic);
    room.setActivity(child.id, { outcome: { kind: 'done', at: Date.now() + 1, line: 'done' } });
    room.setActivity(topic, { outcome: { kind: 'done', at: Date.now() + 1, line: 'All three finished' } });
    vi.advanceTimersByTime(3_000);
    expect(sent.map((n) => n.topic)).toEqual([topic]);
  });
});
