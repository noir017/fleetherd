// The web UI's own script and stylesheet, as esbuild makes them — shared by the asset build
// (`build-webui-assets.mjs`, which writes them to dist/webui-assets/) and the test harness
// (`src/platform/webui/page.test-helpers.ts`, which runs the same bytes in jsdom). One function for
// both, so a page that works in the tests is the page the build ships.
//
// `app` is minified to keep the bundled client within the gzip budget; tests that assert on source
// text read the TypeScript source files directly rather than this output.
//
// No `target` either: nothing is lowered or prefixed, so what runs is what was written. The script
// is bundled as a classic IIFE (`format: 'iife'`), and `tsconfigRaw: {}` keeps esbuild from forcing
// `alwaysStrict` over the injected `CACHE_CORE` snippet.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webui = path.join(root, 'src', 'platform', 'webui');

/** The client script's source, with its two build-time markers still in it. */
export const APP_ENTRY = path.join(webui, 'client', 'main.ts');
/** The synchronous theme boot script linked in <head> before first paint. */
export const BOOT_ENTRY = path.join(webui, 'client', 'theme-boot.ts');
/** The stylesheet's source. */
export const STYLE_ENTRY = path.join(webui, 'client', 'styles', 'main.css');

const EXTRAS_SOURCE = [
  "export { createChangesPlugin } from './features/changes/index.js';",
  "export { createFilesPlugin } from './features/files/index.js';",
  "export { createHistoryPlugin } from './features/history/index.js';",
  "export { createPalettePlugin } from './features/palette/index.js';",
  "export { createReviewsPlugin } from './features/reviews/index.js';",
  "export { createSchedulesPlugin } from './features/schedules/index.js';",
  "export { createSettingsPlugin } from './features/settings/plugin.js';",
  "export { createSkillsPlugin } from './features/skills/index.js';",
  "export { initLocale, setLocale } from './i18n/index.js';",
].join('\n');

/**
 * What the script takes from TypeScript at build time: the icon table and the cache core. Both live
 * in modules the daemon also uses (icons.ts renders the markup, cache-script.ts is sw.ts's too), so
 * they are bundled for Node and evaluated here rather than copied. Neither has an import or touches
 * anything but its own constants, which is what makes evaluating them in-process harmless.
 */
async function clientInputs() {
  const out = await build({
    stdin: {
      contents: "export { clientIcons } from './icons.ts'; export { CACHE_CORE } from './cache-script.ts';",
      resolveDir: webui,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'inputs',
    platform: 'node',
    logLevel: 'warning',
  });
  const mod = new Function(`${out.outputFiles[0].text}; return inputs;`)();
  return { icons: mod.clientIcons(), cacheCore: mod.CACHE_CORE };
}

/** Put one value where its marker is; a marker that is missing or doubled stops the build. */
function fill(text, marker, value) {
  const parts = text.split(marker);
  if (parts.length !== 2) {
    throw new Error(`webui-client: ${path.relative(root, APP_ENTRY)} has ${parts.length - 1} of ${marker}, expected 1`);
  }
  return parts.join(value);
}

/** The client script as source, markers filled: what the page ran inline before Step 1A. */
export async function appSource() {
  const inputs = await clientInputs();
  let text = fs.readFileSync(APP_ENTRY, 'utf8');
  text = fill(text, '__FH_ICONS__', inputs.icons);
  text = fill(text, '__FH_CACHE_CORE__;', inputs.cacheCore);
  return text;
}

/** esbuild's [hash] is a content hash of its own; this one is the same idea for an in-memory output. */
const hashed = (prefix, ext, text) => `${prefix}-${createHash('sha256').update(text).digest('base64url').slice(0, 8)}${ext}`;

/**
 * Bundle the script and the stylesheet. Returns each one's content-hashed file name and text; with
 * `outdir`, also writes both there.
 *
 * Names are hashed here rather than by esbuild's `[hash]` so the two calls — the build's and the
 * tests' — name the same bytes the same way whether or not anything is written. `absWorkingDir`
 * pins the source-path comments esbuild writes into each output, which would otherwise follow the
 * directory the build was started from and change the hash with it.
 */
export async function buildClient({ outdir } = {}) {
  const source = await appSource();
  const common = { bundle: true, write: false, logLevel: 'warning', absWorkingDir: root, tsconfigRaw: {} };
  const extras = await build({
    ...common,
    stdin: {
      contents: EXTRAS_SOURCE,
      loader: 'ts',
      resolveDir: path.dirname(APP_ENTRY),
      sourcefile: 'workbench-extras.ts',
    },
    format: 'esm',
    minify: true,
    target: ['es2022', 'chrome100', 'firefox100', 'safari15'],
  });
  const extrasText = extras.outputFiles[0].text;
  const extrasFile = hashed('workbench-extras', '.js', extrasText);
  const app = await build({
    ...common,
    stdin: { contents: source, loader: 'ts', resolveDir: path.dirname(APP_ENTRY), sourcefile: path.basename(APP_ENTRY) },
    format: 'iife',
    minify: true,
    define: {
      __WEBUI_EXTRAS_ASSET__: JSON.stringify(outdir ? `assets/${extrasFile}` : null),
    },
  });
  const boot = await build({
    ...common,
    entryPoints: [BOOT_ENTRY],
    format: 'iife',
    minify: true,
  });
  // `outdir` only because esbuild wants one to name a CSS output; nothing is written by this call.
  const style = await build({ ...common, entryPoints: [STYLE_ENTRY], outdir: path.join(root, 'dist', 'webui-assets') });
  const appText = app.outputFiles[0].text;
  const bootText = boot.outputFiles[0].text;
  const styleText = style.outputFiles[0].text;
  const result = {
    app: { file: hashed('app', '.js', appText), text: appText },
    boot: { file: hashed('boot', '.js', bootText), text: bootText },
    style: { file: hashed('style', '.css', styleText), text: styleText },
    extras: { file: extrasFile, text: extrasText },
  };
  if (outdir) {
    for (const { file, text } of [result.app, result.boot, result.style, result.extras]) {
      fs.writeFileSync(path.join(outdir, file), text, 'utf8');
    }
  }
  return result;
}
