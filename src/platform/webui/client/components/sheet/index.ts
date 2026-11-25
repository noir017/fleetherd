import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import type { OverlayManager } from '../../services/overlays.js';
import { type IconInput, renderIcon } from '../shared.js';

export interface BottomSheetAction {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly icon?: IconInput;
  readonly selected?: boolean;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onSelect?: () => void;
}

export interface BottomSheetOptions {
  readonly title?: string;
  readonly subtitle?: string;
  readonly body?: TemplateResult;
  readonly actions?: readonly BottomSheetAction[];
  readonly cancelLabel?: string;
  readonly showCancel?: boolean;
  readonly closeOnBackdrop?: boolean;
  readonly closeOnEscape?: boolean;
  readonly overlays?: OverlayManager;
  readonly container?: HTMLElement;
  readonly doc?: Document;
  readonly className?: string;
  readonly onSelect?: (id: string, action: BottomSheetAction) => void;
  readonly onClose?: () => void;
}

export interface BottomSheetController extends Disposable {
  readonly el: HTMLElement;
  isOpen(): boolean;
  close(): void;
}

let sheetSeq = 0;

function renderCheckMark(): TemplateResult {
  return html`<svg class="fh-sheet-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17.5 19.5 7"/></svg>`;
}

function renderSheetActions(
  actions: readonly BottomSheetAction[],
  onPick: (action: BottomSheetAction) => void,
): TemplateResult {
  return html`
    <div class="fh-sheet-options" role="menu">
      ${actions.map((action) => {
        const cls =
          `fh-sheet-option${action.selected ? ' is-selected' : ''}` +
          `${action.danger ? ' is-danger' : ''}` +
          `${action.disabled ? ' is-disabled' : ''}`;
        return html`<button
          type="button"
          class=${cls}
          role="menuitem"
          data-sheet-action=${action.id}
          ?disabled=${Boolean(action.disabled)}
          @click=${() => onPick(action)}
        >
          ${renderIcon(action.icon, 'fh-sheet-option-icon')}
          <span class="fh-sheet-option-label">${action.label}</span>
          ${action.detail ? html`<small class="fh-sheet-option-detail">${action.detail}</small>` : nothing}
          ${action.selected ? renderCheckMark() : nothing}
        </button>`;
      })}
    </div>
  `;
}

function renderSheetTemplate(
  opts: BottomSheetOptions,
  titleId: string,
  showCancel: boolean,
  cancelLabel: string,
  onPick: (action: BottomSheetAction) => void,
  onClose: () => void,
): TemplateResult {
  return html`<div
    class="fh-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby=${opts.title ? titleId : nothing}
    tabindex="-1"
  >
    <div class="fh-sheet-grab" aria-hidden="true"></div>
    ${opts.title || opts.subtitle
      ? html`<div class="fh-sheet-head">
          ${opts.title ? html`<b class="fh-sheet-title" id=${titleId}>${opts.title}</b>` : nothing}
          ${opts.subtitle ? html`<small class="fh-sheet-subtitle">${opts.subtitle}</small>` : nothing}
        </div>`
      : nothing}
    <div class="fh-sheet-body">
      ${opts.body ?? nothing}
      ${opts.actions && opts.actions.length > 0 ? renderSheetActions(opts.actions, onPick) : nothing}
    </div>
    ${showCancel
      ? html`<button type="button" class="fh-sheet-cancel" data-sheet-cancel="true" @click=${onClose}>${cancelLabel}</button>`
      : nothing}
  </div>`;
}

export function openBottomSheet(opts: BottomSheetOptions): BottomSheetController {
  const doc = opts.doc ?? document;
  const listeners = new DisposableStore();
  const prevFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const seq = ++sheetSeq;
  const titleId = `fh-sheet-title-${seq}`;

  const backdrop = doc.createElement('div');
  backdrop.className = `fh-sheet-backdrop${opts.className ? ` ${opts.className}` : ''}`;
  (opts.container ?? doc.body).appendChild(backdrop);

  let closed = false;
  const closeOnBackdrop = opts.closeOnBackdrop !== false;
  const closeOnEscape = opts.closeOnEscape !== false;
  const showCancel = opts.showCancel === true || Boolean(opts.cancelLabel);
  const cancelLabel = opts.cancelLabel ?? tr('common.cancel');

  const close = (): void => {
    if (closed) return;
    closed = true;
    listeners.dispose();
    render(nothing, backdrop);
    backdrop.remove();
    opts.onClose?.();
    if (!opts.overlays) focusSafely(prevFocus);
  };

  const pickAction = (action: BottomSheetAction): void => {
    if (action.disabled) return;
    close();
    action.onSelect?.();
    opts.onSelect?.(action.id, action);
  };

  render(
    renderSheetTemplate(opts, titleId, showCancel, cancelLabel, pickAction, close),
    backdrop,
  );

  listeners.add(
    addDisposableListener(backdrop, 'click', (ev: MouseEvent) => {
      if (closeOnBackdrop && ev.target === backdrop) close();
    }),
  );

  listeners.add(
    addDisposableListener(backdrop, 'keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !opts.overlays && !ev.isComposing && closeOnEscape) {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      }
    }),
  );

  if (opts.overlays) {
    listeners.add(
      opts.overlays.push({
        id: `fh-sheet-${seq}`,
        close: () => {
          if (!closeOnEscape) return false;
          close();
          return true;
        },
        restoreFocus: prevFocus,
      }),
    );
  }

  const sheetEl = backdrop.querySelector<HTMLElement>('.fh-sheet');
  focusSafely(sheetEl?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? sheetEl);

  return {
    el: backdrop,
    isOpen: () => !closed,
    close,
    dispose: close,
  };
}
