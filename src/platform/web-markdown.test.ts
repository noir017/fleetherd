import { describe, it, expect } from 'vitest';

import { renderWebMarkdown, renderWebToolLines, escapeHtml } from './web-markdown.js';
import { formatDuration } from '../core/tool-renderer.js';

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
        '<pre><code class="language-json">{\n  &quot;command&quot;: &quot;ls&quot;\n}</code></pre>' +
        tl('📖 Read: &quot;a.md&quot;') +
        '</div>'
    );
  });

  it('drops blank lines rather than drawing empty rows', () => {
    expect(renderWebToolLines('\n💻 Bash: "ls"\n\n')).toBe(`<div class="tools">${tl('💻 Bash: &quot;ls&quot;')}</div>`);
  });
});

describe('renderWebMarkdown: links to another topic', () => {
  it('keeps `?t=<topic id>` as an in-page link the page switches to', () => {
    expect(renderWebMarkdown('[quantlab](?t=3a9f0c12)')).toContain('<a href="?t=3a9f0c12" data-goto="3a9f0c12">quantlab</a>');
  });

  it('drops every other relative link, keeping its label', () => {
    for (const url of ['?t=3a9f0c1', '?t=3a9f0c12&x=1', '/api/topics', '?topic=3a9f0c12', 'javascript:alert(1)']) {
      const html = renderWebMarkdown(`[x](${url})`);
      expect(html, url).not.toContain('<a');
      expect(html, url).toContain('x');
    }
  });
});
