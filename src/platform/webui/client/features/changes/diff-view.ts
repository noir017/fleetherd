import type { CodeViewApi, DiffHandle, DiffSelection } from '../../../codeview/app.js';
import { icon } from '../../../icons.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import type { Disposable } from '../../base/lifecycle.js';
import { renderEmptyState, renderNotice } from '../../components/index.js';
import { renderIcon } from '../../components/shared.js';
import type { PluginContext } from '../../plugins/api.js';
import { CommentDraftStore, type StagedDiffComment } from './comment-queue.js';
import {
  buildDiffCommentBlock,
  buildDiffFileUrl,
  fetchGitJson,
  parsePatchLines,
  type PatchLine,
} from './diff-helpers.js';
import {
  clearActiveHunkHighlight,
  collectHunkElements,
  computeTextHunks,
  extractPatchHunks,
  focusHunkElement,
  resolveNextHunkIndex,
  type DiffHunk,
  type HunkNavState,
} from './hunk-nav.js';
import type { DiffEditorInput, GitFilePayload } from './types.js';
import type { ApiClient } from '../../services/api.js';

export interface DiffViewerOptions {
  readonly ctx: PluginContext;
  readonly api: Pick<ApiClient, 'get'>;
  readonly codeView: () => Promise<CodeViewApi | null>;
  readonly initialLayout: 'unified' | 'split';
  readonly doc?: Document;
  readonly commentQueue?: CommentDraftStore;
  readonly onLayoutChange?: (layout: 'unified' | 'split') => void;
  readonly onCommentInserted?: (topicId: string, block: string) => void;
  readonly onHunkChange?: (state: HunkNavState) => void;
}

export interface DiffViewerController extends Disposable {
  readonly el: HTMLElement;
  load(input: DiffEditorInput): Promise<void>;
  clear(message?: string): void;
  setLayout(layout: 'unified' | 'split'): void;
  getLayout(): 'unified' | 'split';
  canToggleLayout(): boolean;
  getHunkState(): HunkNavState;
  navigateHunk(direction: 1 | -1): HunkNavState;
  setSelectionForTest(selection: DiffSelection | null): void;
}

function renderPatchLines(lines: readonly PatchLine[]): TemplateResult {
  let hunkIdx = 0;
  return html`<pre class="fh-diff-patch">${lines.map((line) => {
    if (line.kind === 'add') {
      return html`<span class="fh-diff-line fh-diff-line--add" style="background:var(--fh-diff-add)">${line.text}</span>\n`;
    }
    if (line.kind === 'del') {
      return html`<span class="fh-diff-line fh-diff-line--del" style="background:var(--fh-diff-del)">${line.text}</span>\n`;
    }
    if (line.kind === 'hunk') {
      const idx = hunkIdx++;
      return html`<span class="fh-diff-line fh-diff-line--hunk" data-hunk-index=${idx}>${line.text}</span>\n`;
    }
    return html`${line.text}\n`;
  })}</pre>`;
}

function formatSelectionSummary(ctx: PluginContext, sel: DiffSelection): string {
  const from = Math.min(sel.from, sel.to);
  const to = Math.max(sel.from, sel.to);
  const range = from + (to !== from ? `\u2013${to}` : '');
  const side = sel.side === 'old' ? ctx.i18n.t('git.sideOriginal') : ctx.i18n.t('git.sideNew');
  return ctx.i18n.t('git.selLines', { side, range });
}

interface CommentBarState {
  readonly ctx: PluginContext;
  readonly selection: DiffSelection;
  readonly commentOpen: boolean;
  readonly commentDraft: string;
  readonly onOpen: () => void;
  readonly onInput: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStage?: () => void;
  readonly onCancel: () => void;
}

function renderCommentBarTemplate(s: CommentBarState): TemplateResult {
  const summary = formatSelectionSummary(s.ctx, s.selection);
  return html`<div class="fh-diff-sel-bar">
      <span class="fh-diff-sel-what">${summary}</span>
      ${!s.commentOpen
        ? html`<button type="button" class="fh-btn fh-btn--primary" data-diff-comment-open @click=${s.onOpen}>
            ${s.ctx.i18n.t('git.comment')}
          </button>`
        : nothing}
    </div>
    ${s.commentOpen
      ? html`<div class="fh-diff-comment-box">
          <textarea
            class="fh-diff-comment-input"
            rows="3"
            placeholder=${s.ctx.i18n.t('git.commentPlaceholder')}
            .value=${s.commentDraft}
            @input=${(ev: Event) => s.onInput((ev.target as HTMLTextAreaElement).value)}
            @keydown=${(ev: KeyboardEvent) => {
              if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
                ev.preventDefault();
                s.onSubmit();
              }
            }}
          ></textarea>
          <div class="fh-diff-comment-actions">
            <button type="button" class="fh-btn fh-btn--primary" data-diff-comment-submit @click=${s.onSubmit}>
              ${s.ctx.i18n.t('git.addToMessage')}
            </button>
            ${s.onStage
              ? html`<button type="button" class="fh-btn fh-btn--secondary" data-diff-comment-stage @click=${s.onStage}>
                  ${s.ctx.i18n.t('changes.stageComment')}
                </button>`
              : nothing}
            <button type="button" class="fh-btn fh-btn--secondary" data-diff-comment-cancel @click=${s.onCancel}>
              ${s.ctx.i18n.t('common.cancel')}
            </button>
          </div>
        </div>`
      : nothing}`;
}

function formatStagedLocation(item: StagedDiffComment): string {
  const { path, selection, refTag } = item.context;
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  const range = to !== from ? `L${from}-L${to}` : `L${from}`;
  const side = selection.side === 'old' ? 'old' : 'new';
  return `${path}:${range} (${side}${refTag ? `, ${refTag}` : ''})`;
}

interface QueueViewProps {
  readonly ctx: PluginContext;
  readonly items: readonly StagedDiffComment[];
  readonly expanded: boolean;
  readonly editingId: string | null;
  readonly editDraft: string;
  readonly onToggle: () => void;
  readonly onSendAll: () => void;
  readonly onClearAll: () => void;
  readonly onStartEdit: (item: StagedDiffComment) => void;
  readonly onEditInput: (value: string) => void;
  readonly onSaveEdit: (id: string) => void;
  readonly onCancelEdit: () => void;
  readonly onDelete: (id: string) => void;
}

function renderStagedItem(p: QueueViewProps, item: StagedDiffComment): TemplateResult {
  const isEditing = p.editingId === item.id;
  return html`<div class="fh-diff-queue-item" data-staged-id=${item.id}>
    <div class="fh-diff-queue-item-head">
      <span class="fh-diff-queue-loc">${formatStagedLocation(item)}</span>
      ${!isEditing
        ? html`<div class="fh-diff-queue-item-acts">
            <button
              type="button"
              class="fh-btn fh-btn--ghost fh-btn--icon"
              data-staged-edit=${item.id}
              title=${p.ctx.i18n.t('common.edit')}
              aria-label=${p.ctx.i18n.t('common.edit')}
              @click=${() => p.onStartEdit(item)}
            >${renderIcon(icon('pencil'), 'fh-icon')}</button>
            <button
              type="button"
              class="fh-btn fh-btn--ghost fh-btn--icon"
              data-staged-delete=${item.id}
              title=${p.ctx.i18n.t('changes.deleteComment')}
              aria-label=${p.ctx.i18n.t('changes.deleteComment')}
              @click=${() => p.onDelete(item.id)}
            >${renderIcon(icon('trash'), 'fh-icon')}</button>
          </div>`
        : nothing}
    </div>
    ${isEditing
      ? html`<div class="fh-diff-queue-edit">
          <textarea
            class="fh-diff-queue-edit-input"
            rows="2"
            .value=${p.editDraft}
            @input=${(ev: Event) => p.onEditInput((ev.target as HTMLTextAreaElement).value)}
          ></textarea>
          <div class="fh-diff-queue-edit-acts">
            <button type="button" class="fh-btn fh-btn--primary" data-staged-save=${item.id} @click=${() => p.onSaveEdit(item.id)}>
              ${p.ctx.i18n.t('changes.saveEdit')}
            </button>
            <button type="button" class="fh-btn fh-btn--secondary" data-staged-cancel-edit @click=${p.onCancelEdit}>
              ${p.ctx.i18n.t('common.cancel')}
            </button>
          </div>
        </div>`
      : html`<div class="fh-diff-queue-text">${item.comment}</div>`}
  </div>`;
}

function renderCommentQueueTemplate(p: QueueViewProps): TemplateResult | typeof nothing {
  if (p.items.length === 0) return nothing;
  return html`<div class="fh-diff-queue">
    <div class="fh-diff-queue-head">
      <button type="button" class="fh-diff-queue-toggle" data-diff-queue-toggle @click=${p.onToggle}>
        <span>${p.ctx.i18n.t('changes.stagedTitle')}</span>
        <span class="fh-diff-queue-badge" data-diff-queue-count>${p.items.length}</span>
      </button>
      <div class="fh-diff-queue-acts">
        <button type="button" class="fh-btn fh-btn--primary" data-diff-queue-send @click=${p.onSendAll}>
          ${p.ctx.i18n.t('changes.sendMerged', { count: p.items.length })}
        </button>
        <button type="button" class="fh-btn fh-btn--secondary" data-diff-queue-clear @click=${p.onClearAll}>
          ${p.ctx.i18n.t('changes.clearStaged')}
        </button>
      </div>
    </div>
    ${p.expanded
      ? html`<div class="fh-diff-queue-list">${p.items.map((item) => renderStagedItem(p, item))}</div>`
      : nothing}
  </div>`;
}

function payloadEmptyMessage(ctx: PluginContext, ok: boolean, payload: GitFilePayload | null): string | null {
  if (!ok || !payload || !payload.ok) {
    return (payload && (payload.text || payload.error)) || ctx.i18n.t('git.readFileFailed');
  }
  if (payload.tooLarge) {
    return payload.patchTooLarge ? ctx.i18n.t('git.patchTooLarge') : ctx.i18n.t('git.fileTooLarge');
  }
  if (payload.binary) return ctx.i18n.t('git.binaryFile');
  return null;
}

interface ViewerState {
  currentInput: DiffEditorInput | null;
  layout: 'unified' | 'split';
  handle: DiffHandle | null;
  sides: { old: string; new: string } | null;
  selection: DiffSelection | null;
  commentOpen: boolean;
  commentDraft: string;
  queueExpanded: boolean;
  editingCommentId: string | null;
  editingCommentDraft: string;
  hunks: DiffHunk[];
  activeHunkIndex: number;
  noticeMsg: string;
  seq: number;
  disposed: boolean;
}

interface ViewerRuntime {
  readonly opts: DiffViewerOptions;
  readonly root: HTMLElement;
  readonly queue: CommentDraftStore;
  readonly state: ViewerState;
  readonly statusHost: HTMLElement;
  readonly emptyHost: HTMLElement;
  readonly mountHost: HTMLElement;
  readonly commentHost: HTMLElement;
  readonly queueHost: HTMLElement;
  paintStatus: () => void;
  paintCommentBar: () => void;
  paintQueue: () => void;
  notifyHunkChange: () => void;
}

function destroyDiffHandle(state: ViewerState, mountHost: HTMLElement): void {
  if (state.handle) {
    try {
      state.handle.destroy();
    } catch {
      // Ignore teardown errors from a replaced editor.
    }
    state.handle = null;
  }
  mountHost.textContent = '';
  mountHost.hidden = true;
}

function showViewerTemplate(rt: ViewerRuntime, tmpl: TemplateResult | typeof nothing): void {
  rt.mountHost.hidden = true;
  rt.emptyHost.hidden = tmpl === nothing;
  render(tmpl, rt.emptyHost);
}

async function renderDiffPayload(rt: ViewerRuntime, payload: GitFilePayload, mine: number): Promise<void> {
  const { opts, state, mountHost, emptyHost } = rt;
  const path = payload.path || state.currentInput?.path || '';
  state.sides = { old: String(payload.original || ''), new: String(payload.modified || '') };
  const patchHunks = extractPatchHunks(payload.patch || '');
  state.hunks = patchHunks.length > 0 ? patchHunks : computeTextHunks(state.sides.old, state.sides.new);
  state.activeHunkIndex = -1;
  let cv: CodeViewApi | null = null;
  try {
    cv = await opts.codeView();
  } catch {
    cv = null;
  }
  if (state.disposed || mine !== state.seq) return;
  if (cv && typeof cv.diff === 'function') {
    render(nothing, emptyHost);
    emptyHost.hidden = true;
    mountHost.textContent = '';
    mountHost.hidden = false;
    state.handle = cv.diff(mountHost, {
      name: path,
      original: state.sides.old,
      modified: state.sides.new,
      layout: state.layout,
      onSelect: (sel) => {
        state.selection = sel;
        if (!sel) state.commentOpen = false;
        rt.paintCommentBar();
      },
    });
    rt.notifyHunkChange();
    return;
  }
  const patch = payload.patch || '';
  showViewerTemplate(
    rt,
    patch ? renderPatchLines(parsePatchLines(patch)) : renderEmptyState({ title: opts.ctx.i18n.t('git.noTextDiff') }),
  );
  rt.notifyHunkChange();
}

async function loadDiffIntoViewer(rt: ViewerRuntime, input: DiffEditorInput): Promise<void> {
  const { opts, state } = rt;
  const mine = ++state.seq;
  state.currentInput = input;
  state.sides = null;
  state.selection = null;
  state.commentOpen = false;
  state.commentDraft = '';
  state.editingCommentId = null;
  state.editingCommentDraft = '';
  state.hunks = [];
  state.activeHunkIndex = -1;
  state.noticeMsg = '';
  destroyDiffHandle(state, rt.mountHost);
  clearActiveHunkHighlight(rt.root);
  rt.paintStatus();
  rt.paintCommentBar();
  rt.paintQueue();
  rt.notifyHunkChange();
  showViewerTemplate(rt, renderEmptyState({ title: opts.ctx.i18n.t('common.loading') }));

  try {
    const res = await fetchGitJson<GitFilePayload>(opts.api, buildDiffFileUrl(input));
    if (state.disposed || mine !== state.seq) return;
    const errMsg = payloadEmptyMessage(opts.ctx, res.ok, res.data);
    if (errMsg || !res.data) {
      showViewerTemplate(rt, renderEmptyState({ title: errMsg ?? opts.ctx.i18n.t('git.readFileFailed') }));
      return;
    }
    await renderDiffPayload(rt, res.data, mine);
  } catch {
    if (state.disposed || mine !== state.seq) return;
    showViewerTemplate(rt, renderEmptyState({ title: opts.ctx.i18n.t('common.reachServerError') }));
  }
}

function readPendingComment(rt: ViewerRuntime): { topicId: string; refTag?: string; trimmed: string } | null {
  const { state, commentHost } = rt;
  if (!state.selection || !state.currentInput) return null;
  const trimmed = state.commentDraft.trim();
  if (!trimmed) {
    commentHost.querySelector<HTMLTextAreaElement>('.fh-diff-comment-input')?.focus();
    return null;
  }
  const refTag =
    state.currentInput.commitShort || (state.currentInput.sha ? state.currentInput.sha.slice(0, 7) : undefined);
  return { topicId: state.currentInput.topicId, refTag, trimmed };
}

function submitDirectComment(rt: ViewerRuntime): void {
  const info = readPendingComment(rt);
  const { state, opts } = rt;
  if (!info || !state.selection || !state.currentInput) return;
  const block = buildDiffCommentBlock(
    { path: state.currentInput.path, selection: state.selection, sides: state.sides, refTag: info.refTag },
    info.trimmed,
  );
  opts.ctx.topics.insertIntoComposer(info.topicId, block);
  opts.onCommentInserted?.(info.topicId, block);
  state.selection = null;
  state.commentOpen = false;
  state.commentDraft = '';
  state.noticeMsg = opts.ctx.i18n.t('git.addedToMessage');
  rt.paintStatus();
  rt.paintCommentBar();
}

function stagePendingComment(rt: ViewerRuntime): void {
  const info = readPendingComment(rt);
  const { state, opts, queue } = rt;
  if (!info || !state.selection || !state.currentInput) return;
  queue.add(
    info.topicId,
    { path: state.currentInput.path, selection: state.selection, sides: state.sides, refTag: info.refTag },
    info.trimmed,
  );
  state.selection = null;
  state.commentOpen = false;
  state.commentDraft = '';
  state.queueExpanded = true;
  state.noticeMsg = opts.ctx.i18n.t('changes.commentStaged', { count: queue.count(info.topicId) });
  rt.paintStatus();
  rt.paintCommentBar();
  rt.paintQueue();
}

function paintViewerQueue(rt: ViewerRuntime): void {
  const { opts, state, queue, queueHost } = rt;
  const topicId = state.currentInput?.topicId;
  if (!topicId) {
    render(nothing, queueHost);
    return;
  }
  render(
    renderCommentQueueTemplate({
      ctx: opts.ctx,
      items: queue.list(topicId),
      expanded: state.queueExpanded,
      editingId: state.editingCommentId,
      editDraft: state.editingCommentDraft,
      onToggle: () => {
        state.queueExpanded = !state.queueExpanded;
        rt.paintQueue();
      },
      onSendAll: () => {
        const count = queue.count(topicId);
        const merged = queue.flush(topicId);
        if (!merged) return;
        state.editingCommentId = null;
        state.editingCommentDraft = '';
        opts.ctx.topics.insertIntoComposer(topicId, merged);
        opts.onCommentInserted?.(topicId, merged);
        state.noticeMsg = opts.ctx.i18n.t('changes.mergedToMessage', { count });
        rt.paintStatus();
        rt.paintQueue();
      },
      onClearAll: () => {
        state.editingCommentId = null;
        state.editingCommentDraft = '';
        queue.clear(topicId);
      },
      onStartEdit: (item) => {
        state.editingCommentId = item.id;
        state.editingCommentDraft = item.comment;
        rt.paintQueue();
      },
      onEditInput: (value) => {
        state.editingCommentDraft = value;
      },
      onSaveEdit: (id) => {
        if (!queue.update(topicId, id, state.editingCommentDraft)) return;
        state.editingCommentId = null;
        state.editingCommentDraft = '';
        rt.paintQueue();
      },
      onCancelEdit: () => {
        state.editingCommentId = null;
        state.editingCommentDraft = '';
        rt.paintQueue();
      },
      onDelete: (id) => {
        if (state.editingCommentId === id) {
          state.editingCommentId = null;
          state.editingCommentDraft = '';
        }
        queue.remove(topicId, id);
      },
    }),
    queueHost,
  );
}

function getViewerHunkState(rt: ViewerRuntime): HunkNavState {
  const domTargets = collectHunkElements(rt.mountHost, rt.emptyHost);
  const total = rt.state.hunks.length > 0 ? rt.state.hunks.length : domTargets.length;
  return { activeIndex: rt.state.activeHunkIndex, total };
}

function navigateViewerHunk(rt: ViewerRuntime, direction: 1 | -1): HunkNavState {
  const domTargets = collectHunkElements(rt.mountHost, rt.emptyHost);
  const total = rt.state.hunks.length > 0 ? rt.state.hunks.length : domTargets.length;
  const next = resolveNextHunkIndex(rt.state.activeHunkIndex, total, direction);
  rt.state.activeHunkIndex = next;
  if (next >= 0) focusHunkElement(rt.root, domTargets[next]);
  else clearActiveHunkHighlight(rt.root);
  const nextState: HunkNavState = { activeIndex: next, total };
  rt.opts.onHunkChange?.(nextState);
  return nextState;
}

function paintViewerStatus(rt: ViewerRuntime): void {
  const { state, statusHost } = rt;
  render(
    state.noticeMsg
      ? renderNotice({
          tone: 'ok',
          message: state.noticeMsg,
          dismissible: true,
          onDismiss: () => {
            state.noticeMsg = '';
            rt.paintStatus();
          },
        })
      : nothing,
    statusHost,
  );
}

function paintViewerCommentBar(rt: ViewerRuntime): void {
  const { opts, state, commentHost } = rt;
  if (!state.selection || !state.currentInput) {
    render(nothing, commentHost);
    return;
  }
  render(
    renderCommentBarTemplate({
      ctx: opts.ctx,
      selection: state.selection,
      commentOpen: state.commentOpen,
      commentDraft: state.commentDraft,
      onOpen: () => {
        state.commentOpen = true;
        rt.paintCommentBar();
        commentHost.querySelector<HTMLTextAreaElement>('.fh-diff-comment-input')?.focus();
      },
      onInput: (value) => {
        state.commentDraft = value;
      },
      onSubmit: () => submitDirectComment(rt),
      onStage: () => stagePendingComment(rt),
      onCancel: () => {
        state.commentOpen = false;
        state.commentDraft = '';
        rt.paintCommentBar();
      },
    }),
    commentHost,
  );
}

function clearViewer(rt: ViewerRuntime, message?: string): void {
  const { state, mountHost, root } = rt;
  state.seq += 1;
  state.currentInput = null;
  state.sides = null;
  state.selection = null;
  state.commentOpen = false;
  state.commentDraft = '';
  state.editingCommentId = null;
  state.editingCommentDraft = '';
  state.hunks = [];
  state.activeHunkIndex = -1;
  state.noticeMsg = '';
  destroyDiffHandle(state, mountHost);
  clearActiveHunkHighlight(root);
  rt.paintStatus();
  rt.paintCommentBar();
  rt.paintQueue();
  rt.notifyHunkChange();
  showViewerTemplate(rt, message ? renderEmptyState({ title: message }) : nothing);
}

export function createDiffViewer(opts: DiffViewerOptions): DiffViewerController {
  const doc = opts.doc ?? document;
  const ownsQueue = !opts.commentQueue;
  const queue = opts.commentQueue ?? new CommentDraftStore();
  const root = doc.createElement('div');
  root.className = 'fh-diff-viewer';

  const statusHost = doc.createElement('div');
  statusHost.className = 'fh-diff-status';
  const emptyHost = doc.createElement('div');
  emptyHost.className = 'fh-diff-code';
  const mountHost = doc.createElement('div');
  mountHost.className = 'fh-diff-mount';
  mountHost.hidden = true;
  const commentHost = doc.createElement('div');
  commentHost.className = 'fh-diff-comment-host';
  const queueHost = doc.createElement('div');
  queueHost.className = 'fh-diff-queue-host';

  root.append(statusHost, emptyHost, mountHost, commentHost, queueHost);

  const state: ViewerState = {
    currentInput: null,
    layout: opts.initialLayout,
    handle: null,
    sides: null,
    selection: null,
    commentOpen: false,
    commentDraft: '',
    queueExpanded: true,
    editingCommentId: null,
    editingCommentDraft: '',
    hunks: [],
    activeHunkIndex: -1,
    noticeMsg: '',
    seq: 0,
    disposed: false,
  };

  const rt: ViewerRuntime = {
    opts,
    root,
    queue,
    state,
    statusHost,
    emptyHost,
    mountHost,
    commentHost,
    queueHost,
    paintStatus: () => undefined,
    paintCommentBar: () => undefined,
    paintQueue: () => undefined,
    notifyHunkChange: () => undefined,
  };

  rt.paintStatus = () => paintViewerStatus(rt);
  rt.paintQueue = () => paintViewerQueue(rt);
  rt.paintCommentBar = () => paintViewerCommentBar(rt);
  rt.notifyHunkChange = () => opts.onHunkChange?.(getViewerHunkState(rt));

  const queueSub = queue.onDidChange((changedTopicId) => {
    if (!state.disposed && changedTopicId === state.currentInput?.topicId) {
      rt.paintQueue();
    }
  });

  return {
    el: root,
    load: (input: DiffEditorInput) => loadDiffIntoViewer(rt, input),
    clear: (message?: string) => clearViewer(rt, message),
    setLayout(next: 'unified' | 'split'): void {
      state.layout = next;
      if (state.handle && typeof state.handle.setLayout === 'function') state.handle.setLayout(next);
      if (state.activeHunkIndex >= 0) {
        const domTargets = collectHunkElements(mountHost, emptyHost);
        focusHunkElement(root, domTargets[state.activeHunkIndex]);
      }
      opts.onLayoutChange?.(next);
    },
    getLayout: () => state.layout,
    canToggleLayout: () => Boolean(state.handle),
    getHunkState: () => getViewerHunkState(rt),
    navigateHunk: (direction: 1 | -1) => navigateViewerHunk(rt, direction),
    setSelectionForTest(sel: DiffSelection | null): void {
      state.selection = sel;
      if (!sel) state.commentOpen = false;
      rt.paintCommentBar();
    },
    dispose(): void {
      if (state.disposed) return;
      state.disposed = true;
      state.seq += 1;
      queueSub.dispose();
      if (ownsQueue) queue.dispose();
      destroyDiffHandle(state, mountHost);
      render(nothing, statusHost);
      render(nothing, emptyHost);
      render(nothing, commentHost);
      render(nothing, queueHost);
      root.remove();
    },
  };
}
