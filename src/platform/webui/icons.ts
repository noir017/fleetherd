/**
 * The web UI's icons, drawn by hand as inline SVG in place of the emoji and symbol glyphs the page
 * used to show.
 *
 * Why not the glyphs: an emoji is drawn by whichever font the reader's system has, so the same
 * page looked different on every machine, colour emoji ignored the palette, and a symbol a font
 * lacks renders as an empty box (the reason the power button was already an SVG — see page.ts).
 * An SVG here is the same on every screen, takes `currentColor` like the text around it, and
 * sits on the text's baseline.
 *
 * Only the web UI. Every other platform gets the same text it always did — a chat message has no
 * way to carry an SVG — so the emoji stay in what the gateway writes, and the page or the web
 * renderer swaps the ones it knows at display time. One it does not know (a `tools.emojiMap` or
 * `inbound.reactions` an operator set to something else) is shown as the emoji it is.
 *
 * Every icon is 24×24, unfilled, stroked in `currentColor` at 2 with round ends, like the four
 * that were in the page before; `.ic` (page.ts) sizes it to 1em, so it takes the font size of
 * whatever it replaces. Paths are written out by hand — no icon set is vendored.
 */

const PATHS = {
  // Page chrome.
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  gear:
    '<circle cx="12" cy="12" r="6.6"/><circle cx="12" cy="12" r="2.4"/>' +
    '<path stroke-width="2.6" stroke-linecap="butt" d="M18.6 12h3M16.67 16.67l2.12 2.12M12 18.6v3M7.33 16.67l-2.12 2.12M5.4 12h-3M7.33 7.33 5.21 5.21M12 5.4v-3M16.67 7.33l2.12-2.12"/>',
  star: '<path d="M12 3l2.53 6.12 6.6.51-5.04 4.3 1.55 6.44L12 16.9l-5.64 3.47 1.55-6.44-5.04-4.3 6.6-.51z"/>',
  chevronRight: '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
  chevronLeft: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
  chevronDown: '<path d="m5.5 9 6.5 6.5L18.5 9"/>',
  check: '<path d="m4.5 12.5 5 5L19.5 7"/>',
  cross: '<path d="M6 6l12 12M18 6 6 18"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>',
  // Marks in a menu's buttons (core: ● the current choice, ☑ / ☐ a toggle, ⌂ a workdir root).
  dot: '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
  boxOn: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12.3 2.8 2.8L16.2 9"/>',
  boxOff: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
  home: '<path d="M3.5 11.5 12 4l8.5 7.5"/><path d="M6.5 9.5V20h11V9.5"/>',
  // Lifecycle reactions (inbound.reactions: received, done, error).
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  done: '<circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.3"/>',
  failed: '<circle cx="12" cy="12" r="9.5"/><path d="m8.5 8.5 7 7M15.5 8.5l-7 7"/>',
  // Tool bubbles (tools.emojiMap and defaultEmoji), and the sub-agent's ↳.
  book: '<path d="M12 6.5C10 5 7 4.6 3 5v13c4-.4 7 0 9 1.5 2-1.5 5-1.9 9-1.5V5c-4-.4-7 0-9 1.5zM12 6.5v13"/>',
  pencil: '<path d="M15.5 4.5l4 4L8.5 19.5 4 20l.5-4.5zM13.5 6.5l4 4"/>',
  note:
    '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/>' +
    '<path d="M14 3v5h5M8.5 12.5h7M8.5 16.5h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  searchWeb:
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M4 10.5h13"/>' +
    '<path d="M10.5 4c1.7 1.8 2.5 4 2.5 6.5S12.2 15.2 10.5 17c-1.7-1.8-2.5-4-2.5-6.5S8.8 5.8 10.5 4z"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>' +
    '<path d="M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"/>',
  subagent: '<path d="M6 4v8a3 3 0 0 0 3 3h10.5"/><path d="m15.5 11 4 4-4 4"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** One icon's markup. `ic-<name>` names it for CSS and for tests; `extra` adds classes. */
export function icon(name: IconName, extra?: string): string {
  return (
    `<svg class="ic ic-${name}${extra ? ` ${extra}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`
  );
}

/** U+FE0F asks for the emoji presentation; it names the same symbol, so it is not part of the key. */
const bare = (glyph: string): string => glyph.replace(/️/g, '');

/**
 * The tool-bubble glyphs that have an icon: config/schema.ts's default `tools.emojiMap` and
 * `defaultEmoji` (a test fails if they drift apart), `↳` before a sub-agent's tool, and the ✓ / ✗
 * a finished tool ends with (core/tool-renderer.ts).
 */
const TOOL_GLYPHS: Readonly<Record<string, IconName>> = {
  '📖': 'book',
  '✏': 'pencil',
  '📝': 'note',
  '💻': 'terminal',
  '🔍': 'search',
  '🔎': 'searchWeb',
  '🗂': 'folder',
  '🌐': 'globe',
  '⚙': 'gear',
  '↳': 'subagent',
  '✓': 'check',
  '✗': 'cross',
};

/** A tool line's glyph as an icon, or undefined to leave it as the text it is. */
export function toolGlyph(glyph: string): string | undefined {
  const name = TOOL_GLYPHS[bare(glyph)];
  return name ? icon(name) : undefined;
}

/**
 * What the page's inline script uses, as a JavaScript object literal: every icon by name, the menu
 * marks and lifecycle reactions it swaps, keyed by the glyph core and config write.
 *
 * Inlined into a `<script>`, so a `<` is written as `<`: JSON alone would let a `</script>`
 * in a string end the element. None of the paths has one; this keeps it that way by construction.
 */
export function clientIcons(): string {
  const all = Object.fromEntries((Object.keys(PATHS) as IconName[]).map((n) => [n, icon(n)]));
  const marks: Record<string, string> = { '●': icon('dot'), '☑': icon('boxOn'), '☐': icon('boxOff'), '⌂': icon('home') };
  // Done and failed keep the green and red the emoji had; "seen" is not news, so it stays dim.
  const reactions: Record<string, string> = {
    '👀': icon('eye'),
    '✅': icon('done', 'tone-ok'),
    '❌': icon('failed', 'tone-err'),
  };
  return JSON.stringify({ icon: all, mark: marks, reaction: reactions }).replace(/</g, '\\u003c');
}
