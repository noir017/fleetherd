import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import type { OverlayManager } from '../../services/overlays.js';
import { renderNotice } from '../notice/index.js';
import { getFocusableElements, type IconInput, renderIcon } from '../shared.js';

export interface DialogOptions {
  readonly title: string;
  readonly body: string | TemplateResult;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly loadingLabel?: string;
  readonly showCancel?: boolean;
  readonly danger?: boolean;
  readonly closeOnBackdrop?: boolean;
  readonly closeOnEscape?: boolean;
  readonly closeIcon?: IconInput;
  readonly overlays?: OverlayManager;
  readonly container?: HTMLElement;
  readonly doc?: Document;
  readonly className?: string;
  readonly onConfirm?: () => void | boolean | Promise<void | boolean>;
  readonly onCancel?: () => void;
  readonly onClose?: (confirmed: boolean) => void;
}

export interface DialogController extends Disposable {
  readonly el: HTMLElement;
  isOpen(): boolean;
  setLoading(loading: boolean): void;
  setError(message: string | null): void;
  close(confirmed?: boolean): void;
}

let dialogSeq = 0;

function trapTabKey(dialogEl: HTMLElement, ev: KeyboardEvent, doc: Document): void {
  if (ev.key !== 'Tab') return;
  const focusables = getFocusableElements(dialogEl);
  if (focusables.length === 0) {
    ev.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = doc.activeElement as HTMLElement | null;
  if (ev.shiftKey) {
    if (!active || active === first || !dialogEl.contains(active)) {
      ev.preventDefault();
      focusSafely(last);
    }
  } else if (!active || active === last || !dialogEl.contains(active)) {
    ev.preventDefault();
    focusSafely(first);
  }
}

interface DialogViewModel {
  readonly titleId: string;
  readonly bodyId: string;
  readonly opts: DialogOptions;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly loadingLabel: string;
  readonly showCancel: boolean;
  readonly loading: boolean;
  readonly errorMsg: string | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}

function renderDialogTemplate(vm: DialogViewModel): TemplateResult {
  const confirmCls = `fh-btn ${vm.opts.danger ? 'fh-btn--danger' : 'fh-btn--primary'}`;
  return html`<div
    class="fh-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby=${vm.titleId}
    aria-describedby=${vm.bodyId}
    tabindex="-1"
  >
    <div class="fh-dialog-head">
      <h2 class="fh-dialog-title" id=${vm.titleId}>${vm.opts.title}</h2>
      <button
        type="button"
        class="fh-dialog-close fh-btn fh-btn--ghost fh-btn--icon"
        title=${tr('common.closeEsc')}
        aria-label=${tr('common.close')}
        ?disabled=${vm.loading}
        @click=${vm.onClose}
      >${vm.opts.closeIcon ? renderIcon(vm.opts.closeIcon, 'fh-icon') : html`<span aria-hidden="true">×</span>`}</button>
    </div>
    <div class="fh-dialog-body" id=${vm.bodyId}>
      ${vm.opts.body}
      ${vm.errorMsg ? renderNotice({ tone: 'err', message: vm.errorMsg, className: 'fh-dialog-err' }) : nothing}
    </div>
    <div class="fh-dialog-foot">
      ${vm.showCancel
        ? html`<button
            type="button"
            class="fh-btn fh-btn--secondary"
            data-dialog-action="cancel"
            ?disabled=${vm.loading}
            @click=${vm.onClose}
          >${vm.cancelLabel}</button>`
        : nothing}
      <button
        type="button"
        class=${confirmCls}
        data-dialog-action="confirm"
        aria-busy=${vm.loading ? 'true' : nothing}
        ?disabled=${vm.loading}
        @click=${vm.onConfirm}
      >${vm.loading ? vm.loadingLabel : vm.confirmLabel}</button>
    </div>
  </div>`;
}

export function openDialog(opts: DialogOptions): DialogController {
  const doc = opts.doc ?? document;
  const listeners = new DisposableStore();
  const prevFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const seq = ++dialogSeq;
  const titleId = `fh-dialog-title-${seq}`;
  const bodyId = `fh-dialog-body-${seq}`;

  const backdrop = doc.createElement('div');
  backdrop.className = `fh-dialog-backdrop${opts.className ? ` ${opts.className}` : ''}`;
  (opts.container ?? doc.body).appendChild(backdrop);

  let closed = false;
  let loading = false;
  let errorMsg: string | null = null;

  const confirmLabel = opts.confirmLabel ?? tr('common.done');
  const cancelLabel = opts.cancelLabel ?? tr('common.cancel');
  const loadingLabel = opts.loadingLabel ?? tr('common.loading');
  const showCancel = opts.showCancel !== false;
  const closeOnBackdrop = opts.closeOnBackdrop !== false;
  const closeOnEscape = opts.closeOnEscape !== false;

  const close = (confirmed = false): void => {
    if (closed) return;
    closed = true;
    listeners.dispose();
    render(nothing, backdrop);
    backdrop.remove();
    if (!confirmed) opts.onCancel?.();
    opts.onClose?.(confirmed);
    if (!opts.overlays) focusSafely(prevFocus);
  };

  const handleConfirm = async (): Promise<void> => {
    if (loading || closed) return;
    if (!opts.onConfirm) {
      close(true);
      return;
    }
    errorMsg = null;
    try {
      const result = opts.onConfirm();
      if (result instanceof Promise) {
        loading = true;
        paint();
        const resolved = await result;
        if (closed) return;
        loading = false;
        if (resolved === false) {
          paint();
          return;
        }
        close(true);
        return;
      }
      if (result === false) return;
      close(true);
    } catch (err) {
      if (closed) return;
      loading = false;
      errorMsg = err instanceof Error ? err.message : tr('common.didNotWork');
      paint();
    }
  };

  const paint = (): void => {
    if (closed) return;
    render(
      renderDialogTemplate({
        titleId,
        bodyId,
        opts,
        confirmLabel,
        cancelLabel,
        loadingLabel,
        showCancel,
        loading,
        errorMsg,
        onClose: () => close(false),
        onConfirm: () => { void handleConfirm(); },
      }),
      backdrop,
    );
  };

  paint();

  listeners.add(
    addDisposableListener(backdrop, 'click', (ev: MouseEvent) => {
      if (closeOnBackdrop && !loading && ev.target === backdrop) close(false);
    }),
  );

  listeners.add(
    addDisposableListener(backdrop, 'keydown', (ev: KeyboardEvent) => {
      const dialogEl = backdrop.querySelector<HTMLElement>('.fh-dialog');
      if (dialogEl) trapTabKey(dialogEl, ev, doc);
      if (ev.key === 'Escape' && !opts.overlays && !ev.isComposing) {
        if (closeOnEscape && !loading) {
          ev.preventDefault();
          ev.stopPropagation();
          close(false);
        }
      }
    }),
  );

  if (opts.overlays) {
    listeners.add(
      opts.overlays.push({
        id: `fh-dialog-${seq}`,
        close: () => {
          if (!closeOnEscape || loading) return false;
          close(false);
          return true;
        },
        restoreFocus: prevFocus,
      }),
    );
  }

  const dialogEl = backdrop.querySelector<HTMLElement>('.fh-dialog');
  const firstFocus = dialogEl
    ? (dialogEl.querySelector<HTMLElement>('[data-dialog-action="confirm"]') ?? getFocusableElements(dialogEl)[0] ?? dialogEl)
    : null;
  focusSafely(firstFocus);

  return {
    el: backdrop,
    isOpen: () => !closed,
    setLoading(next: boolean): void {
      loading = next;
      paint();
    },
    setError(message: string | null): void {
      errorMsg = message;
      paint();
    },
    close,
    dispose(): void {
      close(false);
    },
  };
}

export function openConfirmDialog(
  opts: Omit<DialogOptions, 'onClose'>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    openDialog({
      ...opts,
      onClose: (confirmed) => resolve(confirmed),
    });
  });
}
