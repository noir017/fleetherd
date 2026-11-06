/**
 * The inline client script, exercised in a real DOM.
 *
 * `page.test.ts` is the cheap half of testing this file: it greps the served HTML and proves the
 * script parses. That catches a stray brace and a character the template literal ate, and it
 * catches nothing else — which is how 1.15.0 shipped a page that rendered nothing at all while
 * its event stream was perfectly healthy. Every gate in this repo was green for that bug, because
 * to all of them `page.ts` is one long string.
 *
 * So this file loads what the daemon actually serves into jsdom, stubs the two things a browser
 * gives the script that Node does not (`EventSource` and `fetch`), and drives it through the
 * events `room.ts` really emits. The assertions are about what a person would see: how many
 * messages are on screen, whether the drawer is open, where the URL points.
 *
 * ── Two jsdom limits worth knowing before adding to this file ────────────────
 *   - It does not evaluate `@media` at all, so `getComputedStyle` always reports the desktop
 *     cascade. Responsive rules are therefore checked by walking `document.styleSheets`, not by
 *     resizing and reading computed values. The *script's* own narrow-screen branches do respond
 *     to `innerWidth`, and those are driven normally.
 *   - Its CSSOM keeps only the last of two declarations of one property, so a deliberate
 *     `height:100vh; height:100dvh` fallback pair reads as collapsed here while being correct in
 *     a browser. Do not "fix" the stylesheet to satisfy a serialization artifact.
 *
 * `EventSource` is installed in `beforeParse`, before the script runs, deliberately: evaluating
 * the script a second time to give it a stubbed global would register every listener twice and
 * fire every click handler twice. `indexedDB` — which jsdom does not implement at all — goes in
 * the same way, as a `fake-indexeddb` factory the harness can hand to a SECOND page so a reload,
 * or a daemon restart under a page that is still open, can be driven end to end.
 */
import { describe, it, expect, vi } from 'vitest';
import { JSDOM, type DOMWindow } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';

import { renderPage } from './page.js';
import { renderWebToolLines } from '../web-markdown.js';

/** One `fetch` the page made, in the shape the assertions care about. */
interface Call {
  path: string;
  body: Record<string, unknown>;
}

/** The stub for the one browser API the whole page is built on. */
interface Stream {
  url: string;
  readyState: number;
  closed: boolean;
  onmessage: ((e: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
}

/** What the page can see of a fake MediaRecorder: enough to feed it audio and read what it chose. */
interface FakeRecorder {
  mimeType: string;
  state: 'inactive' | 'recording';
  /** Tracks of the stream it records, so a test can see the microphone was let go. */
  tracksStopped: () => boolean;
  /** Hand it a chunk, as the browser does while recording. */
  feed: (bytes: string) => void;
}

interface Harness {
  window: DOMWindow;
  doc: Document;
  /** Every stream the page has opened, oldest first — switching topics opens another. */
  streams: Stream[];
  /** The one currently connected. */
  live: () => Stream;
  /** Deliver a server event down the live stream, as `api/events` would. */
  emit: (ev: Record<string, unknown>) => Promise<void>;
  calls: Call[];
  /** Mutable per-path HTTP status, so a send can be made to fail (and then succeed) mid-test. */
  status: Record<string, number>;
  /** The page's own database, to hand to a second page or to read back. */
  idb: IDBFactory | null;
  /** What this browser has cached for a topic, as the page would read it back. */
  cached: (topic: string) => Promise<Array<Record<string, unknown>> | null>;
  /** Everything written to `navigator.clipboard` by the page. */
  clipboard: string[];
  /** Everything the page raised in an `alert()`. */
  alerts: string[];
  /** Every question the page put to `confirm()`, whatever it was answered. */
  confirms: string[];
  /** Every MediaRecorder the page constructed (only with the `mic` option), oldest first. */
  recorders: FakeRecorder[];
  /** The delay of every timer the page armed for 10 s or more (only with `shortenLong`), in ms. */
  longTimers: number[];
  /** What the page did with the push APIs (only with the `push` option). */
  push: PushLog;
  el: (id: string) => HTMLElement;
  /** Messages currently painted in the transcript. */
  painted: () => number;
  /** Placeholder blocks held in the transcript while a sync is in flight. */
  skeletons: () => number;
  /** The "still waiting on the daemon" line under a transcript painted from cache. */
  waiting: () => string | null;
  /** Topic rows currently painted in the sidebar. */
  rows: () => number;
  /** The "why is this room empty" notice, when one is on screen. */
  notice: () => string | null;
  click: (selector: string) => Promise<void>;
}

/** What a page did with a fake push-capable browser (see installPush). */
interface PushLog {
  registered?: string;
  subscribedWith?: { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
  unsubscribed: boolean;
  /** The worker's message listeners, so a test can play a tapped notification. */
  listeners: Array<(e: { data: unknown }) => void>;
}

/**
 * A browser that can do Web Push, installed before the page's script runs: a service-worker
 * container whose registration's pushManager hands out one subscription, and a Notification whose
 * permission prompt answers `answer`. jsdom has none of these.
 */
function installPush(
  w: any,
  opts: { permission?: string; answer?: string; subscribed?: boolean },
  log: PushLog
): void {
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/dev1',
    toJSON() {
      return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: 'P', auth: 'A' } };
    },
    unsubscribe: async () => {
      log.unsubscribed = true;
      current = null;
      return true;
    },
  };
  let current: typeof sub | null = opts.subscribed ? sub : null;
  const reg = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async (o: PushLog['subscribedWith']) => {
        log.subscribedWith = o;
        current = sub;
        return sub;
      },
    },
  };
  Object.defineProperty(w, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(w.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: async (url: string) => {
        log.registered = url;
        return reg;
      },
      ready: Promise.resolve(reg),
      getRegistration: async () => (current || log.registered ? reg : undefined),
      addEventListener: (_t: string, fn: (e: { data: unknown }) => void) => log.listeners.push(fn),
    },
  });
  w.PushManager = function PushManager() {};
  w.Notification = {
    permission: opts.permission ?? 'default',
    requestPermission: async () => {
      w.Notification.permission = opts.answer ?? 'granted';
      return w.Notification.permission;
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Long enough for the page's write debounce (SAVE_MS) to have fired and the write to land. */
const saved = (): Promise<void> => new Promise((r) => setTimeout(r, 550));

/**
 * Spin the macrotask queue until something becomes true.
 *
 * `FileReader` resolves over several turns in jsdom, and how many is an implementation detail —
 * a fixed number of `tick()`s here would be a test that passes until jsdom changes its mind. The
 * cache read on the way into a topic is the same shape of wait, one IndexedDB turn instead.
 */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (ok()) return;
    await tick();
  }
  throw new Error(`never happened: ${what}`);
}

/**
 * `until`, for a wait that really is wall-clock. The page's own back-off between two attempts at a
 * send is 700 ms, which a count of macrotask turns cannot stand in for.
 */
async function within(what: string, ms: number, ok: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never happened within ${ms} ms: ${what}`);
}

/** The same wait, for a condition that is itself a database read. */
async function untilAsync(what: string, ok: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await ok()) return;
    await tick();
  }
  throw new Error(`never happened: ${what}`);
}

/**
 * The names on the composer's attachment chips, in order. Read off `.chip-name` rather than the
 * chips' text, because a chip also carries its × — and a thumbnail's alt, which is not text.
 */
function chipNames(h: { el: (id: string) => HTMLElement }): string[] {
  return Array.from(h.el('chips').querySelectorAll('.chip-name')).map((n) => n.textContent ?? '');
}

/** A sync in the shape `WebRoom.syncEvent` builds it. `extra` carries the optional flags. */
function sync(
  topic: string,
  messages: Array<Record<string, unknown>>,
  topics: string[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    t: 'sync',
    topic,
    messages,
    commands: [{ name: 'new', description: 'start over' }],
    // One daemon, unless a test is specifically about a restart. Ids are per process, so this is
    // what keeps a cached `w1` and a fresh `w1` from being taken for the same message.
    epoch: 1,
    topics: topics.map((id, i) => ({
      id,
      title: `Topic ${id}`,
      lastAt: 1000 - i,
      running: false,
      msgCount: id === topic ? messages.length : 0,
    })),
    ...extra,
  };
}

function message(id: string, html: string, own = false): Record<string, unknown> {
  return { id, html, at: 1758240000000, own };
}

/**
 * A recording-capable browser, installed before the page's script runs: `getUserMedia` answers a
 * stream whose tracks remember being stopped, and MediaRecorder hands back what it was fed, as the
 * real one does — in `dataavailable` events, then `stop`, asynchronously.
 */
function installMic(w: any, mic: { types: string[]; deny?: boolean }, recorders: FakeRecorder[]): void {
  Object.defineProperty(w.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () => {
        if (mic.deny) return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
        const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
        return Promise.resolve({ getTracks: () => tracks });
      },
    },
  });
  class FakeMediaRecorder {
    static isTypeSupported(t: string): boolean {
      return mic.types.includes(t);
    }
    state: 'inactive' | 'recording' = 'inactive';
    mimeType: string;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    private chunks: string[] = [];
    constructor(
      readonly stream: { getTracks(): Array<{ stopped: boolean }> },
      opts?: { mimeType?: string }
    ) {
      this.mimeType = opts?.mimeType ?? '';
      recorders.push(this);
    }
    tracksStopped(): boolean {
      return this.stream.getTracks().every((t) => t.stopped);
    }
    feed(bytes: string): void {
      this.chunks.push(bytes);
    }
    start(): void {
      this.state = 'recording';
    }
    stop(): void {
      this.state = 'inactive';
      setTimeout(() => {
        for (const c of this.chunks) this.ondataavailable?.({ data: new w.Blob([c]) });
        this.onstop?.();
      }, 0);
    }
  }
  w.MediaRecorder = FakeMediaRecorder;
}

async function open(
  opts: {
    url?: string;
    width?: number;
    height?: number;
    /** What each request answers with; anything unlisted answers `{}`, as most routes do. */
    replies?: Record<string, unknown>;
    /** Per-path HTTP status. Anything unlisted answers 200; ≥400 is `ok: false`. */
    status?: Record<string, number>;
    /**
     * The database this page opens. Pass a previous harness's to reload the same browser;
     * pass `null` for one that has no IndexedDB at all, which is a real browser configuration
     * and must not take the page down with it.
     */
    idb?: IDBFactory | null;
    /**
     * localStorage as the page finds it. jsdom gives every page a fresh one, so this is how a
     * reload carries what the last page wrote: read it off that page's window and pass it here.
     */
    storage?: Record<string, string>;
    /** What `confirm()` returns — a destructive control is only half tested by the yes path. */
    confirm?: boolean;
    /** Whether the daemon serves a terminal, which the page is told once at render time. */
    terminal?: boolean;
    /** Whether the daemon was given a way to END a terminal session (terminal.endCommand). */
    terminalEnd?: boolean;
    /** Whether the shared secret is still a way in, i.e. which of the two gates is served. */
    password?: boolean;
    /**
     * A browser that can record: the MediaRecorder types it supports, and whether the user
     * refuses the microphone. Absent = jsdom as it is, with neither mediaDevices nor MediaRecorder.
     */
    mic?: { types: string[]; deny?: boolean };
    /**
     * Paths whose request is never answered. The stub settles it only the way a browser's fetch
     * does when its AbortSignal fires: by rejecting with an AbortError. A page that never aborts
     * therefore waits for ever, which is exactly the bug this exists to reproduce.
     */
    hang?: string[];
    /**
     * Paths whose answer waits for a promise the test settles, so two requests can be made to
     * answer in the order a slow link would choose rather than the order they were sent.
     */
    held?: Record<string, Promise<void>>;
    /**
     * Run any timer of 10 s or more after 30 ms instead, and write down what it was asked for.
     * That is how a 15-second request limit is both exercised and checked for its value without
     * a test that takes 15 seconds. Off by default: only the tests about those limits want it.
     */
    shortenLong?: boolean;
    /** A browser that can do Web Push (see installPush). Absent = jsdom as it is: no notifications offered. */
    push?: { permission?: string; answer?: string; subscribed?: boolean };
  } = {}
): Promise<Harness> {
  const {
    url = 'http://localhost:8787/',
    width = 1440,
    height = 900,
    replies = {},
    status = {},
    idb = new IDBFactory(),
    storage = {},
    confirm = true,
    terminal = false,
    terminalEnd = false,
    password = true,
    mic,
    hang = [],
    held = {},
    shortenLong = false,
    push,
  } = opts;
  const pushLog: PushLog = { unsubscribed: false, listeners: [] };
  const streams: Stream[] = [];
  const recorders: FakeRecorder[] = [];
  const calls: Call[] = [];
  const clipboard: string[] = [];
  const alerts: string[] = [];
  const confirms: string[] = [];
  const longTimers: number[] = [];

  const dom = new JSDOM(renderPage('Chat', terminal, password, terminalEnd), {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, 'innerWidth', { value: width, configurable: true });
      Object.defineProperty(w, 'innerHeight', { value: height, configurable: true });
      if (idb) (w as any).indexedDB = idb;
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      Object.defineProperty(w.navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (s: string) => {
            clipboard.push(s);
            return Promise.resolve();
          },
        },
      });
      class FakeEventSource implements Stream {
        readyState = 1;
        closed = false;
        onmessage: ((e: { data: string }) => void) | null = null;
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(readonly url: string) {
          streams.push(this);
          // The script assigns onopen after constructing, so this cannot be synchronous.
          setTimeout(() => this.onopen?.(), 0);
        }
        close(): void {
          this.readyState = 2;
          this.closed = true;
        }
      }
      (w as any).EventSource = FakeEventSource;
      (w as any).confirm = (s: string) => {
        confirms.push(String(s));
        return confirm;
      };
      // jsdom has no alert, and the page uses one to report a refused "end session". Recorded
      // rather than ignored: "the button failed and said nothing" is the bug worth catching.
      (w as any).alert = (s: string) => {
        alerts.push(String(s));
      };
      if (mic) installMic(w, mic, recorders);
      if (push) installPush(w, push, pushLog);
      if (shortenLong) {
        const real = w.setTimeout.bind(w) as (fn: () => void, ms: number) => number;
        (w as any).setTimeout = (fn: () => void, ms: number): number => {
          if (ms < 10_000) return real(fn, ms);
          longTimers.push(ms);
          return real(fn, 30);
        };
      }
      (w as any).fetch = (path: string, init: { body?: string; signal?: AbortSignal }) => {
        // A GET (the file reader's) carries no body; recorded as an empty one.
        calls.push({ path, body: init.body === undefined ? {} : JSON.parse(init.body) });
        if (hang.includes(path)) {
          return new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
            );
          });
        }
        const code = status[path] ?? 200;
        return (held[path] ?? Promise.resolve()).then(() => ({
          ok: code < 400,
          status: code,
          json: () => Promise.resolve(replies[path] ?? {}),
        }));
      };
    },
  });

  await tick();
  const doc = dom.window.document;
  const live = (): Stream => {
    const open = streams.filter((s) => !s.closed);
    const last = open[open.length - 1];
    if (!last) throw new Error('no stream is connected');
    return last;
  };
  return {
    window: dom.window,
    doc,
    streams,
    live,
    calls,
    status,
    idb,
    clipboard,
    alerts,
    confirms,
    recorders,
    longTimers,
    push: pushLog,
    cached: (topic) => readCache(idb, topic),
    emit: async (ev) => {
      live().onmessage?.({ data: JSON.stringify(ev) });
      await tick();
    },
    el: (id) => {
      const found = doc.getElementById(id);
      if (!found) throw new Error(`#${id} is not in the document`);
      return found;
    },
    painted: () => doc.getElementById('log')!.querySelectorAll(':scope > .m').length,
    skeletons: () => doc.getElementById('log')!.querySelectorAll(':scope > .sk').length,
    waiting: () => doc.querySelector('#log > .syncing')?.textContent ?? null,
    rows: () => doc.getElementById('topics')!.children.length,
    notice: () => doc.querySelector('#log > .empty')?.textContent ?? null,
    click: async (selector) => {
      const target = doc.querySelector<HTMLElement>(selector);
      if (!target) throw new Error(`nothing matches ${selector}`);
      target.click();
      await tick();
    },
  };
}

/**
 * Read one topic's cached transcript straight out of the database.
 *
 * Deliberately not through the page: what is asserted is what a RELOAD would find, so it is read
 * the way the next page would read it rather than the way this one remembers writing it.
 */
function readCache(idb: IDBFactory | null, topic: string): Promise<Array<Record<string, unknown>> | null> {
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rq = idb.open('aa_cache', 1);
    rq.onerror = () => resolve(null);
    rq.onsuccess = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('topics')) {
        db.close();
        return resolve(null);
      }
      const get = db.transaction('topics').objectStore('topics').get(topic);
      get.onerror = () => {
        db.close();
        resolve(null);
      };
      get.onsuccess = () => {
        const rec = get.result as { json?: string } | undefined;
        db.close();
        resolve(rec?.json ? (JSON.parse(rec.json) as Array<Record<string, unknown>>) : null);
      };
    };
  });
}

describe('webui page: rendering', () => {
  it('renders the sync for a topic the client never named', async () => {
    // The 1.15.0 regression, and the reason this file exists. A first visit has no ?t=, so the
    // client's topic is '' and `stream()` answers for `topics.current()` — a sync carrying an id
    // the page never asked for. Dropping it left an empty shell behind a healthy event stream.
    const h = await open({ url: 'http://localhost:8787/' });
    expect(h.live().url).toBe('api/events');

    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>'), message('m2', '<p>hi</p>', true)], ['a1b2c3d4']));

    expect(h.painted()).toBe(2);
    expect(h.el('log').textContent).toContain('hello');
    expect(h.rows()).toBe(1);
    expect(h.el('topic-title').textContent).toBe('Topic a1b2c3d4');
    // Written into the URL, so the reload after it lands in the same room.
    expect(h.window.location.search).toBe('?t=a1b2c3d4');
  });

  it('shows an operator message as typed, numbers and line breaks intact', async () => {
    // The bug this is here for: rendered as markdown, "-ce 2" ends the first list and "2." opens
    // a second one that renumbers from 1, so a prompt written 1./2. read back 1./1. `room.ts`
    // now sends the text escaped rather than rendered — this checks the page shows it that way,
    // which is the half of the fix a server-side test cannot see.
    const h = await open();
    const typed = '1. sada\n- ces1\n-ce 2\n2. test3';
    await h.emit(sync('a1b2c3d4', [message('m1', `<div class="raw">${typed}</div>`, true)], ['a1b2c3d4']));

    expect(h.painted()).toBe(1);
    expect(h.el('log').querySelector('ol')).toBeNull();
    expect(h.el('log').querySelector('.raw')?.textContent).toBe(typed);
  });

  it('still ignores a sync for a topic it has already left', async () => {
    // The guard the regression came from is real, just misaimed: once we ARE on a topic, a sync
    // for another one is a stale stream talking and must not repaint the transcript.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>mine</p>')], ['a1b2c3d4']));
    expect(h.painted()).toBe(1);

    await h.emit(sync('ffffffff', [message('x1', '<p>someone else</p>'), message('x2', '<p>and more</p>')], ['ffffffff']));

    expect(h.painted()).toBe(1);
    expect(h.el('log').textContent).toContain('mine');
    expect(h.el('log').textContent).not.toContain('someone else');
  });

  it('appends, edits, drops and reacts as the events arrive', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>')], ['a1b2c3d4']));

    await h.emit({ t: 'msg', msg: message('m2', '<p>second</p>') });
    expect(h.painted()).toBe(2);

    // Same id is an edit in place, which is the whole streaming model: one live-edited message.
    await h.emit({ t: 'msg', msg: message('m2', '<p>second, revised</p>') });
    expect(h.painted()).toBe(2);
    expect(h.el('log').textContent).toContain('second, revised');

    await h.emit({ t: 'react', id: 'm2', emoji: '👍', on: true });
    expect(h.el('log').textContent).toContain('👍');

    await h.emit({ t: 'del', id: 'm2' });
    expect(h.painted()).toBe(1);
    expect(h.el('log').textContent).not.toContain('second');
  });

  it('a sync reuses the elements already on screen instead of rebuilding the transcript', async () => {
    // Entering a topic used to empty #log and repaint everything, which destroyed the scroll
    // container along with its position and flashed through blank even when the messages were
    // already there from cache. Node identity is the observable half of that: if these are the
    // same elements afterwards, nothing was rebuilt and nothing re-ran the fade-in.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>'), message('m2', '<p>second</p>')], ['a1b2c3d4']));
    const before = [...h.el('log').children];
    expect(before).toHaveLength(2);

    // A reconnect replays the same conversation with one more message on the end.
    await h.emit(
      sync('a1b2c3d4', [message('m1', '<p>first</p>'), message('m2', '<p>second</p>'), message('m3', '<p>third</p>')], ['a1b2c3d4'])
    );
    const after = [...h.el('log').children];
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('a sync drops what the server no longer has, and reorders without re-creating', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>'), message('m2', '<p>second</p>')], ['a1b2c3d4']));
    const kept = h.el('log').children[1];

    // m1 aged out of the server's ring; m2 survives and is now the only thing in the topic.
    await h.emit(sync('a1b2c3d4', [message('m2', '<p>second</p>')], ['a1b2c3d4']));
    expect(h.painted()).toBe(1);
    expect(h.el('log').children[0]).toBe(kept);
    expect(h.el('log').textContent).not.toContain('first');
  });

  it('holds the shape of the transcript until the first sync lands, then gives the space back', async () => {
    const h = await open();
    // Nothing has been synced yet: the page is waiting on its very first payload.
    expect(h.skeletons()).toBeGreaterThan(0);
    expect(h.painted()).toBe(0);

    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>')], ['a1b2c3d4']));
    expect(h.skeletons()).toBe(0);
    expect(h.painted()).toBe(1);
  });

  it('a reconnect with the conversation still on screen shows no placeholders', async () => {
    // The skeleton answers "there is nothing here yet", not "the socket went away". Replacing a
    // transcript someone is reading with grey bars every time the stream blips would be worse
    // than the blank panel this replaced.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>')], ['a1b2c3d4']));
    h.live().onerror?.();
    expect(h.skeletons()).toBe(0);
    expect(h.painted()).toBe(1);
  });

  it('marks your own messages apart from the agent', async () => {
    // The only thing that separates the two sides of the transcript is this class, and the
    // stylesheet hangs a tinted panel off it. Painted onto the wrong side — or onto neither —
    // a long conversation is one undifferentiated column again.
    const h = await open();
    await h.emit(
      sync('a1b2c3d4', [message('m1', '<p>the answer</p>'), message('m2', '<p>the question</p>', true)], ['a1b2c3d4'])
    );

    const painted = Array.from(h.el('log').children);
    expect(painted.map((el) => el.className)).toEqual(['m', 'm own']);
  });

  it('shows the typing indicator and marks the topic running', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    expect(h.el('typing').hidden).toBe(true);

    await h.emit({ t: 'typing', on: true });
    expect(h.el('typing').hidden).toBe(false);
    expect(h.doc.querySelector('.topic-item')?.className).toContain('running');

    await h.emit({ t: 'typing', on: false });
    expect(h.el('typing').hidden).toBe(true);
  });
});

describe('webui page: a picture the agent sent', () => {
  /** A file message in the shape `index.ts` `sendFile` builds it. */
  function fileMessage(id: string, name: string, image: boolean): Record<string, unknown> {
    return { ...message(id, '<p>here</p>'), file: { name, url: 'f/abc123', ...(image ? { image: true } : {}) } };
  }

  it('draws an image in the bubble, and keeps the link that saves it', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [fileMessage('m1', 'shot.png', true)], ['a1b2c3d4']));

    const img = h.doc.querySelector('#log img.shot') as HTMLImageElement | null;
    expect(img?.getAttribute('src')).toBe('f/abc123');
    // The name, not an empty alt: a picture that fails to load still has to say what it was.
    expect(img?.getAttribute('alt')).toBe('shot.png');
    // The link is not replaced by the picture. It is the only route onto disk, and `download`
    // is what overrides the `inline` disposition the server now sends for an image.
    const link = h.doc.querySelector('#log .files a') as HTMLAnchorElement | null;
    expect(link?.textContent).toBe('shot.png');
    expect(link?.hasAttribute('download')).toBe(true);
  });

  it('leaves a file the server would not serve as an image as a link alone', async () => {
    // `image` is the server's answer, not the page's guess — a .pdf drawn into an <img> would
    // be a permanently broken frame under every document an agent ever sends.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [fileMessage('m1', 'report.pdf', false)], ['a1b2c3d4']));

    expect(h.doc.querySelector('#log img.shot')).toBeNull();
    expect(h.doc.querySelector('#log .files a')?.textContent).toBe('report.pdf');
  });

  it('opens the picture full-screen when it is tapped, and closes on a click or Escape', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [fileMessage('m1', 'shot.png', true)], ['a1b2c3d4']));
    expect(h.el('lightbox').hidden).toBe(true);

    await h.click('#log img.shot');
    expect(h.el('lightbox').hidden).toBe(false);
    // `.src` resolved against the document, which is what keeps the relative `f/<token>` working
    // when a reverse proxy mounts this page under a sub-path.
    expect(h.el('lightbox-img').getAttribute('src')).toBe('http://localhost:8787/f/abc123');

    await h.click('#lightbox');
    expect(h.el('lightbox').hidden).toBe(true);
    // Dropped, not left decoded behind an invisible overlay for the life of the daemon.
    expect(h.el('lightbox-img').hasAttribute('src')).toBe(false);

    await h.click('#log img.shot');
    expect(h.el('lightbox').hidden).toBe(false);
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.el('lightbox').hidden).toBe(true);
  });

  it('hides a picture whose file is gone rather than showing a broken frame', async () => {
    // The download table holds 200 files across every topic, so scrolling back far enough finds
    // one that 404s. The link stays — that is what every non-image shows anyway.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [fileMessage('m1', 'shot.png', true)], ['a1b2c3d4']));

    const img = h.doc.querySelector('#log img.shot') as HTMLImageElement;
    img.dispatchEvent(new h.window.Event('error'));
    expect(img.style.display).toBe('none');
    expect(h.doc.querySelector('#log .files a')).not.toBeNull();
  });
});

describe('webui page: reading a file the agent sent', () => {
  const T = 'a1b2c3d4';
  /** A file message as `index.ts` `sendFile` builds it for a name `readableKind` accepts. */
  function readable(id: string, name: string, token: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...message(id, ''), file: { name, url: `f/${token}`, view: `view/${token}` }, ...extra };
  }
  const reading = (html: string, size = 120, shown = size): Record<string, unknown> => ({
    name: 'x',
    size,
    shown,
    html,
  });
  const say = (h: Harness): string => h.el('reader-body').textContent ?? '';

  it("makes the file's name the way into the reader, with Download beside it, only when the server said it can render", async () => {
    const h = await open();
    await h.emit(
      sync(T, [readable('m1', 'plan.md', 'aa'), { ...message('m2', ''), file: { name: 'build.apk', url: 'f/bb' } }], [T])
    );
    const rows = h.doc.querySelectorAll('#log .files');
    expect(rows[0]?.querySelector('a')?.textContent).toBe('plan.md');
    expect(rows[0]?.querySelector('a[data-view]')?.getAttribute('data-view')).toBe('view/aa');
    expect(rows[0]?.querySelector('a.view')?.textContent).toBe('Download');
    expect(rows[0]?.querySelector('a.view')?.getAttribute('href')).toBe('f/aa');
    expect(rows[0]?.querySelector('a.view')?.hasAttribute('download')).toBe(true);
    // `view` is the server's answer, not a guess from the name — no field, no preview, no button.
    expect(rows[1]?.querySelector('a[data-view]')).toBeNull();
    expect(rows[1]?.querySelector('a.view')).toBeNull();
  });

  it('opens the file in a window over the transcript, rendered, with its name and a way to save it', async () => {
    const h = await open({ replies: { 'view/aa': reading('<h1>Plan</h1><p>ship it</p>') } });
    await h.emit(sync(T, [readable('m1', 'plan.md', 'aa')], [T]));
    expect(h.el('reader').hidden).toBe(true);

    await h.click('#log a[data-view]');
    await until('the file to arrive', () => say(h).includes('ship it'));
    expect(h.el('reader').hidden).toBe(false);
    // A dialog over the page, not a page of its own: the backdrop holds a box, and the box holds
    // the name, the download link and the document.
    expect(h.el('reader').getAttribute('role')).toBe('dialog');
    expect(h.el('reader').querySelector('#reader-box #reader-body')).not.toBeNull();
    expect(h.calls.map((c) => c.path)).toContain('view/aa');
    expect(h.el('reader-name').textContent).toBe('plan.md');
    expect(h.el('reader-get').getAttribute('href')).toBe('f/aa');
    expect(h.el('reader-get').hasAttribute('download')).toBe(true);
    // Inside `.b`, so a document gets the headings, tables and code blocks a reply gets.
    expect(h.el('reader-body').querySelector('.b h1')?.textContent).toBe('Plan');
    // Nothing about a cut, because nothing was cut.
    expect(h.el('reader-body').querySelector('.reader-note')).toBeNull();
  });

  it('says how much of a long file it is showing', async () => {
    const h = await open({ replies: { 'view/aa': reading('<pre class="src"><code>1\n2</code></pre>', 3 * 1048576, 524288) } });
    await h.emit(sync(T, [readable('m1', 'run.log', 'aa')], [T]));
    await h.click('#log a[data-view]');
    await until('the file to arrive', () => h.el('reader-body').querySelector('.src') !== null);
    expect(h.el('reader-body').querySelector('.reader-note')?.textContent).toBe(
      'Showing the first 512 KB of 3.0 MB. Download it for the rest.'
    );
  });

  it('closes on its button and on Escape, and lets the document go', async () => {
    const h = await open({ replies: { 'view/aa': reading('<p>ship it</p>') } });
    await h.emit(sync(T, [readable('m1', 'plan.md', 'aa')], [T]));

    await h.click('#log a[data-view]');
    await until('the file to arrive', () => say(h).includes('ship it'));
    await h.click('#reader-close');
    expect(h.el('reader').hidden).toBe(true);
    // Emptied, not hidden with half a megabyte of DOM still under it.
    expect(h.el('reader-body').childNodes.length).toBe(0);

    await h.click('#log a[data-view]');
    await until('the file to arrive', () => say(h).includes('ship it'));
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.el('reader').hidden).toBe(true);
  });

  it('closes on the dimmed page behind it, but not on the document', async () => {
    const h = await open({ replies: { 'view/aa': reading('<p>ship it</p>') } });
    await h.emit(sync(T, [readable('m1', 'plan.md', 'aa')], [T]));

    await h.click('#log a[data-view]');
    await until('the file to arrive', () => say(h).includes('ship it'));
    // A click that lands in the box is a click in the document, and must not put it away.
    h.el('reader-box').click();
    expect(h.el('reader').hidden).toBe(false);
    h.el('reader').click();
    expect(h.el('reader').hidden).toBe(true);
  });

  it('says a file is gone, in words, when its token no longer resolves', async () => {
    const h = await open({ status: { 'view/aa': 404 }, replies: { 'view/aa': { error: 'no such file' } } });
    await h.emit(sync(T, [readable('m1', 'plan.md', 'aa')], [T]));
    await h.click('#log a[data-view]');
    await until('an answer', () => !say(h).includes('Loading'));
    expect(say(h)).toBe('This file is no longer here: the daemon has let it go since it was sent.');
  });

  it("shows the server's reason for a file it would not render", async () => {
    const h = await open({ status: { 'view/aa': 415 }, replies: { 'view/aa': { error: 'that file is not text' } } });
    await h.emit(sync(T, [readable('m1', 'notes.txt', 'aa')], [T]));
    await h.click('#log a[data-view]');
    await until('an answer', () => !say(h).includes('Loading'));
    expect(say(h)).toBe('that file is not text');
  });

  it('puts the second file on screen when the first answers late', async () => {
    // A slow link: the first file is opened, given up on, and another opened — and then the first
    // answer lands. It must not end up under the second file's name.
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const h = await open({
      held: { 'view/aa': slow },
      replies: { 'view/aa': reading('<p>the first</p>'), 'view/bb': reading('<p>the second</p>') },
    });
    await h.emit(sync(T, [readable('m1', 'one.md', 'aa'), readable('m2', 'two.md', 'bb')], [T]));
    const [first, second] = Array.from(h.doc.querySelectorAll('#log a[data-view]')) as HTMLAnchorElement[];

    first?.click();
    await tick();
    await h.click('#reader-close');
    second?.click();
    await until('the second file', () => say(h).includes('the second'));
    release();
    await tick();
    await tick();
    expect(h.el('reader-name').textContent).toBe('two.md');
    expect(say(h)).toBe('the second');
  });

  it('offers no preview on a message from before a restart, whose token is dead', async () => {
    const h = await open();
    await h.emit(sync(T, [readable('m1', 'plan.md', 'aa', { g: 1 }), readable('m2', 'next.md', 'bb', { g: 2 })], [T], { epoch: 2 }));
    const rows = h.doc.querySelectorAll('#log .files');
    // The link stays on the old one — it is what that message has always degraded to.
    expect(rows[0]?.querySelector('a')).not.toBeNull();
    expect(rows[0]?.querySelector('a[data-view]')).toBeNull();
    expect(rows[0]?.querySelector('a.view')).toBeNull();
    expect(rows[1]?.querySelector('a[data-view]')).not.toBeNull();
  });
});

describe('webui page: closing the idle agents', () => {
  const A = 'a1b2c3d4';
  /** One of each state the dot can be in, plus a second idle topic that is starred. */
  const fleet = (): Array<Record<string, unknown>> => [
    { id: A, title: 'asking', lastAt: 1000, running: true, asking: true, live: true, msgCount: 0 },
    { id: 'b2c3d4e5', title: 'working', lastAt: 999, running: true, live: true, msgCount: 0 },
    { id: 'c3d4e5f6', title: 'resident', lastAt: 998, live: true, msgCount: 0, dir: { name: 'talkcode', path: '/w/talkcode', host: 'uniagent' } },
    { id: 'd4e5f6a7', title: 'cold', lastAt: 997, live: false, msgCount: 0 },
    { id: 'e5f6a7b8', title: 'kept warm', lastAt: 996, live: true, starred: true, msgCount: 0 },
  ];
  /** The item lives in the Manage menu now; open it the way a person would. */
  const closeIdle = async (h: Harness): Promise<void> => {
    await h.click('#manage-toggle');
    await h.click('#close-idle');
  };
  const rows = (h: Harness) =>
    Array.from(h.doc.querySelectorAll('#idle-list li')).map((li) => ({
      id: li.getAttribute('data-idle'),
      text: Array.from(li.querySelectorAll('.idle-name,.idle-dir'))
        .map((n) => n.textContent)
        .join(' | '),
      out: li.querySelector('.idle-out')?.textContent,
    }));

  it('counts the dim dots, and only them, on a button that is gone when there are none', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    expect(h.el('close-idle').hidden).toBe(true);

    await h.emit({ t: 'topics', topics: fleet() });
    // Not the asking topic, not the working one, not the cold one: a question on screen and a
    // running turn are not idle, and a grey dot has no process to close.
    expect(h.el('close-idle').hidden).toBe(false);
    expect(h.el('close-idle').textContent).toBe('Close idle (2)');
  });

  it('lists each topic it would close, starred first, before closing anything', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A], { topics: fleet() }));
    await closeIdle(h);

    expect(h.el('idle-dialog').hidden).toBe(false);
    expect(h.el('idle-title').textContent).toBe('Close 2 idle agents?');
    expect(rows(h)).toEqual([
      { id: 'e5f6a7b8', text: 'kept warm', out: '' },
      { id: 'c3d4e5f6', text: 'resident | uniagent · talkcode', out: '' },
    ]);
    // Cancel holds the focus, so an Enter out of habit changes nothing.
    expect(h.doc.activeElement).toBe(h.el('idle-cancel'));
    expect(h.calls.map((c) => c.path)).not.toContain('api/topics/close-idle');

    await h.click('#idle-cancel');
    expect(h.el('idle-dialog').hidden).toBe(true);
    expect(h.calls.map((c) => c.path)).not.toContain('api/topics/close-idle');
  });

  it('closes exactly the listed topics and says what became of each', async () => {
    const h = await open({ replies: { 'api/topics/close-idle': { closed: ['e5f6a7b8'], kept: ['c3d4e5f6'] } } });
    await h.emit(sync(A, [], [A], { topics: fleet() }));
    await closeIdle(h);
    // A topic that goes idle while the dialog is open was not shown, so it is not closed either.
    await h.emit({ t: 'topics', topics: fleet().map((t) => (t.id === 'b2c3d4e5' ? { ...t, running: false } : t)) });
    await h.click('#idle-go');
    await until('the answer', () => h.el('idle-cancel').textContent === 'Done');

    expect(h.calls.find((c) => c.path === 'api/topics/close-idle')?.body).toEqual({ topics: ['e5f6a7b8', 'c3d4e5f6'] });
    expect(rows(h).map((r) => [r.id, r.out])).toEqual([
      ['e5f6a7b8', 'closed'],
      ['c3d4e5f6', 'left running'],
    ]);
    expect(h.el('idle-title').textContent).toBe('Closed 1 idle agent; 1 left running — busy again, or unable to resume');
    expect(h.el('idle-go').hidden).toBe(true);
    await h.click('#idle-cancel');
    expect(h.el('idle-dialog').hidden).toBe(true);
  });

  it('keeps the question open, and says why, when the request fails', async () => {
    const h = await open({ status: { 'api/topics/close-idle': 500 } });
    await h.emit(sync(A, [], [A], { topics: fleet() }));
    await closeIdle(h);
    await h.click('#idle-go');
    await until('the failure', () => h.el('idle-title').textContent !== 'Close 2 idle agents?');

    expect(h.el('idle-title').textContent).toBe('The daemon refused the request.');
    expect((h.el('idle-go') as HTMLButtonElement).disabled).toBe(false);
    // Asked once: a retry after a lost answer would find every agent gone and call them all busy.
    expect(h.calls.filter((c) => c.path === 'api/topics/close-idle')).toHaveLength(1);
  });

  it('goes away on Escape and on a click outside the box', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A], { topics: fleet() }));
    await closeIdle(h);
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.el('idle-dialog').hidden).toBe(true);

    await closeIdle(h);
    await h.click('#idle-dialog');
    expect(h.el('idle-dialog').hidden).toBe(true);
    await closeIdle(h);
    await h.click('#idle-box');
    expect(h.el('idle-dialog').hidden).toBe(false);
  });
});

describe('webui page: the gate', () => {
  it('asks for the token and posts it, when the shared secret is still a door', async () => {
    const h = await open();
    const field = h.doc.getElementById('secret') as HTMLInputElement | null;
    expect(field).not.toBeNull();
    field!.value = 'open-sesame';
    h.doc.getElementById('gate')!.dispatchEvent(new h.window.Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    expect(h.calls.map((c) => c.path)).toContain('api/login');
    expect(h.calls.find((c) => c.path === 'api/login')?.body).toEqual({ token: 'open-sesame' });
  });

  it('serves no field at all under SSO, and asks for no password it cannot check', async () => {
    // The failure this prevents is a quiet one: with `sso.password: false` there is no token
    // that works, so a page still showing the box answers an expired provider session with
    // "that is not the right token" — and sends the operator looking for a secret instead of
    // signing in again.
    const h = await open({ password: false });
    expect(h.doc.getElementById('secret')).toBeNull();
    h.doc.getElementById('gate')!.dispatchEvent(new h.window.Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    // Reloading is what re-triggers the provider, so the one thing that must NOT happen is a
    // login POST — there is nothing on the other end of it.
    expect(h.calls.map((c) => c.path)).not.toContain('api/login');
  });

  it('comes back when the stream is refused for good, under either gate', async () => {
    for (const password of [true, false]) {
      const h = await open({ password });
      await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4']));
      // The stream opened, so whichever gate was served is out of the way.
      expect(h.el('login').hidden).toBe(true);
      // readyState 2 is "the server refused it", not "the network blipped": the session is gone
      // and the page has to offer the way back in — the field under a password, the reload
      // button under SSO.
      h.live().readyState = 2;
      h.live().onerror?.();
      await tick();
      expect(h.el('login').hidden).toBe(false);
      expect(h.el('app').hidden).toBe(true);
    }
  });
});

describe('webui page: topics', () => {
  it('paints a switched-to topic from cache before its stream has answered', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>in A</p>'), message('m2', '<p>also A</p>')], ['a1b2c3d4', 'b2c3d4e5']));
    expect(h.painted()).toBe(2);

    await h.click('[data-topic="b2c3d4e5"]');
    // Nothing cached for B yet and its stream has said nothing — so what is on screen is the
    // shape of a transcript rather than either an empty panel or a message.
    expect(h.painted()).toBe(0);
    expect(h.skeletons()).toBeGreaterThan(0);
    expect(h.live().url).toBe('api/events?t=b2c3d4e5');

    await h.click('[data-topic="a1b2c3d4"]');
    // A came back with no sync emitted at all — this is the cache, and the point of it. It is
    // read rather than remembered, so it arrives an IndexedDB turn later than the click.
    await until('A is painted from cache', () => h.painted() === 2);
    expect(h.el('log').textContent).toContain('in A');
    expect(h.window.location.search).toBe('?t=a1b2c3d4');
  });

  /**
   * The gap this covers is the one a warm cache creates: the transcript is on screen instantly,
   * and then a second or two later everything said while you were elsewhere arrives in one frame.
   * Between those two moments the page has to be visibly waiting on something.
   */
  it('keeps saying it is waiting while a cached topic catches up', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>in A</p>')], ['a1b2c3d4', 'b2c3d4e5']));
    await h.click('[data-topic="b2c3d4e5"]');
    await h.click('[data-topic="a1b2c3d4"]');
    await until('A is painted from cache', () => h.painted() === 1);

    // Not the skeleton — that is for an empty log, and this one is full.
    expect(h.skeletons()).toBe(0);
    expect(h.waiting()).toContain('while you were away');
    // At the bottom, where whatever is missing is going to land.
    expect(h.el('log').lastElementChild?.className).toBe('syncing');

    // And a message typed into the gap still goes above it: the line marks the end of the
    // transcript, not a place in it.
    (h.el('input') as HTMLTextAreaElement).value = 'while I wait';
    await h.click('#composer button[type="submit"]');
    expect(h.el('log').lastElementChild?.className).toBe('syncing');

    await h.emit(
      sync('a1b2c3d4', [message('m1', '<p>in A</p>'), message('m2', '<p>said since</p>')], ['a1b2c3d4', 'b2c3d4e5'])
    );
    expect(h.waiting()).toBe(null);
    expect(h.el('log').textContent).toContain('said since');
  });

  it('leaves a topic with nothing cached to the skeleton rather than stacking two waits on it', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>in A</p>')], ['a1b2c3d4', 'b2c3d4e5']));

    await h.click('[data-topic="b2c3d4e5"]');
    // Long enough for B's cache read to have come back empty, which is what would otherwise put
    // the line up next to the placeholders.
    for (let i = 0; i < 10; i++) await tick();

    expect(h.skeletons()).toBeGreaterThan(0);
    expect(h.waiting()).toBe(null);
  });

  it('closes the stream it left behind when switching', async () => {    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));
    const first = h.live();

    await h.click('[data-topic="b2c3d4e5"]');

    expect(first.closed).toBe(true);
    expect(h.streams.filter((s) => !s.closed)).toHaveLength(1);
  });

  it('asks the daemon to delete a topic and stops showing it', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));

    await h.click('[data-del="b2c3d4e5"]');

    expect(h.calls.map((c) => c.path)).toContain('api/topics/delete');
    expect(h.calls.find((c) => c.path === 'api/topics/delete')?.body).toEqual({ topic: 'b2c3d4e5' });

    // The server answers by announcing the list again; the sidebar follows it, not the click.
    await h.emit({ t: 'topics', topics: [{ id: 'a1b2c3d4', title: 'Topic a1b2c3d4', lastAt: 1000, msgCount: 0 }] });
    expect(h.rows()).toBe(1);
  });

  it('shows which project each topic is working in', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: 'fix the parser', lastAt: 1000, msgCount: 0, dir: { name: 'talkcode', path: '/home/user/workspace/talkcode' } },
        { id: 'b2c3d4e5', title: 'bump the image', lastAt: 999, msgCount: 0, dir: { name: 'uniagent', path: '/home/user/workspace/uniagent' } },
      ],
    });

    const dirs = Array.from(h.doc.querySelectorAll('.topic-dir'));
    expect(dirs.map((d) => d.textContent)).toEqual(['talkcode', 'uniagent']);
    // The column is 240px wide, so the row shows the last segment and the tooltip carries the
    // path that tells two checkouts of one project apart.
    expect(dirs[0]!.getAttribute('title')).toBe('/home/user/workspace/talkcode');
  });

  it('names the machine ahead of the directory for an agent on a host', async () => {
    // Two agy agents on two hosts, both in a directory called `workspace`: without the machine the
    // second lines are identical, and the agent id in the title is all that is left to go on.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: '[ag] 开工', lastAt: 1000, msgCount: 0, dir: { name: 'workspace', path: '/home/user/workspace', host: 'uniagent' } },
        { id: 'b2c3d4e5', title: '[ag2] 你好', lastAt: 999, msgCount: 0, dir: { name: 'workspace', path: '/home/user/workspace', host: 'devbox' } },
        { id: 'c3d4e5f6', title: '[cc] local', lastAt: 998, msgCount: 0, dir: { name: 'talkcode', path: '/srv/talkcode' } },
      ],
    });

    const dirs = Array.from(h.doc.querySelectorAll('.topic-dir'));
    expect(dirs.map((d) => d.textContent)).toEqual(['uniagent · workspace', 'devbox · workspace', 'talkcode']);
    // The tooltip is the whole address, in the form scp and ssh already taught everyone to read.
    expect(dirs.map((d) => d.getAttribute('title'))).toEqual([
      'uniagent:/home/user/workspace',
      'devbox:/home/user/workspace',
      '/srv/talkcode',
    ]);
  });

  it('shortens a host-qualified agent tag once the row already names the machine', async () => {
    // A remote agent's id is `<id>@<host>`, and `formatLaneTitle` puts that id in front of every
    // topic name. Left whole it is 15 characters of a 240px column spent on a machine the
    // directory line repeats, which left rows reading "[cbc@uniagent] Oracle A…" (reported
    // 2026-11-03). The part before the `@` is what the operator types to bind the agent.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: '[cbc@uniagent] Oracle A…', lastAt: 1000, msgCount: 0, dir: { name: 'workspace', path: '/home/user/workspace', host: 'uniagent' } },
        // No directory known, so the second line cannot say which machine this is: the tag keeps
        // its host, because it is the only place on the row that names it.
        { id: 'b2c3d4e5', title: '[ag@devbox] 你好', lastAt: 999, msgCount: 0 },
      ],
    });

    const titles = Array.from(h.doc.querySelectorAll('.topic-title'));
    expect(titles.map((t) => t.textContent)).toEqual(['[cbc] Oracle A…', '[ag@devbox] 你好']);
    // Nothing is lost: the name the tag was cut from is on the tag itself, where the abbreviation
    // is, so the row's own tooltip (what a needs-you row says) still covers the rest of the row.
    expect(titles[0]!.querySelector('.topic-tag')?.getAttribute('title')).toBe('[cbc@uniagent] Oracle A…');
    expect(titles[1]!.querySelector('.topic-tag')?.getAttribute('title')).toBeNull();
  });

  it('leaves the needs-you tooltip alone on a row whose tag was shortened', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: 'on screen', lastAt: 1000, msgCount: 0 },
        {
          id: 'b2c3d4e5',
          title: '[cbc@uniagent] Oracle A…',
          lastAt: 999,
          msgCount: 0,
          stage: 'answer',
          line: 'Ship 2.23.0?',
          dir: { name: 'workspace', path: '/home/user/workspace', host: 'uniagent' },
        },
      ],
    });

    const row = h.doc.querySelector('.topic-item.needs');
    expect(row?.getAttribute('title')).toBe('Waiting on your answer: Ship 2.23.0?');
    expect(row?.querySelector('.topic-title')?.hasAttribute('title')).toBe(false);
  });

  it('leaves the row alone for a daemon that offered no directory', async () => {
    // Every `topics` event before this feature existed, and every deployment whose adapter does
    // not implement the lookup: the second line is absent, not blank.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    expect(h.doc.querySelector('.topic-dir')).toBeNull();
    expect(h.doc.querySelector('.topic-title')?.textContent).toBe('Topic a1b2c3d4');
  });

  it('survives a directory name with a quote in it', async () => {
    // The path goes into a title attribute, and textContent-based escaping leaves the quote
    // alone — so an unescaped one ends the attribute and spills the rest of the path into the
    // tag. Legal on every filesystem this runs on, and the row is unreadable when it happens.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.emit({
      t: 'topics',
      topics: [{ id: 'a1b2c3d4', title: 'odd', lastAt: 1, msgCount: 0, dir: { name: 'say "hi"', path: '/tmp/say "hi"' } }],
    });

    const dir = h.doc.querySelector('.topic-dir');
    expect(dir?.textContent).toBe('say "hi"');
    expect(dir?.getAttribute('title')).toBe('/tmp/say "hi"');
    // Nothing leaked out of the attribute and became markup.
    expect(h.el('topics').querySelectorAll('.topic-dir')).toHaveLength(1);
  });

  it('badges unread messages on a topic that is not the one being read', async () => {    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));
    expect(h.doc.querySelector('.topic-badge')).toBeNull();

    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: 'Topic a1b2c3d4', lastAt: 1000, msgCount: 0 },
        { id: 'b2c3d4e5', title: 'Topic b2c3d4e5', lastAt: 999, msgCount: 3 },
      ],
    });

    expect(h.doc.querySelector('.topic-badge')?.textContent).toBe('3');
  });

  it('sweeps every topic away and lands in the one that replaced them', async () => {
    const h = await open({ replies: { 'api/topics/clear': { topic: { id: 'deadbeef', title: '', lastAt: 2000 } } } });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>in A</p>')], ['a1b2c3d4', 'b2c3d4e5']));
    expect(h.painted()).toBe(1);
    await saved();
    expect(await h.cached('a1b2c3d4')).toHaveLength(1);

    await h.click('#clear-topics');

    expect(h.calls.find((c) => c.path === 'api/topics/clear')?.body).toEqual({});
    // Landed in the replacement rather than waiting for the broadcast list to say where to go.
    expect(h.live().url).toBe('api/events?t=deadbeef');
    expect(h.window.location.search).toBe('?t=deadbeef');
    expect(h.painted()).toBe(0);
    expect(h.rows()).toBe(1);
    // Every local record of the old rooms went with them: a cache left behind would repaint
    // messages for ids the daemon has forgotten the moment one of them was opened again, and a
    // read mark left behind would badge the replacement against a count from a dead room.
    await untilAsync('the cached transcript is gone', async () => (await h.cached('a1b2c3d4')) === null);
    expect(await h.cached('a1b2c3d4')).toBeNull();
    expect(JSON.parse(h.window.localStorage.getItem('aa_reads') ?? 'null')).toEqual({ deadbeef: 0 });
  });

  it('does nothing at all when the confirmation is declined', async () => {
    const h = await open({ confirm: false });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>in A</p>')], ['a1b2c3d4', 'b2c3d4e5']));

    await h.click('#clear-topics');

    expect(h.calls.map((c) => c.path)).not.toContain('api/topics/clear');
    expect(h.rows()).toBe(2);
    expect(h.painted()).toBe(1);
  });

  it('paints the dot by what a topic is doing, not merely by whether a turn is open', async () => {
    // Four states, and two of them only exist because a turn is a bad proxy for the agent: a
    // question holds its turn OPEN while waiting on the user, and a turn ending does not stop
    // the process. The row for each must not be the row for the other.
    const h = await open();
    await h.emit(
      sync('a1b2c3d4', [], ['a1b2c3d4'], {
        topics: [
          { id: 'a1b2c3d4', title: 'asking', lastAt: 1000, running: true, asking: true, live: true, msgCount: 0 },
          { id: 'b2c3d4e5', title: 'working', lastAt: 999, running: true, live: true, msgCount: 0 },
          { id: 'c3d4e5f6', title: 'resident', lastAt: 998, running: false, live: true, msgCount: 0 },
          { id: 'd4e5f6a7', title: 'cold', lastAt: 997, running: false, live: false, msgCount: 0 },
        ],
      })
    );

    expect(Array.from(h.doc.querySelectorAll('.topic-dot')).map((el) => el.className)).toEqual([
      'topic-dot asking',
      'topic-dot running',
      'topic-dot live',
      'topic-dot',
    ]);
    // The row a reclaimed topic gets is the one that says so, and it is not the one a topic with
    // its context still in memory gets.
    expect(Array.from(h.doc.querySelectorAll('.topic-item')).map((el) => el.className)).toEqual([
      'topic-item on running live',
      'topic-item running live',
      'topic-item idle live',
      'topic-item idle',
    ]);
    // And the header says the useful half of "running AND waiting on you".
    expect(h.el('topic-status').textContent).toBe('awaiting you');
    expect(h.el('topic-status').className).toBe('chat-status asking');
  });
});

/** Every row in a transcript is this tall, and the viewport onto it this tall; see `layout`. */
const ROW = 100;
const VIEW = 300;

/**
 * A layout for `#log`, which jsdom does not have at all: every child is `ROW` pixels tall, the
 * viewport is `VIEW`, and scrollHeight, clientHeight and every rect follow from the order of the
 * children and the scrollTop the page last set. That is all scrolling means to the script — it
 * never reads a style — so it is enough to tell "put back" from "at the bottom".
 *
 * scrollTop is clamped on every read AND after every change to the log's children, the way a
 * browser clamps it at the next layout. The second matters: without it, a position set before a
 * topic was left would still be sitting in the stub when the topic came back, and a page that
 * restored nothing at all would pass.
 */
function layout(h: Harness): HTMLElement {
  const log = h.el('log');
  let top = 0;
  const clamp = (): number => (top = Math.min(Math.max(0, top), Math.max(0, log.children.length * ROW - VIEW)));
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => VIEW });
  Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => Math.max(VIEW, log.children.length * ROW) });
  Object.defineProperty(log, 'scrollTop', {
    configurable: true,
    get: clamp,
    set: (v: number) => {
      top = v;
      clamp();
    },
  });
  new h.window.MutationObserver(clamp).observe(log, { childList: true });
  const box = (y: number): DOMRect => ({ top: y, bottom: y + ROW, height: ROW, y }) as DOMRect;
  const own = h.window.Element.prototype.getBoundingClientRect;
  h.window.Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this === log) return { top: 0, bottom: VIEW, height: VIEW, y: 0 } as DOMRect;
    if (this.parentNode === log) return box(Array.prototype.indexOf.call(log.children, this) * ROW - clamp());
    return own.call(this);
  };
  return log;
}

/** `n` agent messages, `line 1` onwards, the way a long topic's ring holds them. */
function lines(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => message(`m${i + 1}`, `<p>line ${i + 1}</p>`));
}

/** The body of the message at the top edge of the viewport, and how much of it is scrolled off. */
function onTop(log: HTMLElement): { text: string | null | undefined; hidden: number } {
  const row = log.children[Math.floor(log.scrollTop / ROW)];
  return { text: row?.querySelector('.b')?.textContent, hidden: log.scrollTop % ROW };
}

describe('webui page: a full topic list, and the topics worth keeping', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const C = 'c3d4e5f6';
  const field = (h: Harness): HTMLTextAreaElement => h.el('input') as HTMLTextAreaElement;
  /** The topic rows in the order they are painted. */
  const order = (h: Harness): Array<string | null> =>
    Array.from(h.el('topics').querySelectorAll('[data-topic]')).map((r) => r.getAttribute('data-topic'));

  it('says why a new topic could not be opened, instead of doing nothing', async () => {
    // What 1.36.3 did at 64 topics: the 409 was dropped on the floor and + simply did nothing.
    const refusal = 'every one of the 64 topics is starred or in use; unstar or delete one before opening another';
    const h = await open({
      url: `http://localhost:8787/?t=${A}`,
      status: { 'api/topics': 409 },
      replies: { 'api/topics': { error: refusal } },
    });
    await h.emit(sync(A, [], [A]));

    await h.click('#new-topic');
    await until('the refusal is on screen', () => h.alerts.length > 0);

    expect(h.alerts[0]).toBe(`Could not open a new topic: ${refusal}`);
    expect(h.live().url).toBe(`api/events?t=${A}`);
  });

  it('stars a topic from its row without opening it, and lists it first', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A, B, C]));
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear all topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear all topics');

    await h.click(`[data-star="${C}"]`);

    expect(h.calls.find((c) => c.path === 'api/topics/star')?.body).toEqual({ topic: C, starred: true });
    // Drawn at once rather than on the broadcast, so a tap on a slow link does not look ignored.
    expect(order(h)).toEqual([C, A, B]);
    expect(h.doc.querySelector(`[data-star="${C}"]`)?.getAttribute('aria-pressed')).toBe('true');
    // A star leads its peers inside its state; it is not a group of its own, so no divider.
    expect(h.doc.querySelector('#topics .after-needs')).toBeNull();
    // Starring is not a reason to switch to it.
    expect(h.live().url).toBe(`api/events?t=${A}`);
    // And the sweep now says it spares what was starred.
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear unstarred topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear unstarred topics');

    // The daemon's order is still the page's order underneath: when the topic on screen goes, the
    // page lands in the most RECENT one, not in whatever is starred at the top.
    await h.emit({
      t: 'topics',
      topics: [
        { id: B, title: 'b', lastAt: 999, msgCount: 0 },
        { id: C, title: 'c', lastAt: 998, msgCount: 0, starred: true },
      ],
    });
    expect(h.live().url).toBe(`api/events?t=${B}`);
  });

  it('puts the star back and says so when the daemon refuses it', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}`, status: { 'api/topics/star': 404 } });
    await h.emit(sync(A, [], [A, B]));

    await h.click(`[data-star="${B}"]`);
    await until('the refusal is on screen', () => h.alerts.length > 0);

    expect(h.doc.querySelector(`[data-star="${B}"]`)?.getAttribute('aria-pressed')).toBe('false');
    expect(order(h)).toEqual([A, B]);
  });

  it('keeps a starred topic' + "'s transcript and draft through a clear, and drops the rest", async () => {
    const fresh = { id: 'deadbeef', title: '', lastAt: 2000, msgCount: 0 };
    const h = await open({
      url: `http://localhost:8787/?t=${A}`,
      replies: { 'api/topics/clear': { topic: fresh, topics: [fresh, { id: B, title: 'kept', lastAt: 900, msgCount: 1, starred: true }] } },
    });
    await h.emit(sync(A, [message('m1', '<p>in A</p>')], [A, B]));
    await h.click(`[data-topic="${B}"]`);
    await h.emit(sync(B, [message('m2', '<p>in B</p>')], [A, B]));
    field(h).value = 'half-written in B';
    await h.click(`[data-topic="${A}"]`);
    await h.emit(sync(A, [message('m1', '<p>in A</p>')], [A, B]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'gone', lastAt: 1000, msgCount: 1 },
        { id: B, title: 'kept', lastAt: 900, msgCount: 1, starred: true },
      ],
    });
    await saved();
    expect(await h.cached(A)).toHaveLength(1);
    expect(await h.cached(B)).toHaveLength(1);

    await h.click('#clear-topics');

    expect(h.confirms.at(-1)).toBe('Delete 1 topic? The 1 starred one is kept. This cannot be undone.');
    expect(h.live().url).toBe('api/events?t=deadbeef');
    expect(h.rows()).toBe(2);
    await untilAsync('the cleared topic' + "'s cache is gone", async () => (await h.cached(A)) === null);
    expect(await h.cached(B)).toHaveLength(1);
    expect(JSON.parse(h.window.localStorage.getItem('aa_drafts') ?? 'null')).toEqual({ [B]: 'half-written in B' });

    // And the draft is still THERE, not just on disk.
    await h.click(`[data-topic="${B}"]`);
    expect(field(h).value).toBe('half-written in B');
  });

  it('has nothing to clear when every topic is starred, and says so instead of asking', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: [{ id: A, title: 'a', lastAt: 1000, msgCount: 0, starred: true }] });

    await h.click('#clear-topics');

    expect(h.confirms).toEqual([]);
    expect(h.alerts[0]).toMatch(/Every topic is starred/);
    expect(h.calls.map((c) => c.path)).not.toContain('api/topics/clear');
  });

  it('names a starred topic as starred before deleting it', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}`, confirm: false });
    await h.emit(sync(A, [], [A, B]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'a', lastAt: 1000, msgCount: 0 },
        { id: B, title: 'b', lastAt: 999, msgCount: 0, starred: true },
      ],
    });

    await h.click(`[data-del="${B}"]`);

    expect(h.confirms.at(-1)).toBe('Delete starred topic "b"?');
  });

  it('places #clear-topics as an icon button inside the header panel-title', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    const headerTitle = h.doc.querySelector('#sidebar-header .panel-title');
    expect(headerTitle).not.toBeNull();
    const titleText = headerTitle?.querySelector('.panel-title-text');
    expect(titleText?.textContent).toBe('Topics');
    const btn = h.el('clear-topics');
    expect(headerTitle?.contains(btn)).toBe(true);
    expect(btn.classList.contains('btn-icon')).toBe(true);
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(btn.textContent).toBe('');
    expect(btn.getAttribute('title')).toBe('Clear all topics');
    expect(btn.getAttribute('aria-label')).toBe('Clear all topics');
  });

  it('updates title and aria-label on #clear-topics as stars come and go', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A, B]));
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear all topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear all topics');

    // Star a topic: title/aria-label update to unstarred
    await h.click(`[data-star="${B}"]`);
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear unstarred topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear unstarred topics');
    expect(h.el('clear-topics').textContent).toBe('');

    // Unstar: title/aria-label revert to all topics
    await h.click(`[data-star="${B}"]`);
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear all topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear all topics');
    expect(h.el('clear-topics').textContent).toBe('');
  });

  it('still asks for confirmation before clearing topics from the header button', async () => {
    const h = await open({ confirm: false });
    await h.emit(sync(A, [], [A, B]));

    await h.click('#clear-topics');
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toBe('Delete all 2 topics? This cannot be undone.');
    expect(h.calls.map((c) => c.path)).not.toContain('api/topics/clear');

    // When confirmed
    (h.window as any).confirm = () => true;
    await h.click('#clear-topics');
    await until('clear request is sent', () => h.calls.some((c) => c.path === 'api/topics/clear'));
  });
});

describe('webui page: coming back to a topic', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';

  it('puts the reader back on the message they left, not at the bottom', async () => {
    const h = await open();
    const log = layout(h);
    await h.emit(sync(A, lines(20), [A, B]));
    // A topic never read before opens at the bottom, as it always has.
    expect(log.scrollTop).toBe(20 * ROW - VIEW);

    // Scrolled up to line 8, with 30px of it above the top edge.
    log.scrollTop = 730;
    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);

    // Put back as soon as the cache has painted — not a moment later, when the sync lands, which
    // would be a visible jump from wherever it was painted first.
    await until('A is painted from cache', () => h.painted() === 20);
    expect(onTop(log)).toEqual({ text: 'line 8', hidden: 30 });

    await h.emit(sync(A, lines(20), [A, B]));
    expect(onTop(log)).toEqual({ text: 'line 8', hidden: 30 });
  });

  it('finds that message again when the sync puts older ones above it', async () => {
    // The cache keeps the last 200 messages and the ring holds 1000, so a long topic comes back
    // short and the sync then adds the head of it — above the message being read. Restoring a
    // scrollTop would land a hundred rows off; this is the reason the view is a message.
    const h = await open();
    const log = layout(h);
    await h.emit(sync(A, lines(210), [A, B]));
    log.scrollTop = 100 * ROW + 30;
    expect(onTop(log).text).toBe('line 101');

    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);
    await until('A is painted from cache', () => h.painted() === 200);
    expect(onTop(log)).toEqual({ text: 'line 101', hidden: 30 });

    await h.emit(sync(A, lines(210), [A, B]));
    expect(h.painted()).toBe(210);
    expect(onTop(log)).toEqual({ text: 'line 101', hidden: 30 });
  });

  it('brings a topic left at the bottom back to the bottom, with what was said since', async () => {
    // At the bottom means following along, and the thing to follow is whatever arrived while this
    // was somewhere else. Putting the reader back on the message they last saw would leave the new
    // ones under the fold, which is the opposite of what they were doing.
    const h = await open();
    const log = layout(h);
    await h.emit(sync(A, lines(20), [A, B]));
    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);
    await until('A is painted from cache', () => h.painted() === 20);

    await h.emit(sync(A, lines(22), [A, B]));
    expect(log.scrollTop).toBe(22 * ROW - VIEW);
    expect(onTop(log).text).toBe('line 20');
  });

  it('does not pull back a reader who scrolled while the topic was still loading', async () => {
    const h = await open();
    const log = layout(h);
    await h.emit(sync(A, lines(20), [A, B]));
    log.scrollTop = 730;
    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);
    await until('A is painted from cache', () => h.painted() === 20);

    // Between the cache and the sync: the transcript is on screen and is being read.
    log.scrollTop = 200;
    await h.emit(sync(A, lines(20), [A, B]));
    expect(log.scrollTop).toBe(200);
  });

  it('keeps the place in a topic flicked through before it loaded, with no cache to paint it', async () => {
    // With no IndexedDB, a topic shows placeholders until its sync — and leaving it then must not
    // be read as "left at the bottom", or passing through on the way somewhere else forgets it.
    const h = await open({ idb: null });
    const log = layout(h);
    await h.emit(sync(A, lines(20), [A, B]));
    log.scrollTop = 730;

    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);
    expect(h.skeletons()).toBeGreaterThan(0);
    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);

    await h.emit(sync(A, lines(20), [A, B]));
    expect(onTop(log)).toEqual({ text: 'line 8', hidden: 30 });
  });
});

/**
 * One composer serves every topic, so what is in it has to be swapped on the way through — text,
 * caret and attachments alike. Before, a half-written prompt followed the reader into the next
 * topic, and so did a pasted screenshot, which then went out with whatever was sent there.
 */
describe('webui page: a composer per topic', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const input = (h: Harness): HTMLTextAreaElement => h.el('input') as HTMLTextAreaElement;
  const stored = (h: Harness): unknown => JSON.parse(h.window.localStorage.getItem('aa_drafts') ?? 'null');
  const sends = (h: Harness): Call[] => h.calls.filter((c) => c.path === 'api/send');

  /** A screenshot pasted into the page, the way the pasting tests below build one. */
  const paste = (h: Harness): void => {
    const file = new h.window.File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
    const ev = new h.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
    });
    h.el('input').dispatchEvent(ev);
  };

  /** The page going into the background, which is the write that has to survive a discard. */
  const hide = (h: Harness): void => {
    Object.defineProperty(h.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    h.doc.dispatchEvent(new h.window.Event('visibilitychange'));
  };

  it('gives each topic its own text, and puts the caret back where it was', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    input(h).value = 'for A, half written';
    input(h).setSelectionRange(5, 5);

    await h.click(`[data-topic="${B}"]`);
    expect(input(h).value).toBe('');
    input(h).value = 'for B';

    await h.click(`[data-topic="${A}"]`);
    expect(input(h).value).toBe('for A, half written');
    expect(input(h).selectionStart).toBe(5);

    await h.click(`[data-topic="${B}"]`);
    expect(input(h).value).toBe('for B');
  });

  it('keeps an attachment with the topic it was attached in', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    paste(h);
    await until('the chip is rendered', () => chipNames(h).join() === 'pasted-1.png');

    await h.click(`[data-topic="${B}"]`);
    expect(chipNames(h)).toEqual([]);
    input(h).value = 'nothing attached here';
    await h.click('#composer button[type="submit"]');
    expect(sends(h)[0]?.body.files).toBeUndefined();

    await h.click(`[data-topic="${A}"]`);
    expect(chipNames(h)).toEqual(['pasted-1.png']);
    await h.click('#composer button[type="submit"]');
    expect((sends(h)[1]?.body.files as unknown[]).length).toBe(1);
    expect(sends(h)[1]?.body.topic).toBe(A);
  });

  it('lands a file still being read in the topic it was picked in, not the one switched to', async () => {
    // FileReader answers a few turns after the paste; a click on another topic in between is
    // exactly the moment a global list would hand the file to the wrong conversation.
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    paste(h);
    h.doc.querySelector<HTMLElement>(`[data-topic="${B}"]`)!.click();
    for (let i = 0; i < 20; i++) await tick();
    expect(chipNames(h)).toEqual([]);

    await h.click(`[data-topic="${A}"]`);
    expect(chipNames(h)).toEqual(['pasted-1.png']);
  });

  it('keeps the text across a reload, written when the page is hidden rather than per keystroke', async () => {
    const first = await open({ url: `http://localhost:8787/?t=${A}` });
    await first.emit(sync(A, [], [A, B]));
    input(first).value = 'survives a reload';
    // A key alone writes nothing: storage is touched on the way out, and once typing pauses.
    input(first).dispatchEvent(new first.window.Event('input', { bubbles: true }));
    expect(stored(first)).toBeNull();

    hide(first);
    expect(stored(first)).toEqual({ [A]: 'survives a reload' });

    const again = await open({
      url: `http://localhost:8787/?t=${A}`,
      storage: { aa_drafts: first.window.localStorage.getItem('aa_drafts')! },
    });
    // Before the stream has said anything: the draft is this browser's, not the daemon's.
    expect(input(again).value).toBe('survives a reload');

    await again.emit(sync(A, [], [A, B]));
    await again.click('#composer button[type="submit"]');
    // Sent, so gone — a reload now must not offer it for sending a second time.
    expect(stored(again)).toEqual({});
  });

  it('writes the draft down once typing pauses, for a page that goes away without a word', async () => {
    // A renderer that crashes, or a phone that kills the tab in the foreground, fires no
    // visibilitychange. That used to cost the whole draft; now it costs the last pause's worth.
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A, B]));
    const type = (s: string): void => {
      input(h).value = s;
      input(h).dispatchEvent(new h.window.Event('input', { bubbles: true }));
    };
    type('half');
    type('half a thought');
    expect(stored(h)).toBeNull();

    await within('the pause is written down', 3000, () => stored(h) !== null);
    expect(stored(h)).toEqual({ [A]: 'half a thought' });
  });

  it('picks up its draft from the first sync when the visit named no topic', async () => {
    const h = await open({ storage: { aa_drafts: JSON.stringify({ [A]: 'from last time' }) } });
    expect(input(h).value).toBe('');
    await h.emit(sync(A, [], [A]));
    expect(input(h).value).toBe('from last time');
  });

  it('leaves drafts another tab wrote alone', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    // Written by a second tab on this origin, after this one loaded.
    h.window.localStorage.setItem('aa_drafts', JSON.stringify({ c3d4e5f6: 'the other tab' }));
    input(h).value = 'this tab';

    await h.click(`[data-topic="${B}"]`);
    expect(stored(h)).toEqual({ c3d4e5f6: 'the other tab', [A]: 'this tab' });
  });

  it('keeps a very long draft in memory only', async () => {
    // localStorage is one small budget for the whole origin; a pasted log must not fill it and take
    // the read marks and the drawer state down with it.
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    const long = 'x'.repeat(70 * 1024);
    input(h).value = long;

    await h.click(`[data-topic="${B}"]`);
    expect(stored(h)).toBeNull();
    await h.click(`[data-topic="${A}"]`);
    expect(input(h).value).toBe(long);
  });

  it('touches no storage at all switching between two empty composers', async () => {
    // Most switches are exactly this, and the draft swap is on the path of every one of them.
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    const touched: string[] = [];
    const proto = h.window.Storage.prototype;
    const get = proto.getItem;
    const set = proto.setItem;
    proto.getItem = function (this: Storage, k: string) {
      if (k === 'aa_drafts') touched.push('get');
      return get.call(this, k);
    };
    proto.setItem = function (this: Storage, k: string, v: string) {
      if (k === 'aa_drafts') touched.push('set');
      return set.call(this, k, v);
    };

    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);
    expect(touched).toEqual([]);
  });

  it('forgets the draft of a topic that is deleted, and every draft when all are cleared', async () => {
    const h = await open({ replies: { 'api/topics/clear': { topic: { id: 'deadbeef', title: '', lastAt: 2000 } } } });
    await h.emit(sync(A, [], [A, B]));
    input(h).value = 'for A';
    await h.click(`[data-topic="${B}"]`);
    input(h).value = 'for B';
    await h.click(`[data-topic="${A}"]`);
    expect(stored(h)).toEqual({ [A]: 'for A', [B]: 'for B' });

    await h.click(`[data-del="${B}"]`);
    await until('B is forgotten', () => JSON.stringify(stored(h)) === JSON.stringify({ [A]: 'for A' }));

    await h.click('#clear-topics');
    await until('every draft is gone', () => stored(h) === null);
    expect(input(h).value).toBe('');
  });
});

describe('webui page: a topic the daemon no longer has', () => {
  // A transcript lives in the daemon's memory while the topic LIST lives on disk, so every
  // restart leaves rows that open onto nothing. Rendered faithfully that is a blank panel — which
  // is indistinguishable from a page that failed to load, and is how it was reported.
  it('says why an emptied topic is empty', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { stale: true }));

    expect(h.painted()).toBe(0);
    expect(h.skeletons()).toBe(0);
    expect(h.notice()).toContain('older than the running daemon');
    // The half that keeps it from reading as data loss: the agent's own context is persisted.
    expect(h.notice()).toContain('still has its context');
  });

  it('takes the notice away as soon as the topic has something in it', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { stale: true }));
    expect(h.notice()).not.toBeNull();

    await h.emit({ t: 'msg', msg: message('m1', '<p>carrying on</p>') });

    expect(h.notice()).toBeNull();
    expect(h.painted()).toBe(1);
  });

  it('leaves a genuinely new topic to speak for itself', async () => {
    // No flag, so this room is empty because nothing has been said in it yet. Explaining a
    // restart here would be both wrong and the first thing a new install ever reads.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    expect(h.notice()).toBeNull();
  });

  it('does not carry the notice into the next topic', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5'], { stale: true }));
    expect(h.notice()).not.toBeNull();

    await h.click('[data-topic="b2c3d4e5"]');

    // Whether THAT room predates the daemon is its own sync's answer to give; until it lands the
    // page is back to showing the shape of a transcript that is on its way.
    expect(h.notice()).toBeNull();
    expect(h.skeletons()).toBeGreaterThan(0);
  });
});

describe('webui page: choosing an agent for a new topic', () => {
  /** Two machines, the shape `agentCatalog` builds: the live deployment's, give or take. */
  const agents = {
    current: 'cc',
    groups: [
      {
        name: 'uniagent',
        agents: [
          { id: 'cc', harness: 'claude', kind: 'Claude Code' },
          { id: 'oc', harness: 'opencode', kind: 'OpenCode', model: 'opencode/deepseek-v4.1-flash-free' },
          { id: 'cx', harness: 'codex', kind: 'Codex' },
        ],
      },
      {
        name: 'awsfree2',
        agents: [
          { id: 'oc2', harness: 'opencode', kind: 'OpenCode' },
          { id: 'cb', harness: 'custom', kind: 'codebuddy' },
        ],
      },
    ],
  };
  const launch = (h: Harness): HTMLElement | null => h.el('log').querySelector('.launch');
  const cards = (h: Harness): HTMLElement[] => Array.from(h.el('log').querySelectorAll<HTMLElement>('.agent-card'));

  it('lays every agent out by machine in place of the empty transcript, the default marked', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));

    expect(h.skeletons()).toBe(0);
    expect(h.painted()).toBe(0);
    expect(Array.from(launch(h)!.querySelectorAll('.launch-host')).map((e) => e.firstChild?.textContent?.trim())).toEqual([
      'uniagent',
      'awsfree2',
    ]);
    expect(cards(h).map((c) => c.getAttribute('data-agent'))).toEqual(['cc', 'oc', 'cx', 'oc2', 'cb']);
    // What each one IS, not only its id — and the model, where one is configured.
    expect(cards(h)[1]!.textContent).toContain('OpenCode');
    expect(cards(h)[1]!.querySelector('.ac-model')?.textContent).toBe('opencode/deepseek-v4.1-flash-free');
    expect(cards(h)[4]!.textContent).toContain('codebuddy');
    // Coloured by the configured harness, which is a key, rather than by the label, which is prose.
    expect(cards(h)[2]!.querySelector('.ac-dot')?.className).toContain('h-codex');
    // Who "just type" reaches, said twice: on its card, and in the line above.
    const def = h.el('log').querySelectorAll('.agent-card.def');
    expect(Array.from(def).map((c) => c.getAttribute('data-agent'))).toEqual(['cc']);
    expect(def[0]!.textContent).toContain('default');
    expect(launch(h)!.querySelector('.launch-sub')?.textContent).toContain('cc answers by default');
  });

  it('names no machine when there is only one', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents: { current: 'cc', groups: [agents.groups[0]] } }));
    expect(cards(h)).toHaveLength(3);
    expect(launch(h)!.querySelector('.launch-host')).toBeNull();
  });

  it('a tap sends /agent <id> for this topic, and its bubble takes the choice away', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));
    (h.el('input') as HTMLTextAreaElement).value = 'a draft';

    await h.click('.agent-card[data-agent="oc2"]');

    const sent = h.calls.filter((c) => c.path === 'api/send');
    expect(sent.map((c) => [c.body.text, c.body.topic])).toEqual([['/agent oc2', 'a1b2c3d4']]);
    expect(launch(h)).toBeNull();
    expect(h.el('log').textContent).toContain('/agent oc2');
    // A control, like Stop: what was in the composer is still there.
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('a draft');
  });

  it('goes as soon as anything is said, typed or not, and comes back if the room empties again', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));

    await h.emit({ t: 'msg', msg: message('w1', '<p>a scheduled task said this</p>') });
    expect(launch(h)).toBeNull();

    // Deleted again, and nothing has said the choice is closed: the room is what it was.
    await h.emit({ t: 'del', id: 'w1' });
    expect(cards(h)).toHaveLength(5);
  });

  it('follows the sync: a room that has started shows none, and a stale one shows the choice instead of the notice', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));
    expect(launch(h)).not.toBeNull();

    // A reconnect's sync for the same room, now carrying nothing: the daemon closed the question.
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    expect(launch(h)).toBeNull();

    // Older than the daemon and still open: no agent has a session here, so "the agent still has its
    // context" would be untrue — the choice is the honest thing to show.
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { stale: true, agents }));
    expect(launch(h)).not.toBeNull();
    expect(h.notice()).toBeNull();
  });

  it('is redrawn only when what it shows changed', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));
    const first = launch(h);
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));
    expect(launch(h)).toBe(first);

    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents: { ...agents, current: 'cx' } }));
    expect(launch(h)).not.toBe(first);
    expect(h.el('log').querySelector('.agent-card.def')?.getAttribute('data-agent')).toBe('cx');
  });

  it('does not carry into the next topic', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5'], { agents }));
    expect(launch(h)).not.toBeNull();

    await h.click('[data-topic="b2c3d4e5"]');

    // That room's own sync says whether it has a choice to offer; until then, placeholders.
    expect(launch(h)).toBeNull();
    expect(h.skeletons()).toBeGreaterThan(0);
  });

  it('lays it out again in the next new topic, though it offers the very same agents', async () => {
    // The everyday path — + twice — and the one a cached "already drawn" would get wrong: the
    // element went with the last topic's transcript, while what it was drawn from has not changed.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5'], { agents }));
    await h.click('[data-topic="b2c3d4e5"]');
    await h.emit(sync('b2c3d4e5', [], ['a1b2c3d4', 'b2c3d4e5'], { agents }));

    expect(cards(h)).toHaveLength(5);
    expect(h.skeletons()).toBe(0);
  });

  it('escapes what it is given, which comes from config.yaml', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    const odd = { id: 'x"><img src=x>', harness: 'custom', kind: '<b>k</b>', model: '<i>m</i>' };
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents: { current: 'cc', groups: [{ name: '<u>g</u>', agents: [odd] }, agents.groups[0]] } }));
    expect(h.el('log').querySelector('.launch img, .launch b:not(.launch-sub b), .launch i:not(.ac-dot), .launch u')).toBeNull();
    expect(cards(h)[0]!.getAttribute('data-agent')).toBe('x"><img src=x>');
  });
});

describe('webui page: menus', () => {
  /** A `/cd`-shaped menu: a root, the current directory, two more, and the page controls. */
  const menu = (): Record<string, unknown> => ({
    ...message('m1', '<p>Working dir</p>'),
    buttons: [
      { id: 'wdr:r:0', label: '⌂ workspace' },
      { id: 'wdr:r:1', label: '● talkcode' },
      { id: 'wdr:r:2', label: 'uniagent' },
      { id: 'wdr:r:3', label: '项目报告归档' },
      { id: 'wdp:r:1', label: '◀ Prev' },
      { id: 'wdp:r:1', label: 'Next ▶' },
    ],
  });
  const cells = (h: Harness, sel: string): string[] =>
    Array.from(h.doc.querySelectorAll(sel)).map((b) => b.textContent ?? '');

  it('puts the choices in the grid and the page controls on a row of their own under them', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    // Direct children of .btns are the choices; the controls are inside .nav, after them. Paging
    // used to sit in the middle of the list as two more things to pick.
    expect(cells(h, '.btns > button')).toEqual(['⌂ workspace', '● talkcode', 'uniagent', '项目报告归档']);
    expect(cells(h, '.btns > .nav > button')).toEqual(['◀ Prev', 'Next ▶']);
    expect(h.doc.querySelector('.btns > :last-child')?.className).toBe('nav');
  });

  it('sizes the columns from the widest label, counting a CJK character as two', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    // 项目报告归档 is six characters and twelve columns wide — wider than "⌂ workspace" (11).
    // The page controls are not choices and do not widen the grid.
    expect(h.doc.querySelector<HTMLElement>('.btns')?.style.getPropertyValue('--cw')).toBe('12ch');
  });

  it('lights the current choice, keeping its mark in the text', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    const lit = h.doc.querySelectorAll('.btns button.on');
    expect(Array.from(lit).map((b) => b.textContent)).toEqual(['● talkcode']);
    // The mark is its own element so it can be coloured — and the root's ⌂ is a mark, not a choice.
    expect(lit[0]?.querySelector('.mk')?.textContent).toBe('●');
    expect(h.doc.querySelector('button[data-btn="wdr:r:0"] .mk')?.textContent).toBe('⌂');
    expect(h.doc.querySelector('button[data-btn="wdr:r:0"]')?.classList.contains('on')).toBe(false);
  });

  it('lights a ticked multi-select option and not an unticked one', async () => {
    const h = await open();
    await h.emit(
      sync('a1b2c3d4', [{ ...message('m1', '<p>which?</p>'), buttons: [
        { id: 'ask:r:0', label: '☑ EU' },
        { id: 'ask:r:1', label: '☐ US' },
      ] }], ['a1b2c3d4'])
    );

    expect(h.doc.querySelector('button[data-btn="ask:r:0"]')?.classList.contains('on')).toBe(true);
    expect(h.doc.querySelector('button[data-btn="ask:r:1"]')?.classList.contains('on')).toBe(false);
  });

  it('a page control still posts its own id', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    await h.click('.nav button:last-child');

    expect(h.calls.find((c) => c.path === 'api/click')?.body).toEqual({
      topic: 'a1b2c3d4',
      messageId: 'm1',
      buttonId: 'wdp:r:1',
    });
  });

  it('lights a tapped cell at once, and stops lighting it when the tap is refused', async () => {
    const h = await open({ status: { 'api/click': 409 } });
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    const b = (): HTMLButtonElement | null => h.doc.querySelector('button[data-btn="wdr:r:2"]');
    h.doc.querySelector<HTMLButtonElement>('button[data-btn="wdr:r:2"]')?.click();
    // Synchronously: the round trip has not even started, and the tap is already visible.
    expect(b()?.classList.contains('busy')).toBe(true);
    expect(b()?.disabled).toBe(true);

    // 409 is "that message is gone": nothing is coming, so it is not left looking like it is.
    await until('the refusal lands', () => b()?.classList.contains('busy') === false);
    expect(b()?.disabled).toBe(true);
  });

  it('a repaint answering the tap takes the lit state away with it', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    await h.click('button[data-btn="wdr:r:2"]');
    expect(h.doc.querySelector('button[data-btn="wdr:r:2"]')?.classList.contains('busy')).toBe(true);

    await h.emit({ t: 'msg', msg: { ...menu(), buttons: [] } });
    expect(h.doc.querySelector('.btns')).toBeNull();
  });
});

describe('webui page: the settings page', () => {
  /**
   * A `/setting` list as the daemon sends it with `capabilities.settingsScreen`: the buttons it
   * would send a chat app, plus the same rows as data — groups, a control per row, and the ids each
   * control posts. The model row's value is deliberately longer than the 40-character label
   * budget, the thing this screen exists to stop cutting.
   */
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const LONG_MODEL = 'openrouter/anthropic/claude-opus-4.6-thinking:high';
  const list = (id = 'm1'): Record<string, unknown> => ({
    ...message(id, '<p>Settings — saved to config.yaml, not just this conversation.</p>'),
    buttons: [
      { id: 'stg:r:0', label: 'Default agent · cc · claude' },
      { id: 'stg:r:1', label: 'Default model · cc · (harness default)' },
      { id: 'stg:r:2', label: 'Default model · oc · openrouter/anthropic/claude-opus…' },
      { id: 'stg:r:3', label: 'Confirm sub-agent starts · on' },
      { id: 'stg:r:4', label: 'Idle reclaim · 15m' },
      { id: 'stg:r:5', label: 'Conversation scope · per_thread' },
      { id: 'sco:r:0', label: '⏰ Scheduled tasks · 1 active' },
    ],
    settings: {
      level: 'list',
      about: 'These apply to every conversation. `/model` changes one topic only.',
      groups: [
        { name: 'Agents' },
        { name: 'Default model', note: 'What each agent starts a new session with.' },
        { name: 'Sub-agents' },
        { name: 'Conversations' },
        { name: 'More' },
      ],
      rows: [
        {
          buttonId: 'stg:r:0',
          label: 'Default agent',
          value: 'cc · claude',
          hint: 'Answers a new conversation that no routing rule claims.',
          group: 'Agents',
          control: {
            kind: 'choice',
            options: [
              { buttonId: 'sts:r:0', label: 'cc · claude', current: true },
              { buttonId: 'sts:r:1', label: 'oc · opencode', current: false },
            ],
          },
        },
        {
          buttonId: 'stg:r:1',
          label: 'cc',
          target: 'cc',
          targetKind: 'Claude Code',
          value: 'harness default',
          unset: true,
          group: 'Default model',
          control: { kind: 'list' },
        },
        {
          buttonId: 'stg:r:2',
          label: 'oc',
          target: 'oc',
          targetKind: 'OpenCode',
          here: true,
          value: LONG_MODEL,
          group: 'Default model',
          control: { kind: 'list' },
        },
        {
          buttonId: 'stg:r:3',
          label: 'Confirm sub-agent starts',
          value: 'on',
          hint: 'Wait for your Start before an agent’s sub-tasks run.',
          group: 'Sub-agents',
          control: { kind: 'switch', on: true, set: 'sts:r:2' },
        },
        {
          buttonId: 'stg:r:4',
          label: 'Idle reclaim',
          value: '15m',
          group: 'Conversations',
          control: {
            kind: 'choice',
            options: [
              { buttonId: 'sts:r:3', label: 'off', detail: 'never reclaim', current: false },
              { buttonId: 'sts:r:4', label: '15m', current: true },
              { buttonId: 'sts:r:5', label: '1h', current: false },
            ],
          },
        },
        {
          buttonId: 'stg:r:5',
          label: 'Conversation scope',
          value: 'per_thread',
          effectLabel: 'after restart',
          effectDetail: 'takes effect when the daemon restarts',
          group: 'Conversations',
          control: {
            kind: 'choice',
            options: [
              { buttonId: 'sts:r:6', label: 'per_thread', detail: 'a topic is its own conversation', current: true },
              { buttonId: 'sts:r:7', label: 'per_channel', current: false },
              { buttonId: 'sts:r:8', label: 'per_user', current: false },
              { buttonId: 'sts:r:9', label: 'shared', current: false },
            ],
          },
        },
        { buttonId: 'sco:r:0', label: '⏰ Scheduled tasks · 1 active', group: 'More', control: { kind: 'link' } },
      ],
    },
  });

  /** The value level of `Idle reclaim`, with `15m` current and nothing to page. */
  const values = (id = 'm1'): Record<string, unknown> => ({
    ...message(id, '<p><strong>Idle reclaim</strong> — <code>15m</code></p>'),
    buttons: [
      { id: 'stv:r:0', label: 'off (never reclaim)' },
      { id: 'stv:r:1', label: '● 15m' },
      { id: 'stv:r:2', label: '1h' },
      { id: 'stb:r:0', label: '◀ Back' },
    ],
    settings: {
      level: 'values',
      head: {
        label: 'Idle reclaim',
        value: '15m',
        description: 'How long a conversation may sit quiet before its agent child is stopped.',
        effect: 'Changes in effect now.',
      },
      options: [
        { buttonId: 'stv:r:0', label: 'off', detail: 'never reclaim', current: false },
        { buttonId: 'stv:r:1', label: '15m', current: true },
        { buttonId: 'stv:r:2', label: '1h', current: false },
      ],
      nav: { page: 1, pageCount: 1, back: 'stb:r:0' },
    },
  });

  /** A list screen whose `settings` the test can change before sending. */
  const withScreen = (edit: (s: { rows: Array<Record<string, any>>; notice?: unknown }) => void, id = 'm1') => {
    const m = list(id);
    edit(m.settings as { rows: Array<Record<string, any>> });
    return m;
  };

  const text = (h: Harness, sel: string): string[] =>
    Array.from(h.doc.querySelectorAll(sel)).map((e) => e.textContent ?? '');
  const clicks = (h: Harness) => h.calls.filter((c) => c.path === 'api/click').map((c) => c.body);

  /** A page with a topic on screen and one live settings screen delivered into it. */
  async function opened(msg: Record<string, unknown> = list(), o: Parameters<typeof open>[0] = {}): Promise<Harness> {
    const h = await open(o);
    await h.emit(sync(A, [], [A, B]));
    await h.emit({ t: 'msg', msg });
    return h;
  }

  it('draws the daemon’s screen in a page of its own, not in the transcript', async () => {
    const h = await opened();

    expect(h.el('settings-page').hidden).toBe(false);
    expect(text(h, '#settings-body .set-group')).toEqual(['Agents', 'Default model', 'Sub-agents', 'Conversations', 'More']);
    // The old grid is not drawn either: the page replaces it, it does not sit under it.
    expect(h.doc.querySelector('#log .btns')).toBeNull();
    // And the screen is not a message: nothing was added to the transcript for it.
    expect(h.painted()).toBe(0);
    expect(h.doc.querySelector('#log .set-card')).toBeNull();
    // The bar says where the settings live, not which topic they belong to: they belong to none.
    expect(h.el('settings-topic').textContent).toBe('Saved to config.yaml · every topic');
    expect(h.el('settings-topic').title).toBe('Opened from the topic “Topic ' + A + '”');
    expect(h.doc.querySelector('#settings-body .set-about')?.innerHTML).toContain('<code>/model</code>');
  });

  it('draws each kind of setting with its own control, from the kind the daemon names', async () => {
    const h = await opened();
    const body = h.el('settings-body');

    // On/off is a switch, in its state.
    const sw = body.querySelector('.set-switch');
    expect(sw?.getAttribute('role')).toBe('switch');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    expect(sw?.getAttribute('data-btn')).toBe('sts:r:2');
    expect(sw?.closest('.set-item')?.querySelector('.set-label')?.textContent).toBe('Confirm sub-agent starts');

    // Five or fewer short values: a segmented control, the current one checked.
    const seg = Array.from(body.querySelectorAll('.set-seg button'));
    expect(seg.map((b) => [b.textContent, b.getAttribute('aria-checked')])).toEqual([
      ['off', 'false'],
      ['15m', 'true'],
      ['1h', 'false'],
    ]);
    expect(seg[0]?.getAttribute('title')).toBe('never reclaim');

    // Longer values: a select, its options writing directly, the explanation beside the value.
    const selects = Array.from(body.querySelectorAll('select.set-select')) as HTMLSelectElement[];
    expect(selects.map((s) => s.getAttribute('aria-label'))).toEqual(['Default agent', 'Conversation scope']);
    expect(selects[1]!.value).toBe('sts:r:6');
    // The value alone, so a closed select is not a sentence cut in half; the meaning is its title.
    expect(Array.from(selects[1]!.options).map((o) => o.textContent)).toEqual(['per_thread', 'per_channel', 'per_user', 'shared']);
    expect(selects[1]!.options[0]!.title).toBe('a topic is its own conversation');

  });

  it('draws a model as a row that opens its own screen, and says when a change lands', async () => {
    const h = await opened();
    const body = h.el('settings-body');
    // Named by its agent, its value in full.
    const oc = body.querySelector('button.set-open[data-btn="stg:r:2"]');
    expect(oc?.querySelector('.set-label span')?.textContent).toBe('oc');
    expect(oc?.querySelector('.set-kind')?.textContent).toBe('OpenCode');
    expect(oc?.querySelector('.set-badge.here')?.textContent).toBe('this topic');
    expect(oc?.querySelector('.set-v')?.textContent).toBe(LONG_MODEL);
    expect(oc?.textContent).not.toContain('…');
    // Unset reads as a placeholder, not as a model called "(harness default)".
    const cc = body.querySelector('button.set-open[data-btn="stg:r:1"] .set-v');
    expect(cc?.textContent).toBe('harness default');
    expect(cc?.classList.contains('unset')).toBe(true);

    // When a change lands is a badge only where it is not "now", with the sentence behind it.
    const badges = Array.from(body.querySelectorAll('.set-badge.restart'));
    expect(badges.map((b) => [b.textContent, b.getAttribute('title')])).toEqual([
      ['after restart', 'takes effect when the daemon restarts'],
    ]);
    expect(text(h, '#settings-body .set-gnote')).toEqual(['What each agent starts a new session with.']);
    // The scheduled tasks are a way elsewhere: a row and a chevron, no value.
    const link = body.querySelector('button.set-open[data-btn="sco:r:0"]');
    expect(link?.querySelector('.set-v')).toBeNull();
    expect(link?.querySelector('.set-chev')).not.toBeNull();
    // One column of sections: no grid of rows left over from the two-column layout.
    expect(body.querySelector('.set-rows')).toBeNull();
  });

  it('flips a switch in one tap, showing the new state before the daemon answers', async () => {
    const h = await opened();
    await h.click('#settings-body .set-switch');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'sts:r:2' }]);
    const sw = h.el('settings-body').querySelector('.set-switch');
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    expect(sw?.classList.contains('busy')).toBe(true);

    // The daemon's answer redraws the row from what it wrote, with a banner saying so.
    const answered = withScreen((s) => {
      s.rows[3]!.control = { kind: 'switch', on: false, set: 'sts:r:2' };
      s.notice = { tone: 'ok', text: '✓ Confirm sub-agent starts → off\nSaved to config.yaml · in effect now.' };
    });
    await h.emit({ t: 'msg', msg: answered });
    const after = h.el('settings-body').querySelector('.set-switch');
    expect(after?.getAttribute('aria-checked')).toBe('false');
    expect(after?.classList.contains('busy')).toBe(false);
    const banner = h.el('settings-body').querySelector('.set-notice');
    expect(banner?.classList.contains('ok')).toBe(true);
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.textContent).toContain('Confirm sub-agent starts → off');
  });

  it('flips a switch from anywhere on its row, the label included', async () => {
    const h = await opened();
    await h.click('#settings-body .set-item.sw .set-label');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'sts:r:2' }]);
  });

  it('writes a segment and a select value straight from the row', async () => {
    const h = await opened();
    await h.click('#settings-body .set-seg button[data-btn="sts:r:5"]');
    expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'sts:r:5' });
    expect(h.doc.querySelector('#settings-body .set-seg button[data-btn="sts:r:5"]')?.getAttribute('aria-checked')).toBe('true');
    expect(h.doc.querySelector('#settings-body .set-seg button[data-btn="sts:r:4"]')?.getAttribute('aria-checked')).toBe('false');

    await h.emit({ t: 'msg', msg: list() });
    const scope = h.doc.querySelectorAll('#settings-body select.set-select')[1] as HTMLSelectElement;
    scope.value = 'sts:r:8';
    scope.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await tick();
    expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'sts:r:8' });
    expect(scope.disabled).toBe(true);
  });

  it('shows a value no option names in the select, rather than a wrong one', async () => {
    const h = await opened(
      withScreen((s) => {
        s.rows[0]!.value = 'gone · claude';
        s.rows[0]!.control.options.forEach((o: { current: boolean }) => (o.current = false));
      })
    );
    const agent = h.doc.querySelector('#settings-body select.set-select') as HTMLSelectElement;
    expect(agent.selectedOptions[0]?.textContent).toBe('gone · claude');
    expect(agent.selectedOptions[0]?.disabled).toBe(true);
  });

  it('says why when the daemon refuses a value, in a banner of its own', async () => {
    const h = await opened(
      withScreen((s) => {
        s.notice = { tone: 'error', text: 'Could not save Idle reclaim: `config.yaml` is read-only' };
      })
    );
    const banner = h.el('settings-body').querySelector('.set-notice');
    expect(banner?.classList.contains('error')).toBe(true);
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.innerHTML).toBe('Could not save Idle reclaim: <code>config.yaml</code> is read-only');
    // It stays where it can be seen however far down the control was, and does not fade.
    expect(renderPage('Chat', false)).toMatch(/\.set-notice\{position:sticky;top:-14px/);
    await new Promise((r) => setTimeout(r, 50));
    expect(banner?.classList.contains('faded')).toBe(false);
  });

  it('escapes what the daemon says before keeping its code spans', async () => {
    const h = await opened(
      withScreen((s) => {
        s.notice = { tone: 'info', text: '<img src=x onerror=alert(1)> `<b>`' };
      })
    );
    const banner = h.el('settings-body').querySelector('.set-notice');
    expect(banner?.querySelector('img')).toBeNull();
    expect(banner?.innerHTML).toBe('&lt;img src=x onerror=alert(1)&gt; <code>&lt;b&gt;</code>');
  });

  it('puts a switch back and says so when the request cannot reach the daemon', async () => {
    const h = await opened(list(), { hang: ['api/click'], shortenLong: true });
    await h.click('#settings-body .set-switch');
    expect(h.el('settings-body').querySelector('.set-switch')?.getAttribute('aria-checked')).toBe('false');
    // Three attempts, each cut at the page's own limit rather than waiting for ever.
    await new Promise((r) => setTimeout(r, 2000));
    expect(h.longTimers).toContain(15000);
    const sw = h.el('settings-body').querySelector('.set-switch');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    expect((sw as HTMLButtonElement).disabled).toBe(false);
    const banner = h.el('settings-body').querySelector('.set-notice.error');
    expect(banner?.textContent).toContain('Could not reach the daemon, so nothing was changed');
    // The next screen from the daemon replaces the page's own line.
    await h.emit({ t: 'msg', msg: list() });
    expect(h.el('settings-body').querySelector('.set-notice')).toBeNull();
  });

  it('says the page is out of date when the daemon no longer has its message', async () => {
    const h = await opened(list(), { status: { 'api/click': 409 } });
    await h.click('#settings-body .set-seg button[data-btn="sts:r:3"]');
    const banner = h.el('settings-body').querySelector('.set-notice.error');
    expect(banner?.textContent).toContain('out of date');
    // Redrawn from what it had: 15m is still the one checked.
    expect(h.doc.querySelector('#settings-body .set-seg button[aria-checked="true"]')?.textContent).toBe('15m');
  });

  it('keeps focus on the control that was used when the answer redraws the page', async () => {
    const h = await opened();
    const sw = h.el('settings-body').querySelector('.set-switch') as HTMLButtonElement;
    sw.focus();
    await h.click('#settings-body .set-switch');
    await h.emit({ t: 'msg', msg: list() });
    expect(h.doc.activeElement?.classList.contains('set-switch')).toBe(true);
  });

  it('marks the current value in the value list, under a head that says what the setting is', async () => {
    const h = await opened(values());
    expect(h.doc.querySelector('.btns')).toBeNull();

    const current = h.doc.querySelector('#settings-body .set-opt.on');
    expect(current?.getAttribute('data-btn')).toBe('stv:r:1');
    expect(current?.getAttribute('aria-current')).toBe('true');
    expect(current?.querySelector('.set-check')?.textContent).toBe('✓');
    expect(current?.querySelector('.set-opt-label')?.textContent).toBe('15m');

    const off = h.doc.querySelector('#settings-body button[data-btn="stv:r:0"]');
    expect(off?.classList.contains('on')).toBe(false);
    expect(off?.querySelector('.set-check')?.textContent).toBe('');
    expect(off?.querySelector('.set-opt-detail')?.textContent).toBe('never reclaim');

    expect(h.doc.querySelector('#settings-body .set-head h3')?.textContent).toBe('Idle reclaim');
    expect(h.doc.querySelector('#settings-body .set-now')?.textContent).toBe('Now: 15m');
    expect(h.doc.querySelector('#settings-body .set-when')?.textContent).toBe('Changes in effect now.');
    // Back is at the top, where a settings sub-page keeps it.
    expect(h.el('settings-body').firstElementChild?.getAttribute('data-btn')).toBe('stb:r:0');
  });

  it('opens a model by posting its row id, and the daemon’s edit turns the list into values', async () => {
    const h = await opened();

    await h.click('#settings-body button[data-btn="stg:r:2"]');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'stg:r:2' }]);

    await h.emit({ t: 'msg', msg: values() });
    expect(h.doc.querySelector('#settings-body .set-opt')).not.toBeNull();
    expect(h.doc.querySelector('#settings-body .set-sec')).toBeNull();
  });

  it('writes the value the row names, and the list comes back with the new value on it', async () => {
    const h = await opened(values());

    await h.click('#settings-body button[data-btn="stv:r:2"]');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'stv:r:2' }]);

    const updated = withScreen((s) => {
      s.rows[2]!.value = 'newapi/glm-5';
    });
    await h.emit({ t: 'msg', msg: updated });
    expect(h.doc.querySelector('#settings-body .set-opt')).toBeNull();
    expect(h.doc.querySelector('#settings-body button[data-btn="stg:r:2"] .set-v')?.textContent).toBe('newapi/glm-5');
  });

  it('posts the Back id, which is how the daemon puts the list back on the same message', async () => {
    const h = await opened(values());

    await h.click('#settings-body button[data-btn="stb:r:0"]');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'stb:r:0' }]);
  });

  it('pages with the ids the daemon drew, and shows which page this is', async () => {
    const paged = values();
    paged.settings = {
      level: 'values',
      options: [
        { buttonId: 'stv:r:2', label: '1h', current: false },
        { buttonId: 'stv:r:3', label: '4h', current: false },
      ],
      nav: { page: 2, pageCount: 3, prev: 'stp:r:0', next: 'stp:r:2', back: 'stb:r:0' },
    };
    const h = await opened(paged);

    expect(h.doc.querySelector('#settings-body .set-page')?.textContent).toBe('2 / 3');
    await h.click('#settings-body button[data-btn="stp:r:2"]');
    expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'stp:r:2' });

    // A repaint re-enables the button, as every other menu relies on.
    await h.emit({ t: 'msg', msg: paged });
    await h.click('#settings-body button[data-btn="stp:r:0"]');
    expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'stp:r:0' });
  });

  it('asks the daemon quietly from the Settings menu, and never posts a bubble for it', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A, B]));

    await h.click('#opts-toggle');
    await h.click('#settings-open');

    // The page is up before the answer, so a slow daemon reads as loading rather than as nothing.
    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.el('settings-body').textContent).toContain('Loading settings');

    const sent = h.calls.find((c) => c.path === 'api/send');
    expect(sent?.body.text).toBe('/setting');
    expect(sent?.body.topic).toBe(A);
    // A control the operator pressed must not become a message they never wrote.
    expect(sent?.body.quiet).toBe(true);
    expect(h.painted()).toBe(0);

    await h.emit({ t: 'msg', msg: list() });
    expect(text(h, '#settings-body .set-group')).toContain('Agents');
    expect(h.painted()).toBe(0);
  });

  it('opens on a typed /setting too, and leaves only the command in the transcript', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));

    const input = h.el('input') as HTMLTextAreaElement;
    input.value = '/setting';
    await h.click('#composer button[type="submit"]');

    const sent = h.calls.find((c) => c.path === 'api/send');
    expect(sent?.body.text).toBe('/setting');
    expect(sent?.body.quiet).toBeUndefined();
    // The operator's own command is their message and stays; the screen does not.
    expect(h.painted()).toBe(1);

    await h.emit({ t: 'msg', msg: list() });
    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.painted()).toBe(1);
    expect(h.doc.querySelector('#log .set-card')).toBeNull();
  });

  it('keeps a retired screen out of the transcript, and a new one replaces the page', async () => {
    const h = await opened();

    // The daemon retires a menu by editing it with no buttons; room.revise marks it so a reload
    // cannot turn its farewell line into a chat message.
    const retired = { ...list(), buttons: [], wasSettings: true } as Record<string, unknown>;
    delete retired.settings;
    await h.emit({ t: 'msg', msg: retired });
    expect(h.painted()).toBe(0);
    // The page stays up: the menu was retired because a new one is about to arrive.
    expect(h.el('settings-page').hidden).toBe(false);

    await h.emit({ t: 'msg', msg: values('m2') });
    expect(h.doc.querySelector('#settings-body .set-opt')).not.toBeNull();
    expect(h.painted()).toBe(0);

    // A message restored from another run is history: it is not a message on screen either.
    await h.emit(sync(A, [{ ...list('m3'), g: 2 }], [A]));
    expect(h.painted()).toBe(0);
    expect(h.doc.querySelector('#log .set-card')).toBeNull();
  });

  it('closes on the ×, on Escape, on the backdrop, and when the topic changes', async () => {
    const h = await opened();
    const shut = (): boolean => h.el('settings-page').hidden;

    await h.click('#settings-close');
    expect(shut()).toBe(true);

    await h.emit({ t: 'msg', msg: list('m2') });
    expect(shut()).toBe(false);
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(shut()).toBe(true);

    await h.emit({ t: 'msg', msg: list('m3') });
    h.doc.getElementById('settings-page')!.click();
    await tick();
    expect(shut()).toBe(true);

    await h.emit({ t: 'msg', msg: list('m4') });
    expect(shut()).toBe(false);
    await h.click('[data-topic="' + B + '"]');
    expect(shut()).toBe(true);
  });

  it('does not reopen a page the operator closed when the daemon edits that message', async () => {
    const h = await opened();
    await h.click('#settings-close');
    expect(h.el('settings-page').hidden).toBe(true);

    // An edit of the same message (a value list, say) is not a new /setting: it stays closed.
    await h.emit({ t: 'msg', msg: values() });
    expect(h.el('settings-page').hidden).toBe(true);
    expect(h.painted()).toBe(0);
  });

  it('does not reopen a page closed while it was still Loading — and a new request still opens', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));

    await h.click('#opts-toggle');
    await h.click('#settings-open');
    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.el('settings-body').textContent).toContain('Loading settings');
    await h.click('#settings-close');
    expect(h.el('settings-page').hidden).toBe(true);

    // The answer to the request that was cancelled on the way out must not reopen the page.
    await h.emit({ t: 'msg', msg: list('m1') });
    expect(h.el('settings-page').hidden).toBe(true);
    expect(h.painted()).toBe(0);

    // A later request has a later token, so its answer does open.
    await h.click('#opts-toggle');
    await h.click('#settings-open');
    await h.emit({ t: 'msg', msg: list('m2') });
    expect(h.el('settings-page').hidden).toBe(false);
    expect(text(h, '#settings-body .set-group')).toContain('Agents');
  });

  it('does not let a cancelled request in one topic swallow an answer in another', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A, B]));

    await h.click('#opts-toggle');
    await h.click('#settings-open');
    await h.click('#settings-close');

    // Another topic, and a /setting the operator typed there: its answer is not the one the
    // cancelled request in A is waiting for.
    await h.click('[data-topic="' + B + '"]');
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = '/setting';
    await h.click('#composer button[type="submit"]');
    await h.emit({ t: 'msg', msg: list('mB') });

    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.el('settings-topic').title).toBe('Opened from the topic “Topic ' + B + '”');
    // And its controls post into B, where its message is.
    await h.click('#settings-body .set-switch');
    expect(clicks(h).at(-1)).toEqual({ topic: B, messageId: 'mB', buttonId: 'sts:r:2' });
  });

  it('says the daemon did not answer instead of sitting on Loading for ever', async () => {
    const h = await open({ shortenLong: true });
    await h.emit(sync(A, [], [A]));

    await h.click('#opts-toggle');
    await h.click('#settings-open');
    expect(h.el('settings-body').textContent).toContain('Loading settings');

    await new Promise((r) => setTimeout(r, 60));
    expect(h.el('settings-body').textContent).toContain('did not answer');
    // The wait is the send's own patience, and it is a real timer rather than a permanent state.
    expect(h.longTimers).toContain(15000);
  });

  it('puts the page away when the message becomes the scheduled-task menu', async () => {
    const h = await opened();
    await h.click('#settings-body button[data-btn="sco:r:0"]');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'sco:r:0' }]);
    // The daemon hands the settings message to the task list: buttons, no screen. That is a menu
    // again, so the page goes and the menu is painted in the transcript.
    await h.emit({
      t: 'msg',
      msg: { ...message('m1', '<p>Scheduled tasks</p>'), buttons: [{ id: 'sct:r:0', label: 'Morning CI' }] },
    });
    expect(h.el('settings-page').hidden).toBe(true);
    expect(h.painted()).toBe(1);
    expect(h.doc.querySelector('#log button[data-btn="sct:r:0"]')).not.toBeNull();
  });

  describe('a model’s own screen', () => {
    const models = Array.from({ length: 12 }, (_, i) => ({
      buttonId: 'stv:r:' + i,
      label: i === 3 ? 'newapi/kimi-k3' : 'opencode/model-' + i,
      ...(i === 3 ? { detail: 'Kimi K3' } : {}),
      current: i === 0,
    }));
    const modelScreen = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...message('m1', '<p>Default model</p>'),
      buttons: [],
      settings: {
        level: 'values',
        head: {
          label: 'Default model',
          target: 'oc@box',
          targetKind: 'OpenCode',
          value: 'opencode/model-0',
          description: 'The model `oc@box` starts its sessions with.',
          effect: 'Takes effect from oc@box’s next agent session.',
          source: "From box's pod.yaml. A model chosen here is kept in the gateway's config.yaml and wins over the pod's.",
        },
        typed: { buttonId: 'stt:r:0', placeholder: 'Or type a model name' },
        options: models,
        nav: { page: 1, pageCount: 1, back: 'stb:r:0' },
        ...over,
      },
    });

    it('says whose value it is, and filters a long list as it is typed into', async () => {
      const h = await opened(modelScreen());
      expect(h.doc.querySelector('#settings-body .set-src')?.textContent).toContain("From box's pod.yaml");
      const field = h.doc.querySelector('#settings-body .set-type') as HTMLInputElement;
      expect(field.placeholder).toBe('Filter, or type a model name');
      field.value = 'kimi';
      field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
      const shown = Array.from(h.doc.querySelectorAll('#settings-body .set-opt')).filter((o) => !(o as HTMLElement).hidden);
      // Matched on the name under the id too.
      expect(shown.map((o) => o.getAttribute('data-btn'))).toEqual(['stv:r:3']);
      expect((h.doc.querySelector('#settings-body .set-nomatch') as HTMLElement).hidden).toBe(true);
      field.value = 'zzz';
      field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
      expect((h.doc.querySelector('#settings-body .set-nomatch') as HTMLElement).hidden).toBe(false);
    });

    it('takes a typed name with Use or Enter, carried as the click’s value', async () => {
      const h = await opened(modelScreen());
      const field = h.doc.querySelector('#settings-body .set-type') as HTMLInputElement;
      field.value = '  opencode/unlisted  ';
      await h.click('#settings-body .set-use');
      expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'stt:r:0', value: 'opencode/unlisted' });

      await h.emit({ t: 'msg', msg: modelScreen() });
      const again = h.doc.querySelector('#settings-body .set-type') as HTMLInputElement;
      again.value = 'glm';
      again.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'stt:r:0', value: 'glm' });
      // Nothing typed: nothing posted.
      const n = clicks(h).length;
      await h.emit({ t: 'msg', msg: modelScreen() });
      (h.doc.querySelector('#settings-body .set-type') as HTMLInputElement).value = ' ';
      await h.click('#settings-body .set-use');
      expect(clicks(h)).toHaveLength(n);
    });

    it('shows the list being asked for, and keeps what was typed when it arrives', async () => {
      const h = await opened(
        modelScreen({ loading: true, options: [], head: { label: 'Default model', target: 'oc@box', value: 'harness default', unset: true, description: 'd', effect: 'e', hint: 'Asking oc@box for its models… A name can be typed meanwhile.' } })
      );
      const box = h.doc.querySelector('#settings-body .set-hintbox');
      expect(box?.classList.contains('loading')).toBe(true);
      expect(box?.querySelector('.set-spin')).not.toBeNull();
      const field = h.doc.querySelector('#settings-body .set-type') as HTMLInputElement;
      field.value = 'kimi';
      field.dispatchEvent(new h.window.Event('input', { bubbles: true }));

      await h.emit({ t: 'msg', msg: modelScreen() });
      expect(h.doc.querySelector('#settings-body .set-hintbox')).toBeNull();
      expect((h.doc.querySelector('#settings-body .set-type') as HTMLInputElement).value).toBe('kimi');
      const shown = Array.from(h.doc.querySelectorAll('#settings-body .set-opt')).filter((o) => !(o as HTMLElement).hidden);
      expect(shown).toHaveLength(1);
    });

    it('marks a pod agent’s value on the list with where it comes from', async () => {
      const h = await opened(
        withScreen((s) => {
          s.rows[2]!.valueNote = 'pod.yaml';
        })
      );
      expect(h.doc.querySelector('#settings-body button[data-btn="stg:r:2"] .set-vnote')?.textContent).toBe('pod.yaml');
      expect(h.doc.querySelector('#settings-body button[data-btn="stg:r:1"] .set-vnote')).toBeNull();
    });
  });

  describe('on a phone', () => {
    const narrow = (): string => {
      const html = renderPage('Chat', false);
      const at = html.indexOf('@media(max-width:640px){');
      let depth = 0;
      for (let i = html.indexOf('{', at); i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
      }
      throw new Error('unclosed');
    };

    it('takes the whole screen, and puts a control under its text rather than beside it', () => {
      const css = narrow();
      expect(css).toContain('#settings-box{width:100%;height:100%');
      // One column per row; a switch alone keeps its place on the right, where a thumb looks for it.
      expect(css).toContain('.set-item{grid-template-columns:minmax(0,1fr);');
      expect(css).toContain('.set-item.sw{grid-template-columns:minmax(0,1fr) auto}');
      expect(css).toContain('.set-seg{display:flex;width:100%}');
      // A model's value goes under its agent instead of fighting it for the width.
      expect(css).toContain('.set-open>.set-vv{grid-column:1;grid-row:2;');
      // And none of that leaks onto the desktop.
      const desktop = renderPage('Chat', false).replace(css, '');
      expect(desktop).not.toContain('.set-item{grid-template-columns:minmax(0,1fr);');
    });

    it('keeps every control a finger target, and a select at 16px so Safari does not zoom', () => {
      const css = narrow();
      expect(css).toMatch(/\.set-switch\{[^}]*height:44px/);
      expect(css).toMatch(/\.set-select\{[^}]*min-height:44px[^}]*font-size:16px/);
      expect(css).toMatch(/\.set-seg button\{[^}]*min-height:40px/);
      expect(css).toMatch(/#settings-close\{[^}]*min-width:44px;height:44px/);
      expect(css).toMatch(/\.set-back\{min-height:44px\}/);
      const html = renderPage('Chat', false);
      expect(html).toMatch(/\.set-opt\{[^}]*min-height:44px/);
      expect(html).toMatch(/\.set-nav button\{[^}]*min-height:44px/);
    });

    it('works the same controls at phone width', async () => {
      const h = await opened(list(), { width: 390, height: 844 });
      await h.click('#settings-body .set-item.sw .set-hint');
      expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'sts:r:2' });
      await h.click('#settings-body .set-seg button[data-btn="sts:r:5"]');
      expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'sts:r:5' });
    });
  });
});

describe('webui page: the command list above the composer', () => {
  // As registerCommands hands them over: `/super` carries its argument as the one required option
  // (core/command-translate.ts genericCommandSpecs), `/new` carries none.
  const commands = [
    { name: 'new', description: 'Start a fresh conversation (clears context)' },
    { name: 'stop', description: 'Stop the current turn' },
    {
      name: 'super',
      description: 'Split a job across agents working in parallel (sub-agents)',
      options: [{ name: 'job', description: 'The job to split up', type: 'string', required: true }],
    },
  ];
  async function typed(h: Awaited<ReturnType<typeof open>>, value: string): Promise<void> {
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new h.window.Event('input'));
    await tick();
  }

  it('says what a command takes once it is chosen, and stops at the first character of it', async () => {
    const h = await open();
    await h.emit({ ...sync('a1b2c3d4', [], ['a1b2c3d4']), commands });
    await typed(h, '/su');
    expect(Array.from(h.el('hints').querySelectorAll('button')).map((b) => b.textContent)).toEqual(['/super']);

    await h.click('#hints button[data-cmd="super"]');
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('/super ');
    // The list it was picked from is gone, and so is the button title that was the only place the
    // description showed — never, on a phone. The row now says what comes next.
    expect(h.el('hints').hidden).toBe(false);
    expect(h.el('hints').querySelector('button')).toBeNull();
    expect(h.el('hints').textContent).toBe('/super <job> — Split a job across agents working in parallel (sub-agents)');

    await typed(h, '/super s');
    expect(h.el('hints').hidden).toBe(true);
  });

  it('shows nothing after a command that takes nothing, as before', async () => {
    const h = await open();
    await h.emit({ ...sync('a1b2c3d4', [], ['a1b2c3d4']), commands });
    await typed(h, '/ne');
    await h.click('#hints button[data-cmd="new"]');
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('/new ');
    expect(h.el('hints').hidden).toBe(true);
  });

  it('offers only what the daemon registered here, which on a chat platform has no /super', async () => {
    const h = await open();
    await h.emit({ ...sync('a1b2c3d4', [], ['a1b2c3d4']), commands: commands.filter((c) => c.name !== 'super') });
    await typed(h, '/s');
    expect(Array.from(h.el('hints').querySelectorAll('button')).map((b) => b.textContent)).toEqual(['/stop']);
    await typed(h, '/super ');
    expect(h.el('hints').hidden).toBe(true);
  });
});

describe('webui page: the sidebar width', () => {
  it('follows a drag of its edge, within bounds, keeps it, and goes back on a double-click', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const sidebar = h.el('sidebar');
    const handle = h.el('sidebar-resize');
    const drag = async (x: number): Promise<void> => {
      // MouseEvent under the pointer names: jsdom's sidebar sits at left 0, so x is the width.
      handle.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, clientX: 240 }));
      h.doc.dispatchEvent(new h.window.MouseEvent('pointermove', { bubbles: true, clientX: x }));
      h.doc.dispatchEvent(new h.window.MouseEvent('pointerup', { bubbles: true, clientX: x }));
      await tick();
    };

    await drag(400);
    expect(sidebar.style.getPropertyValue('--pw')).toBe('400px');
    expect(h.window.localStorage.getItem('aa_sb_w')).toBe('400');

    await drag(40);
    expect(sidebar.style.getPropertyValue('--pw')).toBe('180px');

    handle.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
    expect(sidebar.style.getPropertyValue('--pw')).toBe('');
    expect(h.window.localStorage.getItem('aa_sb_w')).toBeNull();
  });

  it('comes back at the width it was left at', async () => {
    const h = await open({ storage: { aa_sb_w: '320' } });
    expect(h.el('sidebar').style.getPropertyValue('--pw')).toBe('320px');
  });
});

describe('webui page: sending', () => {
  it('posts a button click back with the message and button it belongs to', async () => {
    const h = await open();
    await h.emit(
      sync('a1b2c3d4', [{ ...message('m1', '<p>pick one</p>'), buttons: [{ id: 'b:yes', label: 'Yes' }] }], ['a1b2c3d4'])
    );

    await h.click('button[data-btn="b:yes"]');

    expect(h.calls.find((c) => c.path === 'api/click')?.body).toEqual({
      topic: 'a1b2c3d4',
      messageId: 'm1',
      buttonId: 'b:yes',
    });
    // Disabled on click, so a slow link cannot be answered twice.
    expect(h.doc.querySelector<HTMLButtonElement>('button[data-btn="b:yes"]')?.disabled).toBe(true);
  });

  it('a repaint hands the button back, which is what makes a multi-select tickable twice', async () => {
    // The click handler disables and never re-enables; the repaint that follows the tap is what
    // does. A multi-select round rests entirely on this — tick, untick, tick again all land on the
    // same button — so it is pinned here rather than left as a property of innerHTML.
    const h = await open();
    const ticked = { ...message('m1', '<p>pick some</p>'), buttons: [{ id: 'ask:r:0', label: '☐ EU' }] };
    await h.emit(sync('a1b2c3d4', [ticked], ['a1b2c3d4']));

    await h.click('button[data-btn="ask:r:0"]');
    expect(h.doc.querySelector<HTMLButtonElement>('button[data-btn="ask:r:0"]')?.disabled).toBe(true);

    await h.emit({ t: 'msg', msg: { ...ticked, buttons: [{ id: 'ask:r:0', label: '☑ EU' }] } });
    const button = h.doc.querySelector<HTMLButtonElement>('button[data-btn="ask:r:0"]');
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe('☑ EU');
  });

  it('sends with a nonce and clears the composer', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = 'hello there';

    await h.click('#composer button[type="submit"]');

    const sent = h.calls.find((c) => c.path === 'api/send');
    expect(sent?.body.text).toBe('hello there');
    expect(sent?.body.topic).toBe('a1b2c3d4');
    // Without it the page's own retry would post the same message twice.
    expect(typeof sent?.body.nonce).toBe('string');
    expect(input.value).toBe('');
  });

  /**
   * Enter in the composer, as a browser delivers it. `win.KeyboardEvent` rather than the global
   * one: the event has to come from the same realm as the listener, or jsdom's `instanceof`
   * checks inside the dispatch path disagree about what it is.
   *
   * The event is handed back so a test can read `defaultPrevented`: jsdom does not insert the
   * newline itself, so "writes a newline" is only ever observable as the default being left alone.
   */
  const pressEnter = async (h: Harness, mods: KeyboardEventInit = {}): Promise<KeyboardEvent> => {
    const win = h.doc.defaultView as Window & typeof globalThis;
    const ev = new win.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...mods,
    });
    h.el('input').dispatchEvent(ev);
    await tick();
    return ev;
  };

  /** The composer, ready to send, at whatever width the layout should be decided by. */
  const composing = async (width: number, text: string): Promise<Harness> => {
    const h = await open({ width });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = text;
    return h;
  };

  it('sends on a plain Enter where there is a keyboard to hold Shift on', async () => {
    const h = await composing(1440, 'ship it');

    const ev = await pressEnter(h);

    expect(h.calls.find((c) => c.path === 'api/send')?.body.text).toBe('ship it');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('leaves a plain Enter to write a newline under the narrow-screen layout', async () => {
    // A phone held upright has no Shift key to hold, so this is the one screen where Enter-to-send
    // makes a multi-line prompt impossible to type rather than merely awkward.
    const h = await composing(380, 'first line');

    const ev = await pressEnter(h);

    expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
    expect(ev.defaultPrevented).toBe(false);
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('first line');
  });

  it('leaves Shift-Enter and Alt-Enter to write a newline on a wide screen', async () => {
    for (const mods of [{ shiftKey: true }, { altKey: true }]) {
      const h = await composing(1440, 'first line');

      const ev = await pressEnter(h, mods);

      expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
      expect(ev.defaultPrevented).toBe(false);
    }
  });

  it('sends on Ctrl-Enter and on Cmd-Enter, at either width', async () => {
    for (const width of [1440, 380]) {
      for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
        const h = await composing(width, 'ship it');

        await pressEnter(h, mods);

        expect(h.calls.find((c) => c.path === 'api/send')?.body.text).toBe('ship it');
      }
    }
  });

  it('ignores Enter mid-composition, which is a candidate being chosen and not a send', async () => {
    // Both shortcuts, because on a wide screen the plain Enter is now a send as well — and the
    // keystroke that closes an IME candidate list is the one that would truncate the word.
    for (const mods of [{ isComposing: true }, { ctrlKey: true, isComposing: true }]) {
      const h = await composing(1440, '你好');

      await pressEnter(h, mods as KeyboardEventInit);

      expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
    }
  });

  it('refuses to send nothing', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = '   ';

    await h.click('#composer button[type="submit"]');

    expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
  });

  it('shows the message as soon as it is typed, before the request is answered', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'ship it';

    // Clicked WITHOUT awaiting: the assertion is that the bubble is there before the fetch has
    // resolved, which is the whole of this feature.
    h.doc.querySelector<HTMLElement>('#composer button[type="submit"]')!.click();

    expect(h.painted()).toBe(1);
    const bubble = h.el('log').querySelector('.m');
    expect(bubble?.className).toContain('own');
    expect(bubble?.className).toContain('pending');
    expect(bubble?.textContent).toContain('ship it');

    await tick();
    // Answered: still one message, and no longer dimmed as in flight.
    expect(h.painted()).toBe(1);
    expect(h.el('log').querySelector('.m')?.className).not.toContain('pending');
  });

  it('lets the echo take over the local bubble rather than doubling it', async () => {
    // The node identity is the assertion. Removing the local bubble and painting the server's
    // copy would re-run the fade-in and move the scroll, for a message that has been on screen
    // since it was typed.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'ship it';
    await h.click('#composer button[type="submit"]');
    const before = h.el('log').children[0];
    const nonce = h.calls.find((c) => c.path === 'api/send')?.body.nonce as string;

    await h.emit({ t: 'msg', msg: { ...message('w1', '<div class="raw">ship it</div>', true), nonce } });

    expect(h.painted()).toBe(1);
    expect(h.el('log').children[0]).toBe(before);
    expect(h.el('log').textContent).toContain('ship it');
  });

  it('keeps a message that did not reach the daemon, with something to do about it', async () => {
    // What used to happen instead: the composer was cleared, the POST failed, and a line of note
    // text was all that was left of the prompt. The text IS the message here.
    const h = await open({ status: { 'api/send': 400 } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'a prompt worth not retyping';

    await h.click('#composer button[type="submit"]');

    await until('the failure is drawn', () => h.doc.querySelector('.m.failed') !== null);
    expect(h.el('log').textContent).toContain('a prompt worth not retyping');
    expect(h.el('log').textContent).toContain('Not delivered');
    expect(h.doc.querySelector('[data-retry]')).not.toBeNull();
    expect(h.doc.querySelector('[data-copy]')).not.toBeNull();
    expect(h.doc.querySelector('[data-discard]')).not.toBeNull();
  });

  it('retries under the original nonce, so a request that did land cannot double', async () => {
    const h = await open({ status: { 'api/send': 400 } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'try again';
    await h.click('#composer button[type="submit"]');
    await until('the failure is drawn', () => h.doc.querySelector('.m.failed') !== null);

    h.status['api/send'] = 200;
    await h.click('[data-retry]');

    const sends = h.calls.filter((c) => c.path === 'api/send');
    expect(sends).toHaveLength(2);
    expect(sends[1]?.body.nonce).toBe(sends[0]?.body.nonce);
    expect(h.doc.querySelector('.m.failed')).toBeNull();
  });

  it('copies the text of a failed message, and forgets one that is discarded', async () => {
    const h = await open({ status: { 'api/send': 400 } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'the prompt itself';
    await h.click('#composer button[type="submit"]');
    await until('the failure is drawn', () => h.doc.querySelector('.m.failed') !== null);

    await h.click('[data-copy]');
    expect(h.clipboard).toEqual(['the prompt itself']);
    expect(h.doc.querySelector('[data-copy]')?.textContent).toBe('Copied');

    await h.click('[data-discard]');
    expect(h.painted()).toBe(0);
  });

  it('keeps a failed message across a reload, and can still retry one that was text alone', async () => {
    // A text-only body is rebuilt from what was written down, nonce and all — so a Retry of one that
    // did land after all is answered as the duplicate it is rather than posted twice.
    const T = 'a1b2c3d4';
    const h = await open({ url: `http://localhost:8787/?t=${T}`, status: { 'api/send': 400 } });
    await h.emit(sync(T, [], [T]));
    (h.el('input') as HTMLTextAreaElement).value = 'do not lose this';
    await h.click('#composer button[type="submit"]');
    await until('the failure is drawn', () => h.doc.querySelector('.m.failed') !== null);
    const nonce = h.calls.find((c) => c.path === 'api/send')?.body.nonce;
    const storage = { aa_unsent: h.window.localStorage.getItem('aa_unsent')! };
    h.window.close();

    const again = await open({ url: `http://localhost:8787/?t=${T}`, idb: h.idb, storage });

    // Before the stream has said anything: it is this browser's, not the daemon's.
    expect(again.doc.querySelector('.m.failed')).not.toBeNull();
    expect(again.el('log').textContent).toContain('do not lose this');
    await again.emit(sync(T, [], [T]));
    expect(again.el('log').textContent).toContain('Not delivered');
    expect(again.doc.querySelector('[data-copy]')).not.toBeNull();
    expect(again.doc.querySelector('[data-discard]')).not.toBeNull();

    await again.click('[data-retry]');
    expect(again.calls.filter((c) => c.path === 'api/send').map((c) => c.body)).toEqual([
      { topic: T, text: 'do not lose this', nonce },
    ]);
    expect(again.doc.querySelector('.m.failed')).toBeNull();
    // The daemon has it now, so the next reload must not offer it again.
    expect(again.window.localStorage.getItem('aa_unsent')).toBeNull();
  });

  it('offers no Retry after a reload for a message that carried a file it no longer has', async () => {
    // The file was base64 in a request body and is deliberately not written down; the text alone
    // would be a different message.
    const T = 'a1b2c3d4';
    const h = await open({ url: `http://localhost:8787/?t=${T}`, status: { 'api/send': 400 } });
    await h.emit(sync(T, [], [T]));
    const file = new h.window.File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
    const ev = new h.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
    h.el('input').dispatchEvent(ev);
    await until('the chip is rendered', () => chipNames(h).length === 1);
    (h.el('input') as HTMLTextAreaElement).value = 'about this screenshot';
    await h.click('#composer button[type="submit"]');
    await until('the failure is drawn', () => h.doc.querySelector('.m.failed') !== null);
    expect(h.doc.querySelector('[data-retry]')).not.toBeNull();
    const storage = { aa_unsent: h.window.localStorage.getItem('aa_unsent')! };
    h.window.close();

    const again = await open({ url: `http://localhost:8787/?t=${T}`, idb: h.idb, storage });
    await again.emit(sync(T, [], [T]));

    expect(again.el('log').textContent).toContain('about this screenshot');
    expect(again.el('log').textContent).toContain('pasted-1.png');
    expect(again.doc.querySelector('[data-retry]')).toBeNull();
    expect(again.doc.querySelector('[data-copy]')).not.toBeNull();
    expect(again.doc.querySelector('[data-discard]')).not.toBeNull();
  });

  it('turns a send nobody answers into a failure, instead of leaving it grey for ever', async () => {
    // A tunnel that took the body and went quiet: no response, no error. fetch has no timeout of
    // its own, so the bubble used to sit in `sending` with nothing armed that could ever change
    // it — no red, no Retry, nothing to wait for and nothing to do.
    const h = await open({ hang: ['api/send'], shortenLong: true });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'is anybody there';
    await h.click('#composer button[type="submit"]');
    expect(h.doc.querySelector('.m.pending')).not.toBeNull();

    await within('the failure is drawn', 5000, () => h.doc.querySelector('.m.failed') !== null);

    expect(h.doc.querySelector('.m.pending')).toBeNull();
    expect(h.doc.querySelector('[data-retry]')).not.toBeNull();
    // A silent attempt is retried like a dropped one — three attempts under ONE nonce, which is
    // what makes that safe if the first had in fact landed — and a line of text gets the floor.
    const sent = h.calls.filter((c) => c.path === 'api/send');
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((c) => c.body.nonce)).size).toBe(1);
    expect(h.longTimers).toEqual([15000, 15000, 15000]);
  });

  it('allows an attachment longer in proportion to its size, and does not start an upload over', async () => {
    // One page sends a line of text and a 20 MB file; a limit that catches the first would cut the
    // second off mid-upload on an ordinary uplink and call that a failure. And an attempt that was
    // given over a minute was carrying an upload: repeating it from byte zero twice more is a
    // quarter of an hour of grey, so it fails once and Retry is one tap.
    const h = await open({ hang: ['api/send'], shortenLong: true });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const big = new h.window.File([new Uint8Array(3_000_000)], 'big.png', { type: 'image/png' });
    const ev = new h.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => big }] },
    });
    h.el('input').dispatchEvent(ev);
    await until('the chip is rendered', () => chipNames(h).length > 0);
    await h.click('#composer button[type="submit"]');

    await within('the failure is drawn', 5000, () => h.doc.querySelector('.m.failed') !== null);

    const sent = h.calls.filter((c) => c.path === 'api/send');
    expect(sent).toHaveLength(1);
    const file = (sent[0]?.body.files as Array<{ name: string; data: string }>)[0]!;
    // Fifteen seconds, plus one more for every 64 KiB of what is being sent.
    expect(h.longTimers).toEqual([Math.round(15000 + (file.name.length + file.data.length) / 65.536)]);
    expect(h.longTimers[0]).toBeGreaterThan(60000);
    expect(h.doc.querySelector('[data-retry]')).not.toBeNull();
  });

  it('reports a body it could not even build as a failure, not as a message still on its way', async () => {
    // JSON.stringify throws on a body too big for the engine to build as one string. That used to
    // escape from the send itself, after the bubble had been marked `sending` and before any
    // promise existed to mark it anything else.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const json = h.window.JSON;
    const real = json.stringify;
    json.stringify = ((v: unknown, ...rest: unknown[]) => {
      if ((v as { text?: string } | null)?.text === 'too big to build') throw new RangeError('Invalid string length');
      return (real as (...a: unknown[]) => string)(v, ...rest);
    }) as typeof JSON.stringify;
    try {
      (h.el('input') as HTMLTextAreaElement).value = 'too big to build';
      await h.click('#composer button[type="submit"]');
      await until('the failure is drawn', () => h.doc.querySelector('.m.failed') !== null);
    } finally {
      json.stringify = real;
    }

    expect(h.doc.querySelector('.m.pending')).toBeNull();
    expect(h.el('log').textContent).toContain('too big to build');
    expect(h.doc.querySelector('[data-copy]')).not.toBeNull();
    expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
  });
});

/**
 * What a connection that goes away mid-send costs, which should be nothing of what was typed.
 *
 * The three ways it used to cost the message, each reproduced before the fix: a reload while the
 * send was still in flight (gone — it was in no store at all); a reload after it had failed (back
 * from the transcript cache, but sorted above the whole topic by the first sync, which on a long
 * topic is as good as gone); and a switch to another topic while it was in flight, after which it
 * failed with no bubble left to turn red. A Cloudflare Access session expiring is the everyday case:
 * every request is redirected to its sign-in page, the send fails, and only a reload gets back in.
 */
describe('webui page: a message the daemon never acknowledged', () => {
  const T = 'a1b2c3d4';
  const at = `http://localhost:8787/?t=${T}`;
  const input = (h: Harness): HTMLTextAreaElement => h.el('input') as HTMLTextAreaElement;
  const unsent = (h: Harness): Record<string, { t: string; x: string; s: string }> | null =>
    JSON.parse(h.window.localStorage.getItem('aa_unsent') ?? 'null');
  const nonceOf = (h: Harness): string => h.calls.find((c) => c.path === 'api/send')?.body.nonce as string;
  /** What is on screen, top to bottom: a message's text, or FAILED for an undelivered one. */
  const order = (h: Harness): string[] =>
    Array.from(h.el('log').querySelectorAll(':scope > .m')).map((n) =>
      n.classList.contains('failed') ? 'FAILED' : (n.querySelector('.b')?.textContent ?? '')
    );

  /** Type, press Send, and close the page with the request still unanswered. */
  const sendAndLeave = async (
    messages: Array<Record<string, unknown>>
  ): Promise<{ nonce: string; idb: IDBFactory | null; storage: Record<string, string> }> => {
    const h = await open({ url: at, hang: ['api/send'] });
    await h.emit(sync(T, messages, [T]));
    await saved();
    input(h).value = 'on its way';
    await h.click('#composer button[type="submit"]');
    expect(h.doc.querySelector('.m.pending')).not.toBeNull();
    const nonce = nonceOf(h);
    // What a reload finds: written down before the request left, not when it settled.
    expect(unsent(h)?.[nonce]).toMatchObject({ t: T, x: 'on its way', s: 'sending' });
    const storage = { aa_unsent: h.window.localStorage.getItem('aa_unsent')! };
    h.window.close();
    return { nonce, idb: h.idb, storage };
  };

  it('writes a message down before the request leaves, and forgets it once the daemon has it', async () => {
    const h = await open({ url: at });
    await h.emit(sync(T, [], [T]));
    input(h).value = 'ship it';

    // Not awaited: the record has to exist while the request is still on its way.
    h.doc.querySelector<HTMLElement>('#composer button[type="submit"]')!.click();
    expect(Object.values(unsent(h) ?? {})).toEqual([expect.objectContaining({ x: 'ship it', s: 'sending' })]);

    await tick();
    expect(unsent(h)).toBeNull();
  });

  it('brings back a send still in flight at a reload, and lets the sync say it arrived', async () => {
    const earlier = message('m1', '<p>earlier</p>');
    const { nonce, idb, storage } = await sendAndLeave([earlier]);

    const h = await open({ url: at, idb, storage });
    // Nothing this page saw can say how that request ended, and it does not pretend to.
    expect(h.el('log').textContent).toContain('on its way');
    expect(h.el('log').textContent).toContain('Not confirmed');

    // The daemon did get it: its ring carries the echo, which takes the bubble over.
    await h.emit(sync(T, [earlier, { ...message('m2', '<div class="raw">on its way</div>', true), nonce }], [T]));
    expect(h.painted()).toBe(2);
    expect(h.doc.querySelector('.m.failed')).toBeNull();
    expect(unsent(h)).toBeNull();
  });

  it('says a send in flight at a reload never arrived when the same daemon has no echo of it', async () => {
    const { nonce, idb, storage } = await sendAndLeave([]);

    const h = await open({ url: at, idb, storage });
    await h.emit(sync(T, [], [T]));

    expect(h.el('log').textContent).toContain('Not delivered');
    expect(unsent(h)?.[nonce]?.s).toBe('failed');
    await h.click('[data-retry]');
    expect(h.calls.find((c) => c.path === 'api/send')?.body).toEqual({ topic: T, text: 'on its way', nonce });
  });

  it('goes on saying it does not know when the daemon has restarted since', async () => {
    // A restarted daemon starts with an empty ring, so the echo being absent proves nothing.
    const { idb, storage } = await sendAndLeave([]);

    const h = await open({ url: at, idb, storage });
    await h.emit(sync(T, [], [T], { epoch: 2, stale: true }));

    expect(h.el('log').textContent).toContain('Not confirmed');
    expect(h.el('log').textContent).not.toContain('Not delivered');
    expect(h.doc.querySelector('[data-retry]')).not.toBeNull();
  });

  it('is settled after a restart too, when a starred topic kept the echo', async () => {
    // The one case a restart used to leave unknowable: the ring that could say went with the old
    // process. A starred topic's kept transcript carries the echo, nonce and run (g) and all.
    const { nonce, idb, storage } = await sendAndLeave([]);

    const h = await open({ url: at, idb, storage });
    await h.emit(sync(T, [{ ...message('m1', '<div class="raw">on its way</div>', true), nonce, g: 1 }], [T], { epoch: 2 }));

    expect(h.painted()).toBe(1);
    expect(h.doc.querySelector('.m.failed')).toBeNull();
    expect(unsent(h)).toBeNull();
  });

  it('keeps a restored failure under the transcript, where the reader lands, not above it', async () => {
    const msgs = [message('m1', '<p>one</p>'), message('m2', '<p>two</p>')];
    const first = await open({ url: at, status: { 'api/send': 400 } });
    await first.emit(sync(T, msgs, [T]));
    input(first).value = 'do not lose this';
    await first.click('#composer button[type="submit"]');
    await until('the failure is drawn', () => first.doc.querySelector('.m.failed') !== null);
    await saved();
    const storage = { aa_unsent: first.window.localStorage.getItem('aa_unsent')! };
    first.window.close();

    const h = await open({ url: at, idb: first.idb, storage });
    await until('the cached transcript is painted', () => h.painted() === 3);
    expect(order(h)).toEqual(['one', 'two', 'FAILED']);

    await h.emit(sync(T, msgs, [T]));
    expect(order(h)).toEqual(['one', 'two', 'FAILED']);
  });

  it('keeps a send that fails after its topic was switched away from', async () => {
    const A = T;
    const B = 'b2c3d4e5';
    const h = await open({ url: at, hang: ['api/send'], shortenLong: true });
    await h.emit(sync(A, [], [A, B]));
    input(h).value = 'sent, then switched away from';
    await h.click('#composer button[type="submit"]');
    const nonce = nonceOf(h);

    await h.click(`[data-topic="${B}"]`);
    await h.emit(sync(B, [], [A, B]));
    expect(h.el('log').textContent).not.toContain('sent, then switched away from');
    await within('the send gives up', 5000, () => unsent(h)?.[nonce]?.s === 'failed');

    await h.click(`[data-topic="${A}"]`);
    expect(h.el('log').textContent).toContain('sent, then switched away from');
    await h.emit(sync(A, [], [A, B]));
    expect(h.doc.querySelector('.m.failed')).not.toBeNull();
    expect(h.doc.querySelector('[data-retry]')).not.toBeNull();
  });

  it('lets a sync claim the local bubble, not only a msg event', async () => {
    // A reconnect the backlog no longer reaches is answered with a full sync, and the echo of a send
    // made just before it is in there rather than in a msg event. It used to leave both on screen.
    const h = await open({ url: at, hang: ['api/send'] });
    await h.emit(sync(T, [], [T]));
    input(h).value = 'ship it';
    await h.click('#composer button[type="submit"]');
    const nonce = nonceOf(h);

    await h.emit(sync(T, [{ ...message('w1', '<div class="raw">ship it</div>', true), nonce }], [T]));

    expect(h.painted()).toBe(1);
    expect(h.doc.querySelector('.m.pending')).toBeNull();
    expect(unsent(h)).toBeNull();
    h.window.close();
  });

  it('forgets an unsent message once it is discarded, and with its topic', async () => {
    const B = 'b2c3d4e5';
    const h = await open({ url: at, status: { 'api/send': 400 } });
    await h.emit(sync(T, [], [T, B]));
    input(h).value = 'first';
    await h.click('#composer button[type="submit"]');
    input(h).value = 'second';
    await h.click('#composer button[type="submit"]');
    await until('both fail', () => h.doc.querySelectorAll('.m.failed').length === 2);
    expect(Object.keys(unsent(h) ?? {})).toHaveLength(2);

    await h.click('[data-discard]');
    expect(Object.values(unsent(h) ?? {}).map((r) => r.x)).toEqual(['second']);

    await h.click(`[data-del="${T}"]`);
    await until('the topic is forgotten', () => unsent(h) === null);
  });

  it('moves a failure an older page kept in the transcript cache into its own store', async () => {
    // Before this store existed a failed message was written into the cache, which no longer
    // carries local messages — so without the move, the next write of the cache would lose it.
    const first = await open({ url: at });
    await first.emit(sync(T, [message('m1', '<p>one</p>')], [T]));
    await saved();
    first.window.close();
    const legacy = {
      id: 'p:oldnonce', _local: 1, _nonce: 'oldnonce', _state: 'failed', _text: 'from an older page', own: true,
      html: '<div class="raw">from an older page</div><div class="files"><span class="chip">a.txt</span></div>',
      at: 1, buttons: [], reactions: [],
    };
    await writeCache(first.idb, T, [...((await first.cached(T)) ?? []), legacy]);

    const h = await open({ url: at, idb: first.idb });
    await until('the failure is restored', () => h.doc.querySelector('.m.failed') !== null);
    expect(unsent(h)?.oldnonce).toMatchObject({ t: T, x: 'from an older page', s: 'failed' });
    await h.emit(sync(T, [message('m1', '<p>one</p>')], [T]));
    await saved();
    expect((await h.cached(T))?.map((m) => m.id)).toEqual(['m1']);
    // It had a file, which nothing kept.
    expect(h.doc.querySelector('[data-retry]')).toBeNull();
    const storage = { aa_unsent: h.window.localStorage.getItem('aa_unsent')! };
    h.window.close();

    const again = await open({ url: at, idb: first.idb, storage });
    await again.emit(sync(T, [message('m1', '<p>one</p>')], [T]));
    expect(again.el('log').textContent).toContain('from an older page');
  });
});

/** Overwrite one topic's cached transcript, the way an older page would have written it. */
function writeCache(idb: IDBFactory | null, topic: string, list: Array<Record<string, unknown>>): Promise<void> {
  if (!idb) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const rq = idb.open('aa_cache', 1);
    rq.onerror = () => reject(rq.error);
    rq.onsuccess = () => {
      const db = rq.result;
      const t = db.transaction('topics', 'readwrite');
      t.objectStore('topics').put({ topic, at: Date.now(), json: JSON.stringify(list) });
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => reject(t.error);
    };
  });
}

/**
 * Stop (beside Send) and the power button (beside the title) — `/stop` and `/kill` on a tap.
 *
 * Both are the typed command and nothing more, so the daemon's side is tested where the commands
 * are (`kill-command.test.ts`, `session-control.test.ts`). What can only go wrong HERE is the page:
 * a control shown when its command has nothing to act on, one that never appears, and a press that
 * throws away the draft in the composer — which is what reusing `send()` as-is would have done.
 */
describe('webui page: stopping the agent', () => {
  /** One topic in the state a test wants, delivered the way the daemon's liveness poll does. */
  const state = (flags: Record<string, boolean>): Record<string, unknown> => ({
    t: 'topics',
    topics: [{ id: 'a1b2c3d4', title: 'Topic a1b2c3d4', lastAt: 1000, msgCount: 0, ...flags }],
  });

  it('offers neither control for a topic with no process and no turn', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    expect(h.el('kill-agent').hidden).toBe(true);
    expect(h.el('stop-turn').hidden).toBe(true);
  });

  it('shows each control only while its command has something to act on', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    // Resident but quiet: a process to end, no turn to stop.
    await h.emit(state({ running: false, live: true }));
    expect(h.el('kill-agent').hidden).toBe(false);
    expect(h.el('stop-turn').hidden).toBe(true);

    // A turn opening arrives as `typing`, not as a topic list — Stop has to follow that too.
    await h.emit({ t: 'typing', on: true });
    expect(h.el('stop-turn').hidden).toBe(false);
    await h.emit({ t: 'typing', on: false });
    expect(h.el('stop-turn').hidden).toBe(true);

    // A question holds its turn open, and /stop is how it is called off.
    await h.emit(state({ running: true, asking: true, live: true }));
    expect(h.el('stop-turn').hidden).toBe(false);

    // Reclaimed, or ended by /kill: the power button goes with the process.
    await h.emit(state({ running: false, live: false }));
    expect(h.el('kill-agent').hidden).toBe(true);
    expect(h.el('stop-turn').hidden).toBe(true);
  });

  it('follows the topic on screen, not whichever topic is busy', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));
    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: 'here', lastAt: 1000, running: false, live: false, msgCount: 0 },
        { id: 'b2c3d4e5', title: 'elsewhere', lastAt: 999, running: true, live: true, msgCount: 0 },
      ],
    });

    expect(h.el('kill-agent').hidden).toBe(true);
    expect(h.el('stop-turn').hidden).toBe(true);
  });

  it('Stop sends /stop for this topic and leaves the draft in the composer', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.emit(state({ running: true, live: true }));
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = 'actually, do it the other way';

    await h.click('#stop-turn');

    const sent = h.calls.filter((c) => c.path === 'api/send');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.text).toBe('/stop');
    expect(sent[0]?.body.topic).toBe('a1b2c3d4');
    // The same retry-safe post a typed message makes.
    expect(typeof sent[0]?.body.nonce).toBe('string');
    expect(input.value).toBe('actually, do it the other way');
    // And the same bubble — the transcript records the command like any other.
    expect(h.el('log').textContent).toContain('/stop');
  });

  it('the power button sends /kill, and nothing else', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.emit(state({ running: false, live: true }));
    (h.el('input') as HTMLTextAreaElement).value = 'draft';

    await h.click('#kill-agent');

    const sent = h.calls.filter((c) => c.path === 'api/send');
    expect(sent.map((c) => c.body.text)).toEqual(['/kill']);
    expect(sent[0]?.body.files).toBeUndefined();
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('draft');
  });
});

describe('webui page: the local transcript cache', () => {
  it('paints a topic from the last visit before the daemon has said anything', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>'), message('m2', '<p>second</p>')], ['a1b2c3d4']));
    await saved();
    expect(await h.cached('a1b2c3d4')).toHaveLength(2);

    // A different page object on the same browser: everything in memory is gone, the database is
    // not. Nothing is emitted down this one's stream at all.
    const again = await open({ url: 'http://localhost:8787/?t=a1b2c3d4', idb: h.idb });

    await until('the cached transcript is painted', () => again.painted() === 2);
    expect(again.el('log').textContent).toContain('first');
    expect(again.skeletons()).toBe(0);
  });

  it('keeps what a restarted daemon has lost, says so, and leaves nothing to click', async () => {
    const withButton = { ...message('m2', '<p>pick one</p>'), buttons: [{ id: 'b:yes', label: 'Yes' }] };
    const first = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await first.emit(sync('a1b2c3d4', [message('m1', '<p>from before</p>'), withButton], ['a1b2c3d4']));
    await saved();

    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4', idb: first.idb });
    await until('the cached transcript is painted', () => h.painted() === 2);

    // The daemon came back: a new generation, an empty ring, and a topic older than the process.
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { epoch: 2, stale: true }));

    expect(h.painted()).toBe(2);
    expect(h.doc.querySelectorAll('#log > .m.hist')).toHaveLength(2);
    expect(h.doc.querySelector('#log > .divider')?.textContent).toContain('before the daemon restarted');
    // The apology is for a room with nothing in it; there is something in this one.
    expect(h.notice()).toBeNull();
    // The process that would answer that button is gone, and the id it names now means nothing.
    expect(h.doc.querySelector('button[data-btn]')).toBeNull();
  });

  it('does not let a restarted daemon reuse an id over a cached message', async () => {
    // Ids are counted per process and start again at w1, so a cached message and a fresh one can
    // both be called m1. Keyed by id alone the reply overwrites the history; keyed by generation
    // they are two messages, which is what they are.
    const first = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await first.emit(sync('a1b2c3d4', [message('m1', '<p>from before</p>')], ['a1b2c3d4']));
    await saved();

    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4', idb: first.idb });
    await until('the cached transcript is painted', () => h.painted() === 1);
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { epoch: 2, stale: true }));

    await h.emit({ t: 'msg', msg: message('m1', '<p>brand new</p>') });

    expect(h.painted()).toBe(2);
    expect(h.el('log').textContent).toContain('from before');
    expect(h.el('log').textContent).toContain('brand new');
  });

  it('takes what a topic kept on the daemon as the history it is, once, beside its own copy', async () => {
    // A topic's transcript survives the restart on the daemon's side and arrives in the
    // sync marked with the run it was said in (g). That is what keys it the way this browser's
    // cache already has it; keyed by the new run instead, every message would be on screen twice.
    const T = 'a1b2c3d4';
    const asked = { ...message('m2', '<p>pick one</p>'), buttons: [{ id: 'b:yes', label: 'Yes' }] };
    const first = await open({ url: `http://localhost:8787/?t=${T}` });
    await first.emit(sync(T, [message('m1', '<p>from before</p>'), asked], [T]));
    await saved();

    const kept = [
      { ...message('m1', '<p>from before</p>'), g: 1 },
      { ...asked, buttons: [], g: 1 },
    ];
    const after = sync(T, [...kept, message('m1', '<p>said since</p>')], [T], { epoch: 2 });
    for (const idb of [first.idb, new IDBFactory()]) {
      // The same browser, with its cache; then one that never saw the topic, such as a phone.
      const h = await open({ url: `http://localhost:8787/?t=${T}`, idb });
      await h.emit(after);

      expect(h.painted()).toBe(3);
      expect(h.doc.querySelectorAll('#log > .m.hist')).toHaveLength(2);
      expect(h.el('log').textContent).toContain('said since');
      const divider = h.doc.querySelector('#log > .divider');
      expect(divider?.textContent).toContain('before the daemon restarted');
      expect(divider?.previousElementSibling?.textContent).toContain('pick one');
      expect(h.doc.querySelector('button[data-btn]')).toBeNull();
      expect(h.notice()).toBeNull();
    }
  });

  it('fills in, from what the daemon kept, the end of a turn this browser never received', async () => {
    // Reported on 2026-10-31: the phone was put down mid-turn, so its cache stops at a tool line
    // still running; the reply finished, and the daemon restarted before the page came back.
    // The kept transcript has the rest, and it has to land in place — after what is cached, in
    // order, with the half-finished line brought up to date rather than drawn a second time.
    const T = 'a1b2c3d4';
    const first = await open({ url: `http://localhost:8787/?t=${T}` });
    await first.emit(sync(T, [message('m1', '<p>a question</p>'), message('m2', '<p>getent …</p>')], [T]));
    await saved();

    const kept = [
      { ...message('m1', '<p>a question</p>'), g: 1 },
      { ...message('m2', '<p>getent ✓</p>'), g: 1 },
      { ...message('m3', '<p>the answer</p>'), g: 1 },
    ];
    const h = await open({ url: `http://localhost:8787/?t=${T}`, idb: first.idb });
    await until('the cached transcript is painted', () => h.painted() === 2);
    await h.emit(sync(T, [...kept, message('m1', '<p>progress?</p>')], [T], { epoch: 2 }));

    expect(h.painted()).toBe(4);
    const hist = [...h.doc.querySelectorAll('#log > .m.hist')].map((n) => n.textContent ?? '');
    expect(hist).toHaveLength(3);
    expect(hist[0]).toContain('a question');
    expect(hist[1]).toContain('getent ✓');
    expect(hist[2]).toContain('the answer');
    expect(h.el('log').textContent).not.toContain('getent …');
    expect(h.doc.querySelector('#log > .divider')?.previousElementSibling?.textContent).toContain('the answer');
    expect(h.el('log').lastElementChild?.textContent).toContain('progress?');
  });

  it('keeps only the tail of a long topic', async () => {
    const many: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 210; i++) many.push(message(`m${i}`, `<p>line ${i}</p>`));
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });

    await h.emit(sync('a1b2c3d4', many, ['a1b2c3d4']));
    await saved();

    const kept = await h.cached('a1b2c3d4');
    expect(kept).toHaveLength(200);
    expect(kept?.[0]?.id).toBe('m10');
    expect(kept?.[199]?.id).toBe('m209');
  });

  it('works on a browser with no IndexedDB at all', async () => {
    // Private windows and old engines both produce one. The cache is the only thing that goes.
    const h = await open({ idb: null });

    await h.emit(sync('a1b2c3d4', [message('m1', '<p>still here</p>')], ['a1b2c3d4']));
    expect(h.painted()).toBe(1);

    (h.el('input') as HTMLTextAreaElement).value = 'and sending still works';
    await h.click('#composer button[type="submit"]');
    expect(h.painted()).toBe(2);
    expect(h.calls.find((c) => c.path === 'api/send')?.body.text).toBe('and sending still works');
  });
});

describe('webui page: pasting', () => {
  /**
   * A `paste` carrying clipboard items.
   *
   * jsdom implements neither `ClipboardEvent` nor `DataTransfer`, so the event is an ordinary
   * one with `clipboardData` defined onto it — which is all the handler reads, and keeps this
   * about the handler rather than about jsdom's coverage of the clipboard API.
   */
  function pasteOf(h: Harness, items: Array<{ kind: string; type: string; file: File | null }>): Event {
    const ev = new h.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: items.map((i) => ({ kind: i.kind, type: i.type, getAsFile: () => i.file })) },
    });
    return ev;
  }

  const image = (h: Harness, name: string, type: string): File =>
    new h.window.File([new Uint8Array([137, 80, 78, 71])], name, { type });

  it('attaches a screenshot pasted into the composer', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    const ev = pasteOf(h, [{ kind: 'file', type: 'image/png', file: image(h, 'image.png', 'image/png') }]);
    h.el('input').dispatchEvent(ev);

    // Swallowed, or the `<img>` the clipboard carries beside the file pastes into the textarea
    // as markup on top of the attachment.
    expect(ev.defaultPrevented).toBe(true);
    await until('the chip is rendered', () => chipNames(h).length > 0);
    expect(chipNames(h)).toEqual(['pasted-1.png']);

    (h.el('input') as HTMLTextAreaElement).value = 'what is this';
    await h.click('#composer button[type="submit"]');

    const sent = h.calls.find((c) => c.path === 'api/send');
    const files = sent?.body.files as Array<Record<string, string>>;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('pasted-1.png');
    expect(files[0]!.mime).toBe('image/png');
    // Base64 with the `data:` prefix cut off, which is what `api/send` accepts.
    expect(files[0]!.data).toBe('iVBORw==');
  });

  it('shows a sent screenshot in the transcript once the echo brings it, and opens it on a tap', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    h.el('input').dispatchEvent(pasteOf(h, [{ kind: 'file', type: 'image/png', file: image(h, 'image.png', 'image/png') }]));
    await until('the chip is rendered', () => chipNames(h).length > 0);
    (h.el('input') as HTMLTextAreaElement).value = 'what is wrong here?';
    await h.click('#composer button[type="submit"]');

    // The local bubble names the file and draws nothing: drawing it would put the whole file into
    // this bubble as a data: URL, and this bubble is what the cache keeps if the send fails.
    const bubble = h.el('log').children[0] as HTMLElement;
    expect(bubble.querySelector('img')).toBeNull();
    expect(bubble.innerHTML).not.toContain('data:');
    expect(bubble.querySelector('.files .chip')?.textContent).toBe('pasted-1.png');

    // The echo, in the shape room.ts renderBody builds it.
    const nonce = h.calls.find((c) => c.path === 'api/send')?.body.nonce as string;
    const html =
      '<div class="raw">what is wrong here?</div>' +
      '<div class="shots"><img class="shot" src="f/0123abcd" alt="pasted-1.png" loading="lazy"></div>' +
      '<div class="files"><span class="chip">pasted-1.png</span></div>';
    await h.emit({ t: 'msg', msg: { ...message('w1', html, true), nonce } });

    expect(h.el('log').children[0]).toBe(bubble);
    expect(bubble.querySelector('img.shot')?.getAttribute('src')).toBe('f/0123abcd');
    await h.click('#log img.shot');
    expect(h.el('lightbox').hidden).toBe(false);
    expect(h.el('lightbox-img').getAttribute('src')).toBe('http://localhost:8787/f/0123abcd');

    // After a restart the file is gone: the frame hides and the name is what is left.
    const img = bubble.querySelector('img.shot') as HTMLImageElement;
    img.dispatchEvent(new h.window.Event('error'));
    expect(img.style.display).toBe('none');
    expect(bubble.querySelector('.files .chip')?.textContent).toBe('pasted-1.png');
  });

  it('gives each paste a name of its own', async () => {
    // Every engine calls a pasted screenshot image.png, so without this two of them are two
    // indistinguishable chips and two attachments the agent cannot tell apart.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    h.el('input').dispatchEvent(pasteOf(h, [{ kind: 'file', type: 'image/png', file: image(h, 'image.png', 'image/png') }]));
    await until('the first chip', () => h.el('chips').children.length === 1);
    h.el('input').dispatchEvent(pasteOf(h, [{ kind: 'file', type: 'image/jpeg', file: image(h, 'image.png', 'image/jpeg') }]));
    await until('the second chip', () => h.el('chips').children.length === 2);

    expect(chipNames(h)).toEqual(['pasted-1.png', 'pasted-2.jpeg']);
  });

  it('leaves an ordinary text paste alone', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    const ev = pasteOf(h, [{ kind: 'string', type: 'text/plain', file: null }]);
    h.el('input').dispatchEvent(ev);

    // Cancelling this one would mean pasting text into the composer no longer works at all.
    expect(ev.defaultPrevented).toBe(false);
    await tick();
    expect(chipNames(h)).toEqual([]);
  });

  it('takes a paste that landed outside the composer', async () => {
    // The textarea is not focused after clicking a topic or a button, and on a phone it is
    // rarely focused at all — a paste that reaches nothing there looks like a broken feature.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    h.doc.body.dispatchEvent(pasteOf(h, [{ kind: 'file', type: 'image/png', file: image(h, 'image.png', 'image/png') }]));

    await until('the chip is rendered', () => chipNames(h).length > 0);
    expect(chipNames(h)).toEqual(['pasted-1.png']);
  });
});

describe('webui page: the file picker', () => {
  /**
   * Pick files through the `+` button.
   *
   * jsdom has no FileList and will not let one be assigned to `picker.files`, so the property is
   * redefined — configurable, because the handler sets `picker.value=''` afterwards and jsdom
   * routes that through the same internal file list.
   */
  const pick = (h: Harness, files: File[]): void => {
    const picker = h.el('picker');
    Object.defineProperty(picker, 'files', { value: files, configurable: true, writable: true });
    picker.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };

  it('takes a document as readily as an image', async () => {
    // The picker carries no `accept`, so the browser offers every file — and nothing downstream
    // narrows that either: `mime.startsWith('image/')` in room.ts only chooses between the
    // `image` and `file` attachment kinds, it does not reject the second one.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    pick(h, [
      new h.window.File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }),
      // Empty type is what a browser reports for an extension it does not recognise.
      new h.window.File(['zipbytes'], 'logs.tar.zst', { type: '' }),
    ]);

    await until('both chips are rendered', () => h.el('chips').children.length === 2);
    expect(chipNames(h)).toEqual([
      'report.pdf',
      'logs.tar.zst',
    ]);

    (h.el('input') as HTMLTextAreaElement).value = 'read these';
    await h.click('#composer button[type="submit"]');

    const files = h.calls.find((c) => c.path === 'api/send')?.body.files as Array<Record<string, string>>;
    expect(files.map((f) => [f.name, f.mime])).toEqual([
      ['report.pdf', 'application/pdf'],
      ['logs.tar.zst', ''],
    ]);
  });
});

/**
 * What is about to be sent can be looked at and taken back. Before, a chip was a name: a pasted
 * screenshot could not be checked before it went, and one pasted by mistake could only be got rid
 * of by sending it.
 */
describe('webui page: attachments in the composer', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';

  /** Paste one picture, the way the clipboard hands one over (see `pasteOf` above). */
  const pasteImage = (h: Harness, type = 'image/png'): void => {
    const file = new h.window.File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type });
    const ev = new h.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'file', type, getAsFile: () => file }] },
    });
    h.el('input').dispatchEvent(ev);
  };
  const thumbs = (h: Harness): HTMLImageElement[] =>
    Array.from(h.el('chips').querySelectorAll<HTMLImageElement>('img.thumb'));
  const removeButton = (h: Harness, name: string): HTMLElement => {
    const b = h.el('chips').querySelector<HTMLElement>(`button[aria-label="Remove ${name}"]`);
    if (!b) throw new Error(`no remove button for ${name}`);
    return b;
  };

  it('shows a pasted screenshot before it is sent, and leaves a document as its name', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    pasteImage(h);
    await until('the chip is rendered', () => chipNames(h).length === 1);

    const [thumb] = thumbs(h);
    // A data: URL, because the page's CSP refuses blob: — an object URL would be a broken frame.
    expect(thumb?.getAttribute('src')).toBe('data:image/png;base64,iVBORw==');
    expect(thumb?.getAttribute('alt')).toBe('pasted-1.png');

    const picker = h.el('picker');
    Object.defineProperty(picker, 'files', {
      value: [new h.window.File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' })],
      configurable: true,
      writable: true,
    });
    picker.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await until('the second chip', () => chipNames(h).length === 2);
    expect(thumbs(h)).toHaveLength(1);
  });

  it('takes one attachment back off, and sends only the rest', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    pasteImage(h);
    await until('the first chip', () => chipNames(h).length === 1);
    pasteImage(h, 'image/jpeg');
    await until('the second chip', () => chipNames(h).length === 2);

    removeButton(h, 'pasted-1.png').click();
    expect(chipNames(h)).toEqual(['pasted-2.jpeg']);

    (h.el('input') as HTMLTextAreaElement).value = 'only the second one';
    await h.click('#composer button[type="submit"]');
    const files = h.calls.find((c) => c.path === 'api/send')?.body.files as Array<Record<string, string>>;
    expect(files.map((f) => f.name)).toEqual(['pasted-2.jpeg']);
    // Exactly the upload's three keys: api/send is .strict(), so anything the chips needed to
    // remember about a file riding along on it would get the whole message refused.
    expect(Object.keys(files[0]!).sort()).toEqual(['data', 'mime', 'name']);
  });

  it('sends nothing at all once the only attachment is removed', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    pasteImage(h);
    await until('the chip is rendered', () => chipNames(h).length === 1);

    removeButton(h, 'pasted-1.png').click();
    await h.click('#composer button[type="submit"]');
    expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
  });

  it('keeps a removed attachment removed across a topic switch', async () => {
    // The draft a topic switch keeps holds the same list the chips draw; a removal that only
    // repainted would come back the moment the topic was left and re-entered.
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    pasteImage(h);
    await until('the chip is rendered', () => chipNames(h).length === 1);
    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);
    expect(chipNames(h)).toEqual(['pasted-1.png']);

    removeButton(h, 'pasted-1.png').click();
    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);
    expect(chipNames(h)).toEqual([]);
  });

  it('opens a thumbnail full-screen when it is tapped', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    pasteImage(h);
    await until('the chip is rendered', () => thumbs(h).length === 1);

    await h.click('#chips img.thumb');
    expect(h.el('lightbox').hidden).toBe(false);
    expect(h.el('lightbox-img').getAttribute('src')).toBe('data:image/png;base64,iVBORw==');
    // Looking is not removing.
    expect(chipNames(h)).toEqual(['pasted-1.png']);
  });

  it('builds a thumbnail once, rather than again on every paste', async () => {
    // The src is the whole file again. Rebuilding every chip per paste re-parses and re-decodes
    // every screenshot already attached — the same node being moved is what proves it was not.
    const h = await open();
    await h.emit(sync(A, [], [A]));
    pasteImage(h);
    await until('the first chip', () => thumbs(h).length === 1);
    const first = thumbs(h)[0];
    pasteImage(h);
    await until('the second chip', () => thumbs(h).length === 2);
    expect(thumbs(h)[0]).toBe(first);
  });

  it('keeps the name of a picture this browser cannot decode, and hides the broken frame', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    pasteImage(h, 'image/heic');
    await until('the chip is rendered', () => thumbs(h).length === 1);

    const [thumb] = thumbs(h);
    thumb!.dispatchEvent(new h.window.Event('error'));
    expect(thumb!.style.display).toBe('none');
    expect(chipNames(h)).toEqual(['pasted-1.heic']);
  });
});

describe('webui page: a screen held upright', () => {
  it('starts with the drawer shut and the keyboard down', async () => {
    const h = await open({ width: 390, height: 844 });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4', 'b2c3d4e5']));

    expect(h.el('sidebar').classList.contains('collapsed')).toBe(true);
    // Off-screen but still laid out: without inert, Tab walks into buttons nobody can see.
    expect(h.el('sidebar').hasAttribute('inert')).toBe(true);
    // The one class the stylesheet shows the backdrop for while the left drawer is out.
    expect(h.el('app').classList.contains('sb-open')).toBe(false);
    expect(h.el('expand-sidebar').hidden).toBe(false);
    // Focusing on open would put the keyboard over half a portrait viewport before a word of
    // the conversation had been read.
    expect(h.doc.activeElement).not.toBe(h.el('input'));
    // The chat is still rendered underneath — the drawer is not the landing screen.
    expect(h.painted()).toBe(1);
  });

  it('opens the drawer with a backdrop, and the backdrop shuts it', async () => {
    const h = await open({ width: 390, height: 844 });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.click('#expand-sidebar');
    expect(h.el('sidebar').classList.contains('collapsed')).toBe(false);
    expect(h.el('sidebar').hasAttribute('inert')).toBe(false);
    expect(h.el('app').classList.contains('sb-open')).toBe(true);

    // The only other way out is the collapse button, which the open drawer covers the chat to show.
    await h.click('#backdrop');
    expect(h.el('sidebar').classList.contains('collapsed')).toBe(true);
    expect(h.el('sidebar').hasAttribute('inert')).toBe(true);
    expect(h.el('app').classList.contains('sb-open')).toBe(false);
  });

  it('gets out of the way once a topic has been picked', async () => {
    const h = await open({ width: 390, height: 844 });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));
    await h.click('#expand-sidebar');

    await h.click('[data-topic="b2c3d4e5"]');

    expect(h.el('sidebar').classList.contains('collapsed')).toBe(true);
    expect(h.el('app').classList.contains('sb-open')).toBe(false);
  });

  it('leaves a wide screen alone', async () => {
    const h = await open({ width: 1440, height: 900 });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));

    expect(h.el('sidebar').classList.contains('collapsed')).toBe(false);
    expect(h.doc.activeElement).toBe(h.el('input'));

    await h.click('[data-topic="b2c3d4e5"]');
    // A column, not a drawer: picking a topic has no reason to collapse it.
    expect(h.el('sidebar').classList.contains('collapsed')).toBe(false);
  });

  it('keeps the backdrop out of the way of a wide screen', async () => {
    // It is `position:fixed; inset:0`, so if the base rule ever stopped hiding it the whole
    // desktop UI would be behind an invisible sheet that swallows every click.
    const h = await open({ width: 1440, height: 900 });
    expect(h.window.getComputedStyle(h.el('backdrop')).display).toBe('none');
  });
});

describe('webui page: the narrow-screen stylesheet', () => {
  /**
   * The text of the one `@media(max-width:640px)` block, sliced out of the served CSS.
   *
   * Read as text rather than through `document.styleSheets`, for two reasons. jsdom does not
   * evaluate `@media` at all, so the CSSOM could never answer "does this rule apply" anyway —
   * and its CSS parser silently DROPS declarations it cannot parse while normalizing selectors
   * as it likes. Under jsdom 27 that made `#bar`'s `calc(… + env(safe-area-inset-bottom))`
   * vanish and `html,body` come back under a different key, failing assertions about rules that
   * were perfectly correct. Slicing keeps this about the stylesheet the daemon serves rather
   * than about one parser's coverage of modern CSS.
   */
  const blockAt = (start: string): string => {
    const html = renderPage('Chat', false);
    const at = html.indexOf(start);
    if (at < 0) throw new Error(`there is no ${start} block in the stylesheet`);
    let depth = 0;
    for (let i = html.indexOf('{', at); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
    }
    throw new Error(`the ${start} block is never closed`);
  };
  const narrowBlock = (): string => blockAt('@media(max-width:640px){');

  it('turns the sidebar into a drawer that clears the screen when shut', () => {
    const css = narrowBlock();
    expect(css).toContain('#sidebar{position:fixed');
    // A transform, not a fixed -240px offset: the drawer is 88vw wide here and would still
    // leave a strip on screen.
    expect(css).toContain('#sidebar.collapsed{margin:0;transform:translateX(-100%)}');
    expect(css).toContain('#app.sb-open #backdrop{display:block}');
    // The same drawer width the scheduled panel has, so the two edges are one component.
    expect(css).toContain('width:min(88vw,380px)');
  });

  it('slides the scheduled panel in from the right instead of covering the screen', () => {
    // The old rule made the panel the whole phone screen. It is now the same drawer the topic
    // sidebar is, on the other edge: the overlay rule (below 1024px) keeps it laid out and moves
    // it off-screen, because display:none has nothing to animate.
    expect(narrowBlock()).not.toContain('#app.sched #schedules{width:100%');
    const overlay = blockAt('@media(max-width:1023px){');
    expect(overlay).toContain('#schedules{position:fixed');
    expect(overlay).toContain('width:min(88vw,380px)');
    expect(overlay).toContain('#schedules.collapsed{margin:0;transform:translateX(100%)}');
    expect(overlay).toContain('#app.sched-open #backdrop{display:block}');
  });

  it('measures height in dvh, which is the viewport the URL bar has left', () => {
    const css = narrowBlock();
    expect(css).toContain('html,body{height:100vh;height:100dvh}');
    expect(css).toContain('#input{max-height:30dvh}');
  });

  it('keeps fields at 16px so Safari does not zoom in and stay there', () => {
    expect(narrowBlock()).toContain('#input,#secret{font-size:16px}');
  });

  it('pads the send row past the home indicator', () => {
    expect(narrowBlock()).toContain('env(safe-area-inset-bottom');
  });

  it('splits the composer into two rows on narrow screens with full-width input and action buttons', () => {
    const css = narrowBlock();
    expect(css).toContain('#row{flex-wrap:wrap}');
    expect(css).toContain('#input{width:100%;flex:0 0 100%}');
    expect(css).toContain('#row button[type="submit"]{margin-left:auto}');
    expect(css).toContain('#row #stop-turn:not([hidden]){margin-left:auto}');
    expect(css).toContain('#row #stop-turn:not([hidden])+button[type="submit"]{margin-left:0}');
  });

  it('structures the composer with input first and buttons grouped for two-row mobile flow', () => {
    const html = renderPage('Chat', false);
    const rowMatch = html.match(/<div id="row">([\s\S]*?)<\/div>/);
    expect(rowMatch).not.toBeNull();
    const rowContent = rowMatch![1]!;
    expect(rowContent).toMatch(/^\s*<textarea id="input"/);
    expect(rowContent).toContain('<button type="button" id="attach"');
    expect(rowContent).toContain('<button type="button" id="mic"');
    expect(rowContent).toContain('<button type="button" id="stop-turn"');
    expect(rowContent).toContain('<button type="submit"');
  });

  it('gives the attachment × a target a finger can hit', () => {
    expect(narrowBlock()).toContain('.chip-x{min-width:44px;min-height:44px}');
  });

  it('enlarges #clear-topics SVG on phones to match header glyphs', () => {
    const css = narrowBlock();
    expect(css).toContain('#clear-topics svg{width:18px;height:18px}');
  });

  it('gives the drawer toggle a finger-sized target', () => {
    const css = narrowBlock();
    // At the inherited .btn-icon size this is a 26x21 box, and it is the only way back to the
    // topic list once the drawer is shut. Measured in Chromium at 390px: 44x44, header 42->49.
    expect(css).toMatch(/#expand-sidebar\{[^}]*min-width:44px/);
    expect(css).toMatch(/#expand-sidebar\{[^}]*height:44px/);
    // The rule sets `display`, which is only safe because of the page-wide `!important` guard.
    expect(renderPage('Chat', false)).toContain('[hidden]{display:none!important}');
  });

  it('gives the power button the same finger-sized target', () => {
    // It sets `display` too (inline-flex, to centre the glyph), under the same `!important` guard
    // the drawer toggle relies on — without it the button would show for a topic with no process.
    const css = narrowBlock();
    expect(css).toMatch(/#kill-agent\{[^}]*min-width:44px/);
    expect(css).toMatch(/#kill-agent\{[^}]*height:44px/);
  });

  it("gives the file reader's close button, and Download, a finger-sized target", () => {
    // Measured in Chromium at 390px: the close button was 35x30 and the old Preview 22px tall
    // before this; 44x44 and 33px after (project-scripts/talkcode-file-reader/e2e.mts).
    const css = narrowBlock();
    expect(css).toMatch(/#reader-close\{[^}]*min-width:44px/);
    expect(css).toMatch(/#reader-close\{[^}]*height:44px/);
    expect(css).toContain('.files .view{padding:6px 12px}');
    // A margin all round, so the reader still reads as a window rather than a page on a phone.
    expect(css).toContain('#reader{padding:8px}');
  });

  it("gives the idle-agents dialog's answers a finger-sized target", () => {
    expect(narrowBlock()).toContain('.idle-acts button{min-height:44px;padding:0 16px}');
  });

  it('scopes all of that to the narrow screen and nothing else', () => {
    // The point of slicing the block rather than searching the document: these rules must be
    // INSIDE it. A drawer and 16px fields applied unconditionally would wreck the desktop
    // layout, and an assertion against the whole stylesheet would not notice.
    const css = narrowBlock();
    expect(css.startsWith('@media(max-width:640px){')).toBe(true);
    expect(css.endsWith('}')).toBe(true);
    expect(css.slice('@media'.length)).not.toContain('@media');
  });
});

describe('webui page: the row buttons that only a pointer can reveal', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';

  /**
   * The `@media(hover:hover)` block, as text, for the reasons `narrowBlock` gives — and one more:
   * what is being pinned is a layout (whether two buttons take up room in a row), and jsdom has no
   * layout at all. The widths were measured in Chromium (see the README).
   */
  const hoverBlock = (): string => {
    const html = renderPage('Chat', false);
    const at = html.indexOf('@media(hover:hover){');
    if (at < 0) throw new Error('there is no hover block in the stylesheet');
    let depth = 0;
    for (let i = html.indexOf('{', at); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
    }
    throw new Error('the hover block is never closed');
  };

  it('keeps the star and the × together in one box, and marks the starred rows', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'plain', lastAt: 1000, msgCount: 0 },
        { id: B, title: 'kept', lastAt: 999, msgCount: 0, starred: true },
      ],
    });

    for (const id of [A, B]) {
      const acts = h.doc.querySelector(`[data-topic="${id}"] .topic-acts`);
      expect(acts?.querySelector(`[data-star="${id}"]`)).not.toBeNull();
      expect(acts?.querySelector(`[data-del="${id}"]`)).not.toBeNull();
    }
    // What the stylesheet keys a starred row's resting layout on.
    expect(h.doc.querySelector(`[data-topic="${B}"]`)?.classList.contains('starred')).toBe(true);
    expect(h.doc.querySelector(`[data-topic="${A}"]`)?.classList.contains('starred')).toBe(false);

    // Starring repaints at once, so the class follows the click rather than the broadcast.
    await h.click(`[data-star="${A}"]`);
    expect(h.doc.querySelector(`[data-topic="${A}"]`)?.classList.contains('starred')).toBe(true);
  });

  it('floats the buttons over the row on a pointer device instead of reserving room for them', () => {
    // The bug: opacity:0 buttons that still sat in the row, so every title was cut short in front
    // of an empty strip. Out of the layout, and lit only under the pointer or keyboard focus.
    const css = hoverBlock();
    expect(css).toContain('.topic-acts{position:absolute;');
    expect(css).toContain('opacity:0;pointer-events:none');
    expect(css).toContain('#topics .topic-item:hover .topic-acts,#topics .topic-item:focus-within .topic-acts{opacity:1;pointer-events:auto}');
    // The fade has to end in the row's own colour, or it draws a band across the title.
    expect(css).toContain('linear-gradient(90deg,transparent,var(--row-bg) 18px)');
  });

  it('puts a starred row' + "'s lit star back in the layout, and drops its hidden × from it", () => {
    const css = hoverBlock();
    expect(css).toContain('#topics .topic-item.starred:not(:hover):not(:focus-within) .topic-acts{position:static;');
    expect(css).toContain('#topics .topic-item.starred:not(:hover):not(:focus-within) .topic-del{display:none}');
  });

  it('leaves a touch screen' + "'s rows as they were: no hover, so the buttons stay in the row", () => {
    const html = renderPage('Chat', false);
    const block = hoverBlock();
    // Outside the hover block the box is an ordinary member of the row.
    const outside = html.replace(block, '');
    expect(outside).toContain('.topic-acts{display:flex;align-items:center;gap:8px;flex-shrink:0}');
    expect(outside).not.toMatch(/\.topic-acts\{[^}]*position:absolute/);
    expect(block.slice('@media'.length)).not.toContain('@media');
  });
});

describe('webui page: the terminal window', () => {
  /** Every mounted terminal, whether or not it is the one on screen. */
  const frames = (h: { doc: Document }): HTMLIFrameElement[] =>
    [...h.doc.querySelectorAll<HTMLIFrameElement>('#term-frames iframe')];
  /** The one currently shown. Absence is a fact worth asserting: mounted ≠ visible now. */
  const shown = (h: { doc: Document }): HTMLIFrameElement | null =>
    h.doc.querySelector<HTMLIFrameElement>('#term-frames iframe.on');
  const srcOf = (h: { doc: Document }): string | null => shown(h)?.getAttribute('src') ?? null;

  it('offers nothing at all when the daemon serves no terminal', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hi</p>')], ['a1b2c3d4']));

    expect(h.el('term-toggle').hidden).toBe(true);
    expect(frames(h)).toHaveLength(0);
    // And clicking it anyway — which a curious person can do from the console — changes nothing.
    await h.click('#term-toggle');
    expect(frames(h)).toHaveLength(0);
    expect(h.el('chat').className).not.toContain('term');
  });

  it('connects to ttyd only once a window is opened', async () => {
    // The whole point of mounting on demand: a page that never opens the terminal must never
    // open a socket to it, whether or not the feature is on.
    const h = await open({ terminal: true });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hi</p>')], ['a1b2c3d4']));

    expect(h.el('term-toggle').hidden).toBe(false);
    expect(frames(h)).toHaveLength(0);

    await h.click('#term-toggle');
    expect(srcOf(h)).toBe('term/?arg=a1b2c3d4');
    expect(h.el('chat').className).toContain('term');
    // The transcript is still there underneath, not thrown away — going back is a class flip.
    expect(h.painted()).toBe(1);
  });

  it('puts the window in the URL, and comes back into it on reload', async () => {
    const h = await open({ terminal: true });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.click('#term-toggle');
    expect(h.window.location.search).toBe('?t=a1b2c3d4&v=term');

    const again = await open({ terminal: true, url: 'http://localhost:8787/?t=a1b2c3d4&v=term' });
    await again.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    expect(srcOf(again)).toBe('term/?arg=a1b2c3d4');
    expect(again.el('chat').className).toContain('term');
  });

  it('waits for a topic before pointing a terminal at one', async () => {
    // A first visit has no ?t= at all — the daemon picks the room and says so in the sync. Until
    // then there is nothing to name in the URL, so the window is asked for but not yet built.
    const h = await open({ terminal: true, url: 'http://localhost:8787/?v=term' });
    expect(frames(h)).toHaveLength(0);

    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    expect(srcOf(h)).toBe('term/?arg=a1b2c3d4');
  });

  it('minimizes to the chat without dropping the connection', async () => {
    // The difference between this and the old pane, and the reason the window exists: what is
    // running in there keeps running AND stays attached, so coming back is a repaint rather
    // than a reconnect. A dropped iframe would also put out the switcher's marker, which is
    // fed by the connection.
    const h = await open({ terminal: true });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.click('#term-toggle');
    const mounted = shown(h);
    expect(mounted).not.toBeNull();

    await h.click('#term-min');
    expect(h.el('chat').className).not.toContain('term');
    expect(h.window.location.search).toBe('?t=a1b2c3d4');
    expect(frames(h)).toHaveLength(1);
    expect(shown(h)).toBeNull();

    // Back in, and it is the same element — not a second connection to the same session.
    await h.click('#term-toggle');
    expect(shown(h)).toBe(mounted);
  });

  it('keeps one window per topic, each attached across a switch', async () => {
    // A single window following the topic would hang up on the one being left, which both
    // surprises (the terminal you minimized is gone) and makes the switcher's marker pointless:
    // at most one topic could ever be lit.
    const h = await open({ terminal: true, replies: {} });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));
    await h.click('#term-toggle');
    expect(srcOf(h)).toBe('term/?arg=a1b2c3d4');

    await h.click('[data-topic="b2c3d4e5"]');
    // The other topic has no window, so switching lands in its chat rather than opening one.
    expect(h.el('chat').className).not.toContain('term');
    expect(h.window.location.search).toBe('?t=b2c3d4e5');
    expect(frames(h)).toHaveLength(1);

    await h.click('#term-toggle');
    expect(srcOf(h)).toBe('term/?arg=b2c3d4e5');
    expect(frames(h)).toHaveLength(2);

    // And the first one was never unmounted, so its session is still attached.
    await h.click('[data-topic="a1b2c3d4"]');
    expect(srcOf(h)).toBe('term/?arg=a1b2c3d4');
    expect(frames(h)).toHaveLength(2);
  });

  it('has no close button unless the daemon can end a session', async () => {
    // Nothing here could end one, so the control that claims to does not exist. The alternative
    // — a close that only hides — is the same word meaning two different things on two
    // deployments.
    const h = await open({ terminal: true });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.click('#term-toggle');
    expect(h.el('term-end').hidden).toBe(true);
    expect(h.el('term-min').hidden).toBe(false);
  });

  it('ends the session on close, once confirmed', async () => {
    const h = await open({ terminal: true, terminalEnd: true });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.click('#term-toggle');
    expect(h.el('term-end').hidden).toBe(false);

    await h.click('#term-end');
    expect(h.calls).toContainEqual({ path: 'api/terminal/end', body: { topic: 'a1b2c3d4' } });
    // Unmounted only after the server said it worked — see below for the refusal.
    expect(frames(h)).toHaveLength(0);
    expect(h.el('chat').className).not.toContain('term');
    expect(h.window.location.search).toBe('?t=a1b2c3d4');
  });

  it('asks before ending, and does nothing at all when the answer is no', async () => {
    const h = await open({ terminal: true, terminalEnd: true, confirm: false });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.click('#term-toggle');

    await h.click('#term-end');
    expect(h.calls.filter((c) => c.path === 'api/terminal/end')).toHaveLength(0);
    expect(frames(h)).toHaveLength(1);
    expect(h.el('chat').className).toContain('term');
  });

  it('keeps the window when the daemon refuses to end the session', async () => {
    // The one outcome nobody could explain from the screen is a closed window over a session
    // that is still alive — so a refusal says so and leaves everything where it was.
    const h = await open({
      terminal: true,
      terminalEnd: true,
      status: { 'api/terminal/end': 500 },
      replies: { 'api/terminal/end': { error: 'could not end the terminal session: boom' } },
    });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.click('#term-toggle');

    await h.click('#term-end');
    await tick();
    expect(h.alerts.join('\n')).toContain('boom');
    expect(frames(h)).toHaveLength(1);
    expect(h.el('chat').className).toContain('term');
  });

  it('marks the topics a terminal is attached to', async () => {
    // Fed by the daemon's own count of live terminal connections, not by what this page has
    // open — so a terminal opened on a phone marks the row on a laptop too.
    const h = await open({ terminal: true });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));
    expect(h.doc.querySelectorAll('.topic-term')).toHaveLength(0);

    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: 'One', lastAt: 1000, running: false, msgCount: 0, term: true },
        { id: 'b2c3d4e5', title: 'Two', lastAt: 999, running: false, msgCount: 0, term: false },
      ],
    });
    const marked = [...h.doc.querySelectorAll('.topic-item')].filter((row) => row.querySelector('.topic-term'));
    expect(marked).toHaveLength(1);
    expect(marked[0]?.getAttribute('data-topic')).toBe('a1b2c3d4');
  });

  it('unmounts a deleted topic terminal', async () => {
    // The row is gone, so the window has nothing left to belong to. It is only the window: the
    // session outlives this exactly as it outlives a closed tab.
    const h = await open({ terminal: true, replies: {} });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));
    await h.click('#term-toggle');
    expect(frames(h)).toHaveLength(1);

    await h.click('[data-del="a1b2c3d4"]');
    await tick();
    expect(frames(h)).toHaveLength(0);
  });
});

/**
 * The voice-message button.
 *
 * What makes a recording a voice message is that it is sent ALONE: the daemon transcribes a message
 * that is audio and nothing else, and reads audio with a caption as a file (core/voice.ts). So the
 * load-bearing assertions are that stopping sends the recording by itself, and that whatever was
 * half-typed in the composer is neither sent with it nor lost.
 */
describe('webui page: recording a voice message', () => {
  const recording = async (mic: { types: string[]; deny?: boolean }): Promise<Harness> => {
    const h = await open({ mic });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    return h;
  };
  const sends = (h: Harness) => h.calls.filter((c) => c.path === 'api/send');

  it('is hidden where the browser cannot record', async () => {
    const h = await open();
    expect(h.el('mic').hidden).toBe(true);
  });

  it('records, and sends the recording on its own the moment it stops', async () => {
    const h = await recording({ types: ['audio/webm;codecs=opus'] });
    expect(h.el('mic').hidden).toBe(false);
    await h.click('#mic');
    await tick();
    expect(h.recorders).toHaveLength(1);
    expect(h.recorders[0]!.mimeType).toBe('audio/webm;codecs=opus');
    expect(h.el('mic').classList.contains('rec')).toBe(true);

    h.recorders[0]!.feed('pretend-opus');
    await h.click('#mic');
    await until('the recording is sent', () => sends(h).length === 1);

    const body = sends(h)[0]!.body as { text: string; files: Array<{ name: string; mime: string; data: string }> };
    expect(body.text).toBe('');
    expect(body.files).toHaveLength(1);
    // The container, without the codec parameter: that is what the daemon sniffs and types.
    expect(body.files[0]).toMatchObject({ name: 'voice-1.webm', mime: 'audio/webm' });
    expect(atob(body.files[0]!.data)).toBe('pretend-opus');
    expect(h.recorders[0]!.tracksStopped()).toBe(true); // the microphone is let go
    expect(h.el('mic').classList.contains('rec')).toBe(false);
  });

  it('leaves a half-typed draft in the composer, unsent', async () => {
    const h = await recording({ types: ['audio/webm;codecs=opus'] });
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = 'draft I have not sent';
    await h.click('#mic');
    await tick();
    h.recorders[0]!.feed('x');
    await h.click('#mic');
    await until('the recording is sent', () => sends(h).length === 1);
    expect((sends(h)[0]!.body as { text: string }).text).toBe('');
    expect(input.value).toBe('draft I have not sent');
  });

  it('prefers Ogg where the browser offers it, and names Safari’s MP4 as m4a', async () => {
    const ogg = await recording({ types: ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'] });
    await ogg.click('#mic');
    await tick();
    expect(ogg.recorders[0]!.mimeType).toBe('audio/ogg;codecs=opus');

    const safari = await recording({ types: ['audio/mp4'] });
    await safari.click('#mic');
    await tick();
    safari.recorders[0]!.feed('aac');
    await safari.click('#mic');
    await until('the recording is sent', () => sends(safari).length === 1);
    expect((sends(safari)[0]!.body as { files: Array<{ name: string }> }).files[0]!.name).toBe('voice-1.m4a');
  });

  it('Esc throws the recording away and sends nothing', async () => {
    const h = await recording({ types: ['audio/webm;codecs=opus'] });
    await h.click('#mic');
    await tick();
    h.recorders[0]!.feed('never mind');
    const win = h.doc.defaultView as Window & typeof globalThis;
    h.doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    await tick();
    expect(sends(h)).toHaveLength(0);
    expect(h.recorders[0]!.tracksStopped()).toBe(true);
    expect(h.el('mic').classList.contains('rec')).toBe(false);
  });

  it('says why when the microphone is refused, instead of doing nothing', async () => {
    const h = await recording({ types: ['audio/webm;codecs=opus'], deny: true });
    await h.click('#mic');
    await tick();
    expect(h.el('note').textContent).toContain('Could not record: Permission denied');
    expect(h.recorders).toHaveLength(0);
  });
});

describe('webui page: the model switch in the status line', () => {
  const T = 'a1b2c3d4';
  const OTHER = 'b2c3d4e5';
  const OC = { agent: 'oc@p', model: 'opencode/glm-5', effort: 'high' };
  const LIST = {
    ok: true,
    agent: 'oc@p',
    current: 'opencode/glm-5',
    configured: 'opencode/big-pickle',
    options: [
      { value: 'opencode/big-pickle', name: 'Big Pickle' },
      { value: 'opencode/glm-5', name: 'GLM-5' },
      ...Array.from({ length: 10 }, (_, i) => ({ value: `newapi/model-${i}`, name: `Model ${i}` })),
      { value: 'newapi/kimi-k3', name: 'Kimi K3' },
    ],
  };
  const URL_T = `api/models?t=${T}`;
  const chip = (h: Harness) => h.doc.querySelector('#status .st-model') as HTMLButtonElement | null;
  const pop = (h: Harness) => h.el('model-pop');
  const rows = (h: Harness) => Array.from(h.doc.querySelectorAll('#mp-list .mp-opt')) as HTMLButtonElement[];

  async function ready(o: Parameters<typeof open>[0] = {}): Promise<Harness> {
    const h = await open({ ...o, replies: { [URL_T]: LIST, 'api/models': { ok: true, model: 'newapi/kimi-k3', text: 'Model set to `newapi/kimi-k3` for this conversation.' }, ...(o.replies ?? {}) } });
    await h.emit(sync(T, [message('m1', '<p>hi</p>')], [T, OTHER]));
    await h.emit({ t: 'status', status: OC });
    return h;
  }

  it('makes the model in the status line a button, without changing what the line says', async () => {
    const h = await ready();
    expect(chip(h)?.textContent).toBe('opencode/glm-5');
    expect(h.el('status').textContent).toContain('oc@p · opencode/glm-5 · high');
    expect(chip(h)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the list the agent offers, with the one in use ticked and the default marked', async () => {
    const h = await ready();
    await h.click('#status .st-model');
    expect(pop(h).hidden).toBe(false);
    // A tap on the switch is not a tap on the line: it does not open the line's details.
    expect(h.el('status').classList.contains('open')).toBe(false);
    expect(h.calls.find((c) => c.path === URL_T)).toBeTruthy();
    await tick();
    expect(h.el('mp-agent').textContent).toBe('oc@p');
    expect(rows(h)).toHaveLength(13);
    const on = rows(h).find((r) => r.classList.contains('on'));
    expect(on?.getAttribute('data-v')).toBe('opencode/glm-5');
    expect(on?.getAttribute('aria-selected')).toBe('true');
    const def = rows(h).find((r) => r.querySelector('.mp-tag'));
    expect(def?.getAttribute('data-v')).toBe('opencode/big-pickle');
    expect(def?.querySelector('.mp-n')?.textContent).toBe('Big Pickle');
    expect(chip(h)?.getAttribute('aria-expanded')).toBe('true');
  });

  it('says it is asking while a cold agent starts', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const h = await ready({ held: { [URL_T]: held } });
    await h.click('#status .st-model');
    expect(h.el('mp-list').textContent).toContain('Asking the agent for its models');
    expect(h.el('mp-list').querySelector('.set-spin')).not.toBeNull();
    release();
    await tick();
    await tick();
    expect(rows(h)).toHaveLength(13);
  });

  it('filters a long list as it is typed into', async () => {
    const h = await ready();
    await h.click('#status .st-model');
    await tick();
    expect(h.el('mp-filter').hidden).toBe(false);
    const f = h.el('mp-filter') as HTMLInputElement;
    f.value = 'kimi';
    f.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(rows(h).filter((r) => !r.hidden).map((r) => r.getAttribute('data-v'))).toEqual(['newapi/kimi-k3']);
    // By name too.
    f.value = 'pickle';
    f.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(rows(h).filter((r) => !r.hidden).map((r) => r.getAttribute('data-v'))).toEqual(['opencode/big-pickle']);
  });

  it('switches with a tap, as /model does, and the line says the new model at once', async () => {
    const h = await ready();
    await h.click('#status .st-model');
    await tick();
    await h.click('#mp-list .mp-opt[data-v="newapi/kimi-k3"]');
    await tick();
    expect(h.calls.find((c) => c.path === 'api/models')?.body).toEqual({ topic: T, value: 'newapi/kimi-k3' });
    expect(pop(h).hidden).toBe(true);
    expect(chip(h)?.textContent).toBe('newapi/kimi-k3');
    // /model's own sentence, as plain text.
    expect(h.el('note').textContent).toBe('Model set to newapi/kimi-k3 for this conversation.');
  });

  it('keeps the list open with /model’s reason when the switch is refused', async () => {
    const h = await ready({
      status: { 'api/models': 409 },
      replies: { 'api/models': { ok: false, text: '`newapi/kimi-k3` is no longer offered by this agent. Run /model again for the current list.' } },
    });
    await h.click('#status .st-model');
    await tick();
    await h.click('#mp-list .mp-opt[data-v="newapi/kimi-k3"]');
    await tick();
    expect(pop(h).hidden).toBe(false);
    const err = h.el('mp-list').querySelector('.mp-msg.err');
    expect(err?.innerHTML).toContain('<code>newapi/kimi-k3</code> is no longer offered');
    expect(chip(h)?.textContent).toBe('opencode/glm-5');
  });

  it('says why there is no list for a harness that offers none', async () => {
    const h = await ready({ replies: { [URL_T]: { ok: false, agent: 'cbc@p', reason: 'none', text: 'This agent offers no model selector.' } } });
    await h.click('#status .st-model');
    await tick();
    expect(rows(h)).toHaveLength(0);
    expect(h.el('mp-list').textContent).toContain('This agent offers no model selector.');
    expect(h.el('mp-agent').textContent).toBe('cbc@p');
  });

  it('says so when the list cannot be fetched, rather than spinning for ever', async () => {
    const h = await ready({ hang: [URL_T], shortenLong: true });
    await h.click('#status .st-model');
    await new Promise((r) => setTimeout(r, 120));
    expect(h.longTimers).toContain(45000);
    expect(h.el('mp-list').textContent).toContain('Could not reach the daemon for the list');
  });

  it('closes on Escape, on the ×, on a click outside, and with the topic', async () => {
    const h = await ready();
    const shut = () => pop(h).hidden;
    await h.click('#status .st-model');
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shut()).toBe(true);
    await h.click('#status .st-model');
    await h.click('#mp-close');
    expect(shut()).toBe(true);
    await h.click('#status .st-model');
    await h.click('#log');
    expect(shut()).toBe(true);
    await h.click('#status .st-model');
    expect(shut()).toBe(false);
    await h.click('[data-topic="' + OTHER + '"]');
    expect(shut()).toBe(true);
  });

  it('drops a list that arrives after the switch was closed', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const h = await ready({ held: { [URL_T]: held } });
    await h.click('#status .st-model');
    await h.click('#mp-close');
    release();
    await tick();
    await tick();
    expect(pop(h).hidden).toBe(true);
    expect(rows(h)).toHaveLength(0);
  });

  it('offers the switch in a topic with a conversation but no status yet, and not in a new one', async () => {
    const h = await open({ replies: { [URL_T]: LIST } });
    await h.emit(sync(T, [message('m1', '<p>hi</p>')], [T]));
    expect(h.el('status').hidden).toBe(false);
    expect(chip(h)?.textContent).toBe('Model');
    // A new topic offers its agents instead; the switch would commit it to the default one.
    await h.emit(sync(T, [], [T], { agents: { groups: [{ name: '', agents: [{ id: 'oc@p', kind: 'OpenCode' }] }], current: 'oc@p' } }));
    expect(chip(h)).toBeNull();
  });

  it('offers the switch as soon as an agent is chosen, before the first message and its status', async () => {
    // Reported 2026-11-05: the switch waited on the sync's snapshot of the empty room, which no
    // event after the tap replaces, so it stayed away until the first reply reported a status —
    // too late to choose the model that first message goes to.
    const agents = { groups: [{ name: '', agents: [{ id: 'oc@p', harness: 'opencode', kind: 'OpenCode' }] }], current: 'oc@p' };
    const h = await open({ replies: { [URL_T]: LIST } });
    await h.emit(sync(T, [], [T], { agents }));
    expect(chip(h)).toBeNull();

    await h.click('.agent-card[data-agent="oc@p"]');
    expect(h.calls.filter((c) => c.path === 'api/send').map((c) => c.body.text)).toEqual(['/agent oc@p']);
    // No status has arrived and no sync followed: the tap alone puts it up, and it works.
    expect(chip(h)?.textContent).toBe('Model');
    await h.click('#status .st-model');
    expect(h.calls.find((c) => c.path === URL_T)).toBeTruthy();
    await tick();
    expect(rows(h)).toHaveLength(13);
  });

  it('takes the switch away again when a failed send empties the room and the choice comes back', async () => {
    const agents = { groups: [{ name: '', agents: [{ id: 'oc@p', harness: 'opencode', kind: 'OpenCode' }] }], current: 'oc@p' };
    const h = await open();
    await h.emit(sync(T, [], [T], { agents }));
    await h.emit({ t: 'msg', msg: message('w1', '<p>a scheduled task said this</p>') });
    expect(chip(h)?.textContent).toBe('Model');
    await h.emit({ t: 'del', id: 'w1' });
    expect(h.el('log').querySelector('.launch')).not.toBeNull();
    expect(chip(h)).toBeNull();
  });

  it('is a finger target on a phone, and does not zoom the page when filtering', () => {
    const html = renderPage('Chat', false);
    const at = html.indexOf('@media(max-width:640px){');
    let depth = 0;
    let css = '';
    for (let i = html.indexOf('{', at); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) {
        css = html.slice(at, i + 1);
        break;
      }
    }
    expect(css).toMatch(/\.st-model\{min-height:44px/);
    expect(css).toMatch(/#mp-filter\{min-height:44px;font-size:16px\}/);
    expect(css).toMatch(/#mp-close\{min-width:44px;min-height:44px\}/);
    expect(css).toMatch(/#model-pop\{left:8px;right:8px;width:auto/);
  });

  it('does not take the keyboard on a phone when it opens', async () => {
    const h = await ready({ width: 390, height: 844 });
    await h.click('#status .st-model');
    await tick();
    expect(h.doc.activeElement?.id).not.toBe('mp-filter');
  });
});

describe('webui page: the agent status strip', () => {
  const T = 'a1b2c3d4';
  const OTHER = 'b2c3d4e5';
  const CC = {
    agent: 'cc',
    model: 'claude-opus-5-5',
    effort: 'high',
    context: { used: 230_000, size: 1_000_000 },
    cost: { amount: 1.2391, currency: 'USD' },
  };
  const strip = (h: Harness): HTMLElement => h.el('status');

  it('stays hidden until the daemon has something to say, and shows what it says', async () => {
    const h = await open();
    await h.emit(sync(T, [], [T]));
    // A topic whose agent has not reported since the daemon started: nothing, not a row of zeros.
    expect(strip(h).hidden).toBe(true);

    await h.emit({ t: 'status', status: CC });
    expect(strip(h).hidden).toBe(false);
    const text = strip(h).textContent ?? '';
    expect(text).toContain('cc · claude-opus-5-5 · high');
    expect(text).toContain('23%');
    // The same units as the footer under every reply, so the two can be compared.
    expect(text).toContain('230k/1M');
    expect(text).toContain('$1.24');
  });

  it('colours the context as it fills, at the same thresholds as the agy status line', async () => {
    const h = await open();
    await h.emit(sync(T, [], [T]));
    const ctx = (used: number) => ({ ...CC, context: { used, size: 1000 } });
    const cls = () => strip(h).querySelectorAll('.st')[1]?.className;
    await h.emit({ t: 'status', status: ctx(100) });
    expect(cls()).toBe('st');
    await h.emit({ t: 'status', status: ctx(600) });
    expect(cls()).toBe('st warn');
    await h.emit({ t: 'status', status: ctx(850) });
    expect(cls()).toBe('st bad');
  });

  it('counts the cache down here, from the one expiry the daemon sent', async () => {
    const h = await open();
    const now = Date.now();
    await h.emit(sync(T, [], [T], { status: { ...CC, cacheExpiresAt: now + 41 * 60_000 + 30_000 } }));
    expect(strip(h).textContent).toContain('cache 41m');

    await h.emit({ t: 'status', status: { ...CC, cacheExpiresAt: now + 3 * 60_000 } });
    const cache = [...strip(h).querySelectorAll('.st')].find((s) => s.textContent?.startsWith('cache'));
    // Under five minutes is the moment it is worth sending the next message to keep it.
    expect(cache?.className).toBe('st warn');

    await h.emit({ t: 'status', status: { ...CC, cacheExpiresAt: now - 1000 } });
    expect(strip(h).textContent).toContain('cache expired');
  });

  it('shows the pools being spent from, and every pool once tapped open', async () => {
    const h = await open();
    const agy = {
      agent: 'agy',
      model: 'Claude Opus 5.5 (Medium)',
      quota: [
        { id: '3p-5h', remaining: 1, resetsAt: Date.now() + 5 * 3600_000, active: true },
        { id: '3p-weekly', remaining: 0.3, resetsAt: Date.now() + 2 * 86_400_000 + 3 * 3600_000 + 60_000, active: true },
        { id: 'gemini-weekly', remaining: 1, active: false },
      ],
    };
    await h.emit(sync(T, [], [T], { status: agy }));
    const text = () => strip(h).textContent ?? '';
    expect(text()).toContain('3P 5h 100%');
    // A reset time only once something has been spent; colour once it runs low.
    expect(text()).not.toContain('3P 5h 100% (');
    expect(text()).toContain('3P wk 30% (2d 3h)');
    expect(text()).not.toContain('Gemini');

    await h.click('#status');
    expect(strip(h).classList.contains('open')).toBe(true);
    expect(text()).toContain('Gemini wk 100%');
    expect(strip(h).querySelector('.st.off')?.textContent).toBe('Gemini wk 100%');
  });

  it('escapes what it is sent — a model name is the agent’s to choose', async () => {
    const h = await open();
    await h.emit(sync(T, [], [T], { status: { agent: 'cc', model: '<img src=x onerror=alert(1)>' } }));
    expect(strip(h).querySelector('img')).toBeNull();
    expect(strip(h).textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('clears when the daemon clears it, and on the way into another topic', async () => {
    const h = await open();
    await h.emit(sync(T, [], [T, OTHER], { status: CC }));
    expect(strip(h).hidden).toBe(false);
    await h.emit({ t: 'status' });
    expect(strip(h).hidden).toBe(true);

    await h.emit({ t: 'status', status: CC });
    // Switching: the strip described the topic being left, and must not sit over the next one
    // while its sync is on the way.
    await h.click(`[data-topic="${OTHER}"]`);
    expect(strip(h).hidden).toBe(true);
    await h.emit(sync(OTHER, [], [T, OTHER], { status: { agent: 'agy' } }));
    // No model reported yet: the switch is there all the same, under its own name.
    expect(strip(h).textContent).toBe('agy · Model');
  });

  it('runs its countdown timer only while there is a countdown on screen', async () => {
    const h = await open();
    const set = vi.spyOn(h.window, 'setInterval');
    const clear = vi.spyOn(h.window, 'clearInterval');
    await h.emit(sync(T, [], [T], { status: CC }));
    expect(set).not.toHaveBeenCalled();
    await h.emit({ t: 'status', status: { ...CC, cacheExpiresAt: Date.now() + 3_600_000 } });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[1]).toBe(30_000);
    await h.emit({ t: 'status', status: CC });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('drops the token counts on a narrow screen until tapped open', () => {
    const html = renderPage('Chat', false);
    const at = html.indexOf('@media(max-width:640px){');
    expect(html.slice(at)).toContain('#status:not(.open) .st-x{display:none}');
    // …and not on the desktop, where there is room.
    expect(html.slice(0, at)).not.toContain('.st-x{display:none}');
  });
});

describe('webui page: tool bubbles fold and open', () => {
  const T = 'a1b2c3d4';
  const CMD = 'cd /home/user/workspace/project-scripts/dividend-backtest && python3 fetch_prices.py --since 2018';

  /** A tool bubble in the shape `index.ts` posts one: the server's own line markup, and the kind. */
  function bubble(id: string, lines: string[]): Record<string, unknown> {
    return { ...message(id, renderWebToolLines(lines.join('\n'))), kind: 'tools' };
  }

  const rows = (h: Harness): HTMLElement[] => Array.from(h.doc.querySelectorAll<HTMLElement>('#log .tl'));
  const openRows = (h: Harness): boolean[] => rows(h).map((r) => r.classList.contains('open'));
  const toggle = (h: Harness): HTMLElement | null => h.doc.querySelector<HTMLElement>('#log [data-tl-all]');

  it('draws each tool on a row of its own, folded, with a way to open them all', async () => {
    const h = await open();
    await h.emit(sync(T, [bubble('m1', [`💻 Bash: "${CMD}" ✓ 1.2s`, '📖 Read: "a.md"']), message('m2', '<p>prose</p>')], [T]));

    expect(rows(h)).toHaveLength(2);
    expect(openRows(h)).toEqual([false, false]);
    // The whole command is in the row, folded by the stylesheet — not cut by the server.
    expect(rows(h)[0]?.textContent).toContain('--since 2018');
    expect(toggle(h)?.textContent).toBe('Show all');
    // Only a tool bubble offers it: a reply has nothing folded to open.
    expect(h.doc.querySelectorAll('#log [data-tl-all]')).toHaveLength(1);
  });

  it('opens one row on a click, and folds it on the next', async () => {
    const h = await open();
    await h.emit(sync(T, [bubble('m1', [`💻 Bash: "${CMD}"`, '📖 Read: "a.md"'])], [T]));

    rows(h)[1]!.click();
    await tick();
    expect(openRows(h)).toEqual([false, true]);
    // Answered in the page: opening a line is not a click on the message for the daemon.
    expect(h.calls.filter((c) => c.path === 'api/click')).toEqual([]);

    rows(h)[1]!.click();
    await tick();
    expect(openRows(h)).toEqual([false, false]);
  });

  it('"Show all" opens every row, and the rows the agent adds after it', async () => {
    const h = await open();
    await h.emit(sync(T, [bubble('m1', [`💻 Bash: "${CMD}"`])], [T]));

    await h.click('#log [data-tl-all]');
    expect(openRows(h)).toEqual([true]);
    expect(toggle(h)?.textContent).toBe('Collapse');

    // The bubble is still live: the next tool arrives as an edit of the same message.
    await h.emit({ t: 'msg', msg: bubble('m1', [`💻 Bash: "${CMD}" ✓ 1.2s`, '📖 Read: "a.md"']) });
    expect(openRows(h)).toEqual([true, true]);

    await h.click('#log [data-tl-all]');
    expect(openRows(h)).toEqual([false, false]);
    expect(toggle(h)?.textContent).toBe('Show all');
  });

  it('keeps an opened row open while the bubble goes on being edited', async () => {
    // The reason the state lives in the script and not on the element: every edit rewrites the
    // bubble's markup, and a class set on the old row would snap shut under the reader at the ✓.
    const h = await open();
    await h.emit(sync(T, [bubble('m1', [`💻 Bash: "${CMD}"`])], [T]));
    rows(h)[0]!.click();
    await tick();

    await h.emit({ t: 'msg', msg: bubble('m1', [`💻 Bash: "${CMD}" ✓ 1.2s`, '📖 Read: "a.md"']) });
    expect(openRows(h)).toEqual([true, false]);
    expect(rows(h)[0]?.textContent).toContain('✓ 1.2s');
  });

  it('a click that ends a selection leaves the row as it was', async () => {
    // Selecting part of a command to copy it is the other thing done with these rows. Toggling
    // on that click would repaint the bubble and throw the selection away.
    const h = await open();
    await h.emit(sync(T, [bubble('m1', [`💻 Bash: "${CMD}"`])], [T]));
    const range = h.doc.createRange();
    range.selectNodeContents(rows(h)[0]!);
    // Replacing whatever is there: addRange is a no-op on a selection that already holds a range.
    const sel = h.window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(String(sel)).toContain('python3');

    rows(h)[0]!.click();
    await tick();
    expect(openRows(h)).toEqual([false]);
  });

  it('folds by the stylesheet: the command cut with an ellipsis, the mark kept, wrapping once opened', () => {
    // Asserted as served text, not through the CSSOM (see the README): without these rules a
    // "folded" row is just a long line, and every assertion above would pass on a page that
    // folds nothing. Whether the mark really stays in view is layout, checked in real Chromium.
    const html = renderPage('Chat', false, true, false);
    expect(html).toContain('.tl-c{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}');
    expect(html).toContain('.tl-s{flex:none;white-space:pre}');
    expect(html).toContain('.tl.open{display:block;white-space:pre-wrap;overflow-wrap:anywhere}');
  });
});

describe('webui page: sub-agent bubbles', () => {
  const T = 'a1b2c3d4';
  const at = `http://localhost:8787/?t=${T}`;
  /** A message in the shape `index.ts` posts one: rendered html, and the kind it was sent with. */
  const sub = (
    id: string,
    html: string,
    kind: 'dispatch' | 'report'
  ): Record<string, unknown> => ({ ...message(id, html), kind });
  const tag = (h: Harness, cls: string): string | null =>
    h.doc.querySelector(`#log .m.${cls} .sub-k`)?.textContent ?? null;

  it('draws a dispatch and a report apart, and leaves an ordinary reply alone', async () => {
    const h = await open({ url: at });
    await h.emit(
      sync(T, [sub('m1', '<p>a task</p>', 'dispatch'), sub('m2', renderWebToolLines('🔔 a — done.'), 'report'), message('m3', '<p>a reply</p>')], [T])
    );

    expect(h.doc.querySelectorAll('#log .m.dispatch')).toHaveLength(1);
    expect(h.doc.querySelectorAll('#log .m.report')).toHaveLength(1);
    // The tag is what says which is which before the body is read.
    expect(tag(h, 'dispatch')).toBe('Sub-agent task');
    expect(tag(h, 'report')).toBe('Sub-agent report');
    // A plain reply gets neither mark.
    expect(h.doc.querySelectorAll('#log .m:not(.dispatch):not(.report)')).toHaveLength(1);
    expect(h.doc.querySelectorAll('#log .sub-k')).toHaveLength(2);
  });

  it('folds a report like a tool bubble, and leaves a dispatch unfolded prose', async () => {
    const h = await open({ url: at });
    await h.emit(
      sync(
        T,
        [
          sub('m1', '<p>do the thing</p>', 'dispatch'),
          sub('m2', renderWebToolLines('🔔 a — done.\n🔔 b — waiting on a question.'), 'report'),
        ],
        [T]
      )
    );

    // The report's lines are rows, folded, with the same control a tool bubble offers.
    expect(h.doc.querySelectorAll('#log .m.report .tl')).toHaveLength(2);
    expect(Array.from(h.doc.querySelectorAll('#log .m.report .tl')).map((r) => r.classList.contains('open'))).toEqual([
      false,
      false,
    ]);
    expect(h.doc.querySelector('#log .m.report [data-tl-all]')?.textContent).toBe('Show all');
    // A dispatch is the card or the task text itself: prose, nothing to fold.
    expect(h.doc.querySelectorAll('#log .m.dispatch .tl')).toHaveLength(0);
    expect(h.doc.querySelector('#log .m.dispatch [data-tl-all]')).toBeNull();

    await h.click('#log .m.report [data-tl-all]');
    expect(Array.from(h.doc.querySelectorAll('#log .m.report .tl')).map((r) => r.classList.contains('open'))).toEqual([
      true,
      true,
    ]);
  });

  it('keeps the report a report while it is edited', async () => {
    // The card is edited in place as the burst it gathers grows, before it settles.
    const h = await open({ url: at });
    await h.emit(sync(T, [sub('m1', renderWebToolLines('🔔 a — done.'), 'report')], [T]));
    await h.emit({ t: 'msg', msg: sub('m1', renderWebToolLines('🔔 a — done.\n🔔 b — failed.'), 'report') });

    expect(h.doc.querySelectorAll('#log .m.report')).toHaveLength(1);
    expect(h.doc.querySelectorAll('#log .m.report .tl')).toHaveLength(2);
    expect(tag(h, 'report')).toBe('Sub-agent report');
  });

  it('keeps both markings across a reload', async () => {
    // The transcript cache is what paints before the daemon answers, so the marking has to be in
    // the message it kept — not in markup only the previous page remembered.
    const first = await open({ url: at });
    const messages = [
      sub('m1', '<p>a task</p>', 'dispatch'),
      sub('m2', renderWebToolLines('🔔 a — done.'), 'report'),
    ];
    await first.emit(sync(T, messages, [T]));
    await saved();
    first.window.close();

    const again = await open({ url: at, idb: first.idb });
    // The cache paints before the daemon answers, so this half is the message it kept — not the
    // sync repeating itself.
    await until('the cached transcript is painted', () => again.painted() === 2);
    expect(again.doc.querySelectorAll('#log .m.dispatch')).toHaveLength(1);
    expect(again.doc.querySelectorAll('#log .m.report')).toHaveLength(1);
    expect(tag(again, 'dispatch')).toBe('Sub-agent task');
    expect(tag(again, 'report')).toBe('Sub-agent report');
    expect(again.doc.querySelectorAll('#log .m.report .tl')).toHaveLength(1);

    await again.emit(sync(T, messages, [T]));
    expect(again.doc.querySelectorAll('#log .m.dispatch')).toHaveLength(1);
    expect(again.doc.querySelectorAll('#log .m.report')).toHaveLength(1);
    expect(again.doc.querySelectorAll('#log .m.report .tl')).toHaveLength(1);
  });

  it('styles both kinds with variables, a rail and a tag, so another palette moves no rule', () => {
    // jsdom does not evaluate the cascade (see the README); the assertion is on what is served.
    const html = renderPage('Chat', false, true, false);
    expect(html).toContain('.m.dispatch{background:var(--disp);border-left:3px solid var(--disp-edge)');
    expect(html).toContain('.m.report{background:var(--rep);border-left:3px solid var(--rep-edge)');
    expect(html).toContain('--disp:#1a1622;--disp-edge:#8b6cc1;--rep:#14201a;--rep-edge:#3f8f6b');
    expect(html).toContain('.sub-k{');
  });
});

describe('webui page: what needs you, and sub-agent topics', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const C = 'c3d4e5f6';
  const D = 'd15a7c40';
  const rows = (h: Harness): Array<string | null> =>
    Array.from(h.el('topics').querySelectorAll('[data-topic]')).map((r) => r.getAttribute('data-topic'));
  /** The rows marked as needing you, in order, with what each says on hover. */
  const needs = (h: Harness): Array<[string | null, string | null]> =>
    Array.from(h.el('topics').querySelectorAll('.topic-item.needs')).map((r) => [r.getAttribute('data-topic'), r.getAttribute('title')]);
  const list = (extra: Record<string, Record<string, unknown>>): Array<Record<string, unknown>> =>
    [A, B, C, D].map((id, i) => ({ id, title: `T ${id}`, lastAt: 1000 - i, msgCount: 0, stage: 'idle', ...(extra[id] ?? {}) }));

  it('puts what needs you first, in green — questions, then failures, then unread replies — and nothing else', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    expect(needs(h)).toEqual([]);

    await h.emit({
      t: 'topics',
      topics: list({
        A: {},
        [B]: { stage: 'review', line: 'Done: shipped 2.18.0' },
        [C]: { stage: 'failed', line: 'upstream 503' },
        [D]: { stage: 'answer', line: 'Merge now?' },
      }),
    });
    expect(needs(h)).toEqual([
      [D, 'Waiting on your answer: Merge now?'],
      [C, 'Failed: upstream 503'],
      [B, 'Finished: Done: shipped 2.18.0'],
    ]);
    // Each topic once: the rows themselves move up, with a line under them, rather than a second
    // copy of each in a block of their own (which read as two conversations).
    expect(rows(h)).toEqual([D, C, B, A]);
    expect(h.doc.querySelector(`#topics [data-topic="${A}"]`)?.classList.contains('after-needs')).toBe(true);
    expect(h.doc.getElementById('needs')).toBeNull();
    // The dot still says which of the three it is.
    expect(h.doc.querySelector(`#topics [data-topic="${B}"] .topic-dot`)?.className).toBe('topic-dot review');

    // Working, retrying and idle take no room; and the topic on screen is not listed as news.
    await h.emit({ t: 'topics', topics: list({ [A]: { stage: 'review' }, [B]: { stage: 'working' }, [C]: { stage: 'retrying' } }) });
    expect(needs(h)).toEqual([]);
    expect(rows(h)).toEqual([A, B, C, D]);
  });

  it('opens a topic that needs you like any other row', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: list({ [C]: { stage: 'failed', line: 'x' } }) });
    await h.click(`#topics .topic-item.needs[data-topic="${C}"]`);
    expect(h.live().url).toBe(`api/events?t=${C}`);
  });

  it('offers Stop over a topic whose sub-agents still work after its own turn ended', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    const stop = h.el('stop-turn') as HTMLButtonElement;
    await h.emit({ t: 'topics', topics: list({ [B]: { parent: A } , [C]: { parent: B, running: true } }) });
    expect(stop.hidden).toBe(false);
    expect(stop.title).toContain('sub-agents it started');
    await h.click('#stop-turn');
    expect(h.calls.find((c) => c.path === 'api/send')?.body.text).toBe('/stop');

    await h.emit({ t: 'topics', topics: list({ [B]: { parent: A }, [C]: { parent: B } }) });
    expect(stop.hidden).toBe(true);
  });

  it('nests a sub-agent’s topic under the one that opened it, folded a level at a time', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: list({ [B]: { parent: D }, [C]: { parent: B }, [D]: { starred: true } }) });
    // Folded on first sight: the column lists conversations, not the working detail behind one.
    expect(rows(h)).toEqual([D, A]);
    expect(h.doc.querySelector(`#topics [data-fold="${D}"]`)?.textContent).toBe('▸ 1');
    await h.click(`#topics [data-fold="${D}"]`);
    // Opening one level does not open the next.
    expect(rows(h)).toEqual([D, B, A]);
    expect(h.doc.querySelector(`#topics [data-fold="${B}"]`)?.textContent).toBe('▸ 1');
    await h.click(`#topics [data-fold="${B}"]`);
    expect(rows(h)).toEqual([D, B, C, A]);
    const row = (id: string): Element => h.doc.querySelector(`#topics [data-topic="${id}"]`)!;
    expect(row(D).className).not.toMatch(/\bsub\b/);
    expect(row(B).className).toMatch(/\bsub d1\b/);
    expect(row(C).className).toMatch(/\bsub d2\b/);
    expect(row(D).querySelector('[data-fold]')?.textContent).toBe('▾ 1');
    expect(row(A).querySelector('[data-fold]')).toBeNull();
    // A child is a topic like any other: it can be starred and deleted.
    expect(row(B).querySelector('[data-del]')).not.toBeNull();
  });

  it('folds a parent’s sub-agents away by default — remembered, colour kept, and without switching to it', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    const topics = list({ [B]: { parent: D }, [C]: { parent: D, running: true } });
    await h.emit({ t: 'topics', topics });
    // Folded on first sight, and the pill takes the colour of what it hides.
    expect(rows(h)).toEqual([D, A]);
    const pill = h.doc.querySelector(`#topics [data-fold="${D}"]`)!;
    expect(pill.textContent).toBe('▸ 2');
    expect(pill.className).toContain('running');
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    // Opening is the operator's choice, and it is kept as one.
    await h.click(`#topics [data-fold="${D}"]`);
    expect(rows(h)).toEqual([D, B, C, A]);
    expect(JSON.parse(h.window.localStorage.getItem('aa_folded') ?? '{}')).toEqual({ [D]: false });
    expect(h.live().url).toBe(`api/events?t=${A}`);
    await h.click(`#topics [data-fold="${D}"]`);
    expect(rows(h)).toEqual([D, A]);
    expect(JSON.parse(h.window.localStorage.getItem('aa_folded') ?? '{}')).toEqual({ [D]: true });
  });

  it('never folds away the topic on screen, even under the default fold', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${C}` });
    await h.emit(sync(C, [], [C]));
    await h.emit({ t: 'topics', topics: list({ [C]: { parent: D } }) });
    expect(rows(h)).toEqual([A, B, D, C]);
    expect(h.doc.querySelector(`#topics [data-fold="${D}"]`)?.textContent).toBe('▾ 1');
  });

  it('draws a topic whose sub-agents work as running, not idle', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: list({ [B]: { parent: A }, [C]: { parent: B, running: true } }) });
    const row = (): Element => h.doc.querySelector(`#topics [data-topic="${A}"]`)!;
    // Its own turn ended long ago; the job did not, so the row and the header both say running.
    expect(row().className).toMatch(/\brunning\b/);
    expect(row().querySelector('.topic-dot')?.className).toBe('topic-dot running');
    expect(h.el('topic-status').textContent).toBe('running');
    expect((h.el('stop-turn') as HTMLButtonElement).hidden).toBe(false);
    // And it is not offered for closing as an idle agent either.
    expect(h.el('close-idle').hidden).toBe(true);

    await h.emit({ t: 'topics', topics: list({ [B]: { parent: A }, [C]: { parent: B } }) });
    expect(row().className).not.toMatch(/\brunning\b/);
    expect(h.el('topic-status').textContent).toBe('');
  });

  it('orders the list by state: a decision, then working, then resident, then no agent', async () => {
    const E = 'e6f7a8b9';
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        // The daemon's order, deliberately the reverse of the one these states belong in.
        { id: A, title: 'stopped', lastAt: 1000, msgCount: 0, stage: 'idle' },
        { id: D, title: 'resident', lastAt: 999, msgCount: 0, stage: 'idle', live: true },
        { id: B, title: 'decision', lastAt: 998, msgCount: 0, stage: 'answer', asking: true, running: true, live: true },
        { id: C, title: 'working', lastAt: 997, msgCount: 0, stage: 'working', running: true, live: true },
        { id: E, title: 'resident, starred', lastAt: 996, msgCount: 0, stage: 'idle', live: true, starred: true },
      ],
    });
    // A star leads its unstarred peers inside a state, and the daemon's order holds below that.
    expect(rows(h)).toEqual([B, C, E, D, A]);
    expect(h.doc.querySelector(`#topics [data-topic="${C}"]`)?.classList.contains('after-needs')).toBe(true);
  });

  it('puts a sub-agent’s topic first only for a question of its own', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: list({
        [B]: { parent: A, stage: 'review', line: 'done' },
        [C]: { parent: A, stage: 'answer', asking: true, line: 'Which branch?' },
        [D]: { parent: A, stage: 'failed', line: 'boom' },
      }),
    });
    expect(needs(h)).toEqual([[C, 'Waiting on your answer: Which branch?']]);
    expect(rows(h)[0]).toBe(C);
    // The parent is folded, and its pill carries the question it is hiding.
    expect(h.doc.querySelector(`#topics [data-fold="${A}"]`)?.className).toContain('asking');
  });

  it('keeps a sub-agent’s finished dot grey, and lights only the topic that opened it', async () => {
    // The current topic is the sub-agent's, so its row is painted even though it is nested: its
    // parent is an ancestor and is drawn open. B has a parent; C is an ordinary topic.
    const h = await open({ url: `http://localhost:8787/?t=${B}` });
    await h.emit(sync(B, [], [B]));
    const dot = (id: string): string | undefined =>
      h.doc.querySelector(`#topics [data-topic="${id}"] .topic-dot`)?.className;

    await h.emit({
      t: 'topics',
      topics: list({ [B]: { parent: A, stage: 'review', line: 'done' }, [C]: { stage: 'review', line: 'done' } }),
    });
    // A finished sub-agent is the news of the agent that opened it, not of the person: no green
    // "unread reply" dot, just the ordinary idle grey. A root topic keeps the green one.
    expect(dot(B)).toBe('topic-dot');
    expect(dot(C)).toBe('topic-dot review');
    // Resident, the same row is the ordinary online grey — not a green of its own.
    await h.emit({
      t: 'topics',
      topics: list({ [B]: { parent: A, stage: 'review', live: true }, [C]: { stage: 'review', live: true } }),
    });
    expect(dot(B)).toBe('topic-dot live');
    expect(dot(C)).toBe('topic-dot review');
    // Its own work and its own question are unchanged: blue while it runs, amber while it asks.
    await h.emit({
      t: 'topics',
      topics: list({
        [B]: { parent: A, stage: 'working', running: true },
        [C]: { parent: A, stage: 'answer', asking: true, running: true },
      }),
    });
    expect(dot(B)).toBe('topic-dot running');
    expect(dot(C)).toBe('topic-dot asking');
  });

  it('marks a failed topic’s dot red when nothing else is going on', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: list({ [C]: { stage: 'failed' }, [B]: { stage: 'failed', running: true } }) });
    expect(h.doc.querySelector(`#topics [data-topic="${C}"] .topic-dot`)?.className).toBe('topic-dot failed');
    expect(h.doc.querySelector(`#topics [data-topic="${B}"] .topic-dot`)?.className).toBe('topic-dot running');
  });

  it('tells the daemon a reply on screen was read — once, and not while the page is hidden', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    const seen = (): number => h.calls.filter((c) => c.path === 'api/seen').length;

    await h.emit({ t: 'topics', topics: list({ [A]: { stage: 'review' } }) });
    expect(h.calls.find((c) => c.path === 'api/seen')?.body).toEqual({ topic: A });
    await h.emit({ t: 'topics', topics: list({ [A]: { stage: 'review' } }) });
    expect(seen()).toBe(1);

    // Another topic's unread reply is not this page's to mark.
    await h.emit({ t: 'topics', topics: list({ [B]: { stage: 'review' } }) });
    expect(seen()).toBe(1);

    Object.defineProperty(h.doc, 'visibilityState', { value: 'hidden', configurable: true });
    await new Promise((r) => setTimeout(r, 2_100));
    await h.emit({ t: 'topics', topics: list({ [A]: { stage: 'review' } }) });
    expect(seen()).toBe(1);
    Object.defineProperty(h.doc, 'visibilityState', { value: 'visible', configurable: true });
    h.doc.dispatchEvent(new h.window.Event('visibilitychange'));
    await tick();
    expect(seen()).toBe(2);
  });

  it('switches to a topic a message links to, in place', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${D}` });
    await h.emit(
      sync(D, [message('w1', `<p>Done in <a href="?t=${C}" data-goto="${C}">quantlab</a>.</p>`)], [D, A, C])
    );
    const before = h.streams.length;
    await h.click('#log a[data-goto]');
    expect(h.live().url).toBe(`api/events?t=${C}`);
    expect(h.streams.length).toBe(before + 1);
    // Not a navigation: the page is the same page.
    expect(h.window.location.search).toBe(`?t=${C}`);
  });

  it('ignores a link to a topic it does not have', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${D}` });
    await h.emit(sync(D, [message('w1', '<p><a href="?t=99999999" data-goto="99999999">gone</a></p>')], [D, A]));
    await h.click('#log a[data-goto]');
    expect(h.live().url).toBe(`api/events?t=${D}`);
  });
});

describe('webui page: notifications on this device', () => {
  const A = 'a1b2c3d4';
  const C = 'c3d4e5f6';
  const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
  const ready = async (h: Harness): Promise<void> => {
    await h.emit(sync(A, [], [A, C]));
    await until('the toggle is drawn', () => !h.el('notify-toggle').hidden);
  };

  it('is not offered by a browser that cannot do it', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}`, replies: { 'api/push': { enabled: true, key: KEY } } });
    await h.emit(sync(A, [], [A]));
    await tick();
    expect(h.el('notify-toggle').hidden).toBe(true);
    expect(h.calls.some((c) => c.path === 'api/push')).toBe(false);
  });

  it('is not offered when the server sends none', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}`, push: {}, replies: { 'api/push': { enabled: false } } });
    await h.emit(sync(A, [], [A]));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.el('notify-toggle').hidden).toBe(true);
  });

  it('turns on: asks permission, registers the worker, subscribes with the server key, and tells the server', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}`, push: {}, replies: { 'api/push': { enabled: true, key: KEY } } });
    await ready(h);
    expect(h.el('notify-state').textContent).toBe('off');

    await h.click('#notify-toggle');
    await until('the subscription reached the server', () => h.calls.some((c) => c.path === 'api/push/subscribe'));
    expect(h.push.registered).toBe('sw.js');
    expect(h.push.subscribedWith?.userVisibleOnly).toBe(true);
    expect(Buffer.from(h.push.subscribedWith!.applicationServerKey).toString('base64url')).toBe(KEY);
    expect(h.calls.find((c) => c.path === 'api/push/subscribe')?.body).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/dev1',
      expirationTime: null,
      keys: { p256dh: 'P', auth: 'A' },
    });
    await until('the toggle says so', () => h.el('notify-state').textContent === 'on');
  });

  it('turns off: unsubscribes here and on the server', async () => {
    const h = await open({
      url: `http://localhost:8787/?t=${A}`,
      push: { permission: 'granted', subscribed: true },
      replies: { 'api/push': { enabled: true, key: KEY } },
    });
    await ready(h);
    await until('it knows it is on', () => h.el('notify-state').textContent === 'on');
    await h.click('#notify-toggle');
    await until('the server was told', () => h.calls.some((c) => c.path === 'api/push/unsubscribe'));
    expect(h.push.unsubscribed).toBe(true);
    expect(h.calls.find((c) => c.path === 'api/push/unsubscribe')?.body).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/dev1' });
    await until('the toggle says so', () => h.el('notify-state').textContent === 'off');
  });

  it('says so when the browser blocks it, and asks nothing', async () => {
    const h = await open({
      url: `http://localhost:8787/?t=${A}`,
      push: { permission: 'denied' },
      replies: { 'api/push': { enabled: true, key: KEY } },
    });
    await ready(h);
    expect(h.el('notify-state').textContent).toBe('blocked');
    expect((h.el('notify-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a permission refused at the prompt subscribes nothing', async () => {
    const h = await open({
      url: `http://localhost:8787/?t=${A}`,
      push: { answer: 'denied' },
      replies: { 'api/push': { enabled: true, key: KEY } },
    });
    await ready(h);
    await h.click('#notify-toggle');
    await until('the toggle repaints', () => h.el('notify-state').textContent === 'blocked');
    expect(h.calls.some((c) => c.path === 'api/push/subscribe')).toBe(false);
  });

  it('a tapped notification brings the page to its topic', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}`, push: {}, replies: { 'api/push': { enabled: true, key: KEY } } });
    await ready(h);
    h.push.listeners.forEach((fn) => fn({ data: { goto: C } }));
    await tick();
    expect(h.live().url).toBe(`api/events?t=${C}`);
  });
});

describe('webui page: the sidebar footer, and low attention', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const C = 'c3d4e5f6';
  const menuOpen = (h: Harness): boolean => !h.el('opts-menu').hidden || !h.el('manage-menu').hidden;
  const calm = (h: Harness): boolean => h.el('app').classList.contains('calm');

  it('puts settings and skills in Menu, and housekeeping in Manage, leaving two buttons on the row', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    const menu = h.el('opts-menu');
    for (const id of ['settings-open', 'notify-toggle', 'calm-toggle', 'skills-toggle']) {
      expect(menu.contains(h.el(id))).toBe(true);
    }
    const manage = h.el('manage-menu');
    for (const id of ['close-idle', 'no-idle']) expect(manage.contains(h.el(id))).toBe(true);
    expect(manage.contains(h.el('clear-topics'))).toBe(false);
    expect(h.doc.querySelector('#sidebar-header .panel-title')?.contains(h.el('clear-topics'))).toBe(true);
    // The footer itself holds two buttons and nothing else — the two menus are its children.
    const buttons = Array.from(h.el('sidebar-footer').children).filter((e) => e.tagName === 'BUTTON');
    expect(buttons.map((b) => b.id)).toEqual(['opts-toggle', 'manage-toggle']);
    expect(h.el('opts-toggle').querySelector('.opts-gear')?.textContent).toContain('⚙');
    expect(h.el('manage-toggle').querySelector('.opts-gear svg')).not.toBeNull();
    expect(h.el('manage-toggle').querySelector('.opts-gear svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(menuOpen(h)).toBe(false);
    expect(h.el('opts-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(h.el('manage-toggle').getAttribute('aria-expanded')).toBe('false');

    // Manage aligns to the right edge via margin-left: auto (twin of the 2.34.0 close-idle rule).
    const html = renderPage('Chat', false);
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    expect(css).toMatch(/#manage-toggle\s*\{[^}]*margin-left:\s*auto[^}]*\}/);
  });

  it('shows the idle count on Manage without opening anything', async () => {
    const h = await open();
    // Two topics with a resident agent and nothing running: the two Close idle would end.
    await h.emit(sync(A, [], [A, B]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'here', lastAt: 1000, msgCount: 0, stage: 'idle', live: true },
        { id: B, title: 'also here', lastAt: 999, msgCount: 0, stage: 'idle', live: true },
      ],
    });
    expect(h.el('idle-count').textContent).toBe('(2)');
    expect(h.el('close-idle').textContent).toBe('Close idle (2)');
    expect(h.el('no-idle').hidden).toBe(true);

    // Nothing to close: the count goes, close-idle is hidden, and no-idle is shown.
    await h.emit({
      t: 'topics',
      topics: [{ id: A, title: 'here', lastAt: 1000, msgCount: 0, stage: 'idle', live: true, running: true }],
    });
    expect(h.el('idle-count').textContent).toBe('');
    expect(h.el('close-idle').hidden).toBe(true);
    expect(h.el('no-idle').hidden).toBe(false);
    expect(h.doc.getElementById('idle-sep')).toBeNull();
  });

  it('shows a disabled explanation in Manage when idle is 0 instead of an empty box', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    expect(h.el('manage-toggle').hidden).toBe(false);
    await h.click('#manage-toggle');
    expect(h.el('manage-menu').hidden).toBe(false);
    expect(h.el('close-idle').hidden).toBe(true);
    expect(h.el('no-idle').hidden).toBe(false);
    expect(h.el('no-idle').textContent).toBe('No idle agents');
    expect(h.el('no-idle').getAttribute('disabled')).not.toBeNull();
  });

  it('opens one menu at a time: opening the other puts the first away', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));

    await h.click('#opts-toggle');
    expect(menuOpen(h)).toBe(true);
    await h.click('#manage-toggle');
    expect(h.el('opts-menu').hidden).toBe(true);
    expect(h.el('manage-menu').hidden).toBe(false);
    expect(h.el('opts-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(h.el('manage-toggle').getAttribute('aria-expanded')).toBe('true');

    // A click outside closes the menu.
    await h.click('#log');
    expect(h.el('manage-menu').hidden).toBe(true);
  });

  it('opens on a click, stays open while a toggle flips, and closes on a click elsewhere or on Escape', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.click('#opts-toggle');
    expect(menuOpen(h)).toBe(true);
    expect(h.el('opts-toggle').getAttribute('aria-expanded')).toBe('true');
    // Left open, so the state it flipped is seen flipping.
    await h.click('#calm-toggle');
    expect(menuOpen(h)).toBe(true);

    await h.click('#log');
    expect(menuOpen(h)).toBe(false);
    expect(h.el('opts-toggle').getAttribute('aria-expanded')).toBe('false');

    await h.click('#opts-toggle');
    await h.click('#opts-toggle');
    expect(menuOpen(h)).toBe(false);

    await h.click('#opts-toggle');
    h.el('calm-toggle').focus();
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menuOpen(h)).toBe(false);
    // Back on the button that opened it, rather than on a control that is no longer on screen.
    expect(h.doc.activeElement).toBe(h.el('opts-toggle'));
  });

  it('asks for confirmation before Clear, and does nothing when declined', async () => {
    const h = await open({ confirm: false });
    await h.emit(sync(A, [], [A, B]));
    let asked = false;
    (h.window as any).confirm = (): boolean => {
      asked = true;
      return false;
    };
    await h.click('#clear-topics');
    expect(asked).toBe(true);
    expect(h.calls.map((c) => c.path)).not.toContain('api/topics/clear');
  });

  it('is off until asked for, then marks the page, says so, and is kept by this browser', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    expect(calm(h)).toBe(false);
    expect(h.el('calm-state').textContent).toBe('off');
    expect(h.el('calm-toggle').getAttribute('aria-pressed')).toBe('false');

    await h.click('#opts-toggle');
    await h.click('#calm-toggle');
    expect(calm(h)).toBe(true);
    expect(h.el('calm-state').textContent).toBe('on');
    expect(h.el('calm-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(h.window.localStorage.getItem('aa_calm')).toBe('1');

    // Applied as the script starts, before the first sync: a reload does not flash the pulse back.
    const again = await open({ storage: { aa_calm: '1' } });
    expect(calm(again)).toBe(true);
    expect(again.el('calm-state').textContent).toBe('on');
    await again.click('#calm-toggle');
    expect(calm(again)).toBe(false);
    expect(again.window.localStorage.getItem('aa_calm')).toBeNull();
  });

  it('draws the same list either way: the mode is in the stylesheet, not in what the rows say', async () => {
    // A topic that needs you is found by the same row, dot and badge in both modes; only how loud
    // they are differs. So the markup itself must not change.
    const topics = [
      { id: A, title: 'here', lastAt: 1000, msgCount: 0, stage: 'idle' },
      { id: B, title: 'working', lastAt: 999, msgCount: 5, running: true, live: true, stage: 'working' },
      { id: C, title: 'asks', lastAt: 998, msgCount: 2, running: true, asking: true, live: true, stage: 'answer' },
    ];
    const paint = async (storage: Record<string, string>): Promise<string> => {
      const h = await open({ url: `http://localhost:8787/?t=${A}`, storage: { aa_reads: JSON.stringify({ [B]: 0, [C]: 0 }), ...storage } });
      await h.emit(sync(A, [], [A]));
      await h.emit({ t: 'topics', topics });
      expect(h.doc.querySelectorAll('#topics .topic-badge')).toHaveLength(2);
      return h.el('topics').innerHTML;
    };
    expect(await paint({ aa_calm: '1' })).toBe(await paint({}));
  });

  it('quiets the running dot and the unread count, and nothing that needs you', () => {
    const html = renderPage('Chat', false);
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    // Every rule the mode has, so one added for a question, a failure, a finished reply or the
    // green rows fails here: those are what the mode exists to leave standing out. A running
    // scheduled task is the same kind of "still working" signal as a running topic, so its dot
    // is quieted with the same rule.
    expect(css.match(/#app\.calm [^{]*\{[^}]*\}/g)).toEqual([
      '#app.calm .topic-dot.running{animation:none}',
      '#app.calm .topic-badge{background:#2a2a2a;color:#8a8a8a;font-weight:500}',
      '#app.calm .sched-item.running .sched-dot{animation:none}',
    ]);
    expect(css).toMatch(/\.topic-dot\.asking\{[^}]*animation:pulse/);
  });
});

describe('webui page: one panel component on both edges', () => {
  const A = 'a1b2c3d4';

  const openWide = async (): Promise<Harness> => {
    const h = await open({ width: 1440, height: 900 });
    await h.emit(sync(A, [], [A]));
    return h;
  };
  const shut = (h: Harness, id: string): boolean => h.el(id).classList.contains('collapsed');
  const appHas = (h: Harness, cls: string): boolean => h.el('app').classList.contains(cls);

  it('marks both columns as the same panel, closed by the same × and inert while shut', async () => {
    const h = await openWide();
    // Which edge it is on is the only class that differs; the base rules are `.panel`'s.
    expect(h.el('sidebar').classList.contains('panel')).toBe(true);
    expect(h.el('sidebar').classList.contains('panel-left')).toBe(true);
    expect(h.el('schedules').classList.contains('panel')).toBe(true);
    expect(h.el('schedules').classList.contains('panel-right')).toBe(true);
    // Both close buttons are the one control: same class, same glyph.
    for (const id of ['collapse-sidebar', 'schedules-close']) {
      expect(h.el(id).classList.contains('panel-close')).toBe(true);
      expect(h.el(id).textContent).toBe('×');
    }

    // The left starts open on a wide screen, the right closed.
    expect(shut(h, 'sidebar')).toBe(false);
    expect(shut(h, 'schedules')).toBe(true);
    expect(h.el('schedules').hasAttribute('inert')).toBe(true);

    await h.click('#collapse-sidebar');
    expect(shut(h, 'sidebar')).toBe(true);
    expect(h.el('sidebar').hasAttribute('inert')).toBe(true);
    expect(appHas(h, 'sb-open')).toBe(false);
    // The ☰ is the way back, at every width, because a closed column must not strand itself.
    await h.click('#expand-sidebar');
    expect(shut(h, 'sidebar')).toBe(false);
    expect(h.el('sidebar').hasAttribute('inert')).toBe(false);

    await h.click('#schedules-toggle');
    expect(shut(h, 'schedules')).toBe(false);
    expect(h.el('schedules').hasAttribute('inert')).toBe(false);
    expect(appHas(h, 'sched-open')).toBe(true);
    await h.click('#schedules-close');
    expect(shut(h, 'schedules')).toBe(true);
    expect(h.el('schedules').hasAttribute('inert')).toBe(true);
    expect(appHas(h, 'sched-open')).toBe(false);
  });

  it('answers Escape on both: the right panel first, then the left', async () => {
    const h = await openWide();
    await h.click('#schedules-toggle');
    expect(shut(h, 'sidebar')).toBe(false);
    expect(shut(h, 'schedules')).toBe(false);

    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(shut(h, 'schedules')).toBe(true);
    // The left is a column the person has not asked to close; the second Escape does that.
    expect(shut(h, 'sidebar')).toBe(false);

    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(shut(h, 'sidebar')).toBe(true);
  });

  it('keeps each width under its own key, in the one --pw property both edges read', async () => {
    const h = await open({ width: 1440, height: 900, storage: { aa_sb_w: '300', aa_sched_w: '260' } });
    expect(h.el('sidebar').style.getPropertyValue('--pw')).toBe('300px');
    expect(h.el('schedules').style.getPropertyValue('--pw')).toBe('260px');
    expect(h.window.localStorage.getItem('aa_sb_w')).toBe('300');
    expect(h.window.localStorage.getItem('aa_sched_w')).toBe('260');

    // Double-click on either handle is the default width again, and storage forgets it.
    for (const [handle, panel, key] of [
      ['sidebar-resize', 'sidebar', 'aa_sb_w'],
      ['sched-resize', 'schedules', 'aa_sched_w'],
    ] as const) {
      h.doc.getElementById(handle)!.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
      expect(h.el(panel).style.getPropertyValue('--pw')).toBe('');
      expect(h.window.localStorage.getItem(key)).toBeNull();
    }
  });

  it('keeps the two menus apart and each item wired to its own action', async () => {
    const h = await open({ replies: { 'api/skills': { skills: [] }, 'api/schedules': { enabled: true, tasks: [] } } });
    await h.emit(sync(A, [], [A]));

    // Menu → All settings: a page, opened with a quiet command.
    await h.click('#opts-toggle');
    await h.click('#settings-open');
    expect(h.el('opts-menu').hidden).toBe(true);
    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.calls.find((c) => c.path === 'api/send')?.body).toMatchObject({ text: '/setting', quiet: true });
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));

    // Menu → Skills: the managed-skills window, and the menu is gone.
    await h.click('#opts-toggle');
    await h.click('#skills-toggle');
    expect(h.el('opts-menu').hidden).toBe(true);
    expect(h.el('skills').hidden).toBe(false);
    await until('the skills request', () => h.calls.some((c) => c.path === 'api/skills'));
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));

    // Menu → Low attention stays open, so the state it flipped is seen flipping.
    await h.click('#opts-toggle');
    await h.click('#calm-toggle');
    expect(h.el('opts-menu').hidden).toBe(false);
    expect(appHas(h, 'calm')).toBe(true);
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));

    // Manage → Close idle: the confirmation, not the action. One resident agent is enough.
    await h.emit({
      t: 'topics',
      topics: [{ id: A, title: 'here', lastAt: 1000, msgCount: 0, stage: 'idle', live: true }],
    });
    await h.click('#manage-toggle');
    expect(h.el('manage-menu').hidden).toBe(false);
    expect(h.el('close-idle').hidden).toBe(false);
    await h.click('#close-idle');
    expect(h.el('manage-menu').hidden).toBe(true);
    expect(h.el('idle-dialog').hidden).toBe(false);
    expect(h.el('idle-title').textContent).toBe('Close 1 idle agent?');
    expect(h.calls.some((c) => c.path === 'api/topics/close-idle')).toBe(false);
  });

  it('asks before Clear, and posts only on a yes', async () => {
    const h = await open({ confirm: true });
    await h.emit(sync(A, [], [A]));
    await h.click('#clear-topics');

    expect(h.confirms).toHaveLength(1);
    await until('the clear request', () => h.calls.some((c) => c.path === 'api/topics/clear'));
  });
});

describe('webui page: Escape belongs to what is in front of it', () => {
  const A = 'a1b2c3d4';

  /** Both panels out, so a stray Escape has something visible to put away. */
  const openBoth = async (opts: NonNullable<Parameters<typeof open>[0]> = {}): Promise<Harness> => {
    const h = await open({ width: 1440, height: 900, ...opts });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    expect(h.el('schedules').classList.contains('collapsed')).toBe(false);
    return h;
  };
  const bothOpen = (h: Harness): boolean =>
    !h.el('sidebar').classList.contains('collapsed') && !h.el('schedules').classList.contains('collapsed');
  const esc = async (h: Harness, init: KeyboardEventInit = {}): Promise<void> => {
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', ...init }));
    await tick();
  };

  it('leaves both panels alone when Escape cancels an IME composition', async () => {
    const h = await openBoth();
    // A stored choice first, so a stray close would also be visible in storage.
    await h.click('#collapse-sidebar');
    await h.click('#expand-sidebar');
    expect(h.window.localStorage.getItem('aa_sb_open')).toBe('1');

    const input = h.el('input') as HTMLTextAreaElement;
    input.focus();
    await esc(h, { isComposing: true });

    expect(bothOpen(h)).toBe(true);
    expect(h.window.localStorage.getItem('aa_sb_open')).toBe('1');
    expect(h.window.localStorage.getItem('aa_sched_open')).toBe('1');
  });

  it('stops a recording without putting either panel away', async () => {
    const h = await openBoth({ mic: { types: ['audio/webm;codecs=opus'] } });
    await h.click('#mic');
    await tick();
    expect(h.el('mic').classList.contains('rec')).toBe(true);

    await esc(h);

    expect(h.el('mic').classList.contains('rec')).toBe(false);
    expect(h.recorders[0]!.tracksStopped()).toBe(true);
    // Thrown away, not sent: Escape means cancel.
    expect(h.calls.some((c) => c.path === 'api/send')).toBe(false);
    expect(bothOpen(h)).toBe(true);
  });

  it('closes only the idle dialog when it is the thing in front', async () => {
    const h = await openBoth();
    await h.emit({
      t: 'topics',
      topics: [{ id: A, title: 'here', lastAt: 1000, msgCount: 0, stage: 'idle', live: true }],
    });
    await h.click('#manage-toggle');
    await h.click('#close-idle');
    expect(h.el('idle-dialog').hidden).toBe(false);

    await esc(h);

    expect(h.el('idle-dialog').hidden).toBe(true);
    expect(bothOpen(h)).toBe(true);
  });

  it('closes only the picture when it is the thing in front', async () => {
    const h = await openBoth();
    await h.emit(sync(A, [{ ...message('m1', '<p>here</p>'), file: { name: 'shot.png', url: 'f/abc123', image: true } }], [A]));
    await h.click('#log img.shot');
    expect(h.el('lightbox').hidden).toBe(false);

    await esc(h);

    expect(h.el('lightbox').hidden).toBe(true);
    expect(bothOpen(h)).toBe(true);
  });

  it('closes only the menu when it is the thing in front', async () => {
    const h = await openBoth();
    await h.click('#opts-toggle');
    expect(h.el('opts-menu').hidden).toBe(false);

    await esc(h);

    expect(h.el('opts-menu').hidden).toBe(true);
    expect(bothOpen(h)).toBe(true);
  });

  it('dismisses the command suggestions without touching the panels', async () => {
    const h = await openBoth();
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = '/';
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(h.el('hints').hidden).toBe(false);

    await esc(h);

    expect(h.el('hints').hidden).toBe(true);
    expect(bothOpen(h)).toBe(true);
  });
});

describe('webui page: the scheduled-task panel', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'a1b2c3',
    name: 'Morning CI',
    state: 'active',
    when: '0 8 * * * (Asia/Shanghai)',
    next: '2026-11-05 08:00',
    nextAt: Date.UTC(2026, 10, 5, 0, 0, 0),
    run: 'cc · fixed session',
    target: 'web:main#' + A,
    targetTopic: A,
    runs: 2,
    running: false,
    detail: 'summarise the failures',
    kind: 'agent',
    ...over,
  });
  const listReply = (tasks: Array<Record<string, unknown>>): Record<string, unknown> => ({ enabled: true, tasks });

  it('is closed by default, opens from the header, and draws the list', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]) } });
    await h.emit(sync(A, [], [A]));

    expect(h.el('app').classList.contains('sched-open')).toBe(false);
    expect(h.el('schedules-toggle').getAttribute('aria-expanded')).toBe('false');

    await h.click('#schedules-toggle');

    expect(h.el('app').classList.contains('sched-open')).toBe(true);
    expect(h.el('schedules-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(h.el('schedules-summary').textContent).toBe('1 active');
    expect(h.el('schedules-list').textContent).toContain('Morning CI');
    expect(h.el('schedules-list').textContent).toContain('0 8 * * * (Asia/Shanghai)');
    // The target is resolved against the topic list the page already has, rather than shown as
    // `web:main#…` — the one thing a person cannot read.
    expect(h.el('schedules-list').textContent).toContain('posts to Topic ' + A);
  });

  it('divides the side panel into Scheduled and Reviews outer tabs, with Tasks and Sessions sub-tabs', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/reviews': { reviews: [] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');

    // Outer tabs at the foot
    expect(h.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-scheduled').classList.contains('on')).toBe(true);
    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-tab-reviews').classList.contains('on')).toBe(false);

    // Sub-tabs under the header
    expect(h.el('sched-subnav').hidden).toBe(false);
    expect(h.el('sched-tab-tasks').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-tasks').classList.contains('on')).toBe(true);
    expect(h.el('sched-tab-sessions').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-tab-sessions').classList.contains('on')).toBe(false);

    // Initial content visibility
    expect(h.el('schedules-list').hidden).toBe(false);
    expect(h.el('sched-sessions').hidden).toBe(true);
    expect(h.el('sched-reviews').hidden).toBe(true);

    // Counts on outer tab and sub-tabs
    expect(h.el('sched-tab-scheduled-n').textContent).toBe('1');
    expect(h.el('sched-tab-tasks-n').textContent).toBe('1');
    expect(h.el('sched-tab-sessions-n').textContent).toBe('0');
  });

  it('switches between Tasks and Sessions sub-tabs and outer Reviews tab', async () => {
    const C = 'c3d4e5f6';
    const replies = {
      'api/schedules': listReply([task()]),
      'api/reviews': {
        enabled: true,
        reviews: [{
          id: 'rev1',
          title: 'Reviewed Topic',
          at: 1000,
          outcome: 'nothing',
          changes: [],
          preferences: [],
          topic: A,
        }],
      },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 2, stage: 'idle', scheduled: true },
      ],
    });
    await h.click('#schedules-toggle');

    // Both task count and session count are shown on outer Scheduled tab ('1 · 1')
    expect(h.el('sched-tab-scheduled-n').textContent).toBe('1 · 1');
    expect(h.el('sched-tab-tasks-n').textContent).toBe('1');
    expect(h.el('sched-tab-sessions-n').textContent).toBe('1');

    // Switch to Sessions subtab
    await h.click('#sched-tab-sessions');
    expect(h.el('sched-tab-sessions').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-tasks').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-sessions').hidden).toBe(false);
    expect(h.el('schedules-list').hidden).toBe(true);
    expect(h.window.localStorage.getItem('aa_sched_subtab')).toBe('sessions');
    expect(h.el('schedules-summary').textContent).toContain('1 session');

    // Switch back to Tasks subtab
    await h.click('#sched-tab-tasks');
    expect(h.el('sched-tab-tasks').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-sessions').getAttribute('aria-selected')).toBe('false');
    expect(h.el('schedules-list').hidden).toBe(false);
    expect(h.el('sched-sessions').hidden).toBe(true);
    expect(h.window.localStorage.getItem('aa_sched_subtab')).toBe('tasks');
    expect(h.el('schedules-summary').textContent).toBe('1 active');

    // Switch to Reviews outer tab: outer Scheduled tab still shows '1 · 1'
    await h.click('#sched-tab-reviews');
    await until('reviews list', () => h.el('sched-reviews-list').textContent!.includes('Reviewed Topic'));
    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-tab-scheduled-n').textContent).toBe('1 · 1');
    expect(h.el('sched-tab-reviews-n').textContent).toBe('1');
    expect(h.el('sched-subnav').hidden).toBe(true);
    expect(h.el('sched-reviews').hidden).toBe(false);
    expect(h.el('schedules-list').hidden).toBe(true);
    expect(h.el('sched-sessions').hidden).toBe(true);
    expect(h.window.localStorage.getItem('aa_sched_tab')).toBe('reviews');

    // Switch back to Scheduled outer tab
    await h.click('#sched-tab-scheduled');
    expect(h.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-subnav').hidden).toBe(false);
    expect(h.el('sched-reviews').hidden).toBe(true);
    expect(h.el('schedules-list').hidden).toBe(false);
    expect(h.window.localStorage.getItem('aa_sched_tab')).toBe('scheduled');
  });

  it('shows waiting-on-answer amber alert on outer Scheduled tab and Sessions sub-tab', async () => {
    const C = 'c3d4e5f6';
    const replies = {
      'api/schedules': listReply([task()]),
      'api/reviews': { reviews: [] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');

    expect(h.el('sched-alert').hidden).toBe(true);
    expect(h.el('sched-tab-alert').hidden).toBe(true);
    expect(h.el('sched-sessions-alert').hidden).toBe(true);

    // Scheduled run is waiting on answer
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'answer', asking: true, scheduled: true },
      ],
    });

    expect(h.el('sched-alert').hidden).toBe(false);
    expect(h.el('sched-tab-alert').hidden).toBe(false);
    expect(h.el('sched-sessions-alert').hidden).toBe(false);
    expect(h.el('sched-tab-scheduled').getAttribute('title')).toContain('waiting');
    expect(h.el('sched-tab-sessions').getAttribute('title')).toContain('waiting');

    // Outer alert stays visible even when viewing Reviews tab
    await h.click('#sched-tab-reviews');
    expect(h.el('sched-tab-alert').hidden).toBe(false);

    // Clear waiting state
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 4, stage: 'idle', scheduled: true },
      ],
    });

    expect(h.el('sched-alert').hidden).toBe(true);
    expect(h.el('sched-tab-alert').hidden).toBe(true);
    expect(h.el('sched-sessions-alert').hidden).toBe(true);
  });

  it.each([
    {
      legacyTab: 'sessions',
      expectedTab: 'scheduled',
      expectedSubtab: 'sessions',
      scheduledSelected: 'true',
      reviewsSelected: 'false',
      tasksSelected: 'false',
      sessionsSelected: 'true',
      subnavHidden: false,
      visiblePanel: 'sched-sessions',
    },
    {
      legacyTab: 'tasks',
      expectedTab: 'scheduled',
      expectedSubtab: 'tasks',
      scheduledSelected: 'true',
      reviewsSelected: 'false',
      tasksSelected: 'true',
      sessionsSelected: 'false',
      subnavHidden: false,
      visiblePanel: 'schedules-list',
    },
    {
      legacyTab: 'reviews',
      expectedTab: 'reviews',
      expectedSubtab: 'tasks',
      scheduledSelected: 'false',
      reviewsSelected: 'true',
      tasksSelected: 'false',
      sessionsSelected: 'false',
      subnavHidden: true,
      visiblePanel: 'sched-reviews',
    },
  ] as const)(
    'restores legacy aa_sched_tab = $legacyTab to $expectedTab + $expectedSubtab',
    async ({
      legacyTab,
      scheduledSelected,
      reviewsSelected,
      tasksSelected,
      sessionsSelected,
      subnavHidden,
      visiblePanel,
    }) => {
      const C = 'c3d4e5f6';
      const replies = {
        'api/schedules': listReply([task()]),
        'api/reviews': { enabled: true, reviews: [] },
      };
      const h = await open({
        storage: { aa_sched_tab: legacyTab },
        replies,
      });
      await h.emit(sync(A, [], [A]));
      await h.emit({
        t: 'topics',
        topics: [
          { id: A, title: 'ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
          { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 2, stage: 'idle', scheduled: true },
        ],
      });
      await h.click('#schedules-toggle');

      expect(h.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe(scheduledSelected);
      expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe(reviewsSelected);
      expect(h.el('sched-subnav').hidden).toBe(subnavHidden);
      expect(h.el('sched-tab-tasks').getAttribute('aria-selected')).toBe(tasksSelected);
      expect(h.el('sched-tab-sessions').getAttribute('aria-selected')).toBe(sessionsSelected);
      expect(h.el(visiblePanel).hidden).toBe(false);
    }
  );

  it('stays open across a topic switch and a reload, and a first visit starts closed', async () => {
    const replies = { 'api/schedules': listReply([task()]) };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A, B]));

    // First visit: no stored choice, so the panel is not in the way.
    expect(h.el('app').classList.contains('sched-open')).toBe(false);
    expect(h.window.localStorage.getItem('aa_sched_open')).toBeNull();

    await h.click('#schedules-toggle');
    expect(h.window.localStorage.getItem('aa_sched_open')).toBe('1');

    // Following a topic no longer puts it away.
    await h.click('[data-topic="' + B + '"]');
    expect(h.el('app').classList.contains('sched-open')).toBe(true);

    // What the next page finds: the open choice, not the closed state of some earlier visit.
    const again = await open({ replies, storage: { aa_sched_open: '1' } });
    await again.emit(sync(A, [], [A, B]));
    expect(again.el('app').classList.contains('sched-open')).toBe(true);

    await again.click('#schedules-close');
    expect(again.el('app').classList.contains('sched-open')).toBe(false);
    expect(again.window.localStorage.getItem('aa_sched_open')).toBeNull();
  });

  it('does not restore an open panel where there is nowhere to dock it', async () => {
    const h = await open({ width: 500, storage: { aa_sched_open: '1' } });
    expect(h.el('app').classList.contains('sched-open')).toBe(false);
  });

  it('puts the overlay away after a run, without forgetting it was opened', async () => {
    const C = 'c3d4e5f6';
    const h = await open({ width: 500 });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true },
      ],
    });

    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');
    (h.doc.querySelector('.sess-item') as HTMLElement).click();
    await until('the switch', () => h.window.location.search.includes(C));

    // The overlay has to get out of the way of the chat it opened, but that is not the operator
    // closing the panel: the next wide window still opens it.
    expect(h.el('app').classList.contains('sched-open')).toBe(false);
    expect(h.window.localStorage.getItem('aa_sched_open')).toBe('1');
  });

  it('deletes on the second tap, not the first', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/schedules/op': { ok: true, tasks: [] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    const del = (): HTMLElement => h.doc.querySelector('.sched-acts [data-op="remove"]') as HTMLElement;

    del().click();
    await tick();
    expect(h.calls.some((c) => c.path === 'api/schedules/op')).toBe(false);
    expect(del().textContent).toBe('Delete?');

    del().click();
    await until('the delete request', () => h.calls.some((c) => c.path === 'api/schedules/op'));
    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({ id: 'a1b2c3', action: 'remove' });
    await until('the empty state', () => h.el('schedules-list').textContent!.includes('No scheduled tasks yet'));
  });

  it('shows the daemon sentence when an action is refused, and keeps the list', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/schedules/op': { ok: false, error: '#a1b2c3 is already paused' },
    };
    const h = await open({ replies, status: { 'api/schedules/op': 400 } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');

    (h.doc.querySelector('.sched-acts [data-op="pause"]') as HTMLElement).click();
    await until('the refusal', () => !h.el('schedules-note').hidden);

    expect(h.el('schedules-note').textContent).toBe('#a1b2c3 is already paused');
    expect(h.el('schedules-list').textContent).toContain('Morning CI');
  });

  it('opens a card for the full prompt without treating the tap as an action', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    const card = h.doc.querySelector('.sched-item') as HTMLElement;
    const detail = card.querySelector('.sched-detail') as HTMLElement;

    expect(detail.hidden).toBe(true);
    card.click();
    await tick();

    expect(detail.hidden).toBe(false);
    expect(detail.textContent).toContain('summarise the failures');
    expect(h.calls.some((c) => c.path === 'api/schedules/op')).toBe(false);
  });

  it('closes on Escape', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]) } });
    await h.click('#schedules-toggle');
    expect(h.el('app').classList.contains('sched-open')).toBe(true);

    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();

    expect(h.el('app').classList.contains('sched-open')).toBe(false);
    expect(h.window.localStorage.getItem('aa_sched_open')).toBeNull();
  });

  it('closes on the backdrop, which is how a drawer is dismissed on a phone', async () => {
    const h = await open({ width: 390, height: 844, replies: { 'api/schedules': listReply([task()]) } });
    await h.emit(sync(A, [], [A]));

    // Closed, the drawer is off-screen but laid out: inert is what keeps Tab out of it.
    expect(h.el('schedules').hasAttribute('inert')).toBe(true);
    await h.click('#schedules-toggle');
    expect(h.el('app').classList.contains('sched-open')).toBe(true);
    expect(h.el('schedules').hasAttribute('inert')).toBe(false);
    // The panel is a drawer here, so the dimmed chat behind it is the way out — the one backdrop
    // both edges share, not a second one.
    await h.click('#backdrop');

    expect(h.el('app').classList.contains('sched-open')).toBe(false);
    expect(h.el('schedules').hasAttribute('inert')).toBe(true);
    expect(h.window.localStorage.getItem('aa_sched_open')).toBeNull();
  });

  it('says when the daemon has no task store instead of showing an empty list', async () => {
    const h = await open({ replies: { 'api/schedules': { enabled: false, tasks: [] } } });
    await h.click('#schedules-toggle');
    await until('the disabled note', () => h.el('schedules-list').textContent!.includes('not enabled'));

    expect(h.el('schedules-list').textContent).toContain('Scheduled tasks are not enabled in this daemon');
  });

  it('keeps a scheduled run out of the switcher and lists it under Sessions', async () => {
    const C = 'c3d4e5f6';
    const h = await open({ replies: { 'api/schedules': listReply([task()]) } });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI · 2026-11-04 08:00', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true },
      ],
    });

    // One row, not two: a run is a conversation, but the switcher is where the person's own
    // topics live. The panel is the only place the run is listed.
    expect(h.rows()).toBe(1);
    expect(h.el('topics').textContent).not.toContain('Morning CI');

    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    expect(h.el('sched-sessions').hidden).toBe(false);
    expect(h.el('schedules-list').hidden).toBe(true);
    expect(h.el('sched-tab-sessions').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-sessions').textContent).toContain('Morning CI');
    expect(h.el('sched-sessions').textContent).toContain('3 messages');
    expect(h.el('sched-tab-sessions-n').textContent).toBe('1');

    // A run holding a question has no row in the switcher, so the clock itself has to say so.
    expect(h.el('sched-alert').hidden).toBe(true);
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'answer', asking: true, scheduled: true },
      ],
    });
    expect(h.el('sched-alert').hidden).toBe(false);
    expect(h.el('schedules-toggle').getAttribute('title')).toContain('waiting');
  });

  it('opens a run from the Sessions tab, and remembers which tab was last read', async () => {
    const C = 'c3d4e5f6';
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true },
      ],
    });

    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');
    expect(h.window.localStorage.getItem('aa_sched_tab')).toBe('scheduled');
    expect(h.window.localStorage.getItem('aa_sched_subtab')).toBe('sessions');

    (h.doc.querySelector('.sess-item') as HTMLElement).click();
    await until('the switch', () => h.window.location.search.includes(C));
    // Following the run leaves the panel beside the transcript: it is part of the workspace now,
    // not a side glance that gets out of the way.
    expect(h.el('app').classList.contains('sched-open')).toBe(true);

    const again = await open({ storage: { aa_sched_tab: 'scheduled', aa_sched_subtab: 'sessions' } });
    expect(again.el('sched-tab-sessions').getAttribute('aria-selected')).toBe('true');
    expect(again.el('sched-sessions').hidden).toBe(false);
    expect(again.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe('true');
  });

  it('deletes a run from its row, without switching to it first', async () => {
    const C = 'c3d4e5f6';
    const h = await open({ confirm: true });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true },
      ],
    });

    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');
    (h.doc.querySelector('.sess-del') as HTMLElement).click();
    await until('the delete request', () => h.calls.some((c) => c.path === 'api/topics/delete'));

    expect(h.calls.find((c) => c.path === 'api/topics/delete')?.body).toEqual({ topic: C });
    expect(h.confirms[0]).toContain('Morning CI');
    expect(h.window.location.search).not.toContain(C);
  });

  it('restores a dragged width, and double-clicking the handle returns to the default', async () => {
    const h = await open({ storage: { aa_sched_w: '300' } });
    expect(h.el('schedules').style.getPropertyValue('--pw')).toBe('300px');

    h.doc.getElementById('sched-resize')!.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
    expect(h.el('schedules').style.getPropertyValue('--pw')).toBe('');
    expect(h.window.localStorage.getItem('aa_sched_w')).toBeNull();
  });

  it('drags from its left edge: moving the pointer left widens it', async () => {
    // jsdom has no layout, so pin the right edge where a docked panel's is. The drag measures
    // from that edge; the reversed arithmetic would clamp to the 220px minimum instead of 280.
    const h = await open({ width: 1440, height: 900 });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    h.el('schedules').getBoundingClientRect = () =>
      ({ left: 1024, right: 1280, width: 256, top: 0, bottom: 800, height: 800, x: 1024, y: 0, toJSON: () => ({}) }) as DOMRect;

    const handle = h.el('sched-resize');
    handle.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, clientX: 1024 }));
    h.doc.dispatchEvent(new h.window.MouseEvent('pointermove', { bubbles: true, clientX: 1000 }));
    h.doc.dispatchEvent(new h.window.MouseEvent('pointerup', { bubbles: true, clientX: 1000 }));
    await tick();

    expect(h.el('schedules').style.getPropertyValue('--pw')).toBe('280px');
    expect(h.window.localStorage.getItem('aa_sched_w')).toBe('280');
  });
});

describe('webui page: the Reviews tab', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const at = Date.now() - 2 * 3_600_000;

  const review = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'review:web#main#' + A + ':1',
    title: 'Right sidebar',
    at,
    outcome: 'changed',
    summary: 'updated deploy-check · 1 preference',
    changes: [
      {
        action: 'patch',
        name: 'deploy-check',
        reason: 'two runs forgot the tests',
        applied: true,
        undo: 'talkcode skills revert deploy-check 0001-abc',
      },
      {
        action: 'write-file',
        name: 'ci-logs',
        file: 'references/grep.md',
        applied: false,
        error: 'files may only go in references/',
      },
    ],
    preferences: ['answers lead with the conclusion'],
    invalid: [],
    topic: A,
    ...over,
  });

  const reply = (
    reviews: Array<Record<string, unknown>> = [review()],
    over: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    enabled: true,
    running: true,
    reviews,
    ...over,
  });

  it('lists reviews under a tab of their own, with no daily quota', async () => {
    const h = await open({ replies: { 'api/reviews': reply() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => h.el('sched-reviews-list').textContent!.includes('Right sidebar'));

    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-tasks').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-reviews').hidden).toBe(false);
    expect(h.el('schedules-list').hidden).toBe(true);
    expect(h.el('sched-tab-reviews-n').textContent).toBe('1');
    expect(h.el('schedules-summary').textContent).toBe('1 review');
    // The cap is gone, so there is no counter and no "used up" line to draw.
    expect(h.doc.getElementById('sched-reviews-quota')).toBeNull();
    expect(h.el('sched-reviews').textContent).not.toContain('/10');
    const row = h.doc.querySelector('.rev-item')!;
    expect(row.textContent).toContain('Right sidebar');
    expect(row.textContent).toContain('updated deploy-check · 1 preference');
    // The tab is remembered like the other two.
    expect(h.window.localStorage.getItem('aa_sched_tab')).toBe('reviews');
  });

  it('opens a review for its changes, reasons, undo command and preferences', async () => {
    const h = await open({ replies: { 'api/reviews': reply() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));

    const row = h.doc.querySelector('.rev-item') as HTMLElement;
    expect(row.querySelector('.rev-detail')).toBeNull();
    row.click();
    await tick();

    const detail = h.doc.querySelector('.rev-detail')!;
    expect(detail.textContent).toContain('deploy-check');
    expect(detail.textContent).toContain('two runs forgot the tests');
    expect(detail.textContent).toContain('applied');
    expect(detail.textContent).toContain('refused');
    expect(detail.textContent).toContain('files may only go in references/');
    expect(detail.textContent).toContain('talkcode skills revert deploy-check 0001-abc');
    expect(detail.textContent).toContain('answers lead with the conclusion');
  });

  it('opens the reviewed topic, and offers no link when that topic is gone', async () => {
    const h = await open({ replies: { 'api/reviews': reply() } });
    await h.emit(sync(B, [], [A, B]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));
    (h.doc.querySelector('.rev-item') as HTMLElement).click();
    await tick();

    const openTopic = h.doc.querySelector('.rev-open') as HTMLElement;
    expect(openTopic).not.toBeNull();
    openTopic.click();
    await until('the switch', () => h.window.location.search.includes(A));

    // A review of a topic this page does not have: the row stays, the link does not.
    const gone = await open({ replies: { 'api/reviews': reply([review({ topic: 'deadbeef' })]) } });
    await gone.emit(sync(A, [], [A]));
    await gone.click('#schedules-toggle');
    await gone.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(gone.doc.querySelector('.rev-item')));
    (gone.doc.querySelector('.rev-item') as HTMLElement).click();
    await tick();
    expect(gone.doc.querySelector('.rev-open')).toBeNull();
  });

  it('marks an old review as inferred and leaves its changes unknown', async () => {
    const h = await open({
      replies: {
        'api/reviews': reply([
          review({
            id: 'review:web#main#a1b2c3d4:0',
            outcome: 'proposed',
            summary: '1 change proposed',
            inferred: true,
            changes: [{ action: 'patch', name: 'deploy-check', reason: '补一条' }],
            preferences: [],
          }),
        ]),
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));
    const row = h.doc.querySelector('.rev-item') as HTMLElement;
    expect(row.textContent).toContain('inferred');
    row.click();
    await tick();

    const detail = h.doc.querySelector('.rev-detail')!;
    expect(detail.textContent).toContain('unknown');
    expect(detail.textContent).toContain('whether any of it took effect was not recorded');
  });

  it('says why the list is empty: no reviews yet, review off, or no library', async () => {
    const none = await open({ replies: { 'api/reviews': reply([]) } });
    await none.click('#schedules-toggle');
    await none.click('#sched-tab-reviews');
    await until('the empty note', () => none.el('sched-reviews-list').textContent!.includes('No reviews yet'));
    expect(none.el('sched-reviews-list').textContent).toContain('quiet for an hour');

    const off = await open({ replies: { 'api/reviews': reply([], { running: false }) } });
    await off.click('#schedules-toggle');
    await off.click('#sched-tab-reviews');
    await until('the off note', () => off.el('sched-reviews-list').textContent!.includes('Automatic review is off'));

    const noLibrary = await open({ replies: { 'api/reviews': { enabled: false, running: false, reviews: [] } } });
    await noLibrary.click('#schedules-toggle');
    await noLibrary.click('#sched-tab-reviews');
    await until('the library note', () => noLibrary.el('sched-reviews-list').textContent!.includes('no conversation library'));
  });

  it('asks for the list on a reload that restores the tab and the open panel', async () => {
    const h = await open({
      storage: { aa_sched_open: '1', aa_sched_tab: 'reviews' },
      replies: { 'api/reviews': reply() },
    });
    await h.emit(sync(A, [], [A]));

    expect(h.el('app').classList.contains('sched-open')).toBe(true);
    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('true');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));
    expect(h.calls.some((c) => c.path === 'api/reviews')).toBe(true);
  });

  it('ignores a quota an older daemon still sends', async () => {
    const h = await open({
      replies: { 'api/reviews': reply([review()], { quota: { used: 10, limit: 10, resetsAt: Date.now() + 3_600_000 } }) },
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));

    expect(h.doc.getElementById('sched-reviews-quota')).toBeNull();
    expect(h.el('sched-reviews').textContent).not.toContain('/10');
    expect(h.el('sched-reviews').textContent).not.toContain('quota used up');
  });
});

describe('webui page: the skills page', () => {
  const A = 'a1b2c3d4';
  const MD = '---\nname: deploy-check\ndescription: "Use when checking a deployment"\n---\n\n# Steps\n';
  const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'deploy-check',
    description: 'Use when checking a deployment',
    version: '0123456789ab',
    status: 'active',
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastUsedAt: '2026-11-02T00:00:00.000Z',
    uses: 3,
    agents: ['cc'],
    ...over,
  });
  const detail = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    skill: entry(),
    files: [
      { path: 'SKILL.md', size: MD.length },
      { path: 'references/api.md', size: 3 },
    ],
    file: { path: 'SKILL.md', content: MD, version: '0123456789ab' },
    history: [
      { id: '000000000000002-abcdef', at: '2026-11-02T00:00:00.000Z', action: 'patch', beforeVersion: '0123456789ab', afterVersion: 'fedcba987654' },
      { id: '000000000000001-abcdef', at: '2026-11-01T00:00:00.000Z', action: 'create' },
    ],
    ...over,
  });
  const list = (skills: Array<Record<string, unknown>> = [entry()]): Record<string, unknown> => ({ enabled: true, skills });
  const opReply = (skills: Array<Record<string, unknown>> = [entry()], d: Record<string, unknown> = detail()): Record<string, unknown> => ({
    ok: true,
    skills,
    detail: d,
  });

  it('opens from the sidebar footer and lists status, pin and last use', async () => {
    const h = await open({ replies: { 'api/skills': list([entry({ pinned: true })]) } });
    await h.emit(sync(A, [], [A]));
    expect(h.el('skills').hidden).toBe(true);

    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    expect(h.el('skills').hidden).toBe(false);
    expect(h.el('skills-title').textContent).toBe('Skills');
    expect(h.el('skills-list').textContent).toContain('Active');
    expect(h.el('skills-list').textContent).toContain('pinned');
    expect(h.el('skills-list').textContent).toContain('last used');
    expect(h.el('skills-list').textContent).toContain('3 uses');
  });

  it('opens a skill with its files, editor and history', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    expect(h.calls.find((c) => c.path === 'api/skills/op')?.body).toEqual({ action: 'show', name: 'deploy-check' });
    expect(h.el('skills-detail').textContent).toContain('references/api.md');
    expect(h.el('skills-detail').textContent).toContain('patch');
    expect(h.el('skills-detail').textContent).toContain('Restore this version');
    expect((h.el('skill-text') as HTMLTextAreaElement).value).toBe(MD);
    expect((h.el('skill-path') as HTMLInputElement).value).toBe('SKILL.md');
    expect((h.el('skill-path') as HTMLInputElement).readOnly).toBe(true);
  });

  it('saves SKILL.md with the version the detail carried', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    const next = MD.replace('# Steps', '# Steps\n\nNew line');
    (h.el('skill-text') as HTMLTextAreaElement).value = next;
    (h.doc.querySelector('[data-sop="save"]') as HTMLElement).click();
    await until('the patch', () => h.calls.some((c) => c.body.action === 'patch'));

    expect(h.calls.find((c) => c.body.action === 'patch')?.body).toEqual({
      action: 'patch',
      name: 'deploy-check',
      version: '0123456789ab',
      content: next,
    });
  });

  it('writes a new reference file from the same editor', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    (h.doc.querySelector('[data-sop="new-file"]') as HTMLElement).click();
    (h.el('skill-path') as HTMLInputElement).value = 'references/runbook.md';
    (h.el('skill-text') as HTMLTextAreaElement).value = 'run it';
    (h.doc.querySelector('[data-sop="save"]') as HTMLElement).click();
    await until('the write', () => h.calls.some((c) => c.body.action === 'write-file'));

    expect(h.calls.find((c) => c.body.action === 'write-file')?.body).toEqual({
      action: 'write-file',
      name: 'deploy-check',
      file: 'references/runbook.md',
      content: 'run it',
    });
  });

  it('pins, unpins, and removes a reference file', async () => {
    const ref = { path: 'references/api.md', content: 'API', version: '0123456789ab' };
    const replies: Record<string, unknown> = {
      'api/skills': list(),
      'api/skills/op': opReply([entry()], detail({ file: ref })),
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    // Pin, then unpin. The reply flips between the two so the follow-up show draws the button the
    // operator would see; the assertions are on what the page POSTED, which is the decision.
    replies['api/skills/op'] = opReply([entry({ pinned: true })], detail({ skill: entry({ pinned: true }), file: ref }));
    (h.doc.querySelector('[data-sop="pin"]') as HTMLElement).click();
    await until('the pin', () => h.calls.some((c) => c.body.action === 'pin'));
    expect(h.calls.find((c) => c.body.action === 'pin')?.body).toEqual({ action: 'pin', name: 'deploy-check', pinned: true });
    await until('the Unpin button', () => h.doc.querySelector('[data-sop="pin"]')?.textContent === 'Unpin');

    replies['api/skills/op'] = opReply([entry({ pinned: false })], detail({ file: ref }));
    (h.doc.querySelector('[data-sop="pin"]') as HTMLElement).click();
    await until('the unpin', () => h.calls.filter((c) => c.body.action === 'pin').length === 2);
    expect(h.calls.filter((c) => c.body.action === 'pin')[1]?.body).toEqual({ action: 'pin', name: 'deploy-check', pinned: false });

    // The unpin's own show is still in flight until the button reads "Pin" again; the Remove
    // file control was already on screen from the previous detail, so waiting for it alone would
    // click while the page is still busy and the write would be dropped by design.
    await until('the Pin button back', () => h.doc.querySelector('[data-sop="pin"]')?.textContent === 'Pin');
    await until('the Remove file button', () => Boolean(h.doc.querySelector('[data-sop="remove-file"]')));
    (h.doc.querySelector('[data-sop="remove-file"]') as HTMLElement).click();
    await until('the remove-file', () => h.calls.some((c) => c.body.action === 'remove-file'));
    expect(h.confirms[0]).toContain('references/api.md');
    expect(h.calls.find((c) => c.body.action === 'remove-file')?.body).toEqual({
      action: 'remove-file',
      name: 'deploy-check',
      file: 'references/api.md',
    });
  });

  it('creates a skill from the New form', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    await h.click('#skills-new');
    (h.el('skill-new-name') as HTMLInputElement).value = 'release-check';
    (h.el('skill-new-desc') as HTMLInputElement).value = 'Use before a release';
    (h.el('skill-new-body') as HTMLTextAreaElement).value = '# Steps';
    (h.doc.querySelector('[data-sop="create"]') as HTMLElement).click();
    await until('the create', () => h.calls.some((c) => c.body.action === 'create'));

    expect(h.calls.find((c) => c.body.action === 'create')?.body).toEqual({
      action: 'create',
      name: 'release-check',
      description: 'Use before a release',
      body: '# Steps',
    });
  });

  it('reverts to a recorded version after a confirmation', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    (h.doc.querySelector('[data-revert]') as HTMLElement).click();
    await until('the revert', () => h.calls.some((c) => c.body.action === 'revert'));

    expect(h.confirms[0]).toContain('before this change');
    expect(h.calls.find((c) => c.body.action === 'revert')?.body).toEqual({
      action: 'revert',
      name: 'deploy-check',
      id: '000000000000002-abcdef',
    });
  });

  it('deletes on the second tap, and the Delete is an archive', async () => {
    const archived = entry({ status: 'archived' });
    const replies = {
      'api/skills': list(),
      'api/skills/op': { ok: true, skills: [archived], detail: detail() },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    const del = (): HTMLElement => h.doc.querySelector('[data-sop="archive"]') as HTMLElement;

    del().click();
    await tick();
    expect(h.calls.some((c) => c.body.action === 'archive')).toBe(false);
    expect(del().textContent).toBe('Delete?');

    del().click();
    await until('the archive', () => h.calls.some((c) => c.body.action === 'archive'));
    expect(h.calls.find((c) => c.body.action === 'archive')?.body).toEqual({ action: 'archive', name: 'deploy-check' });
    await until('the archived row', () => h.el('skills-list').textContent!.includes('Archived'));
  });

  it('restores an archived skill from its detail', async () => {
    const archived = entry({ status: 'archived' });
    const replies = {
      'api/skills': list([archived]),
      'api/skills/op': opReply([archived], detail({ skill: archived })),
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('Archived'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    (h.doc.querySelector('[data-sop="restore"]') as HTMLElement).click();
    await until('the restore', () => h.calls.some((c) => c.body.action === 'restore'));
    expect(h.calls.find((c) => c.body.action === 'restore')?.body).toEqual({ action: 'restore', name: 'deploy-check' });
  });

  it('closes on Escape and on the backdrop, and comes back to the list', async () => {
    const h = await open({ replies: { 'api/skills': list(), 'api/skills/op': opReply() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    await h.click('#skills-back');
    expect(h.el('skills-detail').hidden).toBe(true);
    expect(h.el('skills-list').hidden).toBe(false);

    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(h.el('skills').hidden).toBe(true);

    await h.click('#skills-toggle');
    expect(h.el('skills').hidden).toBe(false);
    h.el('skills').click();
    await tick();
    expect(h.el('skills').hidden).toBe(true);
  });

  it('says when the daemon has no skills store instead of showing an empty list', async () => {
    const h = await open({ replies: { 'api/skills': { enabled: false, skills: [] } } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the disabled note', () => h.el('skills-list').textContent!.includes('not enabled'));

    expect(h.el('skills-list').textContent).toContain('Skills are not enabled in this daemon');
  });
});
