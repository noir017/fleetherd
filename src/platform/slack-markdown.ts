// CommonMark → Slack mrkdwn, for Slack.
//
// Why this exists: agents emit standard CommonMark (`**bold**`, `# heading`,
// `| tables |`, ``` ```fences``` ```). Slack does NOT render CommonMark — it uses its own
// "mrkdwn" dialect: `*bold*` (SINGLE asterisk), `_italic_`, `~strike~`, `` `code` ``,
// ``` ```code``` ```, links as `<url|text>`, blockquote `> `, and crucially NO headings and
// NO tables. So the agent's `**bold**` would otherwise show as literal asterisks. We translate.
//
// Mirrors telegram-markdown.ts in STRUCTURE (line-based block parser + a left-to-right,
// first-match-wins inline parser, table→bullet rewrite, stream-safe degradation), but the
// OUTPUT is a STRING (mrkdwn), not a Satori h-tree: Slack's Web API takes a `text` string and
// renders mrkdwn directly, so there is no element tree to hand to an encoder.
//
// Delivery note (see profiles/slack.ts): the profile sends this string via raw
// internal.chatPostMessage / chatUpdate, deliberately bypassing @satorijs/adapter-slack's
// MessageEncoder. The adapter's `escape()` (adapter-slack/lib/index.cjs) prepends a zero-width
// space before every `* _ ~ \`` and rewrites `<...>` → `&lt;...&gt;`; routing our already-rendered
// mrkdwn through it would (a) parse our `<url|text>` links as Satori tags and (b) neutralize every
// `*`/`_`/`~` we just emitted. Bypassing it means WE own escaping (see escapeText below).
//
// Stream-safety: this runs on EVERY streaming edit, not just the final flush, so a half-received
// `**bold` (no closing `**`) must degrade to the literal characters `*` `*`, never to a dangling
// open marker. The inline parser only rewrites a construct once it sees its CLOSING delimiter;
// anything unclosed accumulates as escaped literal text. Send and edit run the identical converter,
// so a message never flickers between two renderings (the Telegram lesson: send/edit must match).
//
// Two limitations are inherent to Slack, not bugs here:
//  - No tables: GFM pipe tables are rewritten to bold-title + `• Label: Value` bullet groups
//    (mirrors hermes' _render_table_block, and is strictly better than hermes' Slack adapter, which
//    forwards the raw pipes). There is no table primitive in mrkdwn.
//  - No headings: `# Title` becomes `*Title*` (bold), the closest mrkdwn equivalent.

/** GFM table separator row, e.g. `|---|:--:|`. At least one dash per cell. */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Escape the three characters Slack treats as control characters in mrkdwn: `&`, `<`, `>`.
 *
 * These are the ONLY characters mrkdwn requires escaping (Slack decodes the entities back when it
 * renders — message-wide, including inside code spans, which is why we escape code bodies too; this
 * matches the adapter's own text `escape()`). We do NOT escape `*`/`_`/`~`/`` ` ``: those are the
 * formatting markers our parser emits intentionally, and any LITERAL ones survive untouched because
 * — unlike the adapter — we don't zero-width-space them; a lone `*` (e.g. "5 * 3") simply isn't a
 * closed construct so Slack leaves it alone.
 *
 * Order matters: `&` first, so the `&` we introduce for `<`/`>` is not re-escaped.
 */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Whether `ch` is undefined or a non-word char — used to gate underscore emphasis so `file_name` is not italicized. */
function isLeftBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/\w/.test(ch);
}

/**
 * The characters an inline rule can start with: every rule in parseInline begins with one of them.
 * Same set as telegram-markdown.ts.
 */
const DELIMITER_RE = /[`[*_~]/;

/**
 * Where the plain text starting at `from` ends: the next delimiter (DELIMITER_RE), or the end of `s`.
 * parseInline copies that run in one step rather than one character at a time; telegram-markdown.ts
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
 * Parse inline markdown within a single logical line into a mrkdwn string.
 *
 * Left-to-right scan, first-match-wins, by priority: inline code → link → bold-italic → bold →
 * strikethrough → italic. Anything that doesn't match a fully-closed construct is accumulated as
 * literal text and escaped on flush (this is the stream-safety property: an unclosed `**` just
 * stays as the characters `*` `*`). Emphasis content recurses so `**bold _and italic_**` nests.
 *
 * Escaping discipline: literal runs are escaped via escapeText; the mrkdwn markers we emit
 * (`*`, `_`, `~`, `` ` ``, and the `<url|...>` link wrapper) are written RAW and never escaped —
 * notably the link URL keeps its `&` (Slack parses the `<...>` link form before entity-decoding, so
 * escaping the URL's `&` would break the link).
 *
 * The rules are tried only where one can start, at a DELIMITER_RE character; the text between is
 * copied whole (plainRunEnd). A new rule's first character goes into DELIMITER_RE.
 */
export function parseInline(s: string): string {
  let out = '';
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf) {
      out += escapeText(buf);
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

    // 1) inline code `...` — content is escaped (Slack decodes &<> everywhere, incl. code) but
    //    never markdown-transformed.
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out += '`' + escapeText(m[1]!) + '`';
      i += m[0].length;
      continue;
    }
    // 2) link [text](url) → <url|text>. The URL is emitted raw (no escaping — see above); the label
    //    is escaped but NOT re-parsed for markdown (matches hermes; Slack link labels with nested
    //    mrkdwn are unreliable, so we keep the label literal).
    if (s[i] === '[' && linkMayStart(i) && (m = /^\[([^\]]+)\]\((\S+?)\)/.exec(rest))) {
      flush();
      out += '<' + m[2]! + '|' + escapeText(m[1]!) + '>';
      i += m[0].length;
      continue;
    }
    // 3) bold+italic ***x*** → *_x_* (Slack nests bold around italic). Must precede the bold rule,
    //    which would otherwise consume the first `**` and leave a stray `*`.
    if ((m = /^\*\*\*([\s\S]+?)\*\*\*/.exec(rest))) {
      flush();
      out += '*_' + parseInline(m[1]!) + '_*';
      i += m[0].length;
      continue;
    }
    // 4) bold **...** (any context) or __...__ (only at a left word boundary) → *...* (single
    //    asterisk = Slack bold).
    if (
      (m = /^\*\*([\s\S]+?)\*\*/.exec(rest)) ||
      (isLeftBoundary(prev) && (m = /^__([\s\S]+?)__/.exec(rest)))
    ) {
      flush();
      out += '*' + parseInline(m[1]!) + '*';
      i += m[0].length;
      continue;
    }
    // 5) strikethrough ~~...~~ → ~...~ (single tilde = Slack strike).
    if ((m = /^~~([\s\S]+?)~~/.exec(rest))) {
      flush();
      out += '~' + parseInline(m[1]!) + '~';
      i += m[0].length;
      continue;
    }
    // 6) italic *...* or _..._ → _..._ (underscore = Slack italic). The `*` form requires the
    //    content to touch non-whitespace on both sides, so a literal "a * b * c" is NOT italicized
    //    (mrkdwn would not render it either; this avoids mangling arithmetic/asterisks). The `_`
    //    form is boundary-gated and not followed by a word char so `_a_b` / `file_name_x` stay literal.
    if (
      (m = /^\*(\S(?:[^*\n]*?\S)?)\*/.exec(rest)) ||
      (isLeftBoundary(prev) && (m = /^_([^_\n]+?)_(?!\w)/.exec(rest)))
    ) {
      flush();
      out += '_' + parseInline(m[1]!) + '_';
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
 * Render a GFM table (header + separator + body rows) as Slack-friendly bullet groups, since Slack
 * mrkdwn has no table support. Each body row becomes a bold title (first cell) followed by
 * `• Header: Value` bullets for the remaining cells. Mirrors hermes' _render_table_block and the
 * Telegram converter. Rows and lines are joined with single newlines.
 */
function renderTableBlock(header: string[], rows: string[][]): string {
  const blocks: string[] = [];
  for (const row of rows) {
    const parts: string[] = [];
    // First cell is the row title (bold). Empty first cell → skip the title line.
    const title = row[0] ?? '';
    if (title) parts.push('*' + parseInline(title) + '*');
    for (let c = 1; c < row.length; c++) {
      const label = header[c] ?? '';
      const value = row[c] ?? '';
      if (!value) continue;
      let bullet = '• ';
      if (label) bullet += parseInline(label) + ': ';
      bullet += parseInline(value);
      parts.push(bullet);
    }
    if (parts.length) blocks.push(parts.join('\n'));
  }
  return blocks.join('\n');
}

/**
 * Convert a full CommonMark string into a Slack mrkdwn string.
 *
 * Block handling is line-based: fenced code blocks, GFM tables, ATX headings, blockquotes, and
 * bullet/ordered lists are recognized; everything else is an inline-parsed line. Original line
 * breaks are preserved (lines are re-joined with `\n`), so blank lines and paragraph spacing
 * survive unchanged.
 */
export function renderSlackMarkdown(input: string): string {
  if (!input) return '';
  const lines = input.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block: ```lang ... ``` (also handles an unclosed fence at end-of-stream). Slack
    // code blocks are bare ``` fences with NO language tag (a lang token would render as literal
    // text), so we drop the language. The body is escaped for &<> but not markdown-transformed.
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume the closing fence (or step past EOF)
      out.push('```\n' + escapeText(body.join('\n')) + '\n```');
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
      out.push(renderTableBlock(header, rows));
      i = j;
      continue;
    }

    // ATX heading `#`..`######` → bold (Slack has no headings).
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push('*' + parseInline(heading[1]!) + '*');
      i++;
      continue;
    }

    // Blockquote `> x` → keep `> x` (Slack supports blockquote). We deliberately emit the `> `
    // marker ourselves and only escape the quoted content; the adapter's escape() would have turned
    // a leading `>` into ` &gt;` (defeating the quote), which is exactly the path we bypass.
    if (/^\s*>\s?/.test(line)) {
      out.push('> ' + parseInline(line.replace(/^\s*>\s?/, '')));
      i++;
      continue;
    }

    // Unordered list item `- ` / `* ` / `+ ` → `• ` bullet (preserve indentation).
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      out.push(ul[1]! + '• ' + parseInline(ul[2]!));
      i++;
      continue;
    }

    // Ordered list item `N. ` → keep `N. ` (Slack renders numbered lists from `N.`).
    const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      out.push(ol[1]! + ol[2]! + '. ' + parseInline(ol[3]!));
      i++;
      continue;
    }

    // Plain line (includes blank lines → empty string, preserving paragraph spacing).
    out.push(parseInline(line));
    i++;
  }

  return out.join('\n');
}
