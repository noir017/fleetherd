/**
 * The page: one HTML shell, linking the script and stylesheet the asset build made.
 *
 * ── Why this is a TypeScript string and not an .html file ────────────────────
 * `npm run build` compiles this with tsc, and `package.json`'s `files` ships only `dist` and the
 * skills. A `.html` under `src/` is silently ignored by tsc: it would not reach `dist/`, would not
 * reach the npm tarball, and the daemon would 500 in production while working perfectly from
 * `tsx src/cli.ts` in development. Shipping it as a module makes dev and prod the same code
 * path. The markup is `page-body.ts`, for the same reason.
 *
 * ── Where the script and the stylesheet went ─────────────────────────────────
 * Until Phase 1 Step 1A (docs/refactor-plan.md) both were inline here. They now live in
 * `client/` — `legacy-app.ts` and `styles/main.css`, moved as they were — and are bundled by
 * `scripts/build-webui-assets.mjs` into `dist/webui-assets/` with content-hashed names, which this
 * page links by the names `assets.ts` read from the build's manifest. With no inline script left,
 * the CSP's `script-src` is `'self'` alone (server.ts PAGE_HEADERS).
 *
 * What the server decides per deployment — terminal, files, instructions, which gate, the code
 * view's bundle, the page's build — used to be spliced into the script's text. It is now a JSON
 * document in `<script type="application/json" id="boot-config">`, which no browser executes and
 * so no CSP has to allow, read once by the script.
 *
 * The script is still the part of this repo the toolchain cannot see — not typechecked, not
 * linted — so it is still kept deliberately stupid. Every decision that could live in TypeScript
 * does: markdown becomes HTML in `web-markdown.ts`, the message shape is fixed in `protocol.ts`,
 * button ids are formed in `core/button-id.ts`. If a change there needs a new *decision*, that
 * decision belongs on this side of the wire.
 *
 * `title` comes from config and is interpolated into `<title>`. It is escaped, because otherwise
 * a `title:` in config.yaml is stored XSS on the operator's own page.
 *
 * ── The look ─────────────────────────────────────────────────────────────────
 * Dark, and only dark — no toggle, no light palette, no `prefers-color-scheme`. One palette
 * is the smallest thing that satisfies "dark by default", and a theme switch is exactly the
 * kind of feature that makes a page memorable. Nothing is loaded from anywhere else: no fonts,
 * no CDN, no favicon request. Every byte the page uses is one this daemon serves.
 */
import { createHash } from 'node:crypto';

import { escapeHtml } from '../web-markdown.js';
import { PAGE_BODY } from './page-body.js';

/**
 * What the page links, each relative to the page (`assets/<file>`) or null when this daemon has no
 * built assets. One value because they are one decision, made by the same build: the names carry
 * content hashes, and a page that guessed a fixed name would cache a stale bundle under the new
 * page's ETag. Relative, like every other URL on the page, so a sub-path mount resolves them under
 * its prefix.
 */
export interface PageAssets {
  /** The page's own script. Without it the page says it was not built, instead of the gate. */
  app: string | null;
  /** The synchronous theme boot script linked in <head> before first paint. */
  boot?: string | null;
  /** The page's stylesheet. */
  style: string | null;
  /** The code view's entry module, imported on demand by the script's `codeView()`. */
  codeview: string | null;
}

/** A daemon whose assets were never built (a source checkout without `npm run build:assets`). */
export const NO_ASSETS: PageAssets = { app: null, boot: null, style: null, codeview: null };

/**
 * Fill in the configured title, whether the terminal pane exists, and whether a session can be
 * ended from it.
 *
 * All three are baked into the document rather than announced over the event stream because
 * they are properties of the daemon, not of a conversation: none can change while the page is
 * open, and a control that appears one sync later is a control that flickers into existence.
 */
export function renderPage(
  title: string,
  terminal: boolean,
  password = true,
  terminalEnd = false,
  assets: PageAssets = NO_ASSETS,
  files = false,
  instructions = false,
  instance = 'web'
): string {
  return servePage(title, terminal, password, terminalEnd, assets, files, instructions, instance).html;
}

/**
 * The page, and the build it carries: a hash of everything it was rendered from.
 *
 * The same hash is the page's ETag (`server.ts` servedPage) and `BUILD` inside its script, which
 * is how a page left open through a restart can tell whether the daemon it reconnected to would
 * serve it a different page (`checkBuild`): the server's answer to a HEAD names its ETag, and the
 * page compares it with its own. Hashed with the placeholder in place, so the stamp is not part of
 * what it stamps. The script and stylesheet are in it by name, and their names are content hashes,
 * so a change to either is still a new build.
 */
export function servePage(
  title: string,
  terminal: boolean,
  password = true,
  terminalEnd = false,
  assets: PageAssets = NO_ASSETS,
  files = false,
  /** Whether the settings page offers the instruction editor (`platforms.<id>.instructions`). */
  instructions = false,
  /** This web UI's platform instance id (`platforms.<id>`), used to format `<id>:main/<topic>` refs. */
  instance = 'web'
): { html: string; build: string } {
  const boot = bootConfig({
    terminal,
    terminalEnd,
    files,
    instructions,
    password,
    codeview: assets.codeview,
    instance,
    build: '__BUILD__',
  });
  const html = page({
    title: escapeHtml(title),
    bootScript: assets.boot == null ? '' : `<script src="${escapeHtml(assets.boot)}"></script>`,
    style: assets.style === null ? '' : `<link rel="stylesheet" href="${escapeHtml(assets.style)}">`,
    gate: (assets.app === null ? UNBUILT : '') + (password ? PASSWORD_GATE : SSO_GATE),
    boot,
    app: assets.app === null ? '' : `<script src="${escapeHtml(assets.app)}"></script>`,
  });
  const build = createHash('sha256').update(html).digest('base64url').slice(0, 27);
  // Global, as it always was: a title that happens to contain the placeholder is stamped too,
  // rather than taking the stamp the boot config needs.
  return { html: html.replace(/__BUILD__/g, build), build };
}

/**
 * The boot config as the text of a `<script type="application/json">`. The HTML parser ends that
 * element at the first `</script` whatever the JSON quoting says, so `<` is written as its JSON
 * escape `\u003c`, as `clientIcons()` does — `JSON.parse` reads it back as the same character.
 * Nothing in it is free text today (flags, the build, an `ASSET_FILE`-checked name); this keeps
 * that from mattering.
 */
function bootConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config).replace(/</g, '\\u003c');
}

/**
 * The two doors, and only ever one of them in the delivered page.
 *
 * Both are `#gate` wrapping `#login`, so every style rule and every reference in the script
 * is blind to which one it got — the only code that has to know is the submit handler.
 * Rendering both and hiding one in script was the other option, and it flashes a password box
 * at someone who has no password on every load.
 *
 * The SSO one has no field on purpose. When the proxy in front is the only way in there is no
 * secret that works, so a box asking for one turns "your session with the identity provider
 * expired" into "wrong token" — the two states a locked-out operator most needs to tell apart.
 * Reloading is what re-triggers the provider's sign-in, so that is the button.
 */
const PASSWORD_GATE = `<form id="gate" autocomplete="off"><div id="login">
<input id="secret" type="password" placeholder="Token" data-i18n-placeholder="gate.tokenPlaceholder" autocomplete="current-password" autofocus>
<button type="submit" data-i18n="gate.enter">Enter</button>
<p id="err"></p>
</div></form>`;

const SSO_GATE = `<form id="gate" autocomplete="off"><div id="login">
<p id="err" data-i18n="gate.ssoExpired">Not signed in. Your access session may have expired.</p>
<button type="submit" data-i18n="gate.reload">Reload</button>
</div></form>`;

/**
 * What a daemon with no built script serves above the gate. Without the script nothing on the page
 * works, and a login form that silently does nothing is the worst way to find that out; this is
 * the explicit degradation. Only a source checkout gets here — `npm run build` always builds the
 * assets, and release.yml checks the manifest names them.
 */
const UNBUILT = `<p id="unbuilt">This page's script was not built. Run <code>npm run build:assets</code> and restart fleetherd.</p>
`;

/** The document. A function rather than placeholders, so no part's text can be read as another's slot. */
function page(p: { title: string; bootScript: string; style: string; gate: string; boot: string; app: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${p.title}</title>
<!-- Installable as an app. Every href is relative for the same reason the fetches are: a
     reverse proxy may mount the daemon under a sub-path, and an absolute "/" walks out of it.
     No viewport-fit=cover, deliberately — it would extend the page under the status bar and
     the gesture bar, which is work the browser is already doing correctly, and the composer's
     env(safe-area-inset-bottom) padding is there for the browsers that inset nothing. -->
<link rel="manifest" href="manifest.webmanifest">
<!-- Android paints the status bar this colour in standalone, so the app starts at its own
     background instead of being framed in white. -->
<meta name="theme-color" content="#131313">
${p.bootScript}
<!-- iOS ignores the manifest for both of these. "black" is the closest opaque bar to #131313;
     "black-translucent" would put the clock on top of the chat header. -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<link rel="apple-touch-icon" href="icon.png">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="icon" href="icon.png" sizes="192x192" type="image/png">
${p.style}
</head>
<body>
${p.gate}
${PAGE_BODY}<script type="application/json" id="boot-config">${p.boot}</script>
${p.app}
</body>
</html>
`;
}
