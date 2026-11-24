import { getLocale } from '../../../i18n/index.js';
import { text } from '../../../services/api.js';
import type { TranscriptIcons, TranscriptMessage } from './types.js';

export const TOPIC_POLISH_EN = {
  'msg.actionsAria': 'Message actions',
  'msg.copyMarkdown': 'Copy Markdown',
  'msg.quoteReply': 'Quote reply',
  'msg.askAside': 'Ask aside (/btw)',
  'msg.moreActions': 'More actions',
  'msg.openDiffSideBySide': 'Open Diff Side-by-Side',
} as const;

export const TOPIC_POLISH_ZH: Readonly<Record<keyof typeof TOPIC_POLISH_EN, string>> = {
  'msg.actionsAria': '消息操作',
  'msg.copyMarkdown': '复制 Markdown',
  'msg.quoteReply': '引用回复',
  'msg.askAside': '顺便问 (/btw)',
  'msg.moreActions': '更多操作',
  'msg.openDiffSideBySide': '并排打开 Diff',
};

export type TopicPolishKey = keyof typeof TOPIC_POLISH_EN;

export function polishLabel(key: TopicPolishKey): string {
  return getLocale() === 'zh-CN' ? TOPIC_POLISH_ZH[key] : TOPIC_POLISH_EN[key];
}

function renderCodeBlockMarkdown(el: Element): string {
  const lang = el.querySelector('.cb-lang')?.textContent?.trim() ?? '';
  const code = el.querySelector('pre code')?.textContent ?? el.querySelector('pre')?.textContent ?? '';
  const body = code.replace(/\n$/, '');
  let fence = '```';
  while (body.includes(fence)) fence += '`';
  return `${fence}${lang}\n${body}\n${fence}\n\n`;
}

function renderTableMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return '';
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const cells = Array.from(row.querySelectorAll('th,td')).map((c) =>
      (c.textContent ?? '').trim().replace(/\|/g, '\\|'),
    );
    lines.push(`| ${cells.join(' | ')} |`);
    if (i === 0) {
      lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
    }
  }
  return `${lines.join('\n')}\n\n`;
}

function renderListMarkdown(list: Element, ordered: boolean): string {
  const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
  const lines: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const li = items[i];
    if (!li) continue;
    let body = childrenToMarkdown(li).trim();
    if (li.classList.contains('task')) {
      body = body.replace(/^[☑☐✓✗\[\]xX\s]+/, '').trim();
      lines.push(`- [${li.classList.contains('done') ? 'x' : ' '}] ${body}`);
    } else {
      lines.push(`${ordered ? `${i + 1}.` : '-'} ${body}`);
    }
  }
  return `${lines.join('\n')}\n\n`;
}

function renderInlineTag(tag: string, el: Element): string | null {
  if (tag === 'BR') return '\n';
  if (tag === 'STRONG' || tag === 'B') return `**${childrenToMarkdown(el)}**`;
  if (tag === 'EM' || tag === 'I') return `*${childrenToMarkdown(el)}*`;
  if (tag === 'DEL' || tag === 'S') return `~~${childrenToMarkdown(el)}~~`;
  if (tag === 'CODE') {
    const raw = el.textContent ?? '';
    return raw.includes('`') ? `\`\` ${raw} \`\`` : `\`${raw}\``;
  }
  if (tag === 'A') {
    const label = childrenToMarkdown(el).trim() || (el.textContent ?? '').trim();
    const href = el.getAttribute('href') ?? '';
    return href && href !== '#' ? `[${label}](${href})` : label;
  }
  return null;
}

function renderBlockTag(tag: string, el: Element): string | null {
  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    return `${'#'.repeat(level)} ${childrenToMarkdown(el).trim()}\n\n`;
  }
  if (tag === 'PRE') {
    const code = (el.textContent ?? '').replace(/\n$/, '');
    return `\`\`\`\n${code}\n\`\`\`\n\n`;
  }
  if (tag === 'BLOCKQUOTE') {
    const inner = childrenToMarkdown(el).trim();
    if (!inner) return '';
    return `${inner.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
  }
  if (tag === 'UL') return renderListMarkdown(el, false);
  if (tag === 'OL') return renderListMarkdown(el, true);
  if (tag === 'TABLE') return renderTableMarkdown(el);
  if (tag === 'HR') return '---\n\n';
  if (tag === 'P') {
    const inner = childrenToMarkdown(el).trim();
    return inner ? `${inner}\n\n` : '';
  }
  return null;
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (el.classList.contains('msg-actions') || el.classList.contains('task-box')) return '';
  if (el.classList.contains('raw')) return el.textContent ?? '';
  if (el.classList.contains('cb')) return renderCodeBlockMarkdown(el);
  if (el.classList.contains('tbl')) {
    const tbl = el.querySelector('table');
    return tbl ? renderTableMarkdown(tbl) : childrenToMarkdown(el);
  }
  const tag = el.tagName.toUpperCase();
  const inline = renderInlineTag(tag, el);
  if (inline !== null) return inline;
  const block = renderBlockTag(tag, el);
  if (block !== null) return block;
  if (tag === 'DIV') {
    const inner = childrenToMarkdown(el);
    return inner ? `${inner}\n` : '';
  }
  return childrenToMarkdown(el);
}

function childrenToMarkdown(parent: Node): string {
  let out = '';
  for (let n: Node | null = parent.firstChild; n; n = n.nextSibling) {
    out += nodeToMarkdown(n);
  }
  return out;
}

export function htmlToMarkdown(rawHtml: string, doc?: Document): string {
  if (!rawHtml) return '';
  const owner = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!owner) {
    return rawHtml.replace(/<[^>]+>/g, '').trim();
  }
  const host = owner.createElement('div');
  host.innerHTML = rawHtml;
  return childrenToMarkdown(host)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractMessageMarkdown(
  m: TranscriptMessage | undefined,
  msgEl?: HTMLElement | null,
): string {
  if (m && typeof m._text === 'string' && m._text.trim()) {
    return m._text.trim();
  }
  const doc = msgEl?.ownerDocument;
  if (m && m.html) {
    const md = htmlToMarkdown(m.html, doc);
    if (md) return md;
  }
  const bodyEl = msgEl?.querySelector<HTMLElement>('.b');
  if (bodyEl) {
    const md = htmlToMarkdown(bodyEl.innerHTML, doc);
    if (md) return md;
    return (bodyEl.textContent ?? '').trim();
  }
  return (msgEl?.textContent ?? '').trim();
}

export function formatQuoteReply(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return '';
  const quoted = trimmed
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return `${quoted}\n\n`;
}

export function messageActionsMarkup(
  key: string,
  m: TranscriptMessage,
  icons: TranscriptIcons,
  hist: boolean,
): string {
  const k = text(key);
  const copyLabel = text(polishLabel('msg.copyMarkdown'));
  const quoteLabel = text(polishLabel('msg.quoteReply'));
  const moreLabel = text(polishLabel('msg.moreActions'));
  const toolbarLabel = text(polishLabel('msg.actionsAria'));

  let btns =
    `<button type="button" class="msg-act-btn" data-msg-act="copy" data-msg-k="${k}" title="${copyLabel}" aria-label="${copyLabel}">${icons.icon.copy ?? ''}</button>` +
    `<button type="button" class="msg-act-btn" data-msg-act="quote" data-msg-k="${k}" title="${quoteLabel}" aria-label="${quoteLabel}">${icons.icon.undo ?? ''}</button>`;

  if (!m.own && !hist) {
    const btwLabel = text(polishLabel('msg.askAside'));
    btns += `<button type="button" class="msg-act-btn" data-msg-act="btw" data-msg-k="${k}" title="${btwLabel}" aria-label="${btwLabel}">${icons.icon.chat ?? ''}</button>`;
  }

  btns += `<button type="button" class="msg-act-btn" data-msg-act="more" data-msg-k="${k}" aria-haspopup="menu" title="${moreLabel}" aria-label="${moreLabel}">${icons.icon.more ?? ''}</button>`;

  return `<div class="msg-actions" role="toolbar" aria-label="${toolbarLabel}">${btns}</div>`;
}

export function handleToolbarKeydown(e: KeyboardEvent, toolbar: HTMLElement): void {
  const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  if (buttons.length === 0) return;
  const active = toolbar.ownerDocument.activeElement;
  const idx = buttons.indexOf(active as HTMLButtonElement);
  if (idx < 0) return;

  let nextIdx = -1;
  if (e.key === 'ArrowRight') nextIdx = (idx + 1) % buttons.length;
  else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + buttons.length) % buttons.length;
  else if (e.key === 'Home') nextIdx = 0;
  else if (e.key === 'End') nextIdx = buttons.length - 1;
  else return;

  e.preventDefault();
  buttons[nextIdx]?.focus();
}
