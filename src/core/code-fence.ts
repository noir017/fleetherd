/**
 * A fenced code block across a message boundary.
 *
 * A reply does not always arrive as one message. The turn runner starts a new message at every
 * tool call and every picture (`daemon/turn-runner.ts`), and nothing guarantees a harness calls a
 * tool between blocks rather than inside one. A browser-driven harness reports the page's steps as
 * tool calls while the answer's text is still arriving, so a step can land anywhere in that text. On
 * 2026-11-20 one landed just before the closing fence of a reply's last code block. The closing
 * ``` then opened the next message, every renderer took it for an opening fence, and the reply's
 * closing paragraph and its footer showed as code. Each message is rendered on its own, so whether
 * a block is still open has to be carried from one message to the next. These functions do that:
 *
 *   - `fenceAfter` says which fence a text leaves open, given the one open before it;
 *   - `closeFence` closes it at the end of a message, so no message is left open — which also keeps a
 *     footer appended after the text from being swallowed by an unclosed block;
 *   - `continueFence` starts the next message inside the block again: it drops the line that closes
 *     the block when that is how the text begins, and otherwise reopens the block with the fence and
 *     info string it had.
 *
 * Fences are read the way `stream-buffer.ts`'s chunker reads them, with any indentation, because a
 * model writes the command for step 2 indented under the list item, where the web renderer
 * (`platform/web-markdown.ts` takeItemFence) still reads it as a fence. Unlike the chunker, a
 * `~~~` fence counts as a fence here, and so does a closing run longer than the opener, as
 * CommonMark has it. Pure: no state, no IO.
 */

/** A fenced code block still open at the end of some text: what opened it. */
export interface OpenFence {
  /** The run of backticks or tildes that opened it; a closer is the same character, at least as many. */
  readonly marker: string;
  /** The info string after it (`ts`, `diff`), so a reopened block is labelled and coloured the same. */
  readonly info: string;
}

const OPENER_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const CLOSER_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

function opener(line: string): OpenFence | undefined {
  const m = OPENER_RE.exec(line);
  if (!m) return undefined;
  const marker = m[1] ?? '';
  const info = (m[2] ?? '').trim();
  // A backtick fence's info string may not contain a backtick (CommonMark 4.5): ```` ```a``` ```` on
  // a line of its own is an inline code span, not a block.
  if (marker.startsWith('`') && info.includes('`')) return undefined;
  return { marker, info };
}

function closes(line: string, open: OpenFence): boolean {
  const run = CLOSER_RE.exec(line)?.[1];
  return run !== undefined && run[0] === open.marker[0] && run.length >= open.marker.length;
}

/**
 * The line a closer can still grow into: only the fence's character so far. A message streaming in
 * may have sent the first backtick of a closer, and deciding before the newline would put a reopened
 * block in front of what turns out to be the line that closes it.
 */
function mayClose(line: string, open: OpenFence): boolean {
  const t = line.trim();
  return [...t].every((c) => c === open.marker[0]);
}

/** The fence left open at the end of `text`, starting inside `before` when one is given. */
export function fenceAfter(text: string, before?: OpenFence): OpenFence | undefined {
  let open = before;
  for (const line of text.split('\n')) {
    if (open) {
      if (closes(line, open)) open = undefined;
    } else {
      open = opener(line);
    }
  }
  return open;
}

/**
 * `text` with the fence it leaves open closed on a line of its own, or `text` itself when it closes
 * everything it opens. Only ever appends, so a message already on screen stays a prefix of it.
 */
export function closeFence(text: string): string {
  const open = fenceAfter(text);
  if (!open || text.trim() === '') return text;
  return `${text}${text.endsWith('\n') ? '' : '\n'}${open.marker}`;
}

/**
 * The text of a message that continues a reply whose previous message ended inside `open`.
 *
 * When its first line with anything on it closes the block, that line goes — with the blank lines
 * before it, which are the block's last lines, and those after it, which would only open the message
 * with a gap. Otherwise the block is reopened in front of the text, and the text is the rest of it.
 *
 * Stream-safe: this runs on every flush of a message still arriving, and its answer only grows.
 * Until that first line is whole and could still turn out to be the closer, it returns '' — nothing
 * to show yet — and once it has decided, the decision does not change. `final` says the text is all
 * there is, so an unfinished last line is taken as it stands.
 */
export function continueFence(text: string, open: OpenFence | undefined, final: boolean): string {
  if (!open) return text;
  let at = 0;
  for (;;) {
    const nl = text.indexOf('\n', at);
    const line = text.slice(at, nl < 0 ? text.length : nl);
    if (line.trim() === '') {
      if (nl < 0) return '';
      at = nl + 1;
      continue;
    }
    const whole = nl >= 0 || final;
    if (!whole && mayClose(line, open)) return '';
    if (closes(line, open)) {
      // Nothing but blank lines after the closer is nothing to show yet, not a message of spaces.
      const rest = nl < 0 ? '' : text.slice(nl + 1);
      return rest.trim() === '' ? '' : rest.replace(/^(?:[ \t]*\n)+/, '');
    }
    return `${open.marker}${open.info}\n${text}`;
  }
}
