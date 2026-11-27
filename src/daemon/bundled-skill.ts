import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';
import { libraryLine } from '../ipc/tools.js';
import { listTree } from './skill-copy.js';
import { SkillLibrary } from './skill-library.js';

/**
 * The bundled `fleetherd` skill as an agent's harness lists it: the package's `skill/` with the
 * library line (ipc/tools.ts libraryLine) at the end of its frontmatter description.
 *
 * The same line ends the `skills` tool's description, but only Claude Code reads a tool description
 * before the first turn; codex, opencode, agy and CodeBuddy list skills, not deferred MCP tools, so
 * the skill list is where they can see a library name before they start. Rendered per skill
 * directory, not per agent: `.agents/skills` is read by codex and opencode alike, and one link there
 * can point at one copy — so the line names what reaches every harness reading that directory.
 *
 * The package's own file is never written: the rendered copy goes to a directory of the gateway's
 * (skill-link.ts bundledSkillProvision, locally and on a host), with every other file of the skill beside it.
 */

/** The Agent Skills specification's longest description. Past it: counts, then no line at all. */
export const DESCRIPTION_MAX = 1024;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const FOLD_WIDTH = 96;

/** One directory's copy: where it goes (`key`), what it holds, and a digest to skip an unchanged write. */
export interface RenderedSkill {
  key: string;
  files: Map<string, Buffer>;
  digest: string;
}

/** The library the line is read from: the gateway's own skills, cached by their stamp. */
const bundledLibrary = new SkillLibrary();
let libraryWarned = false;

/**
 * The skill at `source`, with its SKILL.md carrying the library skills that reach every harness in
 * `readers` on `host`. A library that cannot be read leaves the description as shipped.
 */
export function renderBundledSkill(
  source: string,
  host: string,
  readers: readonly string[],
  library: Pick<SkillLibrary, 'categories'> = bundledLibrary
): RenderedSkill {
  const files = new Map<string, Buffer>();
  for (const rel of listTree(source).sort()) files.set(rel, fs.readFileSync(path.join(source, ...rel.split('/'))));
  const md = files.get('SKILL.md');
  if (md) {
    let categories: unknown;
    try {
      categories = library.categories(...readers.map((harness) => ({ host, harness })));
    } catch (e) {
      if (!libraryWarned) console.warn('[skill] could not read the skill library; the fleetherd skill names none of it:', e instanceof Error ? e.message : e);
      libraryWarned = true;
    }
    if (categories !== undefined) files.set('SKILL.md', Buffer.from(withLibraryLine(md.toString('utf8'), categories), 'utf8'));
  }
  const hash = createHash('sha256');
  for (const [rel, data] of files) hash.update(`${rel}\0${data.length}\0`).update(data);
  return { key: readers.length ? readers.join('+') : 'all', files, digest: hash.digest('hex') };
}

/**
 * `md` with the library line at the end of its description: the names when they fit within
 * DESCRIPTION_MAX, the counts when only those do, and `md` itself when the library has nothing for
 * these readers or neither fits.
 */
export function withLibraryLine(md: string, categories: unknown): string {
  for (const line of new Set([libraryLine(categories), libraryLine(categories, 0)])) {
    if (!line) continue;
    const out = appendToDescription(md, line);
    if (out !== undefined) return out;
  }
  return md;
}

/**
 * `md` with ` <line>` appended to its frontmatter `description`, rewritten as a `>-` folded block
 * (which needs no escaping), or undefined when that cannot be done safely: no frontmatter, a
 * description that is not a string, a result over DESCRIPTION_MAX, or a rewrite that a YAML parser
 * does not read back as exactly the same frontmatter with only the description changed.
 */
export function appendToDescription(md: string, line: string): string | undefined {
  const m = FRONTMATTER.exec(md);
  if (!m) return undefined;
  const fm = m[1]!;
  const before = yamlMap(fm);
  if (!before || typeof before.description !== 'string') return undefined;
  const description = `${before.description} ${line}`.split(/\s+/).filter(Boolean).join(' ');
  if ([...description].length > DESCRIPTION_MAX) return undefined;

  const eol = fm.includes('\r\n') ? '\r\n' : '\n';
  const lines = fm.split(/\r?\n/);
  const start = lines.findIndex((l) => /^description\s*:/.test(l));
  if (start < 0) return undefined;
  // The entry runs on through its indented (or blank) continuation lines; blank ones at its end
  // separate it from the next key and stay.
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]!) || lines[end] === '')) end++;
  while (end > start + 1 && lines[end - 1] === '') end--;
  const rewritten = [...lines.slice(0, start), 'description: >-', ...fold(description), ...lines.slice(end)].join(eol);

  const open = m[0].indexOf('\n') + 1;
  const out = md.slice(0, open) + rewritten + md.slice(open + fm.length);
  const after = yamlMap(rewritten);
  if (FRONTMATTER.exec(out)?.[1] !== rewritten || !after || after.description !== description) return undefined;
  const { description: _was, ...restBefore } = before;
  const { description: _is, ...restAfter } = after;
  return isDeepStrictEqual(restBefore, restAfter) ? out : undefined;
}

/** A frontmatter as a YAML parser reads it, or undefined when it is not a clean mapping. */
function yamlMap(text: string): Record<string, unknown> | undefined {
  try {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) return undefined;
    const v: unknown = doc.toJS();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Words onto two-space-indented lines of a folded block; folding joins them back with one space. */
function fold(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && current.length + 1 + word.length > FOLD_WIDTH) {
      out.push(`  ${current}`);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) out.push(`  ${current}`);
  return out;
}
