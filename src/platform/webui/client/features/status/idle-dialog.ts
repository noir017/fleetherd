import { html, nothing, type TemplateResult } from '../../base/html.js';
import { openDialog, type DialogController } from '../../components/index.js';
import type { TopicInfo } from '../../plugins/api.js';
import type { OverlayManager } from '../../services/overlays.js';
import { renderStatusIcon } from './icons.js';
import type { CloseIdleResponse } from './types.js';

export interface CloseIdleDialogOptions {
  readonly topics: readonly TopicInfo[];
  readonly t: (key: string, vars?: Record<string, unknown>) => string;
  readonly postCloseIdle: (topicIds: readonly string[]) => Promise<CloseIdleResponse>;
  readonly overlays?: OverlayManager;
  readonly doc?: Document;
  readonly onClose?: () => void;
}

interface SnapshotRow {
  readonly id: string;
  readonly title: string;
  readonly where: string;
}

function formatLocation(topic: TopicInfo): string {
  if (!topic.dir) return '';
  return topic.dir.host ? `${topic.dir.host} · ${topic.dir.name}` : topic.dir.name;
}

function buildSnapshot(
  topics: readonly TopicInfo[],
  t: (key: string, vars?: Record<string, unknown>) => string,
): SnapshotRow[] {
  return topics.map((topic) => ({
    id: topic.id,
    title: topic.title || t('common.untitled'),
    where: formatLocation(topic),
  }));
}

function renderResultBody(
  rows: readonly SnapshotRow[],
  result: CloseIdleResponse | null,
  t: (key: string, vars?: Record<string, unknown>) => string,
): TemplateResult {
  const closedSet = new Set<string>(result?.closed ?? []);
  return html`
    ${!result ? html`<p class="fh-idle-why">${t('idle.why')}</p>` : nothing}
    <ul class="fh-idle-list">
      ${rows.map((row) => {
        const hasResult = result !== null;
        const ok = closedSet.has(row.id);
        const outcomeText = hasResult ? (ok ? t('idle.closed') : t('idle.leftRunning')) : '';
        const outcomeCls = `idle-out${hasResult && !ok ? ' kept' : ''}`;
        return html`<li class="fh-idle-row" data-idle=${row.id}>
          <span class="idle-main">
            <span class="idle-name">${row.title}</span>
            ${row.where ? html`<span class="idle-dir">${row.where}</span>` : nothing}
          </span>
          <span class=${outcomeCls}>${outcomeText}</span>
        </li>`;
      })}
    </ul>
  `;
}

function formatResultTitle(
  result: CloseIdleResponse,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  const closedCount = result.closed.length;
  const keptCount = result.kept.length;
  const base = t(closedCount === 1 ? 'idle.closedTitleOne' : 'idle.closedTitleMany', {
    count: closedCount,
  });
  return keptCount > 0 ? base + t('idle.keptSuffix', { count: keptCount }) : base;
}

export function openCloseIdleDialog(opts: CloseIdleDialogOptions): DialogController | null {
  if (opts.topics.length === 0) return null;

  const doc = opts.doc ?? document;
  // Contract 1: snapshot the exact list shown to the operator and post only these ids.
  const rows = buildSnapshot(opts.topics, opts.t);
  const topicIds = rows.map((row) => row.id);
  let activeDialog: DialogController;
  let transitionToResult: CloseIdleResponse | null = null;

  const initialTitle = opts.t(
    rows.length === 1 ? 'idle.confirmTitleOne' : 'idle.confirmTitleMany',
    { count: rows.length },
  );

  activeDialog = openDialog({
    title: initialTitle,
    body: html`<div class="fh-idle-dialog-body">${renderResultBody(rows, null, opts.t)}</div>`,
    confirmLabel: opts.t('idle.closeAgents'),
    cancelLabel: opts.t('common.cancel'),
    closeIcon: renderStatusIcon('cross'),
    className: 'fh-idle-dialog',
    overlays: opts.overlays,
    doc,
    onConfirm: async () => {
      try {
        // Contract 3: posted once without retries.
        const response = await opts.postCloseIdle(topicIds);
        transitionToResult = {
          closed: Array.isArray(response.closed) ? response.closed : [],
          kept: Array.isArray(response.kept) ? response.kept : [],
        };
        return true;
      } catch (err) {
        const message =
          err instanceof Error && err.message ? err.message : opts.t('common.reachServerError');
        throw new Error(message);
      }
    },
    onClose: (confirmed) => {
      const result = transitionToResult;
      transitionToResult = null;
      if (confirmed && result) {
        // Contract 4: show row-by-row results inside the dialog.
        activeDialog = openDialog({
          title: formatResultTitle(result, opts.t),
          body: html`<div class="fh-idle-dialog-body">${renderResultBody(rows, result, opts.t)}</div>`,
          confirmLabel: opts.t('common.done'),
          showCancel: false,
          closeIcon: renderStatusIcon('cross'),
          className: 'fh-idle-dialog is-result',
          overlays: opts.overlays,
          doc,
          onClose: () => {
            opts.onClose?.();
          },
        });
        return;
      }
      opts.onClose?.();
    },
  });

  return {
    get el() {
      return activeDialog.el;
    },
    isOpen: () => activeDialog.isOpen(),
    setLoading: (loading) => activeDialog.setLoading(loading),
    setError: (message) => activeDialog.setError(message),
    close: (confirmed) => activeDialog.close(confirmed),
    dispose: () => activeDialog.dispose(),
  };
}
