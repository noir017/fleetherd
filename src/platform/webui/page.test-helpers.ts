/**
 * The page as a browser assembles it, for tests: the shell `page.ts` renders, with the script and
 * the stylesheet it links put back inline.
 *
 * Since Phase 1 Step 1A (docs/refactor-plan.md) the served page carries neither: it links
 * `assets/app-<hash>.js` and `assets/style-<hash>.css`, which `scripts/build-webui-assets.mjs`
 * writes into `dist/webui-assets/`. CI runs the tests without that build, and jsdom fetches no
 * subresource anyway, so they are built here — by the same `buildClient()` the asset build calls —
 * and spliced in where the shell links them. A page that renders nothing still fails the DOM tests.
 *
 * Two forms of the same page:
 *   - `built` (`pageOf`, which `open()` loads): the bundle and stylesheet exactly as the build
 *     writes them. This is what the DOM tests run.
 *   - `source` (`renderPage` / `servePage`, the default): the script and stylesheet as they are
 *     written in `client/`, markers filled. esbuild reprints both, so a test that pins a CSS rule
 *     or a line of script *as text* — most of page.test.ts, and the `@media` slicing the webui
 *     README recommends over the CSSOM — reads this one.
 * Both share the shell, so they share its build hash: `servePage(...).build` is the BUILD of the
 * page `open()` loaded with the same flags.
 *
 * Built once per worker: the suite runs with `isolate: false`, so this module and its top-level
 * awaits are evaluated once and shared by every test file the worker runs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { appSource, buildClient, STYLE_ENTRY } from '../../../scripts/webui-client.mjs';
import { servePage as serveShell, type PageAssets } from './page.js';

function readStyleSource(entry: string): string {
  const dir = path.dirname(entry);
  return fs.readFileSync(entry, 'utf8').replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_, rel: string) =>
    readStyleSource(path.resolve(dir, rel))
  );
}

/** The script and stylesheet as the asset build makes them. */
export const CLIENT = await buildClient();
/** The script as written in `client/legacy-app.ts`, with its build-time markers filled. */
export const APP_SOURCE = await appSource();
/** The stylesheet as written under `client/styles/`, with `@import`s expanded in cascade order. */
export const STYLE_SOURCE = readStyleSource(STYLE_ENTRY);

const APP_URL = `assets/${CLIENT.app.file}`;
const BOOT_URL = `assets/${CLIENT.boot.file}`;
const STYLE_URL = `assets/${CLIENT.style.file}`;

/** What a test page links: the real build's two names, and whichever code view the test chose. */
export function testAssets(codeview: string | null = null): PageAssets {
  return { app: APP_URL, boot: BOOT_URL, style: STYLE_URL, codeview };
}

/**
 * Put the linked files back as `<style>` and `<script>`. Replaced with functions, because the
 * script is full of `$` and a string replacement would read `$&` and friends as patterns.
 * `css: null` leaves an empty `<style>`: jsdom's CSS parser is ~43% of a page's cost, and most
 * tests do not look at styles.
 */
function inline(html: string, js: string, bootJs: string, css: string | null): string {
  const link = `<link rel="stylesheet" href="${STYLE_URL}">`;
  const bootTag = `<script src="${BOOT_URL}"></script>`;
  const tag = `<script src="${APP_URL}"></script>`;
  if (!html.includes(link) || !html.includes(bootTag) || !html.includes(tag)) {
    throw new Error('the page does not link the built scripts and stylesheet');
  }
  return html
    .replace(bootTag, () => `<script>${bootJs}</script>`)
    .replace(link, () => `<style>${css ?? ''}</style>`)
    .replace(tag, () => `<script>${js}</script>`);
}

/**
 * `page.ts` servePage, with the old positional signature the tests were written against (the code
 * view's URL fifth), and the page's own script and stylesheet inline. See the header for `as`.
 */
export function servePage(
  title: string,
  terminal: boolean,
  password = true,
  terminalEnd = false,
  codeview: string | null = null,
  files = false,
  instructions = false,
  opts: { as?: 'source' | 'built'; styles?: boolean; instance?: string } = {}
): { html: string; build: string } {
  const { as = 'source', styles = true, instance = 'web' } = opts;
  const shell = serveShell(title, terminal, password, terminalEnd, testAssets(codeview), files, instructions, instance);
  const js = as === 'built' ? CLIENT.app.text : APP_SOURCE;
  const css = !styles ? null : as === 'built' ? CLIENT.style.text : STYLE_SOURCE;
  return { html: inline(shell.html, js, CLIENT.boot.text, css), build: shell.build };
}

/** `servePage(...).html`. */
export function renderPage(
  title: string,
  terminal: boolean,
  password = true,
  terminalEnd = false,
  codeview: string | null = null,
  files = false,
  instructions = false
): string {
  return servePage(title, terminal, password, terminalEnd, codeview, files, instructions).html;
}
