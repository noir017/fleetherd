/**
 * What `npm run release` does to CHANGELOG.md before it stamps a version.
 *
 * Two guards for the file that causes the most merge trouble. A release refuses to run while a
 * conflict marker is still in it, and it folds a repeated subsection heading under
 * `## [Unreleased]` into one — the shape a merge of two branches that both added entries tends to
 * leave behind, and one Keep a Changelog does not want in a published section.
 *
 * The incident behind the marker check: on 2026-11-11 a conflict-resolution script failed, later
 * commands ran anyway, and a CHANGELOG with `<<<<<<<` in it reached main. The release is the last
 * gate before such a file becomes a tag.
 */

/** Lines only a merge conflict produces: `<<<<<<<`, `=======`, `>>>>>>>` at the start of a line. */
export function conflictMarkers(text) {
  return /^(?:<{7}|={7}|>{7})(?: |$)/m.test(text);
}

/**
 * Fold duplicate `### <name>` subsections in one body into the first of each name: same order as
 * first appearance, contents concatenated with one blank line between them. Text before the first
 * `###` is left alone, and a body with no duplicates is returned byte for byte.
 *
 * A `###` inside a fenced code block is content, not a heading — an entry that quotes markdown
 * must not be split or merged by it.
 */
export function mergeSubsections(body, eol = '\n') {
  const lines = body.split(eol);
  const preamble = [];
  const sections = [];
  let current = null;
  let fence = null;
  const put = (line) => (current ? current.lines : preamble).push(line);
  for (const line of lines) {
    if (fence) {
      put(line);
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      put(line);
      continue;
    }
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) {
      current = { heading: heading[1], lines: [] };
      sections.push(current);
    } else {
      put(line);
    }
  }

  const counts = new Map();
  for (const section of sections) counts.set(section.heading, (counts.get(section.heading) ?? 0) + 1);
  if (![...counts.values()].some((n) => n > 1)) return body;

  const trimmed = (lines) => {
    const out = [...lines];
    while (out.length > 0 && out[0].trim() === '') out.shift();
    while (out.length > 0 && out.at(-1).trim() === '') out.pop();
    return out;
  };

  const merged = [];
  const byHeading = new Map();
  for (const section of sections) {
    const first = byHeading.get(section.heading);
    if (!first) {
      const copy = { heading: section.heading, lines: trimmed(section.lines) };
      byHeading.set(section.heading, copy);
      merged.push(copy);
      continue;
    }
    const incoming = trimmed(section.lines);
    if (first.lines.length > 0 && incoming.length > 0) first.lines.push('');
    first.lines.push(...incoming);
  }

  // One blank line between sections and at the end, which is the shape the file already uses;
  // only the merged body is rewritten, so a changelog without duplicates is untouched.
  const out = trimmed(preamble);
  if (out.length > 0) out.push('');
  for (const section of merged) {
    out.push(`### ${section.heading}`);
    if (section.lines.length > 0) out.push('', ...section.lines);
    out.push('');
  }
  return out.join(eol) + eol;
}
