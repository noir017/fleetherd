import { describe, it, expect } from 'vitest';
import {
  renderPage,
  tick,
  until,
  opens,
  sync,
  message,
  face,
  open,
  rowMenu,
  type Harness,
} from './page.dom.test-helpers.js';

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
    const h = await open({ width: 1440, height: 900, styles: true });
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

  it('gives a code block\'s Wrap and Copy a finger-sized target on a phone, and only there', () => {
    expect(narrowBlock()).toContain('.cb-b{width:36px;height:32px;font-size:16px}');
    // The desktop rule is the pointer's 26px; the phone's must not leak out of the block.
    const outside = renderPage('Chat', false).replace(narrowBlock(), '');
    expect(outside).not.toContain('.cb-b{width:36px');
    expect(outside).toContain('width:26px;height:24px');
  });

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

  it('enlarges the panel header icons on phones to match header glyphs', () => {
    const css = narrowBlock();
    expect(css).toContain('#clear-topics svg,#read-topics svg,#sched-read svg,#sched-new svg{width:18px;height:18px}');
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

  it('opens from a row without switching topic, with its actions in it', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });

    await rowMenu(h, D);
    const menu = h.el('row-menu');
    expect(menu.hidden).toBe(false);
    expect(menu.getAttribute('role')).toBe('menu');
    expect(h.el('topics').contains(menu)).toBe(false);
    await opens(h, `api/events?t=${A}`);
    expect(h.doc.querySelector(`[data-rm="topic:${D}"]`)?.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual([
      'Star',
      'Copy reference',
      'Fork',
      'End agent',
      'Delete topic',
    ]);
    // An icon from IC, never an emoji.
    expect(menu.querySelector('[data-rmk="star"] .ic-star')).not.toBeNull();
    expect(menu.querySelector('[data-rmk="copy"] .ic-copy')).not.toBeNull();
    expect(menu.querySelector('[data-rmk="fork"] .ic-fork')).not.toBeNull();
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
    // Star, Copy reference, Fork, End agent (disabled), Delete topic.
    items[0]!.focus();
    press('ArrowDown');
    expect(h.doc.activeElement).toBe(items[1]);
    press('ArrowDown');
    expect(h.doc.activeElement).toBe(items[2]);
    press('ArrowDown');
    expect(h.doc.activeElement).toBe(items[4]);
    press('ArrowDown');
    expect(h.doc.activeElement).toBe(items[0]);
    press('ArrowUp');
    expect(h.doc.activeElement).toBe(items[4]);
    press('Home');
    expect(h.doc.activeElement).toBe(items[0]);
    press('End');
    expect(h.doc.activeElement).toBe(items[4]);
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

  it('omits Fork when the bound agent declares no fork support, and keeps it otherwise', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: fleet({
        [A]: { agent: { id: 'gt', harness: 'custom', canFork: false } },
        [D]: { agent: { id: 'cc', harness: 'claude', canFork: true } },
      }),
    });

    await rowMenu(h, A);
    expect(h.doc.querySelector('[data-rmk="fork"]')).toBeNull();
    expect(Array.from(h.doc.querySelectorAll('#row-menu [role="menuitem"]')).map((b) => b.textContent)).toEqual([
      'Star',
      'Copy reference',
      'End agent + 2 sub-agents',
      'Delete topic',
    ]);

    await rowMenu(h, D);
    expect(h.doc.querySelector('[data-rmk="fork"]')?.textContent).toBe('Fork');
  });

  it('copies the topic title and id from the row menu and the chat header', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet({ [D]: { title: '[cc] Fix login CSS' } }) });

    await rowMenu(h, D);
    await h.click('[data-rmk="copy"]');
    await tick();
    expect(h.clipboard).toEqual([`[cc] Fix login CSS (web:main/${D})`]);
    expect(h.el('note').textContent).toContain(`web:main/${D}`);
    expect(h.el('row-menu').hidden).toBe(true);
    // Copying another row does not switch the open topic.
    expect(h.window.location.search).toBe(`?t=${A}`);

    const hdrCopy = h.el('copy-ref');
    expect(hdrCopy.hidden).toBe(false);
    await h.click('#copy-ref');
    await tick();
    expect(h.clipboard).toEqual([
      `[cc] Fix login CSS (web:main/${D})`,
      `parent (web:main/${A})`,
    ]);
    expect(hdrCopy.querySelector('.ic-check')).not.toBeNull();
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

  /**
   * jsdom has no layout, so the boxes the panel is measured against are given here: the chat, the
   * header and the composer above it, and the divider. Desktop proportions, so the heights below
   * are the ones a person would see: 800 tall, 50 header, 100 composer, 9 divider, 120 transcript
   * left over — a panel may be 521 at most.
   */
  const laidOut = (h: Harness): void => {
    const stub = (id: string, prop: string, value: number): void => {
      Object.defineProperty(h.el(id), prop, { configurable: true, get: () => value });
    };
    stub('chat', 'clientHeight', 800);
    stub('chat-header', 'clientHeight', 50);
    stub('bar', 'clientHeight', 100);
    stub('term-grip', 'offsetHeight', 9);
  };

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
    expect(h.el('term').hasAttribute('inert')).toBe(false);

    await h.click('#term-min');
    expect(h.el('chat').className).not.toContain('term');
    expect(h.window.location.search).toBe('?t=a1b2c3d4');
    expect(frames(h)).toHaveLength(1);
    expect(shown(h)).toBeNull();
    // Parked means out of reach as well as out of sight: a hidden iframe can still take focus
    // from script, and a terminal that grabs it is typing going somewhere nobody can see.
    expect(h.el('term').hasAttribute('inert')).toBe(true);
    expect(frames(h)[0]?.hasAttribute('inert')).toBe(true);

    // Back in, and it is the same element — not a second connection to the same session.
    await h.click('#term-toggle');
    expect(shown(h)).toBe(mounted);
    expect(h.el('term').hasAttribute('inert')).toBe(false);
    expect(frames(h)[0]?.hasAttribute('inert')).toBe(false);
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

  it('docks the panel under the conversation instead of covering it', async () => {
    // What changed: the terminal used to swap itself in for the transcript and the composer.
    // The panel now sits at the bottom of #chat, under both, so reading and typing carry on
    // while it is open — and the divider above it is the only thing that moves.
    const h = await open({ terminal: true });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hi</p>')], ['a1b2c3d4']));
    await h.click('#term-toggle');

    expect(h.el('chat').className).toContain('term');
    const ids = [...h.el('chat').children].map((el) => el.id);
    expect(ids.indexOf('term')).toBeGreaterThan(ids.indexOf('bar'));
    expect(ids.indexOf('term-grip')).toBe(ids.indexOf('term') - 1);
    // The transcript is not hidden by the terminal's class any more, and it is still painted.
    expect(renderPage('Chat', true)).not.toContain('#chat.term #log');
    expect(h.painted()).toBe(1);
  });

  it('parks a closed panel rather than taking the frame out of the layout', async () => {
    // The bug this fixes: display:none leaves an iframe with no box, and a browser may discard a
    // frame it is not laying out — which closes its WebSocket, so a topic switch looked like a
    // dropped connection. Asserted as text, since jsdom does not evaluate the stylesheet.
    const css = renderPage('Chat', true);
    expect(css).toContain(
      '#chat:not(.term) #term{position:absolute;left:0;right:0;bottom:0;visibility:hidden;pointer-events:none}'
    );
    expect(css).toContain('#term-frames iframe{position:absolute;inset:0;width:100%;height:100%;border:0;visibility:hidden}');
    expect(css).not.toContain('#term-frames iframe{display:none');
    // And the other half of that pair: the shown frame really is visible, and the divider is
    // only on screen while the panel is. Deleting either rule used to leave every test green.
    expect(css).toContain('#term-frames iframe.on{visibility:visible}');
    expect(css).toContain('#chat.term #term-grip{display:block}');
  });

  it('opens at half the chat, and a drag on the divider is the height it keeps', async () => {
    const h = await open({ terminal: true });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    laidOut(h);
    await h.click('#term-toggle');
    expect(h.el('term').style.height).toBe('400px');

    const grip = h.el('term-grip');
    grip.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, clientY: 500 }));
    grip.dispatchEvent(new h.window.MouseEvent('pointermove', { bubbles: true, clientY: 400 }));
    grip.dispatchEvent(new h.window.MouseEvent('pointerup', { bubbles: true, clientY: 400 }));
    expect(h.el('term').style.height).toBe('500px');
    expect(h.window.localStorage.getItem('aa_term_h')).toBe('500');

    // Clamped both ways: the transcript keeps a few lines above, and the panel stays usable.
    grip.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, clientY: 500 }));
    grip.dispatchEvent(new h.window.MouseEvent('pointermove', { bubbles: true, clientY: 0 }));
    grip.dispatchEvent(new h.window.MouseEvent('pointerup', { bubbles: true, clientY: 0 }));
    expect(h.el('term').style.height).toBe('521px');
    grip.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, clientY: 0 }));
    grip.dispatchEvent(new h.window.MouseEvent('pointermove', { bubbles: true, clientY: 800 }));
    grip.dispatchEvent(new h.window.MouseEvent('pointerup', { bubbles: true, clientY: 800 }));
    expect(h.el('term').style.height).toBe('120px');
  });

  it('comes back at the height it was left, across a reload', async () => {
    const h = await open({ terminal: true, storage: { aa_term_h: '512' } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    laidOut(h);
    await h.click('#term-toggle');
    expect(h.el('term').style.height).toBe('512px');
  });

  it('answers a double-click and the arrow keys, so the divider is not only a drag target', async () => {
    const h = await open({ terminal: true, storage: { aa_term_h: '400' } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    laidOut(h);
    await h.click('#term-toggle');

    const grip = h.el('term-grip');
    grip.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(h.el('term').style.height).toBe('424px');
    grip.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    grip.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(h.el('term').style.height).toBe('376px');

    grip.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
    expect(h.el('term').style.height).toBe('400px');
    expect(h.window.localStorage.getItem('aa_term_h')).toBeNull();
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

  it('fills the composer input with cleaned dictation when /api/voice/transcribe is configured', async () => {
    const h = await open({
      mic: { types: ['audio/webm;codecs=opus'] },
      replies: {
        'api/voice/transcribe': {
          ok: true,
          text: '那个帮我重启一下服务',
          cleaned: '帮我重启一下服务。',
          model: 'groq-whisper-large-v3-turbo',
          latencyMs: 1200,
        },
      },
    });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = '前缀';
    await h.click('#mic');
    await tick();
    h.recorders[0]!.feed('opus-bytes');
    await h.click('#mic');
    await until('dictation fills composer', () => input.value.includes('帮我重启一下服务。'));

    expect(input.value).toBe('前缀 帮我重启一下服务。');
    expect(sends(h)).toHaveLength(0);
    expect(h.el('note').textContent).toContain('1.2s');
    expect(h.el('note').textContent).toContain('那个帮我重启一下服务');
  });

  it('shows a no-speech notice without sending when dictation hears nothing', async () => {
    const h = await open({
      mic: { types: ['audio/webm;codecs=opus'] },
      replies: {
        'api/voice/transcribe': { ok: false, reason: 'no speech recognized', noSpeech: true },
      },
    });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.click('#mic');
    await tick();
    h.recorders[0]!.feed('silence');
    await h.click('#mic');
    await until('no-speech note shown', () => (h.el('note').textContent ?? '').includes('No speech'));
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('');
    expect(sends(h)).toHaveLength(0);
  });

  it('transcodes WebM recordings to 16kHz mono WAV when Web Audio API is available', async () => {
    const h = await open({
      mic: { types: ['audio/webm;codecs=opus'] },
      replies: {
        'api/voice/transcribe': { ok: true, text: '测试', model: 'whisper', latencyMs: 500 },
      },
    });
    const w = h.window as unknown as Record<string, unknown>;
    w['AudioContext'] = class {
      async decodeAudioData() {
        return { duration: 0.01 };
      }
      close() {}
    };
    w['OfflineAudioContext'] = class {
      destination = {};
      constructor(public ch: number, public frames: number, public sampleRate: number) {}
      createBufferSource() {
        return { buffer: null, connect() {}, start() {} };
      }
      async startRendering() {
        return { sampleRate: 16000, getChannelData: () => new Float32Array([0, 0.5, -0.5, 0]) };
      }
    };
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.click('#mic');
    await tick();
    h.recorders[0]!.feed('fake-webm');
    await h.click('#mic');
    await until('transcribe called', () => h.calls.some((c) => c.path === 'api/voice/transcribe'));
    const call = h.calls.find((c) => c.path === 'api/voice/transcribe')!;
    const body = call.body as { mime: string; data: string };
    expect(body.mime).toBe('audio/wav');
    const raw = Buffer.from(body.data, 'base64');
    expect(raw.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(raw.subarray(8, 12).toString('ascii')).toBe('WAVE');
  });
});
