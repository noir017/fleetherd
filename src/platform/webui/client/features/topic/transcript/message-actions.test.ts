// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../../../i18n/index.js';
import {
  extractMessageMarkdown,
  extractSelectedMessageText,
  formatQuoteReply,
  handleToolbarKeydown,
  htmlToMarkdown,
  messageActionsMarkup,
} from './message-actions.js';
import type { TranscriptIcons, TranscriptMessage } from './types.js';

const ICONS: TranscriptIcons = {
  icon: {
    copy: '<svg class="ic-copy"></svg>',
    undo: '<svg class="ic-undo"></svg>',
    chat: '<svg class="ic-chat"></svg>',
    more: '<svg class="ic-more"></svg>',
    check: '<svg class="ic-check"></svg>',
  },
  mark: {},
  reaction: {},
};

describe('transcript/message-actions', () => {
  afterEach(() => {
    setLocale('en');
    document.body.innerHTML = '';
  });

  it('converts rich message HTML back into clean Markdown', () => {
    const html =
      '<h2>Summary</h2>' +
      '<p>Use <strong>bold</strong>, <em>italic</em>, and <code>npm test</code> with <a href="https://example.com">docs</a>.</p>' +
      '<div class="cb"><div class="cb-h"><span class="cb-lang">ts</span></div><pre><code>const x = 1;\n</code></pre></div>' +
      '<ul><li class="task done"><span class="task-box">☑</span>Ship feature</li><li class="task"><span class="task-box">☐</span>Follow up</li></ul>' +
      '<blockquote><p>Note line</p></blockquote>' +
      '<div class="tbl"><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></div>';

    const md = htmlToMarkdown(html);
    expect(md).toContain('## Summary');
    expect(md).toContain('Use **bold**, *italic*, and `npm test` with [docs](https://example.com).');
    expect(md).toContain('```ts\nconst x = 1;\n```');
    expect(md).toContain('- [x] Ship feature');
    expect(md).toContain('- [ ] Follow up');
    expect(md).toContain('> Note line');
    expect(md).toContain('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('prefers raw _text for extractMessageMarkdown and formats multi-line quotes', () => {
    const msg: TranscriptMessage = {
      id: 'm1',
      own: true,
      html: '<div class="raw">fallback</div>',
      _text: 'line one\n\nline two',
      at: 100,
    };
    expect(extractMessageMarkdown(msg)).toBe('line one\n\nline two');
    expect(formatQuoteReply('line one\n\nline two')).toBe('> line one\n>\n> line two\n\n');
    expect(formatQuoteReply('   ')).toBe('');
  });

  it('renders role-aware action bars for user, assistant, and history messages', () => {
    const userMsg: TranscriptMessage = { id: 'u1', own: true, html: '<div class="raw">hi</div>', at: 1 };
    const assistantMsg: TranscriptMessage = { id: 'a1', html: '<p>hello</p>', at: 2 };

    const userHtml = messageActionsMarkup('1:u1', userMsg, ICONS, false);
    expect(userHtml).toContain('role="toolbar"');
    expect(userHtml).toContain('data-msg-act="copy"');
    expect(userHtml).toContain('data-msg-act="quote"');
    expect(userHtml).not.toContain('data-msg-act="btw"');
    expect(userHtml).toContain('data-msg-act="more"');

    const assistantHtml = messageActionsMarkup('1:a1', assistantMsg, ICONS, false);
    expect(assistantHtml).toContain('data-msg-act="btw"');

    const histHtml = messageActionsMarkup('0:a1', assistantMsg, ICONS, true);
    expect(histHtml).not.toContain('data-msg-act="btw"');
  });

  it('supports ArrowLeft, ArrowRight, Home, and End keyboard navigation inside toolbar', () => {
    const host = document.createElement('div');
    host.innerHTML = messageActionsMarkup('1:a1', { id: 'a1', html: '<p>hi</p>', at: 1 }, ICONS, false);
    document.body.appendChild(host);
    const toolbar = host.querySelector<HTMLElement>('.msg-actions')!;
    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons).toHaveLength(4);

    buttons[0]!.focus();
    handleToolbarKeydown(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }), toolbar);
    expect(document.activeElement).toBe(buttons[1]);

    handleToolbarKeydown(new KeyboardEvent('keydown', { key: 'End', cancelable: true }), toolbar);
    expect(document.activeElement).toBe(buttons[3]);

    handleToolbarKeydown(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }), toolbar);
    expect(document.activeElement).toBe(buttons[0]);

    handleToolbarKeydown(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }), toolbar);
    expect(document.activeElement).toBe(buttons[3]);

    handleToolbarKeydown(new KeyboardEvent('keydown', { key: 'Home', cancelable: true }), toolbar);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('extracts clean plain text from an in-message selection while stripping UI chrome', () => {
    const msg = document.createElement('div');
    msg.className = 'm';
    msg.innerHTML =
      '<div class="b">' +
      '<p>Intro line</p>' +
      '<div class="cb"><div class="cb-h"><span class="cb-lang">ts</span><button class="cb-b">Wrap</button><button class="cb-b">Copy</button></div>' +
      '<pre><code>const x = 1;\n  const y = 2;</code></pre></div>' +
      '<ul><li class="task done"><span class="task-box">☑</span>Task A</li><li>Task B</li></ul>' +
      '<table><tr><th>Col1</th><th>Col2</th></tr><tr><td>v1</td><td>v2</td></tr></table>' +
      '</div>' +
      '<div class="t">09:30</div>' +
      '<div class="msg-actions"><button>Copy</button><button>More</button></div>';
    document.body.appendChild(msg);

    const sel = window.getSelection()!;

    // Collapsed selection returns empty string.
    sel.removeAllRanges();
    expect(extractSelectedMessageText(msg)).toBe('');

    // Selection purely inside UI chrome (code block header) returns empty string.
    const chromeRange = document.createRange();
    chromeRange.selectNodeContents(msg.querySelector('.cb-h')!);
    sel.removeAllRanges();
    sel.addRange(chromeRange);
    expect(extractSelectedMessageText(msg)).toBe('');

    // Partial code selection preserves indentation and newlines.
    const codeNode = msg.querySelector('code')!.firstChild!;
    const codeRange = document.createRange();
    codeRange.setStart(codeNode, 6);
    codeRange.setEnd(codeNode, codeNode.textContent!.length);
    sel.removeAllRanges();
    sel.addRange(codeRange);
    expect(extractSelectedMessageText(msg)).toBe('x = 1;\n  const y = 2;');

    // Full message range strips .cb-h, .task-box, .t, and .msg-actions while preserving structure.
    const fullRange = document.createRange();
    fullRange.selectNodeContents(msg);
    sel.removeAllRanges();
    sel.addRange(fullRange);
    expect(extractSelectedMessageText(msg)).toBe(
      'Intro line\nconst x = 1;\n  const y = 2;\nTask A\nTask B\nCol1\tCol2\nv1\tv2',
    );

    // Selection outside the message returns empty string.
    const other = document.createElement('div');
    other.textContent = 'Outside';
    document.body.appendChild(other);
    const outRange = document.createRange();
    outRange.selectNodeContents(other);
    sel.removeAllRanges();
    sel.addRange(outRange);
    expect(extractSelectedMessageText(msg)).toBe('');

    sel.removeAllRanges();
  });
});
