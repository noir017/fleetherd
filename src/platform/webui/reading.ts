/**
 * Reading a file the agent sent on the page itself, instead of downloading it first.
 *
 * A report, a plan or a log the agent wrote is something to be read, and every other way of
 * reading one here went through the downloads folder and another application — on a phone, an
 * application that may not exist. So the page asks `server.ts` `view` for the file, and gets back
 * HTML this module built from its bytes, which it shows over the transcript.
 *
 * ── Never the file as itself ─────────────────────────────────────────────────
 * The download rule (`server.ts` `download`) is that nothing the agent sent is served as its own
 * type, because an `.html` or an `.svg` rendered on this origin would hold the session's cookie.
 * This does not bend that rule; it goes round it. The browser never receives the file — it
 * receives what `web-markdown.ts` (the XSS boundary, which escapes every character before it
 * builds a tag) made of it, or the file's text escaped whole inside a `<pre>`. That is the same
 * trust the page already extends to every message the agent streams, so an `.html` is on the list
 * below as source to be read, and is not, and cannot be, rendered.
 *
 * Deliberately absent: PDF and office documents. Their text is not in their bytes, so showing one
 * means a renderer — the browser's own PDF viewer, which a `sandbox` CSP turns off and which the
 * download rule exists to keep off this origin, or a library of several megabytes. Neither was
 * worth it for the first version; they stay downloads.
 */
import { escapeHtml, renderWebMarkdown } from '../web-markdown.js';

/** How a readable file is shown: through the markdown renderer, or as its text verbatim. */
export type ReadableKind = 'markdown' | 'text';

const MARKDOWN = new Set(['md', 'markdown']);

/**
 * Text an agent writes and sends, shown as it is. A closed list rather than "anything that decodes
 * as UTF-8", so the page can offer the button before anyone has read a byte — the decision rides on
 * the message (`WebMessage.file.view`), made here, the way `inlineImageType` makes the picture one.
 * Source formats a browser would execute (html, svg, js) are here on purpose: see the module doc.
 */
const TEXT = new Set([
  // prose and data
  'txt', 'text', 'log', 'out', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini',
  'cfg', 'conf', 'properties', 'xml', 'rst', 'adoc', 'org', 'tex', 'diff', 'patch',
  // markup and styles, as source
  'html', 'htm', 'svg', 'css', 'scss', 'less', 'vue',
  // code
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'scala', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'swift', 'php', 'pl', 'lua', 'r', 'sql',
  'graphql', 'proto', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'tf', 'hcl', 'nix', 'gradle', 'cmake',
]);

/** Whether a file of this name can be read on the page, and how. By extension only, like the pictures. */
export function readableKind(name: string): ReadableKind | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === undefined) return undefined;
  if (MARKDOWN.has(ext)) return 'markdown';
  if (TEXT.has(ext)) return 'text';
  return undefined;
}

/**
 * How much of a file is read for the page. Past this the reader shows the head and says so, and
 * the download link is how to get the rest. Not a protocol limit: the reply is one JSON body built
 * in memory and one DOM subtree, and a 40 MB log in either would freeze a phone before it showed a
 * line. Half a megabyte is a long report many times over.
 */
export const MAX_READ_BYTES = 512 * 1024;

/**
 * How far into a file to look for a NUL before calling it binary — git's own test and number
 * (`buffer_is_binary`, `FIRST_FEW_BYTES` 8000 in xdiff-interface.c). It catches a file merely
 * NAMED `.txt`, which would otherwise arrive as a screen of replacement characters.
 */
const SNIFF_BYTES = 8000;

export interface Reading {
  /** Safe to assign to `innerHTML`: built here or by `web-markdown.ts`, never passed through. */
  html: string;
  /** How many of the file's bytes it shows. Less than the file's size when it was cut. */
  shown: number;
  /**
   * The decoded head, for a `text` file only — what the page's code view is given to edit and
   * highlight. Markdown has no `text` on purpose: it is shown rendered, and a caller that got both
   * would have to choose, which is the decision this field exists to keep here.
   */
  text?: string;
}

/**
 * Render the head of a file for the reader, or `undefined` when its bytes are not text.
 *
 * `head` is at most `MAX_READ_BYTES` of a file `size` bytes long. A cut file is cut at a line
 * break where it can be, so the reader does not end halfway through a markdown line, and at a
 * character boundary always, so it does not end in a replacement character it invented.
 */
export function renderReading(kind: ReadableKind, head: Buffer, size: number): Reading | undefined {
  if (head.subarray(0, SNIFF_BYTES).includes(0)) return undefined;
  const end = head.length < size ? cutAt(head) : head.length;
  // Not fatal: a stray invalid byte becomes U+FFFD rather than costing the whole file. The
  // decoder also drops a leading BOM, which would otherwise sit in front of the first heading.
  const text = new TextDecoder('utf-8').decode(head.subarray(0, end)).replace(/\r\n?/g, '\n');
  if (kind === 'markdown') return { html: renderWebMarkdown(text), shown: end };
  // `text` beside the escaped HTML: the page's code view needs the source itself, and the `<pre>`
  // stays the answer for a browser that could not load the bundle. Both are cut at the same byte,
  // so what the two show is the same head of the same file.
  return { html: `<pre class="src"><code>${escapeHtml(text)}</code></pre>`, shown: end, text };
}

/**
 * Where to end a cut: after the last line break, or — when there is none in the second half, as
 * in a minified JSON whose only newline is near the top — before a partial UTF-8 sequence.
 */
function cutAt(head: Buffer): number {
  const nl = head.lastIndexOf(0x0a);
  if (nl >= head.length / 2) return nl + 1;
  // Walk back over continuation bytes (10xxxxxx) to the lead byte, which says how long its
  // sequence is meant to be. At most three continuations follow a lead, so this stops within four
  // bytes whatever the input; a run longer than that is malformed and left to the decoder.
  let lead = head.length - 1;
  while (lead > 0 && head.length - lead < 4 && ((head[lead] ?? 0) & 0xc0) === 0x80) lead -= 1;
  const b = head[lead] ?? 0;
  const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  return head.length - lead >= need ? head.length : lead;
}
