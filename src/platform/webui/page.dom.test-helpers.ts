/**
 * The client script, exercised in a real DOM.
 *
 * `page.test.ts` is the cheap half of testing this file: it greps the served HTML and proves the
 * script parses. That catches a stray brace and a character the template literal ate, and it
 * catches nothing else — which is how 1.15.0 shipped a page that rendered nothing at all while
 * its event stream was perfectly healthy. Every gate in this repo was green for that bug, because
 * to all of them `page.ts` is one long string.
 *
 * So this file loads what the daemon actually serves — the page, with the script and stylesheet
 * it links put back inline (page.test-helpers.ts) — into jsdom, stubs the two things a browser
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
import { onTestFinished } from 'vitest';
import { JSDOM, type DOMWindow } from 'jsdom';
export { JSDOM, type DOMWindow };
import { IDBFactory } from 'fake-indexeddb';
export { IDBFactory };

// The page with its script and stylesheet inline, built the way the asset build builds them
// (page.test-helpers.ts says why and how): jsdom runs what the build ships.
import { renderPage, servePage } from './page.test-helpers.js';
import { createReaderPlugin } from './client/features/reader/plugin.js';
export { renderPage, servePage };
export { renderWebMarkdown, renderWebToolLines } from '../web-markdown.js';
export { webMessageHtml } from './room.js';

/** One `fetch` the page made, in the shape the assertions care about. */
export interface Call {
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
  headers?: Record<string, string>;
}

/** A framed send (page.ts `framed`) read back as the server does, into the JSON request's shape. */
export function unframe(view: ArrayBufferView): Record<string, unknown> {
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
export interface Stream {
  url: string;
  readyState: number;
  closed: boolean;
  /** lastEventId as a browser hands it over: the id of the newest event that carried one. */
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  /** Dispatch a named SSE event (such as the server's `ping` heartbeat) to listeners. */
  emitNamed(type: string, e?: { data?: string }): void;
}

/** What the page can see of a fake MediaRecorder: enough to feed it audio and read what it chose. */
export interface FakeRecorder {
  mimeType: string;
  state: 'inactive' | 'recording';
  /** Tracks of the stream it records, so a test can see the microphone was let go. */
  tracksStopped: () => boolean;
  /** Hand it a chunk, as the browser does while recording. */
  feed: (bytes: string) => void;
}

/** What a page did with the picture APIs a real browser has and jsdom does not. */
export interface PhotoLog {
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

export interface Harness {
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
  /** Everything the page wrote to `console.warn` — its one report of a bundle that would not load. */
  warnings: string[];
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
  /** Simulate an OS prefers-color-scheme change in tests that pass `colorScheme`. */
  setColorScheme: (scheme: 'dark' | 'light') => void;
  /** The "still waiting on the daemon" line under a transcript painted from cache. */
  waiting: () => string | null;
  /** Topic rows currently painted in the sidebar. */
  rows: () => number;
  /** The "why is this room empty" notice, when one is on screen. */
  notice: () => string | null;
  click: (selector: string) => Promise<void>;
}

/** What a page did with a fake push-capable browser (see installPush). */
export interface PushLog {
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

export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Long enough for the page's write debounce (SAVE_MS) to have fired and the write to land. */
export const saved = (): Promise<void> => new Promise((r) => setTimeout(r, 550));

/**
 * Spin the macrotask queue until something becomes true.
 *
 * `FileReader` resolves over several turns in jsdom, and how many is an implementation detail —
 * a fixed number of `tick()`s here would be a test that passes until jsdom changes its mind. The
 * cache read on the way into a topic is the same shape of wait, one IndexedDB turn instead.
 */
export async function until(what: string, ok: () => boolean): Promise<void> {
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
export async function within(what: string, ms: number, ok: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never happened within ${ms} ms: ${what}`);
}

/** `within`, for a condition that is itself a database read — one the prefetch's debounce comes before. */
export async function withinAsync(what: string, ms: number, ok: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never happened within ${ms} ms: ${what}`);
}

/** The same wait, for a condition that is itself a database read. */
export async function untilAsync(what: string, ok: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await ok()) return;
    await tick();
  }
  throw new Error(`never happened: ${what}`);
}

/**
 * Wait for the stream to open at url. A topic whose copy is not in memory may be entered only once
 * its record has been read (page.ts enter), since that read decides whether the stream resumes or
 * asks for a sync — so the stream can open an IndexedDB turn after the click.
 */
export async function opens(h: Harness, url: string): Promise<void> {
  await within(`the stream opens at ${url}`, 1000, () => {
    try {
      return h.live().url === url;
    } catch {
      return false;
    }
  });
}

/**
 * The names on the composer's attachment chips, in order. Read off `.chip-name` rather than the
 * chips' text, because a chip also carries its × — and a thumbnail's alt, which is not text.
 */
export function chipNames(h: { el: (id: string) => HTMLElement }): string[] {
  return Array.from(h.el('chips').querySelectorAll('.chip-name')).map((n) => n.textContent ?? '');
}

/** A sync in the shape `WebRoom.syncEvent` builds it. `extra` carries the optional flags. */
export function sync(
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

export function message(id: string, html: string, own = false): Record<string, unknown> {
  return { id, html, at: 1758240000000, own };
}

/**
 * What an element shows, with each icon (icons.ts, `ic-<name>`) read as `[name]` — an SVG has no
 * text, so textContent alone would say a starred topic and an unstarred one look the same.
 */
export function face(el: Element | null | undefined): string {
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

/**
 * The page a test loads. `codeview` is the built bundle's name, or absent for a daemon with no
 * assets at all — the two states `codeView()` distinguishes before it ever imports anything.
 */
export function pageOf(
  terminal: boolean,
  password: boolean,
  terminalEnd: boolean,
  codeview?: string,
  files = false,
  instructions = false,
  styles = false
): string {
  // Without styles the <style> is left empty: that skips jsdom's slow CSSOM parser (~43% of per-test
  // cost); pass styles: true for CSS tests.
  return servePage('Chat', terminal, password, terminalEnd, codeview ?? null, files, instructions, { as: 'built', styles }).html;
}

/**
 * Every window a test opened, closed when that test ends. A jsdom window running the page keeps its
 * timers, its fake EventSource and the whole page script alive until it is closed, and this file
 * opens hundreds of them: left open, one vitest worker's heap passed 2 GB and the worker died in
 * the full suite (2026-11-18, once the git and file windows had grown the page).
 */
async function closeWindowAfterTest(w: { close(): void }): Promise<void> {
  // A test can end with the page still finishing something it started — a transcript read from the
  // fake IndexedDB, a paint after it. Closed under it, that continuation finds no document and
  // throws after the test has passed; a few turns of the loop let it land in a live window first.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  try {
    w.close();
  } catch {
    // Already closed by the test itself.
  }
}

export async function open(
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
    /** Whether the daemon has the file window (platforms.<id>.files.enabled). */
    files?: boolean;
    /** Whether the settings page offers the instruction editor (platforms.<id>.instructions.enabled). */
    instructions?: boolean;
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
    /**
     * What to put on `window.__fhCodeView` before the script runs — the seam `codeView()` checks
     * before it imports the real bundle. Absent means the page has no bundle, which is the
     * degradation the reader must survive; jsdom cannot evaluate a real dynamic `import`, so this
     * fake is also the only way the highlighted path can be driven here at all.
     */
    codeView?: { editor: (...args: any[]) => any; diff: (...args: any[]) => any };
    /**
     * The bundle the served page names (`renderPage`'s fifth argument). Absent means a page with no
     * built assets at all. A name that does not exist is how the load-failure path is driven:
     * jsdom rejects a dynamic import, exactly as a browser does for a hash a rebuild deleted.
     */
    codeviewUrl?: string;
    /** Keep the served <style> block for tests that inspect computed styles. Off by default. */
    styles?: boolean;
    /** Stub window.matchMedia('(prefers-color-scheme: dark)') with the given initial scheme. */
    colorScheme?: 'dark' | 'light';
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
    files = false,
    instructions = false,
    password = true,
    mic,
    hang = [],
    badJson = [],
    held = {},
    shortenLong = false,
    push,
    photos,
    codeView,
    codeviewUrl,
    styles = false,
    colorScheme,
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
  const warnings: string[] = [];
  const confirms: string[] = [];
  const longTimers: number[] = [];
  let currentScheme: 'dark' | 'light' = colorScheme ?? 'dark';
  const schemeListeners = new Set<(e: { matches: boolean; media: string }) => void>();

  const dom = new JSDOM(pageOf(terminal, password, terminalEnd, codeviewUrl, files, instructions, styles), {
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
      if (colorScheme !== undefined) {
        (w as any).matchMedia = (query: string) => ({
          media: query,
          get matches() {
            return query === '(prefers-color-scheme: dark)' ? currentScheme === 'dark' : currentScheme === 'light';
          },
          addEventListener: (_type: string, fn: (e: { matches: boolean; media: string }) => void) => {
            schemeListeners.add(fn);
          },
          removeEventListener: (_type: string, fn: (e: { matches: boolean; media: string }) => void) => {
            schemeListeners.delete(fn);
          },
        });
      }
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
        private listeners = new Map<string, Set<(e: { data?: string }) => void>>();
        constructor(readonly url: string) {
          streams.push(this);
          // The script assigns onopen after constructing, so this cannot be synchronous.
          setTimeout(() => this.onopen?.(), 0);
        }
        addEventListener(type: string, fn: (e: { data?: string }) => void): void {
          let set = this.listeners.get(type);
          if (!set) {
            set = new Set();
            this.listeners.set(type, set);
          }
          set.add(fn);
        }
        emitNamed(type: string, e: { data?: string } = { data: '' }): void {
          for (const fn of this.listeners.get(type) ?? []) fn(e);
        }
        close(): void {
          this.readyState = 2;
          this.closed = true;
        }
      }
      (w as any).EventSource = FakeEventSource;
      if (typeof (w as any).ResizeObserver !== 'function') {
        class FakeResizeObserver {
          observe(): void {
            // jsdom has no layout engine; tests drive resize via window events or shell.layout().
          }
          unobserve(): void {
            // noop
          }
          disconnect(): void {
            // noop
          }
        }
        (w as any).ResizeObserver = FakeResizeObserver;
      }
      (w as any).confirm = (s: string) => {
        confirms.push(String(s));
        return confirm;
      };
      // jsdom has no alert, and the page uses one to report a refused "end session". Recorded
      // rather than ignored: "the button failed and said nothing" is the bug worth catching.
      (w as any).alert = (s: string) => {
        alerts.push(String(s));
      };
      // jsdom's console is its own realm's, and nothing here would otherwise see the page's
      // single warning about a code view that would not load.
      (w as any).console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
      if (mic) installMic(w, mic, recorders);
      if (push) installPush(w, push, pushLog);
      if (photos) installPhotos(w, photos, photoLog);
      if (codeView) (w as any).__fhCodeView = codeView;
      (w as any).__fhWorkbenchExtras ??= { createReaderPlugin };
      if (shortenLong) {
        const real = w.setTimeout.bind(w) as (fn: () => void, ms: number) => number;
        (w as any).setTimeout = (fn: () => void, ms: number): number => {
          if (ms < 10_000) return real(fn, ms);
          longTimers.push(ms);
          return real(fn, 30);
        };
      }
      (w as any).fetch = (path: string, init: { body?: unknown; signal?: AbortSignal; method?: string; headers?: Record<string, string> } = {}) => {
        // A GET (the file reader's) carries no body; recorded as an empty one.
        const bytes = ArrayBuffer.isView(init.body);
        const entry: (typeof calls)[number] = {
          path,
          body: init.body === undefined ? {} : bytes ? unframe(init.body as ArrayBufferView) : JSON.parse(String(init.body)),
          ...(init.method && init.method !== 'POST' ? { method: init.method } : {}),
          ...(bytes ? { binary: true } : {}),
        };
        if (init.headers) Object.defineProperty(entry, 'headers', { value: init.headers, enumerable: false });
        calls.push(entry);
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
  onTestFinished(() => closeWindowAfterTest(dom.window));

  await tick();
  await within('initial stream', 1000, () => streams.length > 0);
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
    warnings,
    confirms,
    recorders,
    longTimers,
    push: pushLog,
    photos: photoLog,
    cached: (topic) => readCache(idb, topic),
    emit: async (ev) => {
      // A switch to a topic whose copy is not in memory may open its stream only once the database
      // has been read (enter), and the stream of the topic left is closed at once — so an event
      // emitted straight after a click waits for the stream it is meant for.
      await within('a stream to deliver to', 1000, () => streams.some((s) => !s.closed));
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
    setColorScheme: (scheme) => {
      currentScheme = scheme;
      for (const fn of schemeListeners) fn({ matches: scheme === 'dark', media: '(prefers-color-scheme: dark)' });
    },
    waiting: () => doc.querySelector('#log > .syncing')?.textContent ?? null,
    rows: () => doc.querySelectorAll('#topics [data-topic]').length,
    notice: () => doc.querySelector('#log > .empty')?.textContent ?? null,
    click: async (selector) => {
      const target = doc.querySelector<HTMLElement>(selector);
      if (!target) throw new Error(`nothing matches ${selector}`);
      target.click();
      await tick();
    },
  };
}

/** One topic's record as it sits in the database — the messages and what the copy is of. */
export interface CacheRecord {
  list: Array<Record<string, unknown>>;
  epoch?: number;
  last?: string;
}

/**
 * Read one topic's cached record straight out of the database.
 *
 * Deliberately not through the page: what is asserted is what a RELOAD would find, so it is read
 * the way the next page would read it rather than the way this one remembers writing it.
 */
export function readRecord(idb: IDBFactory | null, topic: string): Promise<CacheRecord | null> {
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
        const rec = get.result as { json?: string; epoch?: number; last?: string } | undefined;
        db.close();
        if (!rec?.json) return resolve(null);
        const { json, ...meta } = rec;
        resolve({ list: JSON.parse(json) as Array<Record<string, unknown>>, ...meta });
      };
    };
  });
}

/** Just the messages of readRecord. */
export async function readCache(idb: IDBFactory | null, topic: string): Promise<Array<Record<string, unknown>> | null> {
  return (await readRecord(idb, topic))?.list ?? null;
}

/**
 * Open a topic row's ⋯ menu, as a person would. The menu is one box shared by every row, so the
 * selector that follows is the item inside it, not one per row.
 */
export async function rowMenu(h: Harness, id: string): Promise<HTMLElement> {
  await h.click(`[data-rm="topic:${id}"]`);
  return h.el('row-menu');
}


/** Every row in a transcript is this tall, and the viewport onto it this tall; see `layout`. */
export const ROW = 100;
export const VIEW = 300;

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
export function layout(h: Harness): HTMLElement {
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
export function lines(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => message(`m${i + 1}`, `<p>line ${i + 1}</p>`));
}

/** The body of the message at the top edge of the viewport, and how much of it is scrolled off. */
export function onTop(log: HTMLElement): { text: string | null | undefined; hidden: number } {
  const row = log.children[Math.floor(log.scrollTop / ROW)];
  return { text: row?.querySelector('.b')?.textContent, hidden: log.scrollTop % ROW };
}

/** An event as a browser delivers one that carried an `id:` — a sync is numbered too. */
export async function delivered(h: Harness, ev: Record<string, unknown>, id: string): Promise<void> {
  await within('a stream to deliver to', 1000, () => h.streams.some((s) => !s.closed));
  h.live().onmessage?.({ data: JSON.stringify(ev), lastEventId: id });
  await tick();
}

/** What the last message in the transcript says. */
export function lastSaid(h: Harness): string {
  const all = h.doc.querySelectorAll('#log > .m');
  return all[all.length - 1]?.textContent ?? '';
}

/** Overwrite one topic's cached transcript, the way an older page would have written it. */
export function writeCache(idb: IDBFactory | null, topic: string, list: Array<Record<string, unknown>>): Promise<void> {
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

/** A fake `window.__fhCodeView`, recording what the page asked it to draw. */
export interface FakeDiff {
  parent: HTMLElement;
  options: {
    name: string;
    original: string;
    modified: string;
    layout: string;
    onSelect?: (sel: { side: 'old' | 'new'; from: number; to: number; text: string } | null) => void;
  };
  layouts: string[];
  destroyed: number;
}

export function installCodeView(h: Harness): FakeDiff[] {
  const diffs: FakeDiff[] = [];
  (h.window as any).__fhCodeView = {
    diff(parent: HTMLElement, options: FakeDiff['options']) {
      const rec: FakeDiff = { parent, options, layouts: [], destroyed: 0 };
      diffs.push(rec);
      return {
        setLayout(layout: string) {
          rec.layouts.push(layout);
        },
        destroy() {
          rec.destroyed++;
        },
      };
    },
  };
  return diffs;
}
