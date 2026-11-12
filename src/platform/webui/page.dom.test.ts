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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM, type DOMWindow } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';

import { renderPage, servePage } from './page.js';
import { renderWebToolLines } from '../web-markdown.js';
import { webMessageHtml } from './room.js';

/** One `fetch` the page made, in the shape the assertions care about. */
interface Call {
  path: string;
  body: Record<string, unknown>;
  /** Absent for the page's ordinary GETs and POSTs (`post()` says POST); set for anything else. */
  method?: string;
  /**
   * The body went as bytes (a send carrying files, framed as server.ts readFramedSend reads it).
   * `body` is then that request read back the way the server reads it — files' `data` as base64 —
   * so an assertion about what was sent reads the same either way.
   */
  binary?: boolean;
}

/** A framed send (page.ts `framed`) read back as the server does, into the JSON request's shape. */
function unframe(view: ArrayBufferView): Record<string, unknown> {
  const b = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  const n = b.readUInt32BE(0);
  const head = JSON.parse(b.subarray(4, 4 + n).toString('utf8')) as {
    files: Array<{ name: string; mime: string; size: number }>;
  } & Record<string, unknown>;
  let at = 4 + n;
  const files = head.files.map((f) => {
    const data = b.subarray(at, at + f.size).toString('base64');
    at += f.size;
    return { name: f.name, mime: f.mime, data };
  });
  if (at !== b.length) throw new Error(`framed send: ${b.length - at} bytes unaccounted for`);
  return { ...head, files };
}

/** The stub for the one browser API the whole page is built on. */
interface Stream {
  url: string;
  readyState: number;
  closed: boolean;
  /** lastEventId as a browser hands it over: the id of the newest event that carried one. */
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null;
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

/** What a page did with the picture APIs a real browser has and jsdom does not. */
interface PhotoLog {
  /** Every file whose bytes reached createImageBitmap, in order. */
  decoded: string[];
  /** Every held decode the test let answer. */
  released: string[];
  /** How many canvas encodes were asked for. */
  encoded: number;
  /** The pixel size of every canvas that was encoded, oldest first. */
  encodedSizes: Array<[number, number]>;
  /** How many ImageBitmaps the page closed. */
  closed: number;
  /** Let a held decode answer, the way a phone finishes one a second later. */
  release: (name: string) => void;
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
  /** What the page did with pictures (only with the `photos` option). */
  photos: PhotoLog;
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

/**
 * A browser that can decode and encode pictures, installed before the page's script runs. jsdom
 * has no createImageBitmap and no working canvas, so without this every large picture would take
 * the page's "cannot decode it" path and the shrink itself could not be exercised at all.
 *
 * The encoder is priced rather than real: a blob is `pixels × quality × bytesPerPixel` bytes. That
 * is what makes a 4000×3000 photo come out over 300 KB at quality 0.92 and under it lower down,
 * so the page's bisection has an answer to find. `hold` gates one decode the way a phone takes a
 * moment over a photo; the test releases it with the harness's `photos.release`.
 */
function installPhotos(
  w: any,
  opts: {
    sizes?: Record<string, [number, number] | 'fail'>;
    hold?: string[];
    bytesPerPixel?: number;
    /** iOS Safari: a WebP request is answered with a PNG, silently. */
    noWebp?: boolean;
    /** A probe that says WebP and real-size encodes that answer PNG, as Safari's canvas can. */
    webpLies?: boolean;
    /** A browser with no createImageBitmap whose <img> decodes at this pixel size. */
    viaImg?: [number, number];
  },
  log: PhotoLog
): void {
  const sizes = opts.sizes ?? {};
  const held = new Set(opts.hold ?? []);
  const gates = new Map<string, Array<() => void>>();
  const bytesPerPixel = opts.bytesPerPixel ?? 0.18;
  const bitmap = (size: [number, number]) => ({
    width: size[0],
    height: size[1],
    close: () => {
      log.closed++;
    },
  });
  if (!opts.viaImg) {
    w.createImageBitmap = (file: File) => {
      log.decoded.push(file.name);
      const size = sizes[file.name];
      if (size === 'fail') return Promise.reject(new Error('this browser cannot decode it'));
      const made = bitmap(size ?? [4000, 3000]);
      if (!held.has(file.name)) return Promise.resolve(made);
      return new Promise((resolve) => {
        const waiting = gates.get(file.name) ?? [];
        waiting.push(() => resolve(made));
        gates.set(file.name, waiting);
      });
    };
  }
  log.release = (name: string) => {
    log.released.push(name);
    for (const go of gates.get(name) ?? []) go();
    gates.delete(name);
  };
  // What the page needs of a 2d context, and a toBlob that honours the type it was asked for —
  // Chrome, not iOS Safari, which is the other branch the page has to survive.
  const noop = (): void => {};
  w.HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      fillStyle: '#000',
      fillRect: noop,
      drawImage: noop,
    };
  };
  w.HTMLCanvasElement.prototype.toBlob = function toBlob(
    this: HTMLCanvasElement,
    cb: (b: Blob | null) => void,
    type?: string,
    quality?: number
  ) {
    log.encoded++;
    log.encodedSizes.push([this.width, this.height]);
    const bytes = Math.round(this.width * this.height * (quality ?? 0.92) * bytesPerPixel);
    const realWebp = !opts.noWebp && !(opts.webpLies && this.width * this.height > 1);
    const mime = type === 'image/webp' ? (realWebp ? 'image/webp' : 'image/png') : 'image/jpeg';
    setTimeout(() => cb(new w.Blob([new Uint8Array(bytes)], { type: mime })), 0);
  };
  // The fallback decoder, for a file createImageBitmap refused or a browser without it: a data:
  // URL and an <img>. jsdom never loads an image, so unless a test asks for a working one this
  // says no — the same answer a browser without the codec gives.
  w.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = opts.viaImg ? opts.viaImg[0] : 0;
    height = opts.viaImg ? opts.viaImg[1] : 0;
    set src(_url: string) {
      setTimeout(() => (opts.viaImg ? this.onload?.() : this.onerror?.()), 0);
    }
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
 * What an element shows, with each icon (icons.ts, `ic-<name>`) read as `[name]` — an SVG has no
 * text, so textContent alone would say a starred topic and an unstarred one look the same.
 */
function face(el: Element | null | undefined): string {
  if (!el) return '';
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('svg.ic').forEach((svg) => {
    const name = Array.from(svg.classList).find((c) => c.startsWith('ic-'))?.slice(3) ?? '?';
    svg.replaceWith(`[${name}]`);
  });
  return copy.textContent ?? '';
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
    /** Response headers per path, for the few answers the page reads a header of. */
    heads?: Record<string, Record<string, string>>;
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
     * Paths whose answer arrives with a body that is not JSON: `r.json()` rejects, which is a
     * failure the page has to survive rather than a response it can read.
     */
    badJson?: string[];
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
    /**
     * A browser that can decode and encode pictures (see installPhotos). Absent = jsdom as it is:
     * no createImageBitmap and no canvas, so a large picture is sent as it is.
     */
    photos?: {
      sizes?: Record<string, [number, number] | 'fail'>;
      hold?: string[];
      bytesPerPixel?: number;
      noWebp?: boolean;
      webpLies?: boolean;
      viaImg?: [number, number];
    };
  } = {}
): Promise<Harness> {
  const {
    url = 'http://localhost:8787/',
    width = 1440,
    height = 900,
    replies = {},
    heads = {},
    status = {},
    idb = new IDBFactory(),
    storage = {},
    confirm = true,
    terminal = false,
    terminalEnd = false,
    password = true,
    mic,
    hang = [],
    badJson = [],
    held = {},
    shortenLong = false,
    push,
    photos,
  } = opts;
  const pushLog: PushLog = { unsubscribed: false, listeners: [] };
  const photoLog: PhotoLog = {
    decoded: [],
    released: [],
    encoded: 0,
    encodedSizes: [],
    closed: 0,
    release: () => {},
  };
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
      // jsdom builds its own realm, so its Date is not the one vi.setSystemTime patches. Hand
      // the page this realm's Date: the clock is then fixed for both, which is what a test about
      // "today" and "this month" needs. With real timers the two are the same clock anyway.
      (w as any).Date = Date;
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
        onmessage: ((e: { data: string; lastEventId?: string }) => void) | null = null;
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
      if (photos) installPhotos(w, photos, photoLog);
      if (shortenLong) {
        const real = w.setTimeout.bind(w) as (fn: () => void, ms: number) => number;
        (w as any).setTimeout = (fn: () => void, ms: number): number => {
          if (ms < 10_000) return real(fn, ms);
          longTimers.push(ms);
          return real(fn, 30);
        };
      }
      (w as any).fetch = (path: string, init: { body?: unknown; signal?: AbortSignal; method?: string } = {}) => {
        // A GET (the file reader's) carries no body; recorded as an empty one.
        const bytes = ArrayBuffer.isView(init.body);
        calls.push({
          path,
          body: init.body === undefined ? {} : bytes ? unframe(init.body as ArrayBufferView) : JSON.parse(String(init.body)),
          ...(init.method && init.method !== 'POST' ? { method: init.method } : {}),
          ...(bytes ? { binary: true } : {}),
        });
        if (hang.includes(path)) {
          return new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
            );
          });
        }
        const code = status[path] ?? 200;
        const head = heads[path] ?? {};
        return (held[path] ?? Promise.resolve()).then(() => ({
          ok: code < 400,
          status: code,
          headers: { get: (name: string) => head[name] ?? head[name.toLowerCase()] ?? null },
          json: () =>
            badJson.includes(path)
              ? Promise.reject(new SyntaxError('Unexpected token in JSON'))
              : Promise.resolve(replies[path] ?? {}),
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
    photos: photoLog,
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

/**
 * Open a topic row's ⋯ menu, as a person would. The menu is one box shared by every row, so the
 * selector that follows is the item inside it, not one per row.
 */
async function rowMenu(h: Harness, id: string): Promise<HTMLElement> {
  await h.click(`[data-rm="topic:${id}"]`);
  return h.el('row-menu');
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

  it('draws the lifecycle reactions as icons, and one it has no icon for as itself', async () => {
    const h = await open();
    await h.emit(
      sync('a1b2c3d4', [
        { ...message('m1', '<p>done</p>', true), reactions: ['👀', '✅', '🎉'] },
        { ...message('m2', '<p>failed</p>', true), reactions: ['❌'] },
      ], ['a1b2c3d4'])
    );

    const meta = Array.from(h.doc.querySelectorAll('#log .t'));
    expect(face(meta[0])).toMatch(/ {2}\[eye\] \[done\] 🎉$/);
    expect(face(meta[1])).toMatch(/ {2}\[failed\]$/);
    // Coloured as the emoji were: done green, failed red; seen stays the dim of the line.
    expect(meta[0]?.querySelector('.ic-done')?.classList.contains('tone-ok')).toBe(true);
    expect(meta[1]?.querySelector('.ic-failed')?.classList.contains('tone-err')).toBe(true);
    expect(meta[0]?.querySelector('.ic-eye')?.getAttribute('class')).toBe('ic ic-eye');
  });

  it('draws its own controls as icons, leaving no emoji in the page around the conversation', async () => {
    const h = await open({ terminal: true });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4', 'b2c3d4e5']));

    expect(face(h.el('expand-sidebar'))).toBe('[menu]');
    expect(face(h.el('term-toggle'))).toBe('[terminal]');
    expect(face(h.el('skills-back'))).toBe('[chevronLeft]');
    expect(face(h.el('opts-toggle').querySelector('.opts-gear'))).toBe('[gear]');
    // A control is still named for whoever cannot see it.
    expect(h.el('expand-sidebar').getAttribute('aria-label')).toBe('Show topics');
    expect(h.el('term-toggle').getAttribute('aria-label')).toBe('Terminal');
    // Nothing the page draws itself is an emoji any more (the script and stylesheet hold the
    // glyphs they translate, so they are left out of what is read).
    const shown = h.doc.body.cloneNode(true) as HTMLElement;
    shown.querySelectorAll('script,style').forEach((n) => n.remove());
    expect(shown.textContent).not.toMatch(/[\p{Extended_Pictographic}☰★☆▸▾■✓‹›]/u);
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
    { id: 'c3d4e5f6', title: 'resident', lastAt: 998, live: true, msgCount: 0, dir: { name: 'fleetherd', path: '/w/fleetherd', host: 'uniagent' } },
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
      { id: 'c3d4e5f6', text: 'resident | uniagent · fleetherd', out: '' },
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
      // The session really is gone: the daemon says so to any guarded request.
      const h = await open({ password, status: { 'api/push': 401 } });
      await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4']));
      // The stream opened, so whichever gate was served is out of the way.
      expect(h.el('login').hidden).toBe(true);
      // readyState 2 is "the server refused it", not "the network blipped": the session is gone
      // and the page has to offer the way back in — the field under a password, the reload
      // button under SSO.
      h.live().readyState = 2;
      h.live().onerror?.();
      await until('the gate is up', () => !h.el('login').hidden);
      expect(h.el('app').hidden).toBe(true);
    }
  });

  it('does not take a proxy’s 502 during a restart for a lost session: it tries again', async () => {
    // cloudflared answers 502 while the daemon behind it is down, and EventSource gives up on
    // that exactly as on a 401. Showing the gate there sent the person looking for a token they
    // still had; under SSO it was a page with a Reload button and nothing else.
    const h = await open({ status: { 'api/push': 502 } });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4']));
    const before = h.streams.length;
    h.live().readyState = 2;
    h.live().onerror?.();
    await until('it asked whether the session is still good', () => h.calls.some((c) => c.path === 'api/push'));
    await tick();
    expect(h.el('login').hidden).toBe(true);
    expect(h.el('note').textContent).toBe('Reconnecting...');
    await within('a new stream after a second', 2500, () => h.streams.length > before);
    expect(h.el('app').hidden).toBe(false);
  });
});

describe('webui page: a daemon that restarts under an open page', () => {
  it('reconnects after a bye instead of stopping for good, and takes the whole topic again', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4']));
    const first = h.live();
    await h.emit({ t: 'bye' });
    // Closed by the page, so EventSource does not hammer the port on its own schedule.
    expect(first.closed).toBe(true);
    expect(h.el('note').textContent).toContain('Reconnecting');
    expect(h.el('note').textContent).not.toContain('Reload');
    await within('a new stream after a second', 2500, () => h.streams.length === 2);
    // A new EventSource has no resume point to send, so the daemon that answers sends a full sync.
    expect(h.live().url).toBe('api/events?t=a1b2c3d4');
    // The transcript stayed on screen meanwhile; the restarted daemon's sync takes over — the
    // message it kept from the run before carries that run (g), and lands on the copy on screen.
    expect(h.painted()).toBe(1);
    await h.emit(
      sync('a1b2c3d4', [{ ...message('m1', '<p>hello</p>'), g: 1 }, message('w1', '<p>after</p>')], ['a1b2c3d4'], {
        epoch: 2,
      })
    );
    expect(h.painted()).toBe(2);
    expect(h.el('note').textContent).toBe('');
  });

  it('backs off between attempts, and starts again from a second once a stream opens', async () => {
    const h = await open({ status: { 'api/push': 502 } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const timers: number[] = [];
    const real = h.window.setTimeout.bind(h.window);
    (h.window as any).setTimeout = (fn: () => void, ms: number) => {
      if (ms >= 1000) timers.push(ms);
      return real(fn, 0);
    };
    for (let i = 0; i < 7; i++) {
      // A stream that never opens: the proxy answers 502 every time.
      const s = h.live();
      s.onopen = null;
      s.readyState = 2;
      s.onerror?.();
      const n = h.streams.length;
      await until('the next attempt', () => h.streams.length > n);
    }
    expect(timers).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    // One that opens resets it.
    h.live().onopen?.();
    await h.emit({ t: 'bye' });
    expect(timers[timers.length - 1]).toBe(1000);
  });

  it('offers a reload when the daemon that came back serves a different page', async () => {
    const h = await open({ heads: { '/': { ETag: 'W/"some-other-build"' } } });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4']));
    // The first sync of a page is the daemon that served it: nothing to compare yet.
    expect(h.calls.some((c) => c.method === 'HEAD')).toBe(false);
    expect(h.el('update').hidden).toBe(true);
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4'], { epoch: 2 }));
    await until('it asked which page the daemon serves', () => h.calls.some((c) => c.method === 'HEAD'));
    expect(h.calls.find((c) => c.method === 'HEAD')?.path).toBe('/');
    await until('the offer is up', () => !h.el('update').hidden);
    expect(h.el('update').textContent).toContain('updated');
  });

  it('says nothing when the daemon came back serving this same page, or would not say', async () => {
    const build = servePage('Chat', false).build;
    const answers: Array<Record<string, Record<string, string>>> = [{ '/': { ETag: `W/"${build}"` } }, {}];
    for (const heads of answers) {
      const h = await open({ heads });
      await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
      await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { epoch: 2 }));
      await until('it asked', () => h.calls.some((c) => c.method === 'HEAD'));
      await tick();
      expect(h.el('update').hidden).toBe(true);
    }
  });

  it('keeps the draft when the offer is taken', async () => {
    const h = await open({ heads: { '/': { ETag: 'W/"some-other-build"' } } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { epoch: 2 }));
    await until('the offer is up', () => !h.el('update').hidden);
    (h.el('input') as HTMLTextAreaElement).value = 'half a thought';
    // jsdom does not navigate; what matters is what is on disk when the reload happens.
    try {
      await h.click('#update-reload');
    } catch {
      // jsdom: "Not implemented: navigation".
    }
    expect(JSON.parse(h.window.localStorage.getItem('aa_drafts') ?? '{}').a1b2c3d4).toContain('half a thought');
  });
});

describe('webui page: a tab in the background', () => {
  const setVisible = (h: Harness, visible: boolean): void => {
    Object.defineProperty(h.doc, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
    h.doc.dispatchEvent(new h.window.Event('visibilitychange'));
  };
  /** An event the way a browser delivers one that carried an `id:`. */
  const numbered = async (h: Harness, ev: Record<string, unknown>, id: string): Promise<void> => {
    h.live().onmessage?.({ data: JSON.stringify(ev), lastEventId: id });
    await tick();
  };

  it('closes the stream behind a tab hidden for a while, and resumes from the last event on the way back', async () => {
    // A phone on the table and a desktop tab behind others still received every message and the
    // whole topic list after every message posted anywhere.
    const h = await open({ shortenLong: true });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4']));
    await numbered(h, { t: 'msg', msg: message('m2', '<p>two</p>') }, 'a1b2c3d4.run.7');
    const first = h.live();
    setVisible(h, false);
    await until('the stream is closed', () => first.closed);
    expect(h.longTimers).toContain(15000);
    setVisible(h, true);
    // A new stream, told where the old one got to: the daemon replays what came after it.
    expect(h.streams).toHaveLength(2);
    expect(h.live().url).toBe('api/events?t=a1b2c3d4&last=a1b2c3d4.run.7');
    // And the transcript never left the screen.
    expect(h.painted()).toBe(2);
    expect(h.skeletons()).toBe(0);
  });

  it('leaves the stream alone for a glance at another tab', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4']));
    const first = h.live();
    setVisible(h, false);
    await new Promise((r) => setTimeout(r, 50));
    setVisible(h, true);
    await new Promise((r) => setTimeout(r, 50));
    expect(first.closed).toBe(false);
    expect(h.streams).toHaveLength(1);
  });

  it('does not take the focus when the stream comes back', async () => {
    const h = await open({ shortenLong: true });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const search = h.doc.querySelector<HTMLInputElement>('#topics-filter input');
    expect(search).not.toBeNull();
    search!.focus();
    setVisible(h, false);
    await until('the stream is closed', () => h.streams[0]!.closed);
    setVisible(h, true);
    await tick();
    await tick();
    expect(h.doc.activeElement).toBe(search);
  });

  it('waits for the tab to be looked at before reconnecting after a bye', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    setVisible(h, false);
    await h.emit({ t: 'bye' });
    await new Promise((r) => setTimeout(r, 1300));
    expect(h.streams).toHaveLength(1);
    setVisible(h, true);
    expect(h.streams).toHaveLength(2);
  });
});

describe('webui page: what changed in the topic list', () => {
  const order = (h: Harness): string[] =>
    Array.from(h.doc.querySelectorAll('#topics [data-topic]')).map((n) => n.getAttribute('data-topic') ?? '');
  const row = (id: string, lastAt: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: `Topic ${id}`,
    lastAt,
    running: false,
    msgCount: 0,
    ...extra,
  });

  it('applies the rows it is sent, drops the ones that went, and re-sorts by activity', async () => {
    // The whole list used to come after every message posted anywhere; now only what changed does.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']));
    expect(order(h)).toEqual(['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']);
    // A message in the last one: its row alone, newer than the rest, so it goes to the top.
    await h.emit({ t: 'topic-rows', tv: 2, rows: [row('c3d4e5f6', 5000, { title: 'spoken in', msgCount: 1 })] });
    expect(order(h)).toEqual(['c3d4e5f6', 'a1b2c3d4', 'b2c3d4e5']);
    expect(h.doc.querySelector('[data-topic="c3d4e5f6"]')?.textContent).toContain('spoken in');
    // A new one joins, one goes.
    await h.emit({ t: 'topic-rows', tv: 3, rows: [row('d4e5f6a7', 6000)], gone: ['b2c3d4e5'] });
    expect(order(h)).toEqual(['d4e5f6a7', 'c3d4e5f6', 'a1b2c3d4']);
  });

  it('takes the order it is given when the daemon sends one', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']));
    // A tie the page would have broken the other way.
    await h.emit({
      t: 'topic-rows',
      tv: 2,
      rows: [row('b2c3d4e5', 7000), row('c3d4e5f6', 7000)],
      order: ['c3d4e5f6', 'b2c3d4e5', 'a1b2c3d4'],
    });
    expect(order(h)).toEqual(['c3d4e5f6', 'b2c3d4e5', 'a1b2c3d4']);
  });

  it('leaves a topic that another tab deleted for the next one, as a whole list would', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hi</p>')], ['a1b2c3d4', 'b2c3d4e5']));
    await h.emit({ t: 'topic-rows', tv: 2, rows: [], gone: ['a1b2c3d4'] });
    expect(h.live().url).toBe('api/events?t=b2c3d4e5');
    // Nothing was created to replace it: there was somewhere to go.
    expect(h.calls.map((c) => c.path)).not.toContain('api/topics');
  });

  it('tells the daemon which list it holds when it resumes, so an unchanged one is not sent again', async () => {
    const h = await open({ shortenLong: true });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { tv: 5 }));
    await h.emit({ t: 'topic-rows', tv: 6, rows: [row('a1b2c3d4', 2000)] });
    h.live().onmessage?.({ data: JSON.stringify({ t: 'typing', on: false }), lastEventId: 'a1b2c3d4.run.3' });
    Object.defineProperty(h.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    h.doc.dispatchEvent(new h.window.Event('visibilitychange'));
    await until('the stream is closed', () => h.streams[0]!.closed);
    Object.defineProperty(h.doc, 'visibilityState', { configurable: true, get: () => 'visible' });
    h.doc.dispatchEvent(new h.window.Event('visibilitychange'));
    expect(h.live().url).toBe('api/events?t=a1b2c3d4&last=a1b2c3d4.run.3&tv=6');
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

    await rowMenu(h, 'b2c3d4e5');
    await h.click('[data-rmk="delete"]');

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
        { id: 'a1b2c3d4', title: 'fix the parser', lastAt: 1000, msgCount: 0, dir: { name: 'fleetherd', path: '/home/user/workspace/fleetherd' } },
        { id: 'b2c3d4e5', title: 'bump the image', lastAt: 999, msgCount: 0, dir: { name: 'uniagent', path: '/home/user/workspace/uniagent' } },
      ],
    });

    const dirs = Array.from(h.doc.querySelectorAll('.topic-dir'));
    expect(dirs.map((d) => d.textContent)).toEqual(['fleetherd', 'uniagent']);
    // The column is 240px wide, so the row shows the last segment and the tooltip carries the
    // path that tells two checkouts of one project apart.
    expect(dirs[0]!.getAttribute('title')).toBe('/home/user/workspace/fleetherd');
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
        { id: 'c3d4e5f6', title: '[cc] local', lastAt: 998, msgCount: 0, dir: { name: 'fleetherd', path: '/srv/fleetherd' } },
      ],
    });

    const dirs = Array.from(h.doc.querySelectorAll('.topic-dir'));
    expect(dirs.map((d) => d.textContent)).toEqual(['uniagent · workspace', 'devbox · workspace', 'fleetherd']);
    // The tooltip is the whole address, in the form scp and ssh already taught everyone to read.
    expect(dirs.map((d) => d.getAttribute('title'))).toEqual([
      'uniagent:/home/user/workspace',
      'devbox:/home/user/workspace',
      '/srv/fleetherd',
    ]);
  });

  it('shortens a host-qualified agent tag once the row already names the machine', async () => {
    // A remote agent's id is `<id>@<host>`, and `formatLaneTitle` puts that id in front of every
    // topic name. Left whole it is 15 characters of a 240px column spent on a machine the
    // directory line repeats, which left rows reading "[cbc@uniagent] Deploy A…" (reported
    // 2026-11-03). The part before the `@` is what the operator types to bind the agent.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: '[cbc@uniagent] Deploy A…', lastAt: 1000, msgCount: 0, dir: { name: 'workspace', path: '/home/user/workspace', host: 'uniagent' } },
        // No directory known, so the second line cannot say which machine this is: the tag keeps
        // its host, because it is the only place on the row that names it.
        { id: 'b2c3d4e5', title: '[ag@devbox] 你好', lastAt: 999, msgCount: 0 },
      ],
    });

    const titles = Array.from(h.doc.querySelectorAll('.topic-title'));
    expect(titles.map((t) => t.textContent)).toEqual(['[cbc] Deploy A…', '[ag@devbox] 你好']);
    // Nothing is lost: the name the tag was cut from is on the tag itself, where the abbreviation
    // is, so the row's own tooltip (what a needs-you row says) still covers the rest of the row.
    expect(titles[0]!.querySelector('.topic-tag')?.getAttribute('title')).toBe('[cbc@uniagent] Deploy A…');
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
          title: '[cbc@uniagent] Deploy A…',
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

describe('webui page: the topic filter bar', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const C = 'c3d4e5f6';
  const P = 'd4e5f6a7';
  const K = 'e5f6a7b8';
  const H = 'f6a7b8c9';
  const N = 'b8c9d0e1';
  /** One topic per state, an agent on a host, and a child whose title is the only thing matching. */
  const fleet = (): Array<Record<string, unknown>> => [
    { id: A, title: '[cc] parse the config', lastAt: 1000, msgCount: 0, live: true },
    {
      id: B,
      title: '[cbc] parser tests',
      lastAt: 999,
      msgCount: 0,
      running: true,
      live: true,
      dir: { name: 'uniagent', path: '/srv/uniagent', host: 'devbox' },
    },
    { id: C, title: '[cc] release notes', lastAt: 998, msgCount: 0, starred: true },
    { id: P, title: '[cc] split the refactor', lastAt: 997, msgCount: 0, live: true },
    { id: K, title: '[cbc] parser part one', lastAt: 996, msgCount: 0, parent: P, live: true },
    {
      id: H,
      title: '[ag] deploy',
      lastAt: 995,
      msgCount: 0,
      live: true,
      dir: { name: 'workspace', path: '/home/user/workspace', host: 'uniagent' },
    },
    { id: N, title: '[ag] fix the flaky test', lastAt: 994, msgCount: 0, stage: 'answer', live: true },
  ];
  const ids = (h: Harness): string[] =>
    Array.from(h.doc.querySelectorAll('#topics [data-topic]')).map((n) => n.getAttribute('data-topic') ?? '');
  const type = async (h: Harness, s: string): Promise<void> => {
    const q = h.doc.querySelector('.fb-q') as HTMLInputElement;
    q.value = s;
    q.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await tick();
  };
  const openPanel = async (h: Harness): Promise<void> => {
    await h.click('.fb-filter');
  };
  const toggle = async (h: Harness, group: string, value: string): Promise<void> => {
    await h.click(`.fb-chip[data-fb-group="${group}"][data-fb-value="${value}"]`);
  };
  const withFleet = async (h: Harness): Promise<void> => {
    await h.emit(sync(A, [], [A], { topics: fleet() }));
  };

  it('searches title, agent, directory, path and host, with every word required and no case', async () => {
    const h = await open();
    await withFleet(h);
    expect(ids(h)).toHaveLength(6); // seven topics, one folded under its parent

    await type(h, 'config');
    expect(ids(h)).toEqual([A]);
    await type(h, 'CONFIG');
    expect(ids(h)).toEqual([A]);
    // Two words, both hit the one title.
    await type(h, 'parse config');
    expect(ids(h)).toEqual([A]);
    // One word from a title, one from another topic's title: no topic carries both.
    await type(h, 'config parser');
    expect(ids(h)).toEqual([]);

    // The bracketed agent is searchable, and so is everything the second line shows.
    await type(h, 'cbc');
    // B matches on its own; K matches under P, which brings its whole conversation — folded,
    // exactly as it is without a filter.
    expect(ids(h)).toEqual([B, P]);
    await h.click(`#topics [data-fold="${P}"]`);
    expect(ids(h)).toEqual([B, P, K]);
    await h.click(`#topics [data-fold="${P}"]`);
    await type(h, 'devbox');
    expect(ids(h)).toEqual([B]);
    await type(h, 'srv/uniagent');
    expect(ids(h)).toEqual([B]);
    await type(h, 'workspace');
    expect(ids(h)).toEqual([H]);
  });

  it('keeps a matched sub-agent’s whole conversation, folded exactly as the list has it', async () => {
    const h = await open();
    await withFleet(h);
    // Folded by default: the child is not in the list.
    expect(ids(h)).not.toContain(K);

    await type(h, 'parser part');
    // K is the only match, and the conversation it belongs to is what survives: P, still folded.
    expect(ids(h)).toEqual([P]);
    const parent = h.doc.querySelector(`[data-topic="${P}"]`)!;
    expect(parent.classList.contains('ctx')).toBe(false);
    expect(face(parent.querySelector('[data-fold]'))).toBe('[chevronRight] 1');
    await h.click(`#topics [data-fold="${P}"]`);
    expect(ids(h)).toEqual([P, K]);
    expect(h.doc.querySelector(`[data-topic="${K}"]`)!.classList.contains('ctx')).toBe(false);
    // The fold is the person's, not the search's: clearing leaves the tree open in the whole list.
    await type(h, '');
    expect(ids(h)).toEqual([N, B, A, P, K, H, C]);
  });

  it('keeps every sub-agent when the root is the one that matches', async () => {
    const h = await open();
    await withFleet(h);
    await type(h, 'split the refactor');
    expect(ids(h)).toEqual([P]);
    await h.click(`#topics [data-fold="${P}"]`);
    expect(ids(h)).toEqual([P, K]);
    // The sibling row is not dimmed and the fold count is the tree's own.
    expect(h.doc.querySelector('#topics .ctx')).toBeNull();
    expect(face(h.doc.querySelector(`#topics [data-fold="${P}"]`))).toBe('[chevronDown] 1');
  });

  it('keeps a conversation whole when only its sub-agent matches', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'hit: working', lastAt: 1000, msgCount: 0, running: true, live: true },
        { id: P, title: 'parent', lastAt: 999, msgCount: 0, live: true },
        { id: K, title: 'hit: child', lastAt: 998, msgCount: 0, parent: P, running: true, live: true },
      ],
    });
    await type(h, 'hit');
    // A matched on its own; K matched under P, and P's whole conversation comes with it.
    expect(ids(h)).toEqual([A, P]);
    expect(h.doc.querySelector(`[data-topic="${P}"]`)?.classList.contains('ctx')).toBe(false);
    await h.click(`#topics [data-fold="${P}"]`);
    expect(ids(h)).toEqual([A, P, K]);
  });

  it('orders a filtered list by the list’s own rule, not by what matched', async () => {
    const h = await open();
    await withFleet(h);
    // The whole list, so the filtered one can be compared with it: the decision first, then
    // working, then the resident ones, then no agent.
    expect(ids(h)).toEqual([N, B, A, P, H, C]);
    await type(h, 'parser');
    // The survivors keep the places they hold in the whole list.
    expect(ids(h)).toEqual([B, P]);
  });

  it('unions the values of one group and intersects across groups', async () => {
    const h = await open();
    await withFleet(h);
    await openPanel(h);

    await toggle(h, 'agent', 'cc');
    expect(new Set(ids(h))).toEqual(new Set([A, P, C]));
    await toggle(h, 'agent', 'cbc');
    // P's conversation contains K, the cbc sub-agent, so it matches both agents and comes whole
    // (K is folded under P, as it is without a filter).
    expect(new Set(ids(h))).toEqual(new Set([A, P, C, B]));

    // The two agents are a union; a host narrows the same rows to an intersection.
    await toggle(h, 'host', 'devbox');
    expect(ids(h)).toEqual([B]);
    // The two hosts union; the agent selection still intersects, and neither agent is on uniagent.
    await toggle(h, 'host', 'uniagent');
    expect(ids(h)).toEqual([B]);
    await toggle(h, 'agent', 'cc');
    await toggle(h, 'agent', 'cbc');
    expect(new Set(ids(h))).toEqual(new Set([B, H]));
  });

  it('counts every option by conversation, and says what survived', async () => {
    const h = await open();
    await withFleet(h);
    await openPanel(h);

    const chips = Array.from(h.doc.querySelectorAll('.fb-chip'));
    const count = (group: string, value: string): string | undefined =>
      chips
        .find((c) => c.getAttribute('data-fb-group') === group && c.getAttribute('data-fb-value') === value)
        ?.querySelector('.fb-count')?.textContent ?? undefined;
    // Six conversations, seven topics: P and K are one conversation, so the state chips add up
    // to six and K does not count again under its own agent beyond the tree that holds it.
    expect(count('state', 'needs')).toBe('1');
    expect(count('state', 'running')).toBe('1');
    expect(count('state', 'idle')).toBe('3');
    expect(count('state', 'none')).toBe('1');
    expect(count('agent', 'cc')).toBe('3');
    expect(count('agent', 'cbc')).toBe('2');
    expect(count('agent', 'ag')).toBe('2');
    expect(count('host', '__local')).toBe('4');
    expect(count('host', 'devbox')).toBe('1');
    expect(count('host', 'uniagent')).toBe('1');

    await type(h, 'parser');
    expect(h.doc.querySelector('.fb-sumtext')?.textContent).toBe('Showing 2 of 6');
    expect((h.doc.querySelector('.fb-sum') as HTMLElement).hidden).toBe(false);
    // Two conversations — B, and P with K folded under it — not the two matching topics plus
    // the parent that carries them.
  });

  it('counts a conversation once however many of its topics match', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'parser root', lastAt: 1000, msgCount: 0, live: true },
        { id: K, title: 'parser child', lastAt: 999, msgCount: 0, parent: A, live: true },
        { id: B, title: 'parser other', lastAt: 998, msgCount: 0, live: true },
        { id: C, title: 'unrelated', lastAt: 997, msgCount: 0, live: true },
      ],
    });
    await type(h, 'parser');
    // Three matching topics, two conversations: the tree counts once, the line says two of the
    // three conversations in the list.
    expect(h.doc.querySelector('.fb-sumtext')?.textContent).toBe('Showing 2 of 3');
    expect(ids(h)).toEqual([A, B]);
    await h.click(`#topics [data-fold="${A}"]`);
    expect(ids(h)).toEqual([A, K, B]);
  });

  it('keeps the needs-you block and its divider while a filter is on', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'plain root', lastAt: 1000, msgCount: 0, live: true },
        { id: B, title: 'match one', lastAt: 999, msgCount: 0, live: true },
        { id: N, title: 'match needs', lastAt: 998, msgCount: 0, stage: 'answer', asking: true, running: true, live: true },
      ],
    });
    await type(h, 'match');
    expect(ids(h)).toEqual([N, B]);
    expect(h.doc.querySelector(`[data-topic="${B}"]`)?.classList.contains('after-needs')).toBe(true);
  });

  it('treats a starred sub-agent as a starred conversation', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'root', lastAt: 1000, msgCount: 0, live: true },
        { id: K, title: 'kid', lastAt: 999, msgCount: 0, parent: A, live: true, starred: true },
        { id: B, title: 'other', lastAt: 998, msgCount: 0, live: true },
      ],
    });
    await openPanel(h);
    await toggle(h, 'starred', 'starred');
    // The star is on K; the conversation is A's, and it comes whole.
    expect(ids(h)).toEqual([A]);
    await h.click(`#topics [data-fold="${A}"]`);
    expect(ids(h)).toEqual([A, K]);
  });

  it('draws a parent loop once, and keeps the pair together when either matches', async () => {
    const h = await open();
    await h.emit(sync(C, [], [C]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'loop one', lastAt: 1000, msgCount: 0, parent: B, live: true },
        { id: B, title: 'loop two', lastAt: 999, msgCount: 0, parent: A, live: true },
        { id: C, title: 'other', lastAt: 998, msgCount: 0, live: true },
      ],
    });
    // No root to start from: the first of the loop in the list is drawn as the root, the other
    // folded under it, and C (a real root) is drawn before the loop.
    expect(ids(h)).toEqual([C, A]);
    await type(h, 'loop two');
    // B matched; A is the loop's root, so the pair survives as one conversation.
    expect(ids(h)).toEqual([A]);
    expect(h.doc.querySelector('.fb-sumtext')?.textContent).toBe('Showing 1 of 2');
    await h.click(`#topics [data-fold="${A}"]`);
    expect(ids(h)).toEqual([A, B]);
  });

  it('treats a topic whose parent is gone as a conversation of its own', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'orphan', lastAt: 1000, msgCount: 0, parent: 'ffffffff', live: true },
        { id: B, title: 'other', lastAt: 999, msgCount: 0, live: true },
      ],
    });
    // Its parent is not in the list, so it is a root like any other — and a conversation of one.
    expect(ids(h)).toEqual([A, B]);
    await type(h, 'orphan');
    expect(ids(h)).toEqual([A]);
    expect(h.doc.querySelector('.fb-sumtext')?.textContent).toBe('Showing 1 of 2');
  });

  it('keeps a three-level conversation whole when the deepest topic matches', async () => {
    const D = 'd1d2d3d4';
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'root of all', lastAt: 1000, msgCount: 0, live: true },
        { id: B, title: 'middle', lastAt: 999, msgCount: 0, parent: A, live: true },
        { id: D, title: 'deep match', lastAt: 998, msgCount: 0, parent: B, live: true },
        { id: C, title: 'other', lastAt: 997, msgCount: 0, live: true },
      ],
    });
    await type(h, 'deep match');
    // Only the deepest topic matches; the whole tree survives, folded a level at a time as usual.
    expect(ids(h)).toEqual([A]);
    expect(face(h.doc.querySelector(`#topics [data-fold="${A}"]`))).toBe('[chevronRight] 1');
    await h.click(`#topics [data-fold="${A}"]`);
    expect(ids(h)).toEqual([A, B]);
    expect(face(h.doc.querySelector(`#topics [data-fold="${B}"]`))).toBe('[chevronRight] 1');
    await h.click(`#topics [data-fold="${B}"]`);
    expect(ids(h)).toEqual([A, B, D]);
    expect(h.doc.querySelector('#topics .ctx')).toBeNull();
  });

  it('keeps the ancestors of the topic on screen open inside a filtered tree', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${B}` });
    await h.emit(sync(B, [], [B]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'parent', lastAt: 1000, msgCount: 0, live: true },
        { id: B, title: 'child on screen', lastAt: 999, msgCount: 0, parent: A, live: true },
        { id: C, title: 'other', lastAt: 998, msgCount: 0, live: true },
      ],
    });
    // Without a filter the ancestor is open because the topic on screen is under it; a filter
    // must not fold it back over the row the person is reading.
    expect(ids(h)).toEqual([A, B, C]);
    await type(h, 'parent');
    expect(ids(h)).toEqual([A, B]);
    expect(face(h.doc.querySelector(`#topics [data-fold="${A}"]`))).toBe('[chevronDown] 1');
  });

  it('draws a needs-you sub-agent once when its own root also matches', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'unrelated', lastAt: 1000, msgCount: 0, live: true },
        { id: P, title: 'parent hit', lastAt: 999, msgCount: 0, live: true },
        { id: K, title: 'child asks', lastAt: 998, msgCount: 0, parent: P, stage: 'answer', asking: true, running: true, live: true },
      ],
    });
    // Open the tree first, so the pinned row and the walk under P would both reach K.
    await h.click(`#topics [data-fold="${P}"]`);
    await type(h, 'hit');
    // K is pinned above the block; P follows, and K is not drawn a second time under it.
    expect(ids(h)).toEqual([K, P]);
    expect(h.doc.querySelectorAll(`[data-topic="${K}"]`)).toHaveLength(1);
    expect(h.doc.querySelector(`[data-topic="${P}"]`)?.classList.contains('after-needs')).toBe(true);
  });

  it('drops a selected value the caller no longer offers, and says so by showing everything', async () => {
    const h = await open();
    await withFleet(h);
    await openPanel(h);
    await toggle(h, 'agent', 'cc');
    expect(new Set(ids(h))).toEqual(new Set([A, P, C]));

    // A list where no cc topic survives — the chip that selected it is gone too, and the filter
    // cannot keep hiding rows for a value nobody can see any more.
    await h.emit({ t: 'topics', topics: [fleet()[1]!] });
    expect(ids(h)).toEqual([B]);
    expect(h.doc.querySelector('.fb-chip[data-fb-value="cc"]')).toBeNull();
    expect((h.doc.querySelector('.fb-sum') as HTMLElement).hidden).toBe(true);
  });

  it('restores the keyword, the selection and an open panel after a reload', async () => {
    const h = await open();
    await withFleet(h);
    await openPanel(h);
    await type(h, 'parser');
    await toggle(h, 'agent', 'cbc');

    const saved = h.window.localStorage.getItem('aa_topic_filter');
    expect(saved).toBeTruthy();
    const again = await open({ storage: { aa_topic_filter: saved! } });
    await withFleet(again);

    expect((again.doc.querySelector('.fb-q') as HTMLInputElement).value).toBe('parser');
    expect((again.doc.querySelector('.fb-panel') as HTMLElement).hidden).toBe(false);
    expect(again.doc.querySelector('.fb-chip[data-fb-value="cbc"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(ids(again)).toEqual([B, P]);
    await again.click(`#topics [data-fold="${P}"]`);
    expect(ids(again)).toEqual([B, P, K]);
  });

  it('clears from the summary and from an empty result, and Escape empties the field', async () => {
    const h = await open();
    await withFleet(h);

    await type(h, 'parser');
    await h.click('.fb-sum .fb-clear');
    expect((h.doc.querySelector('.fb-q') as HTMLInputElement).value).toBe('');
    expect(ids(h)).toHaveLength(6);

    await type(h, 'no such topic');
    expect(ids(h)).toEqual([]);
    expect(h.doc.querySelector('.topics-empty')?.textContent).toContain('No matching topics');
    await h.click('.topics-empty .fb-clear');
    expect(ids(h)).toHaveLength(6);

    await type(h, 'parser');
    const q = h.doc.querySelector('.fb-q') as HTMLInputElement;
    q.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(q.value).toBe('');
    expect(ids(h)).toHaveLength(6);
    // The same keystroke must not also put the whole sidebar away behind the field.
    expect(h.el('sidebar').classList.contains('collapsed')).toBe(false);
  });

  it('keeps the caret and the open panel through a repaint the sync causes', async () => {
    const h = await open();
    await withFleet(h);
    await openPanel(h);
    const q = h.doc.querySelector('.fb-q') as HTMLInputElement;
    q.value = 'par';
    q.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await tick();
    q.focus();
    q.setSelectionRange(2, 2);

    // A full sync rebuilds the sidebar underneath a focused field. Nothing in the bar may be
    // replaced or re-valued: the caret is where the person left it and the panel stays open.
    await h.emit(sync(A, [message('m1', '<p>while typing</p>')], [A], { topics: fleet() }));

    expect(h.doc.activeElement).toBe(q);
    expect(q.selectionStart).toBe(2);
    expect((h.doc.querySelector('.fb-panel') as HTMLElement).hidden).toBe(false);
  });

  it('keeps the open topic header, Stop and power while its own row is filtered away', async () => {
    const h = await open({
      url: 'http://localhost:8787/?t=' + A,
      storage: { aa_topic_filter: JSON.stringify({ q: 'parser part', sel: {}, sort: '', dir: '', open: false }) },
    });
    const list = fleet().map((t) => (t.id === A ? { ...t, running: true, msgCount: 3 } : t.id === B ? { ...t, msgCount: 5 } : t));
    await h.emit(sync(A, [message('m1', '<p>a</p>'), message('m2', '<p>b</p>'), message('m3', '<p>c</p>')], [A], { topics: list }));

    // The topic on screen matches nothing, so it has no row; its header is drawn from the list,
    // not from the rows that survived.
    expect(ids(h)).not.toContain(A);
    expect(h.el('topic-title').textContent).toBe('[cc] parse the config');
    expect(h.el('stop-turn').hidden).toBe(false);
    expect(h.el('kill-agent').hidden).toBe(false);

    // B never had a row while the filter was on, but its read mark was still seeded; coming back
    // to the whole list must not badge its entire history.
    await type(h, '');
    expect(h.doc.querySelector(`[data-topic="${B}"] .topic-badge`)).toBeNull();
  });

  it('closes only the panel when Escape is pressed on a chip', async () => {
    const h = await open();
    await withFleet(h);
    await openPanel(h);
    await toggle(h, 'starred', 'plain');
    const chip = h.doc.querySelector('.fb-chip[data-fb-group="starred"][data-fb-value="plain"]') as HTMLElement;
    chip.focus();
    chip.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();

    expect((h.doc.querySelector('.fb-panel') as HTMLElement).hidden).toBe(true);
    expect(h.el('sidebar').classList.contains('collapsed')).toBe(false);
    // The chip is still on: Escape put the panel away, it did not clear the filter.
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(h.doc.activeElement).toBe(h.doc.querySelector('.fb-filter'));
  });

  it('keeps Escape on a pinned chip from closing the panel behind it', async () => {
    const h = await open();
    await withFleet(h);
    // The filter panel is shut; the State row is on the bar.
    expect((h.doc.querySelector('.fb-panel') as HTMLElement).hidden).toBe(true);
    const chip = h.doc.querySelector('.fb-chip[data-fb-value="idle"]') as HTMLElement;
    chip.focus();
    chip.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();

    // Nothing in the bar was open to put away, so the drawer behind it must stay where it is.
    expect(h.el('app').classList.contains('sb-open')).toBe(true);
    expect(h.el('sidebar').classList.contains('collapsed')).toBe(false);
    expect(h.doc.activeElement).toBe(chip);
  });

  it('keeps the State row on the bar with the panel shut, and filters from it', async () => {
    const h = await open();
    await withFleet(h);

    const pins = h.doc.querySelector('.fb-pins') as HTMLElement;
    expect(pins.hidden).toBe(false);
    expect((h.doc.querySelector('.fb-panel') as HTMLElement).hidden).toBe(true);
    // One row of four, in the list's own order, and the panel no longer repeats them.
    const chips = Array.from(pins.querySelectorAll('.fb-chip'));
    expect(chips.map((c) => c.getAttribute('data-fb-value'))).toEqual(['needs', 'running', 'idle', 'none']);
    expect(pins.querySelector('.fb-label')).toBeNull();
    expect(h.doc.querySelector('.fb-panel .fb-chip[data-fb-group="state"]')).toBeNull();
    // The row's word is the short one; the full name and its count stay on the chip for a
    // pointer and a reader.
    expect(chips[0]!.getAttribute('title')).toBe('Needs you');
    expect(chips[0]!.getAttribute('aria-label')).toBe('Needs you 1');
    expect(chips[0]!.querySelector('.fb-chip-label')?.textContent).toBe('Needs');

    await toggle(h, 'state', 'idle');
    expect(ids(h)).toEqual([A, P, H]);
    // Filtering from the row does not open the panel, and the line says what survived.
    expect((h.doc.querySelector('.fb-panel') as HTMLElement).hidden).toBe(true);
    expect(h.doc.querySelector('.fb-sumtext')?.textContent).toBe('Showing 3 of 6');
  });

  it('restores a State choice after a reload, with the row still on the bar', async () => {
    const stored = JSON.stringify({ q: '', sel: { state: ['none'] }, sort: '', dir: '', open: false });
    const h = await open({ storage: { aa_topic_filter: stored } });
    await withFleet(h);

    expect((h.doc.querySelector('.fb-pins') as HTMLElement).hidden).toBe(false);
    expect(h.doc.querySelector('.fb-chip[data-fb-value="none"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(ids(h)).toEqual([C]);
  });

  it('lights the Filter dot for the panel’s groups only', async () => {
    const h = await open();
    await withFleet(h);

    await toggle(h, 'state', 'idle');
    expect(h.doc.querySelector('.fb-sumtext')?.textContent).toBe('Showing 3 of 6');
    // A pinned chip is not hidden state: the dot points at the panel, and the panel has nothing on.
    expect((h.doc.querySelector('.fb-dot') as HTMLElement).hidden).toBe(true);
    expect(h.doc.querySelector('.fb-filter')!.classList.contains('on')).toBe(false);

    await openPanel(h);
    await toggle(h, 'starred', 'plain');
    expect((h.doc.querySelector('.fb-dot') as HTMLElement).hidden).toBe(false);
    expect(h.doc.querySelector('.fb-filter')!.classList.contains('on')).toBe(true);
  });

  it('leaves scheduled runs out of the filter counts and the match total', async () => {
    const h = await open();
    const list = fleet().concat([{ id: 'd0e1f2a3', title: '[zz] nightly', scheduled: true, msgCount: 0, live: true }]);
    await h.emit(sync(A, [], [A], { topics: list }));
    await openPanel(h);

    expect(h.doc.querySelector('.fb-chip[data-fb-value="zz"]')).toBeNull();
    const count = (v: string): string | undefined =>
      h.doc.querySelector(`.fb-chip[data-fb-group="state"][data-fb-value="${v}"] .fb-count`)?.textContent ?? undefined;
    expect([count('needs'), count('running'), count('idle'), count('none')]).toEqual(['1', '1', '3', '1']);

    await type(h, 'parser');
    expect(h.doc.querySelector('.fb-sumtext')?.textContent).toBe('Showing 2 of 6');
  });

  it('does not prune a restored selection before the first list has arrived', async () => {
    const stored = JSON.stringify({ q: 'parser', sel: { agent: ['cbc'] }, sort: '', dir: '', open: false });
    const h = await open({ storage: { aa_topic_filter: stored } });

    // The panel's first frame is Loading: setGroups(null) says so, and a selection restored from
    // storage must survive it exactly as written.
    expect(h.doc.querySelector('.fb-chip[data-fb-value="cbc"]')).toBeNull();
    expect(h.window.localStorage.getItem('aa_topic_filter')).toBe(stored);
    expect((h.doc.querySelector('.fb-q') as HTMLInputElement).value).toBe('parser');

    await withFleet(h);
    expect(h.doc.querySelector('.fb-chip[data-fb-value="cbc"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('says Clear all topics applies to the whole list while a filter is on', async () => {
    const h = await open({ confirm: true });
    await withFleet(h);
    await type(h, 'parser');
    await h.click('#clear-topics');
    expect(h.confirms[0]).toContain('This applies to every topic, not only the ones shown.');
  });

  it('lets Escape reach a running recording instead of swallowing it', async () => {
    const h = await open({ mic: { types: ['audio/webm;codecs=opus'] } });
    await withFleet(h);
    await h.click('#mic');
    await tick();
    expect(h.el('mic').classList.contains('rec')).toBe(true);
    await openPanel(h);

    // Escape is pressed with the focus inside the bar. A recording owns that keystroke: it has
    // to be discarded, and the bar must not fold its panel and stop the event on the way.
    const btn = h.doc.querySelector('.fb-filter') as HTMLElement;
    btn.focus();
    btn.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    await tick();

    expect(h.el('mic').classList.contains('rec')).toBe(false);
    expect(h.recorders[0]!.tracksStopped()).toBe(true);
    expect((h.doc.querySelector('.fb-panel') as HTMLElement).hidden).toBe(false);
  });

  it('lets Escape close a model list that is open over the filter bar', async () => {
    const list = { ok: true, agent: 'cc', current: 'm1', options: [{ value: 'm1', name: 'One' }] };
    const h = await open({ replies: { [`api/models?t=${A}`]: list } });
    await withFleet(h);
    await h.emit({ t: 'status', status: { agent: 'cc', model: 'm1' } });
    await openPanel(h);
    // The model list is opened from the status strip, then the panel from the bar without a
    // bubbling click: a real outside click would put one of them away first, so this is the
    // keyboard order — the popup over a panel the person already had open.
    const chip = h.doc.querySelector('#status .st-model') as HTMLElement;
    chip.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await tick();
    expect(h.el('model-pop').hidden).toBe(false);
    const btn = h.doc.querySelector('.fb-filter') as HTMLElement;
    btn.dispatchEvent(new h.window.MouseEvent('click', { bubbles: false }));
    await tick();
    expect((h.doc.querySelector('.fb-panel') as HTMLElement).hidden).toBe(false);

    btn.focus();
    btn.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();

    expect(h.el('model-pop').hidden).toBe(true);
    expect((h.doc.querySelector('.fb-panel') as HTMLElement).hidden).toBe(false);
  });
});

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

    await rowMenu(h, C);
    await h.click('[data-rmk="star"]');

    expect(h.calls.find((c) => c.path === 'api/topics/star')?.body).toEqual({ topic: C, starred: true });
    // Drawn at once rather than on the broadcast, so a tap on a slow link does not look ignored.
    expect(order(h)).toEqual([C, A, B]);
    // The lit star is a marker on the row now, not a button: starring happens in the menu.
    expect(h.doc.querySelector(`[data-topic="${C}"] .topic-star-mark`)).not.toBeNull();
    expect(h.doc.querySelector(`[data-topic="${A}"] .topic-star-mark`)).toBeNull();
    expect(h.doc.querySelector(`[data-topic="${C}"] .topic-more`)).not.toBeNull();
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

  it('says Clear unstarred topics when only a sub-agent is starred', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A, B]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'parent', lastAt: 1000, msgCount: 0 },
        { id: B, title: 'child', lastAt: 999, msgCount: 0, parent: A, starred: true },
      ],
    });
    // The daemon spares a starred sub-agent like any other topic, so the button must not promise
    // to clear everything.
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear unstarred topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear unstarred topics');
  });

  it('puts the star back and says so when the daemon refuses it', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}`, status: { 'api/topics/star': 404 } });
    await h.emit(sync(A, [], [A, B]));

    await rowMenu(h, B);
    await h.click('[data-rmk="star"]');
    await until('the refusal is on screen', () => h.alerts.length > 0);

    expect(h.doc.querySelector(`[data-topic="${B}"] .topic-star-mark`)).toBeNull();
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

    await rowMenu(h, B);
    await h.click('[data-rmk="delete"]');

    expect(h.confirms.at(-1)).toBe('Delete starred topic "b"?');
  });

  it('places #clear-topics as an icon button inside the header panel-title', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    const headerTitle = h.doc.querySelector('#sidebar-header .panel-title');
    expect(headerTitle).not.toBeNull();
    expect(headerTitle?.querySelector('#sb-tab-topics')?.textContent).toBe('Topics');
    const btn = h.el('clear-topics');
    expect(headerTitle?.contains(btn)).toBe(true);
    expect(btn.classList.contains('btn-icon')).toBe(true);
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(btn.textContent).toBe('');
    expect(btn.getAttribute('title')).toBe('Clear all topics');
    expect(btn.getAttribute('aria-label')).toBe('Clear all topics');
  });

  it('puts Topics | History in the panel-title as two tabs, with #clear-topics after them', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    const headerTitle = h.doc.querySelector('#sidebar-header .panel-title')!;
    const tabs = headerTitle.querySelector('[role="tablist"]')!;
    expect([...tabs.querySelectorAll('[role="tab"]')].map((t) => t.id)).toEqual(['sb-tab-topics', 'sb-tab-history']);
    expect(h.el('sb-tab-topics').getAttribute('aria-controls')).toBe('topics');
    expect(h.el('sb-tab-history').getAttribute('aria-controls')).toBe('history-pane');
    expect(tabs.nextElementSibling).toBe(h.el('clear-topics'));
    // The old window's button is gone: History is a place in the sidebar now, not a window.
    expect(h.doc.getElementById('history-open')).toBeNull();
    expect(h.doc.getElementById('history')).toBeNull();
  });

  it('updates title and aria-label on #clear-topics as stars come and go', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A, B]));
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear all topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear all topics');

    // Star a topic: title/aria-label update to unstarred
    await rowMenu(h, B);
    await h.click('[data-rmk="star"]');
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear unstarred topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear unstarred topics');
    expect(h.el('clear-topics').textContent).toBe('');

    // Unstar: title/aria-label revert to all topics
    await rowMenu(h, B);
    await h.click('[data-rmk="star"]');
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

describe('webui page: a topic held in memory', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  /** An event as a browser delivers one that carried an `id:` — a sync is numbered too. */
  const numbered = async (h: Harness, ev: Record<string, unknown>, id: string): Promise<void> => {
    h.live().onmessage?.({ data: JSON.stringify(ev), lastEventId: id });
    await tick();
  };
  const many = (n: number): Array<Record<string, unknown>> =>
    Array.from({ length: n }, (_, i) => message(`w${i + 1}`, `<p>line ${i + 1}</p>`));

  it('puts a topic back whole and resumes its stream, instead of being sent all of it again', async () => {
    // Back and forth between two long topics was a full sync every time — 85 KB gzipped for 1000
    // messages — because the cache keeps 200 and a switch empties memory.
    const h = await open();
    await numbered(h, sync(A, many(300), [A, B]), `${A}.run.300`);
    await h.click(`[data-topic="${B}"]`);
    await numbered(h, sync(B, [message('b1', '<p>in B</p>')], [A, B]), `${B}.run.1`);
    expect(h.painted()).toBe(1);

    await h.click(`[data-topic="${A}"]`);
    // On screen at once, every one of them, before the stream has said anything.
    expect(h.painted()).toBe(300);
    expect(h.live().url).toBe(`api/events?t=${A}&last=${encodeURIComponent(`${A}.run.300`)}`);
    expect(h.waiting()).not.toBeNull();
    // What was said meanwhile is replayed; then the daemon says the catch-up is over.
    await numbered(h, { t: 'msg', msg: message('w301', '<p>said while away</p>') }, `${A}.run.301`);
    await h.emit({ t: 'resumed' });
    expect(h.painted()).toBe(301);
    expect(h.waiting()).toBeNull();
    expect(h.el('log').lastElementChild?.textContent).toContain('said while away');
  });

  it('takes the whole topic as before when the daemon can no longer resume it', async () => {
    const h = await open();
    await numbered(h, sync(A, many(5), [A, B]), `${A}.run.5`);
    await h.click(`[data-topic="${B}"]`);
    await numbered(h, sync(B, [], [A, B]), `${B}.run.0`);
    await h.click(`[data-topic="${A}"]`);
    expect(h.painted()).toBe(5);
    // The backlog did not reach that far: a sync, which is reconciled over what is on screen.
    await numbered(h, sync(A, many(7).slice(2), [A, B]), `${A}.run.400`);
    expect(h.painted()).toBe(5);
    expect(h.waiting()).toBeNull();
    expect(h.el('log').textContent).not.toContain('line 1');
    expect(h.el('log').textContent).toContain('line 7');
  });

  it('holds nothing for a topic left before its stream said where it was', async () => {
    const h = await open();
    await numbered(h, sync(A, many(3), [A, B]), `${A}.run.3`);
    await h.click(`[data-topic="${B}"]`);
    // Left again before B's sync arrived: there is no position to resume B from.
    await h.click(`[data-topic="${A}"]`);
    await h.click(`[data-topic="${B}"]`);
    expect(h.live().url).toBe(`api/events?t=${B}`);
  });

  it('does not put back a topic held from a daemon that has since restarted', async () => {
    const h = await open();
    await numbered(h, sync(A, many(3), [A, B]), `${A}.run.3`);
    await h.click(`[data-topic="${B}"]`);
    await numbered(h, sync(B, [], [A, B], { epoch: 2 }), `${B}.other.0`);
    await h.click(`[data-topic="${A}"]`);
    expect(h.live().url).toBe(`api/events?t=${A}`);
  });

  it('forgets what it held for a topic the list no longer has', async () => {
    const h = await open();
    await numbered(h, sync(A, many(3), [A, B, 'c3d4e5f6']), `${A}.run.3`);
    await h.click(`[data-topic="${B}"]`);
    await numbered(h, sync(B, [], [A, B, 'c3d4e5f6']), `${B}.run.0`);
    // A goes from the list (deleted in another tab): its held copy goes with it — memory nobody
    // could read again. Listed once more, it is entered like any topic, not put back from memory.
    await h.emit({ t: 'topic-rows', tv: 2, rows: [], gone: [A] });
    await h.emit({ t: 'topics', tv: 3, topics: (sync(B, [], [A, B, 'c3d4e5f6']).topics as unknown[]) });
    await h.click(`[data-topic="${A}"]`);
    expect(h.live().url).toBe(`api/events?t=${A}`);
  });
});

describe('webui page: a topic fetched before it is opened', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const C = 'c3d4e5f6';
  const url = (id: string): string => `api/topic?t=${id}`;
  /** A topic row as the daemon sends it; `stage` is what makes it need a person. */
  const row = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: `Topic ${id}`,
    lastAt: 1000,
    running: false,
    msgCount: 0,
    ...over,
  });
  /** A snapshot as `api/topic` answers one. */
  const snap = (topic: string, messages: Array<Record<string, unknown>>, last: string): Record<string, unknown> => ({
    topic,
    epoch: 1,
    last,
    messages,
  });
  const fetched = (h: Harness, id: string): boolean => h.calls.some((c) => c.path === url(id));

  it('fetches a topic that needs an answer, and opening it paints before the stream says anything', async () => {
    const h = await open({ replies: { [url(B)]: snap(B, [message('w9', '<p>from B</p>')], `${B}.run.4`) } });
    await h.emit(
      sync(A, [message('a1', '<p>in A</p>')], [A, B], { topics: [row(A), row(B, { stage: 'answer', lastAt: 900 })] })
    );
    await within('the prefetch goes out', 2000, () => fetched(h, B));
    await tick();
    expect(h.painted()).toBe(1);

    await h.click(`[data-topic="${B}"]`);
    // The whole point: no sync for B has been sent, and its reply is already on screen.
    expect(h.painted()).toBe(1);
    expect(h.el('log').textContent).toContain('from B');
    // And the stream resumes from the snapshot's id, so only what came after it is replayed.
    expect(h.live().url).toBe(`api/events?t=${B}&last=${encodeURIComponent(`${B}.run.4`)}`);
  });

  it('leaves the topic on screen and a scheduled run alone', async () => {
    const h = await open();
    await h.emit(
      sync(A, [], [A, B, C], {
        topics: [row(A, { stage: 'answer' }), row(B, { stage: 'answer', scheduled: true })],
      })
    );
    await new Promise((r) => setTimeout(r, 600));
    // A is being read already, B is a scheduled lane the switcher does not even list.
    expect(h.calls.filter((c) => c.path.startsWith('api/topic'))).toEqual([]);
  });

  it('fetches the first four that need an answer, and no more', async () => {
    const ids = ['11111111', '22222222', '33333333', '44444444', '55555555', '66666666'];
    const replies: Record<string, unknown> = {};
    for (const id of ids) replies[url(id)] = snap(id, [message(`m${id}`, '<p>x</p>')], `${id}.run.1`);
    const h = await open({ replies });
    await h.emit(sync(A, [], [A, ...ids], { topics: [row(A), ...ids.map((id) => row(id, { stage: 'answer' }))] }));
    await within('four prefetches', 4000, () => ids.filter((id) => fetched(h, id)).length === 4);
    await new Promise((r) => setTimeout(r, 600));
    expect(ids.filter((id) => fetched(h, id))).toEqual(ids.slice(0, 4));
  });

  it('picks the four nearest the top of the sidebar, not the four the daemon listed first', async () => {
    // Questions beat failures, failures beat finished replies, and within one stage the newest
    // is first — the order topicRows draws the needs-you block in. The daemon's own order here is
    // the reverse, so a prefetch that took topics as they came would fetch the wrong four.
    const ans1 = 'a1a1a1a1';
    const ans2 = 'a2a2a2a2';
    const failed = 'f0f0f0f0';
    const rev1 = 'c1c1c1c1';
    const rev2 = 'c2c2c2c2';
    const rev3 = 'c3c3c3c3';
    const replies: Record<string, unknown> = {};
    for (const id of [ans1, ans2, failed, rev1, rev2, rev3]) replies[url(id)] = snap(id, [], `${id}.run.0`);
    const h = await open({ replies });
    await h.emit(
      sync(A, [], [A, rev3, rev2, rev1, failed, ans2, ans1], {
        topics: [
          row(A),
          row(rev3, { stage: 'review', lastAt: 900 }),
          row(rev2, { stage: 'review', lastAt: 950 }),
          row(rev1, { stage: 'review', lastAt: 999 }),
          row(failed, { stage: 'failed', lastAt: 800 }),
          row(ans2, { stage: 'answer', lastAt: 400 }),
          row(ans1, { stage: 'answer', lastAt: 500 }),
        ],
      })
    );
    await within('four prefetches', 4000, () =>
      [ans1, ans2, failed, rev1, rev2, rev3].filter((id) => fetched(h, id)).length === 4
    );
    await new Promise((r) => setTimeout(r, 600));
    // In the order they were fetched, which is the order they sit in the list.
    expect(h.calls.filter((c) => c.path.startsWith('api/topic')).map((c) => c.path)).toEqual(
      [ans1, ans2, failed, rev1].map(url)
    );
  });

  it('fetches it again when a new reply moves the row', async () => {
    const h = await open({ replies: { [url(B)]: snap(B, [message('w1', '<p>one</p>')], `${B}.run.1`) } });
    const list = [row(A), row(B, { stage: 'answer', lastAt: 900 })];
    await h.emit(sync(A, [], [A, B], { topics: list }));
    await within('the first prefetch', 2000, () => fetched(h, B));
    await new Promise((r) => setTimeout(r, 100));

    await h.emit({ t: 'topic-rows', tv: 2, rows: [row(B, { stage: 'answer', lastAt: 1200, msgCount: 2 })] });
    await within('the second prefetch', 2000, () => h.calls.filter((c) => c.path === url(B)).length === 2);
  });

  it('drops an answer that arrives after the person has opened the topic', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = await open({ replies: { [url(B)]: snap(B, [message('w1', '<p>stale</p>')], `${B}.run.1`) }, held: { [url(B)]: gate } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer' })] }));
    await within('the prefetch goes out', 2000, () => fetched(h, B));

    // Opened while the answer was still on the wire, and left again before its stream said
    // where it got to — so nothing else could put B up from memory.
    await h.click(`[data-topic="${B}"]`);
    release();
    await tick();
    await tick();
    await h.click(`[data-topic="${A}"]`);
    await h.click(`[data-topic="${B}"]`);
    expect(h.live().url).toBe(`api/events?t=${B}`);
  });

  it('fetches nothing while the tab is hidden', async () => {
    const h = await open({ replies: { [url(B)]: snap(B, [], `${B}.run.0`) } });
    Object.defineProperty(h.doc, 'visibilityState', { value: 'hidden', configurable: true });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer' })] }));
    await new Promise((r) => setTimeout(r, 600));
    expect(fetched(h, B)).toBe(false);
  });

  it('does not ask again at once when the daemon refused one', async () => {
    const h = await open({ status: { [url(B)]: 500 } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer' })] }));
    await within('the first attempt', 2000, () => fetched(h, B));
    await new Promise((r) => setTimeout(r, 600));
    expect(h.calls.filter((c) => c.path === url(B))).toHaveLength(1);
  });

  it('asks for a topic once, even when the list moves again', async () => {
    // The copy is matched to the row by lastAt. Without that, the next pass reads the copy as
    // missing, fetches it again, and the page never stops asking.
    const h = await open({ replies: { [url(B)]: snap(B, [message('w1', '<p>x</p>')], `${B}.run.1`) } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer' })] }));
    await within('the prefetch', 2000, () => fetched(h, B));
    await new Promise((r) => setTimeout(r, 100));

    // The same row, sent again: another list event must not be read as "this copy is stale".
    await h.emit({ t: 'topic-rows', tv: 2, rows: [row(B, { stage: 'answer' })] });
    await new Promise((r) => setTimeout(r, 600));
    expect(h.calls.filter((c) => c.path === url(B))).toHaveLength(1);
  });

  it('asks again after a restart, even for a topic it had just failed on', async () => {
    // A failure is remembered per row, and a restart moves nothing on the row — so without
    // clearing that memory with the epoch, the new daemon's answer would not be asked for.
    const h = await open({ status: { [url(B)]: 500 } });
    const list = [row(A), row(B, { stage: 'answer' })];
    await h.emit(sync(A, [], [A, B], { topics: list }));
    await within('the failed attempt', 2000, () => fetched(h, B));

    await h.emit(sync(A, [], [A, B], { topics: list, epoch: 2 }));
    await within('the retry', 2000, () => h.calls.filter((c) => c.path === url(B)).length === 2);
  });

  it('starts again after a body that does not parse', async () => {
    const h = await open({ badJson: [url(B)], replies: { [url(C)]: snap(C, [], `${C}.run.0`) } });
    await h.emit(
      sync(A, [], [A, B, C], {
        topics: [row(A), row(B, { stage: 'answer', lastAt: 900 }), row(C, { stage: 'answer', lastAt: 800 })],
      })
    );
    await within('the failed one', 2000, () => fetched(h, B));
    // A rejected r.json() used to leave the pump busy for good, so this second one never came.
    await within('the next one', 2000, () => fetched(h, C));
  });

  it('starts again after a request that never comes back', async () => {
    const hang = [url(B)];
    const h = await open({ hang, shortenLong: true, replies: { [url(C)]: snap(C, [], `${C}.run.0`) } });
    await h.emit(
      sync(A, [], [A, B, C], {
        topics: [row(A), row(B, { stage: 'answer', lastAt: 900 }), row(C, { stage: 'answer', lastAt: 800 })],
      })
    );
    await within('the hung one', 2000, () => fetched(h, B));
    // The 60-second limit is 30 ms here: when it fires the request is aborted and the next starts.
    expect(h.longTimers).toContain(60000);
    await within('the next one', 2000, () => fetched(h, C));
  });

  it('leaves a topic it holds in memory alone, and goes back to it from what it held', async () => {
    const h = await open({ replies: { [url(B)]: snap(B, [message('w1', '<p>from B</p>')], `${B}.run.1`) } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer' })] }));
    await within('the prefetch', 2000, () => fetched(h, B));
    await h.click(`[data-topic="${B}"]`);
    h.live().onmessage?.({ data: JSON.stringify({ t: 'typing', on: false }), lastEventId: `${B}.run.1` });
    await tick();
    await h.click(`[data-topic="${A}"]`);

    // A new reply moves the row, but B is held whole and its stream can resume: a fetch would be
    // a few hundred kilobytes against a few hundred bytes.
    await h.emit({ t: 'topic-rows', tv: 2, rows: [row(B, { stage: 'answer', lastAt: 1200 })] });
    await new Promise((r) => setTimeout(r, 600));
    expect(h.calls.filter((c) => c.path === url(B))).toHaveLength(1);
    await h.click(`[data-topic="${B}"]`);
    expect(h.live().url).toBe(`api/events?t=${B}&last=${encodeURIComponent(`${B}.run.1`)}&tv=2`);
  });

  it('prefers what it held over a copy that landed after the person left', async () => {
    // The fetch was in flight when B was opened and left again, so it lands while B is held: both
    // copies exist, and the held one is the topic this tab actually saw, resumed from its own id.
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = await open({
      replies: { [url(B)]: snap(B, [message('w1', '<p>from the fetch</p>')], `${B}.run.1`) },
      held: { [url(B)]: gate },
    });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer' })] }));
    await within('the prefetch goes out', 2000, () => fetched(h, B));

    await h.click(`[data-topic="${B}"]`);
    h.live().onmessage?.({ data: JSON.stringify({ t: 'msg', msg: message('b1', '<p>in B</p>') }), lastEventId: `${B}.run.7` });
    await tick();
    await h.click(`[data-topic="${A}"]`);
    release();
    await new Promise((r) => setTimeout(r, 20));

    await h.click(`[data-topic="${B}"]`);
    expect(h.live().url).toBe(`api/events?t=${B}&last=${encodeURIComponent(`${B}.run.7`)}`);
  });

  it('takes the echo in a fetched copy over the bubble still saying it was not confirmed', async () => {
    // A send that was in flight when the last page went away comes back as "Not confirmed". If
    // the daemon did receive it, the fetched copy carries the echo — and the copy is the first
    // thing this page sees of the topic, so it has to claim that bubble as a sync does, or the
    // same message is on screen twice and the unsure record is never settled.
    const first = await open({ url: `http://localhost:8787/?t=${B}`, hang: ['api/send'] });
    await first.emit(sync(B, [], [B]));
    await saved();
    (first.el('input') as HTMLTextAreaElement).value = 'on its way';
    await first.click('#composer button[type="submit"]');
    const nonce = first.calls.find((c) => c.path === 'api/send')?.body.nonce as string;
    const storage = { aa_unsent: first.window.localStorage.getItem('aa_unsent')! };
    first.window.close();

    const echo = { ...message('w1', '<div class="raw">on its way</div>', true), nonce };
    const h = await open({
      url: `http://localhost:8787/?t=${A}`,
      idb: first.idb,
      storage,
      replies: { [url(B)]: snap(B, [echo], `${B}.run.1`) },
    });
    expect(h.el('log').textContent).not.toContain('on its way');
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer' })] }));
    await within('the prefetch', 2000, () => fetched(h, B));
    await tick();

    await h.click(`[data-topic="${B}"]`);
    expect(h.painted()).toBe(1);
    expect(h.el('log').textContent).toContain('on its way');
    expect(h.el('log').textContent).not.toContain('Not confirmed');
    expect(h.window.localStorage.getItem('aa_unsent')).toBeNull();
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

    await rowMenu(h, B);
    await h.click('[data-rmk="delete"]');
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
        name: 'buildbox',
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
      'buildbox',
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

describe('webui page: a machine the gateway cannot reach', () => {
  const agents = {
    current: 'cc',
    groups: [
      { name: 'uniagent', agents: [{ id: 'cc', harness: 'claude', kind: 'Claude Code' }] },
      { name: 'laptop', agents: [{ id: 'cc@laptop', harness: 'claude', kind: 'Claude Code' }, { id: 'oc@laptop', harness: 'opencode', kind: 'OpenCode' }] },
    ],
  };
  // A few minutes ago, so the page says it as a time of day.
  const since = Date.now() - 5 * 60_000;
  const at = (ms: number): string => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const laptopDown = [{ name: 'laptop', since }];
  /** Two topics, one on each machine, the shape `topicList` builds with a workdir lookup. */
  const placed = (current: string, messages: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    sync(current, messages, [], {
      topics: [
        { id: 'a1b2c3d4', title: 'Fix the build', lastAt: 1000, running: false, msgCount: current === 'a1b2c3d4' ? messages.length : 0, dir: { name: 'shop-api', path: '/home/user/work/shop-api', host: 'laptop' } },
        { id: 'b2c3d4e5', title: 'Docs', lastAt: 999, running: false, msgCount: 0, dir: { name: 'fleetherd', path: '/home/user/workspace/fleetherd', host: 'uniagent' } },
      ],
      ...extra,
    });
  const row = (h: Harness, id: string): HTMLElement => h.el('topics').querySelector<HTMLElement>(`[data-topic="${id}"]`)!;
  const heading = (h: Harness, name: string): Element | undefined =>
    Array.from(h.el('log').querySelectorAll('.launch-host')).find((e) => e.firstChild?.textContent?.trim() === name);

  it('marks the machine over its agents on a new topic, and still lets one be chosen', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents, offline: laptopDown }));

    expect(face(heading(h, 'laptop')?.querySelector('.off'))).toBe(`[offline]offline since ${at(since)}`);
    expect(heading(h, 'uniagent')?.querySelector('.off')).toBeNull();
    expect(h.el('log').querySelector('.launch-group.off .agent-card')?.getAttribute('data-agent')).toBe('cc@laptop');
    // Dimmed, not disabled: the machine may be back by the time anyone writes.
    await h.click('.agent-card[data-agent="oc@laptop"]');
    expect(h.calls.filter((c) => c.path === 'api/send').map((c) => c.body.text)).toEqual(['/agent oc@laptop']);
  });

  it('follows the machines event while the choice is open, both ways', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));
    expect(h.el('log').querySelector('.launch-group.off')).toBeNull();

    await h.emit({ t: 'machines', offline: laptopDown });
    expect(heading(h, 'laptop')?.querySelector('.off')).not.toBeNull();

    await h.emit({ t: 'machines', offline: [] });
    expect(h.el('log').querySelector('.launch-group.off, .launch-host .off')).toBeNull();
  });

  it('names the only machine when it is the one that is offline', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents: { current: 'cc@laptop', groups: [agents.groups[1]] }, offline: laptopDown }));
    expect(face(heading(h, 'laptop'))).toContain('offline since');
  });

  it('marks the machine in the line of every topic on it, and only those', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=b2c3d4e5' });
    await h.emit(placed('b2c3d4e5', [message('w1', '<p>hi</p>')]));
    expect(row(h, 'a1b2c3d4').querySelector('.topic-off')).toBeNull();

    await h.emit({ t: 'machines', offline: laptopDown });
    const off = row(h, 'a1b2c3d4').querySelector('.topic-off');
    expect(face(off)).toBe('[offline]laptop');
    expect(off?.getAttribute('title')).toContain(`offline since ${at(since)}`);
    // The line still says where the topic is.
    expect(face(row(h, 'a1b2c3d4').querySelector('.topic-dir'))).toBe('[offline]laptop · shop-api');
    expect(row(h, 'b2c3d4e5').querySelector('.topic-off')).toBeNull();

    await h.emit({ t: 'machines', offline: [] });
    expect(h.el('topics').querySelector('.topic-off')).toBeNull();
    expect(row(h, 'a1b2c3d4').querySelector('.topic-dir')?.textContent).toBe('laptop · shop-api');
  });

  it('says above the composer why the topic on screen will not be answered', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(placed('a1b2c3d4', [message('w1', '<p>hi</p>')], { offline: laptopDown }));

    const note = h.el('machine-note');
    expect(note.hidden).toBe(false);
    expect(face(note)).toBe(`[offline]laptop is offline since ${at(since)} — its agents cannot answer until it is back.`);

    // Gone once it is back, and never for a topic on a machine that is up.
    await h.emit({ t: 'machines', offline: [] });
    expect(note.hidden).toBe(true);
    await h.emit({ t: 'machines', offline: laptopDown });
    expect(note.hidden).toBe(false);
    await h.click('[data-topic="b2c3d4e5"]');
    expect(note.hidden).toBe(true);
  });

  it('leaves the line out under the agent cards, whose heading already says it', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(placed('a1b2c3d4', [], { agents, offline: laptopDown }));
    expect(heading(h, 'laptop')?.querySelector('.off')).not.toBeNull();
    expect(h.el('machine-note').hidden).toBe(true);
  });

  it('escapes the machine name, which comes from config.yaml', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    const odd = '<img src=x>';
    await h.emit(
      sync('a1b2c3d4', [message('w1', '<p>hi</p>')], [], {
        topics: [{ id: 'a1b2c3d4', title: 'T', lastAt: 1, running: false, msgCount: 1, dir: { name: 'w', path: '/w', host: odd } }],
        offline: [{ name: odd, since }],
      })
    );
    expect(h.el('topics').querySelector('img')).toBeNull();
    expect(h.el('machine-note').querySelector('img')).toBeNull();
    expect(h.el('machine-note').textContent).toContain(odd);
  });
});

describe('webui page: menus', () => {
  /** A `/cd`-shaped menu: a root, the current directory, two more, and the page controls. */
  const menu = (): Record<string, unknown> => ({
    ...message('m1', '<p>Working dir</p>'),
    buttons: [
      { id: 'wdr:r:0', label: '⌂ workspace' },
      { id: 'wdr:r:1', label: '● fleetherd' },
      { id: 'wdr:r:2', label: 'uniagent' },
      { id: 'wdr:r:3', label: '项目报告归档' },
      { id: 'wdp:r:1', label: '◀ Prev' },
      { id: 'wdp:r:1', label: 'Next ▶' },
    ],
  });
  const cells = (h: Harness, sel: string): string[] => Array.from(h.doc.querySelectorAll(sel)).map(face);

  it('puts the choices in the grid and the page controls on a row of their own under them', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    // Direct children of .btns are the choices; the controls are inside .nav, after them. Paging
    // used to sit in the middle of the list as two more things to pick.
    expect(cells(h, '.btns > button')).toEqual(['[home] workspace', '[dot] fleetherd', 'uniagent', '项目报告归档']);
    expect(cells(h, '.btns > .nav > button')).toEqual(['[chevronLeft] Prev', 'Next [chevronRight]']);
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
    expect(Array.from(lit).map(face)).toEqual(['[dot] fleetherd']);
    // The mark is its own element so it can be coloured — and the root's ⌂ is a mark, not a choice.
    expect(face(lit[0]?.querySelector('.mk'))).toBe('[dot]');
    expect(face(h.doc.querySelector('button[data-btn="wdr:r:0"] .mk'))).toBe('[home]');
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
    // The mark is a 1em icon where its glyph was counted as one column: the menu asks for the
    // difference on top of its widest label, or "☑ APAC" wraps its icon onto a line of its own.
    expect(h.doc.querySelector<HTMLElement>('.btns')?.style.getPropertyValue('--cw')).toBe('4ch');
    expect(h.doc.querySelector<HTMLElement>('.btns')?.style.getPropertyValue('--mk')).toBe('1');
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
    expect(face(link?.querySelector('.set-chev'))).toBe('[chevronRight]');
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
    expect(face(current?.querySelector('.set-check'))).toBe('[check]');
    expect(current?.querySelector('.set-opt-label')?.textContent).toBe('15m');

    const off = h.doc.querySelector('#settings-body button[data-btn="stv:r:0"]');
    expect(off?.classList.contains('on')).toBe(false);
    expect(face(off?.querySelector('.set-check'))).toBe('');
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
    expect(face(button)).toBe('[boxOn] EU');
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
    //
    // This browser is given a decoder that refuses the picture, so it goes as it is: the limit is
    // about the bytes in the body, not about what a canvas could have made of them.
    const h = await open({ hang: ['api/send'], shortenLong: true, photos: { sizes: { 'big.png': 'fail' } } });
    // The page warns that it is sending the original; that is expected here, not test output.
    vi.spyOn(h.window.console, 'warn').mockImplementation(() => {});
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

    await rowMenu(h, T);
    await h.click('[data-rmk="delete"]');
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

  it('sends the files as bytes rather than as base64 in JSON, and text alone as JSON', async () => {
    // Base64 is a third larger than the file: on a 250 kbps uplink a 1 MB photo went from 33 s to 44.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'just words';
    await h.click('#composer button[type="submit"]');
    const words = h.calls.filter((c) => c.path === 'api/send');
    expect(words).toHaveLength(1);
    expect(words[0]!.binary).toBeUndefined();

    h.el('input').dispatchEvent(pasteOf(h, [{ kind: 'file', type: 'image/png', file: image(h, 'image.png', 'image/png') }]));
    await until('the chip is rendered', () => chipNames(h).length > 0);
    (h.el('input') as HTMLTextAreaElement).value = 'and a picture — ✓';
    await h.click('#composer button[type="submit"]');
    const sent = h.calls.filter((c) => c.path === 'api/send')[1]!;
    expect(sent.binary).toBe(true);
    // Read back as the server reads it: the same request the JSON form carried, nonce and all —
    // the text's UTF-8 intact, the file's four bytes exact.
    expect(sent.body).toMatchObject({
      topic: 'a1b2c3d4',
      text: 'and a picture — ✓',
      files: [{ name: 'pasted-1.png', mime: 'image/png', data: 'iVBORw==' }],
    });
    expect(typeof sent.body.nonce).toBe('string');
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
 * A phone writes 3–10 MB for one photo and the upload is the slow half of sending it, so the
 * composer re-encodes a large still before it becomes an attachment. These tests are about what
 * leaves the composer — the name, the bytes — and about the tap on Send that lands while the
 * picture is still being shrunk, which must not send the message without it.
 */
describe('webui page: shrinking a picture before it goes', () => {
  const A = 'a1b2c3d4';

  /** A file of `bytes` bytes; the shrink never reads the contents, only the decoder's answer. */
  const photo = (h: Harness, name: string, type: string, bytes: number): File =>
    new h.window.File([new Uint8Array(bytes)], name, { type });

  /** Attach through the picker, which — unlike a paste — keeps the name the file came with. */
  const attachAll = (h: Harness, list: File[]): void => {
    const picker = h.el('picker');
    Object.defineProperty(picker, 'files', { value: list, configurable: true, writable: true });
    picker.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  const attach = (h: Harness, file: File): void => attachAll(h, [file]);

  const sent = (h: Harness): Array<Record<string, string>> =>
    (h.calls.find((c) => c.path === 'api/send')?.body.files as Array<Record<string, string>>) ?? [];

  const sendIt = async (h: Harness, text = 'look'): Promise<void> => {
    (h.el('input') as HTMLTextAreaElement).value = text;
    await h.click('#composer button[type="submit"]');
  };

  it('leaves a picture already under 300 KB exactly as it was', async () => {
    const h = await open({ photos: {} });
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, 'small.jpg', 'image/jpeg', 100 * 1024));
    await until('the chip', () => chipNames(h).length === 1);
    await sendIt(h);

    // No canvas was ever asked for, and the bytes went as they came.
    expect(h.photos.decoded).toEqual([]);
    expect(h.photos.encoded).toBe(0);
    expect(sent(h)[0]).toMatchObject({ name: 'small.jpg', mime: 'image/jpeg' });
    expect(Buffer.from(sent(h)[0]!.data!, 'base64')).toHaveLength(100 * 1024);
  });

  it('re-encodes a large JPEG as WebP under 300 KB, renaming it to match', async () => {
    const h = await open({ photos: { sizes: { 'IMG_1.JPG': [4000, 3000] } } });
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, 'IMG_1.JPG', 'image/jpeg', 600 * 1024));
    await until('the chip', () => chipNames(h).length === 1);
    expect(chipNames(h)).toEqual(['IMG_1.webp']);
    await sendIt(h);

    const file = sent(h)[0]!;
    expect(file.name).toBe('IMG_1.webp');
    expect(file.mime).toBe('image/webp');
    const bytes = Buffer.from(file.data!, 'base64');
    expect(bytes.length).toBeLessThanOrEqual(300 * 1024);
    expect(bytes.length).toBeLessThan(600 * 1024);
    // The search ran: the top quality was too big, so a lower one had to be found.
    expect(h.photos.encoded).toBeGreaterThan(2);
    expect(h.photos.closed).toBe(1);
    // 4000×3000 is 12 MP, so the area budget lands it on 2048×1536. (The 1×1 WebP probe is the
    // first encode of the page's life, which is why this looks for the first real one.)
    expect(h.photos.encodedSizes.find(([w]) => w > 1)).toEqual([2048, 1536]);
  });

  it('keeps a phone screenshot at its own size and only lowers the quality', async () => {
    // 1170×2532 is 2.96 MP, under the 3.1 MP budget. A long-edge rule shrank it to 946 px and the
    // text with it; by area it keeps every pixel and pays in quality instead.
    const h = await open({ photos: { sizes: { 'shot.png': [1170, 2532] } } });
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, 'shot.png', 'image/png', 600 * 1024));
    await until('the chip', () => chipNames(h).length === 1);
    await sendIt(h);

    const file = sent(h)[0]!;
    expect(file).toMatchObject({ name: 'shot.webp', mime: 'image/webp' });
    expect(Buffer.from(file.data!, 'base64').length).toBeLessThanOrEqual(300 * 1024);
    // Every encode was at the screenshot's own size: not one pixel was resampled.
    const real = h.photos.encodedSizes.filter(([w]) => w > 1);
    expect(real.length).toBeGreaterThan(1);
    expect(real.every(([w, ht]) => w === 1170 && ht === 2532)).toBe(true);
  });

  it('caps one long side at 4096 for a panorama the area budget would let through', async () => {
    // 12000×1000 is 12 MP, so area alone asks for 6144 px wide; the long-side cap holds it to 4096.
    const h = await open({ photos: { sizes: { 'pano.jpg': [12000, 1000] } } });
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, 'pano.jpg', 'image/jpeg', 600 * 1024));
    await until('the chip', () => chipNames(h).length === 1);
    await sendIt(h);

    const real = h.photos.encodedSizes.filter(([w]) => w > 1);
    expect(real.length).toBeGreaterThan(0);
    expect(real[0]).toEqual([4096, 341]);
    expect(Math.max(...real.map(([w]) => w))).toBe(4096);
  });

  it('falls back to JPEG when the browser answers a WebP request with a PNG', async () => {
    // iOS Safari's canvas does exactly this, silently — which is why the encoder checks the blob's
    // own type and not the one it asked for.
    const h = await open({ photos: { sizes: { 'IMG_1.JPG': [4000, 3000] }, noWebp: true } });
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, 'IMG_1.JPG', 'image/jpeg', 600 * 1024));
    await until('the chip', () => chipNames(h).length === 1);
    expect(chipNames(h)).toEqual(['IMG_1.jpg']);
    await sendIt(h);

    expect(sent(h)[0]).toMatchObject({ name: 'IMG_1.jpg', mime: 'image/jpeg' });
    expect(Buffer.from(sent(h)[0]!.data!, 'base64').length).toBeLessThanOrEqual(300 * 1024);
  });

  it('never touches a GIF, however big', async () => {
    const h = await open({ photos: {} });
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, 'loop.gif', 'image/gif', 2 * 1024 * 1024));
    await until('the chip', () => chipNames(h).length === 1);
    await sendIt(h);

    // A canvas would keep one frame and lose the animation, which is the picture.
    expect(h.photos.decoded).toEqual([]);
    expect(sent(h)[0]).toMatchObject({ name: 'loop.gif', mime: 'image/gif' });
    expect(Buffer.from(sent(h)[0]!.data!, 'base64')).toHaveLength(2 * 1024 * 1024);
  });

  it('sends the original when the browser cannot decode the picture', async () => {
    const h = await open({ photos: { sizes: { 'IMG_2.HEIC': 'fail' } } });
    const warn = vi.spyOn(h.window.console, 'warn').mockImplementation(() => {});
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, 'IMG_2.HEIC', 'image/heic', 500 * 1024));
    await until('the chip', () => chipNames(h).length === 1);
    await sendIt(h);

    expect(sent(h)[0]).toMatchObject({ name: 'IMG_2.HEIC', mime: 'image/heic' });
    expect(Buffer.from(sent(h)[0]!.data!, 'base64')).toHaveLength(500 * 1024);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('holds a Send pressed while the picture is still being shrunk, and sends it after', async () => {
    // The decode is held, as a phone takes a moment over a 12 MP HEIC. The chip does not exist
    // yet, so a page that let this send through would send the text alone and drop the picture.
    const h = await open({
      photos: { sizes: { 'IMG_3.HEIC': [4032, 3024] }, hold: ['IMG_3.HEIC'] },
    });
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, 'IMG_3.HEIC', 'image/heic', 3 * 1024 * 1024));
    await until('the decoder was asked', () => h.photos.decoded.length === 1);
    expect(chipNames(h)).toEqual([]);
    expect(h.el('note').textContent).toContain('Compressing');

    await sendIt(h, 'what is this?');
    await tick();
    expect(h.calls.some((c) => c.path === 'api/send')).toBe(false);

    h.photos.release('IMG_3.HEIC');
    await until('the send goes out', () => h.calls.some((c) => c.path === 'api/send'));

    const files = sent(h);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'IMG_3.webp', mime: 'image/webp' });
    expect(h.el('note').textContent).toBe('');
  });

  it('cancels a queued Send when the topic changes, leaving its text and picture in that topic', async () => {
    const B = 'b2c3d4e5';
    const h = await open({
      photos: { sizes: { 'IMG_4.HEIC': [4032, 3024] }, hold: ['IMG_4.HEIC'] },
    });
    await h.emit(sync(A, [], [A, B]));

    attach(h, photo(h, 'IMG_4.HEIC', 'image/heic', 3 * 1024 * 1024));
    await until('the decoder was asked', () => h.photos.decoded.length === 1);
    (h.el('input') as HTMLTextAreaElement).value = 'for A only';
    await h.click('#composer button[type="submit"]');
    expect(h.calls.some((c) => c.path === 'api/send')).toBe(false);

    await h.click(`[data-topic="${B}"]`);
    // The note belongs to the composer A's picture is being shrunk for, not to B's.
    expect(h.el('note').textContent).toBe('');
    // B holds a draft of its own when A's picture lands. A page-global queue sends THIS text —
    // which is the bug the second half of the test exists to catch.
    (h.el('input') as HTMLTextAreaElement).value = 'b draft';

    h.photos.release('IMG_4.HEIC');
    await new Promise((r) => setTimeout(r, 50));
    // The switch cancelled the queued send; nothing went out while the person was elsewhere.
    expect(h.calls.some((c) => c.path === 'api/send')).toBe(false);

    await h.click(`[data-topic="${A}"]`);
    await until('the picture is back with the draft', () => chipNames(h).join() === 'IMG_4.webp');
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('for A only');
    expect(h.calls.some((c) => c.path === 'api/send')).toBe(false);

    await h.click('#composer button[type="submit"]');
    expect(sent(h)).toHaveLength(1);
    expect(h.calls.find((c) => c.path === 'api/send')?.body).toMatchObject({ topic: A, text: 'for A only' });

    // B's draft was there when the picture landed; it must still be there, and never have gone out.
    await h.click(`[data-topic="${B}"]`);
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('b draft');
    expect(h.calls.filter((c) => c.path === 'api/send').map((c) => c.body.text)).toEqual(['for A only']);
  });

  it('does not hold up a send in another topic while a picture is being shrunk', async () => {
    const B = 'b2c3d4e5';
    const h = await open({
      photos: { sizes: { 'IMG_5.HEIC': [4032, 3024] }, hold: ['IMG_5.HEIC'] },
    });
    await h.emit(sync(A, [], [A, B]));

    attach(h, photo(h, 'IMG_5.HEIC', 'image/heic', 3 * 1024 * 1024));
    await until('the decoder was asked', () => h.photos.decoded.length === 1);

    await h.click(`[data-topic="${B}"]`);
    (h.el('input') as HTMLTextAreaElement).value = 'b only';
    await h.click('#composer button[type="submit"]');

    const call = h.calls.find((c) => c.path === 'api/send');
    expect(call?.body).toMatchObject({ topic: B, text: 'b only' });
    expect(call?.body.files).toBeUndefined();
    h.photos.release('IMG_5.HEIC');
  });

  it('shrinks several pictures at once and waits for the last one before sending', async () => {
    const h = await open({
      photos: { sizes: { 'one.jpg': [4000, 3000], 'two.jpg': [4000, 3000] }, hold: ['one.jpg', 'two.jpg'] },
    });
    await h.emit(sync(A, [], [A]));

    attachAll(h, [
      photo(h, 'one.jpg', 'image/jpeg', 600 * 1024),
      photo(h, 'two.jpg', 'image/jpeg', 600 * 1024),
    ]);
    await until('both decoders were asked', () => h.photos.decoded.length === 2);
    await sendIt(h, 'both');
    expect(h.calls.some((c) => c.path === 'api/send')).toBe(false);

    h.photos.release('one.jpg');
    await new Promise((r) => setTimeout(r, 30));
    // One is attached, one is still being encoded: the send still waits for both.
    expect(h.calls.some((c) => c.path === 'api/send')).toBe(false);

    h.photos.release('two.jpg');
    await until('the send goes out', () => h.calls.some((c) => c.path === 'api/send'));
    expect(sent(h).map((f) => f.name).sort()).toEqual(['one.webp', 'two.webp']);
  });

  it('decodes through an <img> when the browser has no createImageBitmap', async () => {
    const h = await open({ photos: { viaImg: [4032, 3024] } });
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, 'IMG_6.HEIC', 'image/heic', 600 * 1024));
    await until('the chip', () => chipNames(h).length === 1);
    expect(chipNames(h)).toEqual(['IMG_6.webp']);
    // No bitmap was ever asked for; the data: URL and the <img> did the decode.
    expect(h.photos.decoded).toEqual([]);
    await sendIt(h);

    expect(sent(h)[0]).toMatchObject({ name: 'IMG_6.webp', mime: 'image/webp' });
    expect(Buffer.from(sent(h)[0]!.data!, 'base64').length).toBeLessThanOrEqual(300 * 1024);
  });

  it('falls back to JPEG when the probe promises WebP but a real encode returns PNG', async () => {
    const h = await open({ photos: { sizes: { 'IMG_7.JPG': [4000, 3000] }, webpLies: true } });
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, 'IMG_7.JPG', 'image/jpeg', 600 * 1024));
    await until('the chip', () => chipNames(h).length === 1);
    expect(chipNames(h)).toEqual(['IMG_7.jpg']);
    await sendIt(h);

    expect(sent(h)[0]).toMatchObject({ name: 'IMG_7.jpg', mime: 'image/jpeg' });
    expect(Buffer.from(sent(h)[0]!.data!, 'base64').length).toBeLessThanOrEqual(300 * 1024);
  });

  it('appends the new extension when the name only looks like it has one', async () => {
    const h = await open({ photos: { sizes: { '2026.11 photo': [4000, 3000] } } });
    await h.emit(sync(A, [], [A]));

    attach(h, photo(h, '2026.11 photo', 'image/jpeg', 600 * 1024));
    await until('the chip', () => chipNames(h).length === 1);
    expect(chipNames(h)).toEqual(['2026.11 photo.webp']);
  });

  it('names the file it could not read instead of dropping it without a word', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    h.window.FileReader.prototype.readAsDataURL = function (this: FileReader) {
      setTimeout(() => (this as any).onerror?.(), 0);
    };

    attach(h, photo(h, 'notes.txt', 'text/plain', 16));
    await until('the note names the file', () => h.el('note').textContent.includes('notes.txt'));
    expect(h.el('note').textContent).toBe('Could not read notes.txt; it was not attached.');
    expect(chipNames(h)).toEqual([]);
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

  it('stacks the two answers under a suggested preference, and sizes both for a thumb', () => {
    const css = renderPage('Chat', false);
    // The panel is 240–380px wide at every screen size, so two buttons beside the suggestion
    // would leave the text a sliver even on a desktop. The base rule puts them on their own row.
    expect(css).toContain('.rev-pitem{display:flex;flex-wrap:wrap');
    expect(css).toContain('.rev-pbody{flex:1 1 100%');
    expect(narrowBlock()).toContain('.rev-adopt,.rev-dismiss{min-height:32px');
  });

  it('measures height in dvh, which is the viewport the URL bar has left', () => {
    const css = narrowBlock();
    expect(css).toContain('html,body{height:100vh;height:100dvh}');
    expect(css).toContain('#input{max-height:30dvh}');
  });

  it('gives the skills page ordinary 32px buttons on a phone, not 44px slabs, and wraps a row\'s switches under it', () => {
    const css = narrowBlock();
    expect(css).toContain('.skill-acts button,.skill-file{min-height:32px;');
    expect(css).toContain('.skill-seg button{min-height:32px;');
    expect(css).toContain('.skill-switch{min-height:32px}');
    expect(css).not.toMatch(/\.skill-[a-z-]+( button)?(,[^{]*)?\{min-height:44px/);
    expect(css).toContain('.skill-main{flex-basis:100%}');
  });

  it('gives the History tab finger-sized rows and buttons, and the read-only bar the composer’s clearance', () => {
    const css = narrowBlock();
    // The search field is the filter bar's, whose 16px rule keeps Safari from zooming in on it.
    expect(renderPage('Chat', false)).toContain('<input id="history-q" class="fb-q"');
    expect(css).toContain('.fb-q{font-size:16px}');
    expect(css).toContain('.hist-item{padding:10px 9px}');
    expect(css).toContain('#history-go{min-width:36px;height:36px');
    expect(css).toContain('#history-more{min-height:44px');
    // Where the composer was, the bar's two buttons a thumb has to hit and the home indicator.
    expect(css).toContain('.lib-acts button{min-height:44px');
    expect(css).toContain('#lib-bar{padding:8px 12px calc(10px + env(safe-area-inset-bottom,0px))}');
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

  it('splits the composer by its own width, not the window, when the sidebar leaves it narrow', () => {
    // 2.39.0 split the composer at 640px of *window*, which is one pixel too high a bar for the
    // case that needed it: at 641px the sidebar is still a 240px column, so the composer is 369px
    // and the three buttons that are always there left the input 213px. The window cannot tell
    // that apart from a 1024px window with both panels docked — 512px of composer — because the
    // narrower composer belongs to the wider window. Hence a container query on the composer,
    // not a media query.
    const html = renderPage('Chat', false);
    expect(html).toContain('#composer{container-type:inline-size}');
    expect(html).not.toContain('@media(max-width:480px)');
    const css = blockAt('@container (max-width:480px){');
    expect(css).toContain('#row{flex-wrap:wrap}');
    expect(css).toContain('#input{width:100%;flex:0 0 100%}');
    expect(css).toContain('#row button[type="submit"]{margin-left:auto}');
    expect(css).toContain('#row #stop-turn:not([hidden]){margin-left:auto}');
    expect(css).toContain('#row #stop-turn:not([hidden])+button[type="submit"]{margin-left:0}');
    // And it stands on its own: nested inside the phone block it would still match every
    // assertion above, while a 641–752px window lost the rule entirely and went back to one
    // squeezed row. The phone block is a viewport query; this one is the composer's.
    expect(narrowBlock()).not.toContain('@container');
    // The phone block keeps its own copy: at 640px the sidebar is a drawer and the composer is
    // 616px, wider than this query's threshold, and two rows are the layout a phone shipped with.
    expect(narrowBlock()).toContain('#row{flex-wrap:wrap}');
  });

  it('moves the filter bar sort pair to its own line in a narrow panel', () => {
    // The scheduled panel is 240–320px at every window size, so the bar's own width is what
    // decides this — a viewport query never could. Same shape as the composer's container rule.
    const html = renderPage('Chat', false);
    expect(html).toMatch(/\.filterbar\{[^}]*container-type:inline-size/);
    const css = blockAt('@container (max-width:360px){');
    expect(css).toContain('.fb-row{flex-wrap:wrap}');
    expect(css).toContain('.fb-tools{flex-basis:100%;justify-content:flex-end}');
    // It stands on its own, outside the phone block: a wide window with a narrow panel needs it.
    expect(narrowBlock()).not.toContain('@container');
    // The sort select is a field too; Safari zooms the page in under 16px and stays there.
    expect(narrowBlock()).toContain('.fb-sort select{font-size:16px;max-width:140px}');
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

describe('webui page: the row control that only a pointer can reveal', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';

  /**
   * The `@media(hover:hover)` block, as text, for the reasons `narrowBlock` gives — and one more:
   * what is being pinned is a layout (whether a control takes up room in a row), and jsdom has no
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

  it('carries one ⋯ per row, and a lit star as a marker on a starred row', async () => {
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
      expect(acts?.querySelector(`[data-rm="topic:${id}"]`)).not.toBeNull();
      // The star and the × are items in the menu now; neither is a button on the row.
      expect(acts?.querySelector('[data-star]')).toBeNull();
      expect(acts?.querySelector('[data-del]')).toBeNull();
    }
    // What the stylesheet keys a starred row's resting layout on, and the marker it shows there.
    expect(h.doc.querySelector(`[data-topic="${B}"]`)?.classList.contains('starred')).toBe(true);
    expect(h.doc.querySelector(`[data-topic="${A}"]`)?.classList.contains('starred')).toBe(false);
    expect(h.doc.querySelector(`[data-topic="${B}"] .topic-star-mark`)).not.toBeNull();
    expect(h.doc.querySelector(`[data-topic="${A}"] .topic-star-mark`)).toBeNull();

    // Starring repaints at once, so the class — and the marker — follow the click rather than the
    // broadcast; the control that did it was the menu's item.
    await rowMenu(h, A);
    await h.click('[data-rmk="star"]');
    expect(h.doc.querySelector(`[data-topic="${A}"]`)?.classList.contains('starred')).toBe(true);
    expect(h.doc.querySelector(`[data-topic="${A}"] .topic-star-mark`)).not.toBeNull();
  });

  it('floats the control over the row on a pointer device instead of reserving room for it', () => {
    // The bug: opacity:0 buttons that still sat in the row, so every title was cut short in front
    // of an empty strip. Out of the layout, and lit only under the pointer or keyboard focus.
    const css = hoverBlock();
    expect(css).toContain('.topic-acts{position:absolute;');
    expect(css).toContain('opacity:0;pointer-events:none');
    expect(css).toContain('.topic-item:hover .topic-acts,.topic-item:focus-within .topic-acts{opacity:1;pointer-events:auto}');
    // The fade has to end in the row's own colour, or it draws a band across the title.
    expect(css).toContain('linear-gradient(90deg,transparent,var(--row-bg) 18px)');
  });

  it('puts a starred row' + "'s lit star back in the layout, and drops its hidden ⋯ from it", () => {
    const css = hoverBlock();
    expect(css).toContain('#topics .topic-item.starred:not(:hover):not(:focus-within) .topic-acts{position:static;');
    expect(css).toContain('#topics .topic-item.starred:not(:hover):not(:focus-within) .topic-more{display:none}');
  });

  it('leaves a touch screen' + "'s rows as they were: no hover, so the control stays in the row", () => {
    const html = renderPage('Chat', false);
    const block = hoverBlock();
    // Outside the hover block the box is an ordinary member of the row, and the ⋯ is dimmed
    // rather than hidden — there is no pointer to reveal it with.
    const outside = html.replace(block, '');
    expect(outside).toContain('.topic-acts{display:flex;align-items:center;gap:4px;flex-shrink:0}');
    expect(outside).toContain('@media(hover:none){.topic-more{opacity:.55}}');
    expect(outside).not.toMatch(/\.topic-acts\{[^}]*position:absolute/);
    expect(block.slice('@media'.length)).not.toContain('@media');
  });
});

describe('webui page: a topic row' + "'s ⋯ menu", () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const C = 'c3d4e5f6';
  const D = 'd4e5f6a7';
  /** A parent, a child, a grandchild, and an unrelated topic; each flag set by the test. */
  const fleet = (over: Record<string, Record<string, unknown>> = {}): Array<Record<string, unknown>> =>
    [
      { id: A, title: 'parent', lastAt: 1000, live: true, msgCount: 0 },
      { id: B, title: 'child', lastAt: 999, live: true, parent: A, msgCount: 0 },
      { id: C, title: 'grandchild', lastAt: 998, live: true, parent: B, msgCount: 0 },
      { id: D, title: 'other', lastAt: 997, live: false, msgCount: 0 },
    ].map((t) => ({ ...t, ...(over[t.id as string] ?? {}) }));

  it('opens from a row without switching topic, with the three actions in it', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });

    await rowMenu(h, D);
    const menu = h.el('row-menu');
    expect(menu.hidden).toBe(false);
    expect(menu.getAttribute('role')).toBe('menu');
    expect(h.el('topics').contains(menu)).toBe(false);
    expect(h.live().url).toBe(`api/events?t=${A}`);
    expect(h.doc.querySelector(`[data-rm="topic:${D}"]`)?.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual([
      'Star',
      'End agent',
      'Delete topic',
    ]);
    // An icon from IC, never an emoji: the same three the page draws elsewhere.
    expect(menu.querySelector('[data-rmk="star"] .ic-star')).not.toBeNull();
    expect(menu.querySelector('[data-rmk="end"] .ic-power')).not.toBeNull();
    expect(menu.querySelector('[data-rmk="delete"] .ic-trash')).not.toBeNull();
    expect(menu.querySelector('[role="separator"]')).not.toBeNull();
    // The first item holds the focus, so the keyboard is already inside the menu.
    expect(h.doc.activeElement).toBe(menu.querySelector('[data-rmk="star"]'));

    // One at a time: another row's ⋯ moves the one box rather than opening a second. B is under
    // A, and sub-agents start folded.
    await h.click(`#topics [data-fold="${A}"]`);
    await rowMenu(h, B);
    expect(h.doc.querySelectorAll('#row-menu')).toHaveLength(1);
    expect(h.doc.querySelector(`[data-rm="topic:${D}"]`)?.getAttribute('aria-expanded')).toBe('false');
    expect(h.doc.querySelector(`[data-rm="topic:${B}"]`)?.getAttribute('aria-expanded')).toBe('true');
  });

  it('stars and deletes from the menu, which closes after either', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });

    await rowMenu(h, D);
    await h.click('[data-rmk="star"]');
    expect(h.calls.find((c) => c.path === 'api/topics/star')?.body).toEqual({ topic: D, starred: true });
    expect(h.el('row-menu').hidden).toBe(true);
    expect(h.doc.querySelector(`[data-topic="${D}"] .topic-star-mark`)).not.toBeNull();

    // The same item reads Unstar while the topic is starred.
    await rowMenu(h, D);
    expect(h.doc.querySelector('[data-rmk="star"]')?.textContent).toBe('Unstar');
    await h.click('[data-rmk="delete"]');
    expect(h.confirms.at(-1)).toBe('Delete starred topic "other"?');
    expect(h.calls.find((c) => c.path === 'api/topics/delete')?.body).toEqual({ topic: D });
    expect(h.el('row-menu').hidden).toBe(true);
  });

  it('closes on Escape — focus back on the ⋯ — and on a click outside', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });
    await h.click(`#topics [data-fold="${A}"]`);

    await rowMenu(h, B);
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.el('row-menu').hidden).toBe(true);
    expect(h.doc.activeElement).toBe(h.doc.querySelector(`[data-rm="topic:${B}"]`));

    await rowMenu(h, B);
    await h.click('#topic-title');
    expect(h.el('row-menu').hidden).toBe(true);
    expect(h.doc.querySelector(`[data-rm="topic:${B}"]`)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when the focus leaves it — Tab — and keeps the ⋯ in step', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });
    await h.click(`#topics [data-fold="${A}"]`);
    await rowMenu(h, B);
    const menu = h.el('row-menu');
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const leave = (to: Element): void => {
      menu.dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: to }));
    };

    // A move between the menu's own items is not leaving.
    leave(items[2]!);
    expect(menu.hidden).toBe(false);
    // Tab to the composer: the menu is gone and the button no longer claims it is open.
    leave(h.el('input'));
    expect(menu.hidden).toBe(true);
    expect(h.doc.querySelector(`[data-rm="topic:${B}"]`)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves a tap that blurs it with no next focus to the click — iOS Safari', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });
    await rowMenu(h, D);
    const menu = h.el('row-menu');
    const star = menu.querySelector<HTMLElement>('[data-rmk="star"]')!;

    // iOS Safari does not focus a button on tap: pointerdown, then a focusout with no
    // relatedTarget, and only then the click. Closing on that blur would eat the tap.
    star.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
    menu.dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(menu.hidden).toBe(false);

    star.click();
    await tick();
    expect(h.calls.find((c) => c.path === 'api/topics/star')?.body).toEqual({ topic: D, starred: true });
    expect(menu.hidden).toBe(true);
  });

  it('moves between its items with the arrow keys, Home and End, skipping a disabled item', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    // D has no process: End is disabled and must not be a stop on the way.
    await h.emit({ t: 'topics', topics: fleet({ [D]: { live: false } }) });
    await rowMenu(h, D);
    const menu = h.el('row-menu');
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const press = (key: string): void => {
      h.doc.activeElement?.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true }));
    };
    items[0]!.focus();
    press('ArrowDown');
    expect(h.doc.activeElement).toBe(items[2]);
    press('ArrowDown');
    expect(h.doc.activeElement).toBe(items[0]);
    press('ArrowUp');
    expect(h.doc.activeElement).toBe(items[2]);
    press('Home');
    expect(h.doc.activeElement).toBe(items[0]);
    press('End');
    expect(h.doc.activeElement).toBe(items[2]);
  });

  it('greys End agent, and says why, when nothing in the subtree has a process', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet({ [A]: { live: false }, [B]: { live: false }, [C]: { live: false } }) });
    await rowMenu(h, A);

    const end = h.doc.querySelector<HTMLButtonElement>('[data-rmk="end"]')!;
    expect(end.disabled).toBe(true);
    expect(end.textContent).toBe('End agent');
    expect(end.title).toMatch(/nothing to end/);
  });

  it('says how many sub-agents End reaches, counting topics with a process', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });
    await h.click(`#topics [data-fold="${A}"]`);

    await rowMenu(h, A);
    expect(h.doc.querySelector('[data-rmk="end"]')?.textContent).toBe('End agent + 2 sub-agents');
    await rowMenu(h, B);
    expect(h.doc.querySelector('[data-rmk="end"]')?.textContent).toBe('End agent + 1 sub-agent');
    await rowMenu(h, D);
    expect(h.doc.querySelector('[data-rmk="end"]')?.textContent).toBe('End agent');
  });

  it('ends the whole subtree on the click, with no second question', async () => {
    const h = await open({
      url: `http://localhost:8787/?t=${A}`,
      replies: {
        'api/topics/kill': {
          results: [
            { topic: A, outcome: 'ended' },
            { topic: B, outcome: 'no-child' },
            { topic: C, outcome: 'ended' },
          ],
        },
      },
    });
    await h.emit(sync(A, [], [A]));
    // A running turn and a question in the tree do not bring a confirmation back: /kill
    // interrupts them, and the menu item said how far it reaches before it was clicked.
    await h.emit({ t: 'topics', topics: fleet({ [A]: { running: true, asking: true }, [C]: { running: true } }) });
    await rowMenu(h, A);
    await h.click('[data-rmk="end"]');
    await until('the kill', () => h.calls.some((c) => c.path === 'api/topics/kill'));

    expect(h.el('idle-dialog').hidden).toBe(true);
    expect(h.confirms).toEqual([]);
    // The root names the subtree; the list is what the page held, and the daemon ends only their
    // intersection — a sub-agent opened since is not in it.
    expect(h.calls.find((c) => c.path === 'api/topics/kill')?.body).toEqual({ topic: A, topics: [A, B, C] });
    expect(h.el('row-menu').hidden).toBe(true);
    // Nothing to report when every process was ended or had already gone.
    expect(h.alerts).toEqual([]);
  });

  it('says which process the runtime would not end — nothing else would explain a lit row', async () => {
    const h = await open({
      url: `http://localhost:8787/?t=${A}`,
      replies: { 'api/topics/kill': { results: [{ topic: A, outcome: 'unresumable' }] } },
    });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });
    await rowMenu(h, A);
    await h.click('[data-rmk="end"]');
    await until('the alert', () => h.alerts.length > 0);

    expect(h.alerts[0]).toBe('1 agent left running: the runtime cannot resume it.');
  });

  it('stays open, and follows its row, while a running agent repaints the list', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });
    await rowMenu(h, A);
    const menu = h.el('row-menu');

    // Every streamed message rebuilds #topics with innerHTML. The menu is at the body, so it is
    // not in that markup; the new button under it must still say it is the open one.
    await h.emit({ t: 'topics', topics: fleet({ [A]: { title: 'parent, renamed mid-turn' } }) });
    expect(menu.hidden).toBe(false);
    expect(h.doc.body.contains(menu)).toBe(true);
    expect(h.doc.querySelector(`[data-rm="topic:${A}"]`)?.getAttribute('aria-expanded')).toBe('true');

    // When its topic goes, it has nothing left to act on and closes.
    await h.emit({ t: 'topics', topics: fleet().filter((t) => t.id !== A && t.id !== B && t.id !== C) });
    expect(menu.hidden).toBe(true);
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

    await rowMenu(h, 'a1b2c3d4');
    await h.click('[data-rmk="delete"]');
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
    expect(face(h.el('mic'))).toBe('[mic]');
    await h.click('#mic');
    await tick();
    expect(h.recorders).toHaveLength(1);
    expect(h.recorders[0]!.mimeType).toBe('audio/webm;codecs=opus');
    expect(h.el('mic').classList.contains('rec')).toBe(true);
    expect(face(h.el('mic'))).toBe('[stop] 0:00');

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
    expect(face(h.el('mic'))).toBe('[mic]');
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
    return { ...message(id, webMessageHtml('tools', lines.join('\n'))), kind: 'tools' };
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
    expect(face(rows(h)[0])).toContain('[check] 1.2s');
  });

  it('draws the tool, a sub-agent and the finish mark as icons, and an emoji it has none for as itself', async () => {
    const h = await open();
    await h.emit(
      sync(T, [bubble('m1', [`💻 Bash: "${CMD}" ✓ 1.2s`, '↳ fix tests · ✏️ Edit: "a.ts" ✗ 832ms', '↳ 🦀 Cargo: "build"'])], [T])
    );

    expect(rows(h).map(face)).toEqual([
      `[terminal] Bash: "${CMD}" [check] 1.2s`,
      '[subagent] fix tests · [pencil] Edit: "a.ts" [cross] 832ms',
      '[subagent] 🦀 Cargo: "build"',
    ]);
    // The finish mark is still the part that stays in view when the command folds.
    expect(face(rows(h)[1]?.querySelector('.tl-s'))).toBe(' [cross] 832ms');
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
    expect(face(h.doc.querySelector(`#topics [data-fold="${D}"]`))).toBe('[chevronRight] 1');
    await h.click(`#topics [data-fold="${D}"]`);
    // Opening one level does not open the next.
    expect(rows(h)).toEqual([D, B, A]);
    expect(face(h.doc.querySelector(`#topics [data-fold="${B}"]`))).toBe('[chevronRight] 1');
    await h.click(`#topics [data-fold="${B}"]`);
    expect(rows(h)).toEqual([D, B, C, A]);
    const row = (id: string): Element => h.doc.querySelector(`#topics [data-topic="${id}"]`)!;
    expect(row(D).className).not.toMatch(/\bsub\b/);
    expect(row(B).className).toMatch(/\bsub d1\b/);
    expect(row(C).className).toMatch(/\bsub d2\b/);
    expect(face(row(D).querySelector('[data-fold]'))).toBe('[chevronDown] 1');
    expect(row(A).querySelector('[data-fold]')).toBeNull();
    // A child is a topic like any other: its row carries the same ⋯ menu, with star and delete.
    expect(row(B).querySelector('[data-rm]')).not.toBeNull();
  });

  it('folds a parent’s sub-agents away by default — remembered, colour kept, and without switching to it', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    const topics = list({ [B]: { parent: D }, [C]: { parent: D, running: true } });
    await h.emit({ t: 'topics', topics });
    // Folded on first sight, and the pill takes the colour of what it hides.
    expect(rows(h)).toEqual([D, A]);
    const pill = h.doc.querySelector(`#topics [data-fold="${D}"]`)!;
    expect(face(pill)).toBe('[chevronRight] 2');
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
    expect(face(h.doc.querySelector(`#topics [data-fold="${D}"]`))).toBe('[chevronDown] 1');
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

  it('puts a topic with no title yet below what needs you and above every state', async () => {
    const U = 'a9b8c7d6';
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        // The daemon's order, deliberately the reverse of the one these states belong in.
        { id: A, title: 'stopped', lastAt: 1000, msgCount: 0, stage: 'idle' },
        { id: D, title: 'resident', lastAt: 999, msgCount: 0, stage: 'idle', live: true },
        { id: C, title: 'working', lastAt: 998, msgCount: 0, stage: 'working', running: true, live: true },
        { id: B, title: 'decision', lastAt: 997, msgCount: 0, stage: 'answer', asking: true, running: true, live: true },
        // Opened a moment ago: nothing said in it yet, so no title and no agent behind it.
        { id: U, title: '', lastAt: 996, msgCount: 0, stage: 'idle' },
      ],
    });
    expect(rows(h)).toEqual([B, U, C, D, A]);
    // The line under the needs-you group falls before the untitled row, which is the first of
    // the ordinary ones.
    expect(h.doc.querySelector(`#topics [data-topic="${U}"]`)?.classList.contains('after-needs')).toBe(true);

    // Untitled is a place in the list, not a state: it leads even a working topic.
    await h.emit({
      t: 'topics',
      topics: [
        { id: C, title: 'working', lastAt: 1000, msgCount: 0, stage: 'working', running: true, live: true },
        { id: U, title: '', lastAt: 999, msgCount: 0, stage: 'working', running: true, live: true },
      ],
    });
    expect(rows(h)).toEqual([U, C]);

    // And a sub-agent's topic stays its parent's, untitled or not.
    await h.emit({
      t: 'topics',
      topics: [
        { id: D, title: 'parent', lastAt: 1000, msgCount: 0, stage: 'idle', live: true },
        { id: U, title: '', lastAt: 999, msgCount: 0, stage: 'idle', parent: D },
        { id: C, title: 'working', lastAt: 998, msgCount: 0, stage: 'working', running: true, live: true },
      ],
    });
    expect(rows(h)).toEqual([C, D]);
    await h.click(`#topics [data-fold="${D}"]`);
    expect(rows(h)).toEqual([C, D, U]);
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
      sync(D, [message('w1', `<p>Done in <a href="?t=${C}" data-goto="${C}">shop-api</a>.</p>`)], [D, A, C])
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

describe('webui page: how long a topic has been running, or since it stopped', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const C = 'c3d4e5f6';
  const D = 'd15a7c40';
  const E = 'e6f7a8b9';
  const F = 'f7a8b9c0';
  const NOW = new Date('2027-01-02T12:00:00').getTime();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ageOf = (h: Harness, id: string): HTMLElement | null =>
    h.doc.querySelector(`#topics [data-topic="${id}"] .topic-age`);
  const ageText = (h: Harness, id: string): string | null => ageOf(h, id)?.textContent ?? null;
  const ended = (id: string, ms: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: `T ${id}`,
    lastAt: NOW - 30 * DAY,
    msgCount: 1,
    stage: 'idle',
    outcome: { kind: 'done', at: NOW - ms },
    ...extra,
  });

  it('writes every span in the same units, and "ago" only once it has ended', async () => {
    const ids = ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6', 'd15a7c40', 'e6f7a8b9', 'f7a8b9c0', '0a1b2c3d'];
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        ended(ids[0]!, 30_000), // under a minute
        ended(ids[1]!, 59 * MIN + 30_000), // 59m
        ended(ids[2]!, 60 * MIN), // 1h
        ended(ids[3]!, 23 * HOUR), // 23h, no minutes
        ended(ids[4]!, DAY), // 1d, no hours
        ended(ids[5]!, DAY + 10 * HOUR), // 1d10h
        ended(ids[6]!, -5 * MIN), // a browser clock behind the server's
      ],
    });
    expect(ids.map((id) => ageText(h, id))).toEqual([
      '<1m ago',
      '59m ago',
      '1h ago',
      '23h ago',
      '1d ago',
      '1d10h ago',
      '<1m ago',
    ]);
  });

  it('counts a working topic from its start, an idle one from its last end, and says nothing about a new one', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'working', lastAt: NOW - 10 * MIN, msgCount: 1, stage: 'working', running: true, runningSince: NOW - 3 * MIN },
        { ...ended(B, 10 * MIN) },
        { id: C, title: 'no outcome', lastAt: NOW - 2 * HOUR, msgCount: 2, stage: 'idle' },
        // Nothing said in it yet: there is no run to time and no end to count from.
        { id: D, title: 'new', lastAt: NOW, msgCount: 0, stage: 'idle' },
        // A daemon from before runningSince: it says running, but not since when.
        { id: E, title: 'old server', lastAt: NOW - HOUR, msgCount: 1, stage: 'working', running: true },
        // A question holds its turn open, so the server sends running too, and it is timed
        // like work.
        { id: F, title: 'asking', lastAt: NOW - 8 * MIN, msgCount: 1, stage: 'answer', asking: true, running: true, runningSince: NOW - 5 * MIN },
      ],
    });

    expect(ageText(h, A)).toBe('3m');
    expect(ageOf(h, A)?.className).toContain('run');
    expect(ageOf(h, A)?.getAttribute('title')).toBe('Started 11:57');
    expect(ageText(h, B)).toBe('10m ago');
    expect(ageOf(h, B)?.className).not.toContain('run');
    expect(ageOf(h, B)?.getAttribute('title')).toBe('Ended 11:50');
    // No outcome on the row, but it has been spoken in: the last message is the end.
    expect(ageText(h, C)).toBe('2h ago');
    expect(ageText(h, D)).toBeNull();
    expect(ageText(h, E)).toBeNull();
    expect(ageText(h, F)).toBe('5m');
    expect(ageOf(h, F)?.className).toContain('run');
  });

  it('times a dispatcher from the earliest start under it, not from its own last turn', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        // Its own turn is over; the job its sub-agents are doing began 80 minutes ago.
        { id: A, title: 'dispatcher', lastAt: NOW - 2 * HOUR, msgCount: 3, stage: 'working', outcome: { kind: 'done', at: NOW - 2 * HOUR } },
        { id: B, title: 'sub one', lastAt: NOW - 80 * MIN, msgCount: 1, stage: 'working', running: true, runningSince: NOW - 80 * MIN, parent: A },
        { id: C, title: 'sub two', lastAt: NOW - 3 * MIN, msgCount: 1, stage: 'working', running: true, runningSince: NOW - 3 * MIN, parent: B },
      ],
    });

    // Under a day the row shows hours only, so 80 minutes reads as "1h"; the point is that it is
    // the child's start (10:40) and not the dispatcher's own last turn two hours ago.
    expect(ageText(h, A)).toBe('1h');
    expect(ageOf(h, A)?.className).toContain('run');
    expect(ageOf(h, A)?.getAttribute('title')).toBe('Started 10:40');

    // A daemon older than runningSince says the sub-agent works but not since when: the
    // dispatcher is still drawn as running, so it shows no ended age instead.
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'dispatcher', lastAt: NOW - 2 * HOUR, msgCount: 3, stage: 'working', outcome: { kind: 'done', at: NOW - 2 * HOUR } },
        { id: B, title: 'sub one', lastAt: NOW - 80 * MIN, msgCount: 1, stage: 'working', running: true, parent: A },
      ],
    });
    expect(ageText(h, A)).toBeNull();
  });

  it('moves the age on a 30-second tick by rewriting the text, never by repainting the row', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    const set = vi.spyOn(h.window, 'setInterval');
    const ticks = (): number => set.mock.calls.filter((c) => c[1] === 30_000).length;
    await h.emit({ t: 'topics', topics: [ended(A, 10 * MIN)] });
    expect(ticks()).toBe(1);

    // A second list change repaints the rows; the timer already running is reused, not doubled.
    await h.emit({ t: 'topics', topics: [ended(A, 10 * MIN), ended(B, 5 * MIN)] });
    expect(ticks()).toBe(1);

    const timer = set.mock.calls.find((c) => c[1] === 30_000)!;
    const node = ageOf(h, A)!;
    expect(node.textContent).toBe('10m ago');

    vi.setSystemTime(NOW + MIN);
    (timer[0] as () => void)();

    // The same element, not a fresh row: a repaint would lose the hover state and any menu open
    // over the row, which is why the tick writes textContent only.
    expect(ageOf(h, A)).toBe(node);
    expect(node.textContent).toBe('11m ago');
  });

  it('clears the tick when the last age leaves the list', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    const set = vi.spyOn(h.window, 'setInterval');
    const clear = vi.spyOn(h.window, 'clearInterval');
    await h.emit({ t: 'topics', topics: [ended(A, 10 * MIN)] });
    const timer = set.mock.calls.find((c) => c[1] === 30_000)!;
    const id = set.mock.results[set.mock.calls.indexOf(timer)]?.value;

    // Nothing said in it any more: no running start, no end, so no age to keep current.
    await h.emit({ t: 'topics', topics: [{ id: A, title: 'new', lastAt: NOW, msgCount: 0, stage: 'idle' }] });
    expect(h.doc.querySelector('.topic-age')).toBeNull();
    expect(clear).toHaveBeenCalledWith(id);
  });

  it('stops the tick behind a hidden tab, and catches up the moment it is looked at', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    const set = vi.spyOn(h.window, 'setInterval');
    const clear = vi.spyOn(h.window, 'clearInterval');
    const ticks = (): number => set.mock.calls.filter((c) => c[1] === 30_000).length;
    await h.emit({ t: 'topics', topics: [ended(A, 10 * MIN)] });
    const timer = set.mock.calls.find((c) => c[1] === 30_000)!;
    const node = ageOf(h, A)!;
    expect(ticks()).toBe(1);

    Object.defineProperty(h.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    h.doc.dispatchEvent(new h.window.Event('visibilitychange'));
    expect(clear).toHaveBeenCalledWith(set.mock.results[set.mock.calls.indexOf(timer)]?.value);

    // Five minutes later the row still says what it said; coming back rewrites it at once,
    // rather than up to half a minute later, and arms a fresh timer.
    vi.setSystemTime(NOW + 5 * MIN);
    expect(node.textContent).toBe('10m ago');
    Object.defineProperty(h.doc, 'visibilityState', { configurable: true, get: () => 'visible' });
    h.doc.dispatchEvent(new h.window.Event('visibilitychange'));
    expect(ageOf(h, A)).toBe(node);
    expect(node.textContent).toBe('15m ago');
    expect(ticks()).toBe(2);
  });

  it('writes a scheduled run’s last activity in the same units, and keeps it current', async () => {
    const h = await open({ replies: { 'api/schedules': { enabled: true, tasks: [] } } });
    await h.emit(sync(A, [], [A]));
    const set = vi.spyOn(h.window, 'setInterval');
    await h.emit({
      t: 'topics',
      topics: [{ id: A, title: 'a run', lastAt: NOW - DAY - 10 * HOUR, msgCount: 4, scheduled: true, stage: 'idle' }],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');
    const line = h.doc.querySelector('.sess-item .topic-dir')?.textContent ?? '';
    expect(line).toContain('1d10h ago');
    expect(line).toContain('4 messages');

    // The panel's age is stamped and rewritten by the same tick as the sidebar's, so it does not
    // go stale while the panel is the thing on screen.
    const node = h.doc.querySelector('.sess-item .topic-age')!;
    expect(node.textContent).toBe('1d10h ago');
    const timer = set.mock.calls.find((c) => c[1] === 30_000)!;
    vi.setSystemTime(NOW + HOUR);
    (timer[0] as () => void)();
    expect(h.doc.querySelector('.sess-item .topic-age')).toBe(node);
    expect(node.textContent).toBe('1d11h ago');
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
    expect(face(h.el('opts-toggle').querySelector('.opts-gear'))).toBe('[gear]');
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
    // is quieted by the same rule — it is the same .topic-dot now.
    expect(css.match(/#app\.calm [^{]*\{[^}]*\}/g)).toEqual([
      '#app.calm .topic-dot.running{animation:none}',
      '#app.calm .topic-badge{background:#2a2a2a;color:#8a8a8a;font-weight:500}',
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
  /** Open a task row's ⋯ menu, as a person would: one box, so the selector is inside #row-menu. */
  const taskMenu = async (h: Harness, id: string): Promise<HTMLElement> => {
    await h.click(`[data-rm="task:${id}"]`);
    return h.el('row-menu');
  };

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
    // The cron is not on the row any more — it is on the row's hover card, with the next run.
    // The detail is in the DOM (folded), so the row is what is read here, not the whole list.
    const row = h.doc.querySelector('.sched-item .topic-item') as HTMLElement;
    expect(row.textContent).not.toContain('0 8 * * *');
    expect(row.getAttribute('title')).toContain('0 8 * * * (Asia/Shanghai)');
    expect(row.getAttribute('title')).toContain('next 2026-11-05 08:00');
    // The target is resolved against the topic list the page already has, rather than shown as
    // `web:main#…` — the one thing a person cannot read.
    expect(h.el('schedules-list').textContent).toContain('→ Topic ' + A);
  });

  it('draws a task as a row: no cron on it, the state on its dot, the rest on one line', async () => {
    const now = Date.now();
    const replies = { 'api/schedules': listReply([
      task({ id: 't00001', name: 'Active one', nextAt: now + 3 * 3600 * 1000 }),
      task({ id: 't00002', name: 'Running one', running: true }),
      task({ id: 't00003', name: 'Paused one', state: 'paused' }),
      task({ id: 't00004', name: 'Failed one', last: { status: 'failed', at: now - 2 * 3600 * 1000 } }),
      task({ id: 't00005', name: 'Tagged one', tags: ['ci', 'ops'] }),
      task({ id: 't00006', name: 'Done one', state: 'done' }),
    ]) };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    const row = (id: string): HTMLElement => h.doc.querySelector(`.sched-item[data-id="${id}"] .topic-item`) as HTMLElement;
    const dot = (id: string): Element | null => row(id).querySelector('.topic-dot');
    const line = (id: string): string => row(id).querySelector('.topic-dir')?.textContent ?? '';

    // The shared row component, and the cron is nowhere on the row itself.
    expect(row('t00001').classList.contains('topic-item')).toBe(true);
    expect(row('t00001').textContent).not.toContain('0 8 * * *');
    expect(row('t00001').getAttribute('title')).toContain('0 8 * * * (Asia/Shanghai)');
    expect(row('t00001').querySelector('.topic-title')?.textContent).toBe('Active one');

    // Active: dim-blue dot, the countdown, the target, no last run.
    expect(dot('t00001')?.classList.contains('live')).toBe(true);
    expect(line('t00001')).toMatch(/^in \d+h/);
    expect(line('t00001')).toContain('→ Topic ' + A);

    // Running: the blue pulsing dot, the row's own running class (what colours "running now"),
    // and the words themselves.
    expect(dot('t00002')?.classList.contains('running')).toBe(true);
    expect(row('t00002').classList.contains('running')).toBe(true);
    expect(line('t00002')).toContain('running now');

    // Paused and done: grey dot, the state word, and the title dimmed like an idle row.
    expect(dot('t00003')?.className).toBe('topic-dot');
    expect(line('t00003')).toContain('paused');
    expect(row('t00003').classList.contains('idle')).toBe(true);
    expect(row('t00006').classList.contains('idle')).toBe(true);

    // A failed last run: the red dot and a red last-run segment.
    expect(dot('t00004')?.classList.contains('failed')).toBe(true);
    expect(line('t00004')).toContain('last failed');
    expect(row('t00004').querySelector('.sched-last')?.classList.contains('bad')).toBe(true);

    // Tags are on the line as #tag.
    expect(line('t00005')).toContain('#ci');
    expect(line('t00005')).toContain('#ops');
  });

  it('draws the selected scheduled run' + "'s title white, as the topic list does", () => {
    const html = renderPage('Chat', false);
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    // The old .sess-item.on .sess-title rule went with the row; this is the shared one that
    // replaces it. The topic list's own selected-idle greys are id-scoped and still win there.
    expect(css).toContain('.topic-item.on .topic-title{color:#fff}');
  });

  it('keeps its menu through a poll, and closes it when the task goes', async () => {
    const replies: Record<string, unknown> = {
      'api/schedules': listReply([task(), task({ id: 'b2c3d4', name: 'Other task' })]),
    };
    // The 30s poll is shortened to 30ms, which is the repaint an open menu has to survive.
    const h = await open({ replies, shortenLong: true });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');
    const menu = h.el('row-menu');
    const first = h.doc.querySelector('[data-rm="task:a1b2c3"]');

    await within('a repaint', 1000, () => h.doc.querySelector('[data-rm="task:a1b2c3"]') !== first);
    expect(menu.hidden).toBe(false);
    expect(h.doc.querySelector('[data-rm="task:a1b2c3"]')?.getAttribute('aria-expanded')).toBe('true');

    // The task leaving the daemon's list leaves the menu with nothing to act on.
    replies['api/schedules'] = listReply([task({ id: 'b2c3d4', name: 'Other task' })]);
    await within('the task to go', 1000, () => h.doc.querySelector('[data-rm="task:a1b2c3"]') === null);
    expect(menu.hidden).toBe(true);
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

    // Both task count and session count are shown on outer Scheduled tab ('1·1'). No spaces
    // around the separator: at the panel's narrowest 220px the two of them pushed the amber
    // dot past the tab's clip edge (measured in Chromium; see page.ts).
    expect(h.el('sched-tab-scheduled-n').textContent).toBe('1·1');
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

    // Switch to Reviews outer tab: outer Scheduled tab still shows '1·1'
    await h.click('#sched-tab-reviews');
    await until('reviews list', () => h.el('sched-reviews-list').textContent!.includes('Reviewed Topic'));
    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-tab-scheduled-n').textContent).toBe('1·1');
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

  it('deletes from the task menu, after one confirmation', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/schedules/op': { ok: true, tasks: [] },
    };
    const h = await open({ replies, confirm: true });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');

    // Pause and Run now, then Delete below its divider: the row's actions are all in here now.
    expect(Array.from(h.el('row-menu').querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual([
      'Pause',
      'Run now',
      'Delete',
    ]);
    expect(h.el('row-menu').querySelector('[role="separator"]')).not.toBeNull();
    expect(h.doc.querySelector('.sched-item')?.querySelector('.topic-item [data-rm]')).not.toBeNull();

    await h.click('[data-rmk="remove"]');
    await until('the delete request', () => h.calls.some((c) => c.path === 'api/schedules/op'));
    expect(h.confirms.at(-1)).toBe('Delete task "Morning CI"?');
    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({ id: 'a1b2c3', action: 'remove' });
    await until('the empty state', () => h.el('schedules-list').textContent!.includes('No scheduled tasks yet'));
  });

  it('leaves the task alone when the confirmation is cancelled', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/schedules/op': { ok: true, tasks: [] },
    };
    const h = await open({ replies, confirm: false });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');
    await h.click('[data-rmk="remove"]');
    await tick();

    expect(h.confirms.at(-1)).toBe('Delete task "Morning CI"?');
    expect(h.calls.some((c) => c.path === 'api/schedules/op')).toBe(false);
    expect(h.el('schedules-list').textContent).toContain('Morning CI');
  });

  it.each([
    { state: 'active', key: 'pause', action: 'pause' },
    { state: 'paused', key: 'resume', action: 'resume' },
    { state: 'active', key: 'run', action: 'run' },
  ])('sends $action from the task menu', async ({ state, key, action }) => {
    const replies = {
      'api/schedules': listReply([task({ state })]),
      'api/schedules/op': { ok: true, tasks: [task({ state })] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');
    await h.click(`[data-rmk="${key}"]`);
    await until('the op', () => h.calls.some((c) => c.path === 'api/schedules/op'));

    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({ id: 'a1b2c3', action });
    expect(h.el('row-menu').hidden).toBe(true);
  });

  it('greys Run now while a run is in flight, and says why', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task({ running: true })]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');

    const run = h.doc.querySelector<HTMLButtonElement>('[data-rmk="run"]')!;
    expect(run.disabled).toBe(true);
    expect(run.title).toMatch(/run is in progress/);
  });

  it('shows the daemon sentence when an action is refused, and keeps the list', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/schedules/op': { ok: false, error: '#a1b2c3 is already paused' },
    };
    const h = await open({ replies, status: { 'api/schedules/op': 400 } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');

    await h.click('[data-rmk="pause"]');
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
    // The detail names the target in full, as the hover card does.
    expect(detail.textContent).toContain('Posts to');
    expect(detail.textContent).toContain('Topic ' + A);
    expect(h.calls.some((c) => c.path === 'api/schedules/op')).toBe(false);
  });

  it('opens and folds a task from the keyboard, and Space does not scroll the page', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    const row = h.doc.querySelector('.sched-item .topic-item') as HTMLElement;
    const detail = h.doc.querySelector('.sched-detail') as HTMLElement;
    const press = (key: string): KeyboardEvent => {
      const ev = new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      row.dispatchEvent(ev);
      return ev;
    };

    // The row says role=button, so Enter and Space do what a click does — and Space is not left
    // to the browser's scroll.
    expect(press('Enter').defaultPrevented).toBe(true);
    await tick();
    expect(detail.hidden).toBe(false);
    expect(press(' ').defaultPrevented).toBe(true);
    await tick();
    expect(detail.hidden).toBe(true);

    // The ⋯ is its own control: Enter on it must not also fold the row.
    const more = h.doc.querySelector('[data-rm="task:a1b2c3"]') as HTMLElement;
    more.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();
    expect(detail.hidden).toBe(true);
  });

  it('lets Enter on a tag' + "'s × delete the tag instead of folding the row", async () => {
    const replies = {
      'api/schedules': listReply([task({ tags: ['ci'] })]),
      'api/schedules/op': { ok: true, tasks: [task({ tags: [] })] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    (h.doc.querySelector('.sched-item') as HTMLElement).click();
    await tick();
    const detail = h.doc.querySelector('.sched-detail') as HTMLElement;
    expect(detail.hidden).toBe(false);

    const del = h.doc.querySelector('[data-tag-del="ci"]') as HTMLElement;
    del.focus();
    // A browser turns Enter on a focused button into a click unless the keydown was cancelled;
    // jsdom performs no default actions, so the test does that step itself.
    const ev = new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    const live = del.dispatchEvent(ev);
    expect(live).toBe(true);
    if (live) del.click();
    await until('the tags request', () => h.calls.some((c) => c.path === 'api/schedules/op'));

    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({
      id: 'a1b2c3',
      action: 'tags',
      tags: [],
    });
    expect(detail.hidden).toBe(false);
  });

  it('does not open a menu with a separator when the task has no state change', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task({ state: 'expired' })]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');

    const menu = h.el('row-menu');
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual(['Delete']);
    expect(menu.querySelector('[role="separator"]')).toBeNull();
    expect(menu.firstElementChild?.getAttribute('data-rmk')).toBe('remove');
  });

  it('puts an open task menu away when the panel tab changes or the panel closes', async () => {
    const C = 'c3d4e5f6';
    const replies = {
      'api/schedules': listReply([task()]),
      'api/reviews': { enabled: true, reviews: [] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true },
      ],
    });
    await h.click('#schedules-toggle');
    const menu = h.el('row-menu');

    await taskMenu(h, 'a1b2c3');
    await h.click('#sched-tab-sessions');
    expect(menu.hidden).toBe(true);

    await h.click(`[data-rm="sess:${C}"]`);
    expect(menu.hidden).toBe(false);
    await h.click('#sched-tab-tasks');
    expect(menu.hidden).toBe(true);

    await taskMenu(h, 'a1b2c3');
    await h.click('#sched-tab-reviews');
    expect(menu.hidden).toBe(true);

    await h.click('#sched-tab-scheduled');
    await taskMenu(h, 'a1b2c3');
    await h.click('#schedules-close');
    expect(menu.hidden).toBe(true);
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
    // The run's ⋯ holds the same topic menu a sidebar row has.
    await h.click(`[data-rm="sess:${C}"]`);
    expect(Array.from(h.el('row-menu').querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual([
      'Star',
      'End agent',
      'Delete topic',
    ]);
    await h.click('[data-rmk="delete"]');
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

/**
 * The Sessions list's calendar, with the clock fixed.
 *
 * "Today", "Yesterday", "this month" and a month across the year boundary are all real cases,
 * and a test that read the wall clock could reach only some of them — the Today and Yesterday
 * branches only on the 1st and 2nd of a month — and would flake across midnight. The date is
 * Saturday 2027-01-02, 12:00 local: yesterday is 2027-01-01 and last month is December 2026, so
 * both the day labels and the year boundary are exercised on every run.
 */
describe('webui page: the Sessions list calendar', () => {
  const A = 'a1b2c3d4';
  const C = 'c3d4e5f6';
  const D = 'd4e5f6a7';
  const E = 'e5f6a7b8';
  const F = 'f6a7b8c9';
  const NOW = new Date(2027, 0, 2, 12, 0, 0);
  const at = (y: number, m: number, d: number): number => new Date(y, m, d, 12).getTime();
  const TODAY = at(2027, 0, 2);
  const YESTERDAY = at(2027, 0, 1);
  const LAST_MONTH = at(2026, 11, 31);
  const OLDER = at(2026, 10, 15);
  /** Keeps the topic on screen off the run list, so the default fold is about the newest group. */
  const ordinary = { id: A, title: 'ordinary topic', lastAt: 0, msgCount: 1, stage: 'idle' };
  const heads = (h: Harness): HTMLElement[] =>
    Array.from(h.doc.querySelectorAll('#sched-sessions .sess-group-head')) as HTMLElement[];
  const names = (h: Harness): Array<string | null> =>
    heads(h).map((n) => n.querySelector('.sess-group-name')?.textContent ?? null);
  const expanded = (h: Harness): Array<string | null> => heads(h).map((n) => n.getAttribute('aria-expanded'));
  const body = (h: Harness, head: HTMLElement): HTMLElement =>
    h.doc.getElementById(head.getAttribute('aria-controls') ?? '') as HTMLElement;
  const flags = (head: HTMLElement): string[] =>
    Array.from(head.querySelectorAll('.sess-group-flag')).map((n) => n.textContent ?? '');
  const stored = (h: Harness): Record<string, boolean> =>
    JSON.parse(h.window.localStorage.getItem('aa_sched_groups') ?? '{}');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('groups this month by day and older runs by month, folded except the newest', async () => {
    const h = await open({ storage: { aa_reads: JSON.stringify({ [C]: 1, [E]: 0 }) } });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: D, title: 'newest run', lastAt: TODAY, msgCount: 3, stage: 'idle', scheduled: true },
        { id: C, title: 'yesterday run', lastAt: YESTERDAY, msgCount: 5, stage: 'idle', scheduled: true },
        { id: F, title: 'last month, asking', lastAt: LAST_MONTH, msgCount: 2, stage: 'answer', asking: true, running: true, scheduled: true },
        { id: E, title: 'the month before', lastAt: OLDER, msgCount: 2, stage: 'idle', running: true, scheduled: true },
        ordinary,
      ],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    // December 2026 under a January clock: the month group crosses the year boundary.
    expect(names(h)).toEqual(['Today', 'Yesterday', 'December 2026', 'November 2026']);
    expect(heads(h).map((n) => n.querySelector('.sess-group-count')?.textContent)).toEqual(['1', '1', '1', '1']);
    // The newest group starts open; the rest are folded, and their headers carry what the rows
    // underneath would have said. 5 messages against a mark of 1 is 4 unread; 2 against 0 is 2.
    expect(expanded(h)).toEqual(['true', 'false', 'false', 'false']);
    expect(flags(heads(h)[0]!)).toEqual([]);
    expect(flags(heads(h)[1]!)).toEqual(['4 unread']);
    expect(flags(heads(h)[2]!)).toEqual(['1 awaiting you']);
    expect(flags(heads(h)[3]!)).toEqual(['2 unread', '1 running']);
    expect(body(h, heads(h)[0]!).hidden).toBe(false);
    expect(body(h, heads(h)[1]!).hidden).toBe(true);
    expect(body(h, heads(h)[3]!).hidden).toBe(true);
    expect(body(h, heads(h)[0]!).querySelector('.sess-item')?.textContent).toContain('newest run');
    expect(body(h, heads(h)[1]!).querySelector('.sess-item')?.textContent).toContain('yesterday run');
  });

  it('puts an undated run in an Earlier group, last', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    // First in the list on purpose: the server sorts by lastAt, but the group has to be last
    // whatever order the list arrives in.
    await h.emit({
      t: 'topics',
      topics: [
        { id: E, title: 'no timestamp', lastAt: 0, msgCount: 2, stage: 'idle', scheduled: true },
        { id: D, title: 'today run', lastAt: TODAY, msgCount: 1, stage: 'idle', scheduled: true },
        ordinary,
      ],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    expect(names(h)).toEqual(['Today', 'Earlier']);
    expect(heads(h)[1]!.querySelector('.sess-group-count')?.textContent).toBe('1');
    expect(body(h, heads(h)[1]!).querySelector('.sess-item')?.textContent).toContain('no timestamp');
    // No "December 1969": a run with no timestamp has no date to name.
    expect(h.el('sched-sessions').textContent).not.toContain('1969');
  });

  it('remembers a folded or opened group, and drops groups the list no longer has', async () => {
    const sessions = (): Array<Record<string, unknown>> => [
      { id: D, title: 'newest run', lastAt: TODAY, msgCount: 1, stage: 'idle', scheduled: true },
      { id: C, title: 'yesterday run', lastAt: YESTERDAY, msgCount: 2, stage: 'idle', scheduled: true },
      ordinary,
    ];
    const h = await open({ storage: { aa_sched_groups: JSON.stringify({ 'd:1999-01-01': true }) } });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: sessions() });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    heads(h)[1]!.click();
    await tick();
    expect(expanded(h)).toEqual(['true', 'true']);
    expect(body(h, heads(h)[1]!).hidden).toBe(false);
    // The stale key is gone: only the groups the list still has are kept.
    expect(stored(h)).toEqual({ 'd:2027-01-01': true });

    const again = await open({ storage: { aa_sched_groups: JSON.stringify(stored(h)) } });
    await again.emit(sync(A, [], [A]));
    await again.emit({ t: 'topics', topics: sessions() });
    await again.click('#schedules-toggle');
    await again.click('#sched-tab-sessions');
    expect(expanded(again)).toEqual(['true', 'true']);

    // The newest group can be folded too, and that is remembered over its default.
    heads(again)[0]!.click();
    await tick();
    expect(expanded(again)).toEqual(['false', 'true']);
  });

  it('keeps the group holding the open run unfolded over a manual fold, and restores focus', async () => {
    const h = await open({
      url: `http://localhost:8787/?t=${E}`,
      storage: { aa_sched_groups: JSON.stringify({ 'm:2026-11': false }) },
    });
    await h.emit(sync(E, [], [E]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: D, title: 'newest run', lastAt: TODAY, msgCount: 1, stage: 'idle', scheduled: true },
        { id: C, title: 'yesterday run', lastAt: YESTERDAY, msgCount: 1, stage: 'idle', scheduled: true },
        { id: E, title: 'the one on screen', lastAt: OLDER, msgCount: 1, stage: 'idle', scheduled: true },
        ordinary,
      ],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    // Newest first, then the run on screen: two open, the day between them folded — and the
    // run's group opens even though this browser folded it last time.
    expect(names(h)).toEqual(['Today', 'Yesterday', 'November 2026']);
    expect(expanded(h)).toEqual(['true', 'false', 'true']);
    expect(body(h, heads(h)[2]!).querySelector('.sess-item')?.textContent).toContain('the one on screen');

    // Folding it by hand does nothing while the run is on screen, and stores nothing.
    heads(h)[2]!.click();
    await tick();
    expect(expanded(h)).toEqual(['true', 'false', 'true']);
    expect(stored(h)).toEqual({ 'm:2026-11': false });

    // A fold that does repaint puts the focus back on the header that was clicked.
    heads(h)[1]!.click();
    await tick();
    expect(expanded(h)).toEqual(['true', 'true', 'true']);
    expect(h.doc.activeElement?.getAttribute('data-sgroup')).toBe('d:2027-01-01');
  });

  it('marks every run read in one tap, badges and the daemon’s reply mark alike', async () => {
    const h = await open({ storage: { aa_reads: JSON.stringify({ [C]: 0, [D]: 0 }) } });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: C, title: 'finished run', lastAt: TODAY, msgCount: 3, stage: 'review', scheduled: true },
        { id: D, title: 'working run', lastAt: TODAY - 1000, msgCount: 2, stage: 'idle', scheduled: true },
        ordinary,
      ],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    const button = (): HTMLButtonElement => h.doc.querySelector('[data-readall]') as HTMLButtonElement;
    expect(button().disabled).toBe(false);
    expect(h.el('sched-sessions').querySelectorAll('.topic-badge')).toHaveLength(2);

    button().click();
    await until('the seen request', () => h.calls.some((c) => c.path === 'api/seen'));

    // The badge is this page's count, so it goes at once; the green dot is the daemon's, and
    // only the run that had one is reported.
    expect(h.el('sched-sessions').querySelectorAll('.topic-badge')).toHaveLength(0);
    expect(h.calls.filter((c) => c.path === 'api/seen').map((c) => c.body)).toEqual([{ topic: C }]);
    expect(JSON.parse(h.window.localStorage.getItem('aa_reads') ?? '{}')).toMatchObject({ [C]: 3, [D]: 2 });

    // Once the daemon's own list says the reply was seen, there is nothing left to mark.
    await h.emit({
      t: 'topics',
      topics: [
        { id: C, title: 'finished run', lastAt: TODAY, msgCount: 3, stage: 'idle', scheduled: true },
        { id: D, title: 'working run', lastAt: TODAY - 1000, msgCount: 2, stage: 'idle', scheduled: true },
        ordinary,
      ],
    });
    expect(button().disabled).toBe(true);
  });

  it('says so when the daemon refuses a mark, and sends them one at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = await open({
      held: { 'api/seen': gate },
      status: { 'api/seen': 500 },
      storage: { aa_reads: JSON.stringify({ [C]: 0, [D]: 0 }) },
    });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: C, title: 'finished one', lastAt: TODAY, msgCount: 3, stage: 'review', scheduled: true },
        { id: D, title: 'finished two', lastAt: YESTERDAY, msgCount: 2, stage: 'review', scheduled: true },
        ordinary,
      ],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');
    (h.doc.querySelector('[data-readall]') as HTMLButtonElement).click();
    await tick();

    // One at a time: the second is not even sent until the first has answered.
    expect(h.calls.filter((c) => c.path === 'api/seen')).toHaveLength(1);
    release();
    await until('both marks', () => h.calls.filter((c) => c.path === 'api/seen').length === 2);
    await until('the note', () => h.el('schedules-note').textContent !== '');

    expect(h.calls.filter((c) => c.path === 'api/seen').map((c) => c.body)).toEqual([{ topic: C }, { topic: D }]);
    // A 4xx/5xx resolves, so the page has to look at r.ok; the note is how it says the daemon
    // still counts both as finished.
    expect(h.el('schedules-note').hidden).toBe(false);
    expect(h.el('schedules-note').textContent).toContain('Could not mark 2 sessions read');
    expect(h.el('sched-sessions').querySelectorAll('.topic-dot.review')).toHaveLength(2);
  });
});

describe('webui page: the task list filter', () => {
  const A = 'a1b2c3d4';
  const HOUR = 3_600_000;
  const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'a1b2c3',
    name: 'Morning CI',
    tags: [],
    createdAt: Date.UTC(2026, 10, 1),
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
  const ids = (h: Harness): string[] =>
    Array.from(h.doc.querySelectorAll('#schedules-list .sched-item')).map((n) => n.getAttribute('data-id') ?? '');
  const search = async (h: Harness, s: string): Promise<void> => {
    const q = h.doc.querySelector('#sched-filter .fb-q') as HTMLInputElement;
    q.value = s;
    q.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await tick();
  };
  const toggle = async (h: Harness, group: string, value: string): Promise<void> => {
    await h.click(`#sched-filter .fb-chip[data-fb-group="${group}"][data-fb-value="${value}"]`);
  };
  const sortBy = async (h: Harness, value: string): Promise<void> => {
    const sel = h.doc.querySelector('#sched-filter .fb-sortsel') as HTMLSelectElement;
    sel.value = value;
    sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await tick();
  };
  const flip = async (h: Harness): Promise<void> => {
    await h.click('#sched-filter .fb-dir');
  };
  const openPanel = async (h: Harness): Promise<void> => {
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
  };
  /** One task per status, two tags plus untagged, and a live run. */
  const fleet = (): Array<Record<string, unknown>> => [
    task({ id: 'a1b2c3', name: 'Morning CI', tags: ['ci'] }),
    task({
      id: 'b2c3d4',
      name: 'Nightly backup',
      state: 'paused',
      tags: ['ops'],
      nextAt: undefined,
      next: undefined,
      detail: 'pg_dump app',
      target: 'tg:1',
      targetTopic: undefined,
    }),
    task({ id: 'c3d4e5', name: 'Old report', state: 'expired', nextAt: undefined, next: undefined, detail: 'weekly report' }),
    task({ id: 'd4e5f6', name: 'One shot', state: 'done', nextAt: undefined, next: undefined, detail: 'ping once' }),
    task({ id: 'e5f6a7', name: 'Live run', running: true, tags: ['ci'] }),
  ];

  it('hangs its bar above the list on the Tasks sub-tab only', async () => {
    const replies = { 'api/schedules': listReply([task()]), 'api/reviews': { enabled: true, reviews: [] } };
    const h = await open({ replies });
    await openPanel(h);

    const host = h.el('sched-filter');
    expect(host.hidden).toBe(false);
    expect(host.querySelector('.filterbar')).not.toBeNull();
    // Outside the list that is redrawn: the caret and the open panel live in this DOM.
    expect(h.el('schedules-list').querySelector('.filterbar')).toBeNull();

    await h.click('#sched-tab-sessions');
    expect(host.hidden).toBe(true);
    await h.click('#sched-tab-tasks');
    expect(host.hidden).toBe(false);
    await h.click('#sched-tab-reviews');
    await until('the reviews list', () => h.el('sched-reviews-list').textContent !== '');
    expect(host.hidden).toBe(true);
  });

  it('searches the name, the prompt or command, and the target, word by word', async () => {
    const h = await open({ replies: { 'api/schedules': listReply(fleet()) } });
    await openPanel(h);
    expect(ids(h)).toHaveLength(5);

    await search(h, 'backup');
    expect(ids(h)).toEqual(['b2c3d4']);
    await search(h, 'pg_dump');
    expect(ids(h)).toEqual(['b2c3d4']);
    await search(h, 'tg:1');
    expect(ids(h)).toEqual(['b2c3d4']);
    await search(h, 'MORNING weekend');
    expect(ids(h)).toEqual([]);
    await search(h, 'morning');
    expect(ids(h)).toEqual(['a1b2c3']);
  });

  it('filters by status (Running, Active, Paused, Ended) and by tag, with counts', async () => {
    const h = await open({ replies: { 'api/schedules': listReply(fleet()) } });
    await openPanel(h);

    // Status is the pinned row: on screen with the panel shut, four chips in one row.
    expect((h.doc.querySelector('#sched-filter .fb-panel') as HTMLElement).hidden).toBe(true);
    const statusChips = Array.from(h.doc.querySelectorAll('#sched-filter .fb-pins .fb-chip'));
    expect(statusChips.map((c) => c.getAttribute('data-fb-value'))).toEqual(['running', 'active', 'paused', 'ended']);

    const count = (group: string, value: string): string | undefined =>
      h.doc.querySelector(`#sched-filter .fb-chip[data-fb-group="${group}"][data-fb-value="${value}"] .fb-count`)
        ?.textContent ?? undefined;
    expect([count('status', 'running'), count('status', 'active'), count('status', 'paused'), count('status', 'ended')]).toEqual([
      '1',
      '1',
      '1',
      '2',
    ]);
    // A pinned chip filters without opening the panel.
    await toggle(h, 'status', 'ended');
    expect(new Set(ids(h))).toEqual(new Set(['c3d4e5', 'd4e5f6']));
    expect((h.doc.querySelector('#sched-filter .fb-panel') as HTMLElement).hidden).toBe(true);

    // The tags still live in the panel.
    await h.click('#sched-filter .fb-filter');
    expect(count('tags', 'ci')).toBe('2');
    expect(count('tags', 'ops')).toBe('1');
    expect(count('tags', ' untagged')).toBe('2');
    // The chip carries the tag icon, like the card's own chips.
    expect(h.doc.querySelector('#sched-filter .fb-chip[data-fb-value="ci"] .ic-tag')).not.toBeNull();

    // Values in one group widen: running joins the ended ones.
    await toggle(h, 'status', 'running');
    expect(new Set(ids(h))).toEqual(new Set(['c3d4e5', 'd4e5f6', 'e5f6a7']));

    await toggle(h, 'status', 'ended');
    await toggle(h, 'status', 'running');
    await toggle(h, 'tags', 'ops');
    expect(ids(h)).toEqual(['b2c3d4']);
    // Groups intersect: a tag plus a status the tagged task does not have matches nothing.
    await toggle(h, 'status', 'active');
    expect(ids(h)).toEqual([]);
    expect(h.doc.querySelector('.sched-none')?.textContent).toContain('No matching tasks');
    await h.click('.sched-none .fb-clear');
    expect(ids(h)).toHaveLength(5);
    expect((h.doc.querySelector('#sched-filter .fb-q') as HTMLInputElement).value).toBe('');
  });

  it('keeps a pinned Status chip’s pressed state in step without restating the groups', async () => {
    const h = await open({ replies: { 'api/schedules': listReply(fleet()) } });
    await openPanel(h);
    const paused = (): HTMLElement =>
      h.doc.querySelector('#sched-filter .fb-chip[data-fb-group="status"][data-fb-value="paused"]') as HTMLElement;
    expect(paused().getAttribute('aria-pressed')).toBe('false');

    await toggle(h, 'status', 'paused');
    expect(paused().getAttribute('aria-pressed')).toBe('true');
    // The chip carries its full name and its number, because the row may show only the number.
    expect(paused().getAttribute('aria-label')).toBe('Paused 1');

    await toggle(h, 'status', 'paused');
    expect(paused().getAttribute('aria-pressed')).toBe('false');

    await toggle(h, 'status', 'paused');
    await h.click('#sched-filter .fb-sum .fb-clear');
    expect(paused().getAttribute('aria-pressed')).toBe('false');
    expect((h.doc.querySelector('#sched-filter .fb-sum') as HTMLElement).hidden).toBe(true);
  });

  it('sorts by next run, last run and creation, with the missing values always last', async () => {
    const at = (n: number): Record<string, unknown> => ({ at: n, atText: 'x', status: 'ok' });
    const replies = {
      'api/schedules': listReply([
        task({ id: 'd0d0d0', name: 'done', state: 'done', nextAt: undefined, next: undefined, createdAt: 4000 }),
        task({
          id: 'b0b0b0',
          name: 'paused',
          state: 'paused',
          nextAt: undefined,
          next: undefined,
          last: at(1000),
          createdAt: 3000,
        }),
        task({ id: 'e0e0e0', name: 'later', nextAt: 30 * HOUR, last: at(3000), createdAt: 1000 }),
        task({ id: 'a0a0a0', name: 'sooner', nextAt: HOUR, last: undefined, createdAt: 2000 }),
      ]),
    };
    const h = await open({ replies });
    await openPanel(h);

    // Status is the daemon's order, untouched.
    expect(ids(h)).toEqual(['d0d0d0', 'b0b0b0', 'e0e0e0', 'a0a0a0']);

    await sortBy(h, 'next');
    expect(ids(h)).toEqual(['a0a0a0', 'e0e0e0', 'd0d0d0', 'b0b0b0']);
    await flip(h);
    // Descending reverses the values; the two with no next run stay at the bottom.
    expect(ids(h)).toEqual(['e0e0e0', 'a0a0a0', 'd0d0d0', 'b0b0b0']);

    await sortBy(h, 'last');
    await flip(h); // back to ascending
    expect(ids(h)).toEqual(['b0b0b0', 'e0e0e0', 'd0d0d0', 'a0a0a0']);
    await flip(h);
    expect(ids(h)).toEqual(['e0e0e0', 'b0b0b0', 'd0d0d0', 'a0a0a0']);

    await sortBy(h, 'created');
    await flip(h); // ascending again
    expect(ids(h)).toEqual(['e0e0e0', 'a0a0a0', 'b0b0b0', 'd0d0d0']);
    await flip(h);
    expect(ids(h)).toEqual(['d0d0d0', 'b0b0b0', 'a0a0a0', 'e0e0e0']);

    // Back to Status: the API's order, reversed while the direction is descending.
    await sortBy(h, 'status');
    expect(ids(h)).toEqual(['a0a0a0', 'e0e0e0', 'b0b0b0', 'd0d0d0']);
    await flip(h);
    expect(ids(h)).toEqual(['d0d0d0', 'b0b0b0', 'e0e0e0', 'a0a0a0']);
  });

  it('adds a tag from the card and keeps the card open through the repaint', async () => {
    const replies = {
      'api/schedules': listReply([task({ tags: ['ci'] })]),
      'api/schedules/op': { ok: true, tasks: [task({ tags: ['ci', 'deploy'] })] },
    };
    const h = await open({ replies });
    await openPanel(h);

    (h.doc.querySelector('.sched-item') as HTMLElement).click();
    await tick();
    const input = h.doc.querySelector('[data-tag-input]') as HTMLInputElement;
    input.value = 'deploy';
    input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until('the tags request', () => h.calls.some((c) => c.path === 'api/schedules/op'));

    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({
      id: 'a1b2c3',
      action: 'tags',
      tags: ['ci', 'deploy'],
    });
    await until('the new chip', () => h.doc.querySelectorAll('.sched-tag-edit .sched-tag').length === 2);
    expect(h.el('schedules-list').textContent).toContain('deploy');
    // A poll or the answer's repaint must not fold a card being edited.
    expect((h.doc.querySelector('.sched-detail') as HTMLElement).hidden).toBe(false);
  });

  it('removes a tag with its ×, and shows the daemon sentence when a save is refused', async () => {
    const removed = {
      'api/schedules': listReply([task({ tags: ['ci'] })]),
      'api/schedules/op': { ok: true, tasks: [task({ tags: [] })] },
    };
    const h = await open({ replies: removed });
    await openPanel(h);
    (h.doc.querySelector('.sched-item') as HTMLElement).click();
    await tick();
    (h.doc.querySelector('[data-tag-del="ci"]') as HTMLElement).click();
    await until('the tags request', () => h.calls.some((c) => c.path === 'api/schedules/op'));

    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({
      id: 'a1b2c3',
      action: 'tags',
      tags: [],
    });
    await until('no chip', () => h.doc.querySelectorAll('.sched-tag-edit .sched-tag').length === 0);

    const refused = {
      'api/schedules': listReply([task({ tags: ['ci'] })]),
      'api/schedules/op': { ok: false, error: 'a task takes at most 5 tags, got 6' },
    };
    const r = await open({ replies: refused, status: { 'api/schedules/op': 400 } });
    await openPanel(r);
    (r.doc.querySelector('.sched-item') as HTMLElement).click();
    await tick();
    const input = r.doc.querySelector('[data-tag-input]') as HTMLInputElement;
    input.value = 'x';
    input.dispatchEvent(new r.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until('the refusal', () => !r.el('schedules-note').hidden);

    expect(r.el('schedules-note').textContent).toBe('a task takes at most 5 tags, got 6');
    expect(r.el('schedules-list').textContent).toContain('Morning CI');
  });

  it('keeps a tag being typed and its caret through a poll repaint', async () => {
    const replies = { 'api/schedules': listReply([task()]) };
    // The 30s poll is shortened to 30ms, which is the repaint a person editing a tag would see.
    const h = await open({ replies, shortenLong: true });
    await openPanel(h);
    (h.doc.querySelector('.sched-item') as HTMLElement).click();
    await tick();

    const input = h.doc.querySelector('[data-tag-input]') as HTMLInputElement;
    input.value = 'deploy';
    input.focus();
    input.setSelectionRange(3, 3);

    await within('a poll repaint', 1000, () => !h.doc.contains(input));
    const next = h.doc.querySelector('[data-tag-input]') as HTMLInputElement;
    expect(next).not.toBe(input);
    expect(next.value).toBe('deploy');
    expect(h.doc.activeElement).toBe(next);
    expect(next.selectionStart).toBe(3);
  });

  it('keeps Loading until the first answer arrives, even when the bar is used', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await open({ replies: { 'api/schedules': listReply([task()]) }, held: { 'api/schedules': gate } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await until('the loading line', () => h.el('schedules-list').textContent!.includes('Loading'));

    // A sort before the list has arrived must not paint "no scheduled tasks" over the wait.
    await sortBy(h, 'created');
    expect(h.el('schedules-list').textContent).toContain('Loading');

    release();
    await until('the tasks', () => h.el('schedules-list').textContent!.includes('Morning CI'));
  });

  it('restores the keyword, the tags and the sort after a reload', async () => {
    const replies = { 'api/schedules': listReply(fleet()) };
    const h = await open({ replies });
    await openPanel(h);
    await h.click('#sched-filter .fb-filter');
    await toggle(h, 'status', 'paused');
    await toggle(h, 'tags', 'ops');
    await sortBy(h, 'created');
    await flip(h);
    expect(ids(h)).toEqual(['b2c3d4']);

    const saved = h.window.localStorage.getItem('aa_sched_filter');
    expect(saved).toBeTruthy();
    const again = await open({ replies, storage: { aa_sched_filter: saved! } });
    await openPanel(again);
    // The page came back with the panel open; clicking the clock is a click outside the bar, so
    // it folds the panel as any click elsewhere does. Reopen it to read the restored view.
    await again.click('#sched-filter .fb-filter');

    expect((again.doc.querySelector('#sched-filter .fb-q') as HTMLInputElement).value).toBe('');
    expect(again.doc.querySelector('#sched-filter .fb-chip[data-fb-value="ops"]')?.getAttribute('aria-pressed')).toBe('true');
    // The pinned Status row came back too, without the panel.
    expect(again.doc.querySelector('#sched-filter .fb-chip[data-fb-value="paused"]')?.getAttribute('aria-pressed')).toBe('true');
    expect((again.doc.querySelector('#sched-filter .fb-pins') as HTMLElement).hidden).toBe(false);
    expect((again.doc.querySelector('#sched-filter .fb-panel') as HTMLElement).hidden).toBe(false);
    expect((again.doc.querySelector('#sched-filter .fb-sortsel') as HTMLSelectElement).value).toBe('created');
    expect(again.doc.querySelector('#sched-filter .fb-dir')?.getAttribute('title')).toBe('Descending');
    expect(ids(again)).toEqual(['b2c3d4']);
    expect(again.doc.querySelector('#sched-filter .fb-sumtext')?.textContent).toBe('Showing 1 of 5');
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
        undo: 'fleetherd skills revert deploy-check 0001-abc',
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

  it('lists the pending preference suggestions above the reviews, and dismisses one', async () => {
    const pending = [
      { text: 'answers lead with the conclusion', count: 3, at, from: [{ title: 'Right sidebar', topic: A }, { title: 'Deploy' }] },
      { text: 'delete credentials to the trash, never for good', count: 1, at, from: [{ title: 'Vault' }] },
    ];
    const h = await open({
      replies: {
        'api/reviews': reply([review()], { pending }),
        'api/reviews/op': reply([review()], { pending: [pending[1]] }),
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(h.doc.querySelector('.rev-pending')));

    const block = h.doc.querySelector('.rev-pending')!;
    // Above the reviews, and saying that nothing here is in force.
    expect(h.el('sched-reviews-list').firstElementChild).toBe(block);
    expect(block.textContent).toContain('Suggestions · 2');
    expect(block.textContent).toContain('Not in effect anywhere');
    // The note says what each answer does, now that there are two of them.
    expect(block.textContent).toContain('Adopt opens a new topic');
    const items = block.querySelectorAll('.rev-pitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('answers lead with the conclusion');
    expect(items[0]!.textContent).toContain('3 reviews · Right sidebar, Deploy');
    expect(items[0]!.querySelector('.rev-adopt')!.textContent).toBe('Adopt');
    expect(items[1]!.querySelector('.rev-pmeta')!.textContent).toBe('Vault');

    (items[0]!.querySelector('.rev-dismiss') as HTMLElement).click();
    await until('the dismissal', () => h.doc.querySelectorAll('.rev-pitem').length === 1);
    expect(h.calls.find((c) => c.path === 'api/reviews/op')?.body).toEqual({
      action: 'dismiss',
      text: 'answers lead with the conclusion',
    });
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 1');
    // Dismissing is not opening: no review row was toggled by the click.
    expect(h.doc.querySelector('.rev-detail')).toBeNull();
  });

  it('offers Archive for an archive suggestion, through the Skills tab\'s own operation', async () => {
    const pending = [
      {
        text: 'Archive simular-box, merged into sbox',
        archive: { name: 'simular-box', into: 'sbox' },
        reason: 'the same tool, written twice',
        count: 1,
        at,
        from: [{ title: 'mcpmux' }],
      },
    ];
    const suggestion = review({
      outcome: 'preferences',
      summary: '1 archive suggestion',
      changes: [
        {
          action: 'archive',
          name: 'simular-box',
          into: 'sbox',
          suggested: true,
          command: 'fleetherd skills archive simular-box',
        },
      ],
      preferences: [],
    });
    const replies: Record<string, unknown> = {
      'api/reviews': reply([suggestion], { pending }),
      'api/skills/op': { ok: true, skills: [] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(h.doc.querySelector('.rev-pending')));

    const item = h.doc.querySelector('.rev-pitem')!;
    expect(item.textContent).toContain('the same tool, written twice');
    expect(item.querySelector('[data-rev-adopt]')).toBeNull();
    // The change row says it was a suggestion and names the command that carries it out.
    (h.doc.querySelector('.rev-item') as HTMLElement).click();
    await until('the detail', () => Boolean(h.doc.querySelector('.rev-detail')));
    const change = h.doc.querySelector('.rev-change')!;
    expect(change.textContent).toContain('Archive simular-box into sbox');
    expect(change.querySelector('.rev-status')!.textContent).toBe('suggested');
    expect(change.querySelector('.rev-undo')!.textContent).toBe('fleetherd skills archive simular-box');

    replies['api/reviews'] = reply([suggestion], { pending: [] });
    (h.doc.querySelector('[data-rev-archive]') as HTMLElement).click();
    await until('the archive', () => h.calls.some((c) => c.path === 'api/skills/op'));
    expect(h.calls.find((c) => c.path === 'api/skills/op')?.body).toEqual({ action: 'archive', name: 'simular-box' });
    // Gone once the daemon no longer lists it — the skill is archived, so the suggestion is done.
    await until('the refreshed list', () => h.doc.querySelector('.rev-pending') === null);
  });

  it('keeps a list answer that predates an archive suggestion out of the skills cache', async () => {
    const skill = {
      name: 'simular-box',
      description: 'the old name',
      version: 'v1',
      status: 'active',
      pinned: false,
      resident: false,
      uses: 0,
      agents: [],
    };
    const archived = { ...skill, status: 'archived' };
    const pending = [
      { text: 'Archive simular-box', archive: { name: 'simular-box' }, count: 1, at, from: [{ title: 'mcpmux' }] },
    ];
    const replies: Record<string, unknown> = {
      'api/skills': { enabled: true, skills: [skill] },
      'api/reviews': reply([review()], { pending }),
      'api/skills/op': { ok: true, skills: [archived] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));

    // Seed the cache, then open again with a list request held and close the window under it.
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('simular-box'));
    await h.click('#skills-close');
    const real = h.window.fetch;
    let releaseOld!: () => void;
    let held = false;
    (h.window as any).fetch = (path: string, init?: any) => {
      if (path === 'api/skills' && !held) {
        held = true;
        return new Promise((resolve) => {
          releaseOld = () =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: () => Promise.resolve({ enabled: true, skills: [skill] }),
            });
        });
      }
      return real(path, init);
    };
    await h.click('#skills-toggle');
    await h.click('#skills-close');

    // Archive from Reviews while that request is still in the air.
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(h.doc.querySelector('.rev-pending')));
    replies['api/skills'] = { enabled: true, skills: [archived] };
    const reviews = (): number => h.calls.filter((c) => c.path === 'api/reviews').length;
    const before = reviews();
    (h.doc.querySelector('[data-rev-archive]') as HTMLElement).click();
    // The archive has been answered and its own follow-ups have run.
    await until('the archive answer', () => reviews() > before);

    // The held answer is what the store said before the archive: it must not reach the cache.
    releaseOld();
    await until('the cache', () => {
      const d = JSON.parse(h.window.localStorage.getItem('aa_skills') || '{}') as { skills?: Array<{ status?: string }> };
      return d.skills?.[0]?.status === 'archived';
    });
  });

  it('keeps an archive suggestion and says why when the archive is refused', async () => {
    const pending = [
      { text: 'Archive simular-box', archive: { name: 'simular-box' }, count: 1, at, from: [{ title: 'mcpmux' }] },
    ];
    const h = await open({
      replies: {
        'api/reviews': reply([review()], { pending }),
        'api/skills/op': { ok: false, error: 'no skill named "simular-box"' },
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(h.doc.querySelector('.rev-pending')));
    (h.doc.querySelector('[data-rev-archive]') as HTMLElement).click();
    await until('the note', () => h.doc.body.textContent!.includes('Could not archive simular-box: no skill named'));
    expect((h.doc.querySelector('[data-rev-archive]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('draws no pending block when nothing is pending', async () => {
    const h = await open({ replies: { 'api/reviews': reply([review()], { pending: [] }) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));
    expect(h.doc.querySelector('.rev-pending')).toBeNull();
  });

  const SUGGESTION = 'answers lead with the conclusion';
  const OTHER = 'delete credentials to the trash, never for good';
  const pendingList = (): Array<Record<string, unknown>> => [
    { text: SUGGESTION, count: 3, at, from: [{ title: 'Right sidebar', topic: A }] },
    { text: OTHER, count: 1, at, from: [{ title: 'Vault' }] },
  ];

  /** The Reviews tab, open on a pending list, with `api/topics` answering the new topic. */
  const reviewing = async (
    opts: {
      topicsStatus?: number;
      topicsReply?: Record<string, unknown>;
      held?: Record<string, Promise<void>>;
    } = {}
  ): Promise<Harness> => {
    const h = await open({
      replies: {
        'api/reviews': reply([review()], { pending: pendingList() }),
        'api/reviews/op': reply([review()], { pending: [pendingList()[1]] }),
        'api/topics': opts.topicsReply ?? { topic: { id: 'd4e5f6a7', title: '', lastAt: at } },
      },
      ...(opts.topicsStatus ? { status: { 'api/topics': opts.topicsStatus } } : {}),
      ...(opts.held ? { held: opts.held } : {}),
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(h.doc.querySelector('.rev-pending')));
    return h;
  };

  it('adopts a suggestion into a new topic as a draft, and sends nothing', async () => {
    const h = await reviewing();
    const fresh = 'd4e5f6a7';

    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the new topic', () => h.window.location.search.includes(fresh));

    expect(h.calls.find((c) => c.path === 'api/topics')?.body).toEqual({});
    const draft = (h.el('input') as HTMLTextAreaElement).value;
    expect(draft).toContain('standing instructions');
    expect(draft).toContain('instructions/');
    expect(draft).toContain('diff');
    expect(draft).toContain(`"${SUGGESTION}"`);
    // A draft, not a message: nothing went out, and the suggestion is still on the list.
    expect(h.calls.map((c) => c.path)).not.toContain('api/send');
    expect(h.calls.map((c) => c.path)).not.toContain('api/reviews/op');
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 2');
  });

  it('takes a suggestion off the list once the draft is actually sent', async () => {
    const h = await reviewing();

    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the draft', () => Boolean((h.el('input') as HTMLTextAreaElement).value));
    // The new topic's stream opening asks for the list again. Let that answer land first, so
    // what is asserted below is the dismissal rather than a race with a list fetched earlier.
    await until('the list refreshed', () => h.calls.filter((c) => c.path === 'api/reviews').length === 2);
    await tick();
    await h.click('#composer button[type="submit"]');
    await until('the dismissal', () => h.calls.some((c) => c.path === 'api/reviews/op'));

    expect(h.calls.find((c) => c.path === 'api/reviews/op')?.body).toEqual({
      action: 'dismiss',
      text: SUGGESTION,
    });
    await until('one suggestion left', () => h.doc.querySelectorAll('.rev-pitem').length === 1);
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 1');
  });

  it('leaves the suggestion alone when the draft is replaced before anything is sent', async () => {
    const h = await reviewing();

    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the draft', () => Boolean((h.el('input') as HTMLTextAreaElement).value));
    // Thrown away and replaced: the message that goes out carries nothing of the suggestion.
    (h.el('input') as HTMLTextAreaElement).value = 'never mind, something else';
    await h.click('#composer button[type="submit"]');
    await until('the send', () => h.calls.some((c) => c.path === 'api/send'));
    await tick();

    expect(h.calls.map((c) => c.path)).not.toContain('api/reviews/op');
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 2');
  });

  it('says why a topic could not be opened, and keeps the suggestion', async () => {
    const refusal =
      'every one of the 64 topics is starred or in use; unstar or delete one before opening another';
    const h = await reviewing({
      topicsStatus: 409,
      topicsReply: { error: refusal },
    });

    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the refusal', () => h.alerts.length > 0);

    expect(h.alerts[0]).toBe(`Could not open a new topic: ${refusal}`);
    // Still in the conversation it was in, with the suggestion untouched and Adopt usable again.
    expect(h.window.location.search).toContain(`t=${A}`);
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 2');
    expect((h.doc.querySelector('.rev-adopt') as HTMLButtonElement).disabled).toBe(false);
    expect(h.calls.map((c) => c.path)).not.toContain('api/send');
  });

  it('dismisses when the echo arrives before the send is acknowledged', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const h = await reviewing({ held: { 'api/send': gate } });

    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the draft', () => Boolean((h.el('input') as HTMLTextAreaElement).value));
    await until('the list refreshed', () => h.calls.filter((c) => c.path === 'api/reviews').length === 2);
    await tick();
    await h.click('#composer button[type="submit"]');
    const nonce = h.calls.find((c) => c.path === 'api/send')?.body.nonce as string;

    // The daemon emits the echo before it answers the POST. claim() is what takes the message
    // out of unsent, so the dismissal has to be settled there — by the 2xx there is no record.
    await h.emit({ t: 'msg', msg: { ...message('w1', '<div class="raw">a draft</div>', true), nonce } });
    await until('the dismissal', () => h.calls.some((c) => c.path === 'api/reviews/op'));

    release();
    await tick();
    await tick();
    expect(h.calls.filter((c) => c.path === 'api/reviews/op')).toHaveLength(1);
    expect(h.calls.find((c) => c.path === 'api/reviews/op')?.body).toEqual({
      action: 'dismiss',
      text: SUGGESTION,
    });
  });

  it('does not dismiss after a reload, which forgets what the draft was for', async () => {
    const h = await reviewing();
    const fresh = 'd4e5f6a7';
    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the draft', () => Boolean((h.el('input') as HTMLTextAreaElement).value));

    // The topic, the draft and the pending list all survive a reload; the link between the draft
    // and the suggestion is this page's memory, so it does not. The suggestion must stay.
    const again = await open({
      url: h.window.location.href,
      idb: h.idb,
      storage: { aa_drafts: h.window.localStorage.getItem('aa_drafts')! },
      replies: {
        'api/reviews': reply([review()], { pending: pendingList() }),
        'api/reviews/op': reply([review()], { pending: [pendingList()[1]] }),
      },
    });
    await again.emit(sync(fresh, [], [A, fresh]));
    expect((again.el('input') as HTMLTextAreaElement).value).toContain(`"${SUGGESTION}"`);

    await again.click('#composer button[type="submit"]');
    await until('the send', () => again.calls.some((c) => c.path === 'api/send'));
    await tick();
    expect(again.calls.map((c) => c.path)).not.toContain('api/reviews/op');

    await again.click('#schedules-toggle');
    await again.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(again.doc.querySelector('.rev-pending')));
    expect(again.doc.querySelectorAll('.rev-pitem')).toHaveLength(2);
  });

  it('does not let a list fetched before a dismissal put the suggestion back', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const held: Record<string, Promise<void>> = {};
    const h = await reviewing({ held });
    await h.emit(sync(A, [], [A, B]));

    // A refresh starts (the stream of a topic switched to asks for the list) and is held. Its
    // answer still carries both suggestions, because it was fetched before the dismissal.
    held['api/reviews'] = gate;
    await h.click(`[data-topic="${B}"]`);
    await until('the held refresh', () => h.calls.filter((c) => c.path === 'api/reviews').length === 2);

    (h.doc.querySelector('.rev-dismiss') as HTMLElement).click();
    await until('the dismissal', () => h.calls.some((c) => c.path === 'api/reviews/op'));
    await until('one suggestion left', () => h.doc.querySelectorAll('.rev-pitem').length === 1);

    release();
    await tick();
    await tick();
    expect(h.doc.querySelectorAll('.rev-pitem')).toHaveLength(1);
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 1');
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
    expect(detail.textContent).toContain('fleetherd skills revert deploy-check 0001-abc');
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
    resident: false,
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
      { id: 'c4f06d73eaad', at: '2026-11-02T00:00:00.000Z', action: 'patch', beforeVersion: '0123456789ab', afterVersion: 'fedcba987654' },
      { id: '9b1e2d3c4f5a', at: '2026-11-01T00:00:00.000Z', action: 'create' },
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
    const sw = h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.textContent).toBe('On');
    expect(h.el('skills-list').textContent).toContain('pinned');
    expect(h.el('skills-list').textContent).toContain('last used');
    expect(h.el('skills-list').textContent).toContain('3 uses');
  });

  it('marks a resident skill and its category, and warns about a description too long for it', async () => {
    const resident = entry({ name: 'server-ops', resident: true, category: '运维', warning: 'the description is 130 characters; a resident skill\'s is in every agent\'s context and should be at most 120' });
    const h = await open({ replies: { 'api/skills': list([entry(), resident]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('server-ops'));

    const card = (name: string): Element => h.doc.querySelector(`[data-skill="${name}"]`)!;
    const pressed = (name: string): string | null | undefined =>
      card(name).querySelector('[data-sop="tier"][aria-pressed="true"]')?.textContent;
    expect(card('server-ops').closest('[data-group]')!.getAttribute('data-group')).toBe('resident');
    expect(pressed('server-ops')).toBe('Resident');
    expect(card('server-ops').querySelector('.skill-cat')!.textContent).toBe('运维');
    expect(card('server-ops').querySelector('.skill-warn')!.textContent).toMatch(/130 characters/);
    expect(card('deploy-check').closest('[data-group]')!.getAttribute('data-group')).toBe('library');
    expect(pressed('deploy-check')).toBe('Library');
  });

  it('splits the list into Library and Resident tabs with their counts, off skills last in their tab', async () => {
    const h = await open({
      replies: {
        'api/skills': list([
          entry({ name: 'a-lib' }),
          entry({ name: 'b-res', resident: true }),
          entry({ name: 'c-off', status: 'archived', resident: true }),
          entry({ name: 'd-lib', status: 'expired' }),
        ]),
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('a-lib'));

    const tabs = [...h.doc.querySelectorAll('#skills-list [data-stab]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Library2', 'Resident2']);
    const pane = (k: string): Element => h.doc.querySelector(`#skills-list [data-pane="${k}"]`)!;
    const rows = (k: string, g: string): Array<string | null> =>
      [...pane(k).querySelectorAll(`[data-group="${g}"] [data-skill]`)].map((r) => r.getAttribute('data-skill'));
    expect((pane('library') as HTMLElement).hidden).toBe(false);
    expect((pane('resident') as HTMLElement).hidden).toBe(true);
    expect(rows('library', 'library')).toEqual(['a-lib', 'd-lib']);
    expect(rows('resident', 'resident')).toEqual(['b-res']);
    expect(rows('resident', 'off')).toEqual(['c-off']);

    (h.doc.querySelector('[data-stab="resident"]') as HTMLElement).click();
    expect((pane('resident') as HTMLElement).hidden).toBe(false);
    expect((pane('library') as HTMLElement).hidden).toBe(true);
    // An expired skill is still on — still delivered — and says why it may not stay that way.
    const expired = h.doc.querySelector('[data-skill="d-lib"]')!;
    expect(expired.querySelector('[data-sop="enabled"]')!.getAttribute('aria-checked')).toBe('true');
    expect(expired.querySelector('.skill-state.expired')!.textContent).toBe('Expired');
    // Off: the switch says so, and the tier is greyed rather than hidden — it is where the skill
    // comes back to, and the store would refuse to move an archived one anyway.
    const off = h.doc.querySelector('[data-skill="c-off"]')!;
    expect(off.querySelector('[data-sop="enabled"]')!.getAttribute('aria-checked')).toBe('false');
    expect(off.querySelector('[data-sop="enabled"]')!.textContent).toBe('Off');
    const tiers = [...off.querySelectorAll<HTMLButtonElement>('[data-sop="tier"]')];
    expect(tiers.map((b) => b.disabled)).toEqual([true, true]);
    expect(off.querySelector('[data-sop="tier"][aria-pressed="true"]')!.textContent).toBe('Resident');
  });

  it('lists the searches that found nothing, and the hits nobody opened', async () => {
    const searches = {
      misses: [{ at: '2026-11-06T00:00:00.000Z', query: 'rotate the vpn certificate', agent: 'cx', hits: [] }],
      unread: [{ at: '2026-11-06T00:00:00.000Z', query: 'deploy', hits: ['deploy-check'] }],
    };
    const h = await open({ replies: { 'api/skills': { ...list(), searches } } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    const text = h.el('skills-list').textContent!;
    expect(text).toContain('Searches that found nothing');
    expect(text).toContain('rotate the vpn certificate');
    expect(text).toContain('Found, but not opened');
    const rows = [...h.doc.querySelectorAll('.skill-search')].map((r) => r.textContent);
    expect(rows[1]).toContain('deploy-check');
  });

  it('makes a skill resident from its page, and back', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    const tier = (r: '1' | '0'): HTMLElement => h.el('skills-detail').querySelector(`[data-sop="tier"][data-resident="${r}"]`) as HTMLElement;
    expect(tier('0').getAttribute('aria-pressed')).toBe('true');
    expect(h.el('skills-count').textContent).toBe('Library');
    // The tier it is already in does nothing.
    tier('0').click();
    await tick();
    expect(h.calls.some((c) => c.body?.action === 'resident')).toBe(false);

    tier('1').click();
    await until('the tier op', () => h.calls.some((c) => c.body?.action === 'resident'));
    expect(h.calls.find((c) => c.body?.action === 'resident')?.body).toEqual({ action: 'resident', name: 'deploy-check', resident: true });
    // The page reads the skill again rather than trusting the switch it drew.
    await until('the re-read', () => h.calls.filter((c) => c.body?.action === 'show').length === 2);
  });

  it('moves a skill between resident and library from its row, without opening it', async () => {
    const resident = entry({ resident: true });
    const replies: Record<string, unknown> = { 'api/skills': list([resident]), 'api/skills/op': opReply([entry()]) };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    expect(h.doc.querySelector('[data-skill="deploy-check"]')!.closest('[data-group]')!.getAttribute('data-group')).toBe('resident');

    const pressed = (): string | null | undefined =>
      h.doc.querySelector('[data-skill="deploy-check"] [data-sop="tier"][aria-pressed="true"]')?.textContent;
    (h.doc.querySelector('[data-skill="deploy-check"] [data-sop="tier"][data-resident="0"]') as HTMLElement).click();
    // Switched on the tap, before any answer: with skills.repo set, the answer takes seconds.
    expect(pressed()).toBe('Library');
    await until('the tier op', () => h.calls.some((c) => c.body?.action === 'resident'));

    expect(h.calls.find((c) => c.body?.action === 'resident')?.body).toEqual({ action: 'resident', name: 'deploy-check', resident: false });
    expect(h.calls.some((c) => c.body?.action === 'show')).toBe(false);
    await tick();
    // The row stays in the tab it was drawn in, switched; it moves when the list is next drawn.
    expect(h.doc.querySelector('[data-skill="deploy-check"]')!.closest('[data-pane]')!.getAttribute('data-pane')).toBe('resident');
    expect(pressed()).toBe('Library');
    expect(h.el('skills-detail').hidden).toBe(true);
    expect(h.el('skills-list').hidden).toBe(false);
  });

  it('shows the store\'s refusal in sight of the row, and leaves the row as it was', async () => {
    const replies: Record<string, unknown> = {
      'api/skills': list(),
      'api/skills/op': {
        ok: false,
        error: "a resident skill's description is in every agent's context: at most 120 characters, this one is 134; shorten it and move the detail into the body",
      },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    const pressed = (): string | null | undefined => h.doc.querySelector('[data-skill="deploy-check"] [aria-pressed="true"]')?.textContent;
    (h.doc.querySelector('[data-skill="deploy-check"] [data-sop="tier"][data-resident="1"]') as HTMLElement).click();
    expect(pressed()).toBe('Resident');
    await until('the refusal', () => !h.el('skills-note').hidden);

    expect(h.el('skills-note').textContent).toMatch(/this one is 134/);
    // Put back as the store has it.
    await until('the switch back on Library', () => pressed() === 'Library');
    // Sticky, so it is seen from wherever in the list the switch was tapped.
    expect(renderPage('Chat', false)).toMatch(/#skills-note\{position:sticky;/);
  });

  it('opens a skill from its name, not from its switches', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    const row = h.doc.querySelector('[data-skill="deploy-check"]')!;
    // The row is not a button itself — it holds buttons — and the name is the one that opens it.
    expect(row.getAttribute('role')).toBeNull();
    (row.querySelector('.skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    expect(h.calls.find((c) => c.path === 'api/skills/op')?.body).toEqual({ action: 'show', name: 'deploy-check' });
  });

  it('says on the card why a hand-committed skill is not delivered', async () => {
    const broken = entry({ name: 'broken-one', problem: 'SKILL.md must start with a --- frontmatter block naming the skill and describing it' });
    const h = await open({ replies: { 'api/skills': list([entry(), broken]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('broken-one'));

    const card = (name: string): Element => h.doc.querySelector(`[data-skill="${name}"]`)!;
    expect(card('broken-one').querySelector('.skill-problem')!.textContent).toBe(
      'Not delivered: SKILL.md must start with a --- frontmatter block naming the skill and describing it'
    );
    expect(card('deploy-check').querySelector('.skill-problem')).toBeNull();
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

  it('offers to undo a commit someone made in the repository by hand, and names who', async () => {
    const handMade = detail({
      history: [
        { id: 'abcdef123456', at: '2026-11-02T00:00:00.000Z', action: 'commit', author: 'noir', note: 'docs: rewrite by hand' },
        { id: '0123456789ab', at: '2026-11-01T00:00:00.000Z', action: 'create', author: 'fleetherd' },
        // Before 3.0.0 the gateway's commits were authored talkcode*: still its own, still unnamed.
        { id: '00000000abcd', at: '2026-10-01T00:00:00.000Z', action: 'patch', author: 'talkcode-web' },
      ],
    });
    const replies = { 'api/skills': list(), 'api/skills/op': opReply([entry()], handMade) };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    const rows = [...h.doc.querySelectorAll('.skill-hist')];
    expect(rows[0]!.textContent).toContain('noir');
    expect(rows[0]!.textContent).toContain('docs: rewrite by hand');
    expect(rows[0]!.querySelector('[data-revert="abcdef123456"]')).not.toBeNull();
    // The gateway's own name is not repeated on every row, and a first version has nothing to restore.
    expect(rows[1]!.textContent).not.toContain('fleetherd');
    expect(rows[1]!.querySelector('[data-revert]')).toBeNull();
    expect(rows[2]!.textContent).not.toContain('talkcode');
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
      id: 'c4f06d73eaad',
    });
  });

  it('turns a skill off from its row in one tap — an archive — and on again', async () => {
    const archived = entry({ status: 'archived' });
    const replies: Record<string, unknown> = { 'api/skills': list(), 'api/skills/op': { ok: true, skills: [archived] } };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    const sw = (): HTMLElement => h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement;

    sw().click();
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(sw().textContent).toBe('Off');
    await until('the archive', () => h.calls.some((c) => c.body?.action === 'archive'));
    expect(h.calls.find((c) => c.body?.action === 'archive')?.body).toEqual({ action: 'archive', name: 'deploy-check' });
    expect(h.calls.filter((c) => c.path === 'api/skills/op')).toHaveLength(1);
    await tick();
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(h.doc.querySelector('[data-skill="deploy-check"]')!.classList.contains('skill-off')).toBe(true);
    expect(h.el('skills-detail').hidden).toBe(true);

    // A second tap at once is not swallowed while the first is answered: it queues behind it.
    replies['api/skills/op'] = { ok: true, skills: [entry()] };
    sw().click();
    expect(sw().getAttribute('aria-checked')).toBe('true');
    await until('the restore', () => h.calls.some((c) => c.body?.action === 'restore'));
    expect(h.calls.find((c) => c.body?.action === 'restore')?.body).toEqual({ action: 'restore', name: 'deploy-check' });
    await tick();
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('turns an archived skill on from its page, and stays on the page', async () => {
    const archived = entry({ status: 'archived' });
    const replies = {
      'api/skills': list([archived]),
      'api/skills/op': opReply([archived], detail({ skill: archived })),
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    expect(h.el('skills-count').textContent).toBe('Off');
    expect(h.el('skills-detail').querySelector('[data-sop="archive"],[data-sop="restore"]')).toBeNull();

    (h.el('skills-detail').querySelector('[data-sop="enabled"]') as HTMLElement).click();
    await until('the restore', () => h.calls.some((c) => c.body?.action === 'restore'));
    expect(h.calls.find((c) => c.body?.action === 'restore')?.body).toEqual({ action: 'restore', name: 'deploy-check' });
    await until('the re-read', () => h.calls.filter((c) => c.body?.action === 'show').length === 2);
    expect(h.el('skills-detail').hidden).toBe(false);
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

  it('copies the name from a row and from the skill page, with a moment of feedback', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    const rowCopy = h.doc.querySelector('[data-skill="deploy-check"] [data-copy-skill]')!;
    expect(face(rowCopy)).toBe('[copy]');
    (rowCopy as HTMLElement).click();
    await tick();
    expect(h.clipboard).toEqual(['deploy-check']);
    expect(face(rowCopy)).toBe('[check]');
    // Copying is not opening: the row stayed on screen and the page did not move.
    expect(h.el('skills-detail').hidden).toBe(true);
    // The mark is a moment, not a new state: it goes back on its own.
    await within('the copy mark back', 3000, () => face(rowCopy) === '[copy]');

    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    const headCopy = h.el('skills-detail').querySelector('.skill-head [data-copy-skill]')!;
    (headCopy as HTMLElement).click();
    await tick();
    expect(h.clipboard).toEqual(['deploy-check', 'deploy-check']);
    // Copying is not opening: the row stayed put and the page did not move.
    expect(h.el('skills-detail').hidden).toBe(false);
  });

  it('falls back to the old copy command when the page has no clipboard API', async () => {
    const h = await open({ replies: { 'api/skills': list() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    // A plain-http origin, which is exactly how this page is reached on a LAN.
    Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: undefined });
    let copied = '';
    (h.doc as unknown as { execCommand: (cmd: string) => boolean }).execCommand = (cmd: string) => {
      copied = (h.doc.querySelector('textarea[readonly]') as HTMLTextAreaElement | null)?.value ?? '';
      return cmd === 'copy';
    };

    const rowCopy = h.doc.querySelector('[data-skill="deploy-check"] [data-copy-skill]') as HTMLElement;
    rowCopy.focus();
    rowCopy.click();
    await tick();
    expect(copied).toBe('deploy-check');
    expect(h.clipboard).toEqual([]);
    expect(face(rowCopy)).toBe('[check]');
    // The temporary field is not left in the page, and the focus went back where it was.
    expect(h.doc.querySelector('textarea[readonly]')).toBeNull();
    expect(h.doc.activeElement).toBe(rowCopy);
  });

  it('says the copy failed when the fallback cannot copy, and leaves no field or focus behind', async () => {
    const h = await open({ replies: { 'api/skills': list() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: undefined });
    (h.doc as unknown as { execCommand: () => boolean }).execCommand = () => false;
    const rowCopy = h.doc.querySelector('[data-skill="deploy-check"] [data-copy-skill]') as HTMLElement;
    rowCopy.focus();
    rowCopy.click();
    await tick();
    expect(h.el('skills-note').hidden).toBe(false);
    expect(h.el('skills-note').textContent).toContain('Could not copy the name');
    expect(h.doc.querySelector('textarea[readonly]')).toBeNull();
    expect(h.doc.activeElement).toBe(rowCopy);

    // The same when the command throws: the field still goes, and the page says why.
    (h.doc as unknown as { execCommand: () => boolean }).execCommand = () => {
      throw new Error('execCommand refused');
    };
    rowCopy.click();
    await tick();
    expect(h.doc.querySelector('textarea[readonly]')).toBeNull();
    expect(h.doc.activeElement).toBe(rowCopy);
  });

  it('opens on the cached list and redraws it only when the store moved on', async () => {
    const held: Record<string, Promise<void>> = {};
    const replies: Record<string, unknown> = { 'api/skills': list() };
    const h = await open({ replies, held });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    await h.click('#skills-close');

    // The second open's refresh is held: what is on screen before it answers is the cache.
    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    await h.click('#skills-toggle');
    expect(h.el('skills-list').textContent).toContain('deploy-check');
    expect(h.el('skills-list').textContent).not.toContain('Loading');
    const row = h.doc.querySelector('[data-skill="deploy-check"]');

    // The same answer is not a change: the row drawn from the cache is left alone.
    release();
    await until('the silent refresh', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(h.doc.querySelector('[data-skill="deploy-check"]')).toBe(row);

    // A different answer is, and the list is drawn again from it.
    await h.click('#skills-close');
    replies['api/skills'] = list([entry(), entry({ name: 'second-skill' })]);
    let release2!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release2 = r; });
    await h.click('#skills-toggle');
    expect(h.el('skills-list').textContent).not.toContain('second-skill');
    release2();
    await until('the changed list', () => h.el('skills-list').textContent!.includes('second-skill'));
  });

  it('keeps a silent refresh quiet when it fails, and says so when the button asks', async () => {
    const replies = { 'api/skills': list() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    await h.click('#skills-close');

    h.status['api/skills'] = 500;
    await h.click('#skills-toggle');
    await until('the failed refresh', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(h.el('skills-note').hidden).toBe(true);
    expect(h.el('skills-list').textContent).toContain('deploy-check');

    await h.click('#skills-refresh');
    await until('the failure note', () => !h.el('skills-note').hidden);
    expect(h.el('skills-note').textContent).toContain('Could not refresh skills');
    // The list the cache drew is still there to use.
    expect(h.el('skills-list').textContent).toContain('deploy-check');
  });

  it('refreshes the open skill from the button, but never over unsaved text', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    // Nothing typed: the page reads the skill again, and stays on it.
    await h.click('#skills-refresh');
    await until('the re-read', () => h.calls.filter((c) => c.body.action === 'show').length === 2);
    expect(h.el('skills-detail').hidden).toBe(false);

    // Typed into: the same button refreshes the list behind, and the text is not touched.
    (h.el('skill-text') as HTMLTextAreaElement).value = 'an unsaved draft';
    await h.click('#skills-refresh');
    await until('the second refresh', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(h.calls.filter((c) => c.body.action === 'show')).toHaveLength(2);
    expect((h.el('skill-text') as HTMLTextAreaElement).value).toBe('an unsaved draft');
    expect(h.el('skills-detail').hidden).toBe(false);
  });

  it('refreshes behind an open skill without taking the page away', async () => {
    const held: Record<string, Promise<void>> = {};
    const replies: Record<string, unknown> = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies, held });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    await h.click('#skills-close');

    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    await h.click('#skills-toggle');
    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    const editor = h.el('skill-text');

    // The background answer names another skill: the list's data changes, the page does not.
    replies['api/skills'] = list([entry(), entry({ name: 'new-one' })]);
    release();
    await until('the refresh', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(h.el('skills-detail').hidden).toBe(false);
    expect(h.el('skill-text')).toBe(editor);
    expect((h.el('skill-text') as HTMLTextAreaElement).value).toBe(MD);

    // It is there when the person goes back, because the data behind the page did change.
    await h.click('#skills-back');
    expect(h.el('skills-list').textContent).toContain('new-one');
  });

  it('carries the list across a reload, so the first open after one is not a wait', async () => {
    const h = await open({ replies: { 'api/skills': list() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    const saved = h.window.localStorage.getItem('aa_skills');
    expect(saved).toContain('deploy-check');
    expect((JSON.parse(saved!) as { searches?: unknown }).searches).toBeUndefined();
    await h.click('#skills-close');

    // A new page, with the daemon slow to answer: the list is drawn from what the last page kept.
    const held: Record<string, Promise<void>> = {};
    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    const again = await open({ replies: {}, held, storage: { aa_skills: saved! } });
    await again.emit(sync(A, [], [A]));
    await again.click('#skills-toggle');
    expect(again.el('skills-list').textContent).toContain('deploy-check');
    expect(again.el('skills-list').textContent).not.toContain('Loading');

    // And the refresh still wins: this daemon has no skills store.
    release();
    await until('the answer', () => again.el('skills-list').textContent!.includes('No managed skills yet'));
  });

  it('drops a list answer a write made stale, and asks again once the write is done', async () => {
    const replies: Record<string, unknown> = {
      'api/skills': list(),
      'api/skills/op': { ok: true, skills: [entry({ status: 'archived' })] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    await h.click('#skills-close');

    // The next list request is answered with what the store said before the tap, after the tap.
    const real = h.window.fetch;
    let releaseOld!: () => void;
    let held = false;
    (h.window as any).fetch = (path: string, init?: any) => {
      if (path === 'api/skills' && !held) {
        held = true;
        return new Promise((resolve) => {
          releaseOld = () =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: () => Promise.resolve(list()),
            });
        });
      }
      return real(path, init);
    };

    await h.click('#skills-toggle'); // cached list; its refresh is the held one
    const sw = (): HTMLElement => h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement;
    sw().click();
    await until('the archive answer', () => h.calls.some((c) => c.body?.action === 'archive'));
    expect(sw().getAttribute('aria-checked')).toBe('false');

    // The store now has the archive; the held answer is what it said before the tap. The marker
    // row can only come from the replay, so it proves the stale answer was not applied.
    replies['api/skills'] = list([entry({ status: 'archived' }), entry({ name: 'after-write' })]);
    releaseOld();
    await until('the list asked again', () => h.el('skills-list').textContent!.includes('after-write'));
    const after = h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement;
    expect(after.getAttribute('aria-checked')).toBe('false');
    const saved = JSON.parse(h.window.localStorage.getItem('aa_skills') || '{}') as { skills?: Array<{ name?: string; status?: string }> };
    expect(saved.skills?.find((s) => s.name === 'deploy-check')?.status).toBe('archived');
  });

  it('draws a refresh that arrived during a switch once the switch is done', async () => {
    const held: Record<string, Promise<void>> = {};
    const replies: Record<string, unknown> = {
      'api/skills': list(),
      'api/skills/op': { ok: true, skills: [entry({ status: 'archived' })] },
    };
    const h = await open({ replies, held });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    let release!: () => void;
    held['api/skills/op'] = new Promise<void>((r) => { release = r; });
    (h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement).click();
    await until('the switch sent', () => h.calls.some((c) => c.body?.action === 'archive'));

    // The refresh names a row the page has not drawn yet, and it must not draw it over the tap.
    replies['api/skills'] = list([entry({ status: 'archived' }), entry({ name: 'after-write' })]);
    await h.click('#skills-refresh');
    await until('the refresh answered', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(h.el('skills-list').textContent).not.toContain('after-write');

    // Once the tap's own answer is in, the held-back refresh is asked again and lands.
    release();
    await until('the replay', () => h.el('skills-list').textContent!.includes('after-write'));
    const sw = h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('does not re-read a skill while its switch is still being written', async () => {
    const held: Record<string, Promise<void>> = {};
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies, held });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    const shows = (): number => h.calls.filter((c) => c.body.action === 'show').length;
    expect(shows()).toBe(1);

    // The switch is in flight; a refresh now must not start a show beside the write's own reread.
    let release!: () => void;
    held['api/skills/op'] = new Promise<void>((r) => { release = r; });
    (h.el('skills-detail').querySelector('[data-sop="tier"][data-resident="1"]') as HTMLElement).click();
    await until('the switch sent', () => h.calls.some((c) => c.body.action === 'resident'));
    await h.click('#skills-refresh');
    await until('the refresh', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(shows()).toBe(1);

    release();
    // The write's own reread, then the held refresh replayed: it is asked again and the page is
    // read once more on its answer.
    await until('the held refresh replayed', () => h.calls.filter((c) => c.path === 'api/skills').length >= 3);
    await until('both rereads', () => shows() === 3);
  });

  it('opens the skill again when a switch made the first show stale', async () => {
    const replies: Record<string, unknown> = {
      'api/skills': list(),
      'api/skills/op': { ok: true, skills: [entry({ status: 'archived' })] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    // The first show is held; the switch's answer arrives before it.
    const real = h.window.fetch;
    let releaseShow!: () => void;
    let held = false;
    (h.window as any).fetch = (path: string, init?: any) => {
      const body = path === 'api/skills/op' && init?.body ? (JSON.parse(String(init.body)) as { action?: string }) : null;
      if (body?.action === 'show' && !held) {
        held = true;
        return new Promise((resolve) => {
          releaseShow = () =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              // What the store said before the archive.
              json: () => Promise.resolve({ ok: true, skills: [entry()], detail: detail() }),
            });
        });
      }
      return real(path, init);
    };

    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await tick();
    (h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement).click();
    await until('the archive', () => h.calls.some((c) => c.body?.action === 'archive'));

    // The page the person asked for opens again once the write is done, with the write's state.
    replies['api/skills/op'] = {
      ok: true,
      skills: [entry({ status: 'archived' })],
      detail: detail({ skill: entry({ status: 'archived' }) }),
    };
    releaseShow();
    await until('the reopened page', () => !h.el('skills-detail').hidden);
    expect(h.el('skills-title').textContent).toBe('deploy-check');
    expect(h.el('skills-count').textContent).toBe('Off');
    expect(h.calls.filter((c) => c.body.action === 'show')).toHaveLength(1);
  });

  it('keeps the skill opened last when an older show answers after it', async () => {
    const a = entry({ name: 'a-skill' });
    const b = entry({ name: 'b-skill' });
    const da = detail({ skill: a, file: { path: 'SKILL.md', content: 'A', version: 'a' } });
    const db = detail({ skill: b, file: { path: 'SKILL.md', content: 'B', version: 'b' } });
    const replies: Record<string, unknown> = {
      'api/skills': list([a, b]),
      'api/skills/op': { ok: true, skills: [a, b], detail: db },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('a-skill'));

    const real = h.window.fetch;
    let releaseA!: () => void;
    let held = false;
    (h.window as any).fetch = (path: string, init?: any) => {
      const body = path === 'api/skills/op' && init?.body ? (JSON.parse(String(init.body)) as { action?: string; name?: string }) : null;
      if (body?.action === 'show' && body.name === 'a-skill' && !held) {
        held = true;
        return new Promise((resolve) => {
          releaseA = () =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: () => Promise.resolve({ ok: true, skills: [a, b], detail: da }),
            });
        });
      }
      return real(path, init);
    };

    (h.doc.querySelector('[data-skill="a-skill"] .skill-open') as HTMLElement).click();
    await tick();
    (h.doc.querySelector('[data-skill="b-skill"] .skill-open') as HTMLElement).click();
    await until('b opened', () => h.el('skills-title').textContent === 'b-skill');
    releaseA();
    await tick();
    await tick();
    expect(h.el('skills-title').textContent).toBe('b-skill');
    expect((h.el('skill-text') as HTMLTextAreaElement).value).toBe('B');
  });

  it('ignores a cache written by another shape, and a cached row that is not a skill', async () => {
    const held: Record<string, Promise<void>> = {};
    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    const h = await open({
      replies: { 'api/skills': list() },
      held,
      storage: { aa_skills: JSON.stringify({ v: 99, at: Date.now(), enabled: true, skills: [entry()] }) },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    expect(h.el('skills-list').textContent).toContain('Loading');
    expect(h.el('skills-list').textContent).not.toContain('deploy-check');
    release();
    await until('the list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    const held2: Record<string, Promise<void>> = {};
    let release2!: () => void;
    held2['api/skills'] = new Promise<void>((r) => { release2 = r; });
    const again = await open({
      replies: { 'api/skills': list() },
      held: held2,
      storage: { aa_skills: JSON.stringify({ v: 1, at: Date.now(), enabled: true, skills: [{ name: 'deploy-check' }] }) },
    });
    await again.emit(sync(A, [], [A]));
    await again.click('#skills-toggle');
    expect(again.el('skills-list').textContent).toContain('Loading');
    release2();
    await until('the list', () => again.el('skills-list').textContent!.includes('deploy-check'));
  });

  it('keeps no cached list when the daemon has no skills store', async () => {
    const h = await open({ replies: { 'api/skills': { enabled: false, skills: [] } } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the disabled note', () => h.el('skills-list').textContent!.includes('not enabled'));
    expect(h.window.localStorage.getItem('aa_skills')).toBeNull();
    await h.click('#skills-close');

    const held: Record<string, Promise<void>> = {};
    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    const again = await open({ replies: { 'api/skills': { enabled: false, skills: [] } }, held });
    await again.emit(sync(A, [], [A]));
    await again.click('#skills-toggle');
    expect(again.el('skills-list').textContent).toContain('Loading');
    release();
    await until('the note again', () => again.el('skills-list').textContent!.includes('not enabled'));
  });

  it('leaves the refresh button live during a silent refresh, and a tap makes it manual', async () => {
    const held: Record<string, Promise<void>> = {};
    const h = await open({ replies: { 'api/skills': list() }, held });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    await h.click('#skills-close');

    // The status is read when the request is made, so set it before the silent one leaves.
    h.status['api/skills'] = 500;
    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    await h.click('#skills-toggle');
    const btn = h.el('skills-refresh') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    await h.click('#skills-refresh');
    expect(btn.disabled).toBe(true);
    release();
    await until('the failure', () => !h.el('skills-note').hidden);
    expect(h.el('skills-note').textContent).toContain('Could not refresh skills');
  });
});

describe('webui page: the History tab', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const at = Date.UTC(2026, 10, 9, 12, 0);
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 1,
    key: `webui#main#${A}`,
    title: 'Deploy notes',
    agent: 'cc',
    platform: 'webui',
    lastAt: at,
    messages: 4,
    topic: A,
    ...over,
  });
  const page = (sessions: Array<Record<string, unknown>>, next?: string): Record<string, unknown> => ({
    enabled: true,
    sessions,
    ...(next ? { next } : {}),
  });
  /** Two tool lines exactly as renderWebToolLines writes them. */
  const TOOLS =
    '<div class="tools"><div class="tl"><span class="tl-c">Bash: npm run deploy</span></div>' +
    '<div class="tl"><span class="tl-c">Read: notes.md</span></div></div>';
  /** A read in the shape room.ts historyMessages answers with: the transcript's own messages. */
  const read = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    session: row(),
    messages: [
      { id: 'h1', own: true, html: '<div class="raw">deploy it</div>', at, buttons: [], reactions: [] },
      { id: 'h2', own: false, html: TOOLS, at: at + 500, buttons: [], reactions: [], kind: 'tools' },
      { id: 'h3', own: false, html: '<p>deployed <strong>v2</strong></p>', at: at + 1_000, buttons: [], reactions: [] },
    ],
    ...over,
  });
  const topicList = (stages: Record<string, Record<string, unknown>> = {}): Array<Record<string, unknown>> =>
    [A, B].map((id, i) => ({ id, title: `Topic ${id}`, lastAt: 1000 - i, running: false, msgCount: 0, ...stages[id] }));

  /** Type a query and press Enter, the way a phone's search key does. */
  async function search(h: Harness, q: string): Promise<void> {
    const input = h.el('history-q') as HTMLInputElement;
    input.value = q;
    input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
  }

  /** The History tab, its first page on screen. */
  async function onHistory(h: Harness, until_ = 'Deploy notes'): Promise<void> {
    await h.click('#sb-tab-history');
    await until('the history list', () => h.el('history-list').textContent!.includes(until_));
  }

  /** One conversation opened from the list, read back into the transcript's place. */
  async function openRow(h: Harness, n = 0): Promise<void> {
    (h.doc.querySelectorAll('#history-list .hist-item')[n] as HTMLElement).click();
    await until('the conversation', () => h.el('lib-log').querySelector('.lib-head, .hist-note') !== null);
  }

  const libOn = (h: Harness): boolean => h.el('chat').classList.contains('lib');

  it('is a tab beside Topics in the sidebar header, and the list it shows replaces the topics', async () => {
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, key: 'telegram#chat#9', title: 'Phone chat', agent: 'oc', platform: 'telegram', messages: 1, topic: undefined })]),
      },
    });
    await h.emit(sync(A, [], [A]));
    const title = h.doc.querySelector('#sidebar-header .panel-title')!;
    const tabs = [...title.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Topics', 'History']);
    expect(h.el('sb-tab-topics').getAttribute('aria-selected')).toBe('true');
    expect(h.el('history-pane').hidden).toBe(true);
    // The page never asks the library for anything until the tab is chosen.
    expect(h.calls.some((c) => c.path.startsWith('api/history'))).toBe(false);

    await onHistory(h);

    expect(h.el('sb-tab-history').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sb-tab-history').classList.contains('on')).toBe(true);
    expect(h.el('history-pane').hidden).toBe(false);
    expect(h.el('topics').hidden).toBe(true);
    expect(h.el('topics-filter').hidden).toBe(true);
    // Clear all topics is about the other tab's list.
    expect(h.el('sidebar').classList.contains('on-history')).toBe(true);
    expect(renderPage('Chat', false)).toContain('#sidebar.on-history #clear-topics{display:none}');
    expect(h.el('history-count').textContent).toBe('2 conversations');
    const rows = [...h.doc.querySelectorAll('#history-list .hist-item')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Deploy notes');
    expect(rows[0]!.textContent).toContain('cc · webui');
    expect(rows[0]!.textContent).toContain('4 messages');
    expect(rows[1]!.textContent).toContain('Phone chat');
    expect(rows[1]!.textContent).toContain('oc · telegram');
    expect(h.el('history-more').hidden).toBe(true);

    // Back on Topics, the list is the topics again; the transcript was never touched.
    await h.click('#sb-tab-topics');
    expect(h.el('history-pane').hidden).toBe(true);
    expect(h.el('topics').hidden).toBe(false);
    expect(h.el('sidebar').classList.contains('on-history')).toBe(false);
  });

  it('reads the library again each time the tab is chosen, keeping the rows it has until the answer', async () => {
    const held: Record<string, Promise<void>> = {};
    const h = await open({ replies: { 'api/history': page([row()]) }, held });
    await h.emit(sync(A, [], [A]));
    await onHistory(h);
    const reads = (): number => h.calls.filter((c) => c.path === 'api/history').length;
    expect(reads()).toBe(1);

    // The second read is slow to answer.
    let answer!: () => void;
    held['api/history'] = new Promise<void>((r) => {
      answer = r;
    });
    await h.click('#sb-tab-topics');
    await h.click('#sb-tab-history');
    await until('the second read', () => reads() === 2);
    // No "Loading…" over a list that is already there: the old rows stand until the new ones land.
    expect(h.el('history-list').textContent).toContain('Deploy notes');
    expect(h.el('history-list').textContent).not.toContain('Loading');
    answer();
    await tick();
    // Choosing the tab it is already on is not a reason to ask again.
    await h.click('#sb-tab-history');
    await tick();
    expect(reads()).toBe(2);
  });

  it('pages backwards through the library from the button the daemon offers', async () => {
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, title: 'Second' })], '1762300000000.2'),
        'api/history?before=1762300000000.2': page([row({ id: 3, title: 'Older still' })]),
      },
    });
    await h.emit(sync(A, [], [A]));
    await onHistory(h, 'Second');
    expect(h.el('history-count').textContent).toBe('2+ conversations');
    expect(h.el('history-more').hidden).toBe(false);

    await h.click('#history-more');
    await until('the second page', () => h.el('history-list').textContent!.includes('Older still'));

    // Appended, not replaced, and the last page offers no further one.
    expect([...h.doc.querySelectorAll('#history-list .hist-item')]).toHaveLength(3);
    expect(h.el('history-count').textContent).toBe('3 conversations');
    expect(h.el('history-more').hidden).toBe(true);
    expect(h.calls.some((c) => c.path === 'api/history?before=1762300000000.2')).toBe(true);
  });

  it('ignores Enter mid-composition, which is a candidate being chosen and not a search', async () => {
    const h = await open({ replies: { 'api/history': page([row()]) } });
    await h.emit(sync(A, [], [A]));
    await onHistory(h);
    const searches = (): number => h.calls.filter((c) => c.path.startsWith('api/history/search')).length;

    const input = h.el('history-q') as HTMLInputElement;
    input.value = '部署';
    const ev = new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    input.dispatchEvent(ev);
    await tick();

    // The Enter that closes an IME candidate list is the composition's, not the field's.
    expect(searches()).toBe(0);
    expect(ev.defaultPrevented).toBe(false);

    input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();
    expect(searches()).toBe(1);
  });

  it('counts "30+" when the daemon says the search carried fewer matches than the library has', async () => {
    const hits = Array.from({ length: 30 }, (_, i) => ({
      session: 1,
      message: i + 1,
      at,
      title: 'Deploy notes',
      agent: 'cc',
      platform: 'webui',
      role: 'user',
      excerpt: `deployment ${i}`,
    }));
    const h = await open({
      replies: { 'api/history': page([row()]), 'api/history/search?q=deployment': { enabled: true, hits, more: true } },
    });
    await h.emit(sync(A, [], [A]));
    await onHistory(h);

    await search(h, 'deployment');
    await until('the hits', () => h.doc.querySelectorAll('#history-list .hist-item').length === 30);
    // The number on screen is the size of the answer; the + says it is not the size of the result.
    expect(h.el('history-count').textContent).toBe('30+ matches');

    // A search the daemon did not call a floor keeps the plain number.
    const whole = await open({
      replies: { 'api/history': page([row()]), 'api/history/search?q=deployment': { enabled: true, hits } },
    });
    await whole.emit(sync(A, [], [A]));
    await onHistory(whole);
    await search(whole, 'deployment');
    await until('the hits', () => whole.doc.querySelectorAll('#history-list .hist-item').length === 30);
    expect(whole.el('history-count').textContent).toBe('30 matches');
  });

  it('keeps the page it already has when the next one cannot be read, and offers the button again', async () => {
    const next = 'api/history?before=1762300000000.2';
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, title: 'Second' })], '1762300000000.2'),
        [next]: page([row({ id: 3, title: 'Older still' })]),
      },
      status: { [next]: 500 },
    });
    await h.emit(sync(A, [], [A]));
    await onHistory(h, 'Second');

    await h.click('#history-more');
    await until('the error', () => !h.el('history-err').hidden);

    // The rows already read stay: a page that failed is not a reason to throw them away.
    expect(h.el('history-list').textContent).toContain('Deploy notes');
    expect(h.el('history-list').textContent).toContain('Second');
    expect(h.el('history-err').textContent).toMatch(/HTTP 500/);
    expect(h.el('history-more').hidden).toBe(false);
    expect((h.el('history-more') as HTMLButtonElement).disabled).toBe(false);

    // And it works when the daemon answers: the same button, the page appended, the error gone.
    h.status[next] = 200;
    await h.click('#history-more');
    await until('the second page', () => h.el('history-list').textContent!.includes('Older still'));
    expect(h.el('history-err').hidden).toBe(true);
    expect([...h.doc.querySelectorAll('#history-list .hist-item')]).toHaveLength(3);
  });

  it('puts a failed page under the list, beside the button that asked for it', async () => {
    const next = 'api/history?before=1762300000000.2';
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, title: 'Second' })], '1762300000000.2'),
        [next]: page([row({ id: 3, title: 'Older still' })]),
      },
      status: { [next]: 500 },
    });
    await h.emit(sync(A, [], [A]));
    await onHistory(h, 'Second');

    await h.click('#history-more');
    await until('the error', () => !h.el('history-err').hidden);

    // jsdom does no layout, so the DOM order is the evidence: the error follows the list and sits
    // immediately above the button. That is where a reader who tapped it at the bottom of fifty
    // rows is looking; above the list, the same line was 2550px out of view on a phone.
    const err = h.el('history-err');
    expect(err.parentElement).toBe(h.el('history-body'));
    expect(h.el('history-list').compareDocumentPosition(err) & h.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(err.nextElementSibling).toBe(h.el('history-more'));

    // Failing twice changes nothing: the same line, and the button offers the same page again.
    await h.click('#history-more');
    await until('the second failure', () => !h.el('history-err').hidden && !(h.el('history-more') as HTMLButtonElement).disabled);
    expect(err.textContent).toMatch(/HTTP 500/);
  });

  it('searches the library, and puts the list back when the field is cleared', async () => {
    const h = await open({
      replies: {
        'api/history': page([row()]),
        'api/history/search?q=deployment': {
          enabled: true,
          hits: [
            { session: 1, message: 4, at, title: 'Deploy notes', agent: 'cc', platform: 'webui', role: 'user', excerpt: 'the deployment finished' },
          ],
        },
      },
    });
    await h.emit(sync(A, [], [A]));
    await onHistory(h);

    await search(h, 'deployment');
    await until('the hit', () => h.el('history-list').textContent!.includes('the deployment finished'));

    expect(h.calls.some((c) => c.path === 'api/history/search?q=deployment')).toBe(true);
    expect(h.el('history-count').textContent).toBe('1 match');
    expect(h.doc.querySelector('#history-list .hist-excerpt')!.textContent).toBe('the deployment finished');

    // The field's own × leaves an empty value: the library comes back, not the last search.
    const input = h.el('history-q') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await tick();
    expect(h.doc.querySelector('#history-list .hist-excerpt')).toBeNull();
    expect(h.el('history-list').textContent).toContain('Deploy notes');
    expect(h.el('history-count').textContent).toBe('1 conversation');
  });

  it('opens a conversation where the transcript is, drawn with the transcript’s own bubbles', async () => {
    const h = await open({
      replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() },
    });
    // The topic underneath holds a tool bubble of its own, the same two lines.
    await h.emit(sync(B, [{ ...message('w1', TOOLS), kind: 'tools' }], [A, B]));
    await onHistory(h);
    await openRow(h);

    expect(h.calls.some((c) => c.path === 'api/history/read?id=1')).toBe(true);
    expect(libOn(h)).toBe(true);
    expect(h.el('lib-title').textContent).toBe('Deploy notes');
    expect(h.doc.querySelector('#history-list .hist-item')!.classList.contains('on')).toBe(true);
    const head = h.el('lib-log').querySelector('.lib-head')!;
    expect(head.textContent).toContain('cc · webui');
    expect(head.textContent).toContain('4 messages');
    expect(head.textContent).toContain(`webui#main#${A}`);

    const bubbles = [...h.el('lib-log').querySelectorAll('.m')];
    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]!.className).toBe('m own');
    expect(bubbles[0]!.querySelector('.b .raw')!.textContent).toBe('deploy it');
    expect(bubbles[2]!.querySelector('.b strong')!.textContent).toBe('v2');
    // The same bubble as the transcript draws, from the same markup: class, body and folding.
    const live = h.el('log').querySelector('[data-k="1:w1"]')!;
    const lib = h.el('lib-log').querySelector('[data-k="h:h2"]')!;
    expect(lib.className).toBe(live.className);
    expect(lib.querySelector('.b')!.innerHTML).toBe(live.querySelector('.b')!.innerHTML);
    expect(lib.querySelector('.tl-all')!.textContent).toBe('Show all');

    // A line opens and folds as it does in a topic, and only this bubble's.
    (lib.querySelector('.tl') as HTMLElement).click();
    expect(h.el('lib-log').querySelector('[data-k="h:h2"] .tl')!.classList.contains('open')).toBe(true);
    expect(h.el('log').querySelector('[data-k="1:w1"] .tl')!.classList.contains('open')).toBe(false);
    (h.el('lib-log').querySelector('[data-k="h:h2"] .tl-all') as HTMLElement).click();
    expect(h.el('lib-log').querySelector('[data-k="h:h2"] .tl-all')!.textContent).toBe('Collapse');

    // The topic underneath is still there, untouched, for the way back.
    expect(h.painted()).toBe(1);
    // And the stylesheet takes the composer, the header's topic controls and the terminal away while
    // it is up — as text, because jsdom's CSSOM is not to be trusted with this (see Testing).
    expect(renderPage('Chat', false)).toContain(
      '#chat.lib #log,#chat.lib #typing,#chat.lib #note,#chat.lib #bar,#chat.lib #term,\n' +
        '#chat.lib #topic-title,#chat.lib #topic-status,#chat.lib #kill-agent,#chat.lib #term-toggle{display:none}'
    );
  });

  it('says a read was cut short where the reader lands, and says nothing when it was not', async () => {
    const note = 'This conversation is longer than the 500 messages this page reads; only the first 500 are shown.';
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, title: 'Whole' })]),
        'api/history/read?id=1': read({ note }),
        'api/history/read?id=2': read({ session: row({ id: 2, title: 'Whole' }) }),
      },
    });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);

    // In the bar where the composer was, under the last message read — not above a transcript the
    // reader lands at the bottom of.
    expect(h.el('lib-note').hidden).toBe(false);
    expect(h.el('lib-note').textContent).toBe(note);
    expect(h.el('lib-note').parentElement).toBe(h.el('lib-bar'));

    (h.doc.querySelectorAll('#history-list .hist-item')[1] as HTMLElement).click();
    await until('the second conversation', () => h.el('lib-title').textContent === 'Whole');
    expect(h.el('lib-note').hidden).toBe(true);
    expect(h.doc.querySelectorAll('#history-list .hist-item.on')).toHaveLength(1);
  });

  it('says why nothing can be sent, and takes the reader into the topic while this page has it', async () => {
    const h = await open({ replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() } });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);

    expect(h.el('lib-why').textContent).toMatch(/^Read-only: .*still a topic on this page/);
    expect(h.el('lib-topic').hidden).toBe(false);

    await h.click('#lib-topic');
    await until('the switch', () => h.window.location.search.includes(A));
    expect(libOn(h)).toBe(false);
    // The sidebar follows: the row to come back to is in the Topics list.
    expect(h.el('sb-tab-topics').getAttribute('aria-selected')).toBe('true');
    expect(h.el('history-pane').hidden).toBe(true);
  });

  it('takes the way into a topic away when the topic is gone, and names the other platform', async () => {
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, key: 'telegram#chat#9', title: 'Phone chat', platform: 'telegram', topic: undefined })]),
        'api/history/read?id=1': read(),
        'api/history/read?id=2': read({ session: row({ id: 2, key: 'telegram#chat#9', title: 'Phone chat', platform: 'telegram', topic: undefined }) }),
      },
    });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);
    expect(h.el('lib-topic').hidden).toBe(false);

    // The topic is deleted while its record is on screen: the list changes, and the button goes.
    await h.emit({ t: 'topics', topics: topicList().filter((t) => t.id !== A) });
    expect(h.el('lib-topic').hidden).toBe(true);
    expect(h.el('lib-why').textContent).toMatch(/cleared from this page/);

    (h.doc.querySelectorAll('#history-list .hist-item')[1] as HTMLElement).click();
    await until('the other platform', () => h.el('lib-title').textContent === 'Phone chat');
    expect(h.el('lib-topic').hidden).toBe(true);
    expect(h.el('lib-why').textContent).toMatch(/ran on telegram/);
  });

  it('goes back to the conversation underneath from Close, from the Topics tab and from any topic', async () => {
    const h = await open({ replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() } });
    await h.emit(sync(B, [message('w1', '<p>underneath</p>')], [A, B]));
    await onHistory(h);

    await openRow(h);
    await h.click('#lib-close');
    expect(libOn(h)).toBe(false);
    expect(h.el('lib-log').innerHTML).toBe('');
    // Close leaves the list where it was; the row is no longer lit.
    expect(h.el('history-pane').hidden).toBe(false);
    expect(h.doc.querySelector('#history-list .hist-item.on')).toBeNull();

    await openRow(h);
    // A message that reaches the covered topic lands in it, for when it is shown again.
    await h.emit({ t: 'msg', topic: B, msg: message('w2', '<p>meanwhile</p>') });
    await h.click('#sb-tab-topics');
    expect(libOn(h)).toBe(false);
    expect(h.el('log').textContent).toContain('meanwhile');

    // Into a topic from the record itself, even the one that was underneath all along.
    await onHistory(h);
    await openRow(h);
    h.el('lib-topic').click();
    await tick();
    expect(libOn(h)).toBe(false);
    expect(h.window.location.search).toContain(A);
  });

  it('follows a link to a topic out of the conversation, including one to the topic underneath', async () => {
    const link = (id: string): Record<string, unknown> =>
      read({
        messages: [{ id: 'h1', own: false, html: `<p>see <a href="?t=${id}" data-goto="${id}">the plan</a></p>`, at, buttons: [], reactions: [], kind: 'dispatch' }],
      });
    const h = await open({ replies: { 'api/history': page([row(), row({ id: 2, title: 'Second' })]), 'api/history/read?id=1': link(A), 'api/history/read?id=2': link(A) } });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h, 'Second');

    await openRow(h);
    (h.el('lib-log').querySelector('a[data-goto]') as HTMLElement).click();
    await until('the switch', () => h.window.location.search.includes(A));
    expect(libOn(h)).toBe(false);

    // A link to the topic already underneath: nothing to switch to, but the view still has to go.
    await h.emit(sync(A, [message('w1', '<p>underneath</p>')], [A, B]));
    const streams = h.streams.length;
    (h.doc.querySelectorAll('#history-list .hist-item')[1] as HTMLElement).click();
    await until('the second conversation', () => libOn(h) && h.el('lib-log').querySelector('a[data-goto]') !== null);
    (h.el('lib-log').querySelector('a[data-goto]') as HTMLElement).click();
    await tick();
    expect(libOn(h)).toBe(false);
    expect(h.window.location.search).toBe(`?t=${A}`);
    expect(h.el('log').textContent).toContain('underneath');
    // Shown again, not entered again: the same stream, no new sync asked for.
    expect(h.streams.length).toBe(streams);
  });

  it('keeps the title in a phone’s header: the tag is its icon there', () => {
    const at640 = renderPage('Chat', false);
    const block = at640.slice(at640.indexOf('@media(max-width:640px){'));
    expect(block).toContain('.lib-tag-word{display:none}');
  });

  it('marks nothing seen and takes no paste for the topic it covers', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${B}`, replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() } });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);
    const seen = (): number => h.calls.filter((c) => c.path === 'api/seen').length;

    // The topic underneath finishes a reply nobody can see.
    await h.emit({ t: 'topics', topics: topicList({ [B]: { stage: 'review' } }) });
    expect(seen()).toBe(0);

    // A screenshot pasted now would go, unseen, into that topic's composer.
    const file = new h.window.File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
    const ev = new h.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
    h.doc.body.dispatchEvent(ev);
    await tick();
    expect(ev.defaultPrevented).toBe(false);
    // Nor a file dropped on the page.
    const drop = new h.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
    h.doc.body.dispatchEvent(drop);
    // A file is read over several turns before its chip is drawn; give it them.
    for (let i = 0; i < 20; i++) await tick();
    expect(h.el('chips').children).toHaveLength(0);

    // Uncovered, it is read — and only then.
    await h.click('#lib-close');
    expect(h.calls.filter((c) => c.path === 'api/seen').map((c) => c.body)).toEqual([{ topic: B }]);
  });

  it('on a phone: a picked conversation closes the drawer, and the drawer’s Topics tab brings the topic back', async () => {
    const h = await open({ width: 390, height: 844, replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() } });
    await h.emit(sync(B, [message('w1', '<p>underneath</p>')], [A, B]));
    await h.click('#expand-sidebar');
    await onHistory(h);
    // The tab is chosen inside the drawer; the drawer stays out until something is picked.
    expect(h.el('sidebar').classList.contains('collapsed')).toBe(false);

    await openRow(h);
    expect(libOn(h)).toBe(true);
    expect(h.el('sidebar').classList.contains('collapsed')).toBe(true);
    expect(h.el('app').classList.contains('sb-open')).toBe(false);

    // Back in, the drawer is where it was left: on History, with the row lit.
    await h.click('#expand-sidebar');
    expect(h.el('history-pane').hidden).toBe(false);
    expect(h.doc.querySelector('#history-list .hist-item.on')).not.toBeNull();
    await h.click('#sb-tab-topics');
    expect(libOn(h)).toBe(false);
    expect(h.el('topics').hidden).toBe(false);
    expect(h.el('log').textContent).toContain('underneath');
  });

  it('does not remember the tab or the conversation: a reload opens on Topics, on the topic in the address', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${B}`, replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() } });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);
    // The address still names the topic underneath: ?t= is what links and notifications open.
    expect(h.window.location.search).toBe(`?t=${B}`);
    const storage: Record<string, string> = {};
    for (let i = 0; i < h.window.localStorage.length; i++) {
      const k = h.window.localStorage.key(i)!;
      storage[k] = h.window.localStorage.getItem(k)!;
    }

    const again = await open({ url: `http://localhost:8787/?t=${B}`, storage });
    await again.emit(sync(B, [], [A, B]));
    expect(again.el('sb-tab-topics').getAttribute('aria-selected')).toBe('true');
    expect(again.el('history-pane').hidden).toBe(true);
    expect(again.el('chat').classList.contains('lib')).toBe(false);
  });

  it('says a conversation could not be read, and keeps the way out', async () => {
    const h = await open({
      replies: { 'api/history': page([row()]), 'api/history/read?id=1': { error: 'no conversation "1"; `fleetherd sessions list` shows the ids' } },
      status: { 'api/history/read?id=1': 404 },
    });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);

    expect(h.el('lib-log').querySelector('.hist-note.bad')!.textContent).toMatch(/no conversation "1"/);
    expect(h.el('lib-topic').hidden).toBe(true);
    await h.click('#lib-close');
    expect(libOn(h)).toBe(false);
  });

  it('creates a new topic into the Topics tab', async () => {
    const h = await open({ replies: { 'api/history': page([row()]) } });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await h.click('#new-topic');
    expect(h.el('sb-tab-topics').getAttribute('aria-selected')).toBe('true');
    expect(h.el('topics').hidden).toBe(false);
  });

  it('says when the daemon has no conversation library', async () => {
    const h = await open({ replies: { 'api/history': { enabled: false, sessions: [] } } });
    await h.emit(sync(A, [], [A]));
    await h.click('#sb-tab-history');
    await until('the disabled note', () => h.el('history-list').textContent!.includes('no conversation library'));

    expect(h.el('history-count').textContent).toBe('');
    expect(h.el('history-more').hidden).toBe(true);
  });
});
