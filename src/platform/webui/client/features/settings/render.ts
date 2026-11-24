import type {
  SettingsScreen,
  SettingsScreenField,
  SettingsScreenNotice,
  SettingsScreenOption,
  SettingsScreenRow,
} from '../../../../../types.js';
import { icon } from '../../../icons.js';
import { t as tr } from '../../i18n/index.js';
import { text } from '../../services/api.js';
import type { SettingsWebMessage } from './types.js';

export interface SettingsRenderContext {
  readonly topicTitle: string;
  readonly errorNote: string | null;
  readonly openAgentId: string | null;
  readonly renderOrphans: () => string;
  readonly renderAgentInstructions: (row: { target?: string; label: string }, index: number) => string;
}

// Ordered so the six built-in harness names hash onto distinct hues (pinned by page.dom.settings.test.ts).
export const AG_HUES = [0, 52, 245, 24, 188, 330, 100, 210, 280, 158] as const;

export function agHue(kind: string | undefined): number {
  const s = String(kind || '');
  let x = 0;
  for (let i = 0; i < s.length; i++) {
    x = (x * 31 + s.charCodeAt(i)) >>> 0;
  }
  return AG_HUES[x % AG_HUES.length] ?? AG_HUES[0];
}

// Escape first so the only markup emitted is the <code> spans added here.
export function inlineCodeHtml(s: unknown): string {
  return text(s == null ? '' : s).replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
}

export function settingsNoticeHtml(n: SettingsScreenNotice | null | undefined): string {
  if (!n) return '';
  const tone = n.tone === 'ok' || n.tone === 'error' ? n.tone : 'info';
  return (
    '<div class="set-notice ' +
    tone +
    '" role="' +
    (tone === 'error' ? 'alert' : 'status') +
    '">' +
    inlineCodeHtml(n.text) +
    '</div>'
  );
}

// Chat labels for scheduled tasks lead with ⏰; render our inline SVG clock so systems without emoji fonts never show tofu.
export function settingsLabelHtml(label: string | null | undefined): string {
  const s = String(label == null ? '' : label);
  const m = /^\u23f0\uFE0F? */.exec(s);
  return '<span>' + (m ? icon('clock') + ' ' + text(s.slice(m[0].length)) : text(s)) + '</span>';
}

function isShortChoice(opts: readonly SettingsScreenOption[], select: boolean): boolean {
  if (select || opts.length === 0 || opts.length > 5) return false;
  for (const opt of opts) {
    if (String(opt.label).length > 6) return false;
  }
  return true;
}

export function settingsChoiceHtml(
  label: string,
  opts: readonly SettingsScreenOption[],
  key: string,
  value: string | undefined,
  select = false,
  cls = '',
): string {
  if (isShortChoice(opts, select)) {
    let h = '';
    for (let j = 0; j < opts.length; j++) {
      const o = opts[j];
      if (!o) continue;
      h +=
        '<button type="button" role="radio" aria-checked="' +
        (o.current ? 'true' : 'false') +
        '" data-fk="' +
        key +
        'o' +
        j +
        '" data-btn="' +
        text(o.buttonId) +
        '"' +
        (o.detail ? ' title="' + text(o.detail) + '"' : '') +
        '>' +
        text(o.label) +
        '</button>';
    }
    return '<div class="set-seg" role="radiogroup" aria-label="' + text(label) + '">' + h + '</div>';
  }
  let h = '';
  let any = false;
  for (const p of opts) {
    if (p.current) any = true;
    h +=
      '<option value="' +
      text(p.buttonId) +
      '"' +
      (p.current ? ' selected' : '') +
      (p.detail ? ' title="' + text(p.detail) + '"' : '') +
      '>' +
      text(p.label) +
      '</option>';
  }
  if (!any) {
    h = '<option value="" selected disabled>' + text(value == null ? '' : value) + '</option>' + h;
  }
  return (
    '<select class="set-select' +
    (cls ? ' ' + cls : '') +
    '" data-fk="' +
    key +
    '" aria-label="' +
    text(label) +
    '">' +
    h +
    '</select>'
  );
}

function settingsTextHtml(r: SettingsScreenRow, topicTitle: string): string {
  let badges = '';
  if (r.here) {
    badges +=
      '<span class="set-badge here" title="' +
      text(tr('settings.thisTopicTitle', { title: topicTitle })) +
      '">' +
      text(tr('settings.thisTopic')) +
      '</span>';
  }
  if (r.effectLabel) {
    badges +=
      '<span class="set-badge restart"' +
      (r.effectDetail ? ' title="' + text(r.effectDetail) + '"' : '') +
      '>' +
      text(r.effectLabel) +
      '</span>';
  }
  return (
    '<div class="set-tx"><div class="set-label">' +
    settingsLabelHtml(r.label) +
    (r.targetKind ? '<span class="set-kind">' + text(r.targetKind) + '</span>' : '') +
    badges +
    '</div>' +
    (r.hint ? '<div class="set-hint">' + inlineCodeHtml(r.hint) + '</div>' : '') +
    '</div>'
  );
}

function settingsItemHtml(r: SettingsScreenRow, i: number, topicTitle: string): string {
  const c = r.control || { kind: 'list' as const };
  if (c.kind === 'switch') {
    return (
      '<div class="set-item sw">' +
      settingsTextHtml(r, topicTitle) +
      '<div class="set-ctl"><button type="button" class="set-switch" role="switch" aria-checked="' +
      (c.on ? 'true' : 'false') +
      '" aria-label="' +
      text(r.label) +
      '" data-fk="r' +
      i +
      '" data-btn="' +
      text(c.set) +
      '"></button></div></div>'
    );
  }
  if (c.kind === 'choice') {
    return (
      '<div class="set-item">' +
      settingsTextHtml(r, topicTitle) +
      '<div class="set-ctl">' +
      settingsChoiceHtml(r.label, c.options || [], 'r' + i, r.value) +
      '</div></div>'
    );
  }
  let value = '';
  if (c.kind !== 'link' && r.value != null) {
    value =
      '<span class="set-vv"><span class="set-v' +
      (r.unset ? ' unset' : '') +
      '" title="' +
      text(r.value) +
      '">' +
      text(r.value) +
      '</span>' +
      (r.valueNote ? '<span class="set-vnote">' + text(r.valueNote) + '</span>' : '') +
      '</span>';
  }
  return (
    '<button type="button" class="set-item set-open" data-fk="r' +
    i +
    '" data-btn="' +
    text(r.buttonId) +
    '">' +
    settingsTextHtml(r, topicTitle) +
    value +
    '<span class="set-chev" aria-hidden="true">' +
    icon('chevronRight') +
    '</span></button>'
  );
}

function settingsFieldFootHtml(
  extra: string | undefined,
  note: string,
  badge: string,
): string {
  const parts: string[] = [];
  if (extra) parts.push('<span>' + text(extra) + '</span>');
  if (note) parts.push('<span>' + text(note) + '</span>');
  if (!parts.length && !badge) return '';
  return '<div class="ag-note">' + parts.join('<span aria-hidden="true">\u00b7</span>') + badge + '</div>';
}

function settingsFieldChoiceHtml(
  agent: string,
  f: SettingsScreenField,
  key: string,
  opts: readonly SettingsScreenOption[],
  v: string,
  unset: string,
  tip: string,
  note: string,
  badge: string,
): string {
  const now = opts.find((opt) => opt.current) ?? null;
  if (opts.length < 2) {
    const only = opts[0];
    const title = only && only.detail ? text(only.detail) : tip;
    const label = text(only ? only.label : v);
    return (
      '<span class="ag-fixed' +
      unset +
      '" title="' +
      title +
      '">' +
      label +
      '</span>' +
      settingsFieldFootHtml(only?.detail, note, badge)
    );
  }
  return (
    settingsChoiceHtml(agent + ' \u00b7 ' + f.label, opts, key, v, false, f.unset ? 'unset' : '') +
    settingsFieldFootHtml(now?.detail, note, badge)
  );
}

function settingsFieldHtml(agent: string, f: SettingsScreenField, key: string): string {
  const c = f.control || { kind: 'list' as const };
  const v = f.value == null ? '' : String(f.value);
  const unset = f.unset ? ' unset' : '';
  const tip = f.unset ? text(v + tr('settings.notSetParen')) : text(v);
  const badge = f.effectLabel
    ? '<span class="set-badge restart"' +
      (f.effectDetail ? ' title="' + text(f.effectDetail) + '"' : '') +
      '>' +
      text(f.effectLabel) +
      '</span>'
    : '';
  const note = f.valueNote ? String(f.valueNote) : f.unset && c.kind === 'choice' ? tr('settings.notSet') : '';
  if (c.kind === 'choice') {
    return settingsFieldChoiceHtml(agent, f, key, c.options || [], v, unset, tip, note, badge);
  }
  return (
    '<button type="button" class="ag-open" data-fk="' +
    key +
    '" data-btn="' +
    text(f.buttonId) +
    '" aria-label="' +
    text(agent + ' \u00b7 ' + f.label + ': ' + v) +
    '"><span class="set-v' +
    unset +
    '" title="' +
    tip +
    '">' +
    text(v) +
    '</span><span class="set-chev" aria-hidden="true">' +
    icon('chevronRight') +
    '</span></button>' +
    settingsFieldFootHtml('', note, badge)
  );
}

function settingsAgentSummaryHtml(r: SettingsScreenRow, fields: readonly SettingsScreenField[]): string {
  const sum: string[] = r.targetKind ? ['<span class="ag-kind">' + text(r.targetKind) + '</span>'] : [];
  for (const f of fields) {
    const v = f.value == null ? '' : String(f.value);
    const cls = (f.label === 'Model' || f.label === '模型' ? 'ag-mono' : 'ag-lvl') + (f.unset ? ' unset' : '');
    const title = f.label + ': ' + v + (f.unset ? tr('settings.notSetParen') : '');
    sum.push('<span class="' + cls + '" title="' + text(title) + '">' + text(v) + '</span>');
  }
  return sum.join('<span class="ag-sep" aria-hidden="true">\u00b7</span>');
}

function settingsAgentHtml(r: SettingsScreenRow, i: number, ctx: SettingsRenderContext): string {
  const fields = r.control && r.control.kind === 'agent' ? r.control.fields || [] : [];
  const id = String(r.target || r.label);
  const open = ctx.openAgentId === id;
  const badges =
    (r.here
      ? '<span class="set-badge here" title="' +
        text(tr('settings.thisTopicTitle', { title: ctx.topicTitle })) +
        '">' +
        text(tr('settings.thisTopic')) +
        '</span>'
      : '') +
    (r.defaultAgent
      ? '<span class="set-badge def" title="' +
        text(tr('settings.defaultBadgeTitle')) +
        '">' +
        text(tr('chat.defaultTag')) +
        '</span>'
      : '');
  let body = '';
  for (let n = 0; n < fields.length; n++) {
    const field = fields[n];
    if (!field) continue;
    body +=
      '<div class="ag-field"><span class="ag-lab">' +
      text(field.label) +
      '</span><div class="ag-val">' +
      settingsFieldHtml(r.label, field, 'r' + i + 'f' + n) +
      '</div></div>';
  }
  body += ctx.renderAgentInstructions(r, i);
  return (
    '<div class="ag-card' +
    (open ? ' open' : '') +
    '" style="--ag-h:' +
    agHue(r.targetKind) +
    '" role="group" aria-label="' +
    text(r.label) +
    '" data-ag="' +
    text(id) +
    '"><button type="button" class="ag-top" data-fk="r' +
    i +
    'x" aria-expanded="' +
    (open ? 'true' : 'false') +
    '" aria-controls="ag-b' +
    i +
    '"><span class="ag-who"><span class="ag-id"><span class="ag-name">' +
    text(r.label) +
    '</span>' +
    badges +
    '</span><span class="ag-sum">' +
    settingsAgentSummaryHtml(r, fields) +
    '</span></span><span class="ag-chev" aria-hidden="true">' +
    icon('chevronDown') +
    '</span></button><div class="ag-body" id="ag-b' +
    i +
    '"' +
    (open ? '' : ' hidden') +
    '>' +
    body +
    '</div></div>'
  );
}

function settingsAgentsHtml(
  rows: readonly SettingsScreenRow[],
  idx: readonly number[],
  ctx: SettingsRenderContext,
): string {
  const places: string[] = [];
  const by = new Map<string, number[]>();
  for (const rowIndex of idx) {
    const row = rows[rowIndex];
    if (!row) continue;
    const place = String(row.place || '');
    const list = by.get(place);
    if (list) {
      list.push(rowIndex);
    } else {
      by.set(place, [rowIndex]);
      places.push(place);
    }
  }
  let h = '<div class="ag-list">';
  const heads = places.length > 1;
  for (const place of places) {
    const list = by.get(place) || [];
    if (heads) {
      h +=
        '<h4 class="ag-place"><span>' +
        text(place || tr('settings.elsewhere')) +
        '</span><span class="ag-count">' +
        list.length +
        '</span></h4>';
    }
    for (const rowIndex of list) {
      const row = rows[rowIndex];
      if (row) h += settingsAgentHtml(row, rowIndex, ctx);
    }
  }
  return h + '</div>';
}

interface ListSection {
  name: string;
  plain: number[];
  agents: number[];
}

function groupListSections(rows: readonly SettingsScreenRow[]): ListSection[] {
  const secs: ListSection[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const name = String(row.group == null ? '' : row.group);
    let sec = secs[secs.length - 1];
    if (!sec || sec.name !== name) {
      sec = { name, plain: [], agents: [] };
      secs.push(sec);
    }
    if (row.control && row.control.kind === 'agent') sec.agents.push(i);
    else sec.plain.push(i);
  }
  return secs;
}

function settingsListHtml(
  s: Extract<SettingsScreen, { level: 'list' }>,
  ctx: SettingsRenderContext,
): string {
  let h = '';
  if (s.about) h += '<p class="set-about">' + inlineCodeHtml(s.about) + '</p>';
  if (ctx.errorNote) h += settingsNoticeHtml({ tone: 'error', text: ctx.errorNote });
  h += settingsNoticeHtml(s.notice);
  const notes: Record<string, string | undefined> = {};
  for (const g of s.groups || []) {
    notes[g.name] = g.note;
  }
  const rows = s.rows || [];
  const secs = groupListSections(rows);
  let agentsShown = false;
  for (const x of secs) {
    h +=
      '<section class="set-sec">' +
      (x.name ? '<h3 class="set-group">' + text(x.name) + '</h3>' : '') +
      (notes[x.name] ? '<p class="set-gnote">' + inlineCodeHtml(notes[x.name]) + '</p>' : '');
    if (x.plain.length) {
      h += '<div class="set-card">';
      for (const idx of x.plain) {
        const row = rows[idx];
        if (row) h += settingsItemHtml(row, idx, ctx.topicTitle);
      }
      h += '</div>';
    }
    if (x.agents.length) h += settingsAgentsHtml(rows, x.agents, ctx);
    if (x.name === 'Agents' || x.name === '代理设置') {
      h += ctx.renderOrphans();
      agentsShown = true;
    }
    h += '</section>';
  }
  if (!agentsShown) h += ctx.renderOrphans();
  return h;
}

function settingsOptionHtml(o: SettingsScreenOption, i: number): string {
  return (
    '<button type="button" class="set-opt' +
    (o.current ? ' on' : '') +
    '" data-fk="o' +
    i +
    '" data-btn="' +
    text(o.buttonId) +
    '"' +
    (o.current ? ' aria-current="true"' : '') +
    ' data-q="' +
    text(String(o.label + ' ' + (o.detail || '')).toLowerCase()) +
    '"><span class="set-check" aria-hidden="true">' +
    (o.current ? icon('check') : '') +
    '</span><span class="set-opt-main"><span class="set-opt-label">' +
    text(o.label) +
    '</span>' +
    (o.detail ? '<span class="set-opt-detail">' + text(o.detail) + '</span>' : '') +
    '</span></button>'
  );
}

function settingsValuesHeadHtml(s: Extract<SettingsScreen, { level: 'values' }>): string {
  const hd = s.head;
  if (!hd) return '';
  return (
    '<div class="set-head"><h3><span>' +
    text(hd.label) +
    '</span>' +
    (hd.target ? '<span class="set-tgt">' + text(hd.target) + '</span>' : '') +
    (hd.targetKind ? '<span class="set-kind">' + text(hd.targetKind) + '</span>' : '') +
    '</h3><p class="set-now">' +
    text(tr('settings.now')) +
    '<span class="set-v' +
    (hd.unset ? ' unset' : '') +
    '">' +
    text(hd.value) +
    '</span></p>' +
    (hd.source ? '<p class="set-src">' + inlineCodeHtml(hd.source) + '</p>' : '') +
    '<p class="set-desc">' +
    inlineCodeHtml(hd.description) +
    '</p>' +
    (hd.effect ? '<p class="set-when">' + inlineCodeHtml(hd.effect) + '</p>' : '') +
    '</div>'
  );
}

function settingsValuesNavHtml(s: Extract<SettingsScreen, { level: 'values' }>): string {
  const n = s.nav;
  if (!n || n.pageCount <= 1) return '';
  return (
    '<div class="set-nav">' +
    (n.prev
      ? '<button type="button" data-fk="prev" data-btn="' +
        text(n.prev) +
        '">' +
        icon('chevronLeft') +
        ' ' +
        text(tr('common.prev')) +
        '</button>'
      : '') +
    '<span class="set-page">' +
    text(n.page) +
    ' / ' +
    text(n.pageCount) +
    '</span>' +
    (n.next
      ? '<button type="button" data-fk="next" data-btn="' +
        text(n.next) +
        '">' +
        text(tr('common.next')) +
        ' ' +
        icon('chevronRight') +
        '</button>'
      : '') +
    '</div>'
  );
}

function settingsValuesHtml(
  s: Extract<SettingsScreen, { level: 'values' }>,
  ctx: SettingsRenderContext,
): string {
  let h = '';
  const n = s.nav;
  if (n && n.back) {
    h +=
      '<button type="button" class="set-back" data-fk="back" data-btn="' +
      text(n.back) +
      '">' +
      icon('chevronLeft') +
      ' ' +
      text(tr('menu.allSettings')) +
      '</button>';
  }
  h += settingsValuesHeadHtml(s);
  if (ctx.errorNote) h += settingsNoticeHtml({ tone: 'error', text: ctx.errorNote });
  h += settingsNoticeHtml(s.notice);
  const opts = s.options || [];
  if (s.typed) {
    const placeholder = opts.length > 8 ? tr('settings.filterOrType') : s.typed.placeholder;
    h +=
      '<div class="set-typed"><input type="text" class="set-type" data-fk="typed" data-btn="' +
      text(s.typed.buttonId) +
      '" placeholder="' +
      text(placeholder) +
      '" aria-label="' +
      text(s.typed.placeholder) +
      '" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">' +
      '<button type="button" class="set-use" data-fk="use">' +
      text(tr('common.use')) +
      '</button></div>';
  }
  if (s.loading || (s.head && s.head.hint)) {
    const hintText = s.head && s.head.hint ? s.head.hint : tr('common.loading');
    h +=
      '<div class="set-hintbox' +
      (s.loading ? ' loading' : '') +
      '">' +
      (s.loading ? '<span class="set-spin" aria-hidden="true"></span>' : '') +
      inlineCodeHtml(hintText) +
      '</div>';
  }
  if (opts.length) {
    h += '<div class="set-card set-list">';
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i];
      if (opt) h += settingsOptionHtml(opt, i);
    }
    h += '</div><p class="set-nomatch" hidden>' + text(tr('settings.noModelMatch')) + '</p>';
  }
  h += settingsValuesNavHtml(s);
  return h;
}

export function renderSettingsScreen(m: SettingsWebMessage, ctx: SettingsRenderContext): string {
  const s = m.settings;
  if (!s) return '';
  return s.level === 'values' ? settingsValuesHtml(s, ctx) : settingsListHtml(s, ctx);
}
