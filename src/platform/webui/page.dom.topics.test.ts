import { describe, it, expect } from 'vitest';
import {
  webMessageHtml,
  tick,
  saved,
  until,
  within,
  withinAsync,
  untilAsync,
  opens,
  chipNames,
  sync,
  message,
  face,
  open,
  readRecord,
  rowMenu,
  ROW,
  VIEW,
  layout,
  lines,
  onTop,
  delivered,
  lastSaid,
  type Harness,
  type Call,
} from './page.dom.test-helpers.js';

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
    { id: C, title: '[cc] release notes', lastAt: 998, msgCount: 0 },
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

  it('searches and filters by the agent the daemon says is bound, named as the row legend names it', async () => {
    // The legend, the Agent chips and the search read one answer (agentOf): a topic named under cc
    // and handed to cx is a cx topic in all three, and a host-qualified id is the short label the
    // row shows — while the whole id and the title's old tag still find it.
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: '[cc] handed over', lastAt: 1000, msgCount: 0, agent: { id: 'cx', harness: 'codex' } },
        {
          id: B,
          title: '[cbc@uniagent] remote work',
          lastAt: 999,
          msgCount: 0,
          agent: { id: 'cbc@uniagent', harness: 'custom' },
          dir: { name: 'workspace', path: '/home/user/workspace', host: 'uniagent' },
        },
        { id: C, title: '[cc] still cc', lastAt: 998, msgCount: 0, agent: { id: 'cc', harness: 'claude' } },
      ],
    });
    await openPanel(h);
    const values = Array.from(h.doc.querySelectorAll('.fb-chip[data-fb-group="agent"]')).map((c) => c.getAttribute('data-fb-value'));
    expect(values).toEqual(['cbc', 'cc', 'cx']);
    await toggle(h, 'agent', 'cx');
    expect(ids(h)).toEqual([A]);
    await toggle(h, 'agent', 'cx');

    await type(h, 'cx');
    expect(ids(h)).toEqual([A]);
    await type(h, 'cbc@uniagent');
    expect(ids(h)).toEqual([B]);
    // The stored name is still searched, tag and all.
    await type(h, 'cc');
    expect(new Set(ids(h))).toEqual(new Set([A, C]));
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
    await opens(h, `api/events?t=${A}`);
  });

  it('stars a topic from its row without opening it, and moves an offline one to the Starred tab', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A, B, C]));
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear all topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear all topics');

    await rowMenu(h, C);
    await h.click('[data-rmk="star"]');

    expect(h.calls.find((c) => c.path === 'api/topics/star')?.body).toEqual({ topic: C, starred: true });
    // Offline starred topics move out of Topics into the Starred tab at once.
    expect(order(h)).toEqual([A, B]);
    expect(h.doc.querySelector(`[data-topic="${A}"] .topic-star-mark`)).toBeNull();
    // Starring is not a reason to switch to it.
    await opens(h, `api/events?t=${A}`);
    // And the sweep now says it spares what was starred.
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear unstarred topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear unstarred topics');

    await h.click('#sb-tab-starred');
    expect(order(h)).toEqual([C]);
    expect(h.doc.querySelector(`[data-topic="${C}"] .topic-star-mark`)).not.toBeNull();
    expect(h.doc.querySelector(`[data-topic="${C}"] .topic-more`)).not.toBeNull();
    expect(h.doc.querySelector('#topics .after-needs')).toBeNull();

    // The daemon's order is still the page's order underneath: when the topic on screen goes, the
    // page lands in the most RECENT one, not in whatever is starred at the top.
    await h.emit({
      t: 'topics',
      topics: [
        { id: B, title: 'b', lastAt: 999, msgCount: 0 },
        { id: C, title: 'c', lastAt: 998, msgCount: 0, starred: true },
      ],
    });
    await opens(h, `api/events?t=${B}`);
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
    await opens(h, 'api/events?t=deadbeef');
    expect(h.rows()).toBe(1);
    await untilAsync('the cleared topic' + "'s cache is gone", async () => (await h.cached(A)) === null);
    expect(await h.cached(B)).toHaveLength(1);
    expect(JSON.parse(h.window.localStorage.getItem('aa_drafts') ?? 'null')).toEqual({ [B]: 'half-written in B' });

    // And the draft is still THERE on the Starred tab, not just on disk.
    await h.click('#sb-tab-starred');
    expect(h.rows()).toBe(1);
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

    await h.click('#sb-tab-starred');
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

  it('puts Topics | Starred | History in the panel-title as three tabs, with #clear-topics after them', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    const headerTitle = h.doc.querySelector('#sidebar-header .panel-title')!;
    const tabs = headerTitle.querySelector('[role="tablist"]')!;
    expect([...tabs.querySelectorAll('[role="tab"]')].map((t) => t.id)).toEqual([
      'sb-tab-topics',
      'sb-tab-starred',
      'sb-tab-history',
    ]);
    expect(h.el('sb-tab-topics').getAttribute('aria-controls')).toBe('topics');
    expect(h.el('sb-tab-starred').getAttribute('aria-controls')).toBe('topics');
    expect(h.el('sb-tab-history').getAttribute('aria-controls')).toBe('history-pane');
    expect(tabs.nextElementSibling).toBe(h.el('clear-topics'));
    expect(h.el('clear-topics').nextElementSibling).toBe(h.el('read-topics'));
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
    await h.click('#sb-tab-starred');
    await rowMenu(h, B);
    await h.click('[data-rmk="star"]');
    await h.click('#sb-tab-topics');
    expect(h.el('clear-topics').getAttribute('title')).toBe('Clear all topics');
    expect(h.el('clear-topics').getAttribute('aria-label')).toBe('Clear all topics');
    expect(h.el('clear-topics').textContent).toBe('');
  });

  it('splits starred topics into the Starred tab while keeping active and idle starred topics in both tabs', async () => {
    const D = 'd4e5f6a7';
    const E = 'e5f6a7b8';
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'plain offline', lastAt: 1000, msgCount: 0 },
        { id: B, title: 'starred offline', lastAt: 999, msgCount: 0, starred: true },
        { id: C, title: 'starred idle', lastAt: 998, msgCount: 0, live: true, starred: true },
        { id: D, title: 'starred running', lastAt: 997, msgCount: 0, running: true, live: true, starred: true },
        { id: E, title: 'starred needs', lastAt: 996, msgCount: 0, stage: 'answer', live: true, starred: true },
      ],
    });

    // Topics tab: plain + active/idle starred (E, D, C, A); offline starred (B) is moved out.
    expect(order(h)).toEqual([E, D, C, A]);
    expect(h.el('sidebar').classList.contains('on-starred')).toBe(false);

    // Starred tab: all starred topics (E, D, C, B), plain (A) excluded.
    await h.click('#sb-tab-starred');
    expect(h.el('sb-tab-starred').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sb-tab-topics').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sidebar').classList.contains('on-starred')).toBe(true);
    expect(h.el('topics').getAttribute('aria-labelledby')).toBe('sb-tab-starred');
    expect(order(h)).toEqual([E, D, C, B]);
    // Starred filter group is omitted on the Starred tab.
    expect(h.doc.querySelector('.fb-chip[data-fb-group="starred"]')).toBeNull();

    // Empty state when no topics are starred.
    await h.emit({ t: 'topics', topics: [{ id: A, title: 'plain only', lastAt: 1000, msgCount: 0 }] });
    expect(order(h)).toEqual([]);
    expect(h.doc.querySelector('#topics .topics-empty')?.textContent).toBe('No starred topics');
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

/**
 * A topic's copy (page.ts put / get / enter): one per topic, in memory and in IndexedDB, as of the
 * last event it reflects. Going back to a topic puts its copy up and resumes the stream from there.
 */
describe('webui page: going back to a topic this page left', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const many = (n: number): Array<Record<string, unknown>> =>
    Array.from({ length: n }, (_, i) => message(`w${i + 1}`, `<p>line ${i + 1}</p>`));

  it('puts a topic back whole and resumes its stream, instead of being sent all of it again', async () => {
    // Back and forth between two long topics was a full sync every time — 85 KB gzipped for 1000
    // messages — because the cache kept 200 and a switch empties memory.
    const h = await open();
    await delivered(h, sync(A, many(300), [A, B]), `${A}.run.300`);
    await h.click(`[data-topic="${B}"]`);
    await delivered(h, sync(B, [message('b1', '<p>in B</p>')], [A, B]), `${B}.run.1`);
    expect(h.painted()).toBe(1);

    await h.click(`[data-topic="${A}"]`);
    // On screen at once, every one of them, before the stream has said anything.
    expect(h.painted()).toBe(300);
    await opens(h, `api/events?t=${A}&last=${encodeURIComponent(`${A}.run.300`)}`);
    // The row does not say this copy is its latest, so the page says it is still checking.
    expect(h.waiting()).not.toBeNull();
    // What was said meanwhile is replayed; then the daemon says the catch-up is over.
    await delivered(h, { t: 'msg', msg: message('w301', '<p>said while away</p>') }, `${A}.run.301`);
    await h.emit({ t: 'resumed' });
    expect(h.painted()).toBe(301);
    expect(h.waiting()).toBeNull();
    expect(lastSaid(h)).toContain('said while away');
  });

  it('takes the whole topic as before when the daemon can no longer resume it', async () => {
    const h = await open();
    await delivered(h, sync(A, many(5), [A, B]), `${A}.run.5`);
    await h.click(`[data-topic="${B}"]`);
    await delivered(h, sync(B, [], [A, B]), `${B}.run.0`);
    await h.click(`[data-topic="${A}"]`);
    expect(h.painted()).toBe(5);
    // The backlog did not reach that far: a sync, which is reconciled over what is on screen.
    await delivered(h, sync(A, many(7).slice(2), [A, B]), `${A}.run.400`);
    expect(h.painted()).toBe(5);
    expect(h.waiting()).toBeNull();
    expect(h.el('log').textContent).not.toContain('line 1');
    expect(h.el('log').textContent).toContain('line 7');
  });

  it('keeps nothing to resume from for a topic left before its stream said where it was', async () => {
    const h = await open();
    await delivered(h, sync(A, many(3), [A, B]), `${A}.run.3`);
    await h.click(`[data-topic="${B}"]`);
    // Left again before B's sync arrived: there is no position to resume B from.
    await h.click(`[data-topic="${A}"]`);
    await h.click(`[data-topic="${B}"]`);
    await opens(h, `api/events?t=${B}`);
  });

  it('does not resume a copy from a daemon that has since restarted', async () => {
    const h = await open();
    await delivered(h, sync(A, many(3), [A, B]), `${A}.run.3`);
    await h.click(`[data-topic="${B}"]`);
    await delivered(h, sync(B, [], [A, B], { epoch: 2 }), `${B}.other.0`);
    await h.click(`[data-topic="${A}"]`);
    await opens(h, `api/events?t=${A}`);
    // Still painted, as the history it now is.
    expect(h.painted()).toBe(3);
  });

  it('forgets its copy of a topic the list no longer has', async () => {
    // No IndexedDB, so memory is the only copy there is.
    const h = await open({ idb: null });
    await delivered(h, sync(A, many(3), [A, B, 'c3d4e5f6']), `${A}.run.3`);
    await h.click(`[data-topic="${B}"]`);
    await delivered(h, sync(B, [], [A, B, 'c3d4e5f6']), `${B}.run.0`);
    // A goes from the list (deleted in another tab): its copy goes with it — memory nobody could
    // read again. Listed once more, it is entered like a topic never seen.
    await h.emit({ t: 'topic-rows', tv: 2, rows: [], gone: [A] });
    await h.emit({ t: 'topics', tv: 3, topics: sync(B, [], [A, B, 'c3d4e5f6']).topics as unknown[] });
    await h.click(`[data-topic="${A}"]`);
    await opens(h, `api/events?t=${A}`);
  });

  it('resumes from memory in a browser with no IndexedDB', async () => {
    const h = await open({ idb: null });
    await delivered(h, sync(A, many(4), [A, B]), `${A}.run.4`);
    await h.click(`[data-topic="${B}"]`);
    await delivered(h, sync(B, [message('b1', '<p>in B</p>')], [A, B]), `${B}.run.1`);
    await h.click(`[data-topic="${A}"]`);
    expect(h.painted()).toBe(4);
    expect(lastSaid(h)).toContain('line 4');
    await opens(h, `api/events?t=${A}&last=${encodeURIComponent(`${A}.run.4`)}`);
    await delivered(h, { t: 'msg', msg: message('w5', '<p>line 5</p>') }, `${A}.run.5`);
    await h.emit({ t: 'resumed' });
    expect(lastSaid(h)).toContain('line 5');
    // And back to B the same way, from the copy put on the way out of it.
    await h.click(`[data-topic="${B}"]`);
    await opens(h, `api/events?t=${B}&last=${encodeURIComponent(`${B}.run.1`)}`);
  });
});

describe('webui page: a topic fetched before it is opened', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const C = 'c3d4e5f6';
  const url = (id: string): string => `api/topic?t=${id}`;
  /**
   * A topic row as the daemon sends it: `stage` is what makes it need a person, and `last` is the
   * id of its newest event, which is what a copy is matched against.
   */
  const row = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: `Topic ${id}`,
    lastAt: 1000,
    running: false,
    msgCount: 0,
    last: `${id}.run.0`,
    ...over,
  });
  /** A snapshot as `api/topic` answers one. */
  const snap = (
    topic: string,
    messages: Array<Record<string, unknown>>,
    last: string,
    epoch = 1
  ): Record<string, unknown> => ({ topic, epoch, last, lastAt: 1000, messages });
  const fetched = (h: Harness, id: string): boolean => h.calls.some((c) => c.path === url(id));
  const times = (h: Harness, id: string): number => h.calls.filter((c) => c.path === url(id)).length;
  const asked = (h: Harness): string[] => h.calls.filter((c) => c.path.startsWith('api/topic')).map((c) => c.path);
  /** Whether the topic's record has been written, by the prefetch or by anyone. */
  const kept = (h: Harness, id: string) => async (): Promise<boolean> => (await readRecord(h.idb, id)) !== null;
  const keptAt = (h: Harness, id: string, last: string) => async (): Promise<boolean> =>
    (await readRecord(h.idb, id))?.last === last;

  it('fetches a topic that needs an answer, and opening it paints the latest before the stream says anything', async () => {
    const h = await open({ replies: { [url(B)]: snap(B, [message('w9', '<p>from B</p>')], `${B}.run.4`) } });
    await h.emit(
      sync(A, [message('a1', '<p>in A</p>')], [A, B], { topics: [row(A), row(B, { stage: 'answer', last: `${B}.run.4` })] })
    );
    await within('the prefetch goes out', 2000, () => fetched(h, B));
    await withinAsync('the copy is in the cache', 2000, kept(h, B));
    // Whole, so it says where its stream can be resumed from.
    expect(await readRecord(h.idb, B)).toMatchObject({ epoch: 1, last: `${B}.run.4` });
    expect(h.painted()).toBe(1);

    const before = h.calls.length;
    await h.click(`[data-topic="${B}"]`);
    expect(lastSaid(h)).toContain('from B');
    // The row's own last: this is B as it stands, and nothing says more may be coming.
    expect(h.waiting()).toBeNull();
    await opens(h, `api/events?t=${B}&last=${encodeURIComponent(`${B}.run.4`)}`);
    expect(h.calls.slice(before).filter((c) => c.path.startsWith('api/topic'))).toEqual([]);
  });

  it('puts up a topic left mid-turn as it finished, when the turn only edited its reply', async () => {
    // The everyday case behind the report of 2026-11-19: send, look elsewhere while it works, come
    // back when its row turns green. A reply is one message edited as it streams, so the row's last
    // moves and its lastAt does not. Through 3.13 a topic left was never fetched, and came back as
    // it was left — "working on it" — to be caught up by its stream a second or two later.
    const replies: Record<string, unknown> = {};
    const h = await open({ replies });
    await delivered(h, sync(A, [message('w1', '<p>earlier</p>')], [A, B], { topics: [row(A), row(B)] }), `${A}.run.1`);
    (h.el('input') as HTMLTextAreaElement).value = 'go on';
    await h.click('#composer button[type="submit"]');
    const nonce = h.calls.find((c) => c.path === 'api/send')?.body.nonce as string;
    const echo = { ...message('w2', '<div class="raw">go on</div>', true), nonce };
    await delivered(h, { t: 'msg', msg: echo }, `${A}.run.2`);
    await delivered(h, { t: 'msg', msg: message('w3', '<p>working on it</p>') }, `${A}.run.3`);

    await h.click(`[data-topic="${B}"]`);
    await delivered(
      h,
      sync(B, [message('b1', '<p>in B</p>')], [A, B], { topics: [row(A, { running: true, last: `${A}.run.3` }), row(B)] }),
      `${B}.run.1`
    );
    replies[url(A)] = snap(A, [message('w1', '<p>earlier</p>'), echo, message('w3', '<p>all done</p>')], `${A}.run.9`);
    await h.emit({ t: 'topic-rows', tv: 2, rows: [row(A, { stage: 'review', last: `${A}.run.9` })] });
    await within('A is fetched', 2000, () => fetched(h, A));
    await withinAsync('its copy is kept', 2000, keptAt(h, A, `${A}.run.9`));

    const before = h.calls.length;
    await h.click(`[data-topic="${A}"]`);
    // As it finished, at once, and with nothing to say that more may be coming.
    expect(lastSaid(h)).toContain('all done');
    expect(h.el('log').textContent).not.toContain('working on it');
    expect(h.waiting()).toBeNull();
    // Resumed from the row's last, so the daemon has nothing to replay and sends no sync.
    await opens(h, `api/events?t=${A}&last=${encodeURIComponent(`${A}.run.9`)}&tv=2`);
    expect(h.calls.slice(before).filter((c) => c.path.startsWith('api/topic'))).toEqual([]);
    await h.emit({ t: 'resumed' });
    expect(h.painted()).toBe(3);
    expect(lastSaid(h)).toContain('all done');
  });

  it('puts up a topic left mid-turn as it finished, when the turn posted a tool bubble and a reply', async () => {
    const replies: Record<string, unknown> = {};
    const h = await open({ replies });
    await delivered(h, sync(A, [message('w1', '<p>the task</p>', true)], [A, B], { topics: [row(A), row(B)] }), `${A}.run.1`);
    await delivered(h, { t: 'msg', msg: message('w2', '<p>starting</p>') }, `${A}.run.2`);
    await h.click(`[data-topic="${B}"]`);
    await delivered(h, sync(B, [], [A, B], { topics: [row(A, { running: true, last: `${A}.run.2` }), row(B)] }), `${B}.run.0`);

    const tools = { ...message('w3', webMessageHtml('tools', '💻 Bash: "npm test" ✓ 4.1s')), kind: 'tools' };
    replies[url(A)] = snap(
      A,
      [message('w1', '<p>the task</p>', true), message('w2', '<p>starting</p>'), tools, message('w4', '<p>tests pass</p>')],
      `${A}.run.14`
    );
    await h.emit({ t: 'topic-rows', tv: 2, rows: [row(A, { stage: 'review', last: `${A}.run.14`, lastAt: 1200, msgCount: 4 })] });
    await withinAsync('its copy is kept', 2000, keptAt(h, A, `${A}.run.14`));

    await h.click(`[data-topic="${A}"]`);
    expect(h.painted()).toBe(4);
    expect(h.doc.querySelectorAll('#log .tl')).toHaveLength(1);
    expect(lastSaid(h)).toContain('tests pass');
    expect(h.waiting()).toBeNull();
    await opens(h, `api/events?t=${A}&last=${encodeURIComponent(`${A}.run.14`)}&tv=2`);
  });

  it('fetches a scheduled run and a sub-agent that finished, and opens each as it finished', async () => {
    // Neither is a green row in the switcher — a run lives in the panel, a sub-agent's reply goes
    // to the agent that opened it — but each is opened from its own row or its notification, and
    // was the whole topic again every time.
    const R = 'c3d4e5f6';
    const S = 'd4e5f6a7';
    const h = await open({
      push: { permission: 'granted', subscribed: true },
      replies: {
        [url(R)]: snap(R, [message('r1', '<p>the run reported</p>')], `${R}.run.5`),
        [url(S)]: snap(S, [message('s1', '<p>the sub-agent reported</p>')], `${S}.run.7`),
      },
    });
    await h.emit(
      sync(A, [], [A], {
        topics: [
          row(A),
          row(R, { stage: 'review', scheduled: true, title: '[cc] ⏰ After close', last: `${R}.run.5` }),
          row(S, { stage: 'review', parent: A, last: `${S}.run.7` }),
        ],
      })
    );
    await withinAsync('both are kept', 2000, async () => (await kept(h, R)()) && (await kept(h, S)()));
    for (const [id, said, last] of [
      [R, 'the run reported', `${R}.run.5`],
      [S, 'the sub-agent reported', `${S}.run.7`],
    ] as const) {
      // Opened from its notification.
      for (const fn of h.push.listeners) fn({ data: { goto: id } });
      await tick();
      expect(lastSaid(h)).toContain(said);
      expect(h.waiting()).toBeNull();
      await opens(h, `api/events?t=${id}&last=${encodeURIComponent(last)}`);
    }
    expect(times(h, R)).toBe(1);
    expect(times(h, S)).toBe(1);
  });

  it('leaves the topic on screen alone', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A, B, C], { topics: [row(A, { stage: 'answer' }), row(B), row(C)] }));
    await new Promise((r) => setTimeout(r, 600));
    expect(asked(h)).toEqual([]);
  });

  it('fetches every topic that needs the person, three at a time', async () => {
    // Through 3.9.0 it was the first four and no more, one at a time — so the fifth row of a busy
    // morning was never fetched, and the fourth only after three others had come in.
    const ids = ['11111111', '22222222', '33333333', '44444444', '55555555', '66666666'];
    const replies: Record<string, unknown> = {};
    const gates: Record<string, Promise<void>> = {};
    const open1: Record<string, () => void> = {};
    for (const id of ids) {
      replies[url(id)] = snap(id, [message(`m${id}`, '<p>x</p>')], `${id}.run.1`);
      gates[url(id)] = new Promise<void>((r) => (open1[id] = r));
    }
    const h = await open({ replies, held: gates });
    await h.emit(sync(A, [], [A, ...ids], { topics: [row(A), ...ids.map((id) => row(id, { stage: 'answer', last: `${id}.run.1` }))] }));
    await within('three in flight', 2000, () => asked(h).length === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(asked(h)).toHaveLength(3);

    open1[ids[0]!]!();
    await within('a fourth once one is in', 2000, () => asked(h).length === 4);
    for (const id of ids) open1[id]!();
    await within('all six', 2000, () => asked(h).length === 6);
    for (const id of ids) await withinAsync(`${id} is cached`, 2000, kept(h, id));
  });

  it('fetches them nearest the top of the sidebar first, not in the order the daemon listed them', async () => {
    // Questions beat failures, failures beat finished replies, and within one stage the newest
    // is first — the order topicRows draws the needs-you block in. The daemon's own order here is
    // the reverse, so a prefetch that took topics as they came would start at the bottom.
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
    await within('all six', 4000, () => asked(h).length === 6);
    expect(asked(h)).toEqual([ans1, ans2, failed, rev1, rev2, rev3].map(url));
  });

  it('fetches it again when the row’s last moves, though its lastAt does not', async () => {
    // An edit moves no lastAt — the reply streaming into one message is edits all the way down —
    // so a copy matched by lastAt was taken for current while the reply went on growing.
    const replies: Record<string, unknown> = { [url(B)]: snap(B, [message('w1', '<p>half</p>')], `${B}.run.1`) };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer', last: `${B}.run.1` })] }));
    await withinAsync('the first copy', 2000, keptAt(h, B, `${B}.run.1`));

    replies[url(B)] = snap(B, [message('w1', '<p>whole</p>')], `${B}.run.6`);
    await h.emit({ t: 'topic-rows', tv: 2, rows: [row(B, { stage: 'answer', last: `${B}.run.6` })] });
    await withinAsync('the second copy', 2000, keptAt(h, B, `${B}.run.6`));
    expect(times(h, B)).toBe(2);
    await h.click(`[data-topic="${B}"]`);
    expect(lastSaid(h)).toContain('whole');
  });

  it('drops an answer that arrives after the person has opened the topic', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = await open({ replies: { [url(B)]: snap(B, [message('w1', '<p>stale</p>')], `${B}.run.1`) }, held: { [url(B)]: gate } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer', last: `${B}.run.1` })] }));
    await within('the prefetch goes out', 2000, () => fetched(h, B));

    // Opened while the answer was still on the wire, and left again before its stream said
    // where it got to — so nothing else could put B up.
    await h.click(`[data-topic="${B}"]`);
    release();
    await tick();
    await tick();
    await h.click(`[data-topic="${A}"]`);
    await h.click(`[data-topic="${B}"]`);
    expect(await readRecord(h.idb, B)).toBeNull();
    await opens(h, `api/events?t=${B}`);
  });

  it('does not put a fetched copy over a newer one the page kept while it was on the wire', async () => {
    // The fetch was in flight when B was opened, read on and left again: the copy the page put on
    // the way out is newer than the answer, which lands after it and must not be written over it —
    // in memory or in the database.
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = await open({
      replies: { [url(B)]: snap(B, [message('w1', '<p>from the fetch</p>')], `${B}.run.1`) },
      held: { [url(B)]: gate },
    });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer', last: `${B}.run.1` })] }));
    await within('the prefetch goes out', 2000, () => fetched(h, B));

    await h.click(`[data-topic="${B}"]`);
    await delivered(h, { t: 'msg', msg: message('b7', '<p>said since</p>') }, `${B}.run.7`);
    await h.click(`[data-topic="${A}"]`);
    await withinAsync('the page’s copy', 2000, keptAt(h, B, `${B}.run.7`));
    release();
    await new Promise((r) => setTimeout(r, 50));

    const rec = await readRecord(h.idb, B);
    expect(rec?.last).toBe(`${B}.run.7`);
    expect(rec?.list.map((m) => m.id)).toEqual(['b7']);
    await h.click(`[data-topic="${B}"]`);
    expect(lastSaid(h)).toContain('said since');
    await opens(h, `api/events?t=${B}&last=${encodeURIComponent(`${B}.run.7`)}`);
  });

  it('fetches nothing while the tab is hidden', async () => {
    const h = await open({ replies: { [url(B)]: snap(B, [], `${B}.run.0`) } });
    Object.defineProperty(h.doc, 'visibilityState', { value: 'hidden', configurable: true });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer' })] }));
    await new Promise((r) => setTimeout(r, 600));
    expect(fetched(h, B)).toBe(false);
  });

  it('fetches nothing in a browser with no IndexedDB, where memory could not keep twenty', async () => {
    const h = await open({ idb: null, replies: { [url(B)]: snap(B, [], `${B}.run.0`) } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer' })] }));
    await new Promise((r) => setTimeout(r, 600));
    expect(asked(h)).toEqual([]);
  });

  it('does not ask again at once when the daemon refused one', async () => {
    const h = await open({ status: { [url(B)]: 500 } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer' })] }));
    await within('the first attempt', 2000, () => fetched(h, B));
    await new Promise((r) => setTimeout(r, 600));
    expect(times(h, B)).toBe(1);
  });

  it('asks for a topic once, even when the list moves again', async () => {
    const h = await open({ replies: { [url(B)]: snap(B, [message('w1', '<p>x</p>')], `${B}.run.1`) } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer', last: `${B}.run.1` })] }));
    await withinAsync('the copy', 2000, kept(h, B));

    // The same row, sent again: another list event must not be read as "this copy is stale".
    await h.emit({ t: 'topic-rows', tv: 2, rows: [row(B, { stage: 'answer', last: `${B}.run.1` })] });
    await new Promise((r) => setTimeout(r, 600));
    expect(times(h, B)).toBe(1);
  });

  it('asks once per version of the row, even when the answer is never that version', async () => {
    // The row and the answer disagree — a row a moment behind, or a daemon counting differently.
    // Matched by the copy alone, the next pass would read it as stale and fetch for ever.
    const h = await open({ replies: { [url(B)]: snap(B, [message('w1', '<p>x</p>')], `${B}.run.3`) } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer', last: `${B}.run.4` })] }));
    await withinAsync('the copy', 2000, kept(h, B));
    await h.emit({ t: 'topic-rows', tv: 2, rows: [row(B, { stage: 'answer', last: `${B}.run.4` })] });
    await new Promise((r) => setTimeout(r, 600));
    expect(times(h, B)).toBe(1);
  });

  it('keeps every topic it fetched: a full house of long ones does not push the top one out', async () => {
    // What 3.9.0 did with four topics of a thousand messages: fetch the first, the second, the
    // third — evicting the first to make room — then the first again, for ever.
    const ids = ['11111111', '22222222', '33333333', '44444444'];
    const replies: Record<string, unknown> = {};
    const long = (id: string) => Array.from({ length: 1000 }, (_, i) => message(`${id}-${i}`, `<p>${i}</p>`));
    for (const id of ids) replies[url(id)] = snap(id, long(id), `${id}.run.1000`);
    const h = await open({ replies });
    await h.emit(
      sync(A, [], [A, ...ids], { topics: [row(A), ...ids.map((id) => row(id, { stage: 'answer', msgCount: 1000, last: `${id}.run.1000` }))] })
    );
    await within('all four', 4000, () => asked(h).length === 4);
    for (const id of ids) await withinAsync(`${id} is cached`, 2000, kept(h, id));
    await new Promise((r) => setTimeout(r, 600));
    expect(asked(h)).toHaveLength(4);
    expect((await readRecord(h.idb, ids[0]!))?.list).toHaveLength(1000);
  });

  it('opens it from the cache after a reload, and does not fetch it again', async () => {
    // The copy outlives the page: a reload, or a PWA the phone closed, finds it where it was.
    const first = await open({ replies: { [url(B)]: snap(B, [message('w9', '<p>from B</p>')], `${B}.run.4`) } });
    const list = [row(A), row(B, { stage: 'answer', last: `${B}.run.4` })];
    await first.emit(sync(A, [], [A, B], { topics: list }));
    await withinAsync('the copy', 2000, kept(first, B));
    first.window.close();

    const h = await open({ idb: first.idb });
    await h.emit(sync(A, [], [A, B], { topics: list }));
    await new Promise((r) => setTimeout(r, 600));
    expect(asked(h)).toEqual([]);

    await h.click(`[data-topic="${B}"]`);
    await until('B is painted from the cache', () => lastSaid(h).includes('from B'));
    expect(h.waiting()).toBeNull();
    await opens(h, `api/events?t=${B}&last=${encodeURIComponent(`${B}.run.4`)}`);
  });

  it('paints a copy from another run of the daemon, but asks for the whole topic', async () => {
    // Its ids name messages of a process that has gone, so its last event is no place to resume
    // from — the copy is history until the sync says otherwise.
    const first = await open({ replies: { [url(B)]: snap(B, [message('w9', '<p>from B</p>')], `${B}.run.4`) } });
    await first.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer', last: `${B}.run.4` })] }));
    await withinAsync('the copy', 2000, kept(first, B));
    first.window.close();

    const h = await open({ idb: first.idb, status: { [url(B)]: 500 } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer', last: `${B}.two.0` })], epoch: 2 }));
    await within('the new run is asked', 2000, () => fetched(h, B));
    await h.click(`[data-topic="${B}"]`);
    await opens(h, `api/events?t=${B}`);
    await until('B is painted from the cache', () => lastSaid(h).includes('from B'));
  });

  it('does not fetch a topic the service worker has just kept', async () => {
    const h = await open({ push: { permission: 'granted', subscribed: true }, replies: { [url(B)]: snap(B, [], `${B}.run.3`) } });
    for (const fn of h.push.listeners) fn({ data: { cached: { topic: B, epoch: 1, last: `${B}.run.3` } } });
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer', last: `${B}.run.3` })] }));
    await new Promise((r) => setTimeout(r, 600));
    expect(asked(h)).toEqual([]);
  });

  it('puts up what the service worker kept over the older copy this page has in memory', async () => {
    // B was left at .5; a push then kept it at .8 while the page was in the background. Memory
    // first would put up the turn as it was left.
    const h = await open({ push: { permission: 'granted', subscribed: true } });
    await delivered(h, sync(A, [], [A, B], { topics: [row(A), row(B)] }), `${A}.run.0`);
    await h.click(`[data-topic="${B}"]`);
    await delivered(h, sync(B, [message('w1', '<p>as it was left</p>')], [A, B]), `${B}.run.5`);
    await h.click(`[data-topic="${A}"]`);
    await withinAsync('the copy put on the way out', 2000, keptAt(h, B, `${B}.run.5`));

    // What the worker writes, the way it writes it (sw.ts keepTopic).
    await new Promise<void>((resolve) => {
      const rq = h.idb!.open('aa_cache', 1);
      rq.onsuccess = () => {
        const t = rq.result.transaction('topics', 'readwrite');
        const list = [{ ...message('w1', '<p>as the push found it</p>'), _g: 1 }];
        t.objectStore('topics').put({ topic: B, at: Date.now(), json: JSON.stringify(list), epoch: 1, last: `${B}.run.8` });
        t.oncomplete = () => {
          rq.result.close();
          resolve();
        };
      };
    });
    for (const fn of h.push.listeners) fn({ data: { cached: { topic: B, epoch: 1, last: `${B}.run.8` } } });

    await h.click(`[data-topic="${B}"]`);
    await until('the worker’s copy', () => lastSaid(h).includes('as the push found it'));
    await opens(h, `api/events?t=${B}&last=${encodeURIComponent(`${B}.run.8`)}`);
  });

  it('asks again after a restart, even for a topic it had just failed on', async () => {
    // A failure is remembered per row, and a restart may move nothing on the row the page holds —
    // so without clearing that memory with the epoch, the new daemon's answer would not be asked for.
    const h = await open({ status: { [url(B)]: 500 } });
    const list = [row(A), row(B, { stage: 'answer' })];
    await h.emit(sync(A, [], [A, B], { topics: list }));
    await within('the failed attempt', 2000, () => fetched(h, B));

    await h.emit(sync(A, [], [A, B], { topics: list, epoch: 2 }));
    await within('the retry', 2000, () => times(h, B) === 2);
  });

  it('starts again after bodies that do not parse', async () => {
    // A rejected r.json() used to leave its slot busy for good. Three of them would now fill every
    // slot, and the fourth topic would never be asked for.
    const ids = ['11111111', '22222222', '33333333', '44444444'];
    const h = await open({ badJson: ids.slice(0, 3).map(url), replies: { [url(ids[3]!)]: snap(ids[3]!, [], `${ids[3]}.run.0`) } });
    await h.emit(
      sync(A, [], [A, ...ids], { topics: [row(A), ...ids.map((id, i) => row(id, { stage: 'answer', lastAt: 900 - i }))] })
    );
    await within('the fourth', 2000, () => fetched(h, ids[3]!));
  });

  it('starts again after requests that never come back', async () => {
    const ids = ['11111111', '22222222', '33333333', '44444444'];
    const h = await open({
      hang: ids.slice(0, 3).map(url),
      shortenLong: true,
      replies: { [url(ids[3]!)]: snap(ids[3]!, [], `${ids[3]}.run.0`) },
    });
    await h.emit(
      sync(A, [], [A, ...ids], { topics: [row(A), ...ids.map((id, i) => row(id, { stage: 'answer', lastAt: 900 - i }))] })
    );
    await within('the hung ones', 2000, () => asked(h).length >= 3);
    // The 60-second limit is 30 ms here: when it fires the request is aborted and the next starts.
    expect(h.longTimers).toContain(60000);
    await within('the next one', 2000, () => fetched(h, ids[3]!));
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

    // The echo moved the row: the copy the last page wrote is older than it.
    const echo = { ...message('w1', '<div class="raw">on its way</div>', true), nonce };
    const h = await open({
      url: `http://localhost:8787/?t=${A}`,
      idb: first.idb,
      storage,
      replies: { [url(B)]: snap(B, [echo], `${B}.run.1`) },
    });
    expect(h.el('log').textContent).not.toContain('on its way');
    await h.emit(sync(A, [], [A, B], { topics: [row(A), row(B, { stage: 'answer', last: `${B}.run.1` })] }));
    await within('the prefetch', 2000, () => fetched(h, B));
    await withinAsync('the copy', 2000, keptAt(h, B, `${B}.run.1`));

    await h.click(`[data-topic="${B}"]`);
    await until('B is painted from the cache', () => h.painted() === 1);
    expect(h.el('log').textContent).toContain('on its way');
    expect(h.el('log').textContent).not.toContain('Not confirmed');
    expect(h.window.localStorage.getItem('aa_unsent')).toBeNull();
  });

  it('says a send the last page left unsure never arrived once the replay after the copy is over', async () => {
    // The copy is older than the send — fetched before it was made — so its silence proves
    // nothing. The copy and the replay after it are the whole room, though: once the replay is
    // over and neither carried the echo, the same daemon never got it.
    const list = [row(A), row(B, { stage: 'answer', last: `${B}.run.1` })];
    const fetchFirst = await open({ replies: { [url(B)]: snap(B, [message('w1', '<p>before</p>')], `${B}.run.1`) } });
    await fetchFirst.emit(sync(A, [], [A, B], { topics: list }));
    await withinAsync('the copy', 2000, kept(fetchFirst, B));
    const idb = fetchFirst.idb;
    fetchFirst.window.close();

    const sender = await open({ url: `http://localhost:8787/?t=${A}`, idb, hang: ['api/send'] });
    await sender.emit(sync(A, [], [A, B], { topics: list }));
    await sender.click(`[data-topic="${B}"]`);
    await opens(sender, `api/events?t=${B}&last=${encodeURIComponent(`${B}.run.1`)}`);
    await sender.emit({ t: 'resumed' });
    (sender.el('input') as HTMLTextAreaElement).value = 'did it land';
    await sender.click('#composer button[type="submit"]');
    const storage = { aa_unsent: sender.window.localStorage.getItem('aa_unsent')! };
    sender.window.close();

    const h = await open({ url: `http://localhost:8787/?t=${A}`, idb, storage });
    await h.emit(sync(A, [], [A, B], { topics: list }));
    await h.click(`[data-topic="${B}"]`);
    await until('B is painted from the cache', () => (h.el('log').textContent ?? '').includes('before'));
    expect(h.live().url).toContain('&last=');
    // Not judged on the copy alone.
    expect(h.el('log').textContent).toContain('Not confirmed');

    await h.emit({ t: 'resumed' });
    expect(h.el('log').textContent).toContain('Not delivered');
  });
});

describe('webui page: coming back to a topic', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  /** Eight other topics: visiting them all takes A out of memory, which keeps the eight most recent. */
  const OTHERS = ['10000001', '10000002', '10000003', '10000004', '10000005', '10000006', '10000007', '10000008'];
  const passThrough = async (h: Harness, all: string[]): Promise<void> => {
    for (const id of OTHERS) {
      await h.click(`[data-topic="${id}"]`);
      await h.emit(sync(id, [message(`${id}-1`, '<p>elsewhere</p>')], all));
    }
  };

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

    // Put back as soon as the copy has painted — not a moment later, when the sync lands, which
    // would be a visible jump from wherever it was painted first.
    await until('A is painted from its copy', () => h.painted() === 20);
    expect(onTop(log)).toEqual({ text: 'line 8', hidden: 30 });

    await h.emit(sync(A, lines(20), [A, B]));
    expect(onTop(log)).toEqual({ text: 'line 8', hidden: 30 });
  });

  it('finds that message again when the sync puts older ones above it', async () => {
    // The database keeps a topic's tail within its byte budget, so a topic of long answers comes
    // back from it short and the sync then adds the head of it — above the message being read.
    // Restoring a scrollTop would land rows off; this is the reason the view is a message. Each
    // line here is 12K characters, so 210 of them are over the 2M budget and the record keeps the
    // last 157 — read back once eight other topics have taken A's place in memory.
    const pad = `<!--${'x'.repeat(12_000)}-->`;
    const long = lines(210).map((m) => ({ ...m, html: `${m.html as string}${pad}` }));
    const all = [A, B, ...OTHERS];
    const h = await open();
    const log = layout(h);
    await h.emit(sync(A, long, all));
    log.scrollTop = 100 * ROW + 30;
    expect(onTop(log).text).toBe('line 101');

    await passThrough(h, all);
    await h.click(`[data-topic="${A}"]`);
    await until('A is painted from the database', () => h.painted() === 157);
    expect(onTop(log)).toEqual({ text: 'line 101', hidden: 30 });

    await h.emit(sync(A, long, all));
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
    await until('A is painted from its copy', () => h.painted() === 20);

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
    await until('A is painted from its copy', () => h.painted() === 20);

    // Between the copy and the sync: the transcript is on screen and is being read.
    log.scrollTop = 200;
    await h.emit(sync(A, lines(20), [A, B]));
    expect(log.scrollTop).toBe(200);
  });

  it('keeps the place in a topic flicked through before it loaded, with no copy to paint it', async () => {
    // With no IndexedDB and A gone from memory, a topic shows placeholders until its sync — and
    // leaving it then must not be read as "left at the bottom", or passing through on the way
    // somewhere else forgets it.
    const all = [A, B, ...OTHERS];
    const h = await open({ idb: null });
    const log = layout(h);
    await h.emit(sync(A, lines(20), all));
    log.scrollTop = 730;

    await passThrough(h, all);
    await h.click(`[data-topic="${A}"]`);
    expect(h.skeletons()).toBeGreaterThan(0);
    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);

    await h.emit(sync(A, lines(20), all));
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
