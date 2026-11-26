import { icon } from '../../../icons.js';
import { html, nothing, render } from '../../base/html.js';
import { renderActionBar, renderEmptyState, type ActionItem } from '../../components/index.js';
import type { PluginContext } from '../../plugins/api.js';
import type { CommentDraftStore } from './comment-queue.js';
import {
  buildDiffFileUrl,
  diffEditorPanelId,
  diffEditorTitle,
  isDiffEditorInput,
  isFilesEnabled,
  resolveChangesApi,
} from './diff-helpers.js';
import { createDiffViewer } from './diff-view.js';
import type { HunkNavState } from './hunk-nav.js';
import type {
  ChangesPluginDeps,
  DiffEditorInput,
  FeaturePanelComponent,
  FeaturePanelInitContext,
  FeaturePanelRef,
} from './types.js';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function resolveHunkShortcut(ev: KeyboardEvent): 1 | -1 | null {
  if (ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key === 'F5') {
    return ev.shiftKey ? -1 : 1;
  }
  if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !isEditableTarget(ev.target)) {
    if (ev.key === ']') return 1;
    if (ev.key === '[') return -1;
  }
  return null;
}

function formatRefLabel(input: DiffEditorInput): string {
  if (input.commitShort) return input.commitShort;
  if (input.sha) return input.sha.slice(0, 7);
  return input.ref || input.mode || 'working';
}

function buildHeaderActions(
  ctx: PluginContext,
  deps: ChangesPluginDeps,
  viewer: ReturnType<typeof createDiffViewer>,
  currentInput: DiffEditorInput | null,
  hunkState: HunkNavState,
): ActionItem[] {
  if (!currentInput) return [];
  const noHunks = hunkState.total <= 0;
  const items: ActionItem[] = [
    {
      id: 'prev-hunk',
      icon: icon('arrowUp'),
      title: ctx.i18n.t('changes.prevHunk'),
      disabled: noHunks,
      onClick: () => {
        viewer.navigateHunk(-1);
      },
    },
    {
      id: 'next-hunk',
      icon: icon('arrowDown'),
      title: ctx.i18n.t('changes.nextHunk'),
      disabled: noHunks,
      onClick: () => {
        viewer.navigateHunk(1);
      },
    },
    {
      id: 'layout',
      label: viewer.getLayout() === 'split' ? ctx.i18n.t('git.unified') : ctx.i18n.t('git.split'),
      title: ctx.i18n.t('git.layoutTitle'),
      onClick: () => viewer.setLayout(viewer.getLayout() === 'split' ? 'unified' : 'split'),
    },
  ];
  if (isFilesEnabled(deps) && !currentInput.sha && !currentInput.source) {
    items.push({
      id: 'edit-file',
      icon: icon('pencil'),
      label: ctx.i18n.t('common.edit'),
      title: ctx.i18n.t('git.editFileTitle'),
      onClick: () => {
        ctx.editors.open('file', { topicId: currentInput.topicId, path: currentInput.path });
      },
    });
  }
  items.push({
    id: 'refresh',
    icon: icon('refresh'),
    title: ctx.i18n.t('git.refreshTitle'),
    onClick: () => {
      void viewer.load(currentInput);
    },
  });
  return items;
}

export function createDiffEditorPanel(
  ctx: PluginContext,
  deps: ChangesPluginDeps,
  commentQueue?: CommentDraftStore,
): FeaturePanelComponent {
  const doc = deps.doc ?? document;
  const api = resolveChangesApi(deps);
  const narrow = deps.narrow ?? (() => typeof window !== 'undefined' && window.innerWidth < 900);
  const codeView = deps.codeView ?? (async () => null);

  const element = doc.createElement('div');
  element.className = 'fh-diff-editor';
  element.tabIndex = -1;

  const headerEl = doc.createElement('div');
  headerEl.className = 'fh-diff-editor-head';
  const emptyEl = doc.createElement('div');
  emptyEl.className = 'fh-diff-editor-empty';
  emptyEl.hidden = true;
  const bodyEl = doc.createElement('div');
  bodyEl.className = 'fh-diff-editor-body';
  element.append(headerEl, emptyEl, bodyEl);

  let hunkState: HunkNavState = { activeIndex: -1, total: 0 };

  const viewer = createDiffViewer({
    ctx,
    api,
    codeView,
    initialLayout: narrow() ? 'unified' : 'split',
    doc,
    commentQueue,
    onLayoutChange: () => paintHeader(),
    onHunkChange: (next) => {
      hunkState = next;
      paintHeader();
    },
  });
  bodyEl.appendChild(viewer.el);

  let currentInput: DiffEditorInput | null = null;
  let currentTabKey: string | null = null;
  let panelApi: FeaturePanelRef | null = null;
  let disposed = false;

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (disposed || !currentInput) return;
    const dir = resolveHunkShortcut(ev);
    if (dir === null) return;
    if (viewer.getHunkState().total <= 0) return;
    ev.preventDefault();
    viewer.navigateHunk(dir);
  };
  element.addEventListener('keydown', onKeyDown);

  const paintHeader = (): void => {
    if (disposed) return;
    const items = buildHeaderActions(ctx, deps, viewer, currentInput, hunkState);
    const refLabel = currentInput ? formatRefLabel(currentInput) : '';
    const hunkLabel =
      currentInput && hunkState.total > 0
        ? ctx.i18n.t('changes.hunkCounter', {
            current: hunkState.activeIndex >= 0 ? hunkState.activeIndex + 1 : 0,
            total: hunkState.total,
          })
        : '';

    render(
      html`<div class="fh-diff-editor-meta">
        <span class="fh-diff-editor-path" title=${currentInput?.path ?? ''}>${currentInput?.path ?? ''}</span>
        ${refLabel ? html`<span class="fh-diff-editor-ref">${refLabel}</span>` : nothing}
      </div>
      <div class="fh-diff-editor-controls">
        ${hunkLabel ? html`<span class="fh-diff-hunk-counter" data-hunk-counter>${hunkLabel}</span>` : nothing}
        ${items.length > 0 ? renderActionBar({ items, compact: true }) : nothing}
      </div>`,
      headerEl,
    );
  };

  const applyInput = (params: unknown): void => {
    if (!isDiffEditorInput(params)) {
      currentInput = null;
      currentTabKey = null;
      paintHeader();
      viewer.clear();
      bodyEl.hidden = true;
      emptyEl.hidden = false;
      render(renderEmptyState({ title: ctx.i18n.t('git.selectFile') }), emptyEl);
      return;
    }
    const nextKey = `${diffEditorPanelId(params)}|${buildDiffFileUrl(params)}`;
    if (currentTabKey === nextKey && currentInput) {
      currentInput = params;
      panelApi?.setTitle(diffEditorTitle(params, ctx.i18n.t('git.title')));
      return;
    }
    render(nothing, emptyEl);
    emptyEl.hidden = true;
    bodyEl.hidden = false;
    currentInput = params;
    currentTabKey = nextKey;
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
      element.removeEventListener('keydown', onKeyDown);
      viewer.dispose();
      render(nothing, headerEl);
      render(nothing, emptyEl);
      element.remove();
    },
  };
}
