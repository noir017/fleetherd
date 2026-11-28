/**
 * Markdown → HTML, for the built-in web UI (`platform/webui/`).
 *
 * One converter per dialect, same as the seven others in this directory (see
 * [README](README.md)). The "dialect" here is a browser, which is the only target in the
 * set that renders everything CommonMark can express: tables stay tables instead of
 * degrading to bullets (`markdown-tables.ts`), headings stay headings, and a fenced block
 * keeps its language label.
 *
 * ── The rule that is not about markdown ───────────────────────────────────────
 * THIS FILE IS THE XSS BOUNDARY. Every other converter here emits text into a chat client
 * that renders no markup of its own; this one emits HTML into a DOM. And what it converts
 * is not the operator's prose — it is whatever the agent printed, which includes the raw
 * bytes of every tool result it read. A page that passed `<img onerror=…>` through from a
 * grepped file would execute it.
 *
 * So: every character of input is escaped FIRST, and the only unescaped markup in the
 * output is markup this file constructed itself. There is no raw-HTML passthrough, not
 * even a deliberate one, and adding one later would silently hand the agent's stdout
 * script execution in the operator's browser.
 *
 * Escaping first is also what lets the inline scanner run over the escaped text without a
 * second pass: escaping only ever introduces `&`, `#`, `;`, digits and letters, none of
 * which are inline markdown delimiters. It is why a URL's `&` arrives in an href already
 * spelled `&amp;` — which is the correct spelling for an attribute, not a bug.
 *
 * ── Stream safety (mandatory, as in every converter here) ─────────────────────
 * This runs on EVERY streaming edit, not just the final flush, so it is handed
 * half-received input constantly. A dangling `**bold` must come out as the literal
 * characters `**bold` — never as an unbalanced `<strong>`, which in a DOM does not merely
 * look wrong for one message but swallows the formatting of everything after it. The
 * inline scanner therefore rewrites a construct only once it has seen the CLOSING
 * delimiter, and a table only once both its header row and its `|---|` separator have
 * arrived.
 *
 * An unterminated code fence is the deliberate exception: it renders as an open
 * `<pre><code>` block, because that is what it will be one character later, and the
 * alternative makes every streamed code block flicker through a paragraph first.
 */

import { icon } from './webui/icons.js';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape every character HTML gives meaning to. Runs before anything else looks at the text. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Render markdown to HTML safe to assign to `innerHTML`.
 *
 * Total: any input produces output, and input this file does not understand comes back as
 * escaped literal text rather than being dropped. A converter that silently swallowed what
 * it could not parse would lose part of an answer, which is worse than showing it unstyled.
 */
export function renderWebMarkdown(src: string): string {
  return renderBlocks(src.split('\n'));
}

/**
 * A finished tool line's ` ✓ 1.2s` / ` ✗ 832ms`: what ToolRenderer.renderBlock appends, in
 * formatDuration's two shapes (`core/tool-renderer.ts`; pinned by a test that runs that formatter).
 *
 * Split off so that folding cuts the COMMAND and never the mark. Cut at the bubble's edge, a long
 * line loses its end, and its end is the one part that says whether the tool is still running —
 * the 40-character server cut this replaced never hid it. Parsed back out of the text because the
 * text is all an adapter is given; if the format ever drifts, a line just folds whole, as before.
 */
const TOOL_STATUS_RE = / ([✓✗]) (\d+ms|\d+\.\d+s)$/;

/**
 * The head of a tool line: the tool's emoji, after ToolRenderer.ownerPrefix's `↳ ` or
 * `↳ {sub-agent} · ` when the tool is a sub-agent's. The owner part is tried shortest first, so a
 * ` · ` inside the preview is never taken for the end of a name.
 */
const TOOL_HEAD_RE = /^(?:(↳) ((?:.*? · )??))?(\p{Extended_Pictographic}️?)(?= |$)/u;

/**
 * A glyph a tool line carries, as the markup to show instead (the web UI's icons), or undefined
 * to leave it as text. Asked about the head's emoji, `↳`, and the finish mark's ✓ / ✗.
 */
export type ToolGlyph = (glyph: string) => string | undefined;

/** The escaped line body, with its head's glyphs swapped where `glyph` has something for them. */
function toolBodyHtml(body: string, glyph: ToolGlyph | undefined): string {
  if (!glyph) return escapeHtml(body);
  const as = (g: string): string => glyph(g) ?? escapeHtml(g);
  const head = TOOL_HEAD_RE.exec(body);
  if (head) {
    const owner = head[1] !== undefined ? `${as(head[1])} ${escapeHtml(head[2] ?? '')}` : '';
    return owner + as(head[3] ?? '') + escapeHtml(body.slice(head[0].length));
  }
  // A sub-agent's line whose emoji is not one (an operator's own emojiMap value): the ↳ still is.
  if (body.startsWith('↳ ')) return as('↳') + escapeHtml(body.slice(1));
  return escapeHtml(body);
}

/**
 * A tool-progress bubble (`core/tool-renderer.ts`): one `<div class="tl">` per tool line, which
 * the page folds to a single row and opens on a click. Inside it, `.tl-c` is the part that folds
 * and `.tl-s` the finish mark that stays in view (see TOOL_STATUS_RE).
 *
 * Not markdown, deliberately. A line is `{emoji} {tool}: "{preview}" ✓ 1.2s` and the preview is
 * a command or a path — exactly the text inline markdown mangles: `*.ts` and `a_b_c` start
 * emphasis, a backtick in a shell command opens a code span, and consecutive lines merge into
 * one paragraph so there is no per-tool element to fold. So each line is escaped and nothing
 * else. Verbose mode's argument dump under a line is the one real markdown construct a bubble
 * carries, and goes through the same fence taker the replies use, so it renders identically.
 *
 * Stream safety is free here: nothing spans lines except the fence, which already renders open.
 *
 * `glyph`, when given, swaps the line's head emoji, its `↳` and its ✓ / ✗ for icons; without it
 * every line is the escaped text, as a sub-agent report (whose `🔔` lines are not tools) wants.
 */
export function renderWebToolLines(src: string, glyph?: ToolGlyph): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const consumed = takeBlank(lines, i) ?? takeFence(lines, i, out);
    if (consumed !== null) {
      i += consumed;
      continue;
    }
    const line = lines[i] ?? '';
    const status = TOOL_STATUS_RE.exec(line);
    const body = status ? line.slice(0, status.index) : line;
    const done = status ? (glyph?.(status[1] ?? '') ?? escapeHtml(status[1] ?? '')) : '';
    const mark = status ? `<span class="tl-s"> ${done} ${escapeHtml(status[2] ?? '')}</span>` : '';
    out.push(`<div class="tl"><span class="tl-c">${toolBodyHtml(body, glyph)}</span>${mark}</div>`);
    i += 1;
  }
  return `<div class="tools">${out.join('')}</div>`;
}

/**
 * One subagent's card (kind `subagent`, daemon/subagent-cards.ts): its header line over its tool
 * lines. The header is `↳ {name}`, with the ✓ / ✗ and duration a tool line takes once the subagent
 * has ended (core/tool-renderer.ts subagentHeader), so it is read back with the same pattern.
 *
 * Only what the header says is drawn here, escaped — the state and duration as attributes, the name
 * as text; the page builds its line and its row around it (client transcript/markup.ts parseSubagent), in the
 * reader's language. `.sa-h` and its two attributes are that file's to parse; change them together.
 */
export function renderWebSubagent(src: string, glyph?: ToolGlyph): string {
  const nl = src.indexOf('\n');
  const head = nl < 0 ? src : src.slice(0, nl);
  const status = TOOL_STATUS_RE.exec(head);
  const name = (status ? head.slice(0, status.index) : head).replace(/^↳ /, '');
  const state = !status ? 'run' : status[1] === '✓' ? 'ok' : 'err';
  const lines = renderWebToolLines(nl < 0 ? '' : src.slice(nl + 1), glyph);
  return `<div class="sa-h" data-st="${state}" data-d="${escapeHtml(status?.[2] ?? '')}">${escapeHtml(name)}</div>${lines}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block level
//
// Not a streaming `feed(line)` walker, because one construct needs a line of lookahead: a
// table header is indistinguishable from an ordinary paragraph until the `|---|` separator
// on the NEXT line proves it. An index loop over the whole array gives that for free, and
// costs nothing — the caller always has the full text anyway.
// ─────────────────────────────────────────────────────────────────────────────

/** Each taker reports how many lines it consumed, or null when the construct is not there. */
type Taker = (lines: readonly string[], i: number, out: string[]) => number | null;

const TAKERS: readonly Taker[] = [takeBlank, takeFence, takeHeading, takeRule, takeQuote, takeTable, takeList];

function renderBlocks(lines: readonly string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let consumed: number | null = null;
    for (const take of TAKERS) {
      consumed = take(lines, i, out);
      if (consumed !== null) break;
    }
    // takeParagraph is the fallback rather than a member of TAKERS: it matches everything,
    // so having it in the list would only ever be reached last anyway, and keeping it out
    // makes "the list is ordered by specificity" true without an exception at the end.
    i += consumed ?? takeParagraph(lines, i, out);
  }
  return out.join('');
}

function takeBlank(lines: readonly string[], i: number): number | null {
  return (lines[i] ?? '').trim() === '' ? 1 : null;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;

/**
 * A fenced code block, closed by a fence of the same character and at least the same
 * length — or by the end of the input, which is the streaming case (see the header).
 */
function takeFence(lines: readonly string[], i: number, out: string[]): number | null {
  const open = FENCE_RE.exec(lines[i] ?? '');
  if (!open) return null;
  const marker = open[1] ?? '';
  const info = (open[2] ?? '').trim().split(/\s+/)[0] ?? '';
  const body: string[] = [];
  let n = i + 1;
  while (n < lines.length) {
    const line = lines[n] ?? '';
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close && (close[1] ?? '').startsWith(marker[0] ?? '') && (close[1] ?? '').length >= marker.length) {
      n += 1;
      break;
    }
    body.push(line);
    n += 1;
  }
  out.push(codeBlock(info, body.join('\n')));
  return n - i;
}

/** Fence languages whose lines are coloured here, by their first character (see `diffLines`). */
const DIFF_LANGS: ReadonlySet<string> = new Set(['diff', 'patch']);

/**
 * A code block in its frame: a bar naming the language, with two controls the page wires up by
 * `data-cb` (page.ts, delegated, so every place this HTML lands gets them) — copy the code, and
 * wrap its long lines — over the `<pre>`.
 *
 * The controls are markup here rather than added by the page, the way a tool bubble's icons are:
 * a fence reaches the page through the transcript, a reply streaming in, the History tab, a side
 * answer's card and the file reader, and markup written once here is right in all of them without
 * each having to remember a step. Copy reads the `<code>` element's text, so it gets exactly the
 * characters inside the fence whatever the page has since drawn over them.
 *
 * The language stays a class on `<code>` as well as the label: it is what the page's highlighter
 * (codeview `highlighter`) is asked for, after the message has stopped changing.
 */
function codeBlock(info: string, body: string): string {
  const lang = escapeHtml(info);
  const cls = info ? ` class="language-${lang}"` : '';
  const code = DIFF_LANGS.has(info.toLowerCase()) ? diffLines(body) : escapeHtml(body);
  return (
    `<div class="cb"><div class="cb-h"><span class="cb-lang">${lang}</span>` +
    `<button type="button" class="cb-b" data-cb="wrap" title="Wrap long lines" aria-label="Wrap long lines" aria-pressed="false">${icon('wrap')}</button>` +
    `<button type="button" class="cb-b" data-cb="copy" title="Copy" aria-label="Copy code">${icon('copy')}</button>` +
    `</div><pre><code${cls}>${code}</code></pre></div>`
  );
}

/**
 * A patch, one line at a time: added green, removed red, a hunk header in the header colour — the
 * same rule and classes as the git panel's plain-text fallback (page.ts gitPaintPatch), so a diff
 * in a reply reads like the diff in the panel. `+++` / `---` are the file names, not changes.
 *
 * Done here rather than by the page's highlighter because it needs no grammar: the first character
 * is the whole rule, so a patch is coloured while it is still streaming in and on a page that has
 * no code view at all. Each line is escaped on its own, inside a span this file wrote; the newlines
 * stay between the spans, so the code element's text is the fence's text exactly.
 */
function diffLines(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      const cls =
        line.startsWith('+') && !line.startsWith('+++') ? 'pa'
        : line.startsWith('-') && !line.startsWith('---') ? 'pd'
        : line.startsWith('@@') ? 'ph'
        : '';
      return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
    })
    .join('\n');
}

function takeHeading(lines: readonly string[], i: number, out: string[]): number | null {
  const m = /^ {0,3}(#{1,6})\s+(.*)$/.exec(lines[i] ?? '');
  if (!m) return null;
  const level = (m[1] ?? '#').length;
  // Trailing `###` is a closing sequence in CommonMark, not content.
  const text = (m[2] ?? '').replace(/\s+#+\s*$/, '');
  out.push(`<h${level}>${inline(escapeHtml(text))}</h${level}>`);
  return 1;
}

function takeRule(lines: readonly string[], i: number, out: string[]): number | null {
  if (!/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(lines[i] ?? '')) return null;
  out.push('<hr>');
  return 1;
}

/**
 * A blockquote, rendered by re-running the whole block parser on the stripped lines.
 *
 * Recursion rather than a special case is what makes a list, a fence or a nested quote
 * inside a quote work without a single line of extra code — and agents quote tool output
 * containing all three.
 */
function takeQuote(lines: readonly string[], i: number, out: string[]): number | null {
  if (!/^ {0,3}>/.test(lines[i] ?? '')) return null;
  const inner: string[] = [];
  let n = i;
  while (n < lines.length && /^ {0,3}>/.test(lines[n] ?? '')) {
    inner.push((lines[n] ?? '').replace(/^ {0,3}> ?/, ''));
    n += 1;
  }
  out.push(`<blockquote>${renderBlocks(inner)}</blockquote>`);
  return n - i;
}

const TABLE_SEP_RE = /^ {0,3}\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;

/**
 * A GFM table — converted only once BOTH its header row and its `|---|` separator have
 * arrived, which is the stream-safety rule the other converters state too. Mid-stream, the
 * header alone is an ordinary paragraph, and it becomes a table on the edit after.
 */
function takeTable(lines: readonly string[], i: number, out: string[]): number | null {
  const header = lines[i] ?? '';
  const sep = lines[i + 1];
  if (!header.includes('|') || sep === undefined || !TABLE_SEP_RE.test(sep)) return null;
  const heads = splitRow(header);
  if (heads.length === 0) return null;
  const rows: string[][] = [];
  let n = i + 2;
  while (n < lines.length && (lines[n] ?? '').includes('|')) {
    rows.push(splitRow(lines[n] ?? ''));
    n += 1;
  }
  out.push(renderTable(heads, rows));
  return n - i;
}

/**
 * Split one table row into cells, dropping the leading/trailing pipes GFM allows.
 *
 * Scanned rather than `split('|')`, because a pipe is not always a column. `\|` is a literal pipe
 * (GFM), and a pipe inside a code span is read as part of the code: agents write `a | b` in a
 * cell to show a shell pipeline or a union type, and splitting there cut the cell in two and
 * pushed the last column off the row. A backtick run with no closer is literal, as it is in
 * `inline`, so a row still streaming in splits the way it will once the closer arrives.
 */
function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '');
  const cells: string[] = [];
  let cell = '';
  // Whether nothing has been written since the last separator: a row that ends on its pipe has
  // no empty last cell (`| a | b |` is two cells, `| a | |` still two).
  let fresh = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i] ?? '';
    if (c === '|') {
      cells.push(cell.trim());
      cell = '';
      fresh = true;
      i += 1;
      continue;
    }
    fresh = false;
    if (c === '\\' && s[i + 1] === '|') {
      cell += '|';
      i += 2;
    } else if (c === '`') {
      const len = backtickRun(s, i);
      const close = codeSpanClose(s, i + len, len);
      const end = close < 0 ? i + len : close + len;
      // A code span keeps its pipes, and its `\|` reads as `|` there too, as GFM has it.
      cell += s.slice(i, end).replace(/\\\|/g, '|');
      i = end;
    } else {
      cell += c;
      i += 1;
    }
  }
  if (!fresh || cell.trim() !== '') cells.push(cell.trim());
  return cells;
}

function renderTable(heads: readonly string[], rows: readonly string[][]): string {
  const cell = (tag: string) => (text: string): string => `<${tag}>${inline(escapeHtml(text))}</${tag}>`;
  const head = `<tr>${heads.map(cell('th')).join('')}</tr>`;
  const body = rows
    // Pad short rows and drop the overflow of long ones, so a ragged table still renders as
    // a grid instead of collapsing columns.
    .map((r) => heads.map((_, c) => r[c] ?? '').map(cell('td')).join(''))
    .map((tds) => `<tr>${tds}</tr>`)
    .join('');
  // The frame scrolls sideways, not the table: a table wider than a phone is otherwise either
  // squeezed a word to a line or wider than the bubble it is in. A `display:block` table scrolled
  // too, but it is then no longer a table to the browser's layout, and its cells stop sharing one
  // width with the header row the moment a row is short.
  return `<div class="tbl"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

const ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

interface Item {
  indent: number;
  ordered: boolean;
  /** The number the author wrote, for an ordered item. Used only to start the list at it. */
  num: number;
  /**
   * What the item holds, in order: runs of text (its first line and the continuation lines under
   * it, joined by newlines) and blocks already rendered — a code fence indented under the item.
   */
  parts: Array<string | { html: string }>;
}

/**
 * A list, including nested ones.
 *
 * The run of item lines is collected first and turned into HTML by indentation afterwards,
 * rather than opening and closing tags as lines arrive. The list is the one block where
 * "emit as you go" gets the tags wrong whenever the input dedents by more than one level at
 * once — which is what a hand-written list from a model does constantly.
 */
function takeList(lines: readonly string[], i: number, out: string[]): number | null {
  if (!ITEM_RE.test(lines[i] ?? '')) return null;
  const items: Item[] = [];
  let n = i;
  while (n < lines.length) {
    const m = ITEM_RE.exec(lines[n] ?? '');
    if (m) {
      items.push({
        indent: (m[1] ?? '').length,
        ordered: /\d/.test(m[2] ?? ''),
        num: parseInt(m[2] ?? '', 10) || 1,
        parts: [m[3] ?? ''],
      });
      n += 1;
      continue;
    }
    // A non-item, non-blank line indented under the last item is that item's continuation.
    const line = lines[n] ?? '';
    const last = items[items.length - 1];
    if (!/^\s+\S/.test(line) || !last) break;
    const fence = takeItemFence(lines, n);
    if (fence) {
      last.parts.push({ html: fence.html });
      n += fence.consumed;
      continue;
    }
    const tail = last.parts[last.parts.length - 1];
    if (typeof tail === 'string') last.parts[last.parts.length - 1] = `${tail}\n${line.trim()}`;
    else last.parts.push(line.trim());
    n += 1;
  }
  out.push(renderList(items));
  return n - i;
}

/**
 * A code fence indented under a list item — how a model writes the command that goes with step 2.
 *
 * Taken as a block, by the same fence taker as everywhere else, with the fence line's own indent
 * stripped from every line of it (CommonMark's rule for an indented fence's content). Before, it
 * went down the continuation path: trimmed, joined into the item's text, and the backticks turned
 * the whole block into one inline code span with `<br>` for its newlines.
 *
 * Like a fence anywhere, it runs to its closer or to the end of the input — the streaming case —
 * and the lines inside it are never read as list items, so a YAML list in the code stays code.
 */
function takeItemFence(lines: readonly string[], n: number): { html: string; consumed: number } | null {
  const line = lines[n] ?? '';
  const pad = /^[ \t]*/.exec(line)?.[0].length ?? 0;
  if (!FENCE_RE.test(line.slice(pad))) return null;
  const dedent = new RegExp(`^[ \\t]{0,${pad}}`);
  const out: string[] = [];
  const consumed = takeFence(lines.slice(n).map((l) => l.replace(dedent, '')), 0, out) ?? 1;
  return { html: out.join(''), consumed };
}

/** One open list in `renderList`'s stack: what it is, and how far its items are indented. */
interface OpenList {
  indent: number;
  tag: 'ul' | 'ol';
}

/**
 * The opening tag for a list, carrying `start` when an ordered one does not begin at 1.
 *
 * A numbered list interrupted by anything that is not a list item — a paragraph, a code
 * block, a line the author forgot to put a space after the dash in — ends there, and what
 * follows it is a second `<ol>`. Without `start` that second list renumbers from 1, so
 * "1. … 2. …" written by hand comes out as "1. … 1. …". The browser's own numbering is
 * still used within a list; this only says where it begins.
 */
function openTag(tag: 'ul' | 'ol', num: number): string {
  return tag === 'ol' && num !== 1 ? `<ol start="${num}">` : `<${tag}>`;
}

function renderList(items: readonly Item[]): string {
  const out: string[] = [];
  const stack: OpenList[] = [];
  for (const item of items) {
    const tag: 'ul' | 'ol' = item.ordered ? 'ol' : 'ul';
    // Dedent: close every list deeper than this item, innermost first.
    while (stack.length > 0 && item.indent < (stack[stack.length - 1]?.indent ?? 0)) {
      out.push(`</li></${stack.pop()?.tag ?? 'ul'}>`);
    }
    const top = stack[stack.length - 1];
    if (!top || item.indent > top.indent) {
      // Indent (or the very first item): open a list. The parent's `<li>` stays open on
      // purpose — that is what makes the nested list a child of the item above it rather
      // than a sibling of it.
      stack.push({ indent: item.indent, tag });
      out.push(openTag(tag, item.num));
    } else {
      out.push('</li>');
      if (top.tag !== tag) {
        // A bulleted run turning numbered (or back) at the same indent is two lists, not one.
        out.push(`</${top.tag}>${openTag(tag, item.num)}`);
        stack[stack.length - 1] = { indent: item.indent, tag };
      }
    }
    out.push(itemOpen(item));
  }
  while (stack.length > 0) {
    out.push(`</li></${stack.pop()?.tag ?? 'ul'}>`);
  }
  return out.join('');
}

/**
 * A GFM task item's box: `[ ]` or `[x]`, then a space or the end of the line. `[x](url)` is a link,
 * not a box, and neither is a `[` still waiting for its `]` while the line streams in.
 */
const TASK_RE = /^\[([ xX])\](?:\s+|$)/;

/**
 * An item's opening `<li>` and everything it holds but its nested lists.
 *
 * A task item shows its box as the page's own box icons, drawn not clickable: ticking it here would
 * change nothing the agent can see, and a box that looks like it records a choice and does not is
 * worse than one that plainly reports. The label is for a screen reader, which has no other way to
 * tell the two icons apart.
 */
function itemOpen(item: Item): string {
  const [first, ...rest] = item.parts;
  const task = typeof first === 'string' ? TASK_RE.exec(first) : null;
  const parts = task && typeof first === 'string' ? [first.slice(task[0].length), ...rest] : item.parts;
  const body = parts.map((p) => (typeof p === 'string' ? inlineText(p) : p.html)).join('');
  if (!task) return `<li>${body}`;
  const done = task[1] !== ' ';
  const box = `<span class="task-box" role="img" aria-label="${done ? 'done' : 'not done'}">${icon(done ? 'boxOn' : 'boxOff')}</span>`;
  return `<li class="task${done ? ' done' : ''}">${box}${body}`;
}

/**
 * A paragraph: the run of lines nothing more specific claimed.
 *
 * Lines inside it are joined with `<br>` rather than a space. CommonMark would fold them,
 * and folding is wrong here: this text comes from an agent, whose line breaks are almost
 * always deliberate (a list of paths, a stack trace, a wrapped explanation it laid out
 * itself), and the chat converters in this directory preserve them too.
 */
function takeParagraph(lines: readonly string[], i: number, out: string[]): number {
  const body: string[] = [];
  let n = i;
  while (n < lines.length) {
    const line = lines[n] ?? '';
    // Stop at a blank line or at anything a more specific taker would claim on the next pass.
    if (line.trim() === '' || TAKERS.some((take) => take(lines, n, []) !== null)) break;
    body.push(line);
    n += 1;
  }
  // Defensive: a line that reached here must be consumed, or renderBlocks spins forever.
  if (body.length === 0) {
    body.push(lines[i] ?? '');
    n = i + 1;
  }
  out.push(`<p>${inlineText(body.join('\n'))}</p>`);
  return n - i;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline level
//
// Every entry point escapes first and scans after (see the header). The scanner emits a
// delimiter LITERALLY unless it can see the matching closer, which is the whole of stream
// safety at this level.
// ─────────────────────────────────────────────────────────────────────────────

/** Escape, scan for inline constructs, and turn hard line breaks into `<br>`. */
function inlineText(raw: string): string {
  return inline(escapeHtml(raw)).replace(/\n/g, '<br>');
}

/** What a scanner recognised: the HTML it produced, and where to resume. */
interface Match {
  html: string;
  next: number;
}

type Scanner = (s: string, i: number) => Match | null;

// Ordered by precedence. Code first, because a code span suppresses everything inside it —
// `` `**not bold**` `` has to come out as literal asterisks, and any other order gets that
// wrong.
const SCANNERS: readonly Scanner[] = [scanCode, scanLink, scanAutolink, scanEmphasis, scanStrike];

/**
 * Where a scanner can start: at one of its delimiter characters, or — scanAutolink — at an
 * `http://` or `https://`. A scanner that starts anywhere else has to be added here, or it will
 * only ever be tried right after one of these.
 */
const SCAN_START_RE = /[`[*_~]|https?:\/\//;

/**
 * Where the plain text starting at `from` ends: the next place a scanner can start, or the end.
 *
 * Everywhere else every scanner returns null and the character is copied as-is, so copying the
 * whole run in one step is the same output without five scanner calls per character. This runs on
 * every streaming edit, over every paragraph of the message.
 */
function plainRunEnd(s: string, from: number): number {
  const at = s.slice(from).search(SCAN_START_RE);
  return at < 0 ? s.length : from + at;
}

/** Index of the first `]` after position `i` of `s`, or `s.length` when there is none. */
function closingBracket(s: string, i: number): number {
  const at = s.indexOf(']', i + 1);
  return at < 0 ? s.length : at;
}

export function inline(s: string): string {
  let out = '';
  let i = 0;
  // A link's text runs to the first `]` after its `[`, so unless that `]` is followed by `(` no
  // link starts at this `[` — nor at any other before that `]`. Remembering where it is keeps a
  // paragraph of unmatched `[` linear: scanLink finding it again from every `[` took 0.8 s for
  // 20 000 of them.
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
    let hit: Match | null = null;
    // scanLink is the only scanner that starts at `[`, so a `[` no link can start at is literal.
    if (s[i] !== '[' || linkMayStart(i)) {
      for (const scan of SCANNERS) {
        hit = scan(s, i);
        if (hit) break;
      }
    }
    if (hit) {
      out += hit.html;
      i = hit.next;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/** A code span: a run of N backticks closed by the next run of exactly N. */
function scanCode(s: string, i: number): Match | null {
  if (s[i] !== '`') return null;
  const len = backtickRun(s, i);
  const from = i + len;
  const at = codeSpanClose(s, from, len);
  if (at < 0) return null; // unclosed → the backticks stay literal (stream safety)
  return { html: `<code>${s.slice(from, at)}</code>`, next: at + len };
}

/** How many backticks in a row start at `i`. */
function backtickRun(s: string, i: number): number {
  let len = 0;
  while (s[i + len] === '`') len += 1;
  return len;
}

/**
 * Where the run of exactly `len` backticks that closes a code span starts, searching from `from`;
 * -1 when there is none. Shared by `scanCode` and the table splitter, so a cell is cut around the
 * same code spans the cell's own text is then rendered with.
 */
function codeSpanClose(s: string, from: number, len: number): number {
  const fence = '`'.repeat(len);
  let at = s.indexOf(fence, from);
  // Skip a longer run: it is not this span's closer.
  while (at >= 0 && s[at + len] === '`') {
    at = s.indexOf(fence, at + len + 1);
  }
  return at;
}

/**
 * Schemes a link may carry.
 *
 * An allowlist, not a `javascript:` blocklist. The text being linked is agent output, and a
 * blocklist has to be right about every scheme a browser will ever accept (`data:`,
 * `vbscript:`, whitespace-and-case variants of each); an allowlist only has to be right
 * about the three that are useful here.
 */
const SAFE_URL_RE = /^(?:https?:\/\/|mailto:)/i;

/**
 * The one relative link that is kept: another topic of this page, `?t=<topic id>` — how the
 * gateway and an agent link a sub-agent's topic and the one that opened it (daemon/delegation.ts). Exactly eight hex digits, the only shape a
 * topic id has, so nothing else relative slips through; rendered without `target` and marked
 * `data-goto`, so the page switches to the topic in place instead of loading itself again.
 */
const TOPIC_LINK_RE = /^\?t=([0-9a-f]{8})$/;

function scanLink(s: string, i: number): Match | null {
  if (s[i] !== '[') return null;
  const m = /^\[([^\]]*)\]\(\s*([^\s)]*)\s*\)/.exec(s.slice(i));
  if (!m) return null;
  const url = m[2] ?? '';
  const label = inline(m[1] ?? '');
  const topic = TOPIC_LINK_RE.exec(url)?.[1];
  if (topic) return { html: `<a href="?t=${topic}" data-goto="${topic}">${label}</a>`, next: i + m[0].length };
  // An unsafe or relative href is dropped, not rendered as a dead link: the label is kept so
  // no text is lost, and nothing clickable is produced that this file cannot vouch for.
  if (!SAFE_URL_RE.test(url)) return { html: label, next: i + m[0].length };
  return { html: anchor(url, label), next: i + m[0].length };
}

/**
 * A bare URL in running text.
 *
 * Worth its own scanner because agents print far more bare URLs than markdown links — a
 * docs reference, a PR, a localhost address it just started — and a URL you cannot click is
 * a URL you have to select and copy.
 */
function scanAutolink(s: string, i: number): Match | null {
  if (s[i] !== 'h' || (i > 0 && /[\w/]/.test(s[i - 1] ?? ''))) return null;
  const m = /^https?:\/\/[^\s<>"']+/.exec(s.slice(i));
  if (!m) return null;
  // Trailing punctuation belongs to the sentence, not the URL. `&` is here because escaping
  // turned `&` into `&amp;`, so a trailing `;` would otherwise be eaten off the entity.
  const url = (m[0] ?? '').replace(/[.,:!?)\]]+$/, '');
  if (!url) return null;
  return { html: anchor(url, url), next: i + url.length };
}

function anchor(url: string, label: string): string {
  // The text is already escaped, and `"` inside it is already `&quot;`, so the attribute
  // cannot be broken out of. rel/target because these point off the operator's own page.
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/** `**strong**` / `__strong__` / `*em*` / `_em_`. */
function scanEmphasis(s: string, i: number): Match | null {
  const c = s[i];
  if (c !== '*' && c !== '_') return null;
  // `snake_case` is not emphasis. Underscores only delimit at a word boundary; asterisks
  // are unambiguous and keep working mid-word.
  if (c === '_' && /\w/.test(s[i - 1] ?? '')) return null;
  const double = s[i + 1] === c;
  const open = double ? c + c : c;
  return delimited(s, i, open, double ? 'strong' : 'em');
}

/** `~~struck~~`. */
function scanStrike(s: string, i: number): Match | null {
  if (s[i] !== '~' || s[i + 1] !== '~') return null;
  return delimited(s, i, '~~', 'del');
}

/**
 * The shared "find the closer or give up" step.
 *
 * Giving up means returning null, which makes the caller emit the delimiter as a literal
 * character — the stream-safety contract in one place, so no scanner can forget it.
 */
function delimited(s: string, i: number, open: string, tag: string): Match | null {
  const from = i + open.length;
  if (s[from] === undefined || /\s/.test(s[from] ?? '')) return null; // `a * b` is not emphasis
  const at = s.indexOf(open, from);
  if (at < 0) return null;
  const body = s.slice(from, at);
  if (body.trim() === '') return null;
  return { html: `<${tag}>${inline(body)}</${tag}>`, next: at + open.length };
}
