import { describe, it, expect } from 'vitest';
import {
  tick,
  until,
  within,
  opens,
  sync,
  message,
  face,
  open,
  type Harness,
} from './page.dom.test-helpers.js';

describe('webui page: rendering', () => {
  it('renders the sync for a topic the client never named', async () => {
    // The 1.15.0 regression, and the reason this file exists. A first visit has no ?t=, so the
    // client's topic is '' and `stream()` answers for `topics.current()` — a sync carrying an id
    // the page never asked for. Dropping it left an empty shell behind a healthy event stream.
    const h = await open({ url: 'http://localhost:8787/' });
    await opens(h, 'api/events');

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
      expect(h.el('workbench-root').hidden).toBe(true);
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
    expect(h.el('workbench-root').hidden).toBe(false);
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
    await opens(h, 'api/events?t=a1b2c3d4');
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



});

describe('webui page: a tab in the background', () => {
  const setVisible = (h: Harness, visible: boolean): void => {
    Object.defineProperty(h.doc, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
    h.doc.dispatchEvent(new h.window.Event('visibilitychange'));
  };
  /** An event the way a browser delivers one that carried an `id:`. */
  const numbered = async (h: Harness, ev: Record<string, unknown>, id: string): Promise<void> => {
    await within('a stream to deliver to', 1000, () => h.streams.some((s) => !s.closed));
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
    await opens(h, 'api/events?t=a1b2c3d4&last=a1b2c3d4.run.7');
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

  it('reconnects when hidden longer than PARK_MS even if the OS froze the park timer', async () => {
    const h = await open();
    let now = 1_000_000;
    const origNow = h.window.Date.now;
    h.window.Date.now = () => now;
    try {
      await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4']));
      await numbered(h, { t: 'msg', msg: message('m2', '<p>two</p>') }, 'a1b2c3d4.run.7');
      const first = h.live();
      setVisible(h, false);
      // Timer never fired (frozen mobile tab), but wall clock moved past PARK_MS.
      now += 20_000;
      setVisible(h, true);
      expect(first.closed).toBe(true);
      expect(h.streams).toHaveLength(2);
      await opens(h, 'api/events?t=a1b2c3d4&last=a1b2c3d4.run.7');
    } finally {
      h.window.Date.now = origNow;
    }
  });

  it('cancels a pending reconnect backoff and reconnects at once on returning to the tab', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    setVisible(h, false);
    await h.emit({ t: 'bye' });
    // Still inside the 1s backoff window: returning should not wait out the timer.
    setVisible(h, true);
    expect(h.streams).toHaveLength(2);
  });

  it('reconnects on bfcache pageshow and on online recovery', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4']));
    await numbered(h, { t: 'msg', msg: message('m2', '<p>two</p>') }, 'a1b2c3d4.run.9');
    const first = h.live();
    const ps = new h.window.Event('pageshow');
    Object.defineProperty(ps, 'persisted', { value: true });
    h.window.dispatchEvent(ps);
    expect(first.closed).toBe(true);
    expect(h.streams).toHaveLength(2);
    await opens(h, 'api/events?t=a1b2c3d4&last=a1b2c3d4.run.9');

    const second = h.live();
    h.window.dispatchEvent(new h.window.Event('online'));
    expect(second.closed).toBe(true);
    expect(h.streams).toHaveLength(3);
    await opens(h, 'api/events?t=a1b2c3d4&last=a1b2c3d4.run.9');
  });

  it('treats ping events as stream activity and reconnects when a stream goes silent', async () => {
    const h = await open();
    let now = 2_000_000;
    const origNow = h.window.Date.now;
    h.window.Date.now = () => now;
    try {
      await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4']));
      const first = h.live();
      // Server ping at +60s keeps the stream fresh on a quick glance at +70s.
      now += 60_000;
      first.emitNamed('ping');
      now += 10_000;
      setVisible(h, false);
      setVisible(h, true);
      expect(first.closed).toBe(false);
      expect(h.streams).toHaveLength(1);

      // Without a ping for >65s, returning treats the stream as stale and reconnects.
      now += 70_000;
      setVisible(h, false);
      setVisible(h, true);
      expect(first.closed).toBe(true);
      expect(h.streams).toHaveLength(2);
    } finally {
      h.window.Date.now = origNow;
    }
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
    await opens(h, 'api/events?t=b2c3d4e5');
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
    await opens(h, 'api/events?t=a1b2c3d4&last=a1b2c3d4.run.3&tv=6');
  });
});

describe('webui page: topics', () => {

  /**
   * The gap this covers is the one a warm cache creates: the transcript is on screen instantly,
   * and then a second or two later everything said while you were elsewhere arrives in one frame.
   * Between those two moments the page has to be visibly waiting on something.
   */

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

    // At once, before the cache has been read: nothing of A's may reach B in the meantime.
    expect(first.closed).toBe(true);
    await opens(h, 'api/events?t=b2c3d4e5');
    expect(h.streams.filter((s) => !s.closed)).toHaveLength(1);
  });

  it('paints a revisited topic from cache at once and resumes its stream with ?last=', async () => {
    const h = await open();
    const emitId = async (ev: Record<string, unknown>, id: string): Promise<void> => {
      await within('a stream to deliver to', 1000, () => h.streams.some((s) => !s.closed));
      h.live().onmessage?.({ data: JSON.stringify(ev), lastEventId: id });
      await tick();
    };
    const syncA = sync('a1b2c3d4', [message('m1', '<p>cached A</p>')], ['a1b2c3d4', 'b2c3d4e5'], { tv: 7 });
    await emitId(syncA, 'a1b2c3d4.1.5');

    // Switch away to B (flushes A into cache immediately via cacheService.leave()).
    await h.click('[data-topic="b2c3d4e5"]');
    await opens(h, 'api/events?t=b2c3d4e5');
    await emitId(
      sync('b2c3d4e5', [message('m2', '<p>in B</p>')], ['a1b2c3d4', 'b2c3d4e5'], { tv: 7 }),
      'b2c3d4e5.1.2',
    );

    // Switch back to A: messages paint synchronously from cache BEFORE any sync/resumed arrives,
    // and the stream resumes with ?last= instead of requesting a full sync.
    await h.click('[data-topic="a1b2c3d4"]');
    expect(h.painted()).toBe(1);
    expect(h.el('log').textContent).toContain('cached A');
    expect(h.live().url).toContain('t=a1b2c3d4');
    expect(h.live().url).toContain('last=a1b2c3d4.1.5');
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



});
