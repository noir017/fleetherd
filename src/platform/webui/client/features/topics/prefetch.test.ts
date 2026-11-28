import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CacheCopy, CacheMessage, CacheMeta, CacheVersion } from '../../services/cache.js';
import {
  createTopicPrefetcher,
  mergeTopicDelta,
  PRE_DEBOUNCE_MS,
  PRE_RECENT,
  PRE_RECENT_MS,
  PRE_SETTLE_MS,
  type TopicPrefetchDeps,
} from './prefetch.js';
import type { Topic, TopicSnapshotPayload } from './types.js';

const NOW = 1_800_000_000_000;
const seqOf = (last: string | undefined): number => (last ? Number(last.split('.')[2]) : -1);
const isNewer = (a: string | undefined, b: string | undefined): boolean => seqOf(a) > seqOf(b);

function topic(id: string, over: Partial<Topic> = {}): Topic {
  return { id, title: id, lastAt: NOW - 1000, last: `${id}.1.5`, ...over };
}

interface Harness {
  readonly fetched: string[];
  readonly puts: Array<{ id: string; msgs: readonly CacheMessage[]; meta: CacheMeta }>;
  readonly versions: Record<string, CacheVersion>;
  readonly copies: Record<string, CacheCopy>;
  readonly answers: Record<string, (url: URL) => TopicSnapshotPayload>;
}

function setup(topics: Topic[], over: Partial<TopicPrefetchDeps> = {}): { h: Harness; pre: ReturnType<typeof createTopicPrefetcher> } {
  const h: Harness = { fetched: [], puts: [], versions: {}, copies: {}, answers: {} };
  const pre = createTopicPrefetcher({
    doc: { visibilityState: 'visible' } as Document,
    isDbAvailable: () => true,
    isStreamParked: () => false,
    isStreamOpen: () => true,
    getEpoch: () => 1,
    getActiveTopic: () => 'cur',
    getTopics: () => topics,
    topicById: (id) => topics.find((t) => t.id === id) ?? null,
    getVersion: (id) => h.versions[id] ?? { last: '', epoch: 1 },
    isNewer,
    peekCache: async () => {},
    getCache: async (id) => h.copies[id] ?? null,
    putCache: async (id, msgs, meta) => {
      h.puts.push({ id, msgs, meta });
      return true;
    },
    snapshotMsgs: (d) => ((d.messages ?? []) as CacheMessage[]).map((m) => ({ ...m, _g: d.epoch })),
    fetchFn: (async (input: string) => {
      const url = new URL(input, 'http://x/');
      h.fetched.push(url.search);
      const id = url.searchParams.get('t')!;
      const body = h.answers[id]?.(url) ?? { topic: id, epoch: 1, last: `${id}.1.5`, messages: [] };
      return { ok: true, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch,
    now: () => Date.now(),
    ...over,
  });
  return { h, pre };
}

async function settle(ms = PRE_DEBOUNCE_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('mergeTopicDelta', () => {
  const copy: CacheMessage[] = [
    { id: 'w1', _g: 7, html: 'old run' },
    { id: 'w1', _g: 9, html: 'one' },
    { id: 'w2', _g: 9, html: 'two' },
    { id: 'w3', _g: 9, html: 'three' },
  ];

  it('replaces changed messages in place, appends new ones and drops removed ones', () => {
    const out = mergeTopicDelta(copy, {
      epoch: 9,
      delta: true,
      messages: [
        { id: 'w2', html: 'two, edited' },
        { id: 'w4', html: 'four' },
      ],
      seqs: [2, 4],
      gone: ['w3'],
    });
    expect(out.map((m) => `${m._g}:${m.id}:${m.html}`)).toEqual([
      '7:w1:old run',
      '9:w1:one',
      '9:w2:two, edited',
      '9:w4:four',
    ]);
  });

  it('never takes a message of an earlier run for this run one with the same id', () => {
    const out = mergeTopicDelta(copy, { epoch: 9, messages: [{ id: 'w1', html: 'one, edited' }], seqs: [1] });
    expect(out[0]?.html).toBe('old run');
    expect(out[1]?.html).toBe('one, edited');
    // A message kept from an earlier run says so itself (`g`).
    const kept = mergeTopicDelta(copy, { epoch: 9, messages: [{ id: 'w1', g: 7, html: 'old, edited' }], seqs: [1] });
    expect(kept[0]?.html).toBe('old, edited');
  });

  it('leaves a change above the copy to paging, and drops a message that became a settings page', () => {
    const out = mergeTopicDelta(
      copy,
      {
        epoch: 9,
        messages: [
          { id: 'w0', html: 'paged out' },
          { id: 'w2', html: 'menu', wasSettings: true },
        ],
        seqs: [3, 6],
      },
      5,
    );
    expect(out.map((m) => m.id)).toEqual(['w1', 'w1', 'w3']);
  });
});

describe('createTopicPrefetcher', () => {
  it('keeps the most recent topics current beside the ones needing a person, but not scheduled or open ones', async () => {
    vi.useFakeTimers({ now: NOW });
    const recent = Array.from({ length: PRE_RECENT + 2 }, (_, i) => topic(`r${i}`, { lastAt: NOW - 1000 - i }));
    const topics = [
      topic('needs', { stage: 'review', lastAt: NOW - PRE_RECENT_MS * 3 }),
      ...recent,
      topic('old', { lastAt: NOW - PRE_RECENT_MS - 1 }),
      topic('sched', { scheduled: true }),
      topic('panel'),
      topic('cur'),
    ];
    const { h, pre } = setup(topics, { isOpen: (id) => id === 'panel' });
    for (let i = 0; i < 6; i += 1) {
      pre.pump();
      await settle(0);
    }
    const ids = h.fetched.map((q) => new URLSearchParams(q).get('t'));
    expect(ids).toEqual(['needs', ...recent.slice(0, PRE_RECENT).map((t) => t.id)]);
    pre.dispose();
  });

  it('waits for a recent topic to finish its turn, then for its row to stand still', async () => {
    vi.useFakeTimers({ now: NOW });
    const row = topic('a', { running: true, last: 'a.1.5' });
    const { h, pre } = setup([row]);
    pre.schedule();
    await settle();
    expect(h.fetched).toEqual([]);

    // The turn ends in a burst: typing off, then the reaction a moment later.
    Object.assign(row, { running: false, last: 'a.1.8' });
    pre.schedule();
    await settle();
    Object.assign(row, { last: 'a.1.9' });
    pre.schedule();
    await settle();
    expect(h.fetched).toEqual([]);

    await settle(PRE_SETTLE_MS);
    expect(h.fetched).toEqual(['?t=a']);
    pre.dispose();
  });

  it('asks only for what changed after its copy and merges the answer into it', async () => {
    vi.useFakeTimers({ now: NOW });
    const { h, pre } = setup([topic('a', { last: 'a.1.9' })]);
    h.versions.a = { last: 'a.1.5', epoch: 1 };
    h.copies.a = {
      msgs: [
        { id: 'w1', _g: 1, html: 'one' },
        { id: 'w2', _g: 1, html: 'two' },
      ],
      epoch: 1,
      last: 'a.1.5',
      stale: false,
      hasMore: true,
      oldestSeq: 3,
    };
    h.answers.a = () => ({
      topic: 'a',
      epoch: 1,
      last: 'a.1.9',
      delta: true,
      messages: [
        { id: 'w2', html: 'two, final' },
        { id: 'w3', html: 'three' },
      ],
      seqs: [4, 5],
    });
    pre.pump();
    await settle(0);

    expect(h.fetched).toEqual(['?t=a&since=a.1.5']);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]?.msgs.map((m) => m.html)).toEqual(['one', 'two, final', 'three']);
    expect(h.puts[0]?.meta).toEqual({ epoch: 1, last: 'a.1.9', stale: false, hasMore: true, oldestSeq: 3 });
    pre.dispose();
  });

  it('fetches the whole topic when the copy it would merge into is older than it asked from', async () => {
    vi.useFakeTimers({ now: NOW });
    const { h, pre } = setup([topic('a', { last: 'a.1.9' })]);
    h.versions.a = { last: 'a.1.5', epoch: 1 };
    h.copies.a = { msgs: [{ id: 'w1', _g: 1, html: 'one' }], epoch: 1, last: 'a.1.2', stale: false };
    h.answers.a = (url) =>
      url.searchParams.has('since')
        ? { topic: 'a', epoch: 1, last: 'a.1.9', delta: true, messages: [{ id: 'w3', html: 'three' }], seqs: [3] }
        : { topic: 'a', epoch: 1, last: 'a.1.9', messages: [{ id: 'w1', html: 'one' }, { id: 'w3', html: 'three' }] };
    pre.pump();
    await settle(0);

    expect(h.fetched).toEqual(['?t=a&since=a.1.5', '?t=a']);
    expect(h.puts.map((p) => p.msgs.length)).toEqual([2]);
    pre.dispose();
  });

  it('does not ask for a delta across a restart', async () => {
    vi.useFakeTimers({ now: NOW });
    const { h, pre } = setup([topic('a', { last: 'a.1.9' })]);
    h.versions.a = { last: 'a.0.5', epoch: 0.5 };
    pre.pump();
    await settle(0);
    expect(h.fetched).toEqual(['?t=a']);
    pre.dispose();
  });
});
