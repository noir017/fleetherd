import { icon } from '../../../icons.js';
import { html, nothing, render } from '../../base/html.js';
import { renderActionBar, renderEmptyState, type ActionItem } from '../../components/index.js';
import type { PluginContext } from '../../plugins/api.js';
import {
  diffEditorTitle,
  isDiffEditorInput,
  isFilesEnabled,
  resolveChangesApi,
} from './diff-helpers.js';
import { createDiffViewer } from './diff-view.js';
import type {
  ChangesPluginDeps,
  DiffEditorInput,
  FeaturePanelComponent,
  FeaturePanelInitContext,
  FeaturePanelRef,
} from './types.js';

export function createDiffEditorPanel(
  ctx: PluginContext,
  deps: ChangesPluginDeps,
): FeaturePanelComponent {
  const doc = deps.doc ?? document;
  const api = resolveChangesApi(deps);
  const narrow = deps.narrow ?? (() => typeof window !== 'undefined' && window.innerWidth < 900);
  const codeView = deps.codeView ?? (async () => null);

  const element = doc.createElement('div');
  element.className = 'fh-diff-editor';

  const headerEl = doc.createElement('div');
  headerEl.className = 'fh-diff-editor-head';
  const emptyEl = doc.createElement('div');
  emptyEl.className = 'fh-diff-editor-empty';
  emptyEl.hidden = true;
  const bodyEl = doc.createElement('div');
  bodyEl.className = 'fh-diff-editor-body';
  element.append(headerEl, emptyEl, bodyEl);

  const viewer = createDiffViewer({
    ctx,
    api,
    codeView,
    initialLayout: narrow() ? 'unified' : 'split',
    doc,
    onLayoutChange: () => paintHeader(),
  });
  bodyEl.appendChild(viewer.el);

  let currentInput: DiffEditorInput | null = null;
  let panelApi: FeaturePanelRef | null = null;
  let disposed = false;

  const paintHeader = (): void => {
    if (disposed) return;
    const items: ActionItem[] = [];
    if (currentInput) {
      items.push({
        id: 'layout',
        label: viewer.getLayout() === 'split' ? ctx.i18n.t('git.unified') : ctx.i18n.t('git.split'),
        title: ctx.i18n.t('git.layoutTitle'),
        onClick: () => viewer.setLayout(viewer.getLayout() === 'split' ? 'unified' : 'split'),
      });
      if (isFilesEnabled(deps) && !currentInput.sha && !currentInput.source) {
        items.push({
          id: 'edit-file',
          icon: icon('pencil'),
          label: ctx.i18n.t('common.edit'),
          title: ctx.i18n.t('git.editFileTitle'),
          onClick: () => {
            if (!currentInput) return;
            ctx.editors.open('file', { topicId: currentInput.topicId, path: currentInput.path });
          },
        });
      }
      items.push({
        id: 'refresh',
        icon: icon('refresh'),
        title: ctx.i18n.t('git.refreshTitle'),
        onClick: () => {
          if (currentInput) void viewer.load(currentInput);
        },
      });
    }

    const refLabel = currentInput
      ? currentInput.commitShort || (currentInput.sha ? currentInput.sha.slice(0, 7) : currentInput.ref || currentInput.mode || 'working')
      : '';

    render(
      html`<div class="fh-diff-editor-meta">
        <span class="fh-diff-editor-path" title=${currentInput?.path ?? ''}>${currentInput?.path ?? ''}</span>
        ${refLabel ? html`<span class="fh-diff-editor-ref">${refLabel}</span>` : nothing}
      </div>
      ${items.length > 0 ? renderActionBar({ items, compact: true }) : nothing}`,
      headerEl,
    );
  };

  const applyInput = (params: unknown): void => {
    if (!isDiffEditorInput(params)) {
      currentInput = null;
      paintHeader();
      viewer.clear();
      bodyEl.hidden = true;
      emptyEl.hidden = false;
      render(renderEmptyState({ title: ctx.i18n.t('git.selectFile') }), emptyEl);
      return;
    }
    render(nothing, emptyEl);
    emptyEl.hidden = true;
    bodyEl.hidden = false;
    currentInput = params;
    panelApi?.setTitle(diffEditorTitle(params, ctx.i18n.t('git.title')));
    paintHeader();
    void viewer.load(params);
  };

  return {
    element,
    init(params: unknown, initCtx: FeaturePanelInitContext): void {
      panelApi = initCtx.api;
      applyInput(params);
    },
    update(params: unknown): void {
      applyInput(params);
    },
    focus(): void {
      element.focus?.();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      viewer.dispose();
      render(nothing, headerEl);
      render(nothing, emptyEl);
      element.remove();
    },
  };
}
