/**
 * The page's built assets: one directory of content-hashed files, and the names of the three the
 * page refers to — its own script and stylesheet, and the code view's entry module.
 *
 * They are built by `scripts/build-webui-assets.mjs` into `dist/webui-assets/` — part of
 * `npm run build`, so they reach `dist` and therefore the npm tarball, which ships `dist` only.
 * The page carries no inline script or style of its own any more (the CSP refuses inline scripts),
 * so this is where every script the page runs is served from.
 *
 * ── Nothing here is a path from the browser ─────────────────────────────────
 * The file name is a single path segment, checked against `ASSET_FILE`, and the resolved parent
 * must still be this directory. A name that is not a file in the directory is a 404 before
 * anything is read — there is no route by which `..` or a second segment reaches `readFile`.
 *
 * A daemon whose assets were never built (a source checkout without `npm run build:assets`)
 * answers 404 for `/assets/` and serves a page whose names are all null: the page then says it was
 * not built in place of its login form, and the code view degrades to the plain `<pre>`. That is
 * why a missing directory is not an error here: it is handled where the page is rendered.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WebAssets {
  /** Absolute path of the directory holding the built files. */
  dir: string;
  /** The page's own script (`app-<hash>.js`), relative to `dir`; null when nothing was built. */
  app: string | null;
  /** The page's stylesheet (`style-<hash>.css`), relative to `dir`; null when nothing was built. */
  style: string | null;
  /** The entry module the code view imports, relative to `dir`; null when nothing was built. */
  codeview: string | null;
}

/**
 * One script or stylesheet name, no directory part. Leading dots are refused so a name can never be
 * `.` or `..`, and `%` so an encoded separator stays a name that simply does not exist. The
 * extension is checked because the route answers with the type the extension names and nothing
 * else: a file that is neither is not an asset this route may hand over.
 */
export const ASSET_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css)$/;

/**
 * Where the build wrote them. The same expression in both layouts this file runs in: `tsx` from
 * `src/platform/webui/`, and `dist/platform/webui/` in the published package — three levels up
 * is the project (or package) root either way.
 */
export function assetDir(): string {
  return fileURLToPath(new URL('../../../dist/webui-assets/', import.meta.url));
}

/** One manifest entry, if it names a file this route would serve; anything else is "not built". */
function entry(manifest: Record<string, unknown>, key: string): string | null {
  const value = manifest[key];
  return typeof value === 'string' && ASSET_FILE.test(value) ? value : null;
}

/** Read the build's manifest. A missing or malformed one means "not built", never a crash. */
export function loadAssets(dir: string = assetDir()): WebAssets {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    return { dir, app: entry(manifest, 'app'), style: entry(manifest, 'style'), codeview: entry(manifest, 'codeview') };
  } catch {
    return { dir, app: null, style: null, codeview: null };
  }
}
