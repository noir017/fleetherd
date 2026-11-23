import { describe, it, expect, vi } from 'vitest';
import {
  IDBFactory,
  tick,
  saved,
  until,
  within,
  chipNames,
  sync,
  message,
  face,
  open,
  readRecord,
  rowMenu,
  writeCache,
  type Harness,
} from './page.dom.test-helpers.js';

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

  it('keeps a whole topic, and where its stream had got to', async () => {
    // Through 3.9.0 the last 200 messages, which could only be painted. The longest topic on the
    // live gateway was 356 messages (2026-11-17): whole, a record can be resumed from.
    const T = 'a1b2c3d4';
    const many = Array.from({ length: 400 }, (_, i) => message(`m${i}`, `<p>line ${i}</p>`));
    const h = await open({ url: `http://localhost:8787/?t=${T}` });

    h.live().onmessage?.({ data: JSON.stringify(sync(T, many, [T])), lastEventId: `${T}.run.400` });
    await saved();

    const rec = await readRecord(h.idb, T);
    expect(rec?.list).toHaveLength(400);
    expect(rec).toMatchObject({ epoch: 1, last: `${T}.run.400` });
  });

  it('keeps only the tail of a topic too large for its budget, and nothing to resume it from', async () => {
    // 210 answers of 12K characters are over the 2M budget, so the record is cut to the last 157 —
    // painted on the way in, but a resume would replay onto a transcript with a hole at the top.
    const T = 'a1b2c3d4';
    const pad = `<!--${'x'.repeat(12_000)}-->`;
    const many = Array.from({ length: 210 }, (_, i) => message(`m${i}`, `<p>line ${i}</p>${pad}`));
    const h = await open({ url: `http://localhost:8787/?t=${T}` });

    h.live().onmessage?.({ data: JSON.stringify(sync(T, many, [T])), lastEventId: `${T}.run.210` });
    await saved();

    const rec = await readRecord(h.idb, T);
    expect(rec?.list).toHaveLength(157);
    expect(rec?.list[0]?.id).toBe('m53');
    expect(rec?.list[156]?.id).toBe('m209');
    expect(rec?.epoch).toBe(1);
    expect(rec?.last).toBeUndefined();
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

describe('webui page: pending mid-turn queue and card send-now', () => {
  it('optimistically renders mid-turn sends directly into #pending-queue without flashing a transcript bubble, and replaces on pending event', async () => {
    const T = 'a1b2c3d4';
    const h = await open({
      replies: {
        'api/pending/recall': { ok: true, recalled: 1, content: 'wait a sec' },
        'api/pending/send-now': { ok: true, sent: 1 },
      },
    });
    await h.emit(sync(T, [], [T]));
    await h.emit({ t: 'typing', on: true });

    // No #send-now button in the bottom composer bar.
    expect(h.doc.querySelector('#send-now')).toBeNull();

    // Sending while running goes straight into #pending-queue as a local card, not into #log.
    (h.el('input') as HTMLTextAreaElement).value = 'wait a sec';
    await h.click('#composer button[type="submit"]');
    const sentBody = h.calls.find((c) => c.path === 'api/send')?.body as { topic: string; text: string; nonce: string };
    expect(sentBody).toMatchObject({ topic: T, text: 'wait a sec' });
    expect(h.doc.querySelectorAll('#log .m')).toHaveLength(0);
    const tray = h.el('pending-queue');
    expect(tray.hidden).toBe(false);
    expect(tray.parentElement?.id).toBe('bar');
    expect(tray.querySelectorAll('.pq-item.pq-local')).toHaveLength(1);
    expect(tray.textContent).toContain('wait a sec');

    // Pending event with matching nonce seamlessly replaces the local card with the server card.
    await h.emit({
      t: 'pending',
      items: [
        { id: 'm99', content: 'wait a sec', at: Date.now(), nonce: sentBody.nonce, canSendNow: true, reason: 'tool' },
      ],
    });
    expect(tray.querySelectorAll('.pq-item.pq-local')).toHaveLength(0);
    expect(tray.querySelectorAll('.pq-item')).toHaveLength(1);
    expect(tray.textContent).toContain('wait a sec');

    // Clicking Send now on a steerable item posts directly to api/pending/send-now without interrupt.
    await h.click('[data-pq-send="m99"]');
    expect(h.calls.find((c) => c.path === 'api/pending/send-now')?.body).toEqual({
      topic: T,
      messageId: 'm99',
    });

    // Clicking Recall posts to api/pending/recall and restores content into the empty composer.
    await h.click('[data-pq-recall="m99"]');
    await until('recalled text restored to composer', () => (h.el('input') as HTMLTextAreaElement).value === 'wait a sec');
    expect(h.calls.find((c) => c.path === 'api/pending/recall')?.body).toEqual({
      topic: T,
      messageId: 'm99',
    });
  });

  it('shows inline secondary confirmation before interrupting on non-steerable queued cards', async () => {
    const T = 'a1b2c3d4';
    const h = await open({
      replies: {
        'api/pending/send-now': { ok: true, sent: 1 },
      },
    });
    await h.emit(sync(T, [], [T]));
    await h.emit({ t: 'typing', on: true });
    await h.emit({
      t: 'pending',
      items: [
        { id: 'm100', content: 'stop and do this', at: Date.now(), canSendNow: false, reason: 'turn' },
      ],
    });

    const tray = h.el('pending-queue');
    expect(tray.querySelector('[data-pq-send="m100"]')).not.toBeNull();

    // First click opens inline confirmation instead of firing the request immediately.
    await h.click('[data-pq-send="m100"]');
    expect(h.calls.filter((c) => c.path === 'api/pending/send-now')).toHaveLength(0);
    expect(tray.querySelector('[data-pq-confirm="m100"]')).not.toBeNull();
    expect(tray.querySelector('[data-pq-cancel="m100"]')).not.toBeNull();

    // Cancelling restores the normal buttons without posting.
    await h.click('[data-pq-cancel="m100"]');
    expect(tray.querySelector('[data-pq-send="m100"]')).not.toBeNull();
    expect(tray.querySelector('[data-pq-confirm="m100"]')).toBeNull();

    // Confirming posts api/pending/send-now with interrupt: true.
    await h.click('[data-pq-send="m100"]');
    await h.click('[data-pq-confirm="m100"]');
    expect(h.calls.find((c) => c.path === 'api/pending/send-now')?.body).toEqual({
      topic: T,
      messageId: 'm100',
      interrupt: true,
    });
  });

  it('falls back to a failed local bubble if an optimistic mid-turn send fails', async () => {
    const T = 'a1b2c3d4';
    const h = await open({ status: { 'api/send': 400 } });
    await h.emit(sync(T, [], [T]));
    await h.emit({ t: 'typing', on: true });

    (h.el('input') as HTMLTextAreaElement).value = 'lost connection';
    await h.click('#composer button[type="submit"]');

    await until('failed bubble rendered after send error', () => h.doc.querySelectorAll('#log .m.failed').length === 1);
    expect(h.el('pending-queue').hidden).toBe(true);
    expect(h.doc.querySelector('#log .m.failed')?.textContent).toContain('lost connection');
  });
});
