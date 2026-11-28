import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, NOOP_DISPOSABLE } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import { text } from '../../../services/api.js';
import { foldLines, subagentHead } from './markup.js';
import { SubagentIndex, type SubagentRow } from './subagent-series.js';
import type { ToolOpenState, TranscriptIcons, TranscriptMessage } from './types.js';

export interface SubagentTrayDeps {
  readonly el: HTMLElement | null;
  readonly getData: () => Record<string, TranscriptMessage | undefined>;
  readonly getIcons: () => TranscriptIcons;
}

export interface SubagentTrayController extends Disposable {
  /** The topic's subagent messages changed: repaint once the current task is done. */
  refresh(): void;
  /** The subagent a message is part of (subagent-series.ts): its first message's key and its state. */
  rowOf(key: string): SubagentRow | undefined;
  /** Open the bar on one subagent, its tools shown (the transcript's one-line message, tapped). */
  reveal(key: string): void;
  /** Another topic: folded, nothing open. */
  reset(): void;
  attach(): Disposable;
}

/**
 * The bar above the status line that lists the harness's own subagents (kind `subagent`): folded to
 * how many are running, open to one row each, and each row open to its tools. The transcript keeps
 * a line where each started (markup.ts subagentMarker); the bar reads the same messages, so a
 * message's every edit reaches both. A subagent drawn in several messages is one row
 * (subagent-series.ts), keyed by its first.
 */
class SubagentTray implements SubagentTrayController {
  private expanded = false;
  private readonly open = new Set<string>();
  private readonly lines: Record<string, ToolOpenState> = {};
  private readonly items = new Map<string, HTMLElement>();
  private readonly sig = new Map<string, string>();
  private head: HTMLButtonElement | null = null;
  private list: HTMLElement | null = null;
  private headSig = '';
  private queued = false;
  private readonly index: SubagentIndex;

  constructor(private readonly deps: SubagentTrayDeps) {
    this.index = new SubagentIndex(deps.getData, () => deps.el?.ownerDocument ?? document);
  }

  rowOf(key: string): SubagentRow | undefined {
    return this.index.rowOf(key);
  }

  refresh(): void {
    this.index.invalidate();
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.paint();
    });
  }

  reveal(key: string): void {
    this.expanded = true;
    this.open.add(key);
    this.paint();
    const item = this.items.get(key);
    if (item && this.list) this.list.scrollTop = Math.max(0, item.offsetTop - this.list.offsetTop);
    item?.querySelector<HTMLElement>('[data-sat]')?.focus({ preventScroll: true });
  }

  reset(): void {
    this.index.invalidate();
    this.expanded = false;
    this.open.clear();
    for (const k of Object.keys(this.lines)) delete this.lines[k];
    for (const el of this.items.values()) el.remove();
    this.items.clear();
    this.sig.clear();
    this.paint();
  }

  attach(): Disposable {
    const el = this.deps.el;
    if (!el) return NOOP_DISPOSABLE;
    return addDisposableListener(el, 'click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest('.sat-h')) {
        this.expanded = !this.expanded;
        this.paint();
        return;
      }
      const row = target.closest('[data-sat]');
      const rowKey = row?.getAttribute('data-sat');
      if (rowKey) {
        if (!this.open.delete(rowKey)) this.open.add(rowKey);
        this.paint();
        return;
      }
      const line = target.closest<HTMLElement>('.tl');
      if (line) this.toggleLine(line);
    });
  }

  dispose(): void {
    this.items.clear();
  }

  private toggleLine(line: HTMLElement): void {
    const sel = line.ownerDocument.defaultView?.getSelection?.();
    if (sel && String(sel)) return;
    const key = line.closest('[data-sat-k]')?.getAttribute('data-sat-k');
    const i = line.getAttribute('data-i');
    if (!key || i === null) return;
    const st = this.lines[key] || (this.lines[key] = { all: false, lines: {} });
    st.lines[i] = !st.lines[i];
    this.paint();
  }

  /** Newest first: the ones still running are the latest the agent started or resumed. */
  private entries(): SubagentRow[] {
    return [...this.index.rows()].sort((a, b) => b.at - a.at || b.order - a.order);
  }

  private paint(): void {
    const el = this.deps.el;
    if (!el) return;
    const all = this.entries();
    if (all.length === 0) {
      el.hidden = true;
      return;
    }
    this.build(el);
    el.hidden = false;
    el.classList.toggle('open', this.expanded);
    this.paintHead(all);
    if (this.list) this.list.hidden = !this.expanded;
    if (this.expanded) this.paintList(all);
  }

  private build(el: HTMLElement): void {
    if (this.head && this.list) return;
    const doc = el.ownerDocument;
    this.head = doc.createElement('button');
    this.head.type = 'button';
    this.head.className = 'sat-h';
    this.list = doc.createElement('div');
    this.list.className = 'sat-list';
    el.replaceChildren(this.head, this.list);
  }

  private paintHead(all: readonly SubagentRow[]): void {
    const head = this.head;
    if (!head) return;
    const icons = this.deps.getIcons();
    const running = all.filter((e) => e.p.st === 'run').length;
    const label = running
      ? tr(running === 1 ? 'subagents.runningOne' : 'subagents.running', { count: running })
      : tr(all.length === 1 ? 'subagents.endedOne' : 'subagents.ended', { count: all.length });
    const lead = running ? '<span class="sa-spin"></span>' : (icons.icon.subagent ?? '');
    const html = `${lead}<span class="sat-t">${text(label)}</span>${icons.icon.chevronDown ?? ''}`;
    head.setAttribute('aria-expanded', String(this.expanded));
    head.classList.toggle('st-run', running > 0);
    if (html !== this.headSig) {
      head.innerHTML = html;
      this.headSig = html;
    }
  }

  private paintList(all: readonly SubagentRow[]): void {
    const list = this.list;
    if (!list) return;
    const icons = this.deps.getIcons();
    const keep = new Set<string>();
    let prev: Element | null = null;
    for (const e of all) {
      keep.add(e.key);
      const item = this.item(e.key, list);
      const opened = this.open.has(e.key);
      const html =
        `<button type="button" class="sa-h" data-sat="${text(e.key)}" aria-expanded="${opened}">` +
        `${subagentHead(e.p, icons)}${icons.icon.chevronDown ?? ''}</button>` +
        (opened ? foldLines(e.key, e.p.body, this.lines) : '');
      const cls = `sa st-${e.p.st}${opened ? ' open' : ''}`;
      if (this.sig.get(e.key) !== html || item.className !== cls) {
        item.className = cls;
        item.innerHTML = html;
        this.sig.set(e.key, html);
      }
      const at: Element | null = prev ? prev.nextElementSibling : list.firstElementChild;
      if (at !== item) list.insertBefore(item, at);
      prev = item;
    }
    for (const [key, item] of this.items) {
      if (keep.has(key)) continue;
      item.remove();
      this.items.delete(key);
      this.sig.delete(key);
      this.open.delete(key);
      delete this.lines[key];
    }
  }

  private item(key: string, list: HTMLElement): HTMLElement {
    let item = this.items.get(key);
    if (!item) {
      item = list.ownerDocument.createElement('div');
      item.setAttribute('data-sat-k', key);
      this.items.set(key, item);
    }
    return item;
  }
}

export function createSubagentTray(deps: SubagentTrayDeps): SubagentTrayController {
  return new SubagentTray(deps);
}
