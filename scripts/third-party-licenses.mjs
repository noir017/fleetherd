// The licences of the packages the code view bundles, as one text file.
//
// The bundle is minified, and CodeMirror's packages keep their licence in a LICENSE file rather
// than in header comments — so nothing survives minification, and the npm tarball carries only
// this project's own LICENSE. MIT requires the notice to travel with the copy, so the build
// collects the licence of every package that actually contributed a module to the bundle and
// writes it beside the chunks as `licenses.txt`.
//
// Which packages those are is not a guess: esbuild's metafile lists every input file, and these
// helpers reduce that list to the package directories under `node_modules/` and read their
// licence files. Pure enough to test without a build — `third-party-licenses.test.mjs` does.
import fs from 'node:fs';
import path from 'node:path';

/** Names in a package directory that hold its licence, in the order we prefer them. */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/**
 * The package directory one bundled input file belongs to, as written in a metafile path.
 *
 * The LAST `node_modules/` is the one that counts: a nested dependency
 * (`node_modules/a/node_modules/b/…`) belongs to `b`, whose licence may differ from the hoisted
 * copy. Returns undefined for anything that is not inside a package.
 */
export function packageDirOf(input) {
  const at = input.replaceAll('\\', '/').lastIndexOf('node_modules/');
  if (at < 0) return undefined;
  const rest = input.slice(at + 'node_modules/'.length).split('/');
  const name = rest[0]?.startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
  if (!name || rest.length < 2) return undefined;
  return input.slice(0, at + 'node_modules/'.length) + name;
}

/** One package's licence file, or undefined when it ships none. */
function licenceOf(dir, name, readdir, readFile) {
  let names;
  try {
    names = readdir(dir);
  } catch {
    return undefined;
  }
  const hit = names.filter((n) => LICENSE_FILE.test(n)).sort()[0];
  if (!hit) return undefined;
  try {
    return { name, dir, file: hit, text: readFile(path.join(dir, hit), 'utf8') };
  } catch {
    return undefined;
  }
}

/**
 * Every distinct package named by `inputs`, with its licence. Sorted, so the file is the same on
 * every machine. A package with no licence file is reported by name and left out — that is a fact
 * about the dependency, and the build prints it rather than pretending.
 */
export function collectLicenses(inputs, { readdir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  const dirs = new Set();
  for (const input of inputs) {
    const dir = packageDirOf(input);
    if (dir) dirs.add(dir);
  }
  const licenses = [];
  const missing = [];
  for (const dir of [...dirs].sort()) {
    const name = dir.slice(dir.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const found = licenceOf(dir, name, readdir, readFile);
    if (found) licenses.push(found);
    else missing.push(name);
  }
  licenses.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
  return { licenses, missing };
}

/**
 * Why a build must stop, or null when it may go on.
 *
 * A package with no licence file is not a warning: the bundle is redistributed, and shipping it
 * without that package's notice is exactly what this file exists to prevent. Every missing name
 * is reported at once, because fixing them one build at a time helps nobody.
 */
export function licenseFailure({ licenses, missing }) {
  if (missing.length > 0) {
    return `no licence file in ${missing.join(', ')} — the bundle would carry them without a notice`;
  }
  if (licenses.length === 0) return 'no third-party licence found — the bundle would ship without notices';
  return null;
}

/** The file's text. Each licence keeps its own wording and copyright line, untouched. */
export function renderLicenses(licenses) {
  const rule = '='.repeat(80);
  const head = [
    'Third-party licences for the JavaScript in this directory.',
    '',
    'These packages are bundled into the web UI\'s code view. Their notices travel with the',
    'bytes they cover; this project\'s own licence is the LICENSE at the root of the package.',
    '',
  ];
  const blocks = licenses.map((l) => {
    // The nested case carries its path, because two copies of one package can hold two licences.
    const where = l.dir === `node_modules/${l.name}` ? '' : ` — ${l.dir}`;
    return `${rule}\n${l.name}${where} (${l.file})\n${rule}\n\n${l.text.trimEnd()}\n`;
  });
  return `${head.join('\n')}\n${blocks.join('\n')}`;
}
