import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, NOOP_DISPOSABLE } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import { post, text } from '../../../services/api.js';
import type {
  LocalPendingItem,
  PendingReason,
  PendingRecallResponse,
  StatusIcons,
  WebPendingItem,
} from './types.js';

export interface PendingQueueDeps {
  readonly pendingQueueEl: HTMLElement | null;
  readonly getTopic: () => string;
  readonly getIcons: () => Pick<StatusIcons, 'clock' | 'bolt' | 'undo'>;
  readonly onRetireLocalNonce: (nonce: string) => void;
  readonly onRecallContent: (content: string) => void;
  readonly postFn?: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
}

export interface PendingQueueController {
  paint(): void;
  setPending(items: readonly WebPendingItem[] | null | undefined): void;
  addLocal(item: LocalPendingItem): void;
  hasLocal(nonce: string): boolean;
  removeLocal(nonce: string): boolean;
  attach(): Disposable;
}

export function pendingReasonText(reason: PendingReason | string): string {
  if (reason === 'sending') return tr('pending.reasonSending');
  if (reason === 'tool') return tr('pending.reasonTool');
  if (reason === 'turn') return tr('pending.reasonTurn');
  return tr('pending.reasonDelay');
}

export function collectVisibleLocals(
  localPending: Readonly<Record<string, LocalPendingItem>>,
  topic: string,
  items: readonly WebPendingItem[],
): LocalPendingItem[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.nonce) seen.add(item.nonce);
  }
  const locals: LocalPendingItem[] = [];
  for (const [nonce, lp] of Object.entries(localPending)) {
    if (lp.topic === topic && !seen.has(nonce)) {
      locals.push(lp);
    }
  }
  locals.sort((a, b) => a.at - b.at);
  return locals;
}

function attachmentBadgeHtml(count: number | undefined): string {
  if (!count) return '';
  const label =
    count === 1 ? tr('pending.attachmentsOne') : tr('pending.attachmentsMany', { count });
  return `<span class="pq-files">${text(label)}</span>`;
}

function renderServerItemHtml(
  item: WebPendingItem,
  confirming: boolean,
  icons: Pick<StatusIcons, 'bolt' | 'undo'>,
): string {
  const files = attachmentBadgeHtml(item.attachments);
  let acts: string;
  if (confirming) {
    acts =
      `<button type="button" class="pq-btn pq-confirm" data-pq-confirm="${text(item.id)}" title="${text(tr('pending.sendNowInterruptTitle'))}">${icons.bolt}<span>${text(tr('pending.confirmInterrupt'))}</span></button>` +
      `<button type="button" class="pq-btn pq-cancel" data-pq-cancel="${text(item.id)}"><span>${text(tr('pending.cancel'))}</span></button>`;
  } else {
    const sendTitle = item.canSendNow
      ? tr('pending.sendNowTitle')
      : tr('pending.sendNowInterruptTitle');
    const sendBtn = `<button type="button" class="pq-btn pq-send" data-pq-send="${text(item.id)}" data-pq-interrupt="${item.canSendNow ? '0' : '1'}" title="${text(sendTitle)}">${icons.bolt}<span>${text(tr('pending.sendNow'))}</span></button>`;
    const recallBtn = `<button type="button" class="pq-btn pq-recall" data-pq-recall="${text(item.id)}" title="${text(tr('pending.recallTitle'))}">${icons.undo}<span>${text(tr('pending.recall'))}</span></button>`;
    acts = sendBtn + recallBtn;
  }
  return (
    `<div class="pq-item" data-pq-id="${text(item.id)}">` +
    `<div class="pq-main">` +
    `<div class="pq-meta"><span class="pq-badge">${text(tr('pending.badge'))}</span><span class="pq-reason">${text(pendingReasonText(item.reason))}</span>${files}</div>` +
    `<div class="pq-text">${text(item.content || '')}</div>` +
    `</div>` +
    `<div class="pq-acts">${acts}</div>` +
    `</div>`
  );
}

function renderLocalItemHtml(item: LocalPendingItem): string {
  const files = attachmentBadgeHtml(item.attachments);
  return (
    `<div class="pq-item pq-local" data-pq-nonce="${text(item.nonce)}">` +
    `<div class="pq-main">` +
    `<div class="pq-meta"><span class="pq-badge">${text(tr('pending.badge'))}</span><span class="pq-reason">${text(pendingReasonText('sending'))}</span>${files}</div>` +
    `<div class="pq-text">${text(item.content || '')}</div>` +
    `</div>` +
    `</div>`
  );
}

export function renderPendingQueueHtml(
  items: readonly WebPendingItem[],
  locals: readonly LocalPendingItem[],
  confirmId: string | null,
  icons: Pick<StatusIcons, 'clock' | 'bolt' | 'undo'>,
): string {
  const total = items.length + locals.length;
  if (!total) return '';
  let html = `<div class="pq-head">${icons.clock}<span>${text(tr('pending.header', { count: total }))}</span></div>`;
  for (const item of items) {
    html += renderServerItemHtml(item, confirmId === item.id, icons);
  }
  for (const lp of locals) {
    html += renderLocalItemHtml(lp);
  }
  return html;
}

export function createPendingQueueController(deps: PendingQueueDeps): PendingQueueController {
  const postFn = deps.postFn ?? post;
  let pendingItems: WebPendingItem[] = [];
  const localPending: Record<string, LocalPendingItem> = {};
  let pendingConfirmId: string | null = null;

  function paint(): void {
    const el = deps.pendingQueueEl;
    if (!el) return;
    if (pendingConfirmId && !pendingItems.some((item) => item.id === pendingConfirmId)) {
      pendingConfirmId = null;
    }
    const locals = collectVisibleLocals(localPending, deps.getTopic(), pendingItems);
    const html = renderPendingQueueHtml(pendingItems, locals, pendingConfirmId, deps.getIcons());
    if (!html) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.innerHTML = html;
    el.hidden = false;
  }

  function setPending(items: readonly WebPendingItem[] | null | undefined): void {
    pendingItems = Array.isArray(items) ? [...items] : [];
    for (const item of pendingItems) {
      if (item.nonce) {
        delete localPending[item.nonce];
        deps.onRetireLocalNonce(item.nonce);
      }
    }
    paint();
  }

  function addLocal(item: LocalPendingItem): void {
    localPending[item.nonce] = item;
    paint();
  }

  function hasLocal(nonce: string): boolean {
    return Object.prototype.hasOwnProperty.call(localPending, nonce);
  }

  function removeLocal(nonce: string): boolean {
    if (!hasLocal(nonce)) return false;
    delete localPending[nonce];
    paint();
    return true;
  }

  function handleSendClick(sendEl: HTMLButtonElement, topic: string): void {
    const sid = sendEl.getAttribute('data-pq-send');
    if (!sid) return;
    if (sendEl.getAttribute('data-pq-interrupt') === '1') {
      pendingConfirmId = sid;
      paint();
      return;
    }
    sendEl.disabled = true;
    postFn('api/pending/send-now', { topic, messageId: sid }, 1).catch(() => {
      sendEl.disabled = false;
    });
  }

  function handleConfirmClick(confirmEl: HTMLButtonElement, topic: string): void {
    const cid = confirmEl.getAttribute('data-pq-confirm');
    if (!cid) return;
    confirmEl.disabled = true;
    pendingConfirmId = null;
    postFn('api/pending/send-now', { topic, messageId: cid, interrupt: true }, 1).catch(() => {
      paint();
    });
  }

  function handleRecallClick(recEl: HTMLButtonElement, topic: string): void {
    const rid = recEl.getAttribute('data-pq-recall');
    if (!rid) return;
    recEl.disabled = true;
    postFn('api/pending/recall', { topic, messageId: rid }, 1)
      .then((res) => (res && res.ok ? (res.json() as Promise<PendingRecallResponse>) : null))
      .then(
        (json) => {
          if (json && json.ok && typeof json.content === 'string') {
            deps.onRecallContent(json.content);
          }
        },
        () => {
          recEl.disabled = false;
        },
      );
  }

  function attach(): Disposable {
    const el = deps.pendingQueueEl;
    if (!el) return NOOP_DISPOSABLE;
    return addDisposableListener(el, 'click', (e) => {
      const target = e.target;
      const topic = deps.getTopic();
      if (!(target instanceof Element) || !topic) return;
      const sendEl = target.closest<HTMLButtonElement>('[data-pq-send]');
      if (sendEl) {
        handleSendClick(sendEl, topic);
        return;
      }
      const confirmEl = target.closest<HTMLButtonElement>('[data-pq-confirm]');
      if (confirmEl) {
        handleConfirmClick(confirmEl, topic);
        return;
      }
      if (target.closest('[data-pq-cancel]')) {
        pendingConfirmId = null;
        paint();
        return;
      }
      const recEl = target.closest<HTMLButtonElement>('[data-pq-recall]');
      if (recEl) {
        handleRecallClick(recEl, topic);
      }
    });
  }

  return { paint, setPending, addLocal, hasLocal, removeLocal, attach };
}
