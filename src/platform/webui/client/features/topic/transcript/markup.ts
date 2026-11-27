import { t as tr } from '../../../i18n/index.js';
import { text } from '../../../services/api.js';
import { btwAsked } from './btw.js';
import { messageActionsMarkup, polishLabel } from './message-actions.js';
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

/** Kinds drawn a row per line, each row folded until opened: how each folds as a whole differs. */
const LINE_KINDS: ReadonlySet<string> = new Set(['tools', 'report', 'subagent']);

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

/** The header web-markdown.ts renderWebSubagent draws: state, duration, and the escaped name. */
const SA_HEAD = /^<div class="sa-h" data-st="(run|ok|err)" data-d="([^"]*)">([\s\S]*?)<\/div>/;

/**
 * A subagent's card around what the server drew for it: a header that names the subagent, counts
 * its tools and says whether it is still running, then its tool lines — folded to the newest one
 * until the header is tapped (`ToolOpenState.card`). The name and duration arrive escaped.
 */
export function subagentCard(
  key: string,
  html: string,
  opened: Readonly<Record<string, ToolOpenState | undefined>>,
  icons: TranscriptIcons,
): string {
  const head = SA_HEAD.exec(html);
  if (!head) return html;
  const [, st, dur, name] = head;
  const body = html.slice(head[0].length);
  const n = (body.match(/<div class="tl[ "]/g) || []).length;
  const open = Boolean(opened[key]?.card);
  const count = n === 1 ? tr('msg.subagentToolsOne') : tr('msg.subagentToolsMany', { count: n });
  const state =
    st === 'ok'
      ? (icons.icon.check ?? '') + text(tr('msg.subagentDone'))
      : st === 'err'
        ? (icons.icon.cross ?? '') + text(tr('msg.subagentFailed'))
        : '<span class="sa-spin"></span>' + text(tr('msg.subagentRunning'));
  const earlier = !open && n > 1 ? `<div class="sa-more">${text(tr('msg.subagentEarlier', { count: n - 1 }))}</div>` : '';
  return (
    `<div class="sa st-${st}${open ? ' open' : ''}">` +
    `<button type="button" class="sa-h" data-sa="${text(key)}" aria-expanded="${open}">` +
    `${icons.icon.subagent ?? ''}<span class="sa-n">${name}</span>` +
    `<span class="sa-m">${text(count)}${dur ? ' · ' + dur : ''}</span>` +
    `<span class="sa-s">${state}</span>${icons.icon.chevronDown ?? ''}</button>` +
    earlier +
    body +
    '</div>'
  );
}

/** "Show all" under a line-based message — except a subagent card, which folds by its header. */
function linesToggle(key: string, kind: string | undefined, opened: Readonly<Record<string, ToolOpenState | undefined>>): string {
  return kind !== undefined && kind !== 'subagent' && LINE_KINDS.has(kind) ? allToggle(key, opened) : '';
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
  canOpenSideDiff = false,
): string {
  if ((!canOpenGit && !canOpenSideDiff) || !m.turnChanges) return '';
  const c = m.turnChanges;
  const files = c.files === 1 ? tr('msg.turnFilesOne') : tr('msg.turnFilesMany', { count: c.files });
  const turnStr = text(String(c.turn));
  const summaryInner =
    (icons.icon.diff ?? '') +
    `<span>${text(files)}</span>` +
    `<span class="add">+${text(String(c.additions))}</span>` +
    `<span class="del">-${text(String(c.deletions) + (c.truncated ? '+' : ''))}</span>`;
  const summary = canOpenGit
    ? `<button type="button" data-turns="${turnStr}">${summaryInner}</button>`
    : `<span class="tc-summary">${summaryInner}</span>`;
  const splitLabel = text(polishLabel('msg.openDiffSideBySide'));
  const splitBtn = canOpenSideDiff
    ? `<button type="button" class="tc-split" data-turns-split="${turnStr}" title="${splitLabel}" aria-label="${splitLabel}">${icons.icon.diff ?? ''}<span>${splitLabel}</span></button>`
    : '';
  return `<div class="tc">${summary}${splitBtn}</div>`;
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

export type WorkdirPickerMode =
  | { readonly kind: 'msg'; readonly msg: string }
  | { readonly kind: 'launch'; readonly folded?: boolean; readonly selectedPath?: string };

function wdBrowseAttr(mode: WorkdirPickerMode, buttonId: string, path: string): string {
  return mode.kind === 'msg'
    ? `data-msg="${mode.msg}" data-btn="${text(buttonId)}"`
    : `data-wd-browse="${text(path)}"`;
}

function wdPickAttr(mode: WorkdirPickerMode, buttonId: string, path: string): string {
  return mode.kind === 'msg'
    ? `data-msg="${mode.msg}" data-btn="${text(buttonId)}"`
    : `data-wd-pick="${text(path)}"`;
}

function workdirBreadcrumbs(list: readonly WorkdirCrumb[], mode: WorkdirPickerMode): string {
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
      crumbs += `<button type="button" class="wd-crumb" ${wdBrowseAttr(mode, c.buttonId, c.path)} title="${text(c.path)}">${text(c.name)}</button>`;
    }
  }
  return crumbs;
}

function workdirEntryRow(e: WorkdirEntry, mode: WorkdirPickerMode, icons: TranscriptIcons): string {
  const rowTag = e.current
    ? `<span class="wd-tag on">${text(tr('workdir.currentTag'))}</span>`
    : e.root
      ? `<span class="wd-tag">${text(tr('workdir.rootTag'))}</span>`
      : '';
  return (
    `<div class="wd-row${e.current ? ' on' : ''}" data-wd-name="${text(String(e.name).toLowerCase())}">` +
    `<button type="button" class="wd-open" ${wdBrowseAttr(mode, e.enterId, e.path)} title="${text(tr('workdir.openTitle', { name: e.name }))}">` +
    `<span class="wd-ic">${e.root ? (icons.icon.home ?? '') : (icons.icon.folder ?? '')}</span>` +
    `<span class="wd-name">${text(e.name)}</span>` +
    rowTag +
    `<span class="wd-go" aria-hidden="true">${icons.icon.chevronRight ?? ''}</span>` +
    '</button>' +
    `<button type="button" class="wd-choose${e.current ? ' on' : ''}" ${wdPickAttr(mode, e.pickId, e.path)} title="${text(tr('workdir.chooseTitle', { path: e.path }))}">` +
    `${icons.icon.check ?? ''}<span>${text(tr('workdir.choose'))}</span>` +
    '</button></div>'
  );
}

function workdirActionsBar(
  w: NonNullable<TranscriptMessage['workdir']>,
  mode: WorkdirPickerMode,
  icons: TranscriptIcons,
): string {
  const crumbs = workdirBreadcrumbs(w.breadcrumbs ?? [], mode);
  const upIcon = icons.icon.arrowUp ?? '';
  const upBtn = w.parent
    ? `<button type="button" class="wd-act wd-up" ${wdBrowseAttr(mode, w.parent.buttonId, w.parent.path)} title="${text(tr('workdir.upTitle', { path: w.parent.path }))}">${upIcon}<span>${text(tr('workdir.up'))}</span></button>`
    : `<button type="button" class="wd-act wd-up" disabled>${upIcon}<span>${text(tr('workdir.up'))}</span></button>`;
  const homeBtn = w.home
    ? `<button type="button" class="wd-act wd-home" ${wdBrowseAttr(mode, w.home.buttonId, w.home.path)} title="${text(tr('workdir.rootTitle', { path: w.home.path }))}">${icons.icon.home ?? ''}<span>${text(tr('workdir.root'))}</span></button>`
    : '';
  const sc = w.selectCurrent;
  const pickBtn =
    `<button type="button" class="wd-choose wd-pick-bar${sc.current ? ' on' : ''}" ${wdPickAttr(mode, sc.buttonId, sc.path)} title="${text(tr('workdir.chooseTitle', { path: sc.path }))}">` +
    `${icons.icon.check ?? ''}<span>${text(tr('workdir.choose'))}</span></button>`;
  return `<div class="wd-bar"><div class="wd-acts">${upBtn}${homeBtn}</div><nav class="wd-crumbs" aria-label="Path">${crumbs}</nav>${pickBtn}</div>`;
}

function workdirEntriesBody(
  entries: readonly WorkdirEntry[],
  mode: WorkdirPickerMode,
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
    if (entry) rows += workdirEntryRow(entry, mode, icons);
  }
  return (
    filterHtml +
    `<div class="wd-list">${rows}<div class="wd-empty wd-filter-empty" hidden>${text(tr('workdir.noMatch'))}</div></div>`
  );
}

export function workdirPickerHtml(
  w: NonNullable<TranscriptMessage['workdir']>,
  icons: TranscriptIcons,
  mode: WorkdirPickerMode,
): string {
  const hostPill = w.host ? `<span class="wd-meta">${text(w.host)}</span>` : '';
  const isLaunch = mode.kind === 'launch';
  const folded = Boolean(isLaunch && mode.folded);
  const selectedPath = (isLaunch && mode.selectedPath) || w.current || w.browsing;
  const changeBtn = isLaunch
    ? `<button type="button" class="launch-choice-change wd-change" data-launch-unfold="workdir"${folded ? '' : ' hidden'}>${text(tr('chat.launchChange'))}</button>`
    : '';
  const selectedRow = isLaunch
    ? `<div class="wd-selected"${folded ? '' : ' hidden'}><code class="wd-path" title="${text(selectedPath)}">${text(selectedPath)}</code></div>`
    : '';
  return (
    `<div class="wd-picker${folded ? ' folded' : ''}" data-browsing="${text(w.browsing)}">` +
    `<div class="wd-head"><div class="wd-title-row"><span class="wd-title">${icons.icon.folder ?? ''}<span>${text(tr('workdir.title'))}</span></span>` +
    `<span class="wd-head-right"><span class="wd-badges"><span class="wd-meta">${text(w.agentId)}</span>${hostPill}</span>${changeBtn}</span></div>` +
    `<div class="wd-hint"${folded ? ' hidden' : ''}>${text(tr('workdir.hint'))}</div>${selectedRow}</div>` +
    `<div class="wd-body"${folded ? ' hidden' : ''}>` +
    workdirActionsBar(w, mode, icons) +
    (w.error ? `<div class="wd-err" role="alert">${text(w.error)}</div>` : '') +
    workdirEntriesBody(w.entries ?? [], mode, icons) +
    (w.truncated > 0 ? `<div class="wd-more">${text(tr('workdir.truncated', { count: w.truncated }))}</div>` : '') +
    '</div></div>'
  );
}

export function workdirPicker(m: TranscriptMessage, icons: TranscriptIcons): string {
  const w = m.workdir;
  if (!w) return '';
  return workdirPickerHtml(w, icons, { kind: 'msg', msg: text(m.id) });
}

export function handoffActionRow(key: string, m: TranscriptMessage, icons: TranscriptIcons): string {
  const ho = m.handoff;
  if (!ho) return '';
  const label = tr('msg.continueWithAgent', { agent: ho.agentName });
  return (
    `<div class="handoff-acts">` +
    `<button type="button" class="handoff-btn" data-handoff-k="${text(key)}">` +
    `${icons.icon.subagent ?? ''}<span>${text(label)}</span>` +
    '</button></div>'
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
  readonly canOpenSideDiff?: boolean;
  readonly showMessageActions?: boolean;
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
  let body = folded ? foldLines(key, m.html, ctx.opened) : m.html;
  if (m.kind === 'subagent') body = subagentCard(key, body, ctx.opened, ctx.icons);
  let h = `<div class="b">${body}</div>`;
  if (m.file) h += renderFileAttachment(m, hist);
  if (m.turnChanges) h += turnChangeRow(m, ctx.icons, ctx.canOpenGit, Boolean(ctx.canOpenSideDiff));
  if (!hist && m.buttons && m.buttons.length) h += renderMenu(m, ctx.icons);
  if (m.handoff) h += handoffActionRow(key, m, ctx.icons);
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
  const folded = kind !== undefined && LINE_KINDS.has(kind);
  const subKey = kind && Object.prototype.hasOwnProperty.call(SUB_K, kind) ? SUB_K[kind] : undefined;
  const tag = subKey ? tr(subKey) : '';
  const isStuck = stuck(m);
  const cls = msgClassName(m, hist, tag, isStuck);
  let h = '';
  if (tag) h += `<div class="sub-k">${tag}</div>`;
  if (m.quote && m.quote.html) {
    const jumpAttr = m.quote.id ? ` data-jump-msg="${text(m.quote.id)}" role="button" tabindex="0"` : '';
    h += `<div class="q"${jumpAttr}>${m.quote.html}</div>`;
  }
  h += msgBodyHtml(key, m, hist, folded, ctx);
  if (isStuck) h += failedActions(m, Boolean(m._nonce && ctx.hasOutbox(m._nonce)));
  const reactions =
    m.reactions && m.reactions.length
      ? '  ' + m.reactions.map((e) => reactionMark(e, ctx.icons)).join(' ')
      : '';
  h += `<div class="t">${text(clock(m.at))}${reactions}${linesToggle(key, kind, ctx.opened)}</div>`;
  if (ctx.showMessageActions !== false && !(!hist && m.workdir)) {
    h += messageActionsMarkup(key, m, ctx.icons, hist);
  }
  return { cls, h };
}
