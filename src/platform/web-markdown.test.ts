import { describe, it, expect } from 'vitest';

import { renderWebMarkdown, renderWebToolLines, escapeHtml, inline } from './web-markdown.js';
import { formatDuration } from '../core/tool-renderer.js';
import { icon } from './webui/icons.js';

/** A fenced block as codeBlock frames it: the bar (language, Wrap, Copy) over the pre. */
const cb = (lang: string, code: string): string =>
  `<div class="cb"><div class="cb-h"><span class="cb-lang">${lang}</span>` +
  `<button type="button" class="cb-b" data-cb="wrap" title="Wrap long lines" aria-label="Wrap long lines" aria-pressed="false">${icon('wrap')}</button>` +
  `<button type="button" class="cb-b" data-cb="copy" title="Copy" aria-label="Copy code">${icon('copy')}</button>` +
  `</div><pre><code${lang ? ` class="language-${lang}"` : ''}>${code}</code></pre></div>`;

/**
 * The security half of these tests is not about markdown at all.
 *
 * This converter is the only place in the repo that produces HTML for a DOM, and its input
 * is agent output — which carries the raw bytes of every file the agent read and every
 * command it ran. A regression here is script execution in the operator's browser, not a
 * formatting bug, so the escaping assertions are written to fail loudly on any output that
 * contains markup this file did not construct itself.
 */
describe('web-markdown: escaping is unconditional', () => {
  it('never emits an unescaped tag from input', () => {
    const html = renderWebMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes inside code spans and fences, where an author might assume raw text is fine', () => {
    expect(renderWebMarkdown('`<img onerror=x>`')).toContain('<code>&lt;img onerror=x&gt;</code>');
    expect(renderWebMarkdown('```\n<img onerror=x>\n```')).toContain('&lt;img onerror=x&gt;');
    expect(renderWebMarkdown('```\n<img onerror=x>\n```')).not.toContain('<img');
  });

  it('escapes quotes so a link label cannot break out of an attribute', () => {
    const html = renderWebMarkdown('[a" onmouseover="alert(1)](https://e.com)');
    expect(html).not.toMatch(/onmouseover="/);
    expect(html).toContain('&quot;');
  });

  it('escapes the language label of a fence', () => {
    expect(renderWebMarkdown('```"><script>\nx\n```')).not.toContain('<script>');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    '/etc/passwd',
  ])('drops the href of an unsafe or relative scheme (%s) but keeps the text', (url) => {
    const html = renderWebMarkdown(`[click](${url})`);
    expect(html).not.toContain('href');
    expect(html).toContain('click');
  });

  it.each(['https://e.com/x', 'http://e.com/x', 'mailto:a@e.com'])('links %s', (url) => {
    expect(renderWebMarkdown(`[t](${url})`)).toContain(`<a href="${url}" target="_blank" rel="noopener noreferrer">t</a>`);
  });

  it('keeps an ampersand in a URL spelled as an entity, which is what an attribute wants', () => {
    expect(renderWebMarkdown('[t](https://e.com/?a=1&b=2)')).toContain('href="https://e.com/?a=1&amp;b=2"');
  });

  it('escapeHtml covers every character HTML gives meaning to', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

/**
 * Stream safety. Every one of these inputs is a real intermediate state: the converter runs
 * on each streaming edit, so it sees a construct's opening delimiter one flush before its
 * closer. An unbalanced tag here does not just mis-render one message — it swallows the
 * formatting of everything after it in the same node.
 */
describe('web-markdown: half-received input stays literal', () => {
  it.each([
    ['**bold', '**bold'],
    ['*em', '*em'],
    ['~~struck', '~~struck'],
    ['`code', '`code'],
  ])('leaves %s as literal text', (src, want) => {
    const html = renderWebMarkdown(src);
    expect(html).toContain(want);
    expect(html).not.toMatch(/<(strong|em|del|code|a)\b/);
  });

  it('leaves a half-typed link as literal brackets, and still links the URL inside it', () => {
    // Deliberate, not an accident of ordering: the `[…](…)` construct is not rewritten until
    // its closing paren arrives, but the href half of it is already a real URL the moment it
    // is on screen. Keeping the brackets literal is the stream-safety half; linking the URL
    // anyway is what stops the last flush of every streamed link from being unclickable.
    const html = renderWebMarkdown('[label](https://e.com');
    expect(html).toContain('[label](');
    expect(html).toContain('href="https://e.com"');
  });

  it('emits balanced tags once the closer arrives', () => {
    expect(renderWebMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(renderWebMarkdown('*em*')).toContain('<em>em</em>');
    expect(renderWebMarkdown('~~s~~')).toContain('<del>s</del>');
  });

  it('holds a table as a paragraph until its separator row arrives', () => {
    expect(renderWebMarkdown('| a | b |')).not.toContain('<table>');
    expect(renderWebMarkdown('| a | b |\n|---|---|')).toContain('<table>');
  });

  it('renders an unterminated fence as an open code block rather than flickering through a paragraph', () => {
    const html = renderWebMarkdown('```js\nconst x = 1;');
    expect(html).toContain('<pre><code class="language-js">const x = 1;</code></pre>');
  });

  it('never produces an odd number of tags for a truncated stream of a long reply', () => {
    const full = '# H\n\nsome **bold** and `code`\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n';
    for (let n = 1; n <= full.length; n += 1) {
      const html = renderWebMarkdown(full.slice(0, n));
      const opens = (html.match(/<(?!\/)[a-z]/g) ?? []).length;
      const closes = (html.match(/<\//g) ?? []).length;
      // <hr> and <br> are void; everything else this file emits is paired.
      const voids = (html.match(/<(hr|br)>/g) ?? []).length;
      expect(opens - voids).toBe(closes);
    }
  });
});

describe('web-markdown: blocks', () => {
  it('renders headings and strips the closing sequence', () => {
    expect(renderWebMarkdown('## Title ##')).toBe('<h2>Title</h2>');
    expect(renderWebMarkdown('###### six')).toBe('<h6>six</h6>');
  });

  it('does not treat a bare # as a heading', () => {
    expect(renderWebMarkdown('#notaheading')).toBe('<p>#notaheading</p>');
  });

  it('renders horizontal rules', () => {
    expect(renderWebMarkdown('---')).toBe('<hr>');
    expect(renderWebMarkdown('***')).toBe('<hr>');
  });

  it('recurses into blockquotes so a list inside one still works', () => {
    expect(renderWebMarkdown('> - a\n> - b')).toBe('<blockquote><ul><li>a</li><li>b</li></ul></blockquote>');
  });

  it('keeps an agent line break instead of folding it', () => {
    expect(renderWebMarkdown('one\ntwo')).toBe('<p>one<br>two</p>');
  });

  it('renders a table, padding ragged rows', () => {
    const html = renderWebMarkdown('| a | b |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |');
    expect(html).toContain('<th>a</th><th>b</th>');
    expect(html).toContain('<tr><td>1</td><td></td></tr>');
    expect(html).toContain('<tr><td>2</td><td>3</td></tr>');
  });
});

describe('web-markdown: lists', () => {
  it('nests by indentation and closes every level', () => {
    expect(renderWebMarkdown('- a\n  - b\n- c')).toBe('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  });

  it('dedents more than one level at once', () => {
    expect(renderWebMarkdown('- a\n  - b\n    - c\n- d')).toBe(
      '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>'
    );
  });

  it('treats a numbered run at the same indent as its own list', () => {
    expect(renderWebMarkdown('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });

  it('folds an indented continuation line into the item above it', () => {
    expect(renderWebMarkdown('- a\n  more')).toBe('<ul><li>a<br>more</li></ul>');
  });

  it('resumes a numbered list at the number written, not at 1', () => {
    // The paragraph ends the first list, so "2." opens a second one. Renumbering that one from
    // 1 is how a hand-written "1. … 2. …" came back as "1. … 1. …" in the web UI.
    expect(renderWebMarkdown('1. a\n\nbreak\n\n2. b')).toBe(
      '<ol><li>a</li></ol><p>break</p><ol start="2"><li>b</li></ol>'
    );
  });

  it('starts a numbered run following a bulleted one at its own number', () => {
    expect(renderWebMarkdown('- a\n3. b')).toBe('<ul><li>a</li></ul><ol start="3"><li>b</li></ol>');
  });

  it('leaves a list that does begin at 1 without a start attribute', () => {
    expect(renderWebMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });
});

/**
 * Whether every tag opened is closed, in order. Stronger than counting: `<li><div></li></div>` has
 * as many closers as openers and still takes the rest of the message into the wrong element.
 * Self-closing SVG shapes (`<path …/>`) and `<br>` / `<hr>` close themselves.
 */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (self || name === 'br' || name === 'hr') continue;
    if (!close) stack.push(name ?? '');
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

/** Every tag name in a piece of HTML, so a test can say which ones this file may write. */
const tagNames = (html: string): string[] => [...new Set([...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ''))];

describe('web-markdown: code blocks', () => {
  it('frames a fence with its language, Wrap and Copy', () => {
    expect(renderWebMarkdown('```ts\nconst a = 1;\n```')).toBe(cb('ts', 'const a = 1;'));
  });

  it('frames a fence with no language too, with no label and no language class', () => {
    expect(renderWebMarkdown('```\nplain\n```')).toBe(cb('', 'plain'));
  });

  it('escapes the language wherever it is written, label and class alike', () => {
    const html = renderWebMarkdown('```a"onclick=x<img>\nx\n```');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/"onclick/);
    expect(html).toContain('<span class="cb-lang">a&quot;onclick=x&lt;img&gt;</span>');
    expect(html).toContain('<code class="language-a&quot;onclick=x&lt;img&gt;">');
  });

  it('colours a patch line by line, leaving the file names and the context plain', () => {
    const src = '--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n same';
    expect(renderWebMarkdown(`\`\`\`diff\n${src}\n\`\`\``)).toBe(
      cb(
        'diff',
        '--- a/x.ts\n+++ b/x.ts\n<span class="ph">@@ -1,2 +1,2 @@</span>\n' +
          '<span class="pd">-const a = 1;</span>\n<span class="pa">+const a = 2;</span>\n same'
      )
    );
  });

  it('colours `patch` and any case of the name, and nothing else by its first character', () => {
    expect(renderWebMarkdown('```patch\n+a\n```')).toContain('<span class="pa">+a</span>');
    expect(renderWebMarkdown('```DIFF\n-a\n```')).toContain('<span class="pd">-a</span>');
    expect(renderWebMarkdown('```md\n- a\n```')).not.toContain('class="pd"');
  });

  it('escapes each line of a patch inside the span it is given', () => {
    const html = renderWebMarkdown('```diff\n+<img src=x onerror=alert(1)>\n-"></span><script>\n```');
    expect(html).not.toMatch(/<(img|script)/);
    expect(html).toContain('<span class="pa">+&lt;img src=x onerror=alert(1)&gt;</span>');
    expect(html).toContain('<span class="pd">-&quot;&gt;&lt;/span&gt;&lt;script&gt;</span>');
  });

  it('keeps the code element\'s text the fence\'s text exactly, coloured or not, so Copy takes what was written', () => {
    const src = '@@ -1 +1 @@\n-a & b\n+a < b\n ctx\n';
    const html = renderWebMarkdown(`\`\`\`diff\n${src}\`\`\``);
    const code = /<code[^>]*>([\s\S]*)<\/code>/.exec(html)?.[1] ?? '';
    const text = code.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    expect(text).toBe(src.slice(0, -1));
  });

  it('colours a patch still streaming in, line by line as it arrives', () => {
    expect(renderWebMarkdown('```diff\n+one\n-tw')).toBe(cb('diff', '<span class="pa">+one</span>\n<span class="pd">-tw</span>'));
  });
});

describe('web-markdown: a fence inside a list item', () => {
  it('renders the fence as a block in its item rather than as one inline code span', () => {
    // The case from the report: the continuation path trimmed the lines, joined them with <br>, and
    // the backticks made the whole block a single <code>.
    expect(renderWebMarkdown('- item 1\n  ```js\n  const a = 1;\n  ```\n- item 2')).toBe(
      `<ul><li>item 1${cb('js', 'const a = 1;')}</li><li>item 2</li></ul>`
    );
  });

  it('strips the fence\'s own indent from its lines and keeps deeper indentation', () => {
    expect(renderWebMarkdown('1. step\n   ```py\n   def f():\n       return 1\n   ```\n   then this\n2. next')).toBe(
      `<ol><li>step${cb('py', 'def f():\n    return 1')}then this</li><li>next</li></ol>`
    );
  });

  it('keeps an unclosed fence open to the end of the input, as a fence anywhere does while streaming', () => {
    expect(renderWebMarkdown('- a\n  ```sh\n  echo hi')).toBe(`<ul><li>a${cb('sh', 'echo hi')}</li></ul>`);
  });

  it('does not read the code\'s own lines as list items or end the list at a blank line inside it', () => {
    expect(renderWebMarkdown('- a\n  ```yaml\n  - b: 1\n\n  - c: 2\n  ```\n- d')).toBe(
      `<ul><li>a${cb('yaml', '- b: 1\n\n- c: 2')}</li><li>d</li></ul>`
    );
  });

  it('still nests an item that follows the fence under the same parent', () => {
    expect(renderWebMarkdown('- a\n  ```\n  x\n  ```\n  - b\n- c')).toBe(
      `<ul><li>a${cb('', 'x')}<ul><li>b</li></ul></li><li>c</li></ul>`
    );
  });
});

describe('web-markdown: table cells', () => {
  /** The cells of a table's first row, as rendered: th for the header. */
  const heads = (src: string): string[] => [...renderWebMarkdown(src).matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1] ?? '');

  it('does not split a cell at an escaped pipe in a code span, and keeps the last column', () => {
    // The case from the report: three cells came out as `test`, `` `a \ `` and `` b` ``, and desc was lost.
    expect(heads('| test | `a \\| b` | desc |\n| --- | --- | --- |')).toEqual(['test', '<code>a | b</code>', 'desc']);
  });

  it('does not split a cell at a bare pipe inside a code span either', () => {
    const html = renderWebMarkdown('| cmd | note |\n|---|---|\n| `ls | wc -l` | count |');
    expect(html).toContain('<tr><td><code>ls | wc -l</code></td><td>count</td></tr>');
  });

  it('reads `\\|` outside code as a pipe in the cell', () => {
    expect(heads('| a \\| b | c |\n|---|---|')).toEqual(['a | b', 'c']);
  });

  it('splits at a pipe after a backtick that is never closed, as it will once the row is complete', () => {
    expect(heads('| `a | b |\n|---|---|')).toEqual(['`a', 'b']);
  });

  it('keeps an empty last cell but drops the one the closing pipe would make', () => {
    expect(heads('| a | |\n|---|---|')).toEqual(['a', '']);
    expect(heads('a | b\n---|---')).toEqual(['a', 'b']);
  });

  it('puts the table in a frame of its own, which is what scrolls on a phone', () => {
    expect(renderWebMarkdown('| a |\n|---|\n| 1 |')).toBe(
      '<div class="tbl"><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></div>'
    );
  });
});

describe('web-markdown: task lists', () => {
  const box = (done: boolean): string =>
    `<span class="task-box" role="img" aria-label="${done ? 'done' : 'not done'}">${icon(done ? 'boxOn' : 'boxOff')}</span>`;

  it('draws [ ] and [x] as the page\'s box icons in place of the bullet', () => {
    expect(renderWebMarkdown('- [ ] todo\n- [x] done\n- [X] also')).toBe(
      `<ul><li class="task">${box(false)}todo</li><li class="task done">${box(true)}done</li>` +
        `<li class="task done">${box(true)}also</li></ul>`
    );
  });

  it('reads [x](…) as a link, not a ticked box', () => {
    expect(renderWebMarkdown('- [x](https://e.com) link')).toBe(
      '<ul><li><a href="https://e.com" target="_blank" rel="noopener noreferrer">x</a> link</li></ul>'
    );
  });

  it('leaves a box still streaming in as the characters it is', () => {
    expect(renderWebMarkdown('- [')).toBe('<ul><li>[</li></ul>');
    expect(renderWebMarkdown('- [x')).toBe('<ul><li>[x</li></ul>');
    expect(renderWebMarkdown('- [x]')).toBe(`<ul><li class="task done">${box(true)}</li></ul>`);
  });

  it('nests and keeps inline markup in the item', () => {
    expect(renderWebMarkdown('- [ ] a\n  - [x] **b**')).toBe(
      `<ul><li class="task">${box(false)}a<ul><li class="task done">${box(true)}<strong>b</strong></li></ul></li></ul>`
    );
  });
});

describe('web-markdown: the new blocks under stream and attack', () => {
  const long =
    '1. step\n   ```sh\n   npm i | tee log\n   ```\n2. [x] done **ok**\n\n' +
    '| cmd | out |\n|---|---|\n| `a \\| b` | `x | y` |\n\n' +
    '```diff\n@@ -1 +1 @@\n-old\n+new\n```\n';

  it('keeps every tag balanced at every truncation of a reply that uses them all', () => {
    for (let n = 1; n <= long.length; n += 1) {
      const html = renderWebMarkdown(long.slice(0, n));
      expect(balanced(html), `cut at ${n}: ${html}`).toBe(true);
    }
  });

  it('writes no tag of the input\'s into a list fence, a table cell, a task or a patch', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = renderWebMarkdown(
      `- [x] ${hostile}\n  \`\`\`html\n  ${hostile}\n  \`\`\`\n\n| \`${hostile} | y\` | ${hostile} |\n|---|---|\n\n\`\`\`diff\n+${hostile}\n\`\`\``
    );
    expect(html).not.toContain('<img');
    const allowed = ['div', 'span', 'button', 'svg', 'path', 'rect', 'pre', 'code', 'ul', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];
    expect(tagNames(html).filter((t) => !allowed.includes(t))).toEqual([]);
  });
});

describe('web-markdown: inline', () => {
  it('suppresses markup inside a code span', () => {
    expect(renderWebMarkdown('`**not bold**`')).toContain('<code>**not bold**</code>');
    expect(renderWebMarkdown('`**not bold**`')).not.toContain('<strong>');
  });

  it('leaves snake_case alone', () => {
    expect(renderWebMarkdown('foo_bar_baz')).toBe('<p>foo_bar_baz</p>');
  });

  it('does not read a lone asterisk between spaces as emphasis', () => {
    expect(renderWebMarkdown('a * b * c')).toBe('<p>a * b * c</p>');
  });

  it('links a bare URL and leaves the sentence punctuation out of it', () => {
    const html = renderWebMarkdown('see https://e.com/x.');
    expect(html).toContain('href="https://e.com/x"');
    expect(html).toContain('</a>.');
  });

  it('does not autolink a URL that is already the href of a markdown link', () => {
    const html = renderWebMarkdown('[t](https://e.com)');
    expect((html.match(/<a /g) ?? []).length).toBe(1);
  });

  it('handles a longer backtick run around a span containing backticks', () => {
    expect(renderWebMarkdown('``a ` b``')).toContain('<code>a ` b</code>');
  });
});

describe('web-markdown: a tool bubble', () => {
  /** One line's markup: the part that folds, and the finish mark that stays in view when there is one. */
  const tl = (body: string, mark?: string): string =>
    `<div class="tl"><span class="tl-c">${body}</span>${mark ? `<span class="tl-s">${mark}</span>` : ''}</div>`;

  it('gives every tool line an element of its own', () => {
    // One element per line is what the page folds and opens. Through renderWebMarkdown the lines
    // would merge into a single paragraph, and there would be nothing to click.
    const html = renderWebToolLines('💻 Bash: "ls" ✓ 5ms\n📖 Read: "a.md"');
    expect(html).toBe(`<div class="tools">${tl('💻 Bash: &quot;ls&quot;', ' ✓ 5ms')}${tl('📖 Read: &quot;a.md&quot;')}</div>`);
  });

  it('keeps the finish mark apart from the command, in both of the shapes a duration takes', () => {
    // Folding cuts the end of a long line, and the end is where ✓ says the tool is done. The
    // shapes come from the renderer's own formatter, so a change to it fails here, not on screen.
    for (const ms of [832, 1_240, 61_000]) {
      for (const mark of ['✓', '✗']) {
        const suffix = ` ${mark} ${formatDuration(ms)}`;
        expect(renderWebToolLines(`💻 Bash: "make"${suffix}`)).toBe(`<div class="tools">${tl('💻 Bash: &quot;make&quot;', suffix)}</div>`);
      }
    }
  });

  it('leaves a ✓ that is part of the command where it is', () => {
    // Only the END of a line is the renderer's mark; a running tool has none.
    expect(renderWebToolLines('💻 Bash: "echo ✓ 5ms done"')).toBe(`<div class="tools">${tl('💻 Bash: &quot;echo ✓ 5ms done&quot;')}</div>`);
  });

  it('shows a command exactly as it was run, with no markdown read into it', () => {
    // Commands and paths are what inline markdown mangles: a glob opens emphasis, a snake_case
    // name opens another, and a backtick in a shell line opens a code span.
    const line = '💻 Bash: "grep -rn foo_bar_baz *.ts | sed `s/x/y/` **"';
    const html = renderWebToolLines(line);
    expect(html).not.toMatch(/<(em|strong|code)>/);
    expect(html).toContain('foo_bar_baz *.ts | sed `s/x/y/` **');
  });

  it('escapes a line as unconditionally as a reply', () => {
    const html = renderWebToolLines('💻 Bash: "echo <img src=x onerror=alert(1)>"');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders verbose mode\'s argument dump as the code block it is, outside the lines', () => {
    const html = renderWebToolLines('💻 Bash: "ls"\n```json\n{\n  "command": "ls"\n}\n```\n📖 Read: "a.md"');
    expect(html).toBe(
      '<div class="tools">' +
        tl('💻 Bash: &quot;ls&quot;') +
        cb('json', '{\n  &quot;command&quot;: &quot;ls&quot;\n}') +
        tl('📖 Read: &quot;a.md&quot;') +
        '</div>'
    );
  });

  it('drops blank lines rather than drawing empty rows', () => {
    expect(renderWebToolLines('\n💻 Bash: "ls"\n\n')).toBe(`<div class="tools">${tl('💻 Bash: &quot;ls&quot;')}</div>`);
  });

  describe('with a glyph swap (the web UI icons)', () => {
    /** Marks what was swapped, so a test sees exactly which glyphs were asked about. */
    const glyph = (g: string): string | undefined => (g === '🦀' ? undefined : `<i>${g}</i>`);

    it('swaps the head emoji and the finish mark, and escapes the rest as before', () => {
      expect(renderWebToolLines('💻 Bash: "a <b>" ✓ 5ms', glyph)).toBe(
        `<div class="tools">${tl('<i>💻</i> Bash: &quot;a &lt;b&gt;&quot;', ' <i>✓</i> 5ms')}</div>`
      );
    });

    it("finds the emoji after a sub-agent's ↳ and its name, and takes no ` · ` in the preview for a name", () => {
      expect(renderWebToolLines('↳ fix tests · ✏️ Edit: "a.ts"\n↳ 📖 Read: "x · y.md"', glyph)).toBe(
        '<div class="tools">' +
          tl('<i>↳</i> fix tests · <i>✏️</i> Edit: &quot;a.ts&quot;') +
          tl('<i>↳</i> <i>📖</i> Read: &quot;x · y.md&quot;') +
          '</div>'
      );
    });

    it('leaves a glyph the swap has nothing for as the text it is, and a line with no emoji alone', () => {
      expect(renderWebToolLines('↳ 🦀 Cargo: "build"\n↳ * Custom: "x"\nplain: "✓ 5ms"', glyph)).toBe(
        '<div class="tools">' +
          tl('<i>↳</i> 🦀 Cargo: &quot;build&quot;') +
          tl('<i>↳</i> * Custom: &quot;x&quot;') +
          tl('plain: &quot;✓ 5ms&quot;') +
          '</div>'
      );
    });

    it('a name cannot smuggle markup through the swap', () => {
      const html = renderWebToolLines('↳ <img src=x> · 💻 Bash: "ls"', glyph);
      expect(html).not.toContain('<img');
      expect(html).toContain('<i>↳</i> &lt;img src=x&gt; · <i>💻</i> Bash');
    });
  });
});

describe('renderWebMarkdown: links to another topic', () => {
  it('keeps `?t=<topic id>` as an in-page link the page switches to', () => {
    expect(renderWebMarkdown('[shop-api](?t=3a9f0c12)')).toContain('<a href="?t=3a9f0c12" data-goto="3a9f0c12">shop-api</a>');
  });

  it('drops every other relative link, keeping its label', () => {
    for (const url of ['?t=3a9f0c1', '?t=3a9f0c12&x=1', '/api/topics', '?topic=3a9f0c12', 'javascript:alert(1)']) {
      const html = renderWebMarkdown(`[x](${url})`);
      expect(html, url).not.toContain('<a');
      expect(html, url).toContain('x');
    }
  });
});

/**
 * Pinned from the per-character scan, before inline learned to copy plain runs whole and to skip a
 * `[` no link can start at (2026-11-07). The point is that those changed only the speed: some of
 * these outputs are quirks of the scanner (`****d****`, `[](x)` losing its brackets), and they are
 * here because they must not move, not because they are right.
 */
describe('inline output is unchanged by the fast paths', () => {
  const CASES: Array<[string, string]> = [
    ["plain words, then `code`, a [link](https://x.y/a?b=1&c=2), **bold**, __bold__, *it*, _it_, ~~gone~~ — and 中文 🙂", "plain words, then <code>code</code>, a <a href=\"https://x.y/a?b=1&amp;c=2\" target=\"_blank\" rel=\"noopener noreferrer\">link</a>, <strong>bold</strong>, <strong>bold</strong>, <em>it</em>, <em>it</em>, <del>gone</del> — and 中文 🙂"],
    ["file_name_here and (_x_) and a_b_ and x__y__ and __z__ and _a_b", "file_name_here and (<em>x</em>) and a_b_ and x__y__ and <strong>z</strong> and <em>a</em>b"],
    ["[not a link] and [also](not closed and **open and ~~open and `open", "[not a link] and [also](not closed and **open and ~~open and `open"],
    ["[[[[[a](https://x) ]] [b] [c](d)", "<a href=\"https://x\" target=\"_blank\" rel=\"noopener noreferrer\">[[[[a</a> ]] [b] c"],
    ["*a* **b** ***c*** ****d**** *e **f** g*", "<em>a</em> <strong>b</strong> <strong>*c</strong>* *<strong>*d</strong>** <em>e </em><em>f</em>* g*"],
    ["trailing delimiters: * _ ~ ` [ ](", "trailing delimiters: * _ ~ ` [ ]("],
    ["中文**加粗**中文_斜体_中文~~删~~中文`码`中文", "中文<strong>加粗</strong>中文<em>斜体</em>中文<del>删</del>中文<code>码</code>中文"],
    ["5 * 3 * 2 and a * b and a*b*c", "5 * 3 * 2 and a * b and a<em>b</em>c"],
    ["see https://example.com/a_b*c, xhttps://no, http://ok. and [t](javascript:x) h h ht htt http https:/ https://", "see <a href=\"https://example.com/a_b*c\" target=\"_blank\" rel=\"noopener noreferrer\">https://example.com/a_b*c</a>, xhttps://no, <a href=\"http://ok\" target=\"_blank\" rel=\"noopener noreferrer\">http://ok</a>. and t h h ht htt http https:/ https://"],
    ["[a]b](c) [a](b c) [](x) [x]() [x] (y)", "[a]b](c) [a](b c)  x [x] (y)"],
    ["<b> & \"q\" 's' &amp; <script>", "&lt;b&gt; &amp; &quot;q&quot; &#39;s&#39; &amp;amp; &lt;script&gt;"],
    ["😀*😀*😀_😀_😀~~😀~~😀`😀`😀[😀](u)", "😀<em>😀</em>😀<em>😀</em>😀<del>😀</del>😀<code>😀</code>😀😀"],
    ["``double `tick` code`` and ```triple``` and `` unclosed", "<code>double `tick` code</code> and <code>triple</code> and `` unclosed"],
    ["**bold `code **not bold** inside` still bold**", "<strong>bold `code </strong>not bold** inside` still bold**"],
  ];

  it.each(CASES)('case %#', (input, expected) => {
    expect(inline(escapeHtml(input))).toBe(expected);
  });

  // A paragraph reaches inline() whole, newlines included, so a link and its `]` can be lines apart.
  const BLOCKS: Array<[string, string]> = [
    ["line one [x\nline two](https://a) and *em\nacross* lines, see http://h.example/x_y\nhttps://next.line", "<p>line one <a href=\"https://a\" target=\"_blank\" rel=\"noopener noreferrer\">x<br>line two</a> and <em>em<br>across</em> lines, see <a href=\"http://h.example/x_y\" target=\"_blank\" rel=\"noopener noreferrer\">http://h.example/x_y</a><br><a href=\"https://next.line\" target=\"_blank\" rel=\"noopener noreferrer\">https://next.line</a></p>"],
    ["[open\n[no close here\n\nnew para [a](https://b) [c]\n(d) [e](https://f)", "<p>[open<br>[no close here</p><p>new para <a href=\"https://b\" target=\"_blank\" rel=\"noopener noreferrer\">a</a> [c]<br>(d) <a href=\"https://f\" target=\"_blank\" rel=\"noopener noreferrer\">e</a></p>"],
    ["# head *i* [l](https://l)\n\n| a | *b* |\n|---|---|\n| [x](https://x) | `y` |\n\n- item **b** [\n- item ]( no", "<h1>head <em>i</em> <a href=\"https://l\" target=\"_blank\" rel=\"noopener noreferrer\">l</a></h1><div class=\"tbl\"><table><thead><tr><th>a</th><th><em>b</em></th></tr></thead><tbody><tr><td><a href=\"https://x\" target=\"_blank\" rel=\"noopener noreferrer\">x</a></td><td><code>y</code></td></tr></tbody></table></div><ul><li>item <strong>b</strong> [</li><li>item ]( no</li></ul>"],
  ];

  it.each(BLOCKS)('block %#', (input, expected) => {
    expect(renderWebMarkdown(input)).toBe(expected);
  });

  it('keeps a paragraph of unmatched [ literal, without rescanning it from every [', () => {
    // Each `[` used to re-read the rest of the paragraph for its `]`: 20 000 took 0.8 s and these
    // 100 000 about 20 s, against a few milliseconds now. Measured, because the test timeout cannot
    // be the assertion: it never interrupts a synchronous test. The bound leaves a loaded machine
    // two orders of magnitude.
    const line = '['.repeat(100_000);
    const t0 = performance.now();
    expect(inline(line)).toBe(line);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
