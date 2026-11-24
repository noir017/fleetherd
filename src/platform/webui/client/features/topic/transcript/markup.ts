import { t as tr } from '../../../i18n/index.js';
import { text } from '../../../services/api.js';
import { btwAsked } from './btw.js';
import type {
  MsgMarkupResult,
  ToolOpenState,
  TranscriptIcons,
  TranscriptMessage,
  WorkdirCrumb,
  WorkdirEntry,
} from './types.js';

const SUB_K: Readonly<Record<string, 'msg.dispatch' | 'msg.report' | 'msg.aside'>> = {
  dispatch: 'msg.dispatch',
  report: 'msg.report',
  aside: 'msg.aside',
};

const MARK = /^([●☑☐⌂]) /;
const NAV = /^[◀‹]|[▶›]$/;

export function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => (n < 10 ? '0' : '') + n;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function labelWidth(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) >= 0x2e80 ? 2 : 1;
  return n;
}

export function navLabel(label: string, icons: TranscriptIcons): string {
  const back = /^[◀‹] ?/.exec(label);
  const on = / ?[▶›]$/.exec(label);
  if (back) {
    const rest = label.length > back[0].length ? ' ' + text(label.slice(back[0].length)) : '';
    return (icons.icon.chevronLeft ?? '') + rest;
  }
  if (on) {
    const lead = on.index ? text(label.slice(0, on.index)) + ' ' : '';
    return lead + (icons.icon.chevronRight ?? '');
  }
  return text(label);
}

export function reactionMark(emoji: string, icons: TranscriptIcons): string {
  const key = String(emoji).replace(/\uFE0F/g, '');
  return icons.reaction[key] || text(emoji);
}

export function lineOpen(st: ToolOpenState | undefined, i: number | string): boolean {
  if (!st) return false;
  const key = String(i);
  return st.lines[key] !== undefined ? Boolean(st.lines[key]) : st.all;
}

export function foldLines(
  key: string,
  html: string,
  opened: Readonly<Record<string, ToolOpenState | undefined>>,
): string {
  const st = opened[key];
  let i = 0;
  return html.replace(/<div class="tl">/g, () => {
    const n = i++;
    return `<div class="tl${lineOpen(st, n) ? ' open' : ''}" data-i="${n}">`;
  });
}

export function allToggle(
  key: string,
  opened: Readonly<Record<string, ToolOpenState | undefined>>,
): string {
  const st = opened[key];
  return (
    `<button type="button" class="tl-all" data-tl-all="${text(key)}">` +
    text(st && st.all ? tr('msg.collapse') : tr('msg.showAll')) +
    '</button>'
  );
}

export function stuck(m: TranscriptMessage | null | undefined): boolean {
  return Boolean(m && m._local) && (m?._state === 'failed' || m?._state === 'unsure');
}

export function failedActions(m: TranscriptMessage, hasOutbox: boolean): string {
  const why = m._state === 'unsure' ? tr('msg.notConfirmed') : tr('msg.notDelivered');
  const nonce = text(m._nonce ?? '');
  let h = `<div class="warn">${text(why)}</div><div class="acts">`;
  if (hasOutbox) h += `<button type="button" data-retry="${nonce}">${text(tr('common.retry'))}</button>`;
  return (
    h +
    `<button type="button" data-copy="${nonce}">${text(tr('common.copy'))}</button>` +
    `<button type="button" data-discard="${nonce}">${text(tr('common.discard'))}</button></div>`
  );
}

export function turnChangeRow(
  m: TranscriptMessage,
  icons: TranscriptIcons,
  canOpenGit: boolean,
): string {
  if (!canOpenGit || !m.turnChanges) return '';
  const c = m.turnChanges;
  const files = c.files === 1 ? tr('msg.turnFilesOne') : tr('msg.turnFilesMany', { count: c.files });
  return (
    `<div class="tc"><button type="button" data-turns="${text(String(c.turn))}">` +
    (icons.icon.diff ?? '') +
    `<span>${text(files)}</span>` +
    `<span class="add">+${text(String(c.additions))}</span>` +
    `<span class="del">-${text(String(c.deletions) + (c.truncated ? '+' : ''))}</span>` +
    '</button></div>'
  );
}

export function renderMenu(m: TranscriptMessage, icons: TranscriptIcons): string {
  const buttons = m.buttons ?? [];
  let items = '';
  let nav = '';
  let widest = 0;
  let marked = false;
  const msg = text(m.id);
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    if (!b) continue;
    const label = String(b.label == null ? '' : b.label);
    const mk = MARK.exec(label);
    const tag = `<button type="button" data-msg="${msg}" data-btn="${text(b.id)}"`;
    if (NAV.test(label)) {
      nav += `${tag}>${navLabel(label, icons)}</button>`;
      continue;
    }
    widest = Math.max(widest, labelWidth(label));
    if (mk) marked = true;
    const glyph = mk?.[1] ?? '';
    const on = glyph === '●' || glyph === '☑';
    const body = mk
      ? `<span class="mk">${icons.mark[glyph] || text(glyph)}</span> ${text(label.slice(2))}`
      : text(label);
    items += `${tag}${on ? ' class="on"' : ''}>${body}</button>`;
  }
  return (
    `<div class="btns" style="--cw:${Math.min(widest, 40)}ch${marked ? ';--mk:1' : ''}">` +
    items +
    (nav ? `<div class="nav">${nav}</div>` : '') +
    '</div>'
  );
}

function workdirBreadcrumbs(list: readonly WorkdirCrumb[], msg: string): string {
  let crumbs = '';
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c) continue;
    const prev = i > 0 ? list[i - 1] : undefined;
    if (prev && prev.name !== '/' && !/\\$/.test(prev.name)) {
      crumbs += '<span class="wd-sep" aria-hidden="true">/</span>';
    }
    if (i === list.length - 1) {
      crumbs += `<span class="wd-crumb cur" title="${text(c.path)}">${text(c.name)}</span>`;
    } else {
      crumbs += `<button type="button" class="wd-crumb" data-msg="${msg}" data-btn="${text(c.buttonId)}" title="${text(c.path)}">${text(c.name)}</button>`;
    }
  }
  return crumbs;
}

function workdirEntryRow(e: WorkdirEntry, msg: string, icons: TranscriptIcons): string {
  const rowTag = e.current
    ? `<span class="wd-tag on">${text(tr('workdir.currentTag'))}</span>`
    : e.root
      ? `<span class="wd-tag">${text(tr('workdir.rootTag'))}</span>`
      : '';
  return (
    `<div class="wd-row${e.current ? ' on' : ''}" data-wd-name="${text(String(e.name).toLowerCase())}">` +
    `<button type="button" class="wd-open" data-msg="${msg}" data-btn="${text(e.enterId)}" title="${text(tr('workdir.openTitle', { name: e.name }))}">` +
    `<span class="wd-ic">${e.root ? (icons.icon.home ?? '') : (icons.icon.folder ?? '')}</span>` +
    `<span class="wd-name">${text(e.name)}</span>` +
    rowTag +
    `<span class="wd-go" aria-hidden="true">${icons.icon.chevronRight ?? ''}</span>` +
    '</button>' +
    `<button type="button" class="wd-choose${e.current ? ' on' : ''}" data-msg="${msg}" data-btn="${text(e.pickId)}" title="${text(tr('workdir.chooseTitle', { path: e.path }))}">` +
    `${icons.icon.check ?? ''}<span>${text(tr('workdir.choose'))}</span>` +
    '</button></div>'
  );
}

function workdirActionsBar(
  w: NonNullable<TranscriptMessage['workdir']>,
  msg: string,
  icons: TranscriptIcons,
): string {
  const crumbs = workdirBreadcrumbs(w.breadcrumbs ?? [], msg);
  const upIcon = icons.icon.arrowUp ?? '';
  const upBtn = w.parent
    ? `<button type="button" class="wd-act wd-up" data-msg="${msg}" data-btn="${text(w.parent.buttonId)}" title="${text(tr('workdir.upTitle', { path: w.parent.path }))}">${upIcon}<span>${text(tr('workdir.up'))}</span></button>`
    : `<button type="button" class="wd-act wd-up" disabled>${upIcon}<span>${text(tr('workdir.up'))}</span></button>`;
  const homeBtn = w.home
    ? `<button type="button" class="wd-act wd-home" data-msg="${msg}" data-btn="${text(w.home.buttonId)}" title="${text(tr('workdir.rootTitle', { path: w.home.path }))}">${icons.icon.home ?? ''}<span>${text(tr('workdir.root'))}</span></button>`
    : '';
  return `<div class="wd-bar"><div class="wd-acts">${upBtn}${homeBtn}</div><nav class="wd-crumbs" aria-label="Path">${crumbs}</nav></div>`;
}

function workdirCurrentRow(
  sc: NonNullable<TranscriptMessage['workdir']>['selectCurrent'],
  msg: string,
  icons: TranscriptIcons,
): string {
  const curTags =
    (sc.current ? `<span class="wd-tag on">${text(tr('workdir.currentTag'))}</span>` : '') +
    (sc.root ? `<span class="wd-tag">${text(tr('workdir.rootTag'))}</span>` : '');
  const label = tr(sc.current ? 'workdir.keepCurrent' : 'workdir.useCurrent');
  return (
    `<div class="wd-cur"><div class="wd-cur-info"><code class="wd-path" title="${text(sc.path)}">${text(sc.path)}</code>${curTags}</div>` +
    `<button type="button" class="wd-pick-cur${sc.current ? ' on' : ''}" data-msg="${msg}" data-btn="${text(sc.buttonId)}">${icons.icon.check ?? ''}<span>${text(label)}</span></button></div>`
  );
}

function workdirEntriesBody(
  entries: readonly WorkdirEntry[],
  msg: string,
  icons: TranscriptIcons,
): string {
  const filterHtml =
    entries.length >= 6
      ? `<div class="wd-filter">${icons.icon.search ?? ''}<input type="search" class="wd-q" placeholder="${text(tr('workdir.filterPlaceholder'))}" aria-label="${text(tr('workdir.filterPlaceholder'))}" autocomplete="off" spellcheck="false"></div>`
      : '';
  if (!entries.length) return filterHtml + `<div class="wd-empty">${text(tr('workdir.empty'))}</div>`;
  let rows = '';
  for (let j = 0; j < entries.length; j++) {
    const entry = entries[j];
    if (entry) rows += workdirEntryRow(entry, msg, icons);
  }
  return (
    filterHtml +
    `<div class="wd-list">${rows}<div class="wd-empty wd-filter-empty" hidden>${text(tr('workdir.noMatch'))}</div></div>`
  );
}

export function workdirPicker(m: TranscriptMessage, icons: TranscriptIcons): string {
  const w = m.workdir;
  if (!w) return '';
  const msg = text(m.id);
  const hostPill = w.host ? `<span class="wd-meta">${text(w.host)}</span>` : '';
  return (
    `<div class="wd-picker" data-browsing="${text(w.browsing)}">` +
    `<div class="wd-head"><div class="wd-title-row"><span class="wd-title">${icons.icon.folder ?? ''}<span>${text(tr('workdir.title'))}</span></span>` +
    `<span class="wd-badges"><span class="wd-meta">${text(w.agentId)}</span>${hostPill}</span></div>` +
    `<div class="wd-hint">${text(tr('workdir.hint'))}</div></div>` +
    workdirActionsBar(w, msg, icons) +
    (w.error ? `<div class="wd-err" role="alert">${text(w.error)}</div>` : '') +
    workdirCurrentRow(w.selectCurrent, msg, icons) +
    workdirEntriesBody(w.entries ?? [], msg, icons) +
    (w.truncated > 0 ? `<div class="wd-more">${text(tr('workdir.truncated', { count: w.truncated }))}</div>` : '') +
    '</div>'
  );
}

function renderFileAttachment(m: TranscriptMessage, hist: boolean): string {
  const f = m.file;
  if (!f) return '';
  let h = '';
  if (f.image) {
    h += `<img class="shot" src="${text(f.url)}" alt="${text(f.name)}" loading="lazy">`;
  }
  h +=
    `<div class="files"><a href="${text(f.url)}" download` +
    (f.view && !hist ? ` data-view="${text(f.view)}"` : '') +
    `>${text(f.name)}</a>`;
  if (f.view && !hist) {
    h += `<a class="view" href="${text(f.url)}" download>${text(tr('common.download'))}</a>`;
  }
  return h + '</div>';
}

export interface MsgMarkupContext {
  readonly icons: TranscriptIcons;
  readonly opened: Readonly<Record<string, ToolOpenState | undefined>>;
  readonly canOpenGit: boolean;
  readonly hasOutbox: (nonce: string) => boolean;
  readonly isBtwHeld: (key: string, m: TranscriptMessage) => boolean;
  readonly btwLineMarkup: (
    key: string,
    m: TranscriptMessage,
    asked: string,
    hist: boolean,
  ) => MsgMarkupResult;
}

function msgClassName(m: TranscriptMessage, hist: boolean, tag: string, isStuck: boolean): string {
  return (
    'm' +
    (m.own ? ' own' : '') +
    (hist ? ' hist' : '') +
    (tag ? ` ${m.kind}` : '') +
    (m._local && m._state === 'sending' ? ' pending' : '') +
    (isStuck ? ' failed' : '')
  );
}

function msgBodyHtml(
  key: string,
  m: TranscriptMessage,
  hist: boolean,
  folded: boolean,
  ctx: MsgMarkupContext,
): string {
  if (!hist && m.workdir) return workdirPicker(m, ctx.icons);
  let h = `<div class="b">${folded ? foldLines(key, m.html, ctx.opened) : m.html}</div>`;
  if (m.file) h += renderFileAttachment(m, hist);
  if (m.turnChanges) h += turnChangeRow(m, ctx.icons, ctx.canOpenGit);
  if (!hist && m.buttons && m.buttons.length) h += renderMenu(m, ctx.icons);
  return h;
}

export function renderMsgMarkup(
  key: string,
  m: TranscriptMessage,
  hist: boolean,
  ctx: MsgMarkupContext,
): MsgMarkupResult {
  const asked = btwAsked(key, m);
  if (asked !== null) return ctx.btwLineMarkup(key, m, asked, hist);
  if (ctx.isBtwHeld(key, m)) return { cls: 'm aside-held', h: '' };

  const kind = m.kind;
  const folded = kind === 'tools' || kind === 'report';
  const subKey = kind && Object.prototype.hasOwnProperty.call(SUB_K, kind) ? SUB_K[kind] : undefined;
  const tag = subKey ? tr(subKey) : '';
  const isStuck = stuck(m);
  const cls = msgClassName(m, hist, tag, isStuck);
  let h = '';
  if (tag) h += `<div class="sub-k">${tag}</div>`;
  if (m.quote && m.quote.html) h += `<div class="q">${m.quote.html}</div>`;
  h += msgBodyHtml(key, m, hist, folded, ctx);
  if (isStuck) h += failedActions(m, Boolean(m._nonce && ctx.hasOutbox(m._nonce)));
  const reactions =
    m.reactions && m.reactions.length
      ? '  ' + m.reactions.map((e) => reactionMark(e, ctx.icons)).join(' ')
      : '';
  h += `<div class="t">${text(clock(m.at))}${reactions}${folded ? allToggle(key, ctx.opened) : ''}</div>`;
  return { cls, h };
}
