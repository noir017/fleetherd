import { describe, it, expect } from 'vitest';
import { flattenInline, flattenMarkdown } from './plaintext-markdown.js';

describe('flattenInline', () => {
  it('strips bold/italic/strikethrough markers and keeps the word', () => {
    expect(flattenInline('**b**')).toBe('b');
    expect(flattenInline('__b__')).toBe('b');
    expect(flattenInline('*i*')).toBe('i');
    expect(flattenInline('_i_')).toBe('i');
    expect(flattenInline('~~x~~')).toBe('x');
  });

  it('strips inline-code backticks but keeps the content', () => {
    expect(flattenInline('`code`')).toBe('code');
    expect(flattenInline('run `npm test` now')).toBe('run npm test now');
  });

  it('rewrites a link to `text (url)` so the target is not lost', () => {
    expect(flattenInline('[docs](https://x.com/a)')).toBe('docs (https://x.com/a)');
  });

  it('recurses into link display text and emphasis', () => {
    expect(flattenInline('[**hi**](https://x.com/a)')).toBe('hi (https://x.com/a)');
    expect(flattenInline('**a _b_ c**')).toBe('a b c');
  });

  it('leaves an unclosed delimiter as literal text (stream safety)', () => {
    expect(flattenInline('**not closed')).toBe('**not closed');
  });

  it('does not flatten underscores inside a word (file_name stays literal)', () => {
    expect(flattenInline('file_name_here')).toBe('file_name_here');
  });

  it('does not parse markdown inside inline code', () => {
    expect(flattenInline('`a **b** c`')).toBe('a **b** c');
  });

  it('leaves plain text untouched', () => {
    expect(flattenInline('just plain words')).toBe('just plain words');
  });
});

describe('flattenMarkdown blocks', () => {
  it('strips ATX heading markers', () => {
    expect(flattenMarkdown('# Title')).toBe('Title');
    expect(flattenMarkdown('### Deeper **bold** head')).toBe('Deeper bold head');
  });

  it('keeps a fenced code block body verbatim, dropping the fences and language', () => {
    expect(flattenMarkdown('```ts\nconst x = 1;\nfoo();\n```')).toBe('const x = 1;\nfoo();');
  });

  it('does not flatten markdown-looking characters inside a code block', () => {
    expect(flattenMarkdown('```\n**not bold** | a | b\n```')).toBe('**not bold** | a | b');
  });

  it('treats an unclosed fence at end-of-stream as a code block (stream safety)', () => {
    expect(flattenMarkdown('```\nhalf')).toBe('half');
  });

  it('rewrites a GFM table into title + bullet groups with no pipes', () => {
    const md = '| Name | Score |\n|------|-------|\n| Ada | 95 |';
    expect(flattenMarkdown(md)).toBe('Ada\n• Score: 95');
  });

  it('rewrites a multi-row table into back-to-back groups', () => {
    const md = '| Name | Score |\n|------|-------|\n| Ada | 95 |\n| Bob | 88 |';
    expect(flattenMarkdown(md)).toBe('Ada\n• Score: 95\nBob\n• Score: 88');
  });

  it('converts unordered list markers to bullets, keeping inline text clean', () => {
    expect(flattenMarkdown('- **a**\n* b\n+ c')).toBe('• a\n• b\n• c');
  });

  it('keeps ordered list numbers', () => {
    expect(flattenMarkdown('1. first\n2. **second**')).toBe('1. first\n2. second');
  });

  it('strips blockquote markers, keeping the quoted text plain', () => {
    expect(flattenMarkdown('> one\n> two')).toBe('one\ntwo');
  });

  it('preserves blank lines between paragraphs', () => {
    expect(flattenMarkdown('a\n\nb')).toBe('a\n\nb');
  });

  it('trims trailing blank lines (no dangling newline)', () => {
    expect(flattenMarkdown('text\n\n')).toBe('text');
  });

  it('returns empty string for empty input', () => {
    expect(flattenMarkdown('')).toBe('');
  });

  it('leaves no stray markdown chars across a mixed document', () => {
    const md = [
      '# Report',
      '',
      'Status is **green** and uses `cache`.',
      '',
      '- item *one*',
      '- [link](https://x.com/a)',
      '',
      '| Col A | Col B |',
      '|-------|-------|',
      '| 1 | 2 |',
      '',
      '```js',
      'const k = 1;',
      '```',
      '',
      '> quoted note',
    ].join('\n');
    const out = flattenMarkdown(md);
    // No emphasis markers, heading hashes, or raw table pipes survive.
    expect(out).not.toMatch(/\*\*/);
    expect(out).not.toMatch(/^#/m);
    expect(out).not.toContain('|');
    // The link target is preserved as `text (url)`.
    expect(out).toContain('link (https://x.com/a)');
    // The code body survives, the fences do not.
    expect(out).toContain('const k = 1;');
    expect(out).not.toContain('```');
  });
});

/**
 * Pinned from the per-character scan, before flattenInline learned to copy plain runs whole and
 * to skip a `[` no link can start at (2026-11-07). The point is that those changed only the speed:
 * some of these outputs are quirks of the parser (`***c***`, a code span inside bold), and they are
 * here because they must not move, not because they are right.
 */
describe('flattenInline output is unchanged by the fast paths', () => {
  const CASES: Array<[string, string]> = [
    ["plain words, then `code`, a [link](https://x.y/a?b=1&c=2), **bold**, __bold__, *it*, _it_, ~~gone~~ — and 中文 🙂", "plain words, then code, a link (https://x.y/a?b=1&c=2), bold, bold, it, it, gone — and 中文 🙂"],
    ["file_name_here and (_x_) and a_b_ and x__y__ and __z__ and _a_b", "file_name_here and (x) and a_b_ and x__y__ and z and _a_b"],
    ["[not a link] and [also](not closed and **open and ~~open and `open", "[not a link] and [also](not closed and **open and ~~open and `open"],
    ["[[[[[a](https://x) ]] [b] [c](d)", "[[[[a (https://x) ]] [b] c (d)"],
    ["*a* **b** ***c*** ****d**** *e **f** g*", "a b *c *d *e f* g"],
    ["trailing delimiters: * _ ~ ` [ ](", "trailing delimiters: * _ ~ ` [ ]("],
    ["中文**加粗**中文_斜体_中文~~删~~中文`码`中文", "中文加粗中文斜体中文删中文码中文"],
    ["5 * 3 * 2 and a * b and a*b*c", "5  3  2 and a  b and ab*c"],
    ["see https://example.com/a_b*c, xhttps://no, http://ok. and [t](javascript:x) h h ht htt http https:/ https://", "see https://example.com/a_b*c, xhttps://no, http://ok. and t (javascript:x) h h ht htt http https:/ https://"],
    ["[a]b](c) [a](b c) [](x) [x]() [x] (y)", "[a]b](c) [a](b c) [](x) [x]() [x] (y)"],
    ["<b> & \"q\" 's' &amp; <script>", "<b> & \"q\" 's' &amp; <script>"],
    ["😀*😀*😀_😀_😀~~😀~~😀`😀`😀[😀](u)", "😀😀😀😀😀😀😀😀😀😀 (u)"],
    ["``double `tick` code`` and ```triple``` and `` unclosed", "`double tick code and `triple` and ` unclosed"],
    ["**bold `code **not bold** inside` still bold**", "bold `code not bold inside` still bold"],
  ];

  it.each(CASES)('case %#', (input, expected) => {
    expect(flattenInline(input)).toBe(expected);
  });

  it('keeps a line of unmatched [ literal, without rescanning it from every [', () => {
    // Each `[` used to re-read the rest of the line for its `]`: 20 000 took 0.8 s and these
    // 100 000 about 20 s, against a few milliseconds now. Measured, because the test timeout cannot
    // be the assertion: it never interrupts a synchronous test. The bound leaves a loaded machine
    // two orders of magnitude.
    const line = '['.repeat(100_000);
    const t0 = performance.now();
    expect(flattenInline(line)).toBe(line);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
