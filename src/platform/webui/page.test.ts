import { describe, it, expect } from 'vitest';

import { renderPage } from './page.js';

/**
 * The inline script is the one artifact in this repo the toolchain cannot see: it is not
 * typechecked, not linted and not unit-tested, because to TypeScript it is a string. These
 * assertions are the substitute — they will not catch a logic error, but they catch the two
 * failures that would otherwise reach a browser: a syntax error, and a character the
 * surrounding template literal swallowed.
 */
function scriptOf(html: string): string {
  return html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
}

describe('webui page', () => {
  const html = renderPage('Chat', false);

  it('emits a client script that actually parses', () => {
    // `new Function` compiles the body without running it, which is exactly the check wanted:
    // a stray brace or a broken string literal throws here instead of producing a page that
    // renders and then does nothing at all.
    expect(() => new Function(scriptOf(html))).not.toThrow();
  });

  it('contains no backtick and no ${, which the template literal would have eaten', () => {
    // Not style: a literal `${` in the client code is read by TypeScript as part of THIS
    // file's template, so it becomes a module-load-time ReferenceError — the daemon fails to
    // start, pointing at a string. The script therefore concatenates rather than interpolates.
    expect(html).not.toContain('`');
    expect(html).not.toContain('${');
  });

  it('loads nothing from anywhere', () => {
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/);
    expect(html).not.toContain('//cdn');
    expect(html).not.toContain('fonts.googleapis');
  });

  it('asks for everything by a relative path, so a reverse proxy sub-path just works', () => {
    expect(html).toContain("EventSource('api/events'");
    expect(html).not.toMatch(/fetch\('\//);
    expect(html).toContain("post('api/send'");
    // The app-install tags are subject to the same rule — an absolute href walks out of a
    // sub-path mount, and the symptom is an installed app that opens on the proxy's root.
    expect(html).toContain('href="manifest.webmanifest"');
    expect(html).not.toMatch(/href="\/(manifest|icon)/);
  });

  it('carries what a phone needs to install it as an app', () => {
    expect(html).toContain('rel="manifest"');
    // Android colours the status bar with this in standalone; iOS reads neither the manifest
    // nor theme-color and needs its own three.
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
    expect(html).toContain('rel="apple-touch-icon"');
    // iOS has never accepted SVG for apple-touch-icon, so the PNG has to exist and be the one
    // that link points at.
    expect(html).toMatch(/rel="apple-touch-icon" href="icon\.png"/);
  });

  it('does not claim a viewport it has not laid out for', () => {
    // viewport-fit=cover extends the page under the status bar and the gesture bar. The layout
    // pads for the bottom one and nothing pads for the top, so turning it on would put the
    // clock over the chat header. Left off deliberately; this is the reminder. Matched against
    // the tag rather than the whole document, which also mentions it in a comment.
    const meta = html.match(/<meta name="viewport" content="([^"]*)"/)?.[1];
    expect(meta).toBe('width=device-width,initial-scale=1');
  });

  it('escapes the configured title', () => {
    const evil = renderPage('</title><script>alert(1)</script>', false);
    expect(evil).not.toContain('<script>alert(1)</script>');
    expect(scriptOf(evil)).not.toContain('alert(1)');
  });

  it('has a collapsible topic sidebar with running indicators and unread badges', () => {
    expect(html).toContain('id="topics"');
    expect(html).toContain('id="sidebar"');
    expect(html).toContain('#sidebar.collapsed');
    expect(html).toContain('id="collapse-sidebar"');
    expect(html).toContain('id="expand-sidebar"');
    expect(html).toContain('data-topic=');
    expect(html).toContain('data-new=');
    expect(html).toContain('topic-badge');
    expect(html).toContain('topic-dot');
    expect(html).toContain('.topic-item.idle');
    expect(html).toContain('.topic-item.running');
  });

  it('fades the agent tag with its row instead of pinning it to one grey', () => {
    // A fixed #6b7683 was tuned against an idle title and read as disabled beside the
    // #dcdcdc/#fff of a running or selected one. Inheriting the title's colour keeps the tag
    // one step below whichever state the row is in. Asserted as text: jsdom resolves neither
    // opacity blending nor an inherited colour from a class rule.
    expect(html).toContain('.topic-tag{color:inherit;opacity:');
    expect(html).not.toMatch(/\.topic-tag\{color:#/);
  });

  it('has a scheduled-task panel of its own, opened from the chat header', () => {
    // A column, not a row in the topic list: a task is not a conversation, and the sidebar is
    // the conversation switcher. Opening it is remembered; a first visit starts closed.
    expect(html).toContain('id="schedules"');
    expect(html).toContain('id="schedules-toggle"');
    expect(html).toContain('api/schedules');
    expect(html).toContain('api/schedules/op');
    expect(html).toContain('aa_sched_open');
    expect(html).not.toContain('aa_sched_pin');
    expect(html).not.toContain('schedules-pin');
    // The same panel component as the sidebar, on the right: one set of rules, not two.
    expect(html).toContain('class="panel panel-right"');
    expect(html).toContain('.panel-left.collapsed{margin-left:calc(-1 * var(--pw,var(--pw-default)))}');
    expect(html).toContain('.panel-right.collapsed{margin-right:calc(-1 * var(--pw,var(--pw-default)))}');
    // The heading is words, not a clock glyph.
    expect(html).toContain('<span class="panel-title">Side tasks</span>');
    // Two top-level tabs at the foot (Scheduled and Reviews), with Scheduled subdivided into Tasks and Sessions.
    expect(html).toContain('id="sched-tabs"');
    expect(html).toContain('id="sched-tab-scheduled"');
    expect(html).toContain('id="sched-tab-reviews"');
    expect(html).toContain('id="sched-subnav"');
    expect(html).toContain('id="sched-tab-tasks"');
    expect(html).toContain('id="sched-tab-sessions"');
    expect(html).toContain('id="sched-sessions"');
    expect(html).toContain('id="sched-reviews"');
    expect(html.indexOf('id="sched-subnav"')).toBeLessThan(html.indexOf('id="schedules-body"'));
    expect(html.indexOf('id="schedules-body"')).toBeLessThan(html.indexOf('id="sched-tabs"'));
    expect(html.indexOf('id="sched-tab-scheduled"')).toBeLessThan(html.indexOf('id="sched-tab-reviews"'));
    expect(html.indexOf('id="sched-tab-tasks"')).toBeLessThan(html.indexOf('id="sched-tab-sessions"'));
    // Narrower than the old fixed column, and the operator can drag it.
    expect(html).toContain('clamp(240px,20vw,320px)');
    expect(html).toContain('id="sched-resize"');
    expect(html).toContain('aa_sched_w');
  });

  it('sends a nonce, without which its own retry would double-post', () => {
    expect(html).toContain('nonce:');
  });

  it('makes the hidden attribute actually hide', () => {
    // #app and #hints both carry `display:` in an id rule, which outranks the browser's own
    // [hidden]{display:none} — without this the chat pane is on screen before login.
    expect(html).toContain('[hidden]{display:none!important}');
  });

  it('ships one dark palette and no way to switch it', () => {
    // "Dark by default" plus "no extra features" has one smallest answer, and a theme toggle
    // is exactly the sort of thing that makes a page memorable.
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).toMatch(/--bg:#1[0-9a-f]{5}/);
  });

  it('gives your own messages a tinted panel the agent does not get', () => {
    // Asserted as text: jsdom resolves no custom property, so the CSSOM would report an empty
    // background for a rule that is perfectly correct in a browser.
    expect(html).toMatch(/--own:#[0-9a-f]{6}/);
    expect(html).toContain('.m.own{background:var(--own)');
    // One side marked is what makes the boundary findable; marking both moves the problem.
    expect(html).not.toContain('.m:not(.own){background:');
  });

  it('lays out the unrendered operator message so its own line breaks survive', () => {
    // room.ts escapes that text instead of rendering it, which leaves the newlines as the only
    // structure it has — collapsed by default HTML whitespace into one run-on line.
    expect(html).toContain('.b .raw{white-space:pre-wrap');
  });

  it('takes a file off the clipboard and names it before it can collide', () => {
    expect(html).toContain("addEventListener('paste'");
    expect(html).toContain('getAsFile()');
    // Every engine calls a pasted screenshot image.png.
    expect(html).toContain("'pasted-'");
  });

  it('styles scrollbars to blend with the dark background', () => {
    expect(html).toContain('color-scheme:dark');
    expect(html).toContain('scrollbar-color:');
    expect(html).toContain('scrollbar-width:thin');
    expect(html).toContain('::-webkit-scrollbar');
    expect(html).toContain('::-webkit-scrollbar-thumb');
  });

  it('allows deleting topics with an inline delete button and confirmation', () => {
    expect(html).toContain('topic-del');
    expect(html).toContain('data-del=');
    expect(html).toContain('api/topics/delete');
  });

  it('caches topic messages in browser storage for instant switching', () => {
    expect(html).toContain('aa_cache');
    // IndexedDB, not localStorage: a transcript with code blocks in it runs to hundreds of
    // kilobytes and the ~5MB there is shared with everything else this origin keeps.
    expect(html).toContain('indexedDB');
    expect(html).toContain('MAX_CACHE_TOPICS');
    expect(html).toContain('MAX_CACHE_MSGS');
    expect(html).toContain('MAX_CACHE_BYTES');
  });

  it('shows a message the moment it is typed, and keeps one that failed to send', () => {
    // The local bubble and its three ways out. `page.dom.test.ts` is what proves they work;
    // this only proves the markup that carries them survived the template.
    expect(html).toContain('data-retry=');
    expect(html).toContain('data-copy=');
    expect(html).toContain('data-discard=');
    expect(html).toContain('Not delivered');
  });

  it('accepts the sync for a topic it did not name', () => {
    // A visit with no ?t= starts with topic === '', and the server answers by picking a topic
    // for the client — so a bare `ev.topic !== topic` drops the only sync that visit will ever
    // get and the page stays an empty shell with a healthy event stream behind it. The guard
    // must only fire once we are actually on a topic.
    expect(html).toContain('if(topic && ev.topic !== topic) return;');
  });

  it('adapts to a screen held upright', () => {
    expect(html).toContain('@media(max-width:640px)');
    // The drawer needs something to tap beside itself, or the only way out on a phone is the
    // one button it covers half the screen to show.
    expect(html).toContain('id="backdrop"');
    // dvh, not vh: the mobile URL bar is counted by the latter and not by the former, and the
    // difference is whether the composer is on screen.
    expect(html).toContain('100dvh');
    // Under 16px, Safari zooms the page in on focus and never zooms back out.
    expect(html).toContain('#input,#secret{font-size:16px}');
    // The Send row belongs above the home indicator, not under it.
    expect(html).toContain('env(safe-area-inset-bottom');
    // On handsets the composer wraps onto two rows to keep the input box full-width.
    expect(html).toContain('#row{flex-wrap:wrap}');
    expect(html).toContain('#input{width:100%;flex:0 0 100%}');
  });
});
