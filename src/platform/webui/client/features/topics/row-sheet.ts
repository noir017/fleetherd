import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type Disposable, DisposableStore, MutableDisposable } from '../../base/lifecycle.js';
import type { MenuActionItem, MenuEntry } from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import type { OverlayManager } from '../../services/overlays.js';

export interface TopicRowSheetHeader {
  readonly title: string;
  readonly subtitle: string;
}

export interface TopicRowSheetOptions {
  readonly doc?: Document;
  readonly overlays?: OverlayManager;
  readonly container?: HTMLElement;
}

export interface TopicRowSheetController extends Disposable {
  isOpen(): boolean;
  open(header: TopicRowSheetHeader, entries: readonly MenuEntry[]): void;
  close(): void;
}

function renderIconHtml(svg: string | undefined): TemplateResult | typeof nothing {
  if (!svg) return nothing;
  const tpl = document.createElement('template');
  tpl.innerHTML = svg;
  return html`<span class="wb-topic-sheet-icon" aria-hidden="true">${tpl.content}</span>`;
}

function filterSheetItems(entries: readonly MenuEntry[]): MenuActionItem[] {
  const out: MenuActionItem[] = [];
  for (const entry of entries) {
    if (entry.kind === 'separator' || entry.kind === 'header') continue;
    if (entry.id === 'topics.openInNewTab') continue;
    out.push(entry);
  }
  return out;
}

export function createTopicRowSheet(opts: TopicRowSheetOptions = {}): TopicRowSheetController {
  const doc = opts.doc ?? document;
  const listeners = new DisposableStore();
  const overlaySub = new MutableDisposable();
  let openState = false;
  let prevFocus: HTMLElement | null = null;

  const host = doc.createElement('div');
  host.className = 'wb-topic-sheet-host';
  host.hidden = true;
  (opts.container ?? doc.body).appendChild(host);

  const close = (): void => {
    if (!openState) return;
    openState = false;
    overlaySub.clear();
    host.hidden = true;
    render(nothing, host);
    if (!opts.overlays) focusSafely(prevFocus);
    prevFocus = null;
  };

  const open = (header: TopicRowSheetHeader, entries: readonly MenuEntry[]): void => {
    const items = filterSheetItems(entries);
    if (items.length === 0) return;
    prevFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    openState = true;
    host.hidden = false;

    const template = html`
      <div class="wb-topic-sheet-scrim" @click=${() => close()}></div>
      <div
        class="wb-topic-sheet"
        role="dialog"
        aria-modal="true"
        aria-label=${header.title}
        tabindex="-1"
      >
        <div class="wb-topic-sheet-grab" aria-hidden="true"></div>
        <div class="wb-topic-sheet-head">
          <b class="wb-topic-sheet-title">${header.title}</b>
          ${header.subtitle ? html`<small class="wb-topic-sheet-sub">${header.subtitle}</small>` : nothing}
        </div>
        <div class="wb-topic-sheet-body" role="menu">
          ${items.map(
            (item) => html`<button
              type="button"
              class=${`wb-topic-sheet-op${item.danger ? ' is-danger' : ''}`}
              role="menuitem"
              data-sheet-id=${item.id}
              ?disabled=${Boolean(item.disabled)}
              title=${item.title ?? nothing}
              @click=${() => {
                if (item.disabled) return;
                close();
                item.onSelect?.();
              }}
            >
              ${typeof item.icon === 'string' ? renderIconHtml(item.icon) : nothing}
              <span class="wb-topic-sheet-label">${item.label}</span>
            </button>`,
          )}
        </div>
        <button
          type="button"
          class="wb-topic-sheet-cancel"
          data-sheet-cancel="1"
          @click=${() => close()}
        >${tr('common.cancel')}</button>
      </div>
    `;
    render(template, host);

    if (opts.overlays) {
      overlaySub.value = opts.overlays.push({
        id: 'wb-topic-row-sheet',
        close: () => {
          close();
          return true;
        },
        restoreFocus: prevFocus,
      });
    }
    const first = host.querySelector<HTMLElement>('.wb-topic-sheet-op:not(:disabled), .wb-topic-sheet-cancel');
    focusSafely(first);
  };

  listeners.add(
    addDisposableListener(host, 'keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !opts.overlays && !ev.isComposing && openState) {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      }
    }),
  );

  return {
    isOpen: () => openState,
    open,
    close,
    dispose(): void {
      close();
      listeners.dispose();
      overlaySub.dispose();
      host.remove();
    },
  };
}
