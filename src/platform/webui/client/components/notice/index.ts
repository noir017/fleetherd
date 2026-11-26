import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type Disposable } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import { type IconInput, renderIcon } from '../shared.js';

export type NoticeTone = 'info' | 'ok' | 'warn' | 'err';

export interface NoticeOptions {
  readonly tone?: NoticeTone;
  readonly title?: string;
  readonly message: string | TemplateResult;
  readonly icon?: IconInput;
  readonly dismissible?: boolean;
  readonly dismissIcon?: IconInput;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
  readonly actions?: TemplateResult;
  readonly role?: 'status' | 'alert';
  readonly className?: string;
}

export interface NoticeController extends Disposable {
  readonly el: HTMLElement;
  update(opts: NoticeOptions): void;
  dismiss(): void;
}

export interface EmptyStateAction {
  readonly label: string;
  readonly variant?: 'primary' | 'secondary';
  readonly onClick: () => void;
}

export interface EmptyStateOptions {
  readonly icon?: IconInput;
  readonly title: string;
  readonly description?: string;
  readonly action?: EmptyStateAction;
  readonly className?: string;
}

export interface EmptyStateController extends Disposable {
  readonly el: HTMLElement;
  update(opts: EmptyStateOptions): void;
}

export function renderNotice(opts: NoticeOptions): TemplateResult {
  const tone = opts.tone ?? 'info';
  const role = opts.role ?? (tone === 'err' || tone === 'warn' ? 'alert' : 'status');
  const dismissLabel = opts.dismissLabel ?? tr('common.close');
  const cls = `fh-notice fh-notice--${tone}${opts.className ? ` ${opts.className}` : ''}`;
  return html`<div class=${cls} role=${role}>
    ${renderIcon(opts.icon, 'fh-notice-icon')}
    <div class="fh-notice-body">
      ${opts.title ? html`<div class="fh-notice-title">${opts.title}</div>` : nothing}
      <div class="fh-notice-msg">${opts.message}</div>
    </div>
    ${opts.actions ? html`<div class="fh-notice-actions">${opts.actions}</div>` : nothing}
    ${opts.dismissible
      ? html`<button
          type="button"
          class="fh-notice-dismiss"
          title=${dismissLabel}
          aria-label=${dismissLabel}
          @click=${() => opts.onDismiss?.()}
        >${opts.dismissIcon ? renderIcon(opts.dismissIcon, 'fh-icon') : html`<span aria-hidden="true">×</span>`}</button>`
      : nothing}
  </div>`;
}

export function createNotice(opts: NoticeOptions, doc: Document = document): NoticeController {
  const host = doc.createElement('div');
  host.className = 'fh-notice-host';
  let dismissed = false;
  let current = opts;

  const paint = (): void => {
    if (dismissed) {
      render(nothing, host);
      host.hidden = true;
      return;
    }
    host.hidden = false;
    render(
      renderNotice({
        ...current,
        onDismiss: () => {
          dismiss();
        },
      }),
      host,
    );
  };

  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    paint();
    current.onDismiss?.();
  };

  paint();

  return {
    el: host,
    update(next: NoticeOptions): void {
      current = next;
      dismissed = false;
      paint();
    },
    dismiss,
    dispose(): void {
      render(nothing, host);
      host.remove();
    },
  };
}

export function renderEmptyState(opts: EmptyStateOptions): TemplateResult {
  const cls = `fh-empty${opts.className ? ` ${opts.className}` : ''}`;
  const btnCls = opts.action?.variant === 'primary' ? 'fh-btn fh-btn--primary' : 'fh-btn fh-btn--secondary';
  return html`<div class=${cls}>
    ${renderIcon(opts.icon, 'fh-empty-icon')}
    <div class="fh-empty-title">${opts.title}</div>
    ${opts.description ? html`<div class="fh-empty-desc">${opts.description}</div>` : nothing}
    ${opts.action
      ? html`<div class="fh-empty-actions">
          <button type="button" class=${btnCls} @click=${() => opts.action?.onClick()}>${opts.action.label}</button>
        </div>`
      : nothing}
  </div>`;
}

export function createEmptyState(opts: EmptyStateOptions, doc: Document = document): EmptyStateController {
  const host = doc.createElement('div');
  host.className = 'fh-empty-host';
  const paint = (next: EmptyStateOptions): void => {
    render(renderEmptyState(next), host);
  };
  paint(opts);
  return {
    el: host,
    update: paint,
    dispose(): void {
      render(nothing, host);
      host.remove();
    },
  };
}

export const EmptyState = renderEmptyState;
