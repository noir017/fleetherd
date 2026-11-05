import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MessageNotEditableError } from '../../core/outbound-errors.js';
import type { SchedulePanelTask, SkillPanelEntry } from '../adapter.js';
import { WebuiConfigSchema } from '../config-schemas.js';
import {
  CHANNEL,
  DIR_TTL_MS,
  inlineImageType,
  OWNER,
  WebRoom,
  type Kept,
  type TranscriptStore,
  type UploadStore,
  type WebuiInstance,
} from './room.js';
import { MAX_TOPICS, TopicStore } from './topics.js';
import { hasTopic } from './index.js';
import type { InboundMessage } from '../../types.js';
import type { WebEvent, WebMessage } from './protocol.js';

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
} {
  const store = new TopicStore(path.join(dir, `${Math.random()}.json`));
  const room = new WebRoom(instance(over), store);
  const topic = store.current().id;
  const seen: Seen[] = [];
  const off = room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
  return { room, topic, seen, off };
}

const kinds = (seen: Seen[]): string[] => seen.map((s) => s.ev.t);
const last = (seen: Seen[]): WebEvent | undefined => seen[seen.length - 1]?.ev;
/** The last event of one kind: an edit that carries buttons now drags a topic list along behind it. */
const lastOf = (seen: Seen[], t: WebEvent['t']): WebEvent | undefined =>
  [...seen].reverse().find((s) => s.ev.t === t)?.ev;

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
    expect(kinds(seenA)).toContain('topics');

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
    const { room, topic, seen } = attached();
    seen.length = 0;
    room.createTopic('second');
    expect(last(seen)).toMatchObject({ t: 'topics' });
    seen.length = 0;
    room.renameTopic(topic, '[cc] a subject');
    expect(last(seen)).toMatchObject({ t: 'topics' });
    expect((last(seen) as { topics: Array<{ title: string }> }).topics.some((t) => t.title === '[cc] a subject')).toBe(true);
  });

  it('tracks running state and msgCount in the topic list', () => {
    const { room, topic, seen } = attached();
    expect(room.topicList().find((t) => t.id === topic)?.running).toBe(false);
    expect(room.topicList().find((t) => t.id === topic)?.msgCount).toBe(0);

    // Typing sets running: true and announces
    seen.length = 0;
    room.setTyping(topic, true);
    expect(room.topicList().find((t) => t.id === topic)?.running).toBe(true);
    expect(seen.some((s) => s.ev.t === 'topics')).toBe(true);

    // Posting a message increments msgCount
    room.post(topic, { own: false, html: '<p>hi</p>' }, 'hi');
    expect(room.topicList().find((t) => t.id === topic)?.msgCount).toBe(1);

    // Stopping typing sets running: false and announces
    seen.length = 0;
    room.setTyping(topic, false);
    expect(room.topicList().find((t) => t.id === topic)?.running).toBe(false);
    expect(seen.some((s) => s.ev.t === 'topics')).toBe(true);
  });

  it('deletes a topic, cleans up room state, and announces the updated list', () => {
    const { room, seen } = attached();
    const second = room.createTopic('second');
    room.post(second.id, { own: false, html: '<p>msg</p>' }, 'msg');
    seen.length = 0;

    expect(room.deleteTopic(second.id)).toBe(true);
    expect(room.topicList().some((t) => t.id === second.id)).toBe(false);
    expect(last(seen)).toMatchObject({ t: 'topics' });
    expect((last(seen) as { topics: Array<{ id: string }> }).topics.some((t) => t.id === second.id)).toBe(false);

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
    const { room, topic, seen } = attached();
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
    expect(kinds(seen)).toEqual(['topics']);
    expect((last(seen) as { topics: Array<{ id: string }> }).topics.map((t) => t.id)).toEqual([fresh.id]);

    vi.advanceTimersByTime(60_000);
    expect(kinds(seen)).toEqual(['topics']);
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
    expect(lastId).toMatch(new RegExp(`^${topic}\\.\\d+$`));
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
    // `topics` is the one event that crosses rooms, so it is in no topic's backlog and nothing
    // could be resumed from it. A browser only advances Last-Event-ID when it sees an `id:`
    // field, so leaving it off keeps the resume point pointing at the last event that IS
    // replayable — numbering it would silently break the resume it looks like it enables.
    const { room, seen } = attached();
    seen.length = 0;
    room.createTopic('another');
    expect(seen.map((s) => [s.ev.t, s.id])).toEqual([['topics', '']]);
  });

  it('falls back to a full sync when it has nothing to resume from', () => {
    const { room, topic } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    for (const lastId of [undefined, 'garbage', `${topic}.notanumber`, 'someothertopic.1']) {
      const seen: Seen[] = [];
      room.subscribe(topic, (id, ev) => seen.push({ id, ev }), lastId);
      expect(seen[0]?.ev.t).toBe('sync');
    }
  });

  it('falls back to a full sync rather than handing over a transcript with a hole in it', () => {
    const { room, topic } = attached();
    // Further back than the backlog keeps: the gap cannot be filled, and pretending otherwise
    // would silently drop messages out of the middle of the conversation.
    for (let i = 0; i < 400; i += 1) room.post(topic, { own: false, html: '' }, '');
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }), `${topic}.1`);
    expect(seen[0]?.ev.t).toBe('sync');
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
    const url = await room.publishCopy('/tmp/talkcode-file-x/report.pdf', 'report.pdf');
    expect(uploads.copied).toEqual(['/tmp/talkcode-file-x/report.pdf']);
    expect(room.resolveDownload(url.slice(2))).toMatchObject({ path: '/uploads/copy-1', name: 'report.pdf', owned: true });
    for (let i = 0; i < 200; i++) room.publish(`/work/f${i}.txt`, `f${i}.txt`);
    await Promise.resolve();
    await Promise.resolve();
    expect(uploads.discarded).toEqual(['/uploads/copy-1']);
    // The agent's own file was only ever read.
    expect(uploads.discarded).not.toContain('/tmp/talkcode-file-x/report.pdf');
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
    // would merge into one paragraph and the page would have nothing left to fold.
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
          '<div class="tl"><span class="tl-c">💻 Bash: &quot;ls *.ts&quot;</span><span class="tl-s"> ✓ 5ms</span></div>' +
          '<div class="tl"><span class="tl-c">📖 Read: &quot;a_b_c.md&quot;</span></div>' +
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
    room.useWorkdirLookup((ref) => (ref.thread === topic ? { path: '/home/user/workspace/talkcode' } : undefined));

    expect(room.topicList().find((t) => t.id === topic)?.dir).toEqual({
      name: 'talkcode',
      path: '/home/user/workspace/talkcode',
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

  /** The row's label as the last topic list sent said it. */
  const sentDir = (seen: Seen[], topic: string): string | undefined => {
    const ev = lastOf(seen, 'topics') as { topics: Array<{ id: string; dir?: { name: string; host?: string } }> } | undefined;
    const dir = ev?.topics.find((t) => t.id === topic)?.dir;
    return dir ? `${dir.host ?? ''}·${dir.name}` : undefined;
  };

  it('reads the label again after the operator writes, so the answer to a /agent or /cd carries the move', () => {
    // A new topic picked an agent on another machine (2026-11-02, the launcher): the ack and the
    // directory menu both announced the list inside the TTL, and the row went on naming the default
    // agent's machine until something happened to announce it again.
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    let where = { path: '/home/u/workspace', host: 'uniagent' };
    room.useWorkdirLookup(() => where);
    room.topicList();

    room.submit({ topic, text: '/agent oc2' });
    where = { path: '/home/u/workspace', host: 'awsfree2' }; // what the daemon did with it
    room.post(topic, { own: false, html: '<p>ack</p>' }, '▸ opencode is answering');
    expect(sentDir(seen, topic)).toBe('awsfree2·workspace');

    // And a tap, the other way the operator moves a topic: a `/cd` menu pick.
    const menu = room.post(topic, { own: false, html: '', buttons: [{ id: 'wdr:r:1', label: 'quantlab' }] }, 'Working dir:');
    room.click({ topic, messageId: menu.id, buttonId: 'wdr:r:1' });
    where = { path: '/home/u/workspace/quantlab', host: 'awsfree2' };
    room.revise(topic, menu.id, 'Now working in quantlab', []);
    expect(sentDir(seen, topic)).toBe('awsfree2·quantlab');
  });

  it('is corrected by the liveness poll when a move lands after its own announcement', () => {
    // A `/cd` on a host lists the directory over the link before it applies, so the list sent with
    // the echo is already out of date and nothing else is coming. The poll reads the label fresh.
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    let path = '/srv/a';
    room.useWorkdirLookup(() => ({ path }));
    room.useLivenessLookup(() => false);
    seen.length = 0;

    vi.advanceTimersByTime(60_000);
    expect(kinds(seen)).not.toContain('topics'); // nothing moved, nothing sent

    path = '/srv/b';
    vi.advanceTimersByTime(60_000);
    expect(sentDir(seen, topic)).toBe('·b');
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
    expect(kinds(seen)).toContain('topics');
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
    expect(kinds(seen)).not.toContain('topics');
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
    const { room, topic, seen } = attached();
    let up = true;
    room.useLivenessLookup(() => up);
    seen.length = 0;

    // Nothing changed: the poll stays silent rather than re-sending the list every tick.
    vi.advanceTimersByTime(60_000);
    expect(kinds(seen)).not.toContain('topics');

    up = false;
    vi.advanceTimersByTime(60_000);
    expect(kinds(seen)).toContain('topics');
    expect((lastOf(seen, 'topics') as { topics: Array<{ id: string; live?: boolean }> }).topics
      .find((t) => t.id === topic)?.live).toBe(false);
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
    const { room, topic: idle, seen } = attached();
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
    return { room, seen, asked, idle, working, asking, stubborn };
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
    const { room, seen, idle } = fleet();
    seen.length = 0;
    room.closeIdle([idle]);
    const listed = (lastOf(seen, 'topics') as { topics: Array<{ id: string; live?: boolean }> } | undefined)?.topics;
    expect(listed?.find((t) => t.id === idle)?.live).toBe(false);
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
    // One list, not one for the eviction and another for the creation.
    expect(kinds(seen).filter((k) => k === 'topics')).toHaveLength(1);
  });

  it('takes an evicted topic\'s kept transcript with it', () => {
    const { room, ids } = full();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dropped: string[] = [];
    room.useTranscripts({ load: () => new Map(), save: () => {}, drop: (t) => void dropped.push(t) });
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

    expect(() => room.createTopic()).toThrow(/every one of the 64 topics is starred or in use; unstar or delete one/);
    expect(store.list()).toHaveLength(MAX_TOPICS);
  });

  it('announces a star, and refuses one for a topic that does not exist', () => {
    const { room, topic, seen } = attached();
    seen.length = 0;
    expect(room.starTopic(topic, true)).toBe(true);
    expect((lastOf(seen, 'topics') as { topics: Array<{ id: string; starred?: boolean }> }).topics
      .find((t) => t.id === topic)?.starred).toBe(true);
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
    expect(last(resumed)).toEqual({ t: 'status', status: { ...STATUS, context: { used: 399, size: 200_000 } } });
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
    expect(last(resumed)).toEqual({ t: 'status' });
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

  it('says the daemon offered none rather than pretending there are no tasks', () => {
    const { room } = attached();

    expect(room.schedules()).toEqual({ enabled: false, tasks: [] });
    expect(room.scheduleOp('a1b2c3', 'pause')).toEqual({
      ok: false,
      error: 'scheduled tasks are not enabled in this daemon',
    });
  });

  it('reads the list through the daemon and forwards each action', () => {
    const { room } = attached();
    const ops: string[] = [];
    room.useSchedulePanel({
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
});

describe('WebRoom: the skills page', () => {
  const skill: SkillPanelEntry = {
    name: 'deploy-check',
    description: 'Use when checking a deployment',
    version: '0123456789ab',
    status: 'active',
    pinned: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    uses: 3,
    agents: ['cc'],
  };

  it('says the daemon offered none rather than pretending there are no skills', () => {
    const { room } = attached();

    expect(room.skills()).toEqual({ enabled: false, skills: [] });
    expect(room.skillOp({ action: 'show', name: 'deploy-check' })).toEqual({
      ok: false,
      error: 'skills are not enabled in this daemon',
    });
  });

  it('reads the list through the daemon and forwards each operation', () => {
    const { room } = attached();
    const ops: string[] = [];
    room.useSkillsPanel({
      list: () => [skill],
      op: (op) => {
        ops.push(op.action);
        return { ok: true, skills: [{ ...skill, pinned: true }] };
      },
    });

    expect(room.skills()).toEqual({ enabled: true, skills: [skill] });
    expect(room.skillOp({ action: 'pin', name: 'deploy-check', pinned: true })).toEqual({
      ok: true,
      skills: [{ ...skill, pinned: true }],
    });
    expect(ops).toEqual(['pin']);
  });
});
