// Build the web UI's assets into dist/webui-assets/ — part of `npm run build`, so the files
// reach `dist` and therefore the npm tarball (which ships `dist` only).
//
// Three entries, all served by `GET /assets/<file>` (src/platform/webui/server.ts):
//
//   - `app` and `style`: the page's own script and stylesheet (src/platform/webui/client/),
//     bundled by `webui-client.mjs` — the same function the test harness runs, so the tests and
//     the build cannot disagree about what the page is. They are linked from the page itself,
//     which is how its CSP can refuse every inline script.
//   - `codeview`: CodeMirror, bundled here as ES modules and loaded by the script's `codeView()` —
//     on demand, never with the page. Every language is a dynamic import in
//     src/platform/webui/codeview/index.ts, which esbuild turns into its own chunk: a browser
//     reading a `.go` file downloads the editor and the Go grammar, not the other sixteen.
//
// Names carry a content hash, so the route can answer `immutable` and a rebuilt asset is a new
// URL rather than a stale cache. The page finds all three through manifest.json, which is read by
// src/platform/webui/assets.ts at startup.
//
//   node scripts/build-webui-assets.mjs           build into dist/webui-assets/
//   npm run build                                 tsc, the Go binary, then this
//
// A source checkout started with `node --import tsx src/cli.ts start` needs one
// `npm run build:assets` first, and another after editing anything under client/: without one the
// page has no script and says so in place of the login form (page.ts), and the README says so.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { build } from 'esbuild';

import { collectLicenses, licenseFailure, renderLicenses } from './third-party-licenses.mjs';
import { buildClient } from './webui-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'webui-assets');
const entry = path.join(root, 'src', 'platform', 'webui', 'codeview', 'index.ts');

// Emptied first: a hash names content, so keeping last build's files would only grow the tarball
// with every release. Nothing here survives a rebuild by design.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: { codeview: entry },
  outdir: out,
  bundle: true,
  format: 'esm',
  // Required for `format: 'esm'` plus more than one output file: the language chunks are shared
  // by `import()`, and only a real ES module can name them.
  splitting: true,
  minify: true,
  target: ['es2022', 'chrome100', 'firefox100', 'safari15'],
  entryNames: 'codeview-[hash]',
  chunkNames: 'chunk-[hash]',
  assetNames: 'asset-[hash]',
  metafile: true,
  // Any licence comment a dependency does write into its source stays in the output. These
  // packages keep theirs in a LICENSE file instead, so the notices are collected below.
  legalComments: 'eof',
  logLevel: 'warning',
});

const outputs = Object.entries(result.metafile.outputs);
// Every dynamic-import chunk is an "entry point" to esbuild too, so the page's entry is found by
// the path it was built from rather than by having one.
const codeview = outputs.find(([, o]) => o.entryPoint !== undefined && path.resolve(root, o.entryPoint) === entry)?.[0];
if (!codeview) {
  console.error('build-webui-assets: esbuild produced no output for the code view entry');
  process.exit(1);
}
const entryName = path.basename(codeview);

// The page's own two files, into the same directory. They share nothing with the code view's
// chunks — a classic script and a stylesheet, not ES modules — so they are a separate esbuild run.
const client = await buildClient({ outdir: out });

fs.writeFileSync(
  path.join(out, 'manifest.json'),
  `${JSON.stringify({ app: client.app.file, style: client.style.file, codeview: entryName }, null, 2)}\n`,
  'utf8'
);

// MIT obligations that minification would otherwise erase: CodeMirror keeps its licence in a
// LICENSE file, not in header comments. Every package whose modules reached the bundle contributes
// its own text, verbatim, and the file ships beside the chunks (the npm tarball carries `dist`).
// release.yml only checks that the file exists; whether it says anything is decided here, where
// the inputs are known. A package with no licence file stops the build — redistributing its code
// without a notice is the one thing this file exists to prevent.
const { licenses, missing } = collectLicenses(Object.keys(result.metafile.inputs));
const failure = licenseFailure({ licenses, missing });
if (failure) {
  console.error(`build-webui-assets: ${failure}`);
  process.exit(1);
}
const licensesFile = path.join(out, 'licenses.txt');
fs.writeFileSync(licensesFile, renderLicenses(licenses), 'utf8');
// Read back what was written: a file that exists but says nothing is the failure this guards
// against, and the check has to see the bytes that actually landed in dist.
const written = fs.readFileSync(licensesFile, 'utf8');
if (!written.includes('@codemirror/state') || !/MIT/.test(written)) {
  console.error(`build-webui-assets: ${path.relative(root, licensesFile)} does not name the bundled CodeMirror packages`);
  process.exit(1);
}

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
let raw = 0;
let packed = 0;
const files = [
  ...outputs.sort(([, a], [, b]) => b.bytes - a.bytes).map(([file]) => path.resolve(root, file)),
  path.join(out, client.app.file),
  path.join(out, client.style.file),
];
for (const file of files) {
  const bytes = fs.readFileSync(file);
  const packedBytes = gzipSync(bytes, { level: 9 }).length;
  raw += bytes.length;
  packed += packedBytes;
  console.log(`build-webui-assets: ${path.basename(file)} ${kib(bytes.length)} (gzip ${kib(packedBytes)})`);
}
console.log(
  `build-webui-assets: ${files.length} files, ${kib(raw)} (gzip ${kib(packed)}); the page loads ${client.app.file} and ${client.style.file}, and ${entryName} only when it shows code`
);
console.log(`build-webui-assets: ${licenses.length} third-party licences in licenses.txt (${kib(fs.statSync(licensesFile).size)})`);
