import { describe, it, expect } from 'vitest';
import {
  tick,
  until,
  delivered,
  sync,
  message,
  open,
  type Harness,
  type Call,
} from './page.dom.test-helpers.js';

const A = 'a1b2c3d4';
const B = 'b2c3d4e5';
const C = 'c3d4e5f6';

function editorFor(h: Harness, topicId: string): HTMLElement {
  const el = h.doc.querySelector<HTMLElement>(`.wb-topic-editor[data-topic-id="${topicId}"]`);
  if (!el) throw new Error(`missing topic editor for ${topicId}`);
  return el;
}

function ctrlClickTopic(h: Harness, topicId: string): void {
  const row = h.doc.querySelector<HTMLElement>(`[data-topic="${topicId}"]`);
  if (!row) throw new Error(`missing topic row ${topicId}`);
  row.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
}

function splitActiveEditorRight(h: Harness): void {
  h.doc.dispatchEvent(
    new h.window.KeyboardEvent('keydown', { key: '\\', ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

function sendFromEditor(h: Harness, editor: HTMLElement, text: string): void {
  const input = editor.querySelector<HTMLTextAreaElement>('textarea.composer-input, textarea');
  const form = editor.querySelector<HTMLFormElement>('form.composer, form');
  if (!input || !form) throw new Error('missing composer controls in editor');
  input.value = text;
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
}

function sends(h: Harness): Call[] {
  return h.calls.filter((c) => c.path === 'api/send');
}

function latestStream(h: Harness) {
  const s = h.streams.at(-1);
  if (!s) throw new Error('no stream opened');
  return s;
}

describe('webui page: split multi-topic live editors', () => {
  it('streams messages, typing, status, and pending queue to two live editors independently on one SSE stream', async () => {
    const h = await open({ width: 1280 });
    await delivered(h, sync(A, [message('w1', '<p>init A</p>')], [A, B, C]), `${A}.r.1`);

    // Open B in a new pinned tab via Ctrl-click.
    const streamsBefore = h.streams.length;
    ctrlClickTopic(h, B);
    await until('stream reconnects with B', () => h.streams.length > streamsBefore);

    // Stream reconnects once with both topics multiplexed on the single EventSource.
    const latest = latestStream(h);
    const url = new URL(latest.url, 'http://localhost');
    expect(url.searchParams.getAll('t')).toEqual([A, B]);
    expect(url.searchParams.getAll('last')).toContain(`${A}.r.1`);

    // Server resumes A and syncs B.
    await h.emit({ t: 'resumed', topic: A });
    await delivered(h, sync(B, [message('w10', '<p>init B</p>')], [A, B, C]), `${B}.r.1`);

    // Split B to the right so both editors are mounted side by side.
    splitActiveEditorRight(h);
    await tick();
    expect(h.doc.querySelectorAll('.wb-editor-group').length).toBe(2);

    const edA = editorFor(h, A);
    const edB = editorFor(h, B);
    expect(edA.querySelector('.log')?.textContent).toContain('init A');
    expect(edB.querySelector('.log')?.textContent).toContain('init B');

    // Deliver live events to both A (unfocused) and B (focused).
    await delivered(h, { t: 'msg', topic: A, msg: message('w2', '<p>live A</p>') }, `${A}.r.2`);
    await delivered(h, { t: 'msg', topic: B, msg: message('w11', '<p>live B</p>') }, `${B}.r.2`);
    await delivered(h, { t: 'typing', topic: A, on: true }, `${A}.r.3`);
    await h.emit({ t: 'status', topic: A, status: { agent: 'alpha', model: 'model-a' } });
    await h.emit({ t: 'status', topic: B, status: { agent: 'beta', model: 'model-b' } });
    await h.emit({
      t: 'pending',
      topic: B,
      items: [{ id: 'q1', content: 'queued for B', at: 1000, canSendNow: true, reason: 'turn' }],
    });

    expect(edA.querySelector('.log')?.textContent).toContain('live A');
    expect(edA.querySelector('.log')?.textContent).not.toContain('live B');
    expect(edB.querySelector('.log')?.textContent).toContain('live B');
    expect(edB.querySelector('.log')?.textContent).not.toContain('live A');

    expect(edA.querySelector<HTMLElement>('.wb-topic-typing')?.hidden).toBe(false);
    expect(edB.querySelector<HTMLElement>('.wb-topic-typing')?.hidden).toBe(true);
    expect(edA.querySelector('.wb-topic-status')?.textContent).toContain('model-a');
    expect(edB.querySelector('.wb-topic-status')?.textContent).toContain('model-b');
    expect(edB.querySelector('.wb-topic-pending-queue')?.textContent).toContain('queued for B');
    expect(edA.querySelector('.wb-topic-pending-queue')?.textContent || '').not.toContain('queued for B');
  });

  it('sends from each editor composer independently and keeps local bubbles, echo claims, and unsent failures isolated', async () => {
    const h = await open({ width: 1280 });
    await delivered(h, sync(A, [], [A, B]), `${A}.r.1`);
    const streamsBefore = h.streams.length;
    ctrlClickTopic(h, B);
    await until('stream reconnects with B', () => h.streams.length > streamsBefore);
    await h.emit({ t: 'resumed', topic: A });
    await delivered(h, sync(B, [], [A, B]), `${B}.r.1`);
    splitActiveEditorRight(h);
    await tick();

    const edA = editorFor(h, A);
    const edB = editorFor(h, B);

    // Send from A (succeeds) and from B (fails).
    sendFromEditor(h, edA, 'hello from A');
    await until('A send posted', () => sends(h).some((c) => c.body.topic === A));
    h.status['api/send'] = 400;
    sendFromEditor(h, edB, 'hello from B');
    await until('B shows failed bubble', () => Boolean(edB.querySelector('.m.failed')));

    const sent = sends(h);
    const sendA = sent.find((c) => c.body.topic === A);
    const sendB = sent.find((c) => c.body.topic === B);
    expect(sendA?.body.text).toBe('hello from A');
    expect(sendB?.body.text).toBe('hello from B');

    // Echo claims A's optimistic bubble without touching B's failed bubble.
    await delivered(
      h,
      {
        t: 'msg',
        topic: A,
        msg: { ...message('w20', '<div class="raw">hello from A</div>', true), nonce: String(sendA?.body.nonce) },
      },
      `${A}.r.2`,
    );

    expect(edA.querySelectorAll('.m').length).toBe(1);
    expect(edA.querySelector('.m.failed')).toBeNull();
    expect(edB.querySelector('.m.failed')?.textContent).toContain('hello from B');
  });

  it('navigates topic:active on sidebar click while keeping the pinned editor pinned and live', async () => {
    const h = await open({ width: 1280 });
    await delivered(h, sync(A, [message('w1', '<p>topic A</p>')], [A, B, C]), `${A}.r.1`);

    const streamsAfterOpen = h.streams.length;
    ctrlClickTopic(h, B);
    await until('stream reconnects with B', () => h.streams.length > streamsAfterOpen);
    await h.emit({ t: 'resumed', topic: A });
    await delivered(h, sync(B, [message('w2', '<p>topic B</p>')], [A, B, C]), `${B}.r.1`);
    splitActiveEditorRight(h);
    await tick();

    // Regular click on C in the sidebar navigates topic:active from A -> C, leaving pinned B alone.
    const streamsBeforeNav = h.streams.length;
    await h.click(`[data-topic="${C}"]`);
    await until('stream reconnects with C and B', () => h.streams.length > streamsBeforeNav);
    const url = new URL(latestStream(h).url, 'http://localhost');
    expect(url.searchParams.getAll('t')).toEqual([C, B]);

    await delivered(h, sync(C, [message('w3', '<p>topic C</p>')], [A, B, C]), `${C}.r.1`);
    await h.emit({ t: 'resumed', topic: B });
    await delivered(h, { t: 'msg', topic: B, msg: message('w4', '<p>still live B</p>') }, `${B}.r.2`);

    expect(editorFor(h, C).querySelector('.log')?.textContent).toContain('topic C');
    expect(editorFor(h, B).querySelector('.log')?.textContent).toContain('still live B');
  });

  it('marks every visible split topic as seen and restores pinned editors from aa_layout on reload', async () => {
    const h = await open({ width: 1280 });
    const reviewTopics = [
      { id: A, title: 'Topic A', createdAt: 1, lastAt: 2, msgCount: 1, running: false, stage: 'review' },
      { id: B, title: 'Topic B', createdAt: 1, lastAt: 2, msgCount: 1, running: false, stage: 'review' },
    ];
    await delivered(
      h,
      sync(A, [message('w1', '<p>A msg</p>')], [A, B], { topics: reviewTopics }),
      `${A}.r.1`,
    );

    const streamsBefore = h.streams.length;
    ctrlClickTopic(h, B);
    await until('stream reconnects with B', () => h.streams.length > streamsBefore);
    await h.emit({ t: 'resumed', topic: A });
    await delivered(
      h,
      sync(B, [message('w2', '<p>B msg</p>')], [A, B], { topics: reviewTopics }),
      `${B}.r.1`,
    );
    splitActiveEditorRight(h);
    await until('both topics reported seen', () => {
      const topics = h.calls.filter((c) => c.path === 'api/seen').map((c) => c.body.topic);
      return topics.includes(A) && topics.includes(B);
    });

    const seenTopics = h.calls.filter((c) => c.path === 'api/seen').map((c) => c.body.topic);
    expect(seenTopics).toContain(A);
    expect(seenTopics).toContain(B);

    // Reload with the persisted aa_layout storage.
    const savedStorage: Record<string, string> = {};
    for (let i = 0; i < h.window.localStorage.length; i += 1) {
      const k = h.window.localStorage.key(i);
      if (k) savedStorage[k] = h.window.localStorage.getItem(k) ?? '';
    }
    expect(savedStorage.aa_layout).toBeTruthy();

    const h2 = await open({ width: 1280, storage: savedStorage });
    const url2 = new URL(latestStream(h2).url, 'http://localhost');
    expect(url2.searchParams.getAll('t')).toEqual([A, B]);
    expect(h2.doc.querySelectorAll('.wb-editor-group').length).toBe(2);
    expect(h2.doc.querySelector(`.wb-topic-editor[data-topic-id="${A}"]`)).not.toBeNull();
    expect(h2.doc.querySelector(`.wb-topic-editor[data-topic-id="${B}"]`)).not.toBeNull();
  });

  it('keeps tablet and mobile single-topic (Ctrl-click does not open a second editor)', async () => {
    const h = await open({ width: 800 });
    await delivered(h, sync(A, [], [A, B]), `${A}.r.1`);
    await h.click('.wb-activity-item[data-activity-id="topics"]');
    ctrlClickTopic(h, B);
    await tick();
    expect(h.doc.querySelectorAll('.wb-topic-editor').length).toBe(1);
    const url = new URL(latestStream(h).url, 'http://localhost');
    expect(url.searchParams.getAll('t').length).toBeLessThanOrEqual(1);
  });

  it('keeps independent scroll positions per editor and tracks focus across split groups', async () => {
    const h = await open({ width: 1280 });
    await delivered(h, sync(A, [message('w1', '<p>A1</p>')], [A, B]), `${A}.r.1`);
    const streamsBefore = h.streams.length;
    ctrlClickTopic(h, B);
    await until('stream reconnects with B', () => h.streams.length > streamsBefore);
    await h.emit({ t: 'resumed', topic: A });
    await delivered(h, sync(B, [message('w2', '<p>B1</p>')], [A, B]), `${B}.r.1`);
    splitActiveEditorRight(h);
    await tick();

    const edA = editorFor(h, A);
    const edB = editorFor(h, B);
    const logA = edA.querySelector<HTMLElement>('.log')!;
    const logB = edB.querySelector<HTMLElement>('.log')!;
    Object.defineProperty(logA, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(logA, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(logB, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(logB, 'clientHeight', { value: 400, configurable: true });
    logA.scrollTop = 120;
    logB.scrollTop = 600;
    logA.dispatchEvent(new h.window.Event('scroll'));
    logB.dispatchEvent(new h.window.Event('scroll'));

    // New message in B does not alter A's scroll position.
    await delivered(h, { t: 'msg', topic: B, msg: message('w3', '<p>B2</p>') }, `${B}.r.2`);
    expect(logA.scrollTop).toBe(120);

    // Focusing group 1 (A) then group 2 (B) updates the active editor group.
    edA.dispatchEvent(new h.window.Event('focusin', { bubbles: true }));
    await tick();
    const groupA = edA.closest('.wb-editor-group');
    const groupB = edB.closest('.wb-editor-group');
    expect(groupA?.classList.contains('is-active')).toBe(true);
    expect(groupB?.classList.contains('is-active')).toBe(false);

    edB.dispatchEvent(new h.window.Event('focusin', { bubbles: true }));
    await tick();
    expect(groupB?.classList.contains('is-active')).toBe(true);
    expect(groupA?.classList.contains('is-active')).toBe(false);
  });
});
