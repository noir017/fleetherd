import { t as tr } from '../../../i18n/index.js';
import { text } from '../../../services/api.js';
import type { AgentStatus, QuotaPool, StatusOption } from './types.js';

export interface StatusRenderOptions {
  readonly fallbackOptions: readonly StatusOption[];
  readonly openModel: boolean;
  readonly openOptId: string | null;
}

export interface BareStatusRenderOptions {
  readonly agent: string;
  readonly model: string;
  readonly options: readonly StatusOption[];
  readonly openModel: boolean;
  readonly openOptId: string | null;
}

// Same units as core/runtime-footer.ts formatTokens / formatWindow so status and reply footer match.
export function stTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(n / 1000)}k`;
}

export function stWindow(n: number): string {
  return n >= 1e6
    ? `${(Math.floor(n / 1e5) / 10).toFixed(1).replace(/\.0$/, '')}M`
    : `${Math.floor(n / 1000)}k`;
}

export function stLeft(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d${h ? ` ${h}h` : ''}`;
  if (h > 0) return `${h}h${mm ? ` ${mm}m` : ''}`;
  return `${m}m`;
}

export function stClock(at: number): string {
  const dt = new Date(at);
  const hh = dt.getHours();
  const mm = dt.getMinutes();
  return `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`;
}

export function poolLabel(id: string): string {
  const cut = id.lastIndexOf('-');
  let fam = cut > 0 ? id.slice(0, cut) : id;
  let win = cut > 0 ? id.slice(cut + 1) : '';
  fam = fam === '3p' ? '3P' : fam === 'gemini' ? 'Gemini' : fam;
  win = win === 'weekly' ? 'wk' : win === 'daily' ? 'day' : win;
  return win ? `${fam} ${win}` : fam;
}

export function hasCountdown(s: AgentStatus | null | undefined): boolean {
  if (!s) return false;
  if (s.cacheExpiresAt) return true;
  const pools = s.quota ?? [];
  for (const pool of pools) {
    if (pool.resetsAt) return true;
  }
  return false;
}

export function seg(cls: string, title: string, html: string): string {
  return (
    `<span class="st${cls ? ` ${cls}` : ''}"` +
    `${title ? ` title="${text(title)}"` : ''}>${html}</span>`
  );
}

export function modelChip(label: string, expanded: boolean): string {
  return (
    `<button type="button" class="st-model" aria-haspopup="dialog" aria-expanded="${expanded ? 'true' : 'false'}"` +
    ` title="${text(tr('status.switchModelTitle'))}"><span class="st-mtext">${text(label)}</span></button>`
  );
}

export function optChip(o: StatusOption, openOptId: string | null): string {
  const val = o.value !== undefined && o.value !== null ? String(o.value) : '';
  const body =
    `<span class="st-olabel">${text(o.name)}</span>` +
    `${val ? ` <span class="st-mtext">${text(val)}</span>` : ''}`;
  const note = o.note ? `\n${o.note}` : '';
  if (o.fixed) {
    return (
      `<button type="button" class="st-model st-opt fixed" disabled data-opt="${text(o.id)}"` +
      ` title="${text(tr('status.optFixedTitle', { name: o.name, val, note }))}">${body}</button>`
    );
  }
  const open = openOptId === o.id;
  return (
    `<button type="button" class="st-model st-opt" data-opt="${text(o.id)}" aria-haspopup="dialog" aria-expanded="${open ? 'true' : 'false'}"` +
    ` title="${text(tr('status.optSwitchTitle', { name: o.name, note }))}">${body}</button>`
  );
}

export function optChips(
  list: readonly StatusOption[] | undefined,
  openOptId: string | null,
): string {
  let h = '';
  for (const item of list ?? []) {
    h += `<span class="st-sep"> \u00b7 </span>${optChip(item, openOptId)}`;
  }
  return h;
}

function renderContextSegment(context: { readonly used: number; readonly size: number }): string {
  const pct = Math.min(100, Math.max(0, Math.round((context.used / context.size) * 100)));
  const cls = pct >= 80 ? 'bad' : pct >= 50 ? 'warn' : '';
  return seg(
    cls,
    tr('status.contextTip', {
      used: context.used.toLocaleString(),
      size: context.size.toLocaleString(),
    }),
    `<i class="st-meter"><i style="width:${pct}%"></i></i>${pct}%` +
      `<span class="st-x">${stTokens(context.used)}/${stWindow(context.size)}</span>`,
  );
}

function renderCostSegment(cost: { readonly amount: number; readonly currency: string }): string {
  const label =
    cost.currency === 'USD'
      ? `$${cost.amount.toFixed(2)}`
      : text(`${cost.amount.toFixed(2)} ${cost.currency}`);
  return seg(
    '',
    tr('status.costTip', { amount: cost.amount.toFixed(4), currency: cost.currency }),
    label,
  );
}

function renderCacheSegment(cacheExpiresAt: number, now: number): string {
  const left = cacheExpiresAt - now;
  const clock = stClock(cacheExpiresAt);
  if (left > 0) {
    return seg(
      left < 5 * 60000 ? 'warn' : '',
      tr('status.cacheTip', { clock }),
      text(tr('status.cacheLeft', { left: stLeft(left) })),
    );
  }
  return seg('', tr('status.cacheExpiredTip', { clock }), text(tr('status.cacheExpired')));
}

export function renderQuotaSegments(
  pools: readonly QuotaPool[],
  now: number,
  open: boolean,
): string[] {
  const out: string[] = [];
  const anyActive = pools.some((p) => Boolean(p.active));
  const accounts = new Set<string>();
  for (const p of pools) {
    if (p.account) accounts.add(p.account);
  }
  const multiAcct = accounts.size > 1;
  for (const p of pools) {
    const off = anyActive && !p.active;
    if (off && !open) continue;
    const rp = Math.round(p.remaining * 100);
    const reset = p.resetsAt && rp < 100 ? ` (${stLeft(p.resetsAt - now)})` : '';
    const acctPrefix = multiAcct && p.account ? `${p.account.split('@')[0] ?? ''} ` : '';
    const tip =
      (p.account ? `${p.account}${p.resetsAt ? ' \u00b7 ' : ''}` : '') +
      (p.resetsAt ? tr('status.refills', { when: new Date(p.resetsAt).toLocaleString() }) : '');
    const level = rp <= 15 ? 'bad' : rp <= 40 ? 'warn' : '';
    const cls = `${level}${off ? ' off' : ''}`;
    out.push(seg(cls, tip, text(`${acctPrefix}${poolLabel(p.id)} ${rp}%${reset}`)));
  }
  return out;
}

export function statusSegments(
  s: AgentStatus,
  now: number,
  open: boolean,
  opts: StatusRenderOptions,
): string {
  const out: string[] = [];
  const whoHtml =
    `<span class="st-agent">${text(s.agent)}</span><span class="st-sep"> \u00b7 </span>${modelChip(s.model || tr('status.model'), opts.openModel)}` +
    `${s.effort ? `<span class="st-sep"> \u00b7 </span><span class="st-effort">${text(s.effort)}</span>` : ''}` +
    optChips(s.options ?? opts.fallbackOptions, opts.openOptId);
  out.push(seg('st-who', '', whoHtml));
  if (s.context && s.context.size > 0) {
    out.push(renderContextSegment(s.context));
  }
  if (s.cost) {
    out.push(renderCostSegment(s.cost));
  }
  if (s.cacheExpiresAt) {
    out.push(renderCacheSegment(s.cacheExpiresAt, now));
  }
  if (s.quota && s.quota.length > 0) {
    out.push(...renderQuotaSegments(s.quota, now, open));
  }
  return out.join('');
}

export function renderBareStatus(opts: BareStatusRenderOptions): string {
  const bareWho =
    `${opts.agent ? `<span class="st-agent">${text(opts.agent)}</span><span class="st-sep"> \u00b7 </span>` : ''}` +
    modelChip(opts.model || tr('status.model'), opts.openModel) +
    optChips(opts.options, opts.openOptId);
  return seg('st-who', '', bareWho);
}
