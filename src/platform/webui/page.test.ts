import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NO_ASSETS, servePage as serveShell } from './page.js';
import { APP_SOURCE, CLIENT, renderPage, testAssets } from './page.test-helpers.js';

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'client');
const BOOT_SOURCE = fs.readFileSync(path.join(clientDir, 'services', 'boot.ts'), 'utf8');
const STREAM_SOURCE = fs.readFileSync(path.join(clientDir, 'services', 'stream.ts'), 'utf8');
const CACHE_SOURCE = fs.readFileSync(path.join(clientDir, 'services', 'cache.ts'), 'utf8');
const READS_SOURCE = fs.readFileSync(path.join(clientDir, 'services', 'reads.ts'), 'utf8');
const READER_SOURCE = fs.readFileSync(path.join(clientDir, 'features', 'reader', 'index.ts'), 'utf8');
const LEGACY_SHELL_SOURCE = fs.readFileSync(path.join(clientDir, 'workbench', 'legacy-shell.ts'), 'utf8');
const COMPOSER_ATTACHMENTS_SOURCE = fs.readFileSync(
  path.join(clientDir, 'features', 'topic', 'composer', 'attachments.ts'),
  'utf8',
);
const COMPOSER_UNSENT_SOURCE = fs.readFileSync(
  path.join(clientDir, 'features', 'topic', 'composer', 'unsent.ts'),
  'utf8',
);

/**
 * The client script is the one artifact in this repo the toolchain cannot see: it is not
 * typechecked and not linted (client/legacy-app.ts is left out of both until the refactor plan's
 * later steps). These assertions are the substitute — they will not catch a logic error, but they
 * catch what would otherwise reach a browser: a syntax error, a build marker left unfilled, and a
 * page that can no longer run under its own CSP.
 *
 * `html` is the page with its script and stylesheet inline as they are written (page.test-helpers.ts),
 * which is what the text assertions below read; `shell` is the document the server actually sends.
 */
const bootOf = (doc: string): Record<string, unknown> => {
  const json = /<script type="application\/json" id="boot-config">([^<]*)<\/script>/.exec(doc)?.[1];
  if (json === undefined) throw new Error('no boot-config element');
  return JSON.parse(json) as Record<string, unknown>;
};

describe('webui page', () => {
  const html = renderPage('Chat', false);
  const shell = serveShell('Chat', false, true, false, testAssets()).html;

  it('emits a client script that actually parses, with every build marker filled', () => {
    // `new Function` compiles the bundled IIFE without running it, catching a stray brace or
    // broken literal before it reaches a browser. APP_SOURCE uses ES imports for split panels.
    expect(() => new Function(CLIENT.app.text)).not.toThrow();
    expect(() => new Function(CLIENT.boot.text)).not.toThrow();
    // An unfilled marker is a ReferenceError the moment the script starts.
    expect(CLIENT.app.text).not.toMatch(/__FH_[A-Z_]+__/);
    expect(APP_SOURCE).not.toMatch(/__FH_[A-Z_]+__/);
  });

  it('carries no inline script, so the CSP can refuse every one', () => {
    // server.ts serves the page with `script-src 'self'` and no 'unsafe-inline': an inline script
    // or handler here would simply not run. The one inline <script> is data, which no browser
    // executes.
    const scripts = [...shell.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? '');
    expect(scripts).toEqual([
      ` src="assets/${CLIENT.boot.file}"`,
      ' type="application/json" id="boot-config"',
      ` src="assets/${CLIENT.app.file}"`,
    ]);
    expect(shell).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
    expect(shell).not.toContain('javascript:');
  });

  it('links its script and stylesheet by a path a sub-path mount still resolves', () => {
    expect(shell).toContain(`<link rel="stylesheet" href="assets/${CLIENT.style.file}">`);
    expect(shell).toContain(`<script src="assets/${CLIENT.boot.file}"></script>`);
    expect(shell).toContain(`<script src="assets/${CLIENT.app.file}"></script>`);
    // Relative, like api/events and manifest.webmanifest: an absolute /assets/ would leave a proxy
    // prefix behind and 404 the whole page.
    expect(shell).not.toMatch(/(?:src|href)="\/assets\//);
    // The data comes before the script that reads it.
    expect(shell.indexOf('id="boot-config"')).toBeLessThan(shell.indexOf(`src="assets/${CLIENT.app.file}"`));
    // The anti-FOUC boot script sits in <head> after theme-color so it runs before first paint.
    expect(shell.indexOf('name="theme-color"')).toBeLessThan(shell.indexOf(`src="assets/${CLIENT.boot.file}"`));
    expect(shell.indexOf(`src="assets/${CLIENT.boot.file}"`)).toBeLessThan(shell.indexOf('</head>'));
  });

  it('contains no backtick and no ${ in the markup, which the template literal would have eaten', () => {
    // Not style: the shell and the body are still TypeScript templates (page.ts, page-body.ts), and
    // a literal `${` in them is read as part of the template — a module-load-time ReferenceError,
    // the daemon failing to start while pointing at a string.
    expect(shell).not.toContain('`');
    expect(shell).not.toContain('${');
  });

  it('hands the script what the server decided as JSON, and the page its build', () => {
   const { html: page, build } = serveShell('Chat', true, false, true, testAssets(), true, true);
   expect(bootOf(page)).toEqual({
     terminal: true,
     terminalEnd: true,
     files: true,
     instructions: true,
     password: false,
     codeview: null,
      instance: 'web',
     build,
   });
    expect(bootOf(shell)).toMatchObject({ terminal: false, terminalEnd: false, files: false, instructions: false, password: true, instance: 'web' });
    const custom = serveShell('Chat', false, true, false, testAssets(), false, false, 'portal').html;
    expect(bootOf(custom).instance).toBe('portal');
   expect(APP_SOURCE).toContain('var BOOT = readBootConfig(document);');
   expect(BOOT_SOURCE).toContain("getElementById('boot-config')");
 });

  it('cannot be broken out of through the boot config', () => {
    // Nothing in it is free text today; this pins that if one ever is, `</script>` stays inside.
    const hostile = 'assets/</script><script>alert(1)</script>';
    const page = serveShell('Chat', false, true, false, { ...testAssets(), codeview: hostile }).html;
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(bootOf(page).codeview).toBe(hostile);
  });

  it('loads its code view on demand, not with the page', () => {
    // The bundle is an ES module under assets/, imported the first time a file needs it — never a
    // script element of the page's, so a page that never shows code never downloads the editor, and
    // a build with no code view (null) still has a complete page.
    expect(READER_SOURCE).toContain('__fhCodeView');
    expect(READER_SOURCE).toContain('new URL(bundleUrl, doc.baseURI).href');
    expect(APP_SOURCE).toContain('createCodeViewLoader(BOOT.codeview)');
    expect(shell).not.toContain('codeview-');
  });

  it('carries the built bundle when it is handed one, by a path a sub-path mount still resolves', () => {
    const built = serveShell('Chat', false, true, false, testAssets('assets/codeview-abc123.js')).html;
    expect(bootOf(built).codeview).toBe('assets/codeview-abc123.js');
  });

  it('says it was not built, instead of serving a login form that does nothing', () => {
    // A source checkout without `npm run build:assets`: no script, so nothing on the page works.
    const bare = serveShell('Chat', false, true, false, NO_ASSETS).html;
    expect(bare).toContain('id="unbuilt"');
    expect(bare).toContain('npm run build:assets');
    expect(bare).not.toContain('<script src=');
    expect(bare).not.toContain('rel="stylesheet"');
    expect(shell).not.toContain('id="unbuilt"');
  });

  it('loads nothing from anywhere', () => {
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/);
    expect(html).not.toContain('//cdn');
    expect(html).not.toContain('fonts.googleapis');
  });

  it('asks for everything by a relative path, so a reverse proxy sub-path just works', () => {
    expect(STREAM_SOURCE).toContain('`api/events');
    expect(STREAM_SOURCE).toContain('new EventSource(url)');
    expect(html).not.toMatch(/fetch\('\//);
    expect(COMPOSER_UNSENT_SOURCE).toContain("postFn('api/send'");
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
    const evil = serveShell('</title><script>alert(1)</script>', false, true, false, testAssets()).html;
    expect(evil).not.toContain('<script>alert(1)</script>');
    expect(evil).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    // The script is a file every deployment shares; the title never reaches it.
    expect(JSON.stringify(bootOf(evil))).not.toContain('alert(1)');
  });

  it('has a collapsible topic sidebar with running indicators and unread badges', () => {
    expect(html).toContain('id="topics"');
    expect(html).toContain('id="sidebar"');
    expect(html).toContain('#sidebar.collapsed');
    expect(html).toContain('id="collapse-sidebar"');
    expect(html).toContain('id="expand-sidebar"');
    // The rows' attribute is a parameter of the shared row (treeRowHtml); the handlers read it.
    expect(html).toContain("closest('[data-topic]')");
    expect(html).toContain('data-new=');
    expect(html).toContain('topic-badge');
    expect(html).toContain('topic-dot');
    expect(html).toContain('.topic-item.idle');
    expect(html).toContain('.topic-item.running');
  });

  it('draws the agent legend on the frame line, in its harness colour, with no grey of its own per state', () => {
    // The legend sits on the row's top border. Its background is split at that line — what is
    // behind the row above, the row's own colour below — so the border reads as broken by the name,
    // and it follows hover, the selected row and the green needs-you rows through --row-bg.
    // Asserted as text: jsdom computes no gradient, no custom property and no color-mix.
    expect(html).toContain('background:linear-gradient(to bottom,var(--behind,var(--bg-panel)) 50%,var(--row-bg) 50%)');
    expect(html).toContain('.agent-tag{position:absolute;top:-7px;left:7px;');
    // One palette for the agent cards' dots and the legend: a harness colour is written once.
    expect(html).toContain('.ac-dot.h-claude,.agent-tag.h-claude{--hc:var(--hc-claude)}');
    expect(html).toContain('.ac-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--hc,var(--hc-dot-fallback))}');
    expect(html).not.toMatch(/\.ac-dot\.h-[a-z]+\{background:/);
    // The selected row's legend is a step brighter, mixed from the same colour rather than a second palette.
    expect(html).toContain('.topic-item.on .agent-tag{color:color-mix(in srgb,var(--hc,var(--hc-fallback)) 72%,var(--mix-hi))}');
    expect(html).not.toContain('.topic-tag');
  });

  it('has a scheduled-task panel of its own, opened from the chat header', () => {
    // A column, not a row in the topic list: a task is not a conversation, and the sidebar is
    // the conversation switcher. Opening it is remembered; a first visit starts closed.
    expect(html).toContain('id="schedules"');
    expect(html).toContain('id="schedules-toggle"');
    expect(CLIENT.app.text).toContain('api/schedules');
    expect(CLIENT.app.text).toContain('api/schedules/op');
    expect(LEGACY_SHELL_SOURCE).toContain('aa_sched_open');
    expect(html).not.toContain('aa_sched_pin');
    expect(html).not.toContain('schedules-pin');
    // The same panel component as the sidebar, on the right: one set of rules, not two.
    expect(html).toContain('class="panel panel-right"');
    expect(html).toContain('.panel-left.collapsed{margin-left:calc(-1 * var(--pw,var(--pw-default)))}');
    expect(html).toContain('.panel-right.collapsed{margin-right:calc(-1 * var(--pw,var(--pw-default)))}');
    // The heading is words, not a clock glyph.
    expect(html).toContain('<span class="panel-title" data-i18n="sideTasks.title">Side tasks</span>');
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
    expect(LEGACY_SHELL_SOURCE).toContain('aa_sched_w');
  });

  it('sends a nonce, without which its own retry would double-post', () => {
    expect(COMPOSER_UNSENT_SOURCE).toContain('nonce');
  });

  it('makes the hidden attribute actually hide', () => {
    // #app and #hints both carry `display:` in an id rule, which outranks the browser's own
    // [hidden]{display:none} — without this the chat pane is on screen before login.
    expect(html).toContain('[hidden]{display:none!important}');
  });

  it('defines semantic dark and light palettes with zero-JS system fallback', () => {
    expect(html).toContain(':root,[data-theme="dark"]{');
    expect(html).toContain('[data-theme="light"]{');
    expect(html).toContain('@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){');
    expect(html).toContain('color-scheme:dark');
    expect(html).toContain('color-scheme:light');
    expect(html).toMatch(/--fh-bg:#1[0-9a-f]{5}/);
    expect(html).toContain('--bg:var(--fh-bg)');
    expect(html).toContain('id="theme-toggle"');
  });

  it('gives your own messages a tinted panel the agent does not get', () => {
    // Asserted as text: jsdom resolves no custom property, so the CSSOM would report an empty
    // background for a rule that is perfectly correct in a browser.
    expect(html).toMatch(/--fh-own:#[0-9a-f]{6}/);
    expect(html).toContain('--own:var(--fh-own)');
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
    expect(COMPOSER_ATTACHMENTS_SOURCE).toContain("'paste'");
    expect(COMPOSER_ATTACHMENTS_SOURCE).toContain('getAsFile()');
    // Every engine calls a pasted screenshot image.png.
    expect(COMPOSER_ATTACHMENTS_SOURCE).toContain('pasted-');
  });

  it('styles scrollbars to blend with the dark background', () => {
    expect(html).toContain('color-scheme:dark');
    expect(html).toContain('scrollbar-color:');
    expect(html).toContain('scrollbar-width:thin');
    expect(html).toContain('::-webkit-scrollbar');
    expect(html).toContain('::-webkit-scrollbar-thumb');
  });

  it('allows deleting topics from the row menu, with its confirmation', () => {
    expect(html).toContain('row-menu');
    expect(html).toContain("key:'delete'");
    expect(html).toContain('api/topics/delete');
  });

  it('caches topic messages in browser storage for instant switching', () => {
    expect(html).toContain('aa_cache');
    // IndexedDB, not localStorage: a transcript with code blocks in it runs to hundreds of
    // kilobytes and the ~5MB there is shared with everything else this origin keeps.
    expect(html).toContain('indexedDB');
    expect(CACHE_SOURCE).toContain('indexedDB');
    expect(html).toContain('MAX_CACHE_TOPICS');
    expect(html).toContain('MAX_CACHE_MSGS');
    expect(html).toContain('MAX_CACHE_BYTES');
    expect(READS_SOURCE).toContain('aa_reads');
  });

  it('shows a message the moment it is typed, and keeps one that failed to send', () => {
    // The local bubble and its three ways out. `page.dom.*.test.ts` is what proves they work;
    // this only proves the markup that carries them survived the template.
    expect(html).toContain('data-retry=');
    expect(html).toContain('data-copy=');
    expect(html).toContain('data-discard=');
    expect(CLIENT.app.text).toContain('Not delivered');
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
