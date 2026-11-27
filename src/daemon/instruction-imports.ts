import path from 'node:path';

/**
 * Where an agent's OWN instructions are — the files its harness reads at user level besides the one
 * the gateway delivers (instructions.ts), and the files those reference — as the web UI's editor
 * lists them (instructions-panel.ts walks the machine; everything harness-specific is here, in one
 * table, `harnessSources`).
 *
 * The delivered file is the gateway's; what it references, and every other file the harness reads
 * by itself, is not. Those live on the machine the agent runs on, belong to whoever wrote them
 * there, and are read as they are: the gateway reads the harness's own rules for finding them, and
 * the files are the truth.
 *
 * ── Per harness ────────────────────────────────────────────────────────────────────────────────
 * Probed 2026-11-18 (project report "agent-instructions-refs"): each harness run in print mode from
 * a throwaway HOME, a random word in every candidate file, asked which words it was given; Claude
 * Code read out of its 2.1.322 bundle instead, not run.
 *  - claude 2.1.322 — `@path` references (below), followed four hops; `~/.claude/rules/**.md` read
 *    too, each a file that may reference more.
 *  - codebuddy 2.181.0 — the same `@path`, without the backslash escape (a path ends at the first
 *    whitespace); four hops measured, though its own docs say five; `~/.codebuddy/rules/**.md`.
 *  - agy 1.5.9 — `@[label](path)` includes, one level only, expanded inside code blocks too (its
 *    regex is `@\[([^\]]*)\]\(([^)]+)\)`). It reads `~/.gemini/{AGENTS,GEMINI}.md` and
 *    `~/.gemini/config/GEMINI.md` besides the delivered `config/AGENTS.md`, and
 *    `~/.gemini/config/rules/**.md` — at start only a rule whose frontmatter says
 *    `trigger: always_on`. A relative include in `config/AGENTS.md` or `config/GEMINI.md` resolves
 *    against `~/.gemini`, not the file's own directory.
 *  - opencode 2.2.5 — nothing inside a file; the `instructions` array of its global config lists
 *    more: `~/` against the home, absolute as written, globs expanded, URLs fetched (not files, so
 *    not listed), and a relative entry against each conversation's directory — no one file.
 *  - codex 0.165.0 — no references. `~/.codex/AGENTS.override.md`, when it exists, is read INSTEAD
 *    of `AGENTS.md`, which takes the delivered text away from codex while it is there.
 *  - atomcode, and the harnesses with no delivered file — nothing known, so nothing listed.
 * A harness's own override of its directory (CODEX_HOME, XDG_CONFIG_HOME) is not followed, as in
 * instructions.ts.
 *
 * ── Claude Code's `@` references ─────────────────────────────────────────────────────────────────
 * From the 2.1.322 bundle's CLAUDE.md loader: `@` at the start of a text or after whitespace, then
 * everything up to the next whitespace with `\ ` standing for a space —
 * `/(?:^|\s)@((?:[^\s\\]|\\ )+)/g`; a `#…` suffix cut off; what remains counts only if it starts
 * `./`, `~/` or `/` (not `/` alone), or else does not start with `@` or a run of `#%^&*()` and does
 * start with a letter, digit, `.`, `_` or `-` (so a quoted path is not one); nothing in a code block,
 * a code span or an HTML comment; relative against the directory of the file's REAL path; a file
 * with an extension outside its text types skipped, and anything under /dev or /proc. Root at depth
 * 0, nothing read at depth 5 (`Flo = 5`): four hops.
 *
 * The markdown is read here by a line scanner rather than the lexer the harness uses: fenced code
 * blocks, code spans and HTML comments are recognized; an indented code block, and a reference
 * wrapped in emphasis or a link's text, are not. A listed reference the harness would not load is
 * still a real file, opened as itself.
 */

/** The extensions Claude Code reads a reference of (2.1.322's own set); one without any is read too. */
export const IMPORT_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    '.md .txt .text .json .yaml .yml .toml .xml .csv .html .htm .css .scss .sass .less .js .ts .tsx .jsx .mjs .cjs .mts ' +
    '.cts .py .pyi .pyw .rb .erb .rake .go .rs .java .kt .kts .scala .c .cpp .cc .cxx .h .hpp .hxx .cs .swift .sh .bash ' +
    '.zsh .fish .ps1 .bat .cmd .env .ini .cfg .conf .config .properties .sql .graphql .gql .proto .vue .svelte .astro ' +
    '.ejs .hbs .pug .jade .php .pl .pm .lua .r .dart .ex .exs .erl .hrl .clj .cljs .cljc .edn .hs .lhs .elm .ml .mli ' +
    '.f .f90 .f95 .for .cmake .make .makefile .gradle .sbt .rst .adoc .asciidoc .org .tex .latex .lock .log .diff .patch'
  ).split(' ')
);

// ── markdown ────────────────────────────────────────────────────────────────────────────────────

/** The text a `@path` harness scans: code blocks, code spans and HTML comments removed. */
export function scannableText(text: string): string {
  const out: string[] = [];
  let fence: { ch: string; len: number } | undefined;
  let block: string[] = [];
  const flush = (): void => {
    if (block.length) out.push(stripInline(block.join('\n')));
    block = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close?.[1] && close[1][0] === fence.ch && close[1].length >= fence.len) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    // A backtick fence's info string may not hold a backtick (CommonMark 4.5); one that does is text.
    if (open?.[1] && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
      flush();
      fence = { ch: open[1][0] as string, len: open[1].length };
      continue;
    }
    if (!line.trim()) flush();
    else block.push(line);
  }
  flush();
  return out.join('\n\n');
}

/**
 * One paragraph's text without its HTML comments and code spans. A comment may run across lines
 * within it; an unclosed one hides the rest, as a browser's parser would. A code span is a run of
 * backticks closed by a run of the same length (CommonMark 6.1); an unmatched run is literal.
 */
function stripInline(block: string): string {
  return block.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, ' ');
}

// ── claude ──────────────────────────────────────────────────────────────────────────────────────

/** Claude Code's references in one file, as written (the header says how they are found). */
export function claudeReferences(text: string): string[] {
  const seen = new Set<string>();
  const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
  const body = scannableText(text);
  for (let m = re.exec(body); m; m = re.exec(body)) {
    let ref = m[1] ?? '';
    const hash = ref.indexOf('#');
    if (hash !== -1) ref = ref.slice(0, hash);
    ref = ref.replaceAll('\\ ', ' ');
    if (ref && claudeAccepts(ref)) seen.add(ref);
  }
  return [...seen];
}

function claudeAccepts(ref: string): boolean {
  if (ref.startsWith('./') || ref.startsWith('~/')) return true;
  if (ref.startsWith('/')) return ref !== '/';
  return !ref.startsWith('@') && !/^[#%^&*()]+/.test(ref) && /^[a-zA-Z0-9._-]/.test(ref);
}

/** `~/` against the home, absolute as written, relative against the holding file's real directory. */
function againstFile(ref: string, real: string, home: string): string {
  const P = path.posix;
  if (ref.startsWith('~/')) return P.join(home, ref.slice(2));
  return P.isAbsolute(ref) ? P.normalize(ref) : P.join(P.dirname(real), ref);
}

/** Claude Code's resolution, with what it refuses to read: a non-text extension, /dev, /proc. */
export function resolveClaudeReference(ref: string, file: { real: string }, home: string): string | undefined {
  const abs = againstFile(ref, file.real, home);
  if (/^\/(?:dev|proc)(?:\/|$)/.test(abs)) return undefined;
  const ext = path.posix.extname(abs).toLowerCase();
  if (ext && !IMPORT_TEXT_EXTENSIONS.has(ext)) return undefined;
  return abs;
}

// ── codebuddy ───────────────────────────────────────────────────────────────────────────────────

/** CodeBuddy's: the same scan, the path ending at the first whitespace, no escape (measured). */
export function codebuddyReferences(text: string): string[] {
  const seen = new Set<string>();
  const re = /(?:^|\s)@([^\s]+)/g;
  const body = scannableText(text);
  for (let m = re.exec(body); m; m = re.exec(body)) if (m[1]) seen.add(m[1]);
  return [...seen];
}

export function resolveAgainstFile(ref: string, file: { real: string }, home: string): string | undefined {
  return againstFile(ref, file.real, home);
}

// ── agy ─────────────────────────────────────────────────────────────────────────────────────────

/** agy's includes: `@[label](path)` anywhere, code blocks included; the path as written, spaces and all. */
export function agyReferences(text: string): string[] {
  const seen = new Set<string>();
  const re = /@\[([^\]]*)\]\(([^)]+)\)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) if (m[2]) seen.add(m[2]);
  return [...seen];
}

/** agy's base for a relative include: `~/.gemini` for the two standalone files under config/, else the file's own. */
export function resolveAgyReference(ref: string, file: { path: string; real: string }, home: string): string {
  const P = path.posix;
  const standalone = [P.join(home, '.gemini', 'config', 'AGENTS.md'), P.join(home, '.gemini', 'config', 'GEMINI.md')];
  if (!ref.startsWith('~/') && !P.isAbsolute(ref) && standalone.includes(file.path)) return P.join(home, '.gemini', ref);
  return againstFile(ref, file.real, home);
}

/** A rule agy injects at start says `trigger: always_on` in its frontmatter; any other waits to be chosen. */
export function agyRuleNote(text: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const always = front?.[1] && /^trigger:\s*["']?always_on["']?\s*$/m.test(front[1]);
  return always ? undefined : 'not read at start: only a rule whose frontmatter says trigger: always_on is';
}

// ── opencode ────────────────────────────────────────────────────────────────────────────────────

/** The `instructions` entries of an opencode config, which may be JSONC (comments, trailing commas). */
export function opencodeInstructions(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return [];
  }
  const list = (parsed as { instructions?: unknown } | null)?.instructions;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/** JSON with its comments and trailing commas taken out — strings left exactly as they are. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Whether a path has a glob in it, which then has to be expanded on the machine. */
export function hasGlob(p: string): boolean {
  return /[*?[{]/.test(p);
}

/** A glob as a regex over absolute paths: `**` any depth, `*` and `?` within one segment, `{a,b}`. */
export function globRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:[^/]*/)*' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += `(?:${glob.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
        i = end;
      }
    } else if (ch === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) re += '\\[';
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|\\/]/g, '\\$&');
}

/** The directory a glob's expansion starts from: its segments before the first wildcard. */
export function globBase(glob: string): string {
  const parts = glob.split('/');
  const fixed: string[] = [];
  for (const part of parts) {
    if (hasGlob(part)) break;
    fixed.push(part);
  }
  return fixed.join('/') || '/';
}
