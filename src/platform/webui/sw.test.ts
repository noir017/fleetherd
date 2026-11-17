/**
 * The service worker's script, run in a context of its own with the few things a worker has —
 * `self`, its registration and clients, `fetch`, IndexedDB (fake-indexeddb) — so what a push does
 * can be checked without a browser. Only the push handler is exercised here: keeping the topic a
 * push is about is the part that writes, and what it writes must be a record the page reads.
 */
import vm from 'node:vm';

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { SERVICE_WORKER } from './sw.js';

interface Client {
  visibilityState: string;
  url: string;
  posted: unknown[];
  postMessage(m: unknown): void;
}

interface Worker {
  idb: IDBFactory;
  fetched: string[];
  shown: Array<{ title: string; tag: string }>;
  clients: Client[];
  /** Dispatch a push with this payload and wait for everything it handed to waitUntil. */
  push(payload: unknown): Promise<void>;
}

const TOPIC = 'b2c3d4e5';
const snapshot = {
  topic: TOPIC,
  epoch: 7,
  last: `${TOPIC}.run.4`,
  lastAt: 900,
  messages: [
    { id: 'w1', html: '<p>question</p>', at: 800 },
    { id: 'w2', html: '<p>the reply</p>', at: 900 },
  ],
};

function worker(opts: { visible?: boolean; status?: number; idb?: boolean } = {}): Worker {
  const idb = new IDBFactory();
  const fetched: string[] = [];
  const shown: Array<{ title: string; tag: string }> = [];
  const handlers: Record<string, (e: unknown) => void> = {};
  const client: Client = {
    visibilityState: opts.visible ? 'visible' : 'hidden',
    url: 'https://chat.example/',
    posted: [],
    postMessage(m) {
      this.posted.push(m);
    },
  };
  const clients = [client];
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    registration: {
      scope: 'https://chat.example/',
      showNotification: (title: string, o: { tag: string }) => {
        shown.push({ title, tag: o.tag });
        return Promise.resolve();
      },
    },
    clients: { matchAll: () => Promise.resolve(clients) },
    indexedDB: opts.idb === false ? undefined : idb,
  };
  const fetch = (url: string): Promise<unknown> => {
    fetched.push(url);
    const status = opts.status ?? 200;
    return Promise.resolve({ ok: status === 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(snapshot))) });
  };
  vm.runInNewContext(SERVICE_WORKER, { self, fetch, Promise, JSON, Date, Math, encodeURIComponent });
  return {
    idb,
    fetched,
    shown,
    clients,
    async push(payload) {
      let wait: Promise<unknown> = Promise.resolve();
      handlers.push!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => (wait = p) });
      await wait;
    },
  };
}

/** The record as the page reads it (cacheRead): the JSON string parsed, and what it is a copy of. */
function record(idb: IDBFactory, topic: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const rq = idb.open('aa_cache', 1);
    rq.onsuccess = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('topics')) {
        db.close();
        return resolve(null);
      }
      const get = db.transaction('topics').objectStore('topics').get(topic);
      get.onsuccess = () => {
        db.close();
        const r = get.result as { json: string } | undefined;
        resolve(r ? { ...r, list: JSON.parse(r.json) as unknown[] } : null);
      };
    };
  });
}

describe('service worker: the topic a push is about', () => {
  it('shows the notification and keeps the topic where the page will look for it', async () => {
    const w = worker();
    await w.push({ topic: TOPIC, title: 'Topic', body: 'done' });

    expect(w.shown).toEqual([{ title: 'Topic', tag: TOPIC }]);
    expect(w.fetched).toEqual([`api/topic?t=${TOPIC}`]);
    const rec = await record(w.idb, TOPIC);
    // Whole and from run 7, so a page of that run resumes from `last` instead of syncing.
    expect(rec).toMatchObject({ topic: TOPIC, epoch: 7, lastAt: 900, last: `${TOPIC}.run.4` });
    expect((rec?.list as Array<{ id: string; _g: number }>).map((m) => [m.id, m._g])).toEqual([
      ['w1', 7],
      ['w2', 7],
    ]);
    // A page open in the background is told, so its prefetch does not fetch the same topic again.
    expect(w.clients[0]!.posted).toEqual([{ cached: { topic: TOPIC, epoch: 7, lastAt: 900, last: `${TOPIC}.run.4` } }]);
  });

  it('fetches nothing while a page is on screen: that page fetches what needs the person itself', async () => {
    const w = worker({ visible: true });
    await w.push({ topic: TOPIC, title: 'Topic', body: 'done' });
    expect(w.shown).toHaveLength(1);
    expect(w.fetched).toEqual([]);
    expect(await record(w.idb, TOPIC)).toBeNull();
  });

  it('still shows the notification when the topic cannot be had', async () => {
    const w = worker({ status: 302 });
    await w.push({ topic: TOPIC, title: 'Topic', body: 'done' });
    expect(w.shown).toHaveLength(1);
    expect(await record(w.idb, TOPIC)).toBeNull();
    expect(w.clients[0]!.posted).toEqual([]);
  });

  it('keeps nothing without IndexedDB, and fetches nothing it could not keep', async () => {
    const w = worker({ idb: false });
    await w.push({ topic: TOPIC, title: 'Topic', body: 'done' });
    expect(w.shown).toHaveLength(1);
    expect(w.fetched).toEqual([]);
  });

  it('fetches nothing for a push that names no topic', async () => {
    const w = worker();
    await w.push({ title: 'fleetherd', body: 'hello' });
    expect(w.shown).toEqual([{ title: 'fleetherd', tag: 'fleetherd' }]);
    expect(w.fetched).toEqual([]);
  });
});
