import { describe, it, expect } from 'vitest';
import { parseInline, renderSlackMarkdown } from './slack-markdown.js';

describe('parseInline', () => {
  it('converts CommonMark bold/italic/strike to mrkdwn single-marker forms', () => {
    expect(parseInline('**b**')).toBe('*b*'); // ** → *
    expect(parseInline('__b__')).toBe('*b*'); // __ → *
    expect(parseInline('*i*')).toBe('_i_'); // * → _
    expect(parseInline('_i_')).toBe('_i_'); // _ → _ (unchanged)
    expect(parseInline('~~x~~')).toBe('~x~'); // ~~ → ~
  });

  it('preserves inline code and does not transform markdown inside it', () => {
    expect(parseInline('`c`')).toBe('`c`');
    expect(parseInline('`a **b** c`')).toBe('`a **b** c`');
  });

  it('converts [text](url) → <url|text>, keeping the URL raw (ampersand not escaped)', () => {
    expect(parseInline('[hi](https://x.com/a)')).toBe('<https://x.com/a|hi>');
    expect(parseInline('[q](https://x.com/s?a=1&b=2)')).toBe('<https://x.com/s?a=1&b=2|q>');
  });

  it('converts ***x*** → *_x_* (bold wrapping italic)', () => {
    expect(parseInline('***x***')).toBe('*_x_*');
  });

  it('nests emphasis: bold containing italic', () => {
    expect(parseInline('**a _b_ c**')).toBe('*a _b_ c*');
  });

  it('leaves an unclosed delimiter as literal text (stream safety)', () => {
    expect(parseInline('**not closed')).toBe('**not closed');
    expect(parseInline('a ~~half')).toBe('a ~~half');
  });

  it('does not italicize underscores inside a word (file_name stays literal)', () => {
    expect(parseInline('file_name_here')).toBe('file_name_here');
  });

  it('does not italicize a lone asterisk with surrounding spaces (arithmetic stays literal)', () => {
    expect(parseInline('a * b * c')).toBe('a * b * c');
    expect(parseInline('5 * 3 = 15')).toBe('5 * 3 = 15');
  });

  it('escapes the three Slack control chars &, <, > in literal text', () => {
    expect(parseInline('Array<T> & U')).toBe('Array&lt;T&gt; &amp; U');
  });
});

describe('renderSlackMarkdown blocks', () => {
  it('renders an ATX heading as bold (Slack has no headings)', () => {
    expect(renderSlackMarkdown('# Title')).toBe('*Title*');
    expect(renderSlackMarkdown('### Deep **strong**')).toBe('*Deep *strong**');
  });

  it('renders a fenced code block as a bare ``` fence (no lang) and escapes its body', () => {
    expect(renderSlackMarkdown('```ts\na<b && c>d\n```')).toBe(
      '```\na&lt;b &amp;&amp; c&gt;d\n```'
    );
  });

  it('treats an unclosed fence at end-of-stream as a code block (stream safety)', () => {
    expect(renderSlackMarkdown('```\nhalf')).toBe('```\nhalf\n```');
  });

  it('rewrites a GFM table into bold-title + bullet groups (Slack has no tables)', () => {
    const md = '| Name | Score |\n|------|-------|\n| Ada | 95 |';
    expect(renderSlackMarkdown(md)).toBe('*Ada*\n• Score: 95');
  });

  it('rewrites a multi-row table with newline-separated row groups', () => {
    const md = '| Name | Score |\n|------|-------|\n| Ada | 95 |\n| Bo | 80 |';
    expect(renderSlackMarkdown(md)).toBe('*Ada*\n• Score: 95\n*Bo*\n• Score: 80');
  });

  it('converts unordered list markers to bullets and keeps inline formatting', () => {
    expect(renderSlackMarkdown('- **a**\n- b')).toBe('• *a*\n• b');
    expect(renderSlackMarkdown('* x\n+ y')).toBe('• x\n• y');
  });

  it('keeps ordered list markers as N.', () => {
    expect(renderSlackMarkdown('1. first\n2. **second**')).toBe('1. first\n2. *second*');
  });

  it('keeps blockquote lines as > and escapes their content', () => {
    expect(renderSlackMarkdown('> one\n> two')).toBe('> one\n> two');
    expect(renderSlackMarkdown('> a < b')).toBe('> a &lt; b');
  });

  it('preserves blank lines between paragraphs', () => {
    expect(renderSlackMarkdown('a\n\nb')).toBe('a\n\nb');
  });

  it('returns an empty string for empty input', () => {
    expect(renderSlackMarkdown('')).toBe('');
  });

  it('converts a representative mixed document end-to-end', () => {
    const md = '# Report\n\nSee **bold**, *italic*, `code`, and [link](https://x.com/a).\n\n- one\n- two';
    expect(renderSlackMarkdown(md)).toBe(
      '*Report*\n\nSee *bold*, _italic_, `code`, and <https://x.com/a|link>.\n\n• one\n• two'
    );
  });
});

/**
 * Pinned from the per-character scan, before parseInline learned to copy plain runs whole and to
 * skip a `[` no link can start at (2026-11-07). The point is that those changed only the speed:
 * some of these outputs are quirks of the parser (`****d****`, a code span inside bold), and they
 * are here because they must not move, not because they are right.
 */
describe('parseInline output is unchanged by the fast paths', () => {
  const CASES: Array<[string, string]> = [
    ["plain words, then `code`, a [link](https://x.y/a?b=1&c=2), **bold**, __bold__, *it*, _it_, ~~gone~~ — and 中文 🙂", "plain words, then `code`, a <https://x.y/a?b=1&c=2|link>, *bold*, *bold*, _it_, _it_, ~gone~ — and 中文 🙂"],
    ["file_name_here and (_x_) and a_b_ and x__y__ and __z__ and _a_b", "file_name_here and (_x_) and a_b_ and x__y__ and *z* and _a_b"],
    ["[not a link] and [also](not closed and **open and ~~open and `open", "[not a link] and [also](not closed and **open and ~~open and `open"],
    ["[[[[[a](https://x) ]] [b] [c](d)", "<https://x|[[[[a> ]] [b] <d|c>"],
    ["*a* **b** ***c*** ****d**** *e **f** g*", "_a_ *b* *_c_* *_*d_** _e *_f_* g_"],
    ["trailing delimiters: * _ ~ ` [ ](", "trailing delimiters: * _ ~ ` [ ]("],
    ["中文**加粗**中文_斜体_中文~~删~~中文`码`中文", "中文*加粗*中文_斜体_中文~删~中文`码`中文"],
    ["5 * 3 * 2 and a * b and a*b*c", "5 * 3 * 2 and a * b and a_b_c"],
    ["see https://example.com/a_b*c, xhttps://no, http://ok. and [t](javascript:x) h h ht htt http https:/ https://", "see https://example.com/a_b*c, xhttps://no, http://ok. and <javascript:x|t> h h ht htt http https:/ https://"],
    ["[a]b](c) [a](b c) [](x) [x]() [x] (y)", "[a]b](c) [a](b c) [](x) [x]() [x] (y)"],
    ["<b> & \"q\" 's' &amp; <script>", "&lt;b&gt; &amp; \"q\" 's' &amp;amp; &lt;script&gt;"],
    ["😀*😀*😀_😀_😀~~😀~~😀`😀`😀[😀](u)", "😀_😀_😀_😀_😀~😀~😀`😀`😀<u|😀>"],
    ["``double `tick` code`` and ```triple``` and `` unclosed", "``double `tick` code`` and ```triple``` and `` unclosed"],
    ["**bold `code **not bold** inside` still bold**", "*bold `code *not bold* inside` still bold*"],
  ];

  it.each(CASES)('case %#', (input, expected) => {
    expect(parseInline(input)).toBe(expected);
  });
});
