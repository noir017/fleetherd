// CommonMark → clean plain text, for the no-rich-text IM platforms.
//
// Why this exists: agents emit standard CommonMark (`**bold**`, `# heading`,
// `| tables |`, ``` ```fences``` ```). LINE, QQ (default), and WeCom (default)
// render NO markdown — they display the message body verbatim as plain text. So
// `**bold**` shows the literal asterisks, a GFM table shows a wall of `|` pipes and
// `---` separators, and `# Title` shows a stray leading `#`. That markup is pure
// noise to the human reader on these platforms (this is exactly how hermes treats
// LINE/QQ/WeCom: as plain text, with no rich format_message).
//
// So instead of the Telegram approach (telegram-markdown.ts: CommonMark → a Satori
// element tree the adapter serializes into Telegram-HTML), here we FLATTEN: strip
// the markers and keep the words, rewrite block structures (tables, lists,
// headings, code fences, blockquotes) into readable line-oriented plain text. The
// output is a plain STRING, fed straight to the adapter's text encoder (LINE/QQ/
// WeCom all just append `attrs.content` of a text element to their send buffer, so
// a plain string is delivered byte-for-byte).
//
// Structure mirrors telegram-markdown.ts (block scan + inline scan, first-match-
// wins, unclosed delimiters degrade to literal text for stream safety), but every
// path emits text rather than `h()` nodes.
//
// Readability choices (documented per the platform's plain-text constraint):
//  - Fenced code blocks: the fence lines (``` and the language tag) are dropped and
//    the code body is kept verbatim, left-aligned (no extra indent). On a plain-text
//    surface there is no monospace rendering to gain from indentation, and adding
//    leading spaces only risks tripping the platform's own length/byte limits — the
//    raw lines are already the most readable form.
//  - Blockquotes: the `>` marker is stripped and the quoted text is kept as plain
//    lines. Decorative wrappers (`「…」`, or a re-emitted `>`) would just be more
//    literal noise on a surface that can't render a quote block; the words alone are
//    cleanest.
//  - GFM tables: rewritten to bold-less bullet groups — the first cell becomes a
//    title line, each remaining cell becomes `• Header: Value` (same idea as
//    telegram-markdown.ts's renderTableBlock, but without the `**` emphasis, which
//    would itself be noise here).

/** GFM table separator row, e.g. `|---|:--:|`. At least one dash per cell. (Same as telegram-markdown.ts.) */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Whether `ch` is undefined or a non-word char — gates underscore emphasis so `file_name` is not flattened. */
function isLeftBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/\w/.test(ch);
}

/**
 * The characters an inline rule can start with: every rule in flattenInline begins with one of them.
 * Same set as telegram-markdown.ts.
 */
const DELIMITER_RE = /[`[*_~]/;

/**
 * Where the plain text starting at `from` ends: the next delimiter (DELIMITER_RE), or the end of `s`.
 * flattenInline copies that run in one step rather than one character at a time; telegram-markdown.ts
 * plainRunEnd says why. A rule that starts with any other character has to be added to
 * DELIMITER_RE, or it will only ever be tried right after a delimiter.
 */
function plainRunEnd(s: string, from: number): number {
  const at = s.slice(from).search(DELIMITER_RE);
  return at < 0 ? s.length : from + at;
}

/** Index of the first `]` after position `i` of `s`, or `s.length` when there is none. */
function closingBracket(s: string, i: number): number {
  const at = s.indexOf(']', i + 1);
  return at < 0 ? s.length : at;
}

/**
 * Flatten inline markdown within a single logical line into plain text.
 *
 * Left-to-right scan, first-match-wins, by priority: inline code → link → bold →
 * strikethrough → italic. Anything that doesn't match a fully-closed construct is
 * accumulated as literal text — this is the stream-safety property mirrored from
 * telegram-markdown.ts: an unclosed `**` just stays as the characters `*` `*`
 * rather than swallowing the rest of the line. Recurses into emphasis/link content
 * so `**bold _and italic_**` flattens fully to `bold and italic`.
 *
 * The rules are tried only where one can start, at a DELIMITER_RE character; the text between is
 * copied whole (plainRunEnd). A new rule's first character goes into DELIMITER_RE.
 */
export function flattenInline(s: string): string {
  let out = '';
  let i = 0;
  // A link's text runs to the first `]` after its `[`, so unless that `]` is followed by `(` no
  // link starts at this `[` — nor at any other before that `]`. Remembering where it is keeps a
  // line of unmatched `[` linear: finding it again from every `[` took 0.8 s for 20 000 of them.
  let close = -1;
  const linkMayStart = (at: number): boolean => {
    if (close <= at) close = closingBracket(s, at);
    return s[close + 1] === '(';
  };
  while (i < s.length) {
    const end = plainRunEnd(s, i);
    if (end > i) {
      out += s.slice(i, end);
      i = end;
      continue;
    }
    const rest = s.slice(i);
    const prev = s[i - 1];
    let m: RegExpExecArray | null;

    // 1) inline code `...` — strip the backticks, keep the content literal (never re-parsed).
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      out += m[1];
      i += m[0].length;
      continue;
    }
    // 2) link [text](url) → `text (url)` so the target isn't lost. Display text recurses.
    if (s[i] === '[' && linkMayStart(i) && (m = /^\[([^\]]+)\]\((\S+?)\)/.exec(rest))) {
      out += `${flattenInline(m[1]!)} (${m[2]})`;
      i += m[0].length;
      continue;
    }
    // 3) bold **...** (any context) or __...__ (only at a left word boundary) → keep the word.
    if (
      (m = /^\*\*([\s\S]+?)\*\*/.exec(rest)) ||
      (isLeftBoundary(prev) && (m = /^__([\s\S]+?)__/.exec(rest)))
    ) {
      out += flattenInline(m[1]!);
      i += m[0].length;
      continue;
    }
    // 4) strikethrough ~~...~~ → keep the word.
    if ((m = /^~~([\s\S]+?)~~/.exec(rest))) {
      out += flattenInline(m[1]!);
      i += m[0].length;
      continue;
    }
    // 5) italic *...* (any context) or _..._ (boundary-gated, not followed by a word char so
    //    `_a_b` is not split). Single-asterisk italic forbids `*` inside to avoid eating bold.
    if (
      (m = /^\*([^*\n]+?)\*/.exec(rest)) ||
      (isLeftBoundary(prev) && (m = /^_([^_\n]+?)_(?!\w)/.exec(rest)))
    ) {
      out += flattenInline(m[1]!);
      i += m[0].length;
      continue;
    }

    // No construct matched at this position: emit the char literally (degrade gracefully).
    out += s[i];
    i++;
  }
  return out;
}

/** Split a GFM table row into trimmed cell strings (drops the leading/trailing empties from edge pipes). */
function splitTableRow(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/**
 * Render a GFM table (header + separator + body rows) as plain-text bullet groups,
 * since these platforms have no table support. Each body row becomes a title line
 * (first cell) followed by `• Header: Value` lines for the remaining cells. Mirrors
 * telegram-markdown.ts's renderTableBlock, minus the bold (no `**` on plain text).
 * Rows are emitted back-to-back (one line each), matching the Telegram spacing.
 */
function flattenTableBlock(header: string[], rows: string[][]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    // First cell is the row title. Empty first cell → skip the title line.
    const title = row[0] ? flattenInline(row[0]) : '';
    if (title) out.push(title);
    for (let c = 1; c < row.length; c++) {
      const label = header[c] ? flattenInline(header[c]!) : '';
      const value = row[c] ? flattenInline(row[c]!) : '';
      if (!value) continue;
      out.push(label ? `• ${label}: ${value}` : `• ${value}`);
    }
  }
  return out;
}

/** Collect a fenced code block's body lines (verbatim) starting just after the opening fence. */
function collectFenceBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
    body.push(lines[i]!);
    i++;
  }
  return { body, next: i + 1 }; // +1 consumes the closing fence (or steps past EOF)
}

/** Collect a GFM table's body rows starting just after the separator row. */
function collectTableRows(lines: string[], start: number): { rows: string[][]; next: number } {
  const rows: string[][] = [];
  let i = start;
  while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
    rows.push(splitTableRow(lines[i]!));
    i++;
  }
  return { rows, next: i };
}

/**
 * Flatten a full CommonMark string into clean plain text.
 *
 * Block handling is line-based (mirrors telegram-markdown.ts): fenced code blocks,
 * GFM tables, ATX headings, blockquotes, and bullet/ordered lists are recognized;
 * everything else is an inline-flattened line. Output lines are joined with `\n`, so
 * blank lines and paragraph spacing survive. Trailing blank lines are trimmed so the
 * message has no dangling newline.
 */
export function flattenMarkdown(input: string): string {
  if (!input) return '';
  const lines = input.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block: ```lang ... ``` (also handles an unclosed fence at end-of-stream).
    // Drop the fence + language; keep the body lines verbatim (see readability note above).
    if (/^\s*```(.*)$/.test(line)) {
      const { body, next } = collectFenceBody(lines, i + 1);
      out.push(...body);
      i = next;
      continue;
    }

    // GFM table: a pipe-bearing header row immediately followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1]!)) {
      const { rows, next } = collectTableRows(lines, i + 2);
      out.push(...flattenTableBlock(splitTableRow(line), rows));
      i = next;
      continue;
    }

    // ATX heading `#`..`######` → strip the markers, keep the text.
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(flattenInline(heading[1]!));
      i++;
      continue;
    }

    // Blockquote: strip the `>` marker from each consecutive line, keep the text plain.
    if (/^\s*>\s?/.test(line)) {
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        out.push(flattenInline(lines[i]!.replace(/^\s*>\s?/, '')));
        i++;
      }
      continue;
    }

    // Unordered list item `- ` / `* ` / `+ ` → `• ` bullet (preserve indentation).
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      out.push(`${ul[1]}• ${flattenInline(ul[2]!)}`);
      i++;
      continue;
    }

    // Ordered list item `N. ` is kept as-is (the number is meaningful), inline-flattened.
    const ol = /^(\s*\d+\.\s+)(.*)$/.exec(line);
    if (ol) {
      out.push(`${ol[1]}${flattenInline(ol[2]!)}`);
      i++;
      continue;
    }

    // Plain line (blank lines included → empty string, preserving paragraph spacing).
    out.push(flattenInline(line));
    i++;
  }

  // Trim trailing blank lines so the message has no dangling newline.
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
