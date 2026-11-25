import { focusSafely } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type Disposable } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import { renderBadge } from '../badge/index.js';
import { escapeAttrValue, type IconInput, renderIcon } from '../shared.js';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconInput;
  readonly title?: string;
  readonly badge?: number | string | null;
  readonly dirty?: boolean;
  readonly closable?: boolean;
  readonly disabled?: boolean;
}

export interface TabsOptions {
  readonly items: readonly TabItem[];
  readonly activeId: string;
  readonly singleTabMode?: 'bar' | 'header';
  readonly headerStatus?: TemplateResult;
  readonly headerActions?: TemplateResult;
  readonly closeIcon?: IconInput;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly onSelect: (id: string) => void;
  readonly onClose?: (id: string) => void;
}

export interface TabsController extends Disposable {
  readonly el: HTMLElement;
  update(next: Partial<Pick<TabsOptions, 'items' | 'activeId' | 'singleTabMode' | 'headerStatus' | 'headerActions'>>): void;
  setActive(id: string): void;
  getActive(): string;
}

export type SegmentedKind = 'nav' | 'value';

export interface SegmentedOption {
  readonly value: string;
  readonly label: string;
  readonly icon?: IconInput;
  readonly badge?: number | string | null;
  readonly title?: string;
  readonly disabled?: boolean;
}

export interface SegmentedOptions {
  readonly options: readonly SegmentedOption[];
  readonly value: string;
  readonly kind?: SegmentedKind;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly onChange: (value: string) => void;
}

export interface SegmentedController extends Disposable {
  readonly el: HTMLElement;
  update(next: Partial<Pick<SegmentedOptions, 'options' | 'value' | 'kind'>>): void;
  setValue(value: string): void;
  getValue(): string;
}

function nextEnabledIndex<T extends { readonly disabled?: boolean }>(
  items: readonly T[],
  currentIdx: number,
  key: string,
): number {
  const enabled: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i]?.disabled) enabled.push(i);
  }
  if (enabled.length === 0) return -1;
  const pos = enabled.indexOf(currentIdx);
  if (key === 'Home') return enabled[0] ?? -1;
  if (key === 'End') return enabled[enabled.length - 1] ?? -1;
  if (key === 'ArrowRight') return enabled[(pos + 1) % enabled.length] ?? -1;
  if (key === 'ArrowLeft') return enabled[(pos - 1 + enabled.length) % enabled.length] ?? -1;
  return -1;
}

function handleTabKeydown(
  ev: KeyboardEvent,
  items: readonly TabItem[],
  idx: number,
  onSelect: (id: string) => void,
): void {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'Home' && ev.key !== 'End') return;
  const next = nextEnabledIndex(items, idx, ev.key);
  if (next < 0) return;
  const targetItem = items[next];
  if (!targetItem) return;
  ev.preventDefault();
  onSelect(targetItem.id);
  const list = (ev.currentTarget as HTMLElement | null)?.closest('[role="tablist"]');
  const btn = list?.querySelector<HTMLElement>(`[data-tab-id="${escapeAttrValue(targetItem.id)}"]`);
  focusSafely(btn);
}

function renderSingleHeader(tab: TabItem, opts: TabsOptions): TemplateResult {
  const cls = `fh-tab-header${opts.className ? ` ${opts.className}` : ''}`;
  return html`<div class=${cls} data-single-tab="true" data-tab-id=${tab.id}>
    ${renderIcon(tab.icon, 'fh-tab-icon')}
    <span class="fh-tab-header-title" title=${tab.title ?? tab.label}>${tab.label}</span>
    ${tab.dirty ? html`<span class="fh-tab-dirty" aria-label="Unsaved"></span>` : nothing}
    ${opts.headerStatus ? html`<span class="fh-tab-header-status">${opts.headerStatus}</span>` : nothing}
    <span class="fh-tab-spacer"></span>
    ${opts.headerActions ? html`<div class="fh-tab-header-actions">${opts.headerActions}</div>` : nothing}
  </div>`;
}

export function renderTabs(opts: TabsOptions): TemplateResult {
  if (opts.singleTabMode === 'header' && opts.items.length === 1 && opts.items[0]) {
    return renderSingleHeader(opts.items[0], opts);
  }
  const closeLabel = tr('common.close');
  const cls = `fh-tabs${opts.className ? ` ${opts.className}` : ''}`;
  return html`<div class=${cls} role="tablist" aria-label=${opts.ariaLabel ?? nothing}>
    ${opts.items.map((tab, idx) => {
      const active = tab.id === opts.activeId;
      const tabCls =
        `fh-tab${active ? ' is-active' : ''}` +
        `${tab.dirty ? ' is-dirty' : ''}` +
        `${tab.disabled ? ' is-disabled' : ''}`;
      return html`<div class=${tabCls} role="presentation">
        <button
          type="button"
          class="fh-tab-btn"
          role="tab"
          data-tab-id=${tab.id}
          aria-selected=${active ? 'true' : 'false'}
          tabindex=${active ? '0' : '-1'}
          ?disabled=${Boolean(tab.disabled)}
          title=${tab.title ?? tab.label}
          @click=${() => { if (!tab.disabled) opts.onSelect(tab.id); }}
          @keydown=${(ev: KeyboardEvent) => handleTabKeydown(ev, opts.items, idx, opts.onSelect)}
        >
          ${renderIcon(tab.icon, 'fh-tab-icon')}
          <span class="fh-tab-label">${tab.label}</span>
          ${tab.dirty ? html`<span class="fh-tab-dirty" aria-label="Unsaved"></span>` : nothing}
          ${tab.badge != null && tab.badge !== '' ? renderBadge({ count: tab.badge }) : nothing}
        </button>
        ${tab.closable
          ? html`<button
              type="button"
              class="fh-tab-close"
              title=${closeLabel}
              aria-label=${`${closeLabel} ${tab.label}`}
              @click=${(ev: MouseEvent) => {
                ev.stopPropagation();
                opts.onClose?.(tab.id);
              }}
            >${opts.closeIcon ? renderIcon(opts.closeIcon, 'fh-icon') : html`<span aria-hidden="true">×</span>`}</button>`
          : nothing}
      </div>`;
    })}
  </div>`;
}

export function createTabs(opts: TabsOptions, doc: Document = document): TabsController {
  const host = doc.createElement('div');
  host.className = 'fh-tabs-host';
  let state: TabsOptions = { ...opts };

  const paint = (): void => {
    render(renderTabs(state), host);
  };
  paint();

  return {
    el: host,
    update(next): void {
      state = { ...state, ...next };
      paint();
    },
    setActive(id: string): void {
      state = { ...state, activeId: id };
      paint();
    },
    getActive(): string {
      return state.activeId;
    },
    dispose(): void {
      render(nothing, host);
      host.remove();
    },
  };
}

function handleSegKeydown(
  ev: KeyboardEvent,
  options: readonly SegmentedOption[],
  idx: number,
  onChange: (value: string) => void,
): void {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'Home' && ev.key !== 'End') return;
  const next = nextEnabledIndex(options, idx, ev.key);
  if (next < 0) return;
  const opt = options[next];
  if (!opt) return;
  ev.preventDefault();
  onChange(opt.value);
  const group = (ev.currentTarget as HTMLElement | null)?.closest('.fh-seg');
  const btn = group?.querySelector<HTMLElement>(`[data-seg-value="${escapeAttrValue(opt.value)}"]`);
  focusSafely(btn);
}

export function renderSegmented(opts: SegmentedOptions): TemplateResult {
  const kind = opts.kind ?? 'nav';
  const groupRole = kind === 'value' ? 'radiogroup' : 'tablist';
  const itemRole = kind === 'value' ? 'radio' : 'tab';
  const cls = `fh-seg fh-seg--${kind}${opts.className ? ` ${opts.className}` : ''}`;
  return html`<div class=${cls} role=${groupRole} aria-label=${opts.ariaLabel ?? nothing}>
    ${opts.options.map((opt, idx) => {
      const active = opt.value === opts.value;
      const btnCls = `fh-seg-item${active ? ' is-active' : ''}`;
      return html`<button
        type="button"
        class=${btnCls}
        role=${itemRole}
        data-seg-value=${opt.value}
        aria-selected=${kind === 'nav' ? (active ? 'true' : 'false') : nothing}
        aria-checked=${kind === 'value' ? (active ? 'true' : 'false') : nothing}
        tabindex=${active ? '0' : '-1'}
        ?disabled=${Boolean(opt.disabled)}
        title=${opt.title ?? nothing}
        @click=${() => { if (!opt.disabled) opts.onChange(opt.value); }}
        @keydown=${(ev: KeyboardEvent) => handleSegKeydown(ev, opts.options, idx, opts.onChange)}
      >
        ${renderIcon(opt.icon, 'fh-seg-icon')}
        <span class="fh-seg-label">${opt.label}</span>
        ${opt.badge != null && opt.badge !== ''
          ? renderBadge({ count: opt.badge, tone: 'neutral', className: 'fh-seg-count' })
          : nothing}
      </button>`;
    })}
  </div>`;
}

export function createSegmented(
  opts: SegmentedOptions,
  doc: Document = document,
): SegmentedController {
  const host = doc.createElement('div');
  host.className = 'fh-seg-host';
  let state: SegmentedOptions = { ...opts };

  const paint = (): void => {
    render(
      renderSegmented({
        ...state,
        onChange: (value) => {
          state = { ...state, value };
          paint();
          opts.onChange(value);
        },
      }),
      host,
    );
  };
  paint();

  return {
    el: host,
    update(next): void {
      state = { ...state, ...next };
      paint();
    },
    setValue(value: string): void {
      state = { ...state, value };
      paint();
    },
    getValue(): string {
      return state.value;
    },
    dispose(): void {
      render(nothing, host);
      host.remove();
    },
  };
}
