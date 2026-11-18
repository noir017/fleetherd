import { describe, expect, it } from 'vitest';

import { MAX_READ_BYTES, readableKind, renderReading } from './reading.js';

describe('readableKind', () => {
  it.each([
    ['plan.md', 'markdown'],
    ['NOTES.MARKDOWN', 'markdown'],
    ['run.log', 'text'],
    ['data.csv', 'text'],
    ['config.yaml', 'text'],
    ['main.ts', 'text'],
    // Source formats a browser would execute are read as source, never rendered — see the module doc.
    ['report.html', 'text'],
    ['diagram.svg', 'text'],
  ])('reads %s as %s', (name, kind) => {
    expect(readableKind(name)).toBe(kind);
  });

  it.each([
    // Their text is not in their bytes: a renderer would be needed, and none is shipped.
    ['report.pdf'],
    ['sheet.xlsx'],
    ['memo.docx'],
    ['build.apk'],
    ['shot.png'],
    ['Makefile'],
    ['notes.md.zip'],
  ])('leaves %s a download', (name) => {
    expect(readableKind(name)).toBeUndefined();
  });
});

describe('renderReading', () => {
  const whole = (s: string) => Buffer.from(s, 'utf8');

  it('renders markdown through the same renderer as a reply', () => {
    const r = renderReading('markdown', whole('# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'), 30);
    expect(r?.html).toContain('<h1>Plan</h1>');
    expect(r?.html).toContain('<table');
  });

  it('escapes every character of a text file and builds nothing out of it', () => {
    const src = '<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n';
    const r = renderReading('text', whole(src), src.length);
    expect(r?.html).toBe(
      '<pre class="src"><code>&lt;script&gt;alert(1)&lt;/script&gt;\n&lt;img src=x onerror=alert(2)&gt;\n</code></pre>'
    );
  });

  it('passes no raw HTML through a markdown file either', () => {
    const src = 'hello <img src=x onerror=alert(1)>\n';
    expect(renderReading('markdown', whole(src), src.length)?.html).not.toContain('<img');
  });

  it('refuses bytes that are not text, whatever the name says', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    expect(renderReading('text', png, png.length)).toBeUndefined();
  });

  it('drops a BOM and folds CRLF, so a Windows file reads like any other', () => {
    const r = renderReading('markdown', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), whole('# Title\r\nbody\r\n')]), 20);
    expect(r?.html.startsWith('<h1>Title</h1>')).toBe(true);
    expect(r?.html).not.toContain('\r');
  });

  it('shows all of a file that fits', () => {
    const src = 'one\ntwo\n';
    expect(renderReading('text', whole(src), src.length)?.shown).toBe(src.length);
  });

  it('cuts a long file after its last line break', () => {
    // Exactly the budget, the way server.ts reads it, out of a file twice that size.
    const line = 'x'.repeat(99) + '\n';
    const head = whole(line.repeat(MAX_READ_BYTES / line.length) + 'y'.repeat(MAX_READ_BYTES % line.length));
    const r = renderReading('text', head, MAX_READ_BYTES * 2);
    expect(r?.shown).toBe(Math.floor(MAX_READ_BYTES / line.length) * line.length);
    expect(r?.html).not.toContain('y');
  });

  it('cuts one enormous line at a character, never inside one', () => {
    // A minified JSON's only newline is near the top; cutting there would show nothing. '中' is
    // three bytes, so the budget ends partway into one.
    const head = whole('{\n' + '中'.repeat(MAX_READ_BYTES)).subarray(0, MAX_READ_BYTES);
    const r = renderReading('text', head, MAX_READ_BYTES * 3);
    expect(r).toBeDefined();
    expect(r?.html).not.toContain('�');
    expect((r?.shown ?? 0) - 2).toBe(Math.floor((MAX_READ_BYTES - 2) / 3) * 3);
  });

  it('keeps a character that the budget ends exactly after', () => {
    const head = whole('中'.repeat(4));
    expect(renderReading('text', head, 100)?.shown).toBe(12);
  });

  it('hands the page the source of a text file, and never of a markdown one', () => {
    // The page's code view edits and highlights the source itself; markdown is shown rendered, so
    // handing it a source too would make every caller choose between two answers.
    const src = 'package main\n\nfunc main() {}\n';
    expect(renderReading('text', whole(src), src.length)?.text).toBe(src);
    expect(renderReading('markdown', whole('# Title\n'), 8)?.text).toBeUndefined();
  });

  it('cuts the source at the same byte as the HTML, so both views show the same head', () => {
    const line = 'x'.repeat(99) + '\n';
    const head = whole(line.repeat(MAX_READ_BYTES / line.length) + 'y'.repeat(MAX_READ_BYTES % line.length));
    const r = renderReading('text', head, MAX_READ_BYTES * 2);
    expect(r?.text?.length).toBe(r?.shown);
    expect(r?.text).not.toContain('y');
  });
});
