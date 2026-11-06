// CommonMark → Satori element tree, for Telegram.
//
// Why this exists: agents emit standard CommonMark (`**bold**`, `# heading`,
// `| tables |`, ``` ```fences``` ```). Telegram does NOT render CommonMark — its own
// markup is a different dialect (`*bold*`, no headings, no tables) and the Bot API
// rejects malformed markup with a 400. The @satorijs/adapter-telegram MessageEncoder
// renders messages with parse_mode=html and understands a fixed set of Satori
// elements (b/strong/i/em/u/ins/s/del/a, plus code, code-block, quote→blockquote,
// spl→spoiler). So instead of hand-rolling Telegram-HTML strings (and the escaping
// minefield that comes with them — see hermes' format_message), we convert CommonMark
// into that Satori element tree and let the adapter serialize + escape it. Satori's
// h.text() HTML-escapes `< > &`, and the tree is structurally balanced by construction,
// which is what makes this safe to run on EVERY streaming edit, not just the final one:
// a half-received `**bold` (no closing `**`) degrades to literal text rather than an
// unbalanced tag that would 400.
//
// Two limitations are inherent to Telegram, not bugs here:
//  - No tables: GFM pipe tables are rewritten to bold-title + bullet groups (hermes does
//    the same). There is no table primitive to target.
//  - No headings: `# Title` becomes bold, the closest Telegram equivalent.
import { h } from '@satorijs/core';

/** GFM table separator row, e.g. `|---|:--:|`. At least one dash per cell. */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Whether `ch` is undefined or a non-word char — used to gate underscore emphasis so `file_name` is not italicized. */
function isLeftBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/\w/.test(ch);
}

/**
 * The characters an inline rule can start with: every rule in parseInline begins with one of them.
 * plaintext-markdown.ts and slack-markdown.ts keep the same set for the same rules.
 */
const DELIMITER_RE = /[`[*_~]/;

/**
 * Where the plain text starting at `from` ends: the next delimiter (DELIMITER_RE), or the end of `s`.
 *
 * At any other character every rule fails and the character is copied as-is, so copying the whole
 * run in one step is the same output without trying seven regexes per character — which was nearly
 * all of a long line's cost, paid on every streaming edit over the whole message (a 10 KB line
 * took 2.8 ms; measured 2026-11-07). A rule that starts with any other character has to be added
 * to DELIMITER_RE, or it will only ever be tried right after a delimiter.
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
 * Parse inline markdown within a single logical line into Satori nodes.
 *
 * Left-to-right scan, first-match-wins, by priority: inline code → link → bold → strikethrough
 * → italic. Anything that doesn't match a fully-closed construct is accumulated as literal text
 * (this is the stream-safety property: an unclosed `**` just stays as the characters `*` `*`).
 * Recurses into emphasis/link content so `**bold _and italic_**` nests correctly.
 *
 * The rules are tried only where one can start, at a DELIMITER_RE character; the text between is
 * copied whole (plainRunEnd). A new rule's first character goes into DELIMITER_RE.
 */
export function parseInline(s: string): h[] {
  const out: h[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf) {
      out.push(h.text(buf));
      buf = '';
    }
  };
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
      buf += s.slice(i, end);
      i = end;
      continue;
    }
    const rest = s.slice(i);
    const prev = s[i - 1];
    let m: RegExpExecArray | null;

    // 1) inline code `...` — content is literal, never further parsed.
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push(h('code', {}, m[1]));
      i += m[0].length;
      continue;
    }
    // 2) link [text](url) — display text recurses, url goes to href.
    if (s[i] === '[' && linkMayStart(i) && (m = /^\[([^\]]+)\]\((\S+?)\)/.exec(rest))) {
      flush();
      out.push(h('a', { href: m[2] }, ...parseInline(m[1]!)));
      i += m[0].length;
      continue;
    }
    // 3) bold **...** (any context) or __...__ (only at a left word boundary).
    if (
      (m = /^\*\*([\s\S]+?)\*\*/.exec(rest)) ||
      (isLeftBoundary(prev) && (m = /^__([\s\S]+?)__/.exec(rest)))
    ) {
      flush();
      out.push(h('b', {}, ...parseInline(m[1]!)));
      i += m[0].length;
      continue;
    }
    // 4) strikethrough ~~...~~
    if ((m = /^~~([\s\S]+?)~~/.exec(rest))) {
      flush();
      out.push(h('s', {}, ...parseInline(m[1]!)));
      i += m[0].length;
      continue;
    }
    // 5) italic *...* (any context) or _..._ (boundary-gated, and not followed by a word char
    //    so `_a_b` is not split). Single-asterisk italic forbids `*` inside to avoid eating bold.
    if (
      (m = /^\*([^*\n]+?)\*/.exec(rest)) ||
      (isLeftBoundary(prev) && (m = /^_([^_\n]+?)_(?!\w)/.exec(rest)))
    ) {
      flush();
      out.push(h('i', {}, ...parseInline(m[1]!)));
      i += m[0].length;
      continue;
    }

    buf += s[i];
    i++;
  }
  flush();
  return out;
}

/** Split a GFM table row into trimmed cell strings (drops the leading/trailing empty cells from edge pipes). */
function splitTableRow(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/**
 * Render a GFM table (header + separator + body rows) as Telegram-friendly bullet groups,
 * since Telegram has no table support. Each body row becomes a bold title (first cell) followed
 * by `• Header: Value` bullets for the remaining cells. Mirrors hermes' _render_table_block.
 */
function renderTableBlock(header: string[], rows: string[][]): h[] {
  const out: h[] = [];
  rows.forEach((row, ri) => {
    if (ri > 0) out.push(h('br'));
    // First cell is the row title (bold). Empty first cell → skip the title line.
    const title = row[0] ?? '';
    if (title) {
      out.push(h('b', {}, ...parseInline(title)), h('br'));
    }
    for (let c = 1; c < row.length; c++) {
      const label = header[c] ?? '';
      const value = row[c] ?? '';
      if (!value) continue;
      out.push(h.text('• '));
      if (label) out.push(...parseInline(label), h.text(': '));
      out.push(...parseInline(value));
      if (c < row.length - 1) out.push(h('br'));
    }
  });
  return out;
}

/**
 * Convert a full CommonMark string into a Satori element fragment for Telegram.
 *
 * Block handling is line-based: fenced code blocks, GFM tables, ATX headings, blockquotes,
 * and bullet/ordered lists are recognized; everything else is an inline-parsed line. Original
 * line breaks are preserved as <br/> (the adapter renders br → "\n"), so blank lines and
 * paragraph spacing survive unchanged. A trailing break is trimmed so we never emit a dangling
 * newline.
 */
export function renderTelegramMarkdown(input: string): h[] {
  if (!input) return [];
  const lines = input.split('\n');
  const out: h[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block: ```lang ... ``` (also handles an unclosed fence at end-of-stream).
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1]!.trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume the closing fence (or step past EOF)
      out.push(h('code-block', lang ? { lang } : {}, body.join('\n')), h('br'));
      continue;
    }

    // GFM table: a pipe-bearing header row immediately followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1]!)) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes('|') && lines[j]!.trim() !== '') {
        rows.push(splitTableRow(lines[j]!));
        j++;
      }
      out.push(...renderTableBlock(header, rows), h('br'));
      i = j;
      continue;
    }

    // ATX heading `#`..`######` → bold (Telegram has no headings).
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(h('b', {}, ...parseInline(heading[1]!)), h('br'));
      i++;
      continue;
    }

    // Blockquote: collapse consecutive `>` lines into one <blockquote> with internal breaks.
    if (/^\s*>\s?/.test(line)) {
      const quoted: h[] = [];
      let first = true;
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        if (!first) quoted.push(h('br'));
        quoted.push(...parseInline(lines[i]!.replace(/^\s*>\s?/, '')));
        first = false;
        i++;
      }
      out.push(h('quote', {}, ...quoted), h('br'));
      continue;
    }

    // Unordered list item `- ` / `* ` / `+ ` → `• ` bullet (preserve indentation).
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      out.push(h.text(`${ul[1]}• `), ...parseInline(ul[2]!), h('br'));
      i++;
      continue;
    }

    // Plain line (includes blank lines → just a break, preserving spacing).
    out.push(...parseInline(line), h('br'));
    i++;
  }

  // Trim a single trailing break so the message has no dangling newline.
  if (out.length && typeof out[out.length - 1] !== 'string' && (out[out.length - 1] as h).type === 'br') {
    out.pop();
  }
  return out;
}

/**
 * Visible length Telegram counts toward its 4096 limit for the rendered text.
 *
 * Telegram measures the limit on the ENTITY-PARSED text (HTML tags don't count — verified: an 4800-
 * char HTML string with 600 visible chars is accepted), in UTF-16 code units (which JS .length
 * already counts). So strip the tags we emit and decode the entities we emit to get the visible
 * text. Used by the StreamBuffer (via the profile's measureRendered) to chunk by the real limit,
 * since renderTelegramMarkdown can expand the visible length (table→bullets ~1.4x).
 */
export function telegramVisibleLength(text: string): number {
  const html = fragmentToTelegramHtml(renderTelegramMarkdown(text));
  const visible = html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return visible.length;
}

/** Escape text for raw Telegram HTML (used only by the forum-topic path that bypasses the Satori encoder). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Serialize a Satori fragment (as produced by renderTelegramMarkdown) to a raw Telegram-HTML string.
 *
 * Only the forum-topic send path needs this: it posts via internal.sendMessage (the raw Bot API),
 * which bypasses the adapter's MessageEncoder, so we must emit the HTML + set parse_mode ourselves.
 * The element set handled here mirrors @satorijs/adapter-telegram's visit(): b/strong/i/em/u/ins/s/del/a
 * already stringify to valid Telegram HTML, while code/code-block/quote need the Telegram-specific tags.
 */
export function fragmentToTelegramHtml(nodes: h[]): string {
  const childText = (node: h): string =>
    (node.children ?? []).map((c) => (typeof c === 'string' ? c : c.attrs?.content ?? '')).join('');
  return nodes
    .map((node): string => {
      const { type, attrs, children } = node;
      switch (type) {
        case 'text':
          return escapeHtml(String(attrs?.content ?? ''));
        case 'br':
          return '\n';
        case 'code':
          return `<code>${escapeHtml(childText(node))}</code>`;
        case 'code-block': {
          const lang = attrs?.lang as string | undefined;
          return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(childText(node))}</code></pre>`;
        }
        case 'quote':
          return `<blockquote>${fragmentToTelegramHtml(children ?? [])}</blockquote>`;
        case 'b':
        case 'strong':
        case 'i':
        case 'em':
        case 'u':
        case 'ins':
        case 's':
        case 'del':
        case 'a':
          // These element names are valid Telegram HTML tags; Satori's toString() emits them escaped.
          return node.toString();
        default:
          return fragmentToTelegramHtml(children ?? []);
      }
    })
    .join('');
}
