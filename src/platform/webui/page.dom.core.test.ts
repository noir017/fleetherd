import { describe, it, expect } from 'vitest';
import {
  servePage,
  tick,
  saved,
  until,
  within,
  untilAsync,
  opens,
  sync,
  message,
  face,
  open,
  rowMenu,
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

  /** A stand-in for the loaded bundle: the reader only ever asks it for an editor. */
  function fakeCodeView(log: { calls: Array<{ doc: string; name: string; readOnly?: boolean }>; destroyed: number }) {
    return {
      editor(parent: HTMLElement, o: { doc: string; name: string; readOnly?: boolean }) {
        log.calls.push(o);
        const el = parent.ownerDocument.createElement('div');
        el.className = 'cm-editor';
        el.textContent = o.doc;
        parent.appendChild(el);
        let doc = o.doc;
        return {
          getDoc: () => doc,
          setDoc: (next: string) => {
            doc = next;
            el.textContent = next;
          },
          focus: () => {},
          destroy: () => {
            log.destroyed++;
            el.remove();
          },
        };
      },
      diff() {
        throw new Error('the reader never asks for a diff');
      },
    };
  }

  it('shows a text file in the code view when the page has one, instead of the server pre', async () => {
    const log = { calls: [] as Array<{ doc: string; name: string; readOnly?: boolean }>, destroyed: 0 };
    const h = await open({
      codeView: fakeCodeView(log),
      replies: {
        'view/aa': { ...reading('<pre class="src"><code>package main</code></pre>', 3 * 1048576, 524288), name: 'main.go', text: 'package main\n' },
      },
    });
    await h.emit(sync(T, [readable('m1', 'main.go', 'aa')], [T]));
    await h.click('#log a[data-view]');
    await until('the code view', () => h.el('reader-body').querySelector('.cm-editor') !== null);

    expect(log.calls[0]).toEqual({ doc: 'package main\n', name: 'main.go', readOnly: true });
    // One view of the file, not two: the server's escaped copy is not also on screen.
    expect(h.el('reader-body').querySelector('.src')).toBeNull();
    // The cut notice still stands above it, and the body has handed its scrolling to the editor.
    expect(h.el('reader-body').querySelector('.reader-note')?.textContent).toBe(
      'Showing the first 512 KB of 3.0 MB. Download it for the rest.'
    );
    expect(h.el('reader-body').classList.contains('cv')).toBe(true);

    // Closing drops the view rather than leaving CodeMirror's listeners on a detached node.
    await h.click('#reader-close');
    expect(log.destroyed).toBe(1);
    expect(h.el('reader-body').classList.contains('cv')).toBe(false);
  });

  it('keeps the server pre for a text file when there is no code view, which is a build with no bundle', async () => {
    const h = await open({
      replies: { 'view/aa': { ...reading('<pre class="src"><code>one\ntwo</code></pre>'), text: 'one\ntwo' } },
    });
    await h.emit(sync(T, [readable('m1', 'run.log', 'aa')], [T]));
    await h.click('#log a[data-view]');
    await until('the plain text', () => h.el('reader-body').querySelector('.src') !== null);
    expect(h.el('reader-body').textContent).toBe('one\ntwo');
    expect(h.el('reader-body').classList.contains('cv')).toBe(false);
  });

  it('falls back to the pre when the bundle will not load, and warns about it exactly once', async () => {
    // The case that only happens in production: the page names a hash a rebuild has since deleted,
    // so the import 404s. jsdom refuses a dynamic import outright, which is the same rejection.
    const h = await open({
      codeviewUrl: 'assets/codeview-gone.js',
      replies: {
        'view/aa': { ...reading('<pre class="src"><code>one</code></pre>'), text: 'one' },
        'view/bb': { ...reading('<pre class="src"><code>two</code></pre>'), text: 'two' },
      },
    });
    const warns = () => h.warnings.filter((w) => w.includes('code view unavailable'));
    await h.emit(sync(T, [readable('m1', 'one.log', 'aa'), readable('m2', 'two.log', 'bb')], [T]));
    await h.click('#log a[data-view]');
    await until('the plain text', () => h.el('reader-body').querySelector('.src') !== null);
    expect(h.el('reader-body').classList.contains('cv')).toBe(false);
    expect(warns()).toHaveLength(1);

    // A second file finds the same failed promise: the reader degrades again, the log stays quiet.
    const links = Array.from(h.doc.querySelectorAll('#log a[data-view]')) as HTMLAnchorElement[];
    links[1]?.click();
    await until('the second file', () => (h.el('reader-body').textContent ?? '').includes('two'));
    expect(h.el('reader-body').classList.contains('cv')).toBe(false);
    expect(warns()).toHaveLength(1);
  });

  it('destroys the open editor when another file takes its place', async () => {
    const log = { calls: [] as Array<{ doc: string; name: string; readOnly?: boolean }>, destroyed: 0 };
    const h = await open({
      codeView: fakeCodeView(log),
      replies: {
        'view/aa': { ...reading('<pre class="src"><code>one</code></pre>', 3, 3), name: 'one.ts', text: 'one' },
        'view/bb': { ...reading('<pre class="src"><code>two</code></pre>', 3, 3), name: 'two.ts', text: 'two' },
      },
    });
    await h.emit(sync(T, [readable('m1', 'one.ts', 'aa'), readable('m2', 'two.ts', 'bb')], [T]));

    await h.click('#log a[data-view]');
    await until('the first editor', () => (h.el('reader-body').textContent ?? '') === 'one');
    const links = Array.from(h.doc.querySelectorAll('#log a[data-view]')) as HTMLAnchorElement[];
    links[1]?.click();
    await until('the second editor', () => (h.el('reader-body').textContent ?? '') === 'two');

    // One handle, one replacement: the first view is gone rather than left listening on a node
    // that has been detached from the document.
    expect(log.calls.map((c) => c.doc)).toEqual(['one', 'two']);
    expect(log.destroyed).toBe(1);
    expect(h.el('reader-body').querySelectorAll('.cm-editor')).toHaveLength(1);
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
  it('paints a switched-to topic from cache before its stream has answered', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>in A</p>'), message('m2', '<p>also A</p>')], ['a1b2c3d4', 'b2c3d4e5']));
    expect(h.painted()).toBe(2);

    await h.click('[data-topic="b2c3d4e5"]');
    // Nothing cached for B yet and its stream has said nothing — so what is on screen is the
    // shape of a transcript rather than either an empty panel or a message.
    expect(h.painted()).toBe(0);
    expect(h.skeletons()).toBeGreaterThan(0);
    await opens(h, 'api/events?t=b2c3d4e5');

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

    // At once, before the cache has been read: nothing of A's may reach B in the meantime.
    expect(first.closed).toBe(true);
    await opens(h, 'api/events?t=b2c3d4e5');
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

  it('names the agent on the row frame, in its harness colour, and leaves the title line to the subject', async () => {
    // "[gemini-task] " in front of every title took the one ellipsised line a 240px column has, and
    // left a subject of a few characters. The stored name keeps its tag (the chat platforms' topic
    // names need it); the row draws the agent as a legend on its frame instead.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: '[cc] parse the config', lastAt: 1000, msgCount: 0, agent: { id: 'cc', harness: 'claude' } },
        { id: 'b2c3d4e5', title: '[gemini-task] 工具访问权限限制排查', lastAt: 999, msgCount: 0, agent: { id: 'gemini-task', harness: 'custom' } },
        { id: 'c3d4e5f6', title: '[ag] 调研', lastAt: 998, msgCount: 0, agent: { id: 'ag', harness: 'agy' } },
      ],
    });

    const rows = Array.from(h.doc.querySelectorAll('#topics .topic-item'));
    expect(rows.map((r) => r.querySelector('.topic-title')?.textContent)).toEqual(['parse the config', '工具访问权限限制排查', '调研']);
    const tags = rows.map((r) => r.querySelector('.agent-tag'));
    expect(tags.map((t) => t?.textContent)).toEqual(['cc', 'gemini-task', 'ag']);
    // The class is the configured harness, which the stylesheet's palette keys on; a custom harness
    // gets its class too and simply has no colour there, so it stays grey.
    expect(tags.map((t) => t?.className)).toEqual(['agent-tag h-claude', 'agent-tag h-custom', 'agent-tag h-agy']);
    expect(tags.map((t) => t?.getAttribute('title'))).toEqual(['Agent: cc', 'Agent: gemini-task', 'Agent: ag']);
    // Outside the title, so it takes none of the line it used to.
    expect(rows[0]!.querySelector('.topic-title .agent-tag')).toBeNull();
    expect(rows.every((r) => r.classList.contains('framed'))).toBe(true);
  });

  it('labels the agent the daemon says is bound, not the one the title was named under', async () => {
    // The tag is written when the topic is named and a later /agent does not rewrite it, so a topic
    // named under cc and handed to cx would go on saying cc.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.emit({
      t: 'topics',
      topics: [{ id: 'a1b2c3d4', title: '[cc] 修 history 搜索', lastAt: 1000, msgCount: 0, agent: { id: 'cx', harness: 'codex' } }],
    });

    const tag = h.doc.querySelector('#topics .agent-tag');
    expect(tag?.textContent).toBe('cx');
    expect(tag?.className).toBe('agent-tag h-codex');
    expect(h.doc.querySelector('#topics .topic-title')?.textContent).toBe('修 history 搜索');
  });

  it('falls back to the title tag, uncoloured, when the daemon names no agent, and draws none when nothing does', async () => {
    // A topic whose agent left config, or a page served by a daemon without the lookup: the tag the
    // topic was named under is still the best answer, but it carries no harness.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: '[ag] 开工', lastAt: 1000, msgCount: 0 },
        { id: 'b2c3d4e5', title: '', lastAt: 999, msgCount: 0 },
        { id: 'c3d4e5f6', title: 'seeded from the first message', lastAt: 998, msgCount: 0 },
      ],
    });

    const rows = Array.from(h.doc.querySelectorAll('#topics .topic-item'));
    const byId = (id: string): Element => rows.find((r) => r.getAttribute('data-topic') === id)!;
    const tag = byId('a1b2c3d4').querySelector('.agent-tag');
    expect(tag?.textContent).toBe('ag');
    expect(tag?.className).toBe('agent-tag');
    expect(tag?.getAttribute('title')).toBe('Agent: ag');
    expect(byId('a1b2c3d4').querySelector('.topic-title')?.textContent).toBe('开工');
    // No agent named anywhere: no legend, and the row keeps its frame like every other.
    expect(byId('b2c3d4e5').querySelector('.agent-tag')).toBeNull();
    expect(byId('b2c3d4e5').querySelector('.topic-title')?.textContent).toBe('Untitled');
    expect(byId('c3d4e5f6').querySelector('.agent-tag')).toBeNull();
    expect(byId('c3d4e5f6').classList.contains('framed')).toBe(true);
  });

  it('shortens a host-qualified agent id once the row already names the machine, keeping it whole on the tooltip', async () => {
    // A remote agent's id is `<id>@<host>`. Left whole it is 15 characters spent on a machine the
    // directory line repeats (reported 2026-11-03, against the title's tag). The part before the
    // `@` is what the operator types to bind the agent.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.emit({
      t: 'topics',
      topics: [
        {
          id: 'a1b2c3d4',
          title: '[cbc@uniagent] Deploy A…',
          lastAt: 1000,
          msgCount: 0,
          agent: { id: 'cbc@uniagent', harness: 'custom' },
          dir: { name: 'workspace', path: '/home/user/workspace', host: 'uniagent' },
        },
        // No directory known, so the second line cannot say which machine this is: the label keeps
        // its host, because it is the only place on the row that names it. From the title's tag
        // alone, the rule is the same.
        { id: 'b2c3d4e5', title: '[ag@devbox] 你好', lastAt: 999, msgCount: 0 },
        // A group standing in for the host names a different machine: left whole.
        {
          id: 'c3d4e5f6',
          title: '[oc@aws] 你好',
          lastAt: 998,
          msgCount: 0,
          agent: { id: 'oc@aws', harness: 'opencode' },
          dir: { name: 'workspace', path: '/home/user/workspace', host: 'sydney' },
        },
      ],
    });

    const tags = Array.from(h.doc.querySelectorAll('#topics .agent-tag'));
    expect(tags.map((t) => t.textContent)).toEqual(['cbc', 'ag@devbox', 'oc@aws']);
    expect(tags.map((t) => t.getAttribute('title'))).toEqual(['Agent: cbc@uniagent', 'Agent: ag@devbox', 'Agent: oc@aws']);
    expect(Array.from(h.doc.querySelectorAll('#topics .topic-title')).map((t) => t.textContent)).toEqual(['Deploy A…', '你好', '你好']);
  });

  it('leaves the needs-you tooltip to the row, the agent id to its legend', async () => {
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
          agent: { id: 'cbc@uniagent', harness: 'custom' },
          dir: { name: 'workspace', path: '/home/user/workspace', host: 'uniagent' },
        },
      ],
    });

    const row = h.doc.querySelector('.topic-item.needs');
    expect(row?.getAttribute('title')).toBe('Waiting on your answer: Ship 2.23.0?');
    expect(row?.querySelector('.topic-title')?.hasAttribute('title')).toBe(false);
    // The legend's tooltip covers the legend alone: hovering the rest of the row still says what it needs.
    expect(row?.querySelector('.agent-tag')?.getAttribute('title')).toBe('Agent: cbc@uniagent');
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
    await opens(h, 'api/events?t=deadbeef');
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
      'topic-item on running live framed',
      'topic-item running live framed',
      'topic-item idle live framed',
      'topic-item idle framed',
    ]);
    // And the header says the useful half of "running AND waiting on you".
    expect(h.el('topic-status').textContent).toBe('awaiting you');
    expect(h.el('topic-status').className).toBe('chat-status asking');
  });
});
