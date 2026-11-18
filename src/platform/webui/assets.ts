/**
 * The page's built assets: one directory of content-hashed ES modules, and the name of the entry
 * the page imports.
 *
 * They are built by `scripts/build-webui-assets.mjs` into `dist/webui-assets/` — part of
 * `npm run build`, so they reach `dist` and therefore the npm tarball, which ships `dist` only.
 * The page's inline script cannot hold a syntax-highlighting editor, and the CSP allows no
 * origin but this one, so this is the one place a script is served from disk.
 *
 * ── Nothing here is a path from the browser ─────────────────────────────────
 * The file name is a single path segment, checked against `ASSET_FILE`, and the resolved parent
 * must still be this directory. A name that is not a file in the directory is a 404 before
 * anything is read — there is no route by which `..` or a second segment reaches `readFile`.
 *
 * A daemon whose assets were never built (a source checkout without `npm run build:assets`)
 * answers 404 for `/assets/` and serves a page whose `CODEVIEW` is null, which the reader
 * degrades to the plain `<pre>` it has always shown. That is why a missing directory is not an
 * error here: it is handled where the page is rendered.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WebAssets {
  /** Absolute path of the directory holding the built files. */
  dir: string;
  /** The entry module the page imports, relative to `dir`; null when nothing was built. */
  codeview: string | null;
}

/**
 * One JavaScript file name, no directory part. Leading dots are refused so a name can never be
 * `.` or `..`, and `%` so an encoded separator stays a name that simply does not exist. The
 * extension is checked because the route answers `text/javascript` and nothing else: a file that
 * is not a module is not an asset this route may hand over under that type.
 */
export const ASSET_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;

/**
 * Where the build wrote them. The same expression in both layouts this file runs in: `tsx` from
 * `src/platform/webui/`, and `dist/platform/webui/` in the published package — three levels up
 * is the project (or package) root either way.
 */
export function assetDir(): string {
  return fileURLToPath(new URL('../../../dist/webui-assets/', import.meta.url));
}

/** Read the build's manifest. A missing or malformed one means "not built", never a crash. */
export function loadAssets(dir: string = assetDir()): WebAssets {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      codeview?: unknown;
    };
    const codeview = typeof manifest.codeview === 'string' && ASSET_FILE.test(manifest.codeview) ? manifest.codeview : null;
    return { dir, codeview };
  } catch {
    return { dir, codeview: null };
  }
}
