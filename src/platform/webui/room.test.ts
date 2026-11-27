import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RETRY_PREFIX } from '../../core/turn-retry.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MessageNotEditableError } from '../../core/outbound-errors.js';
import type {
  SchedulePanel,
  SchedulePanelFormContext,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
  SkillPanelEntry,
} from '../workbench.js';
import { WebuiConfigSchema } from '../../config/platform-schemas.js';
import {
  CHANNEL,
  DIR_TTL_MS,
  historyMessages,
  inlineImageType,
  isControlMenu,
  isControlMenuButton,
  mergeReplay,
  OWNER,
  WebRoom,
  type Kept,
  type TranscriptStore,
  type UploadStore,
  type WebuiInstance,
} from './room.js';
import { MAX_TOPICS, TopicStore, type Topic } from './topics.js';
import { icon } from './icons.js';
import { hasTopic } from './index.js';
import type { InboundMessage } from '../../types.js';
import type { WebEvent, WebMessage } from './protocol.js';
import { WORKDIR_PICK_PREFIX, WORKDIR_PAGE_PREFIX } from '../../core/workdir-menu.js';
import { MODEL_PICK_PREFIX, MODEL_PAGE_PREFIX } from '../../core/model-menu.js';
import { EFFORT_PICK_PREFIX } from '../../core/effort-menu.js';
import { AGENT_GROUP_PREFIX, AGENT_PICK_PREFIX, AGENT_BACK_PREFIX, AGENT_PAGE_PREFIX } from '../../core/agent-menu.js';
import {
  SETTING_ROW_PREFIX,
  SETTING_VALUE_PREFIX,
  SETTING_PAGE_PREFIX,
  SETTING_BACK_PREFIX,
  SETTING_SET_PREFIX,
  SETTING_TYPE_PREFIX,
} from '../../core/settings.js';
import { SCHEDULE_OPEN_PREFIX, SCHEDULE_TASK_PREFIX, SCHEDULE_ACTION_PREFIX } from '../../core/schedule-menu.js';
import { PICK_PREFIX } from '../../core/button-id.js';
import { VOICE_BUTTON_PREFIX } from '../../core/voice.js';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-room-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function instance(over: Partial<WebuiInstance> = {}): WebuiInstance {
  return { ...WebuiConfigSchema.parse({ type: 'webui', token: 'secret' }), id: 'webui', ...over };
}

interface Seen {
  id: string;
  ev: WebEvent;
}

/** A room with one topic and a client attached to it, whose events the test can read back. */
function attached(over?: Partial<WebuiInstance>): {
  room: WebRoom;
  topic: string;
  seen: Seen[];
  off: () => void;
  /** The topic list as this client holds it, every list event applied — `seen` may have been emptied. */
  list: () => Topic[];
} {
  const store = new TopicStore(path.join(dir, `${Math.random()}.json`));
  const room = new WebRoom(instance(over), store);
  const topic = store.current().id;
  const seen: Seen[] = [];
  let held: Topic[] = [];
  const off = room.subscribe(topic, (id, ev) => {
    seen.push({ id, ev });
    held = applyList(held, ev);
  });
  return { room, topic, seen, off, list: () => held };
}

const kinds = (seen: Seen[]): string[] => seen.map((s) => s.ev.t);
const last = (seen: Seen[]): WebEvent | undefined => seen[seen.length - 1]?.ev;
/** The last event of one kind: an edit that carries buttons now drags a topic list along behind it. */
const lastOf = (seen: Seen[], t: WebEvent['t']): WebEvent | undefined =>
  [...seen].reverse().find((s) => s.ev.t === t)?.ev;
/** The events that carry the topic list, whole (a sync, `topics`) or what changed in it (`topic-rows`). */
const listEvents = (seen: Seen[]): Seen[] => seen.filter((s) => s.ev.t === 'topics' || s.ev.t === 'topic-rows');

/**
 * A list event applied to the list a client holds, the way the page applies it (`applyRows`):
 * written here rather than borrowed from room.ts, so the order the server derives is checked
 * against an independent reading of the same rule.
 */
function applyList(held: Topic[], ev: WebEvent): Topic[] {
  if (ev.t === 'sync' || ev.t === 'topics') return ev.topics;
  if (ev.t !== 'topic-rows') return held;
  const gone = new Set(ev.gone ?? []);
  const next = held.filter((t) => !gone.has(t.id));
  for (const row of ev.rows) {
    const at = next.findIndex((t) => t.id === row.id);
    if (at >= 0) next[at] = row;
    else next.push(row);
  }
  if (ev.order) return ev.order.map((id) => next.find((t) => t.id === id)).filter((t): t is Topic => Boolean(t));
  return next
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.lastAt - a.t.lastAt || a.i - b.i)
    .map((x) => x.t);
}

describe('WebRoom: topics are separate conversations', () => {
  it('keeps two topics' + " messages and streams apart", () => {
    const store = new TopicStore(path.join(dir, 't.json'));
    const room = new WebRoom(instance(), store);
    const a = store.create('a').id;
    const b = store.create('b').id;
    const seenA: Seen[] = [];
    room.subscribe(a, (id, ev) => seenA.push({ id, ev }));

    room.post(b, { own: false, html: '<p>in b</p>' }, 'in b');
    // A client reading one room is not billed for traffic in another — the point of a
    // per-topic stream on a weak link. Only the topic list crosses.
    expect(kinds(seenA).filter((k) => k === 'msg')).toEqual([]);
    // And of the list, only the row that moved.
    expect(kinds(seenA)).toContain('topic-rows');
    expect((lastOf(seenA, 'topic-rows') as { rows: Topic[] }).rows.map((t) => t.id)).toEqual([b]);

    room.post(a, { own: false, html: '<p>in a</p>' }, 'in a');
    expect(seenA.filter((s) => s.ev.t === 'msg')).toHaveLength(1);
  });

  it('addresses a topic as a lane, and as a DM', () => {
    const { room, topic } = attached();
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    room.submit({ topic, text: 'hi' });
    // `kind: 'direct'` even with a lane set, deliberately: with 'thread' the inbound gate falls
    // through to its mention requirement and a brand-new topic's FIRST message is dropped.
    expect(got[0]?.conversation).toEqual({
      platform: 'webui',
      channel: CHANNEL,
      thread: topic,
      kind: 'direct',
      user: OWNER,
    });
  });

  it('applies chat.channels per lane', () => {
    const store = new TopicStore(path.join(dir, 'c.json'));
    const topic = store.create().id;
    // A bare channel entry covers every topic in it; a lane entry names one.
    const broad = new WebRoom(instance({ chat: { ...instance().chat, channels: [CHANNEL] } }), store);
    const heard = vi.fn();
    broad.onMessage(heard);
    broad.submit({ topic, text: 'hi' });
    expect(heard).toHaveBeenCalledOnce();

    const narrow = new WebRoom(instance({ chat: { ...instance().chat, channels: [`${CHANNEL}/other123`] } }), store);
    const muted = vi.fn();
    narrow.onMessage(muted);
    narrow.submit({ topic, text: 'hi' });
    expect(muted).not.toHaveBeenCalled();
  });

  it('refuses a message or a click for a topic that does not exist', () => {
    const { room } = attached();
    const onMsg = vi.fn();
    const onBtn = vi.fn();
    room.onMessage(onMsg);
    room.onButton(onBtn);
    expect(room.submit({ topic: 'deadbeef', text: 'hi' })).toBe('unknown-topic');
    expect(room.click({ topic: 'deadbeef', messageId: 'w1', buttonId: 'ask:r:0' })).toBe(false);
    expect(onMsg).not.toHaveBeenCalled();
    expect(onBtn).not.toHaveBeenCalled();
  });

  it('announces the topic list when one is created, renamed or spoken in', () => {
    const { room, topic, seen, list } = attached();
    seen.length = 0;
    const second = room.createTopic('second');
    expect(last(seen)).toMatchObject({ t: 'topic-rows' });
    expect(list().map((t) => t.id)).toContain(second.id);
    seen.length = 0;
    room.renameTopic(topic, '[cc] a subject');
    // The renamed row, and nothing about the other one.
    expect((last(seen) as { rows: Topic[] }).rows.map((t) => [t.id, t.title])).toEqual([[topic, '[cc] a subject']]);
    expect(list().some((t) => t.title === '[cc] a subject')).toBe(true);
  });

  it('tracks running state and msgCount in the topic list', () => {
    const { room, topic, seen, list } = attached();
    expect(room.topicList().find((t) => t.id === topic)?.running).toBe(false);
    expect(room.topicList().find((t) => t.id === topic)?.msgCount).toBe(0);

    // Typing sets running: true and announces
    seen.length = 0;
    room.setTyping(topic, true);
    expect(room.topicList().find((t) => t.id === topic)?.running).toBe(true);
    expect(listEvents(seen)).toHaveLength(1);
    expect(list().find((t) => t.id === topic)?.running).toBe(true);

    // Posting a message increments msgCount
    room.post(topic, { own: false, html: '<p>hi</p>' }, 'hi');
    expect(room.topicList().find((t) => t.id === topic)?.msgCount).toBe(1);
    expect(list().find((t) => t.id === topic)?.msgCount).toBe(1);

    // Stopping typing sets running: false and announces
    seen.length = 0;
    room.setTyping(topic, false);
    expect(room.topicList().find((t) => t.id === topic)?.running).toBe(false);
    expect(listEvents(seen)).toHaveLength(1);
    expect(list().find((t) => t.id === topic)?.running).toBe(false);
  });

  it('stamps when a run began, sends it with the row, and clears it when typing stops', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { room, topic, seen, list } = attached();

    seen.length = 0;
    room.setTyping(topic, true);
    expect(room.topicList().find((t) => t.id === topic)?.runningSince).toBe(1_000_000);
    // The client holds it too: the row that changed is what the page counts the age from.
    expect(list().find((t) => t.id === topic)?.runningSince).toBe(1_000_000);
    const on = (lastOf(seen, 'topic-rows') as { rows: Topic[] }).rows.find((t) => t.id === topic);
    expect(on?.runningSince).toBe(1_000_000);

    // A repeat is not a new run: the start must not move under the reader.
    vi.setSystemTime(1_030_000);
    room.setTyping(topic, true);
    expect(room.topicList().find((t) => t.id === topic)?.runningSince).toBe(1_000_000);

    // Off clears it, and the row is sent without the field rather than with a stale one.
    seen.length = 0;
    room.setTyping(topic, false);
    expect(room.topicList().find((t) => t.id === topic)?.runningSince).toBeUndefined();
    expect(list().find((t) => t.id === topic)?.runningSince).toBeUndefined();
    const off = (lastOf(seen, 'topic-rows') as { rows: Topic[] }).rows.find((t) => t.id === topic);
    expect(off).not.toHaveProperty('runningSince');
  });

  it('stamps a fresh start when a stopped topic starts again, and never writes it to disk', () => {
    vi.useFakeTimers({ now: 2_000_000 });
    const file = path.join(dir, 'running.json');
    const store = new TopicStore(file);
    const room = new WebRoom(instance(), store);
    const topic = store.current().id;

    room.setTyping(topic, true);
    expect(room.topicList().find((t) => t.id === topic)?.runningSince).toBe(2_000_000);
    // The start is live state only: the topic file keeps the list's own fields.
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(saved[topic]).not.toHaveProperty('runningSince');

    room.setTyping(topic, false);
    vi.setSystemTime(2_060_000);
    room.setTyping(topic, true);
    expect(room.topicList().find((t) => t.id === topic)?.runningSince).toBe(2_060_000);
  });

  it('deletes a topic, cleans up room state, and announces the updated list', () => {
    const { room, seen, list } = attached();
    const second = room.createTopic('second');
    room.post(second.id, { own: false, html: '<p>msg</p>' }, 'msg');
    seen.length = 0;

    expect(room.deleteTopic(second.id)).toBe(true);
    expect(room.topicList().some((t) => t.id === second.id)).toBe(false);
    expect(last(seen)).toMatchObject({ t: 'topic-rows', gone: [second.id] });
    expect(list().some((t) => t.id === second.id)).toBe(false);

    // Deleting again returns false
    expect(room.deleteTopic(second.id)).toBe(false);
  });

  it('reports a deleted topic gone, which is what a daily run asks before rejoining it', () => {
    const { room, topic } = attached();
    expect(hasTopic(room.topics, { channel: CHANNEL, thread: topic })).toBe(true);
    room.deleteTopic(topic);
    expect(hasTopic(room.topics, { channel: CHANNEL, thread: topic })).toBe(false);
    // The two other shapes the adapter refuses: another channel, and no lane at all.
    expect(hasTopic(room.topics, { channel: 'elsewhere', thread: topic })).toBe(false);
    expect(hasTopic(room.topics, { channel: CHANNEL })).toBe(false);
  });

  it('clears every topic at once, announcing the replacement rather than each removal', () => {
    vi.useFakeTimers();
    const { room, topic, seen, list } = attached();
    const second = room.createTopic('second');
    const msg = room.post(second.id, { own: false, html: '<p>msg</p>' }, 'msg');
    // An edit left in flight, so the sweep is proved to stop the timers rather than leave one
    // armed to fire into a room that no longer exists.
    room.revise(second.id, msg.id, 'still typing');
    seen.length = 0;

    const fresh = room.clearTopics();

    expect(room.topicList().map((t) => t.id)).toEqual([fresh.id]);
    expect(fresh.id).not.toBe(topic);
    expect(fresh.id).not.toBe(second.id);
    // One announcement for the whole sweep, not one per topic dropped.
    expect(kinds(seen)).toEqual(['topic-rows']);
    expect(list().map((t) => t.id)).toEqual([fresh.id]);

    vi.advanceTimersByTime(60_000);
    expect(kinds(seen)).toEqual(['topic-rows']);
  });
});

describe('WebRoom: the topic list reaching every client', () => {
  it('does not send a list that has not changed', () => {
    // Several announcers cannot tell whether they changed anything — an outcome the topic already
    // had, a star set to what it was — and the list goes to every client.
    const { room, topic, seen, list } = attached();
    room.renameTopic(topic, 'named');
    room.setActivity(topic, { outcome: { kind: 'done', at: 5, line: 'Done' } });
    expect(listEvents(seen)).toHaveLength(2);
    seen.length = 0;

    room.setActivity(topic, { outcome: { kind: 'done', at: 5, line: 'Done' } });
    room.starTopic(topic, false);
    room.renameTopic(topic, 'named');
    expect(listEvents(seen)).toHaveLength(0);

    // A real change still goes out.
    room.starTopic(topic, true);
    expect(list()[0]?.starred).toBe(true);
  });

  it('sends a message elsewhere as its one row, not the whole list', () => {
    // It was the whole list, to every client, on every message posted anywhere: 34 KB of JSON at
    // 200 topics for one row's msgCount and lastAt.
    //
    // On a clock that moves a millisecond per step. On the real one a fast machine (CI, 2026-11-10)
    // made several of these topics, and then posted, inside one millisecond: the post's lastAt tied
    // with topics made in it, the store and the page break that tie differently, and the order is
    // sent — correctly, which is what the next test is about, but not what this one is.
    vi.useFakeTimers({ now: 1_000_000 });
    const { room, topic, seen, list } = attached();
    const others = Array.from({ length: 30 }, (_, i) => {
      vi.advanceTimersByTime(1);
      return room.createTopic(`topic ${i}`);
    });
    const busy = others[7]!;
    seen.length = 0;
    vi.advanceTimersByTime(1);
    room.post(busy.id, { own: false, html: '<p>x</p>' }, 'x');
    const ev = last(seen) as { t: string; rows: Topic[]; gone?: string[]; order?: string[] };
    expect(ev.t).toBe('topic-rows');
    expect(ev.rows.map((t) => t.id)).toEqual([busy.id]);
    expect(ev.gone).toBeUndefined();
    // Its new lastAt puts it first, which the page works out by itself.
    expect(ev.order).toBeUndefined();
    expect(list().map((t) => t.id)).toEqual(room.topicList().map((t) => t.id));
    expect(list()[0]?.id).toBe(busy.id);
    expect(list().some((t) => t.id === topic)).toBe(true);
  });

  it('sends the order only when the page would break a tie differently', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { room, topic, seen, list } = attached();
    vi.setSystemTime(1_000_100);
    const a = room.createTopic('a');
    vi.setSystemTime(1_000_200);
    const b = room.createTopic('b');
    // a and b touched in the same millisecond: the store keeps them in the order they were made
    // (a first), while the page, which held b ahead of a, would keep b first.
    vi.setSystemTime(1_000_300);
    room.topics.touch(b.id, 1_000_300);
    room.topics.touch(a.id, 1_000_300);
    seen.length = 0;
    room.renameTopic(topic, 'nudge');
    const ev = last(seen) as { order?: string[] };
    expect(ev.order?.slice(0, 2)).toEqual([a.id, b.id]);
    expect(list().map((t) => t.id)).toEqual(room.topicList().map((t) => t.id));
  });

  it('brings every client up to the list a newcomer is handed, so one change reaches all alike', () => {
    // A sync is drawn from the list as it is now, which may hold a change nobody was sent (the
    // liveness poll is the only announcer of an agent going away). Unless the others are brought
    // up to it first, the next change is worked out against a list the newcomer never had.
    let live = true;
    const { room, topic, seen, list } = attached();
    room.useLivenessLookup(() => live);
    live = false; // unannounced
    seen.length = 0;
    const later: Seen[] = [];
    let laterList: Topic[] = [];
    room.subscribe(topic, (id, ev) => {
      later.push({ id, ev });
      laterList = applyList(laterList, ev);
    });
    // The old client is told on the newcomer's arrival; the newcomer's sync already has it.
    expect(listEvents(seen)).toHaveLength(1);
    expect(list().find((t) => t.id === topic)?.live).toBe(false);
    expect(kinds(later)).toEqual(['sync']);
    room.starTopic(topic, true);
    expect(listEvents(later)).toHaveLength(1);
    expect(laterList).toEqual(list());
    expect(laterList).toEqual(room.topicList());
  });

  it('keeps a client holding exactly the daemon’s list through any run of changes', () => {
    // Creates, deletes, posts, renames, stars, and touches landing in the same millisecond (the
    // ties the page cannot order by itself): after each, what the client folded must be the list.
    vi.useFakeTimers({ now: 5_000_000 });
    const { room, list } = attached();
    let seed = 7;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let step = 0; step < 300; step++) {
      const ids = room.topicList().map((t) => t.id);
      const pick = ids[rnd(ids.length)]!;
      if (rnd(3) === 0) vi.advanceTimersByTime(1); // otherwise: the same millisecond, a tie
      switch (rnd(6)) {
        case 0:
          if (ids.length < 40) room.createTopic(`t${step}`);
          break;
        case 1:
          if (ids.length > 1) room.deleteTopic(pick);
          break;
        case 2:
          room.post(pick, { own: false, html: '<p>x</p>' }, 'x');
          break;
        case 3:
          room.renameTopic(pick, `n${step}`);
          break;
        case 4:
          room.starTopic(pick, rnd(2) === 0);
          break;
        default:
          room.setTyping(pick, rnd(2) === 0);
      }
      expect(list()).toEqual(room.topicList());
    }
  });

  it('serialises a change once for every client, not once per client', () => {
    const { room, topic } = attached();
    const bodies: string[] = [];
    for (let i = 0; i < 4; i++) room.subscribe(topic, (_id, ev, data) => void (ev.t === 'topic-rows' && bodies.push(data)));
    const stringify = vi.spyOn(JSON, 'stringify');
    room.starTopic(topic, true);
    const lists = stringify.mock.calls.filter(([v]) => (v as { t?: string } | undefined)?.t === 'topic-rows');
    stringify.mockRestore();
    expect(lists).toHaveLength(1);
    // And every client is handed that one serialisation, which is what the server writes.
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ t: 'topic-rows' });
  });

  it('hands a resumed page the list only when it moved since the version it holds', () => {
    const { room, topic, seen, off } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const lastId = seen.filter((s) => s.id !== '').at(-1)?.id ?? '';
    const tv = (listEvents(seen).at(-1)?.ev as { tv: number }).tv;
    off();
    const same: Seen[] = [];
    room.subscribe(topic, (id, ev) => same.push({ id, ev }), lastId, tv);
    expect(listEvents(same)).toHaveLength(0);
    room.createTopic('meanwhile');
    const moved: Seen[] = [];
    room.subscribe(topic, (id, ev) => moved.push({ id, ev }), lastId, tv);
    expect(kinds(moved)).not.toContain('sync');
    expect(lastOf(moved, 'topics')).toMatchObject({ t: 'topics', tv: tv + 1 });
  });

  it('ends a resume with a marker, and a sync with none', () => {
    // A page that entered a topic from memory has no sync coming to say it is caught up.
    const { room, topic, seen, off } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const lastId = seen.filter((s) => s.id !== '').at(-1)?.id ?? '';
    off();
    room.post(topic, { own: false, html: '<p>two</p>' }, 'two');
    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    expect(kinds(resumed).at(-1)).toBe('resumed');
    expect(resumed.at(-1)?.id).toBe('');
    const fresh: Seen[] = [];
    room.subscribe(topic, (id, ev) => fresh.push({ id, ev }));
    expect(kinds(fresh)).toEqual(['sync']);
  });
});

describe('WebRoom: the last event id on a row', () => {
  it('names the newest event in the same shape the stream and a snapshot use', () => {
    const { room, topic, seen } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const row = room.topicList().find((t) => t.id === topic);
    expect(row?.last).toMatch(new RegExp(`^${topic}\\.[0-9a-z]+\\.\\d+$`));
    // One number, three readers: the row a page compares its cached copy against, the snapshot it
    // may have painted from, and the id it resumes the stream from. They must be the same number.
    expect(row?.last).toBe(room.snapshot(topic)?.last);
    expect(row?.last).toBe(seen.filter((s) => s.id).at(-1)?.id);
    // A topic nothing has been emitted in sits at the zero position a sync of it would carry.
    const run = row?.last?.split('.')[1];
    const quiet = room.createTopic('quiet');
    expect(room.topicList().find((t) => t.id === quiet.id)?.last).toBe(`${quiet.id}.${run}.0`);
  });

  it('moves when a reply is edited, which is the case lastAt cannot see', () => {
    vi.useFakeTimers();
    const { room, topic, list } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    const before = list().find((t) => t.id === topic)?.last;
    room.revise(topic, msg.id, 'edited');
    // The edit is held for SETTLE_MS, so the event it will be sent as does not exist yet.
    vi.advanceTimersByTime(1_500);
    expect(list().find((t) => t.id === topic)?.last).toBe(before);
    // The flush emitted it; the row follows on the announce timer, not with the event itself.
    vi.advanceTimersByTime(299);
    expect(list().find((t) => t.id === topic)?.last).toBe(before);
    vi.advanceTimersByTime(1);
    const after = list().find((t) => t.id === topic)?.last;
    expect(after).not.toBe(before);
    expect(after).toBe(room.topicList().find((t) => t.id === topic)?.last);
    expect(after).toBe(room.snapshot(topic)?.last);
  });

  it('announces a burst once, counting from its first event rather than its last', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.react(topic, msg.id, '👀', true);
    vi.advanceTimersByTime(200);
    room.react(topic, msg.id, '👀', false);
    vi.advanceTimersByTime(99);
    expect(listEvents(seen)).toHaveLength(0);
    // 300ms after the FIRST change, not the second: a stream that never goes quiet has to report
    // where it stands rather than wait for a silence it will not get.
    vi.advanceTimersByTime(1);
    expect(listEvents(seen)).toHaveLength(1);
    const row = (lastOf(seen, 'topic-rows') as { rows: Topic[] }).rows.find((t) => t.id === topic);
    expect(row?.last).toBe(room.topicList().find((t) => t.id === topic)?.last);
    vi.advanceTimersByTime(1_000);
    expect(listEvents(seen)).toHaveLength(1);
  });

  it('sends one list for several edits inside the window', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    // An edit carrying buttons is sent at once rather than held (see `revise`), so these are
    // three separate events, each moving the row's `last`.
    room.revise(topic, msg.id, 'one', []);
    room.revise(topic, msg.id, 'two', []);
    room.revise(topic, msg.id, 'three', []);
    expect(seen.filter((s) => s.ev.t === 'msg')).toHaveLength(3);
    expect(listEvents(seen)).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(listEvents(seen)).toHaveLength(1);
    const row = (lastOf(seen, 'topic-rows') as { rows: Topic[] }).rows.find((t) => t.id === topic);
    expect(row?.last).toBe(room.topicList().find((t) => t.id === topic)?.last);
  });

  it('cancels the pending announcement when a synchronous one covers it', () => {
    vi.useFakeTimers();
    const { room, topic } = attached();
    // `post` emits (which arms the throttle) and then announces. Counted through `topicList`,
    // which only an announcement calls: a timer left armed would rebuild the list once more at
    // 300 ms — invisibly, because `sendTopics` would find nothing to send.
    const builds = vi.spyOn(room, 'topicList');
    room.post(topic, { own: false, html: '' }, '');
    expect(builds).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(builds).toHaveBeenCalledTimes(1);
  });

  it('keeps announcing across windows while events keep coming', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.react(topic, msg.id, '👀', true); // 0 ms: opens the first window
    vi.advanceTimersByTime(250);
    room.react(topic, msg.id, '👀', false); // 250 ms: rides along
    vi.advanceTimersByTime(300); // the first window fired at 300
    expect(listEvents(seen)).toHaveLength(1);
    room.react(topic, msg.id, '👀', true); // 550 ms: opens the second
    vi.advanceTimersByTime(300);
    expect(listEvents(seen)).toHaveLength(2);
  });

  it('never writes last to the topic file', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const file = path.join(dir, 'rows.json');
    const store = new TopicStore(file);
    const room = new WebRoom(instance(), store);
    const topic = store.current().id;
    room.post(topic, { own: false, html: '' }, '');
    // `touch` gathers its write for TOUCH_WRITE_MS; wait it out and read what a restart would.
    vi.advanceTimersByTime(1_000);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(saved[topic]?.lastAt).toBe(1_000_000);
    expect(saved[topic]).not.toHaveProperty('last');
  });

  it('drops a pending announcement at shutdown', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.react(topic, msg.id, '👀', true);
    room.dispose();
    vi.advanceTimersByTime(1_000);
    expect(listEvents(seen)).toHaveLength(0);
  });
});

describe('WebRoom: held edits', () => {
  it('does not announce an edit immediately', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'one');
    room.revise(topic, msg.id, 'one two');
    expect(seen).toHaveLength(0);
  });

  it('announces once, with the newest text, after it settles', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'one');
    room.revise(topic, msg.id, 'one two');
    room.revise(topic, msg.id, 'one two three');
    vi.advanceTimersByTime(1_600);
    expect(seen).toHaveLength(1);
    // The queue holds the id, not a snapshot, so what goes out is the newest state rather than
    // whichever revision happened to be enqueued first.
    expect(last(seen)).toMatchObject({ t: 'msg', msg: { html: '<p>one two three</p>' } });
  });

  it('re-arms while a reply keeps streaming, but never holds past the cap', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    // A reply flushing at the daemon's own 1.2s cadence would re-arm a 1.5s settle forever;
    // the cap is what keeps the page from looking frozen through a long answer.
    for (let i = 0; i < 10; i += 1) {
      room.revise(topic, msg.id, `chunk ${i}`);
      vi.advanceTimersByTime(1_200);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(5);
  });

  it.each([
    ['a new message', (r: WebRoom, t: string) => void r.post(t, { own: false, html: '' }, '')],
    ['a reaction', (r: WebRoom, t: string, id: string) => r.react(t, id, '✅', true)],
    ['typing', (r: WebRoom, t: string) => r.setTyping(t, true)],
    ['a delete', (r: WebRoom, t: string, id: string) => r.remove(t, id)],
  ])('flushes what is held before %s, so the page reads in order', (_label, act) => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'the held edit');
    act(room, topic, msg.id);
    // The held edit must be the FIRST thing out, not the last: a tool bubble whose final state
    // arrives below the text that followed it is the scrambled transcript
    // `daemon/render-order.test.ts` exists for, one layer up.
    expect(seen[0]?.ev).toMatchObject({ t: 'msg', msg: { id: msg.id, html: '<p>the held edit</p>' } });
    expect(seen.length).toBeGreaterThan(1);
  });

  it('sends what is held when the daemon shuts down', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'last words');
    room.dispose();
    expect(last(seen)).toMatchObject({ t: 'msg', msg: { html: '<p>last words</p>' } });
  });
});

describe('WebRoom: resuming a dropped stream', () => {
  it('numbers events per topic and lets a client resume from the last it saw', () => {
    const { room, topic, seen, off } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const identified = seen.filter((s) => s.id !== '');
    const lastId = identified[identified.length - 1]?.id ?? '';
    expect(lastId).toMatch(new RegExp(`^${topic}\\.[0-9a-z]+\\.\\d+$`));
    off();

    room.post(topic, { own: false, html: '<p>two</p>' }, 'two');
    room.post(topic, { own: false, html: '<p>three</p>' }, 'three');

    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    // Only what was missed — not the whole conversation, which is what this used to cost on
    // every network blip.
    expect(kinds(resumed).filter((k) => k === 'sync')).toEqual([]);
    expect(resumed.filter((s) => s.ev.t === 'msg')).toHaveLength(2);
  });

  it('gives the cross-topic list event no id, so it cannot move a resume point', () => {
    // The list is the one thing that crosses rooms, so it is in no topic's backlog and nothing
    // could be resumed from it. A browser only advances Last-Event-ID when it sees an `id:`
    // field, so leaving it off keeps the resume point pointing at the last event that IS
    // replayable — numbering it would silently break the resume it looks like it enables.
    const { room, seen } = attached();
    seen.length = 0;
    room.createTopic('another');
    expect(seen.map((s) => [s.ev.t, s.id])).toEqual([['topic-rows', '']]);
  });

  it('falls back to a full sync when it has nothing to resume from', () => {
    const { room, topic, seen: first } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const real = first.filter((s) => s.id).pop()?.id ?? '';
    const [, run, seq] = real.split('.');
    for (const lastId of [
      undefined,
      'garbage',
      `${topic}.${run}.notanumber`,
      `someothertopic.${run}.1`,
      // The shape ids had before they named their process: a page from before the upgrade.
      `${topic}.${seq}`,
      // Further on than this room has ever been.
      `${topic}.${run}.${Number(seq) + 5}`,
    ]) {
      const seen: Seen[] = [];
      room.subscribe(topic, (id, ev) => seen.push({ id, ev }), lastId);
      expect(seen[0]?.ev.t).toBe('sync');
    }
  });

  it('falls back to a full sync rather than handing over a transcript with a hole in it', () => {
    const { room, topic, seen: first } = attached();
    room.post(topic, { own: false, html: '' }, '');
    const early = first.filter((s) => s.id).pop()?.id;
    // Further back than the backlog keeps: the gap cannot be filled, and pretending otherwise
    // would silently drop messages out of the middle of the conversation.
    for (let i = 0; i < 400; i += 1) room.post(topic, { own: false, html: '' }, '');
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }), early);
    expect(seen[0]?.ev.t).toBe('sync');
  });

  it('answers a resume point from the process before a restart with a full sync, not with nothing', () => {
    // The crash path: no `bye`, so EventSource reconnects by itself and sends back the id it last
    // saw — from a process that is gone. The new one's numbering starts again at 1 and its backlog
    // is empty, which read as "nothing missed": the page was handed no sync and kept a transcript
    // the new process had never seen, with nothing on screen to say so.
    vi.useFakeTimers({ now: new Date('2026-11-10T08:00:00Z') });
    const file = path.join(dir, 'restart.json');
    const store = new TopicStore(file);
    const topic = store.current().id;
    const before = new WebRoom(instance(), store);
    const seen: Seen[] = [];
    before.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    for (let i = 0; i < 5; i++) before.post(topic, { own: false, html: `<p>m${i}</p>` }, `m${i}`);
    const lastId = seen.filter((s) => s.id).pop()?.id;
    before.dispose();

    vi.setSystemTime(new Date('2026-11-10T08:00:07Z'));
    const after = new WebRoom(instance(), new TopicStore(file));
    // Even one that has since said MORE than the old process had: the old id's number is reached
    // again, and only the run tells the two apart.
    for (let i = 0; i < 8; i++) after.post(topic, { own: false, html: `<p>n${i}</p>` }, `n${i}`);
    const resumed: Seen[] = [];
    after.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    expect(resumed[0]?.ev).toMatchObject({ t: 'sync', topic });
    expect((resumed[0]?.ev as { messages: unknown[] }).messages).toHaveLength(8);
    after.dispose();
  });

  it('a sync carries the topic it is for, its messages, and the topic list', () => {
    const { room, topic } = attached();
    room.post(topic, { own: false, html: '<p>x</p>' }, 'x');
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    expect(seen[0]?.ev).toMatchObject({ t: 'sync', topic, messages: [{ html: '<p>x</p>' }] });
    expect((seen[0]?.ev as { topics: unknown[] }).topics).toHaveLength(1);
  });

  it('a sync says which run of the daemon its ids belong to', () => {
    // Ids are counted per process and start again at w1, and the page caches transcripts across
    // restarts — so without a generation to compare, a cached w1 and a fresh w1 are the same
    // message to it, and the first reply after a restart overwrites what it kept.
    const { room, topic } = attached();
    const first: Seen[] = [];
    room.subscribe(topic, (id, ev) => first.push({ id, ev }));
    const epoch = (first[0]?.ev as { epoch: number }).epoch;
    expect(typeof epoch).toBe('number');
    // Stable for the life of one room, and different for the one that replaces it.
    const again: Seen[] = [];
    room.subscribe(topic, (id, ev) => again.push({ id, ev }));
    expect((again[0]?.ev as { epoch: number }).epoch).toBe(epoch);
  });

  it('replays a message edited five times once, with its last body, where it first appeared', () => {
    vi.useFakeTimers();
    const { room, topic, seen, off } = attached();
    const edited = room.post(topic, { own: false, html: '<p>v0</p>' }, 'v0');
    const other = room.post(topic, { own: false, html: '<p>other</p>' }, 'other');
    const lastId = seen.filter((s) => s.id).at(-1)?.id ?? '';
    off();
    for (let i = 1; i <= 5; i += 1) {
      room.revise(topic, edited.id, `v${i}`);
      vi.advanceTimersByTime(1_500);
    }
    room.react(topic, other.id, '👀', true);

    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    const replay = resumed.filter((s) => s.id);
    // Five edits of one message are five backlog entries and one event on the wire, ahead of the
    // reaction that came after them.
    expect(replay.map((s) => s.ev.t)).toEqual(['msg', 'react']);
    expect(replay[0]?.ev).toMatchObject({ t: 'msg', msg: { id: edited.id, html: '<p>v5</p>' } });
    // The page resumes from the last id it was handed, so that one has to be the room's newest.
    expect(replay.at(-1)?.id).toBe(room.snapshot(topic)?.last);
    expect(room.topicList().find((t) => t.id === topic)?.last).toBe(room.snapshot(topic)?.last);
  });

  it('ends the replay on the room’s newest number when the last event was folded back', () => {
    vi.useFakeTimers();
    const { room, topic, seen, off } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    const lastId = seen.filter((s) => s.id).at(-1)?.id ?? '';
    off();
    for (let i = 1; i <= 5; i += 1) {
      room.revise(topic, msg.id, `v${i}`);
      vi.advanceTimersByTime(1_500);
    }
    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    const replay = resumed.filter((s) => s.id);
    expect(replay).toHaveLength(1);
    expect(replay[0]?.ev).toMatchObject({ t: 'msg', msg: { id: msg.id, html: '<p>v5</p>' } });
    // Its place is where it first appeared, but its number is the room's latest — otherwise the
    // page would sit on a resume point five events behind and look caught up.
    expect(replay[0]?.id).toBe(room.snapshot(topic)?.last);
  });

  it('leaves a deletion and a reaction in their places, in order', () => {
    vi.useFakeTimers();
    const { room, topic, seen, off } = attached();
    const a = room.post(topic, { own: false, html: '<p>a</p>' }, 'a');
    const b = room.post(topic, { own: false, html: '<p>b</p>' }, 'b');
    const lastId = seen.filter((s) => s.id).at(-1)?.id ?? '';
    off();
    room.revise(topic, a.id, 'a2');
    vi.advanceTimersByTime(1_500);
    room.remove(topic, b.id);
    room.react(topic, a.id, '👀', true);

    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    const replay = resumed.filter((s) => s.id);
    expect(replay.map((s) => s.ev.t)).toEqual(['msg', 'del', 'react']);
    expect(replay[0]?.ev).toMatchObject({ msg: { id: a.id, html: '<p>a2</p>' } });
    expect(replay[1]?.ev).toMatchObject({ t: 'del', id: b.id });
    expect(replay[2]?.ev).toMatchObject({ t: 'react', id: a.id, on: true });
  });

  it('replays a deletion that names the message whose edits it folded', () => {
    vi.useFakeTimers();
    const { room, topic, seen, off } = attached();
    const doomed = room.post(topic, { own: false, html: '<p>v0</p>' }, 'v0');
    const lastId = seen.filter((s) => s.id).at(-1)?.id ?? '';
    off();
    for (let i = 1; i <= 3; i += 1) {
      room.revise(topic, doomed.id, `v${i}`);
      vi.advanceTimersByTime(1_500);
    }
    room.remove(topic, doomed.id);

    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    const replay = resumed.filter((s) => s.id);
    // The folded message stays where it first appeared and the deletion follows it, so applying
    // the replay in order ends where the room is: the message gone.
    expect(replay.map((s) => s.ev.t)).toEqual(['msg', 'del']);
    expect(replay[0]?.ev).toMatchObject({ msg: { id: doomed.id, html: '<p>v3</p>' } });
    expect(replay[1]?.ev).toMatchObject({ t: 'del', id: doomed.id });
  });

  it('resumes with nothing to replay when the client is already at the room’s position', () => {
    const { room, topic, seen, off } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const lastId = seen.filter((s) => s.id).at(-1)?.id ?? '';
    off();
    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    // Nothing to fold and nothing missed: no sync, no message, just the state a backlog cannot
    // hold and the marker that says the resume is over.
    expect(kinds(resumed)).not.toContain('sync');
    expect(resumed.filter((s) => s.ev.t === 'msg')).toHaveLength(0);
    expect(kinds(resumed).at(-1)).toBe('resumed');
  });
});

describe('mergeReplay', () => {
  const message = (id: string, html = id): WebEvent => ({
    t: 'msg',
    msg: { id, own: false, html, at: 0, buttons: [], reactions: [] },
  });
  const at = (seq: number, ev: WebEvent): { seq: number; ev: WebEvent } => ({ seq, ev });

  it('keeps one copy of a message, at its first place, with its last body', () => {
    const merged = mergeReplay([
      at(1, message('w1', 'v1')),
      at(2, message('w2')),
      at(3, message('w1', 'v2')),
      at(4, { t: 'react', id: 'w2', emoji: '👀', on: true }),
      at(5, message('w1', 'v3')),
    ]);
    expect(merged.map((e) => [e.seq, e.ev.t])).toEqual([[1, 'msg'], [2, 'msg'], [5, 'react']]);
    expect(merged[0]?.ev).toMatchObject({ msg: { id: 'w1', html: 'v3' } });
    // The tail carries the newest number — the reaction keeps its place but moves up to it — and
    // nothing moves backwards.
    expect(merged.at(-1)?.seq).toBe(5);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 5]);
  });

  it('keeps a reaction that landed between two copies of one message', () => {
    const merged = mergeReplay([
      at(1, message('w1', 'v1')),
      at(2, { t: 'react', id: 'w1', emoji: '👀', on: true }),
      at(3, message('w1', 'v2')),
    ]);
    // The message keeps its first place with its last body; the reaction stays where it was, and
    // being last it carries the newest number. The body already includes the reaction, so
    // applying it again is idempotent.
    expect(merged.map((e) => [e.seq, e.ev.t])).toEqual([[1, 'msg'], [3, 'react']]);
    expect(merged[0]?.ev).toMatchObject({ msg: { id: 'w1', html: 'v2' } });
    expect(merged[1]?.ev).toMatchObject({ t: 'react', id: 'w1', on: true });
  });

  it('keeps a deletion that names the folded message, after it', () => {
    const merged = mergeReplay([
      at(1, message('w1', 'v1')),
      at(2, message('w1', 'v2')),
      at(3, { t: 'del', id: 'w1' }),
    ]);
    // The page applies these in order and ends where the room is: the message gone.
    expect(merged.map((e) => [e.seq, e.ev.t])).toEqual([[1, 'msg'], [3, 'del']]);
    expect(merged[0]?.ev).toMatchObject({ msg: { id: 'w1', html: 'v2' } });
    expect(merged[1]?.ev).toMatchObject({ t: 'del', id: 'w1' });
  });

  it('leaves a replay of one event alone', () => {
    const entries = [at(4, message('w1', 'only'))];
    expect(mergeReplay(entries)).toEqual(entries);
  });

  it('leaves a replay with nothing to fold exactly as it was', () => {
    const entries = [at(1, message('w1')), at(2, { t: 'del', id: 'w1' }), at(3, { t: 'typing', on: false })];
    expect(mergeReplay(entries)).toEqual(entries);
  });

  it('is empty for an empty replay', () => {
    expect(mergeReplay([])).toEqual([]);
  });
});

describe('WebRoom: a topic handed over without attaching', () => {
  it('gives the whole room and leaves no trace: no subscriber, no list event', () => {
    const { room, topic, seen } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    room.post(topic, { own: true, html: '<p>two</p>' }, 'two');
    seen.length = 0;

    const snap = room.snapshot(topic);

    expect(snap?.topic).toBe(topic);
    expect(typeof snap?.epoch).toBe('number');
    expect(snap?.messages.map((m) => m.html)).toEqual(['<p>one</p>', '<p>two</p>']);
    expect(snap?.last).toMatch(new RegExp(`^${topic}\\.[0-9a-z]+\\.\\d+$`));
    // Read-only in the strong sense: nobody was attached, so nothing was announced to the client
    // already watching, and the room is exactly as the snapshot found it.
    expect(seen).toEqual([]);
    expect(room.watchers).toBe(1);
    expect(snap?.stale).toBeUndefined();
  });

  it('numbers its last id so the stream can be resumed from it', () => {
    const { room, topic } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const snap = room.snapshot(topic);
    expect(snap).toBeDefined();
    room.post(topic, { own: false, html: '<p>two</p>' }, 'two');
    room.post(topic, { own: false, html: '<p>three</p>' }, 'three');

    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), snap?.last);
    // The snapshot is the sync the page never had to wait for: what follows is only what was said
    // after it, never the whole topic again.
    expect(kinds(resumed).filter((k) => k === 'sync')).toEqual([]);
    expect(resumed.filter((s) => s.ev.t === 'msg')).toHaveLength(2);
  });

  it('answers nothing for a topic the store does not have', () => {
    const { room } = attached();
    expect(room.snapshot('deadbeef')).toBeUndefined();
    expect(room.snapshot('not-a-topic')).toBeUndefined();
  });

  it('leaves the seen mark and the stage exactly where they were', () => {
    // A fetch nobody is waiting on is not the person looking: if it marked the topic seen, the
    // green row would go grey before it was ever opened.
    const { room, topic } = attached();
    room.post(topic, { own: false, html: '<p>x</p>' }, 'x');
    room.setActivity(topic, { outcome: { kind: 'done', at: Date.now(), line: 'done' } });
    expect(room.topicList().find((t) => t.id === topic)?.stage).toBe('review');
    room.markSeen(topic);
    const before = room.topicList().find((t) => t.id === topic);

    room.snapshot(topic);

    const after = room.topicList().find((t) => t.id === topic);
    expect(after?.seenAt).toBe(before?.seenAt);
    expect(after?.stage).toBe(before?.stage);
    expect(after?.stage).toBe('idle');
  });

  it('calls an empty topic from before this process stale, without creating a room for it', () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T08:00:00Z') });
    const file = path.join(dir, 'stale.json');
    const store = new TopicStore(file);
    const topic = store.current().id;
    // A daemon that started after the topic was last active: the transcript was not kept, and the
    // page has to be told that rather than shown a blank panel.
    vi.setSystemTime(new Date('2026-11-10T08:00:05Z'));
    const room = new WebRoom(instance(), store);
    expect(room.snapshot(topic)).toMatchObject({ topic, messages: [], stale: true });
    room.dispose();
  });
});

describe('WebRoom: a topic older than the process', () => {
  // A transcript is memory; the topic LIST is a file. So every restart leaves rows that open
  // onto nothing, and a page that renders that faithfully looks broken rather than empty — which
  // is exactly how it was reported. The sync says which of the two it is.
  it('flags an empty room whose last activity predates this process', () => {
    const store = new TopicStore(path.join(dir, 'stale.json'));
    const old = store.create('from before');
    // Persisted by a daemon that is now gone; this WebRoom is built after it.
    store.touch(old.id, Date.now() - 60_000);
    const room = new WebRoom(instance(), store);

    const seen: Seen[] = [];
    room.subscribe(old.id, (id, ev) => seen.push({ id, ev }));

    expect(seen[0]?.ev).toMatchObject({ t: 'sync', topic: old.id, messages: [], stale: true });
  });

  it('says nothing about a topic that is merely new, or one that has something in it', () => {
    const { room, topic } = attached();
    const fresh: Seen[] = [];
    room.subscribe(topic, (id, ev) => fresh.push({ id, ev }));
    // Created by this process, so its emptiness needs no explaining — and explaining a restart
    // here would be the first thing a new install ever read.
    expect(fresh[0]?.ev).not.toHaveProperty('stale');

    const store = new TopicStore(path.join(dir, 'spoken.json'));
    const old = store.create('from before');
    store.touch(old.id, Date.now() - 60_000);
    const reopened = new WebRoom(instance(), store);
    reopened.post(old.id, { own: false, html: '<p>said since</p>' }, 'said since');
    const seen: Seen[] = [];
    reopened.subscribe(old.id, (id, ev) => seen.push({ id, ev }));
    expect(seen[0]?.ev).not.toHaveProperty('stale');
  });
});

describe('WebRoom: a topic keeps its transcript across a restart', () => {
  /** A TranscriptStore in memory: what a file per topic would hold, and every call made of it. */
  const memory = (): TranscriptStore & { kept: Map<string, Kept[]>; saves: string[] } => {
    const kept = new Map<string, Kept[]>();
    const saves: string[] = [];
    return {
      kept,
      saves,
      load: () => new Map([...kept].map(([k, v]) => [k, structuredClone(v)])),
      save: (topicId, messages) => {
        saves.push(topicId);
        kept.set(topicId, structuredClone(messages));
        return Promise.resolve();
      },
      saveNow: (topicId, messages) => {
        saves.push(topicId);
        kept.set(topicId, structuredClone(messages));
      },
      drop: (topicId) => void kept.delete(topicId),
    };
  };
  const syncOf = (room: WebRoom, topic: string): Extract<WebEvent, { t: 'sync' }> => {
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    return seen[0]!.ev as Extract<WebEvent, { t: 'sync' }>;
  };

  it('comes back as the run it was said in, with no buttons, and the room is not stale', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const file = path.join(dir, 'kept.json');
    const disk = memory();
    const before = new WebRoom(instance(), new TopicStore(file));
    before.useTranscripts(disk);
    const topic = before.topics.create('worth keeping').id;
    before.post(topic, { own: true, html: '<p>a question</p>', nonce: 'n1' }, 'a question');
    before.post(topic, { own: false, html: '<p>pick one</p>', buttons: [{ id: 'b:yes', label: 'Yes' }] }, 'pick one');
    const epoch = syncOf(before, topic).epoch;
    // Shutdown, which writes whatever the timer has not yet.
    before.dispose();

    vi.setSystemTime(2_000_000);
    const after = new WebRoom(instance(), new TopicStore(file));
    after.useTranscripts(disk);
    const sync = syncOf(after, topic);

    expect(sync.epoch).not.toBe(epoch);
    expect(sync.messages.map((m) => [m.html, m.g, m.buttons])).toEqual([
      ['<p>a question</p>', epoch, []],
      ['<p>pick one</p>', epoch, []],
    ]);
    // Its echo still names the send it answered, which is how a message the page restored as
    // unconfirmed finds out it did arrive.
    expect(sync.messages[0]?.nonce).toBe('n1');
    expect(sync).not.toHaveProperty('stale');
    // And the agent can read it back.
    expect(after.history(topic, {}).map((m) => m.content)).toEqual(['a question', 'pick one']);
  });

  it('starts its ids past the kept ones, so a new message cannot overwrite one', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const file = path.join(dir, 'ids.json');
    const disk = memory();
    const before = new WebRoom(instance(), new TopicStore(file));
    before.useTranscripts(disk);
    const topic = before.topics.create('ids').id;
    for (const t of ['one', 'two', 'three']) before.post(topic, { own: false, html: `<p>${t}</p>` }, t);
    before.dispose();

    vi.setSystemTime(2_000_000);
    const after = new WebRoom(instance(), new TopicStore(file));
    after.useTranscripts(disk);
    const fresh = after.post(topic, { own: false, html: '<p>four</p>' }, 'four');

    expect(['w1', 'w2', 'w3']).not.toContain(fresh.id);
    expect(syncOf(after, topic).messages.map((m) => m.html)).toEqual(['<p>one</p>', '<p>two</p>', '<p>three</p>', '<p>four</p>']);
  });

  it('keeps each message under the run it was said in, through more than one restart', () => {
    // Re-saved by the second run, a first-run message must still say first run: the page's cache
    // keys it that way, and a message re-marked as the second run's would be drawn twice.
    vi.useFakeTimers({ now: 1_000_000 });
    const file = path.join(dir, 'twice.json');
    const disk = memory();
    const one = new WebRoom(instance(), new TopicStore(file));
    one.useTranscripts(disk);
    const topic = one.topics.create('twice').id;
    one.post(topic, { own: false, html: '<p>first run</p>' }, 'first run');
    const e1 = syncOf(one, topic).epoch;
    one.dispose();

    vi.setSystemTime(2_000_000);
    const two = new WebRoom(instance(), new TopicStore(file));
    two.useTranscripts(disk);
    two.post(topic, { own: false, html: '<p>second run</p>' }, 'second run');
    const e2 = syncOf(two, topic).epoch;
    two.dispose();

    vi.setSystemTime(3_000_000);
    const three = new WebRoom(instance(), new TopicStore(file));
    three.useTranscripts(disk);
    expect(syncOf(three, topic).messages.map((m) => [m.html, m.g])).toEqual([
      ['<p>first run</p>', e1],
      ['<p>second run</p>', e2],
    ]);
  });

  it('writes a topic within seconds of a new message', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const disk = memory();
    const room = new WebRoom(instance(), new TopicStore(path.join(dir, 'posted.json')));
    room.useTranscripts(disk);
    const topic = room.topics.create('posted').id;
    vi.advanceTimersByTime(10_000);

    room.post(topic, { own: false, html: '<p>news</p>' }, 'news');
    vi.advanceTimersByTime(3_000);
    expect(disk.kept.get(topic)?.map((k) => k.text)).toEqual(['news']);
  });

  it('writes a topic within seconds of a change, not only at shutdown', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const disk = memory();
    const room = new WebRoom(instance(), new TopicStore(path.join(dir, 'often.json')));
    room.useTranscripts(disk);
    const topic = room.topics.create('streaming').id;
    const msg = room.post(topic, { own: false, html: '<p>a</p>' }, 'a');
    // A reply streaming for longer than the window is still written inside it: the first change
    // arms the write and later ones ride along, rather than each pushing it back.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1_000);
      room.revise(topic, msg.id, `a${'b'.repeat(i)}`);
    }
    expect(disk.saves.length).toBeGreaterThanOrEqual(1);
    expect(disk.saves.length).toBeLessThanOrEqual(2);
  });

  it('keeps what was said after every page stopped listening, in a topic nobody starred', () => {
    // Reported on 2026-10-31: a phone put down at 13:03, the reply finished at 13:04, an update at
    // 13:11 — and the page came back stopped halfway through the turn. Only this process had heard
    // the rest, and before every topic was kept, only a starred one survived it.
    vi.useFakeTimers({ now: 1_000_000 });
    const file = path.join(dir, 'unheard.json');
    const disk = memory();
    const before = new WebRoom(instance(), new TopicStore(file));
    before.useTranscripts(disk);
    const topic = before.topics.create('not starred').id;
    const off = before.subscribe(topic, () => {});
    const tool = before.post(topic, { own: false, html: '<p>getent</p>' }, 'getent');
    off();
    before.revise(topic, tool.id, 'getent ✓');
    before.post(topic, { own: false, html: '<p>the answer</p>' }, 'the answer');
    // No shutdown write to lean on: the update came minutes later, and found it all on disk.
    vi.advanceTimersByTime(7 * 60_000);

    const after = new WebRoom(instance(), new TopicStore(file));
    after.useTranscripts(disk);
    expect(after.history(topic, {}).map((m) => m.content)).toEqual(['getent ✓', 'the answer']);
    expect(syncOf(after, topic).messages).toHaveLength(2);
  });

  it('keeps a topic whether or not it is starred, and lets go of one deleted or swept', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const disk = memory();
    const room = new WebRoom(instance(), new TopicStore(path.join(dir, 'which.json')));
    room.useTranscripts(disk);
    const plain = room.topics.create('plain').id;
    const starred = room.topics.create('starred').id;
    const deleted = room.topics.create('deleted').id;
    room.starTopic(starred, true);
    for (const t of [plain, starred, deleted]) room.post(t, { own: false, html: '<p>x</p>' }, 'x');
    // Deleted with its write still pending: the write must not bring the file back.
    room.deleteTopic(deleted);
    vi.advanceTimersByTime(5_000);
    expect([...disk.kept.keys()].sort()).toEqual([plain, starred].sort());

    // A star no longer decides what is kept, so taking one off keeps the file.
    room.starTopic(starred, false);
    expect(disk.kept.has(starred)).toBe(true);
    // A sweep takes the unstarred topics, and their files with them.
    room.starTopic(starred, true);
    room.post(plain, { own: false, html: '<p>y</p>' }, 'y');
    room.clearTopics();
    room.dispose();
    expect([...disk.kept.keys()]).toEqual([starred]);
  });

  it('writes at exit a topic whose background write had not landed yet', () => {
    // The background write is handed over and forgotten: the topic is no longer "changed". If the
    // daemon stops before that write lands, the exit write must still cover it, or the topic is
    // left at the copy before it.
    vi.useFakeTimers({ now: 1_000_000 });
    const disk = memory();
    const landed: string[] = [];
    const room = new WebRoom(instance(), new TopicStore(path.join(dir, 'slow.json')));
    room.useTranscripts({ ...disk, save: (topicId) => ((landed.push(topicId), new Promise<void>(() => {}))) });
    const topic = room.topics.create('slow disk').id;
    room.post(topic, { own: false, html: '<p>the reply</p>' }, 'the reply');
    vi.advanceTimersByTime(3_000);
    expect(landed).toEqual([topic]);
    expect(disk.kept.has(topic)).toBe(false);

    room.dispose();
    expect(disk.kept.get(topic)?.map((k) => k.text)).toEqual(['the reply']);
  });

  it('throws away a kept transcript whose topic is gone when it comes back, and restores the rest', () => {
    const disk = memory();
    const store = new TopicStore(path.join(dir, 'orphan.json'));
    const topic = store.create('never starred').id;
    disk.kept.set(topic, [{ text: 'x', msg: { id: 'w1', own: false, html: '<p>x</p>', at: 1, g: 1, buttons: [], reactions: [] } }]);
    disk.kept.set('deadbeef', [{ text: 'y', msg: { id: 'w2', own: false, html: '<p>y</p>', at: 1, g: 1, buttons: [], reactions: [] } }]);

    const room = new WebRoom(instance(), store);
    room.useTranscripts(disk);

    expect([...disk.kept.keys()]).toEqual([topic]);
    expect(syncOf(room, topic).messages.map((m) => m.html)).toEqual(['<p>x</p>']);
  });
});

describe('WebRoom: inbound', () => {
  it('echoes the operator message and hands the daemon the SAME id', () => {
    // They must match: the daemon reacts on the inbound id (👀 / ✅), and a mismatch would
    // leave every lifecycle reaction pointing at a message the page does not hold.
    const { room, topic, seen } = attached();
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    room.submit({ topic, text: 'hello' });
    const echoed = seen.filter((s) => s.ev.t === 'msg').pop()?.ev as { msg: { id: string; own: boolean } };
    expect(echoed.msg.own).toBe(true);
    expect(got[0]?.messageId).toBe(echoed.msg.id);
  });

  it('echoes what the operator typed verbatim, not as rendered markdown', () => {
    // A prompt is checked against the compose box, so the echo has to be the same characters.
    // Rendered, this list came back numbered "1." twice — the "-ce" line is not an item, so it
    // ends the first list and "2." opened a second one that renumbered from 1.
    const { room, topic, seen } = attached();
    const text = '1. sada\n- ces1\n-ce 2\n2. test3';
    room.submit({ topic, text });
    const echoed = seen.filter((s) => s.ev.t === 'msg').pop()?.ev as { msg: { html: string } };
    expect(echoed.msg.html).toBe(`<div class="raw">${text}</div>`);
  });

  it('escapes the operator message it does not render', () => {
    const { room, topic, seen } = attached();
    room.submit({ topic, text: '<img src=x onerror=alert(1)>' });
    const echoed = seen.filter((s) => s.ev.t === 'msg').pop()?.ev as { msg: { html: string } };
    expect(echoed.msg.html).not.toContain('<img');
    expect(echoed.msg.html).toContain('&lt;img');
  });

  it('delivers a retried send exactly once', () => {
    // The nonce is what makes the page's retry safe on a bad link: a request can be accepted
    // and still time out, and the daemon's own dedup cannot help — it keys on a message id,
    // and a retry mints a fresh one.
    const { room, topic } = attached();
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    expect(room.submit({ topic, text: 'once', nonce: 'n1' })).toBe('accepted');
    expect(room.submit({ topic, text: 'once', nonce: 'n1' })).toBe('duplicate');
    expect(got).toHaveLength(1);
  });

  it('echoes the nonce back on the operator message, and only when one was sent', () => {
    // The page draws a message the moment it is typed. That local bubble is retired by the echo
    // that claims it, and this is what it claims it by — matching on the text would be a guess.
    const { room, topic } = attached();
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    room.submit({ topic, text: 'hello', nonce: 'n1' });
    room.submit({ topic, text: 'again' });
    const posted = seen.filter((s) => s.ev.t === 'msg').map((s) => (s.ev as { msg: WebMessage }).msg);
    expect(posted[0]?.nonce).toBe('n1');
    expect(posted[1]).not.toHaveProperty('nonce');
  });

  it('delivers a quiet command to the daemon without echoing it or naming the topic', () => {
    // The Settings menu asks for the screen it draws itself. The daemon needs the command, but a
    // control the operator pressed must not leave a bubble in the conversation — or a topic named
    // "/setting" — and the answer is a message of its own, so no echo is needed either.
    const { room, topic, seen } = attached();
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    expect(room.submit({ topic, text: '/setting', quiet: true })).toBe('accepted');
    expect(got).toHaveLength(1);
    expect(got[0]?.content).toBe('/setting');
    expect(got[0]?.messageId).toMatch(/^w\d+$/);
    expect(seen.filter((s) => s.ev.t === 'msg')).toHaveLength(0);
    expect(room.topics.get(topic)?.title).toBe('');
  });

  it('does not let any other text hide behind quiet', () => {
    // The flag is for the page's own settings request and nothing else. A client that sends
    // something else with it gets an ordinary message, echo and title included — a message the
    // operator wrote must not be able to vanish by asking.
    const { room, topic, seen } = attached();
    room.submit({ topic, text: 'hello', quiet: true });
    expect(seen.filter((s) => s.ev.t === 'msg')).toHaveLength(1);
    expect(room.topics.get(topic)?.title).toBe('hello');

    // `/setting` with arguments is not the bare request the menu makes, so it is not quiet either.
    room.submit({ topic, text: '/setting idle', quiet: true });
    expect(seen.filter((s) => s.ev.t === 'msg')).toHaveLength(2);
  });

  it('names a blank topic from the first thing said in it', () => {
    const { room, topic } = attached();
    room.submit({ topic, text: 'why is login timing out' });
    expect(room.topics.get(topic)?.title).toBe('why is login timing out');
  });

  it('turns an upload into a data: URL, the one shape the SSRF guard has a branch for', () => {
    const { room, topic } = attached();
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    room.submit({ topic, text: '', files: [{ name: 'a.png', mime: 'image/png', data: 'AAAA' }] });
    expect(got[0]?.attachments).toEqual([
      { type: 'image', url: 'data:image/png;base64,AAAA', name: 'a.png', mime: 'image/png' },
    ]);
  });

  it('writes how many files came with a message into the [in] line', () => {
    // The preview is the first 50 characters of the text, so before this a file sent alone logged
    // an empty line and "did it arrive with its attachment" could not be answered from the log.
    const { room, topic } = attached();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = { name: 'a.pdf', mime: 'application/pdf', data: 'AAAA' };

    room.submit({ topic, text: 'look at this', files: [file, file] });
    room.submit({ topic, text: '', files: [file] });
    room.submit({ topic, text: 'no files' });

    const lines = log.mock.calls.flat().filter((l) => String(l).startsWith('[in]')).map(String);
    expect(lines[0]).toMatch(/: look at this \(\+2 files\)$/);
    expect(lines[1]).toMatch(/:\s+\(\+1 file\)$/);
    expect(lines[2]).toMatch(/: no files$/);
  });

  /** An UploadStore that records instead of writing: paths are predictable, `ready` is already settled. */
  function fakeUploads(): UploadStore & {
    saved: Array<{ name: string; base64: string }>;
    copied: string[];
    discarded: string[];
  } {
    const saved: Array<{ name: string; base64: string }> = [];
    const copied: string[] = [];
    const discarded: string[] = [];
    return {
      saved,
      copied,
      discarded,
      save(name, base64) {
        saved.push({ name, base64 });
        return { path: `/uploads/${saved.length}-${name}`, ready: Promise.resolve() };
      },
      async copy(source) {
        if (source.includes('missing')) throw new Error(`ENOENT: no such file or directory, open '${source}'`);
        copied.push(source);
        return `/uploads/copy-${copied.length}`;
      },
      discard(p) {
        discarded.push(p);
      },
    };
  }

  /** The html of the last message the topic's subscriber was sent. */
  function lastHtml(seen: Seen[]): string {
    return (seen.filter((s) => s.ev.t === 'msg').pop()?.ev as { msg: WebMessage }).msg.html;
  }

  it('shows the pictures the operator sent, not just their names — the other files stay names', () => {
    const { room, topic } = attached();
    const uploads = fakeUploads();
    room.useUploads(uploads);
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    room.submit({
      topic,
      text: 'what is wrong here?',
      files: [
        { name: 'pasted-1.png', mime: 'image/png', data: 'iVBORw0K' },
        { name: 'notes.txt', mime: 'text/plain', data: 'aGk=' },
        { name: 'diagram.svg', mime: 'image/svg+xml', data: 'PHN2Zz4=' },
      ],
    });

    // Only the picture is kept: an .svg is code (inlineImageType), a .txt has nothing to draw.
    expect(uploads.saved).toEqual([{ name: 'pasted-1.png', base64: 'iVBORw0K' }]);
    const html = lastHtml(seen);
    const src = /<img class="shot" src="(f\/[0-9a-f]{32})" alt="pasted-1\.png" loading="lazy">/.exec(html)?.[1];
    expect(src).toBeDefined();
    expect(room.resolveDownload(src!.slice(2))).toMatchObject({ path: '/uploads/1-pasted-1.png', name: 'pasted-1.png', owned: true });
    // Every file keeps its name chip, the picture included: it is what is left once the file is gone.
    expect(html.match(/<span class="chip">[^<]*<\/span>/g)).toEqual([
      '<span class="chip">pasted-1.png</span>',
      '<span class="chip">notes.txt</span>',
      '<span class="chip">diagram.svg</span>',
    ]);
    // The path on disk never reaches the page.
    expect(html).not.toContain('/uploads/');
  });

  it('escapes a picture\'s name where it lands in an attribute', () => {
    const { room, topic } = attached();
    room.useUploads(fakeUploads());
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    room.submit({ topic, text: '', files: [{ name: '"><script>x</script>.png', mime: 'image/png', data: 'AAAA' }] });
    expect(lastHtml(seen)).not.toContain('<script>');
    expect(lastHtml(seen)).toContain('alt="&quot;&gt;&lt;script&gt;');
  });

  it('shows names only when nothing keeps the pictures', () => {
    const { room, topic } = attached();
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    room.submit({ topic, text: '', files: [{ name: 'a.png', mime: 'image/png', data: 'AAAA' }] });
    expect(lastHtml(seen)).not.toContain('<img');
    expect(lastHtml(seen)).toContain('<span class="chip">a.png</span>');
  });

  it('deletes a kept picture once the download table lets it go — and never a path it was handed', async () => {
    const { room, topic } = attached();
    const uploads = fakeUploads();
    room.useUploads(uploads);
    room.publish('/work/agent-shot.png', 'agent-shot.png');
    room.submit({ topic, text: '', files: [{ name: 'mine.png', mime: 'image/png', data: 'AAAA' }] });
    // Fill the table: each publish past its size evicts the oldest entry.
    for (let i = 0; i < 199; i++) room.publish(`/work/f${i}.txt`, `f${i}.txt`);
    expect(uploads.discarded).toEqual([]);
    room.publish('/work/next.txt', 'next.txt'); // evicts the path it was handed
    room.publish('/work/next2.txt', 'next2.txt'); // evicts the upload
    await Promise.resolve();
    await Promise.resolve();
    expect(uploads.discarded).toEqual(['/uploads/1-mine.png']);
  });

  it('serves a file the agent sent from a copy, which is deleted like an upload once evicted', async () => {
    // The agent's path may not outlive `sendFile`: a remote agent's file is a temporary one the
    // daemon removes as soon as the call returns. Serving the path itself made every such link a 404.
    const { room } = attached();
    const uploads = fakeUploads();
    room.useUploads(uploads);
    const url = await room.publishCopy('/tmp/fleetherd-file-x/report.pdf', 'report.pdf');
    expect(uploads.copied).toEqual(['/tmp/fleetherd-file-x/report.pdf']);
    expect(room.resolveDownload(url.slice(2))).toMatchObject({ path: '/uploads/copy-1', name: 'report.pdf', owned: true });
    for (let i = 0; i < 200; i++) room.publish(`/work/f${i}.txt`, `f${i}.txt`);
    await Promise.resolve();
    await Promise.resolve();
    expect(uploads.discarded).toEqual(['/uploads/copy-1']);
    // The agent's own file was only ever read.
    expect(uploads.discarded).not.toContain('/tmp/fleetherd-file-x/report.pdf');
  });

  it('refuses a file the agent sent that cannot be read, rather than publishing a link to nothing', async () => {
    // Not a link that 404s later: the agent is still waiting on its send-file and hears the error.
    const { room } = attached();
    const uploads = fakeUploads();
    room.useUploads(uploads);
    await expect(room.publishCopy('/work/missing.pdf', 'missing.pdf')).rejects.toThrow(/ENOENT/);
    expect(uploads.copied).toEqual([]);
  });

  it('publishes the agent\'s path itself when nothing keeps copies', async () => {
    const { room } = attached();
    const url = await room.publishCopy('/tmp/report.pdf', 'report.pdf');
    expect(room.resolveDownload(url.slice(2))).toEqual({ path: '/tmp/report.pdf', name: 'report.pdf' });
  });

  it('ignores an empty submission', () => {
    const { room, topic } = attached();
    const onMsg = vi.fn();
    room.onMessage(onMsg);
    expect(room.submit({ topic, text: '   ' })).toBe('accepted');
    expect(onMsg).not.toHaveBeenCalled();
  });

  it('forwards a click with the same conversation a message carries', () => {
    const { room, topic } = attached();
    const clicks: Array<{ conversation: unknown; buttonId: string }> = [];
    room.onButton((ev) => clicks.push(ev));
    const msg = room.post(topic, { own: false, html: '', buttons: [{ id: 'mdl:r:1', label: 'x' }] }, '');
    expect(room.click({ topic, messageId: msg.id, buttonId: 'mdl:r:1' })).toBe(true);
    // Identical to the message path, because `access.allowFrom` is re-checked on every menu
    // click as `<platform>:<user>` — a click carrying a different user is silently denied.
    expect(clicks[0]?.conversation).toMatchObject({ thread: topic, kind: 'direct', user: OWNER });
  });

  it('refuses a click naming a message the topic does not hold', () => {
    const { room, topic } = attached();
    const onBtn = vi.fn();
    room.onButton(onBtn);
    expect(room.click({ topic, messageId: 'nope', buttonId: 'ask:r:0' })).toBe(false);
    expect(onBtn).not.toHaveBeenCalled();
  });
});

describe('WebRoom: outbound basics', () => {
  it('accepts a message with nobody watching', () => {
    // The contract the whole adapter rests on: the ring is the conversation, the clients are a
    // fan-out of it. Failing here would fail every turn started before the page was opened.
    const store = new TopicStore(path.join(dir, 'n.json'));
    const room = new WebRoom(instance(), store);
    expect(() => room.post(store.current().id, { own: false, html: '' }, '')).not.toThrow();
  });

  it('mints ids that are unique across topics and never reused', () => {
    // Not cosmetic: the outbound pacer coalesces edits into `edit:<channel>:<messageId>`, and
    // every topic shares the one channel — ids restarting per topic would let one topic's
    // edits supersede another's.
    const store = new TopicStore(path.join(dir, 'u.json'));
    const room = new WebRoom(instance(), store);
    const a = store.create().id;
    const b = store.create().id;
    const ids = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      ids.add(room.post(a, { own: false, html: '' }, '').id);
      ids.add(room.post(b, { own: false, html: '' }, '').id);
    }
    expect(ids.size).toBe(600);
  });

  it('throws MessageNotEditableError for an id the topic no longer holds', () => {
    const { room, topic } = attached();
    expect(() => room.revise(topic, 'never-existed', 'x')).toThrow(MessageNotEditableError);
  });

  it('keeps a tool bubble a tool bubble through its edits', () => {
    // The kind arrives on the send only (SendOptions), and a bubble's whole life after that is
    // edits — another line, another ✓. Re-rendered as markdown on the first of them, the lines
    // would merge into one paragraph and the page would have nothing left to fold. Its glyphs are
    // the web UI's icons; a report's lines (below) are not tools and keep theirs.
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '', kind: 'tools' }, '');
    seen.length = 0;
    room.revise(topic, msg.id, '💻 Bash: "ls *.ts" ✓ 5ms\n📖 Read: "a_b_c.md"');
    vi.advanceTimersByTime(1_600);
    expect(lastOf(seen, 'msg')).toMatchObject({
      t: 'msg',
      msg: {
        kind: 'tools',
        html:
          '<div class="tools">' +
          `<div class="tl"><span class="tl-c">${icon('terminal')} Bash: &quot;ls *.ts&quot;</span><span class="tl-s"> ${icon('check')} 5ms</span></div>` +
          `<div class="tl"><span class="tl-c">${icon('book')} Read: &quot;a_b_c.md&quot;</span></div>` +
          '</div>',
      },
    });
  });

  it('keeps a report a report through its edits, rendered as rows so it stays foldable', () => {
    // A report is a line-based bubble like a tool one (a `[sub-agent updates]` card can be
    // edited as the burst it gathers grows before it is sent). Re-rendered as markdown, its
    // lines would merge into one paragraph and the page would have nothing left to fold.
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '', kind: 'report' }, '');
    seen.length = 0;
    room.revise(topic, msg.id, '🔔 part (cc) — finished: all green.\n🔔 other (cx) — finished: done.');
    vi.advanceTimersByTime(1_600);
    expect(lastOf(seen, 'msg')).toMatchObject({
      t: 'msg',
      msg: {
        kind: 'report',
        html:
          '<div class="tools">' +
          '<div class="tl"><span class="tl-c">🔔 part (cc) — finished: all green.</span></div>' +
          '<div class="tl"><span class="tl-c">🔔 other (cx) — finished: done.</span></div>' +
          '</div>',
      },
    });
  });

  it('strips buttons when handed an empty list, which is how every menu is retired', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '', buttons: [{ id: 'ask:r:0', label: 'Yes' }] }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'answered', []);
    expect((lastOf(seen, 'msg') as { msg: { buttons: unknown[] } }).msg.buttons).toEqual([]);
  });

  it('an edit carrying buttons goes out at once, unlike a text-only one', () => {
    // The page disables a button as it is clicked and re-enables it only when the message
    // repaints. Holding that repaint for the settle window leaves the control the user just
    // pressed dead in their hand — on a multi-select, for the whole 1.5s between two ticks.
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '', buttons: [{ id: 'ask:r:0', label: '☐ EU' }] }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'pick some', [{ id: 'ask:r:0', label: '☑ EU' }]);
    expect(seen).toHaveLength(1);
    expect((last(seen) as { msg: { buttons: Array<{ label: string }> } }).msg.buttons).toEqual([
      { id: 'ask:r:0', label: '☑ EU' },
    ]);
  });

  it('carries reactions on the message as well as announcing them, so a reload keeps them', () => {
    const { room, topic } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    room.react(topic, msg.id, '👀', true);
    room.react(topic, msg.id, '✅', true);
    room.react(topic, msg.id, '👀', false);
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    expect(seen[0]?.ev).toMatchObject({ t: 'sync', messages: [{ reactions: ['✅'] }] });
  });

  it('ignores a reaction on an unknown message, and a delete of one already gone', () => {
    const { room, topic } = attached();
    expect(() => room.react(topic, 'gone', '✅', true)).not.toThrow();
    expect(() => room.remove(topic, 'gone')).not.toThrow();
  });

  it('drops a client that throws rather than letting it take the turn down', () => {
    const store = new TopicStore(path.join(dir, 'd.json'));
    const room = new WebRoom(instance(), store);
    room.subscribe(store.current().id, () => {
      throw new Error('socket is gone');
    });
    expect(() => room.post(store.current().id, { own: false, html: '' }, '')).not.toThrow();
    expect(room.watchers).toBe(0);
  });

  it('returns the markdown it was given, not the html it rendered', () => {
    const { room, topic } = attached();
    room.post(topic, { own: false, html: '<p><strong>b</strong></p>' }, '**b**');
    expect(room.history(topic, {})[0]?.content).toBe('**b**');
  });

  it('honours limit and before, per topic', () => {
    const { room, topic } = attached();
    const ids = [1, 2, 3, 4].map((n) => room.post(topic, { own: false, html: '' }, `m${n}`).id);
    expect(room.history(topic, { limit: 2 }).map((m) => m.content)).toEqual(['m3', 'm4']);
    expect(room.history(topic, { before: ids[2] }).map((m) => m.content)).toEqual(['m1', 'm2']);
  });

  it('hands out an opaque, page-relative token for a file and resolves it back', () => {
    const { room } = attached();
    const url = room.publish('/tmp/report.pdf', 'report.pdf');
    expect(url).toMatch(/^f\/[0-9a-f]{32}$/);
    expect(url).not.toContain('tmp');
    expect(room.resolveDownload(url.slice(2))).toEqual({ path: '/tmp/report.pdf', name: 'report.pdf' });
  });
});

describe('WebRoom: which files may be shown instead of downloaded', () => {
  it.each([
    ['shot.png', 'image/png'],
    ['photo.JPG', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['anim.gif', 'image/gif'],
    ['pic.webp', 'image/webp'],
    ['pic.avif', 'image/avif'],
    ['old.bmp', 'image/bmp'],
    ['a.name.with.dots.png', 'image/png'],
  ])('shows %s as %s', (name, mime) => {
    expect(inlineImageType(name)).toBe(mime);
  });

  it.each([
    // The load-bearing one. An SVG is XML a browser runs as a document, so serving it as itself
    // would put a <script> on the origin holding this session's cookie — which is the whole
    // reason downloads are octet-stream in the first place.
    'diagram.svg',
    'page.html',
    // Rendered by browsers, and scriptable. Not worth the argument for an inline preview.
    'report.pdf',
    // No browser displays one, so inline would mean a broken image where a download worked.
    'scan.tiff',
    // The extension is the last one, not any of them: this is a download whatever it is named.
    'notes.png.html',
    'screenshot',
  ])('keeps %s a download', (name) => {
    expect(inlineImageType(name)).toBeUndefined();
  });
});

describe('WebRoom: which agents an empty topic could be given to', () => {
  const catalog = {
    current: 'cc',
    groups: [
      {
        name: 'devbox',
        agents: [
          { id: 'cc', harness: 'claude', kind: 'Claude Code' },
          { id: 'cx', harness: 'codex', kind: 'Codex' },
        ],
      },
    ],
  };

  it('rides on the sync of an empty room, asked at the address of that topic', () => {
    const { room, topic } = attached();
    const asked: Array<string | undefined> = [];
    room.useAgentCatalog((ref) => {
      asked.push(ref.thread);
      return catalog;
    });
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    expect(seen[0]?.ev).toMatchObject({ t: 'sync', messages: [], agents: catalog });
    expect(asked).toEqual([topic]);
  });

  it('is not asked for once anything is in the room: the transcript is the page from then on', () => {
    const { room, topic } = attached();
    let asked = 0;
    room.useAgentCatalog(() => {
      asked += 1;
      return catalog;
    });
    room.post(topic, { own: false, html: '<p>said</p>' }, 'said');
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    expect(seen[0]?.ev).not.toHaveProperty('agents');
    expect(asked).toBe(0);
  });

  it('leaves the field off when the daemon closes the question, or never offered a lookup', () => {
    const { room, topic } = attached();
    const before: Seen[] = [];
    room.subscribe(topic, (id, ev) => before.push({ id, ev }));
    expect(before[0]?.ev).not.toHaveProperty('agents');

    room.useAgentCatalog(() => undefined);
    const after: Seen[] = [];
    room.subscribe(topic, (id, ev) => after.push({ id, ev }));
    expect(after[0]?.ev).not.toHaveProperty('agents');
  });

  it('still syncs when the lookup throws: the choice is decoration, the sync is not', () => {
    const { room, topic } = attached();
    room.useAgentCatalog(() => {
      throw new Error('the config is gone');
    });
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    expect(seen[0]?.ev).toMatchObject({ t: 'sync', topic });
    expect(seen[0]?.ev).not.toHaveProperty('agents');
  });

  it('marks cwdChosen on sync after setupTopic confirms a directory (including root)', () => {
    const { room, topic } = attached();
    room.useAgentCatalog(() => ({ ...catalog, agentChosen: true }));
    room.useTopicSetup((_ref, opts) => ({ ok: true, agent: opts.agent ?? 'cc', cwd: opts.cwd ?? '/home/me/projects' }));

    const before: Seen[] = [];
    room.subscribe(topic, (id, ev) => before.push({ id, ev }));
    expect(before[0]?.ev).toMatchObject({ t: 'sync', agents: { current: 'cc', agentChosen: true } });
    expect((before[0]?.ev as { agents?: { cwdChosen?: boolean } }).agents?.cwdChosen).toBeUndefined();

    expect(room.setupTopic(topic, { agent: 'cc', cwd: '/home/me/projects' }).ok).toBe(true);
    const afterPick: Seen[] = [];
    room.subscribe(topic, (id, ev) => afterPick.push({ id, ev }));
    expect(afterPick[0]?.ev).toMatchObject({ t: 'sync', agents: { current: 'cc', agentChosen: true, cwdChosen: true } });

    // Switching agent without passing cwd clears the root-dir marker.
    expect(room.setupTopic(topic, { agent: 'oc' }).ok).toBe(true);
    const afterSwitch: Seen[] = [];
    room.subscribe(topic, (id, ev) => afterSwitch.push({ id, ev }));
    expect((afterSwitch[0]?.ev as { agents?: { cwdChosen?: boolean } }).agents?.cwdChosen).toBeUndefined();
  });
});

describe('WebRoom: which directory a topic is working in', () => {
  it('lists nothing at all when the daemon never offered a lookup', () => {
    // Every deployment that is not the daemon — the tests above, a future embedder — must keep
    // working, so the field is absent rather than empty.
    const { room, topic } = attached();
    expect(room.topicList().find((t) => t.id === topic)?.dir).toBeUndefined();
  });

  it('labels each topic with the last segment, keeping the full path for the tooltip', () => {
    const { room, topic } = attached();
    room.useWorkdirLookup((ref) => (ref.thread === topic ? { path: '/home/user/workspace/fleetherd' } : undefined));

    expect(room.topicList().find((t) => t.id === topic)?.dir).toEqual({
      name: 'fleetherd',
      path: '/home/user/workspace/fleetherd',
    });
  });

  it('carries the machine through when the daemon names one, and invents none when it does not', () => {
    const { room, topic } = attached();
    room.useWorkdirLookup(() => ({ path: '/home/user/workspace', host: 'devbox' }));
    expect(room.topicList().find((t) => t.id === topic)?.dir).toEqual({
      name: 'workspace',
      path: '/home/user/workspace',
      host: 'devbox',
    });

    // A local agent: the key is absent rather than empty, so the page has nothing to prefix.
    room.useWorkdirLookup(() => ({ path: '/home/user/workspace' }));
    expect(room.topicList().find((t) => t.id === topic)?.dir).toEqual({ name: 'workspace', path: '/home/user/workspace' });
  });

  it('carries the bound agent beside the directory, and none when the daemon names none', () => {
    // The row's legend and its colour come from here, not from the title's "[agent]".
    const { room, topic } = attached();
    room.useWorkdirLookup(() => ({ path: '/home/user/workspace', host: 'devbox', agent: { id: 'cbc@devbox', harness: 'custom' } }));
    const row = room.topicList().find((t) => t.id === topic);
    expect(row?.agent).toEqual({ id: 'cbc@devbox', harness: 'custom' });
    expect(row?.dir).toEqual({ name: 'workspace', path: '/home/user/workspace', host: 'devbox' });

    // Nothing bound yet: absent, not a guess.
    room.useWorkdirLookup(() => ({ path: '/home/user/workspace' }));
    expect(room.topicList().find((t) => t.id === topic)).not.toHaveProperty('agent');
  });

  it('announces an agent moving under the same directory, through the liveness poll', () => {
    // `/agent cx` in a topic whose directory stays put: the flags the poll compares must include the
    // agent, or the legend would name the old one until something else announced the list.
    vi.useFakeTimers();
    const { room, topic, seen, list } = attached();
    let agent = { id: 'cc', harness: 'claude' };
    room.useWorkdirLookup(() => ({ path: '/srv/a', agent }));
    room.useLivenessLookup(() => false);
    vi.advanceTimersByTime(60_000);
    seen.length = 0;

    agent = { id: 'cx', harness: 'codex' };
    vi.advanceTimersByTime(60_000);
    expect(listEvents(seen).length).toBeGreaterThan(0);
    expect(list().find((t) => t.id === topic)?.agent).toEqual({ id: 'cx', harness: 'codex' });
  });

  it('carries agent.canFork and announces when it becomes known on the liveness poll', () => {
    vi.useFakeTimers();
    const { room, topic, seen, list } = attached();
    let agent: { id: string; harness: string; canFork?: boolean } = { id: 'gt', harness: 'custom' };
    room.useWorkdirLookup(() => ({ path: '/srv/a', agent }));
    room.useLivenessLookup(() => false);
    vi.advanceTimersByTime(60_000);
    expect(list().find((t) => t.id === topic)?.agent).toEqual({ id: 'gt', harness: 'custom' });
    seen.length = 0;

    agent = { id: 'gt', harness: 'custom', canFork: false };
    vi.advanceTimersByTime(60_000);
    expect(listEvents(seen).length).toBeGreaterThan(0);
    expect(list().find((t) => t.id === topic)?.agent).toEqual({ id: 'gt', harness: 'custom', canFork: false });
  });

  it('asks the daemon at the address of the topic, not of the channel', () => {
    // The lookup crosses back into the conversation store, which separates lanes — handing it
    // the channel would give every topic the directory of whichever one happened to be first.
    const { room, topic } = attached();
    const asked: Array<string | undefined> = [];
    room.useWorkdirLookup((ref) => {
      asked.push(ref.thread);
      return { path: '/srv/project' };
    });

    room.topicList();

    expect(asked).toEqual([topic]);
  });

  it('does not ask again for every message of a streamed turn', () => {
    // topicList() is rebuilt on every post, and the lookup stats the filesystem on the other
    // side. Without the memo a long answer asks the same question once per segment.
    vi.useFakeTimers();
    const { room, topic } = attached();
    let answer = '/srv/project';
    let asked = 0;
    room.useWorkdirLookup(() => {
      asked += 1;
      return { path: answer };
    });

    for (let i = 0; i < 20; i++) room.post(topic, { own: false, html: '' }, `m${i}`);
    expect(asked).toBe(1);

    // Which is what the staleness costs: a `/cd` is not on the sidebar yet.
    answer = '/srv/elsewhere';
    expect(room.topicList().find((t) => t.id === topic)?.dir?.name).toBe('project');

    // And what bounds it: the label cannot be wrong for longer than the TTL.
    vi.advanceTimersByTime(DIR_TTL_MS + 1);
    expect(room.topicList().find((t) => t.id === topic)?.dir?.name).toBe('elsewhere');
    expect(asked).toBe(2);
  });

  it('posts the message even when the lookup throws', () => {
    // It runs inside announceTopics, which runs inside post. A sidebar label is not worth
    // losing an answer over.
    const { room, topic, seen } = attached();
    room.useWorkdirLookup(() => {
      throw new Error('the store is gone');
    });

    expect(() => room.post(topic, { own: false, html: '<p>hi</p>' }, 'hi')).not.toThrow();
    expect(kinds(seen)).toContain('msg');
    expect(room.topicList().find((t) => t.id === topic)?.dir).toBeUndefined();
  });

  /** The row's label as the client holds it, from the topic list events it was sent. */
  const sentDir = (held: Topic[], topic: string): string | undefined => {
    const dir = held.find((t) => t.id === topic)?.dir;
    return dir ? `${dir.host ?? ''}·${dir.name}` : undefined;
  };

  it('reads the label again after the operator writes, so the answer to a /agent or /cd carries the move', () => {
    // A new topic picked an agent on another machine (2026-11-02, the launcher): the ack and the
    // directory menu both announced the list inside the TTL, and the row went on naming the default
    // agent's machine until something happened to announce it again.
    vi.useFakeTimers();
    const { room, topic, list } = attached();
    let where = { path: '/home/u/workspace', host: 'uniagent' };
    room.useWorkdirLookup(() => where);
    room.topicList();

    room.submit({ topic, text: '/agent oc2' });
    where = { path: '/home/u/workspace', host: 'buildbox' }; // what the daemon did with it
    room.post(topic, { own: false, html: '<p>ack</p>' }, '▸ opencode is answering');
    expect(sentDir(list(), topic)).toBe('buildbox·workspace');

    // And a tap, the other way the operator moves a topic: a `/cd` menu pick.
    const menu = room.post(topic, { own: false, html: '', buttons: [{ id: 'wdr:r:1', label: 'shop-api' }] }, 'Working dir:');
    room.click({ topic, messageId: menu.id, buttonId: 'wdr:r:1' });
    where = { path: '/home/u/workspace/shop-api', host: 'buildbox' };
    room.revise(topic, menu.id, 'Now working in shop-api', []);
    expect(sentDir(list(), topic)).toBe('buildbox·shop-api');
  });

  it('refreshWorkdir drops the cached label within the TTL and announces the new directory and agent', () => {
    vi.useFakeTimers();
    const { room, topic, list } = attached();
    let where: { path: string; host?: string; agent?: { id: string; harness: string } } = { path: '/home/me/projects/parent' };
    room.useWorkdirLookup(() => where);
    room.post(topic, { own: false, html: '<p>hi</p>' }, 'hi');
    expect(sentDir(list(), topic)).toBe('·parent');

    where = { path: '/home/me/projects/child', agent: { id: 'oc', harness: 'opencode' } };
    // Still cached inside DIR_TTL_MS until refreshWorkdir invalidates it.
    room.post(topic, { own: false, html: '<p>still</p>' }, 'still');
    expect(sentDir(list(), topic)).toBe('·parent');

    room.refreshWorkdir(topic);
    expect(sentDir(list(), topic)).toBe('·child');
    expect(list().find((t) => t.id === topic)?.agent).toEqual({ id: 'oc', harness: 'opencode' });
  });

  it('is corrected by the liveness poll when a move lands after its own announcement', () => {
    // A `/cd` on a host lists the directory over the link before it applies, so the list sent with
    // the echo is already out of date and nothing else is coming. The poll reads the label fresh.
    vi.useFakeTimers();
    const { room, topic, seen, list } = attached();
    let path = '/srv/a';
    room.useWorkdirLookup(() => ({ path }));
    room.useLivenessLookup(() => false);
    seen.length = 0;

    vi.advanceTimersByTime(60_000);
    expect(listEvents(seen)).toHaveLength(0); // nothing moved, nothing sent

    path = '/srv/b';
    vi.advanceTimersByTime(60_000);
    expect(sentDir(list(), topic)).toBe('·b');
  });
});

describe('WebRoom: what the switcher dot is saying', () => {
  const flagsOf = (room: WebRoom, topic: string): { asking?: boolean; live?: boolean; running?: boolean } => {
    const t = room.topicList().find((x) => x.id === topic);
    return { asking: t?.asking, live: t?.live, running: t?.running };
  };

  it('marks a topic as waiting on the user for as long as its question is on screen', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    expect(flagsOf(room, topic).asking).toBe(false);

    // Every ask, elicitation round and menu reaches this platform as a message with buttons.
    const msg = room.post(topic, { own: false, html: '', buttons: [{ id: 'ask:r:0', label: 'Yes' }] }, '?');
    expect(flagsOf(room, topic).asking).toBe(true);

    // …and is retired by stripping them, which is what has to put the dot back.
    seen.length = 0;
    room.revise(topic, msg.id, 'answered: Yes', []);
    expect(flagsOf(room, topic).asking).toBe(false);
    expect(listEvents(seen)).toHaveLength(1);
  });

  it('keeps saying it is waiting while a menu turns its pages', () => {
    // A page turn is an edit carrying buttons too. It changes nothing about who is waiting on
    // whom, so it must not cost a redraw of every client's sidebar.
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '', buttons: [{ id: 'cd:p:1', label: 'Next' }] }, 'pick one');
    seen.length = 0;

    room.revise(topic, msg.id, 'pick one', [{ id: 'cd:p:2', label: 'Next' }]);

    expect(flagsOf(room, topic).asking).toBe(true);
    expect(listEvents(seen)).toHaveLength(0);
  });

  it('stops waiting when the question is deleted rather than answered', () => {
    // `/new` sweeps a topic's messages; an unanswered menu leaving that way must not leave the
    // dot blinking at a question nobody can see.
    const { room, topic } = attached();
    const msg = room.post(topic, { own: false, html: '', buttons: [{ id: 'ask:r:0', label: 'Yes' }] }, '?');
    room.remove(topic, msg.id);
    expect(flagsOf(room, topic).asking).toBe(false);
  });

  it('stops waiting once the operator writes into the topic instead of tapping', () => {
    // The reported bug: `/cc` posts the workdir menu, the user types `hello` rather than picking
    // a directory, gets an answer — and the topic stayed amber, because the ignored menu still
    // carries its buttons and nothing ever retires it.
    vi.useFakeTimers();
    const { room, topic } = attached();
    room.post(topic, { own: false, html: '', buttons: [{ id: 'cd:0', label: 'workspace' }] }, 'pick one');
    expect(flagsOf(room, topic).asking).toBe(true);

    room.submit({ topic, text: 'hello' });
    expect(flagsOf(room, topic).asking).toBe(false);

    // A question arriving after the message still marks it — that one IS waiting on the user.
    room.post(topic, { own: false, html: '', buttons: [{ id: 'ask:r:0', label: 'Yes' }] }, '?');
    expect(flagsOf(room, topic).asking).toBe(true);
  });

  it('marks the topic again when an ask that was answered by text moves on to its next question', () => {
    // A multi-question ask edits the same message to show the next question's buttons; the
    // clear on submit must not have made that message unable to mark the topic again.
    vi.useFakeTimers();
    const { room, topic } = attached();
    const ask = room.post(topic, { own: false, html: '', buttons: [{ id: 'ask:r:0', label: 'A' }] }, 'Q1');
    room.submit({ topic, text: 'my own answer' });
    expect(flagsOf(room, topic).asking).toBe(false);

    room.revise(topic, ask.id, 'Q2', [{ id: 'ask:r:1', label: 'B' }]);
    expect(flagsOf(room, topic).asking).toBe(true);
  });

  it('exempts operator control menus from asking while recognizing true questions and unknown buttons', () => {
    const { room, topic } = attached();

    // 1. Directory / workdir menu (/cd, wdr: / wdp:)
    const wdrMsg = room.post(topic, { own: false, html: '', buttons: [{ id: 'wdr:req:0', label: 'dir' }, { id: 'wdp:req:1', label: 'Next' }] }, 'workdir');
    expect(flagsOf(room, topic).asking).toBe(false);
    room.remove(topic, wdrMsg.id);

    // 2. Model menu (/model, mdl: / mpg:)
    const mdlMsg = room.post(topic, { own: false, html: '', buttons: [{ id: 'mdl:req:0', label: 'm1' }, { id: 'mpg:req:1', label: 'Next' }] }, 'model');
    expect(flagsOf(room, topic).asking).toBe(false);
    room.remove(topic, mdlMsg.id);

    // 3. Effort menu (/effort, eff:)
    const effMsg = room.post(topic, { own: false, html: '', buttons: [{ id: 'eff:req:0', label: 'low' }] }, 'effort');
    expect(flagsOf(room, topic).asking).toBe(false);
    room.remove(topic, effMsg.id);

    // 4. Agent menu (/agent, aga: / agp: / agg: / agb:)
    const agMsg = room.post(topic, { own: false, html: '', buttons: [
      { id: 'aga:req:0', label: 'cc' },
      { id: 'agp:req:1', label: 'Next' },
      { id: 'agg:req:0', label: 'group' },
      { id: 'agb:req:0', label: 'Back' },
    ] }, 'agent');
    expect(flagsOf(room, topic).asking).toBe(false);
    room.remove(topic, agMsg.id);

    // 5. Settings menu (/setting, stg: / stv: / sts: / stt: / stp: / stb: / sco:)
    const setMsg = room.post(topic, { own: false, html: '', buttons: [
      { id: 'stg:req:0', label: 'Agent' },
      { id: 'stv:req:1', label: 'val' },
      { id: 'sts:req:2', label: 'switch' },
      { id: 'stt:req:0', label: 'type' },
      { id: 'stp:req:1', label: 'page' },
      { id: 'stb:req:0', label: 'back' },
      { id: 'sco:req:0', label: 'Schedule' },
    ] }, 'settings');
    expect(flagsOf(room, topic).asking).toBe(false);
    room.remove(topic, setMsg.id);

    // 6. Settings screen message (WebMessage.settings)
    const scrMsg = room.post(topic, { own: false, html: '', buttons: [{ id: 'sts:req:0', label: 'switch' }], settings: { level: 'list', groups: [], rows: [] } }, 'settings screen');
    expect(flagsOf(room, topic).asking).toBe(false);
    room.remove(topic, scrMsg.id);

    // 7. Scheduled task menu (sco: / sct: / sca:)
    const scMsg = room.post(topic, { own: false, html: '', buttons: [
      { id: 'sco:req:0', label: 'Open' },
      { id: 'sct:req:0', label: 'Task' },
      { id: 'sca:req:0', label: 'Pause' },
    ] }, 'schedule');
    expect(flagsOf(room, topic).asking).toBe(false);
    room.remove(topic, scMsg.id);

    // 8. Command picker menu (cmd:)
    const cmdMsg = room.post(topic, { own: false, html: '', buttons: [{ id: 'cmd:req:0', label: '/init' }] }, 'picker');
    expect(flagsOf(room, topic).asking).toBe(false);
    room.remove(topic, cmdMsg.id);

    // 9. True question (ask:) -> asking: true
    const askMsg = room.post(topic, { own: false, html: '', buttons: [{ id: 'ask:req:0', label: 'Yes' }] }, 'Are you sure?');
    expect(flagsOf(room, topic).asking).toBe(true);
    room.remove(topic, askMsg.id);

    // 10. Unrecognized buttons (fails safe) -> asking: true
    const unkMsg = room.post(topic, { own: false, html: '', buttons: [{ id: 'custom:1', label: 'Custom' }] }, 'Choose:');
    expect(flagsOf(room, topic).asking).toBe(true);
    room.remove(topic, unkMsg.id);
  });

  it('recognizes every control menu prefix and rejects non-control prefixes (single source of truth)', () => {
    const CONTROL_PREFIXES = [
      WORKDIR_PICK_PREFIX,
      WORKDIR_PAGE_PREFIX,
      MODEL_PICK_PREFIX,
      MODEL_PAGE_PREFIX,
      EFFORT_PICK_PREFIX,
      AGENT_GROUP_PREFIX,
      AGENT_PICK_PREFIX,
      AGENT_BACK_PREFIX,
      AGENT_PAGE_PREFIX,
      SETTING_ROW_PREFIX,
      SETTING_VALUE_PREFIX,
      SETTING_PAGE_PREFIX,
      SETTING_BACK_PREFIX,
      SETTING_SET_PREFIX,
      SETTING_TYPE_PREFIX,
      SCHEDULE_OPEN_PREFIX,
      SCHEDULE_TASK_PREFIX,
      SCHEDULE_ACTION_PREFIX,
      PICK_PREFIX,
      RETRY_PREFIX,
    ];

    for (const prefix of CONTROL_PREFIXES) {
      const id = `${prefix}req1:0`;
      expect(isControlMenuButton(id), `prefix ${prefix} must be recognized as a control menu`).toBe(true);
      const msg: WebMessage = { id: 'w1', own: false, html: '', at: 1, g: 1, reactions: [], buttons: [{ id, label: 'btn' }] };
      expect(isControlMenu(msg), `message with ${prefix} button must be exempted`).toBe(true);
    }

    const NON_CONTROL_PREFIXES = ['ask:', VOICE_BUTTON_PREFIX];
    for (const prefix of NON_CONTROL_PREFIXES) {
      const id = `${prefix}req1:0`;
      expect(isControlMenuButton(id), `prefix ${prefix} must not be a control menu`).toBe(false);
      const msg: WebMessage = { id: 'w1', own: false, html: '', at: 1, g: 1, reactions: [], buttons: [{ id, label: 'btn' }] };
      expect(isControlMenu(msg), `message with ${prefix} button must not be exempted`).toBe(false);
    }
  });

  it('treats a message with both control buttons and ask buttons as a question (every, not some)', () => {
    const { room, topic } = attached();
    const mixedMsg = room.post(
      topic,
      {
        own: false,
        html: '',
        buttons: [
          { id: `${SETTING_ROW_PREFIX}req:0`, label: 'Default model' },
          { id: 'ask:req:0', label: 'Confirm' },
        ],
      },
      'Mixed buttons'
    );
    expect(isControlMenu(mixedMsg)).toBe(false);
    expect(flagsOf(room, topic).asking).toBe(true);
  });

  it('does not exempt a settings screen message if it also carries ask or unknown buttons', () => {
    const mixedSettings: WebMessage = {
      id: 'w1',
      own: false,
      html: '',
      at: 1,
      g: 1,
      reactions: [],
      settings: { level: 'list', groups: [], rows: [] },
      buttons: [
        { id: `${SETTING_SET_PREFIX}req:0`, label: 'Switch' },
        { id: 'ask:req:0', label: 'Approve' },
      ],
    };
    expect(isControlMenu(mixedSettings)).toBe(false);

    const pureSettings: WebMessage = {
      id: 'w2',
      own: false,
      html: '',
      at: 1,
      g: 1,
      reactions: [],
      settings: { level: 'list', groups: [], rows: [] },
      buttons: [{ id: `${SETTING_SET_PREFIX}req:0`, label: 'Switch' }],
    };
    expect(isControlMenu(pureSettings)).toBe(true);

    const noButtonSettings: WebMessage = {
      id: 'w3',
      own: false,
      html: '',
      at: 1,
      g: 1,
      reactions: [],
      settings: { level: 'list', groups: [], rows: [] },
      buttons: [],
    };
    expect(isControlMenu(noButtonSettings)).toBe(true);
  });

  it('picks the text of the actual question for questionLine when both control menus and asks exist', () => {
    const { room, topic } = attached();
    // Post a control menu first (e.g. /setting)
    room.post(topic, { own: false, html: '', buttons: [{ id: 'stg:req:0', label: 'Agent' }] }, 'Settings menu text');
    // Post a real ask
    room.post(topic, { own: false, html: '', buttons: [{ id: 'ask:req:0', label: 'Yes' }] }, 'Do you want to proceed?\nLine 2');
    // Post another control menu (e.g. /model)
    room.post(topic, { own: false, html: '', buttons: [{ id: 'mdl:req:0', label: 'model' }] }, 'Model menu text');

    expect(flagsOf(room, topic).asking).toBe(true);
    const item = room.topicList().find((t) => t.id === topic);
    expect(item?.stage).toBe('answer');
    expect(item?.line).toBe('Do you want to proceed?');
  });

  it('still considers a topic inUse and protects it from idle reclaim when holding a control menu', () => {
    const { room, topic } = attached();
    room.useIdleReclaim(() => true);
    room.post(topic, { own: false, html: '', buttons: [{ id: 'stg:req:0', label: 'Agent' }] }, 'Settings');
    const res = room.closeIdle([topic]);
    expect(res.closed).toEqual([]);
    expect(res.kept).toEqual([topic]);
  });

  it('reports no agent behind any topic when the daemon never offered a lookup', () => {
    const { room, topic } = attached();
    expect(flagsOf(room, topic).live).toBe(false);
  });

  it('separates a topic whose agent is still resident from one with nothing left running', () => {
    const { room, topic } = attached();
    const cold = room.createTopic('cold');
    room.useLivenessLookup((ref) => ref.thread === topic);

    const listed = room.topicList();
    expect(listed.find((t) => t.id === topic)?.live).toBe(true);
    expect(listed.find((t) => t.id === cold.id)?.live).toBe(false);
  });

  it('redraws the switcher when an agent goes away, which nothing else announces', () => {
    // An idle reclaim happens on a timer in a conversation nobody is touching, so there is no
    // message, no typing change and no click to hang the redraw off. Hence the poll.
    vi.useFakeTimers();
    const { room, topic, seen, list } = attached();
    let up = true;
    room.useLivenessLookup(() => up);
    seen.length = 0;

    // Nothing changed: the poll stays silent rather than re-sending the list every tick.
    vi.advanceTimersByTime(60_000);
    expect(listEvents(seen)).toHaveLength(0);

    up = false;
    vi.advanceTimersByTime(60_000);
    expect(listEvents(seen)).toHaveLength(1);
    expect(list().find((t) => t.id === topic)?.live).toBe(false);
  });

  it('keeps posting messages when the liveness lookup throws', () => {
    // Same rule as the directory lookup: it runs inside announceTopics, which runs inside post.
    const { room, topic, seen } = attached();
    room.useLivenessLookup(() => {
      throw new Error('the registry is gone');
    });

    expect(() => room.post(topic, { own: false, html: '<p>hi</p>' }, 'hi')).not.toThrow();
    expect(kinds(seen)).toContain('msg');
    expect(flagsOf(room, topic).live).toBe(false);
  });
});

describe('WebRoom: closing idle agents', () => {
  /** A room with four topics — idle, working, asking, and an idle one whose daemon refuses — plus a log of what was asked. */
  function fleet() {
    const { room, topic: idle, seen, list } = attached();
    const working = room.createTopic('working').id;
    const asking = room.createTopic('asking').id;
    const stubborn = room.createTopic('stubborn').id;
    room.setTyping(working, true);
    room.post(asking, { own: false, html: '<p>which?</p>', buttons: [{ id: 'ask:r:0', label: 'this one' }] }, 'which?');
    const asked: string[] = [];
    const up = new Set([idle, working, asking, stubborn]);
    room.useLivenessLookup((ref) => up.has(ref.thread ?? ''));
    room.useIdleReclaim((ref) => {
      const id = ref.thread ?? '';
      asked.push(id);
      if (id === stubborn) return false; // a runtime that cannot resume, or a turn the daemon sees
      up.delete(id);
      return true;
    });
    return { room, seen, list, asked, idle, working, asking, stubborn };
  }

  it('ends the listed topics that are still idle, and leaves the rest running', () => {
    const { room, asked, idle, working, asking, stubborn } = fleet();
    expect(room.topicList().find((t) => t.id === asking)?.asking).toBe(true);

    const result = room.closeIdle([idle, working, asking, stubborn, 'ffffffff']);

    expect(result).toEqual({ closed: [idle], kept: [working, asking, stubborn] });
    // The page's list can be seconds old: a topic working or asking NOW is not handed to the
    // daemon at all, and an id the store no longer holds is not reported back either way.
    expect(asked).toEqual([idle, stubborn]);
  });

  it('redraws the dots at once instead of at the next liveness poll', () => {
    const { room, seen, list, idle } = fleet();
    seen.length = 0;
    room.closeIdle([idle]);
    expect(listEvents(seen)).toHaveLength(1);
    expect(list().find((t) => t.id === idle)?.live).toBe(false);
  });

  it('closes nothing, and says so, without a daemon to ask or when asking throws', () => {
    const { room, topic } = attached();
    expect(room.closeIdle([topic])).toEqual({ closed: [], kept: [topic] });
    room.useIdleReclaim(() => {
      throw new Error('the registry is gone');
    });
    expect(room.closeIdle([topic])).toEqual({ closed: [], kept: [topic] });
  });
});

describe('WebRoom: ending a topic and the topics under it', () => {
  it('hands the one topic to the daemon and answers what became of each', () => {
    const { room, topic, seen, list } = attached();
    const asked: Array<{ topic: string; confirmed: string[] }> = [];
    let up = true;
    room.useLivenessLookup(() => up);
    room.useTopicKill((ref, confirmed) => {
      asked.push({ topic: ref.thread ?? '', confirmed: [...confirmed].sort() });
      up = false;
      return [
        { topic: ref.thread ?? '', outcome: 'ended' },
        { topic: 'b2c3d4e5', outcome: 'ended' },
        { topic: 'c3d4e5f6', outcome: 'no-child' },
      ];
    });
    seen.length = 0;

    const res = room.killTopic(topic, [topic, 'b2c3d4e5', 'c3d4e5f6']);

    // The root names the subtree; the confirmed list travels with it, and the daemon intersects.
    expect(asked).toEqual([{ topic, confirmed: [topic, 'b2c3d4e5', 'c3d4e5f6'].sort() }]);
    expect(res.results).toEqual([
      { topic, outcome: 'ended' },
      { topic: 'b2c3d4e5', outcome: 'ended' },
      { topic: 'c3d4e5f6', outcome: 'no-child' },
    ]);
    // The dots go grey now rather than at the next liveness poll.
    expect(listEvents(seen)).toHaveLength(1);
    expect(list().find((t) => t.id === topic)?.live).toBe(false);
  });

  it('answers no rows for a topic it does not hold, and no-child when no daemon offered a hook', () => {
    const { room, topic } = attached();
    expect(room.killTopic('ffffffff', ['ffffffff'])).toEqual({ results: [] });
    // Nothing was ended, and the page says "left running" rather than "ended".
    expect(room.killTopic(topic, [topic])).toEqual({ results: [{ topic, outcome: 'no-child' }] });
  });

  it('answers no-child, and keeps the room alive, when the daemon throws', () => {
    const { room, topic } = attached();
    room.useTopicKill(() => {
      throw new Error('the registry is gone');
    });
    expect(room.killTopic(topic, [topic])).toEqual({ results: [{ topic, outcome: 'no-child' }] });
  });
});

describe('WebRoom: a full topic list makes room instead of refusing', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * A room whose store is full: `n` topics whose `lastAt` counts up from 1, so `ids[0]` is the
   * oldest. Built through the store so the timestamps are exact, then wrapped, which is how the
   * adapter builds it too.
   */
  function full(): { room: WebRoom; store: TopicStore; ids: string[] } {
    const store = new TopicStore(path.join(dir, `${Math.random()}.json`));
    const ids: string[] = [];
    for (let i = 0; i < MAX_TOPICS; i += 1) {
      const t = store.create(`t${i}`);
      store.touch(t.id, i + 1);
      ids.push(t.id);
    }
    return { room: new WebRoom(instance(), store), store, ids };
  }

  it('gives up the least recently active topic, and says which in the log', () => {
    // 64 topics was two weeks of ordinary use, after which + did nothing at all.
    const { room, store, ids } = full();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const seen: Seen[] = [];
    room.subscribe(ids[5]!, (id, ev) => seen.push({ id, ev }));
    seen.length = 0;

    const fresh = room.createTopic('new');

    expect(store.has(ids[0]!)).toBe(false);
    expect(store.has(fresh.id)).toBe(true);
    expect(store.list()).toHaveLength(MAX_TOPICS);
    // The id and the title, because the daemon's binding for it outlives the row and this line
    // is how its session can still be found.
    expect(log.mock.calls.flat().join('\n')).toMatch(new RegExp(`evicted ${ids[0]} "t0"`));
    // One list event, not one for the eviction and another for the creation: the one that went
    // and the one that came, together.
    expect(listEvents(seen)).toHaveLength(1);
    expect(listEvents(seen)[0]?.ev).toMatchObject({ t: 'topic-rows', gone: [ids[0]] });
    expect((listEvents(seen)[0]?.ev as { rows: Topic[] }).rows.map((t) => t.id)).toEqual([fresh.id]);
  });

  it('takes an evicted topic\'s kept transcript with it', () => {
    const { room, ids } = full();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dropped: string[] = [];
    room.useTranscripts({
      load: () => new Map(),
      save: () => Promise.resolve(),
      saveNow: () => {},
      drop: (t) => void dropped.push(t),
    });
    room.createTopic();
    expect(dropped).toEqual([ids[0]]);
  });

  it('never gives up a starred topic', () => {
    const { room, store, ids } = full();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    room.starTopic(ids[0]!, true);
    room.starTopic(ids[1]!, true);

    room.createTopic();

    expect(store.has(ids[0]!)).toBe(true);
    expect(store.has(ids[1]!)).toBe(true);
    expect(store.has(ids[2]!)).toBe(false);
  });

  it('passes over a topic that is mid-turn, asking, resident, has a terminal, or is a scheduled target', () => {
    // Each is something eviction would break rather than merely orphan.
    const { room, store, ids } = full();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    room.setTyping(ids[0]!, true);
    room.post(ids[1]!, { own: false, html: '', buttons: [{ id: 'ask:q:0', label: 'yes' }] }, 'Q');
    room.useLivenessLookup((ref) => ref.thread === ids[2]);
    room.useTerminalSessions({ has: (t) => t === ids[3], onChange: () => {} });
    room.useScheduleLookup((ref) => ref.thread === ids[4]);
    // post() and setTyping() touched two of them; put them back at the bottom of the list.
    store.touch(ids[0]!, 1);
    store.touch(ids[1]!, 2);

    room.createTopic();

    for (const busy of ids.slice(0, 5)) expect(store.has(busy)).toBe(true);
    expect(store.has(ids[5]!)).toBe(false);
  });

  it('treats a schedule lookup that throws as "in use" — keeping a row is cheaper than losing a task', () => {
    const { room, store, ids } = full();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    room.useScheduleLookup(() => {
      throw new Error('the scheduler is gone');
    });

    expect(() => room.createTopic()).toThrow(/starred or in use/);
    expect(store.list().map((t) => t.id)).toEqual([...ids].reverse());
  });

  it('refuses with a sentence the page can show when every topic is starred', () => {
    const { room, store, ids } = full();
    for (const id of ids) room.starTopic(id, true);

    expect(() => room.createTopic()).toThrow(new RegExp(`every one of the ${MAX_TOPICS} topics is starred or in use; unstar or delete one`));
    expect(store.list()).toHaveLength(MAX_TOPICS);
  });

  it('announces a star, and refuses one for a topic that does not exist', () => {
    const { room, topic, seen, list } = attached();
    seen.length = 0;
    expect(room.starTopic(topic, true)).toBe(true);
    expect(listEvents(seen)).toHaveLength(1);
    expect(list().find((t) => t.id === topic)?.starred).toBe(true);
    expect(room.starTopic('ffffffff', true)).toBe(false);
  });

  it('keeps starred topics and their transcripts through "Clear all topics", and lands in a fresh one', () => {
    const { room, topic } = attached();
    const plain = room.createTopic('plain');
    room.post(topic, { own: false, html: '<p>keep</p>' }, 'keep');
    room.starTopic(topic, true);

    const fresh = room.clearTopics();

    expect(room.topicList().map((t) => t.id).sort()).toEqual([topic, fresh.id].sort());
    expect(room.topics.has(plain.id)).toBe(false);
    // New, not the surviving star: landing in a starred topic would read as a sweep that did nothing.
    expect(fresh.id).not.toBe(topic);
    // Its room went untouched — the messages are still there to sync.
    expect(room.history(topic, {}).map((m) => m.content)).toEqual(['keep']);
  });
});

describe('WebRoom: the agent status strip', () => {
  const STATUS = { agent: 'cc', model: 'claude-opus-5-5', context: { used: 1000, size: 200_000 } };

  it('tells the clients reading that topic, unnumbered, and nobody else', () => {
    const { room, topic, seen } = attached();
    const other = room.createTopic('other').id;
    const elsewhere: Seen[] = [];
    room.subscribe(other, (id, ev) => elsewhere.push({ id, ev }));
    seen.length = 0;
    elsewhere.length = 0;

    room.setStatus(topic, STATUS);
    expect(seen.map((s) => [s.ev.t, s.id])).toEqual([['status', '']]);
    expect(last(seen)).toEqual({ t: 'status', status: STATUS });
    expect(elsewhere).toEqual([]);
  });

  it('drops a repeat, and says "cleared" with an empty status', () => {
    const { room, topic, seen } = attached();
    seen.length = 0;
    room.setStatus(topic, STATUS);
    room.setStatus(topic, { ...STATUS });
    expect(kinds(seen)).toEqual(['status']);
    room.setStatus(topic, undefined);
    expect(last(seen)).toEqual({ t: 'status' });
    room.setStatus(topic, undefined);
    expect(kinds(seen)).toEqual(['status', 'status']);
  });

  it('hands the current status to a page that syncs, and none once it is cleared', () => {
    const { room, topic } = attached();
    room.setStatus(topic, STATUS);
    const first: Seen[] = [];
    room.subscribe(topic, (id, ev) => first.push({ id, ev }));
    expect(first[0]?.ev).toMatchObject({ t: 'sync', status: STATUS });

    room.setStatus(topic, undefined);
    const second: Seen[] = [];
    room.subscribe(topic, (id, ev) => second.push({ id, ev }));
    expect(second[0]?.ev.t).toBe('sync');
    expect('status' in (second[0]?.ev ?? {})).toBe(false);
  });

  it('keeps status out of the backlog, so a busy turn cannot push the messages a resume needs out of it', () => {
    // A turn can report usage hundreds of times. Were each status numbered and kept, a client that
    // dropped mid-turn would find its resume point evicted and be re-sent the whole conversation.
    const { room, topic, seen, off } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const lastId = seen.filter((s) => s.id !== '').at(-1)?.id ?? '';
    off();
    for (let i = 0; i < 400; i++) room.setStatus(topic, { ...STATUS, context: { used: i, size: 200_000 } });
    room.post(topic, { own: false, html: '<p>two</p>' }, 'two');

    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    expect(kinds(resumed)).not.toContain('sync');
    expect(resumed.filter((s) => s.ev.t === 'msg')).toHaveLength(1);
    // …and since none of those 400 were replayed, the resumed page is told the current one.
    expect(resumed.filter((s) => s.ev.t === 'status').map((s) => s.ev)).toEqual([
      { t: 'status', status: { ...STATUS, context: { used: 399, size: 200_000 } } },
    ]);
  });

  it('tells a resumed page the status was cleared while it was away', () => {
    const { room, topic, seen, off } = attached();
    room.setStatus(topic, STATUS);
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const lastId = seen.filter((s) => s.id !== '').at(-1)?.id ?? '';
    off();
    room.setStatus(topic, undefined);

    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    expect(resumed.filter((s) => s.ev.t === 'status').map((s) => s.ev)).toEqual([{ t: 'status' }]);
  });
});

describe('WebRoom: machines the daemon cannot reach', () => {
  const DOWN = [{ name: 'laptop', since: 1_762_000_000_000 }];

  it('tells every client, whichever topic it reads, unnumbered', () => {
    const { room, seen } = attached();
    const other = room.createTopic('other').id;
    const elsewhere: Seen[] = [];
    room.subscribe(other, (id, ev) => elsewhere.push({ id, ev }));
    seen.length = 0;
    elsewhere.length = 0;

    room.setOfflineMachines(DOWN);
    expect(seen.map((s) => [s.ev.t, s.id])).toEqual([['machines', '']]);
    expect(last(seen)).toEqual({ t: 'machines', offline: DOWN });
    expect(elsewhere.map((s) => s.ev)).toEqual([{ t: 'machines', offline: DOWN }]);
  });

  it('drops a list equal to the last, and says "all back" with an empty one', () => {
    const { room, seen } = attached();
    seen.length = 0;
    room.setOfflineMachines(DOWN);
    room.setOfflineMachines([...DOWN]);
    expect(kinds(seen)).toEqual(['machines']);
    room.setOfflineMachines([]);
    expect(last(seen)).toEqual({ t: 'machines', offline: [] });
  });

  it('puts the list on a sync, and leaves the field off when nothing is offline', () => {
    const { room, topic } = attached();
    room.setOfflineMachines(DOWN);
    const first: Seen[] = [];
    room.subscribe(topic, (id, ev) => first.push({ id, ev }));
    expect(first[0]?.ev).toMatchObject({ t: 'sync', offline: DOWN });

    room.setOfflineMachines([]);
    const second: Seen[] = [];
    room.subscribe(topic, (id, ev) => second.push({ id, ev }));
    expect('offline' in (second[0]?.ev ?? {})).toBe(false);
  });

  it('tells a resumed page the list as it is now, which may have changed while it was away', () => {
    const { room, topic, seen, off } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const lastId = seen.filter((s) => s.id !== '').at(-1)?.id ?? '';
    off();
    room.setOfflineMachines(DOWN);

    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    expect(kinds(resumed)).not.toContain('sync');
    expect(resumed.find((s) => s.ev.t === 'machines')?.ev).toEqual({ t: 'machines', offline: DOWN });
  });

  it('hands a resumed page the topic list too, which no backlog keeps', () => {
    // A page in the background closes its stream and resumes it minutes later; whatever the list
    // went through meanwhile reached nobody, and a sidebar from before would stay wrong until the
    // next message anywhere.
    const { room, topic, seen, off } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const lastId = seen.filter((s) => s.id !== '').at(-1)?.id ?? '';
    off();
    const added = room.createTopic('made while it was away');
    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    expect(kinds(resumed)).not.toContain('sync');
    const list = resumed.find((s) => s.ev.t === 'topics')?.ev as { topics: Array<{ id: string }> } | undefined;
    expect(list?.topics.map((t) => t.id)).toContain(added.id);
  });

  it('numbers a sync with the room’s position, so a stream that drops straight after it resumes', () => {
    const { room, topic } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    room.post(topic, { own: false, html: '<p>two</p>' }, 'two');
    const first: Seen[] = [];
    room.subscribe(topic, (id, ev) => first.push({ id, ev }));
    expect(first[0]?.ev.t).toBe('sync');
    expect(first[0]?.id).toMatch(new RegExp(`^${topic}\\.[0-9a-z]+\\.\\d+$`));
    // Nothing said since: the resume hands over nothing, not the topic again.
    const again: Seen[] = [];
    room.subscribe(topic, (id, ev) => again.push({ id, ev }), first[0]?.id);
    expect(kinds(again)).not.toContain('sync');
    expect(again.filter((s) => s.ev.t === 'msg')).toHaveLength(0);
    // Something said since: exactly that.
    room.post(topic, { own: false, html: '<p>three</p>' }, 'three');
    const later: Seen[] = [];
    room.subscribe(topic, (id, ev) => later.push({ id, ev }), first[0]?.id);
    expect(later.filter((s) => s.ev.t === 'msg').map((s) => (s.ev as { msg: { html: string } }).msg.html)).toEqual([
      '<p>three</p>',
    ]);
  });
});

describe('WebRoom: a settings screen retired in place', () => {
  const screen = { level: 'list' as const, groups: [], rows: [] };

  it('marks a retired screen so the page can keep it out of the transcript', () => {
    // The page draws settings screens in a page of their own. A message that stops being one must
    // say so, or a reload would put its farewell line into the chat as an ordinary message.
    const { room, topic, seen } = attached();
    const msg = room.post(
      topic,
      { own: false, html: '<p>Settings</p>', buttons: [{ id: 'stg:r:0', label: 'Agent' }], settings: screen },
      'Settings'
    );
    room.revise(topic, msg.id, 'Settings — superseded by a newer /setting menu.', []);
    const edit = lastOf(seen, 'msg') as { msg: WebMessage };
    expect(edit.msg.wasSettings).toBe(true);
    expect(edit.msg.settings).toBeUndefined();
  });

  it('does not mark one handed to another menu, which has to show', () => {
    // The scheduled-task list takes over the same message with its own buttons; that menu is a
    // real message and must reach the transcript.
    const { room, topic, seen } = attached();
    const msg = room.post(
      topic,
      { own: false, html: '<p>Settings</p>', buttons: [{ id: 'sco:r:0', label: 'Tasks' }], settings: screen },
      'Settings'
    );
    room.revise(topic, msg.id, 'Scheduled tasks', [{ id: 'sct:r:0', label: 'Morning CI' }]);
    const edit = lastOf(seen, 'msg') as { msg: WebMessage };
    expect(edit.msg.wasSettings).toBeUndefined();
    expect(edit.msg.settings).toBeUndefined();
    expect(edit.msg.buttons).toHaveLength(1);
  });
});

describe('WebRoom: the scheduled-task panel', () => {
  const task: SchedulePanelTask = {
    id: 'a1b2c3',
    name: 'Morning CI',
    tags: ['ci'],
    createdAt: Date.UTC(2026, 10, 1, 0, 0, 0),
    state: 'active',
    when: '0 8 * * * (Asia/Shanghai)',
    next: '2026-11-05 08:00',
    nextAt: Date.UTC(2026, 10, 5, 0, 0, 0),
    run: 'cc · fixed session',
    target: 'web:main#a1b2c3d4',
    targetTopic: 'a1b2c3d4',
    runs: 2,
    running: false,
    detail: 'summarise the failures',
    kind: 'agent',
  };
  const FORM: SchedulePanelFormContext = {
    agents: ['cc'],
    agentHosts: {},
    hosts: [],
    channels: [],
    shapes: { bash: ['cwd', 'host', 'timeout', 'at'], fixed: ['agent', 'at'], new: ['agent', 'model', 'cwd', 'at'], daily: ['agent', 'model', 'cwd'] },
    tz: 'Asia/Shanghai',
    agent: 'cc',
  };
  const NO_DETAIL: Pick<SchedulePanel, 'detail' | 'edit' | 'add' | 'form'> = {
    detail: () => undefined,
    edit: async () => ({ ok: false, error: 'not in this test' }),
    add: async () => ({ ok: false, error: 'not in this test' }),
    form: () => FORM,
  };

  it('says the daemon offered none rather than pretending there are no tasks', async () => {
    const { room } = attached();

    expect(room.schedules()).toEqual({ enabled: false, tasks: [] });
    const off = { ok: false, error: 'scheduled tasks are not enabled in this daemon' };
    expect(room.scheduleOp('a1b2c3', 'pause')).toEqual(off);
    expect(room.scheduleDetail('a1b2c3')).toEqual(off);
    expect(await room.scheduleEdit('a1b2c3', { name: 'x' })).toEqual(off);
    expect(room.scheduleForm()).toEqual(off);
    expect(await room.scheduleAdd({ prompt: 'x', target: { channel: 'tg:-100/7' } })).toEqual(off);
  });

  it("forwards a task's page and an edit, and names a task that is not there", async () => {
    const { room } = attached();
    const page: SchedulePanelTaskDetail = {
      ...FORM,
      task,
      fields: { name: 'Morning CI', cron: '0 8 * * *', tz: 'Asia/Shanghai', prompt: 'p', agent: 'cc', session: 'fixed', target: 'web:main/t1' },
      runs: [],
    };
    const edits: unknown[] = [];
    const adds: unknown[] = [];
    room.useSchedulePanel({
      list: () => [task],
      op: () => ({ ok: true, tasks: [task] }),
      detail: (id) => (id === 'a1b2c3' ? page : undefined),
      form: () => FORM,
      edit: async (id, edit) => {
        edits.push([id, edit]);
        return { ok: true, detail: page, tasks: [task] };
      },
      add: async (input) => {
        adds.push(input);
        return { ok: true, detail: page, tasks: [task] };
      },
    });

    expect(room.scheduleDetail('a1b2c3')).toEqual({ ok: true, detail: page });
    expect(room.scheduleDetail('ffff00')).toEqual({ ok: false, error: 'no scheduled task #ffff00' });
    expect(room.scheduleForm()).toEqual({ ok: true, form: FORM });
    expect(await room.scheduleEdit('a1b2c3', { model: null })).toEqual({ ok: true, detail: page, tasks: [task] });
    expect(edits).toEqual([['a1b2c3', { model: null }]]);

    // "Posts to": one of this page's topics becomes its lane, as --channel would name it; any other
    // place goes as the id it was given, for the daemon to read; a topic the page lost is refused here.
    const here = room.createTopic('deploys');
    await room.scheduleEdit('a1b2c3', { target: { topic: here.id } });
    await room.scheduleAdd({ prompt: 'x', target: { channel: 'tg:-100/7' } });
    expect(edits.at(-1)).toEqual(['a1b2c3', { target: `webui:main/${here.id}` }]);
    expect(adds).toEqual([{ prompt: 'x', target: 'tg:-100/7' }]);
    expect(await room.scheduleAdd({ prompt: 'x', target: { topic: 'ffffffff' } })).toEqual({
      ok: false,
      error: 'That topic is not on this page any more; pick another.',
    });
    expect(adds).toHaveLength(1);
  });

  it('records the task a scheduled run opened its topic for, and nothing on a topic a person opened', () => {
    const { room } = attached();
    const run = room.createTopic('[cc] ⏰ CI · 2026-11-16', undefined, { scheduled: true, task: 'a1b2c3' });
    const mine = room.createTopic('mine', undefined, { task: 'a1b2c3' });
    const list = room.topicList();
    expect(list.find((t) => t.id === run.id)).toMatchObject({ scheduled: true, task: 'a1b2c3' });
    expect(list.find((t) => t.id === mine.id)?.task).toBeUndefined();
  });

  it('reads the list through the daemon and forwards each action', () => {
    const { room } = attached();
    const ops: string[] = [];
    room.useSchedulePanel({
      ...NO_DETAIL,
      list: () => [task],
      op: (id, action) => {
        ops.push(`${id}:${action}`);
        return { ok: true, tasks: [{ ...task, state: 'paused' }] };
      },
    });

    expect(room.schedules()).toEqual({ enabled: true, tasks: [task] });
    expect(room.scheduleOp('a1b2c3', 'pause')).toEqual({ ok: true, tasks: [{ ...task, state: 'paused' }] });
    expect(ops).toEqual(['a1b2c3:pause']);
  });

  it('forwards the whole tag set with the tags action', () => {
    const { room } = attached();
    const calls: Array<{ id: string; action: string; tags?: string[] }> = [];
    room.useSchedulePanel({
      ...NO_DETAIL,
      list: () => [task],
      op: (id, action, tags) => {
        calls.push({ id, action, ...(tags !== undefined ? { tags } : {}) });
        return { ok: true, tasks: [{ ...task, tags: ['ops'] }] };
      },
    });

    expect(room.scheduleOp('a1b2c3', 'tags', ['ops'])).toEqual({ ok: true, tasks: [{ ...task, tags: ['ops'] }] });
    expect(calls).toEqual([{ id: 'a1b2c3', action: 'tags', tags: ['ops'] }]);
  });
});

describe('WebRoom: the skills page', () => {
  const skill: SkillPanelEntry = {
    name: 'deploy-check',
    description: 'Use when checking a deployment',
    version: '0123456789ab',
    status: 'active',
    pinned: false,
    resident: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    uses: 3,
    agents: ['cc'],
  };

  it('says the daemon offered none rather than pretending there are no skills', async () => {
    const { room } = attached();

    expect(room.skills()).toEqual({ enabled: false, skills: [] });
    expect(await room.skillOp({ action: 'show', name: 'deploy-check' })).toEqual({
      ok: false,
      error: 'skills are not enabled in this daemon',
    });
  });

  it('reads the list through the daemon and forwards each operation', async () => {
    const { room } = attached();
    const ops: string[] = [];
    room.useSkillsPanel({
      list: () => [skill],
      op: async (op) => {
        ops.push(op.action);
        return { ok: true, skills: [{ ...skill, pinned: true }] };
      },
    });

    expect(room.skills()).toEqual({ enabled: true, skills: [skill] });
    expect(await room.skillOp({ action: 'pin', name: 'deploy-check', pinned: true })).toEqual({
      ok: true,
      skills: [{ ...skill, pinned: true }],
    });
    expect(ops).toEqual(['pin']);
  });
});

describe('WebRoom: a conversation from the library, drawn as a topic', () => {
  const at = 1762300000000;
  const row = (id: number, role: string, text: string, kind = 'normal') => ({ id, at: at + id, role, kind, text });

  it('makes the operator’s prompt their own bubble, a reply markdown, and a run of tool rows one tool bubble', () => {
    const out = historyMessages([
      row(1, 'user', 'deploy *it* <now>'),
      row(2, 'tool', 'Bash: npm run deploy\n{"command":"npm run deploy"}'),
      row(3, 'tool', '[37 tool calls: Read ×20, Edit ×17]'),
      row(4, 'agent', 'deployed **v2**'),
      row(5, 'tool', 'Read: notes.md'),
    ]);
    expect(out.map((m) => [m.id, m.own, m.kind ?? ''])).toEqual([
      ['h1', true, ''],
      ['h2', false, 'tools'],
      ['h4', false, ''],
      ['h5', false, 'tools'],
    ]);
    // What the operator typed is shown as typed, escaped and not rendered — as `record` posts it.
    expect(out[0]!.html).toBe('<div class="raw">deploy *it* &lt;now&gt;</div>');
    // Two rows, two lines: the arguments after a call's first line are the library's, not the bubble's.
    expect(out[1]!.html.match(/class="tl"/g)).toHaveLength(2);
    expect(out[1]!.html).toContain('Bash: npm run deploy');
    expect(out[1]!.html).not.toContain('"command"');
    expect(out[1]!.html).toContain('[37 tool calls: Read ×20, Edit ×17]');
    expect(out[2]!.html).toContain('<strong>v2</strong>');
    // Every message is a live one's shape: no buttons to answer, no reactions, a time.
    for (const m of out) {
      expect(m.buttons).toEqual([]);
      expect(m.reactions).toEqual([]);
      expect(typeof m.at).toBe('number');
    }
    expect(out[0]!.at).toBe(at + 1);
    // A tool bubble takes the time and id of the first call in it.
    expect(out[1]!.at).toBe(at + 2);
  });

  it('draws what the gateway wrote into a conversation as the bubble it was in the topic', () => {
    const out = historyMessages([
      row(1, 'user', '**↳ From [Plan](?t=a1b2c3d4)**\n\nWrite the tests.', 'subagent'),
      row(2, 'user', '[sub-agent updates] 1 of 2 finished\n🔔 tests: done', 'subagent'),
      row(3, 'user', 'a scheduled prompt', 'schedule'),
    ]);
    expect(out.map((m) => [m.own, m.kind ?? ''])).toEqual([
      [false, 'dispatch'],
      [false, 'report'],
      [true, ''],
    ]);
    // A dispatch is prose, with its topic link kept for the page to follow; a report is a line each.
    expect(out[0]!.html).toContain('data-goto="a1b2c3d4"');
    expect(out[1]!.html.match(/class="tl"/g)).toHaveLength(2);
  });

  it('answers a read with those messages, the session and the note, and refuses without a library', () => {
    const room = new WebRoom(instance(), new TopicStore(path.join(dir, `${Math.random()}.json`)));
    expect(() => room.historyRead(1)).toThrow(/not enabled/);
    const session = { id: 1, key: 'webui#main#a1b2c3d4', title: 'Deploy', agent: 'cc', platform: 'webui', lastAt: at, messages: 2, topic: 'a1b2c3d4' };
    room.useHistoryPanel({
      list: () => ({ enabled: true, sessions: [] }),
      search: () => ({ hits: [] }),
      read: () => ({ session, messages: [row(1, 'user', 'hi'), row(2, 'agent', 'hello')], note: 'cut' }),
    });
    const read = room.historyRead(1);
    expect(read.session).toEqual(session);
    expect(read.note).toBe('cut');
    expect(read.messages.map((m) => m.id)).toEqual(['h1', 'h2']);
    room.useHistoryPanel({
      list: () => ({ enabled: true, sessions: [] }),
      search: () => ({ hits: [] }),
      read: () => ({ session, messages: [] }),
    });
    expect('note' in room.historyRead(1)).toBe(false);
  });
});

describe('room: a turn’s changes', () => {
  it('hangs the entry off the reply it is given, and tells the page', () => {
    const { room, topic, seen } = attached();
    const posted = room.post(topic, { own: false, html: 'done' }, 'done');
    seen.length = 0;
    room.attachTurnChanges(topic, { turn: 3, files: 2, additions: 12, deletions: 4 }, posted.id);
    const ev = lastOf(seen, 'msg');
    expect(ev && ev.t === 'msg' ? ev.msg.id : undefined).toBe(posted.id);
    expect(ev && ev.t === 'msg' ? ev.msg.turnChanges : undefined).toEqual({ turn: 3, files: 2, additions: 12, deletions: 4 });
    // The entry is part of the message, so a topic read back from disk carries it.
    expect(seen.filter((s) => s.ev.t === 'msg')).toHaveLength(1);
  });

  it('puts it on the message it names, not on the newest one', () => {
    // The end snapshot is taken off the turn, so the next turn's reply may already be in the
    // topic when it lands. Only the id the daemon captured at turn end is right.
    const { room, topic, seen } = attached();
    const first = room.post(topic, { own: false, html: 'first' }, 'first');
    room.post(topic, { own: false, html: 'second' }, 'second');
    seen.length = 0;
    room.attachTurnChanges(topic, { turn: 1, files: 1, additions: 2, deletions: 0 }, first.id);
    const ev = lastOf(seen, 'msg');
    expect(ev && ev.t === 'msg' ? ev.msg.id : undefined).toBe(first.id);
  });

  it('ignores an unknown message, an operator’s own, and one that already carries an entry', () => {
    const { room, topic, seen } = attached();
    room.attachTurnChanges(topic, { turn: 1, files: 1, additions: 1, deletions: 0 }, 'w404');
    const mine = room.post(topic, { own: true, html: 'mine' }, 'mine');
    room.attachTurnChanges(topic, { turn: 1, files: 1, additions: 1, deletions: 0 }, mine.id);
    expect(seen.filter((s) => s.ev.t === 'msg' && s.ev.msg.turnChanges)).toHaveLength(0);

    const reply = room.post(topic, { own: false, html: 'reply' }, 'reply');
    room.attachTurnChanges(topic, { turn: 1, files: 1, additions: 1, deletions: 0 }, reply.id);
    seen.length = 0;
    room.attachTurnChanges(topic, { turn: 2, files: 9, additions: 90, deletions: 9 }, reply.id);
    expect(seen).toHaveLength(0);
  });

  it('forgets the records of every topic a sweep clears, but not a starred survivor’s', () => {
    const { room, topic } = attached();
    const plain = room.createTopic('plain');
    room.starTopic(topic, true);
    const forgot: string[] = [];
    room.useTurnChanges({
      status: async () => ({ ok: false, reason: 'error', text: 'none' }),
      file: async () => ({ ok: false, text: 'none' }),
      forget: (ref) => forgot.push(String(ref.thread)),
    });

    room.clearTopics();

    expect(forgot).toEqual([plain.id]);
  });

  it('forgets the records of a topic eviction gives up', () => {
    // Two topics in one directory is supported; a topic that has to make room is not coming back.
    const store = new TopicStore(path.join(dir, `${Math.random()}.json`));
    const ids: string[] = [];
    for (let i = 0; i < MAX_TOPICS; i += 1) {
      const t = store.create(`t${i}`);
      store.touch(t.id, i + 1);
      ids.push(t.id);
    }
    const room = new WebRoom(instance(), store);
    const forgot: string[] = [];
    room.useTurnChanges({
      status: async () => ({ ok: false, reason: 'error', text: 'none' }),
      file: async () => ({ ok: false, text: 'none' }),
      forget: (ref) => forgot.push(String(ref.thread)),
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    room.createTopic('new');

    expect(forgot).toEqual([ids[0]]);
    vi.restoreAllMocks();
  });

  it('tells the daemon to forget a topic’s records when the topic is deleted', () => {
    const { room, topic } = attached();
    const forgot: string[] = [];
    room.useTurnChanges({
      status: async () => ({ ok: false, reason: 'error', text: 'none' }),
      file: async () => ({ ok: false, text: 'none' }),
      forget: (ref) => forgot.push(String(ref.thread)),
    });
    room.deleteTopic(topic);
    expect(forgot).toEqual([topic]);
  });

  it('reads a turn through the panel it was given', async () => {
    const { room, topic } = attached();
    const asked: Array<[string, number, string | undefined]> = [];
    room.useTurnChanges({
      status: async (ref, turn) => {
        asked.push(['status', turn, ref.thread]);
        return { ok: true, repo: { root: '/r' }, files: [{ path: 'a', status: 'added', additions: 1, deletions: 0 }] };
      },
      file: async (ref, turn, path) => {
        asked.push(['file', turn, `${ref.thread}:${path}`]);
        return { ok: true, path, status: 'added', original: '', modified: 'x', patch: '+x' };
      },
    });
    const status = await room.turnChangesStatus(topic, 2);
    expect(status.ok && status.repo.root).toBe('/r');
    const file = await room.turnChangesFile(topic, 2, 'a');
    expect(file.ok && file.patch).toBe('+x');
    expect(asked).toEqual([
      ['status', 2, topic],
      ['file', 2, `${topic}:a`],
    ]);
  });

  it('refuses without a panel, and for a topic it does not have', async () => {
    const { room, topic } = attached();
    expect(await room.turnChangesStatus(topic, 1)).toMatchObject({ ok: false, reason: 'error' });
    expect(await room.turnChangesFile(topic, 1, 'a')).toMatchObject({ ok: false });
    room.useTurnChanges({
      status: async () => ({ ok: false, reason: 'not-git', text: 'nope' }),
      file: async () => ({ ok: false, text: 'nope' }),
    });
    expect(await room.turnChangesStatus('ffffffff', 1)).toMatchObject({ ok: false });
    expect(await room.turnChangesFile('ffffffff', 1, 'a')).toMatchObject({ ok: false });
  });
});

describe('WebRoom: pending mid-turn queue', () => {
  it('holds a pending message out of stored, syncs it with nonce, and promotes it on delivery or drops on recall', () => {
    const { room, topic, seen } = attached();
    let heldId = '';
    room.onMessage((m) => {
      heldId = m.messageId;
      room.setPendingQueue(topic, [
        { id: m.messageId, content: m.content, at: m.timestamp, canSendNow: true, reason: 'tool' },
      ]);
    });

    expect(room.submit({ topic, text: 'wait for tool', nonce: 'n-pending-1' })).toBe('accepted');
    // Not posted into stored yet; emitted as pending state with nonce attached.
    expect(seen.some((e) => e.ev.t === 'msg' && e.ev.msg.id === heldId)).toBe(false);
    expect(seen.at(-1)?.ev).toEqual({
      t: 'pending',
      items: [expect.objectContaining({ id: heldId, content: 'wait for tool', nonce: 'n-pending-1', reason: 'tool' })],
    });

    // A fresh subscriber sees the pending item in sync.
    const fresh: WebEvent[] = [];
    const unsub = room.subscribe(topic, (_id, ev) => {
      fresh.push(ev);
    });
    const syncEv = fresh.find((e) => e.t === 'sync');
    expect(syncEv && syncEv.t === 'sync' && syncEv.pending).toEqual([
      expect.objectContaining({ id: heldId, content: 'wait for tool', nonce: 'n-pending-1' }),
    ]);
    unsub();

    // Promoting on delivery posts it into stored with the same id and nonce.
    room.markPendingDelivered(topic, [heldId]);
    room.setPendingQueue(topic, []);
    expect(seen.some((e) => e.ev.t === 'msg' && e.ev.msg.id === heldId && e.ev.msg.nonce === 'n-pending-1')).toBe(true);
    expect(seen.at(-1)?.ev).toEqual({ t: 'pending', items: [] });
  });

  it('forwards recall and send-now actions and never records a recalled message in stored', () => {
    const { room, topic, seen } = attached();
    let heldId = '';
    const actions: string[] = [];
    room.onMessage((m) => {
      heldId = m.messageId;
      room.setPendingQueue(topic, [
        { id: m.messageId, content: m.content, at: m.timestamp, canSendNow: true, reason: 'delay' },
      ]);
    });
    room.usePendingQueueActions({
      recall: (_ref, id) => {
        actions.push(`recall:${id ?? ''}`);
        room.setPendingQueue(topic, []);
        return { ok: true, recalled: 1, content: 'never mind' };
      },
      sendNow: (_ref, id, opts) => {
        actions.push(`sendNow:${id ?? ''}${opts?.interrupt ? ':interrupt' : ''}`);
        return { ok: true, sent: 1 };
      },
    });

    room.submit({ topic, text: 'never mind', nonce: 'n-recall' });
    expect(room.sendNowPending(topic, heldId)).toEqual({ ok: true, sent: 1 });
    expect(room.sendNowPending(topic, heldId, { interrupt: true })).toEqual({ ok: true, sent: 1 });
    expect(room.recallPending(topic, heldId)).toEqual({ ok: true, recalled: 1, content: 'never mind' });
    expect(actions).toEqual([`sendNow:${heldId}`, `sendNow:${heldId}:interrupt`, `recall:${heldId}`]);
    expect(seen.some((e) => e.ev.t === 'msg' && e.ev.msg.id === heldId)).toBe(false);
  });

  it('still posts a pending message when setPendingQueue clears it before markPendingDelivered (steered / send-now)', () => {
    const { room, topic, seen } = attached();
    let heldId = '';
    room.onMessage((m) => {
      heldId = m.messageId;
      room.setPendingQueue(topic, [
        { id: m.messageId, content: m.content, at: m.timestamp, canSendNow: true, reason: 'tool' },
      ]);
    });

    expect(room.submit({ topic, text: 'steer me now', nonce: 'n-steer-1' })).toBe('accepted');
    expect(seen.some((e) => e.ev.t === 'msg' && e.ev.msg.id === heldId)).toBe(false);

    // Mirrors InboundMerger.sendNow() / flushPendingSteer(): emitPending() removes the item from
    // pending before async steer() resolves and calls markPendingDelivered().
    room.setPendingQueue(topic, []);
    room.markPendingDelivered(topic, [heldId]);

    expect(
      seen.some((e) => e.ev.t === 'msg' && e.ev.msg.id === heldId && e.ev.msg.nonce === 'n-steer-1' && e.ev.msg.own),
    ).toBe(true);

    // Survives reload (fresh sync includes the delivered message).
    const fresh: WebEvent[] = [];
    const unsub = room.subscribe(topic, (_id, ev) => {
      fresh.push(ev);
    });
    const syncEv = fresh.find((e) => e.t === 'sync');
    expect(
      syncEv &&
        syncEv.t === 'sync' &&
        syncEv.messages.some((m) => m.id === heldId && m.own && m.html.includes('steer me now')),
    ).toBe(true);
    unsub();
  });

  it('preserves draft nonce if a steered item is refused and re-queued before later delivery', () => {
    const { room, topic, seen } = attached();
    let heldId = '';
    room.onMessage((m) => {
      heldId = m.messageId;
      room.setPendingQueue(topic, [
        { id: m.messageId, content: m.content, at: m.timestamp, canSendNow: true, reason: 'delay' },
      ]);
    });

    expect(room.submit({ topic, text: 'retry queued', nonce: 'n-requeue-1' })).toBe('accepted');
    // Cleared while offering to steer, then refused and placed back into queued.
    room.setPendingQueue(topic, []);
    room.setPendingQueue(topic, [
      { id: heldId, content: 'retry queued', at: Date.now(), canSendNow: false, reason: 'turn' },
    ]);
    expect(seen.at(-1)?.ev).toEqual({
      t: 'pending',
      items: [expect.objectContaining({ id: heldId, nonce: 'n-requeue-1', reason: 'turn' })],
    });

    room.setPendingQueue(topic, []);
    room.markPendingDelivered(topic, [heldId]);
    expect(seen.some((e) => e.ev.t === 'msg' && e.ev.msg.id === heldId && e.ev.msg.nonce === 'n-requeue-1')).toBe(true);
  });
});

describe('WebRoom: multiplexed multi-topic streams', () => {
  it('streams multiple topics on one subscription, tagging per-topic events with topic and resuming independently', () => {
    const { room, topic: t1 } = attached();
    const t2 = room.createTopic('second').id;
    const t3 = room.createTopic('third').id;
    room.post(t1, { own: false, html: '<p>t1-init</p>' }, 't1-init');
    room.post(t2, { own: false, html: '<p>t2-init</p>' }, 't2-init');

    const received: Array<{ id: string; ev: WebEvent }> = [];
    const unsub = room.subscribeMany([t1, t2], (id, ev) => {
      received.push({ id, ev });
    });

    const syncs = received.filter((r) => r.ev.t === 'sync');
    expect(syncs.map((s) => (s.ev.t === 'sync' ? s.ev.topic : ''))).toEqual([t1, t2]);
    const last1 = syncs[0]!.id;
    const last2 = syncs[1]!.id;

    received.length = 0;
    room.post(t1, { own: false, html: '<p>t1-live</p>' }, 't1-live');
    room.post(t2, { own: false, html: '<p>t2-live</p>' }, 't2-live');
    room.post(t3, { own: false, html: '<p>t3-ignored</p>' }, 't3-ignored');
    room.setTyping(t2, true);
    room.setStatus(t1, { agent: 'alpha', model: 'm1' });
    room.setPendingQueue(t2, [{ id: 'p1', content: 'queued', at: 1, canSendNow: true, reason: 'turn' }]);

    expect(received.some((r) => r.ev.t === 'msg' && r.ev.topic === t1 && r.ev.msg.html.includes('t1-live'))).toBe(true);
    expect(received.some((r) => r.ev.t === 'msg' && r.ev.topic === t2 && r.ev.msg.html.includes('t2-live'))).toBe(true);
    expect(received.some((r) => r.ev.t === 'msg' && r.ev.msg.html.includes('t3-ignored'))).toBe(false);
    expect(received.some((r) => r.ev.t === 'typing' && r.ev.topic === t2 && r.ev.on === true)).toBe(true);
    expect(received.some((r) => r.ev.t === 'status' && r.ev.topic === t1 && r.ev.status?.model === 'm1')).toBe(true);
    expect(received.some((r) => r.ev.t === 'pending' && r.ev.topic === t2 && r.ev.items.length === 1)).toBe(true);
    unsub();

    // Reconnect with last1 valid (resume) and no last2 (full sync): t1 resumes while t2 syncs.
    const resumed: Array<{ id: string; ev: WebEvent }> = [];
    const unsub2 = room.subscribeMany([t1, t2], (id, ev) => {
      resumed.push({ id, ev });
    }, [last1]);
    expect(resumed.some((r) => r.ev.t === 'msg' && r.ev.topic === t1 && r.ev.msg.html.includes('t1-live'))).toBe(true);
    expect(resumed.some((r) => r.ev.t === 'resumed' && r.ev.topic === t1)).toBe(true);
    expect(resumed.some((r) => r.ev.t === 'sync' && r.ev.topic === t2)).toBe(true);
    unsub2();

    // Reconnect with both last1 and last2 valid: both resume, global machines/topics sent once.
    const bothResumed: Array<{ id: string; ev: WebEvent }> = [];
    const unsub3 = room.subscribeMany([t1, t2], (id, ev) => {
      bothResumed.push({ id, ev });
    }, [last1, last2]);
    expect(bothResumed.filter((r) => r.ev.t === 'resumed').map((r) => (r.ev.t === 'resumed' ? r.ev.topic : ''))).toEqual([
      t1,
      t2,
    ]);
    expect(bothResumed.filter((r) => r.ev.t === 'machines')).toHaveLength(1);
    expect(bothResumed.filter((r) => r.ev.t === 'topics')).toHaveLength(1);
    unsub3();
  });
});

describe('WebRoom: agent handoff action', () => {
  it('enriches handoff with topic id and title, keeps it out of awaitingQuestion, and attaches via revise', () => {
    const { room, topic, seen } = attached();
    room.renameTopic(topic, 'Refactor auth');
    const posted = room.post(
      topic,
      {
        own: false,
        html: '<p>refused</p>',
        handoff: {
          agentId: 'oc',
          agentName: 'opencode',
          fromAgent: 'claude',
          sessionId: 'ses_123',
          workdir: '/home/me/projects/app',
          sameHost: true,
        },
      },
      'refused'
    );
    expect(posted.handoff).toEqual({
      agentId: 'oc',
      agentName: 'opencode',
      fromAgent: 'claude',
      sessionId: 'ses_123',
      workdir: '/home/me/projects/app',
      sameHost: true,
      fromTopicId: topic,
      fromTopicTitle: 'Refactor auth',
    });
    // Must not put the topic into amber "waiting on your answer" state.
    expect(room.topicList().find((t) => t.id === topic)?.stage).not.toBe('answer');

    const menuMsg = room.post(
      topic,
      { own: false, html: '<p>pick</p>', buttons: [{ id: 'ag:1:0', label: 'oc' }] },
      'pick'
    );
    room.revise(topic, menuMsg.id, 'refused', [], undefined, undefined, {
      agentId: 'oc',
      agentName: 'opencode',
      fromAgent: 'claude',
      sessionId: 'ses_456',
      sameHost: true,
    });
    const lastMsg = [...seen].reverse().find((s) => s.ev.t === 'msg' && s.ev.msg.id === menuMsg.id);
    expect(lastMsg?.ev.t === 'msg' && lastMsg.ev.msg.handoff).toEqual({
      agentId: 'oc',
      agentName: 'opencode',
      fromAgent: 'claude',
      sessionId: 'ses_456',
      sameHost: true,
      fromTopicId: topic,
      fromTopicTitle: 'Refactor auth',
    });
  });
});
