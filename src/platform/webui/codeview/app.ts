/**
 * The page's code view — CodeMirror 6, bundled into the daemon's own assets.
 *
 * This module holds all of it. `index.ts` is the entry and exists only to load this one through a
 * dynamic import: see the note there about why the split is not cosmetic.
 *
 * ── Why this is a bundle and not more of `page.ts` ──────────────────────────
 * `page.ts` is one inline script string with no module system, and the page's CSP is built
 * around that. A syntax-highlighting editor is a library of a few hundred kilobytes with its
 * own parser and DOM layer; it cannot be written by hand into that string, and it must not be
 * fetched from a CDN (nothing on this page is loaded from anywhere). So it is bundled here by
 * `scripts/build-webui-assets.mjs` and served from `/assets/`, which is the one route the CSP
 * admits as a same-origin script. `page.ts` `codeView()` is the only loader.
 *
 * Every language is a dynamic import, so esbuild emits one chunk per language and the browser
 * downloads only the grammar the file it is showing needs. The base editor is one shared chunk.
 *
 * ── The surface other branches build on ─────────────────────────────────────
 * `editor`, `diff` and `highlighter` are the whole API; the names and shapes are fixed by
 * `CodeViewApi` and reached only through `page.ts` `codeView()`. A git diff panel, a file editor or
 * a reply's code block is a caller, never a second implementation — so everything they share
 * (language lookup, the palette, read-only, Mac/PC save) is decided once, here.
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  HighlightStyle,
  Language,
  LanguageSupport,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { highlightTree, tags } from '@lezer/highlight';

export interface EditorOptions {
  doc: string;
  /** The file's name; only its extension is read (see `LANG`). */
  name: string;
  readOnly?: boolean;
  onChange?(doc: string): void;
  /** Ctrl/Cmd-S. `preventDefault` is the editor's, so the browser's save dialog never opens. */
  onSave?(): void;
}

export interface EditorHandle {
  getDoc(): string;
  setDoc(doc: string): void;
  focus(): void;
  destroy(): void;
}

export interface DiffSelection {
  side: 'old' | 'new';
  /** 1-based line numbers, both ends inclusive of what `lineAt` reports. */
  from: number;
  to: number;
  text: string;
}

export interface DiffOptions {
  name: string;
  original: string;
  modified: string;
  layout: 'unified' | 'split';
  /** `null` when the selection is emptied — a reader has simply clicked somewhere else. */
  onSelect?(sel: DiffSelection | null): void;
}

export interface DiffHandle {
  setLayout(layout: 'unified' | 'split'): void;
  destroy(): void;
}

/**
 * One coloured run of a highlighted text: `[from, to, classes]`, offsets into the text, in order
 * and never overlapping. Text between runs is plain. The classes are the palette's (`highlight`),
 * whose rules `highlighter` puts on the page.
 */
export type HighlightSpan = [number, number, string];

/** Highlight one text, synchronously, with a grammar already loaded. */
export type Highlight = (code: string) => HighlightSpan[];

export interface CodeViewApi {
  editor(parent: HTMLElement, options: EditorOptions): EditorHandle;
  diff(parent: HTMLElement, options: DiffOptions): DiffHandle;
  /**
   * The colouring for a code fence's language, once its grammar has loaded: null when no grammar
   * here is that language, a rejection when the grammar's chunk would not load.
   */
  highlighter(lang: string): Promise<Highlight | null>;
}

/**
 * Extension → grammar. Every value is a dynamic import so esbuild splits it out; two keys that
 * name the same module share one chunk (`ts` and `js` both come from `lang-javascript`).
 *
 * A file whose extension is not listed opens as plain text rather than as another language:
 * highlighting a language with the wrong grammar is worse than none. This list is about
 * highlighting only, and is narrower than `reading.ts`'s — that one decides whether a file may be
 * read here at all, so `csv`, `log` or `toml` are readable and simply have no grammar to colour.
 */
const LANG: Record<string, () => Promise<Extension>> = {
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  mts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  cts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  htm: () => import('@codemirror/lang-html').then((m) => m.html()),
  vue: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  scss: () => import('@codemirror/lang-css').then((m) => m.css()),
  less: () => import('@codemirror/lang-css').then((m) => m.css()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  svg: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  c: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  h: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cc: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cxx: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  hpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  // No official package for a shell: the legacy stream mode is the grammar CodeMirror 5 shipped,
  // and it is both small and good enough for the logs and scripts this page is asked to show.
  sh: () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  bash: () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  zsh: () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  fish: () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  diff: () => import('@codemirror/legacy-modes/mode/diff').then((m) => StreamLanguage.define(m.diff)),
  patch: () => import('@codemirror/legacy-modes/mode/diff').then((m) => StreamLanguage.define(m.diff)),
};

/**
 * A grammar by its `LANG` key. Own keys only: the table is an object literal, and an extension or
 * fence name of `constructor` would otherwise find Object's constructor and call it as a loader.
 */
function grammar(key: string): (() => Promise<Extension>) | undefined {
  return Object.prototype.hasOwnProperty.call(LANG, key) ? LANG[key] : undefined;
}

/** The grammar for a file name, from its extension alone — the same rule `reading.ts` uses. */
function langFor(name: string): (() => Promise<Extension>) | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext === undefined ? undefined : grammar(ext);
}

/**
 * The names a code fence uses that are not already a `LANG` key: fences name a language
 * (```typescript, ```python, ```shell), files an extension.
 */
const FENCE_NAMES: Readonly<Record<string, string>> = {
  javascript: 'js',
  node: 'js',
  typescript: 'ts',
  python: 'py',
  python3: 'py',
  golang: 'go',
  rust: 'rs',
  shell: 'sh',
  shellscript: 'sh',
  'c++': 'cpp',
  jsonc: 'json',
  json5: 'json',
  xhtml: 'html',
};

/**
 * The grammar for a fence's info string. Never a patch's: web-markdown.ts colours a diff fence by
 * its lines' first characters before it reaches the page, and a grammar re-colouring it here
 * would throw that away for less.
 */
function fenceGrammar(lang: string): (() => Promise<Extension>) | undefined {
  const name = lang.toLowerCase();
  const key = Object.prototype.hasOwnProperty.call(FENCE_NAMES, name) ? (FENCE_NAMES[name] ?? name) : name;
  return key === 'diff' || key === 'patch' ? undefined : grammar(key);
}

/**
 * Load a grammar into a compartment, once. A grammar that fails to load leaves the editor
 * usable and plain: the file is still readable, and the console says which chunk did not come.
 */
function applyLang(
  name: string,
  compartment: Compartment,
  dispatch: (tr: { effects: StateEffect<unknown> }) => void
): void {
  const load = langFor(name);
  if (!load) return;
  load()
    .then((ext) => dispatch({ effects: compartment.reconfigure(ext) }))
    .catch((e: unknown) => {
      console.warn('[webui] a code language failed to load, showing plain text:', e);
    });
}

/**
 * The palette, in the page's own CSS variables where there is one (`page.ts` `:root`) so the
 * editor follows the page instead of carrying a second copy of the colours. The tokens are a
 * dark palette tuned against `--bg: #131313`; there is no light one, for the same reason the
 * page has none.
 */
const theme = EditorView.theme(
  {
    '&': { color: 'var(--fg)', backgroundColor: 'var(--bg)', fontSize: '13px', height: '100%' },
    '.cm-content': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      padding: '10px 0',
      caretColor: 'var(--fg)',
    },
    '.cm-line': { padding: '0 12px' },
    '.cm-scroller': { lineHeight: '1.55' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg)',
      color: 'var(--dim)',
      border: 'none',
      borderRight: '1px solid var(--line)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.035)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#2c4a6b',
    },
    // The merge view's own decorations: an added line reads green, a removed one red, both
    // dimmed enough to sit under the text. `@codemirror/merge` names these classes.
    '.cm-changedLine': { backgroundColor: 'rgba(74,222,128,.09)' },
    '.cm-changedText': { background: 'rgba(74,222,128,.22)' },
    '.cm-deletedChunk': { backgroundColor: 'rgba(248,113,113,.07)' },
    '.cm-deletedText': { background: 'rgba(248,113,113,.2)' },
    '.cm-mergeView': { height: '100%' },
    '.cm-mergeView &': { height: '100%' },
    '.cm-mergeViewEditors': { height: '100%' },
  },
  { dark: true }
);

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: '#c792ea' },
  { tag: [tags.atom, tags.bool, tags.number, tags.null], color: '#f78c6c' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: '#c3e88d' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: '#6b7683', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: '#82aaff' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.name)], color: '#ffcb6b' },
  { tag: [tags.propertyName, tags.attributeName], color: '#b2ccd6' },
  { tag: [tags.tagName, tags.deleted], color: '#f07178' },
  { tag: [tags.operator, tags.meta, tags.processingInstruction], color: '#89ddff' },
  { tag: [tags.link, tags.url], color: '#8fa6c0', textDecoration: 'underline' },
  { tag: [tags.heading1, tags.heading2, tags.heading3], color: '#dcdcdc', fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.invalid, color: '#f87171' },
  { tag: tags.inserted, color: '#4ade80' },
]);

/**
 * Put the palette's rules on the page, once, for colouring done outside an editor.
 *
 * `HighlightStyle` keeps its colours in a style module whose class names it generated, and an
 * editor mounts that module when it is created — so with no editor open (a reply's code block is
 * not one) the classes `highlightTree` hands out would style nothing. A plain `<style>` with the
 * module's own rules is the same thing the editor does, without importing `style-mod` for it: the
 * CSP admits inline style, and an editor mounting the module later only repeats identical rules.
 */
let paletteMounted = false;
function mountPalette(): void {
  if (paletteMounted) return;
  paletteMounted = true;
  const rules = highlight.module?.getRules();
  if (!rules) return;
  const el = document.createElement('style');
  el.textContent = rules;
  document.head.appendChild(el);
}

/** The language a grammar's extension carries: a `LanguageSupport`, or a stream language itself. */
function languageOf(ext: Extension): Language | null {
  if (ext instanceof LanguageSupport) return ext.language;
  return ext instanceof Language ? ext : null;
}

/**
 * Colour a code fence the way the editor colours a file: the same grammars, the same palette.
 *
 * Static — one parse and a walk of the tree, no editor, no DOM. The page asks for this only once a
 * message has stopped changing, and builds the coloured text itself from the spans, as text nodes:
 * nothing here produces markup, so nothing the agent printed can become any.
 */
export function highlighter(lang: string): Promise<Highlight | null> {
  const load = fenceGrammar(lang);
  if (!load) return Promise.resolve(null);
  return load().then((ext) => {
    const language = languageOf(ext);
    if (!language) return null;
    mountPalette();
    return (code: string): HighlightSpan[] => {
      const spans: HighlightSpan[] = [];
      highlightTree(language.parser.parse(code), highlight, (from, to, classes) => {
        spans.push([from, to, classes]);
      });
      return spans;
    };
  });
}

/** What every editor here has, read-only or not. */
function base(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(highlight),
    keymap.of(defaultKeymap),
    keymap.of(historyKeymap),
    theme,
  ];
}

/** The facets that make an editor read-only, kept together so no caller applies half of them. */
const READ_ONLY: Extension[] = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

function handle(view: EditorView): EditorHandle {
  return {
    getDoc: () => view.state.doc.toString(),
    setDoc: (doc) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

export function editor(parent: HTMLElement, o: EditorOptions): EditorHandle {
  const lang = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: o.doc,
      extensions: [
        ...base(),
        // Long lines wrap: this is read (and edited) on phones, where horizontal scrolling a
        // 3000-character line is not reading.
        EditorView.lineWrapping,
        lang.of([]),
        ...(o.readOnly ? READ_ONLY : []),
        // Ctrl and Cmd both, because `Mod-` is whatever the platform calls it — and the page is
        // used from both a Mac and a Windows machine against the same daemon.
        ...(o.onSave
          ? [
              keymap.of([
                {
                  key: 'Mod-s',
                  preventDefault: true,
                  run: () => {
                    o.onSave?.();
                    return true;
                  },
                },
              ]),
            ]
          : []),
        ...(o.onChange
          ? [
              EditorView.updateListener.of((u) => {
                if (u.docChanged) o.onChange?.(u.state.doc.toString());
              }),
            ]
          : []),
        EditorView.contentAttributes.of({ 'aria-label': o.name }),
      ],
    }),
  });
  applyLang(o.name, lang, (tr) => view.dispatch(tr));
  return handle(view);
}

/** Report the main selection of one side, as 1-based lines. */
function selectionReporter(side: 'old' | 'new', o: DiffOptions): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.selectionSet || !o.onSelect) return;
    const range = u.state.selection.main;
    if (range.empty) return o.onSelect(null);
    const { doc } = u.state;
    o.onSelect({
      side,
      from: doc.lineAt(range.from).number,
      to: doc.lineAt(range.to).number,
      text: u.state.sliceDoc(range.from, range.to),
    });
  });
}

/** The two panes, each read-only, with the merge view's own alignment and change gutters. */
function splitView(parent: HTMLElement, o: DiffOptions): MergeView {
  const langA = new Compartment();
  const langB = new Compartment();
  const view = new MergeView({
    parent,
    a: { doc: o.original, extensions: [...base(), ...READ_ONLY, langA.of([]), selectionReporter('old', o)] },
    b: { doc: o.modified, extensions: [...base(), ...READ_ONLY, langB.of([]), selectionReporter('new', o)] },
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  });
  applyLang(o.name, langA, (tr) => view.a.dispatch(tr));
  applyLang(o.name, langB, (tr) => view.b.dispatch(tr));
  return view;
}

/** One column: the new text with removed lines shown above it, as a patch reads. */
function unifiedView(parent: HTMLElement, o: DiffOptions): EditorView {
  const lang = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: o.modified,
      extensions: [
        ...base(),
        ...READ_ONLY,
        ...unifiedMergeView({
          original: o.original,
          highlightChanges: true,
          gutter: true,
          mergeControls: false,
          syntaxHighlightDeletions: true,
          collapseUnchanged: { margin: 3, minSize: 6 },
        }),
        lang.of([]),
        selectionReporter('new', o),
      ],
    }),
  });
  applyLang(o.name, lang, (tr) => view.dispatch(tr));
  return view;
}

export function diff(parent: HTMLElement, o: DiffOptions): DiffHandle {
  let layout = o.layout;
  let view: MergeView | EditorView | null = null;
  let disposed = false;

  const render = (): void => {
    // `MergeView` and `EditorView` are two different shapes; rebuilding on a layout change is
    // the only supported switch between them (the package's own `reconfigure` keeps the layout).
    view?.destroy();
    parent.textContent = '';
    view = layout === 'split' ? splitView(parent, o) : unifiedView(parent, o);
  };

  render();

  return {
    setLayout: (next) => {
      if (next === layout || disposed) return;
      layout = next;
      render();
    },
    destroy: () => {
      if (disposed) return;
      disposed = true;
      view?.destroy();
      view = null;
      parent.textContent = '';
    },
  };
}

const api: CodeViewApi = { editor, diff, highlighter };

export default api;
