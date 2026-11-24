import type { CodeViewApi, DiffHandle, DiffSelection } from '../../../codeview/app.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import type { Disposable } from '../../base/lifecycle.js';
import { renderEmptyState, renderNotice } from '../../components/index.js';
import type { PluginContext } from '../../plugins/api.js';
import {
  buildDiffCommentBlock,
  buildDiffFileUrl,
  fetchGitJson,
  parsePatchLines,
  type PatchLine,
} from './diff-helpers.js';
import type { DiffEditorInput, GitFilePayload } from './types.js';
import type { ApiClient } from '../../services/api.js';

export interface DiffViewerOptions {
  readonly ctx: PluginContext;
  readonly api: Pick<ApiClient, 'get'>;
  readonly codeView: () => Promise<CodeViewApi | null>;
  readonly initialLayout: 'unified' | 'split';
  readonly doc?: Document;
  readonly onLayoutChange?: (layout: 'unified' | 'split') => void;
  readonly onCommentInserted?: (topicId: string, block: string) => void;
}

export interface DiffViewerController extends Disposable {
  readonly el: HTMLElement;
  load(input: DiffEditorInput): Promise<void>;
  clear(message?: string): void;
  setLayout(layout: 'unified' | 'split'): void;
  getLayout(): 'unified' | 'split';
  canToggleLayout(): boolean;
  setSelectionForTest(selection: DiffSelection | null): void;
}

function renderPatchLines(lines: readonly PatchLine[]): TemplateResult {
  return html`<pre class="fh-diff-patch">${lines.map((line) => {
    if (line.kind === 'add') {
      return html`<span class="fh-diff-line fh-diff-line--add" style="background:var(--fh-diff-add)">${line.text}</span>\n`;
    }
    if (line.kind === 'del') {
      return html`<span class="fh-diff-line fh-diff-line--del" style="background:var(--fh-diff-del)">${line.text}</span>\n`;
    }
    if (line.kind === 'hunk') {
      return html`<span class="fh-diff-line fh-diff-line--hunk">${line.text}</span>\n`;
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
            <button type="button" class="fh-btn fh-btn--secondary" data-diff-comment-cancel @click=${s.onCancel}>
              ${s.ctx.i18n.t('common.cancel')}
            </button>
          </div>
        </div>`
      : nothing}`;
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
  noticeMsg: string;
  seq: number;
  disposed: boolean;
}

interface ViewerRuntime {
  readonly opts: DiffViewerOptions;
  readonly state: ViewerState;
  readonly statusHost: HTMLElement;
  readonly emptyHost: HTMLElement;
  readonly mountHost: HTMLElement;
  readonly commentHost: HTMLElement;
  paintStatus: () => void;
  paintCommentBar: () => void;
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
    return;
  }
  const patch = payload.patch || '';
  showViewerTemplate(
    rt,
    patch ? renderPatchLines(parsePatchLines(patch)) : renderEmptyState({ title: opts.ctx.i18n.t('git.noTextDiff') }),
  );
}

async function loadDiffIntoViewer(rt: ViewerRuntime, input: DiffEditorInput): Promise<void> {
  const { opts, state } = rt;
  const mine = ++state.seq;
  state.currentInput = input;
  state.sides = null;
  state.selection = null;
  state.commentOpen = false;
  state.commentDraft = '';
  state.noticeMsg = '';
  destroyDiffHandle(state, rt.mountHost);
  rt.paintStatus();
  rt.paintCommentBar();
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

export function createDiffViewer(opts: DiffViewerOptions): DiffViewerController {
  const doc = opts.doc ?? document;
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

  root.append(statusHost, emptyHost, mountHost, commentHost);

  const state: ViewerState = {
    currentInput: null,
    layout: opts.initialLayout,
    handle: null,
    sides: null,
    selection: null,
    commentOpen: false,
    commentDraft: '',
    noticeMsg: '',
    seq: 0,
    disposed: false,
  };

  const paintStatus = (): void => {
    render(
      state.noticeMsg
        ? renderNotice({
            tone: 'ok',
            message: state.noticeMsg,
            dismissible: true,
            onDismiss: () => {
              state.noticeMsg = '';
              paintStatus();
            },
          })
        : nothing,
      statusHost,
    );
  };

  const submitComment = (): void => {
    if (!state.selection || !state.currentInput) return;
    const trimmed = state.commentDraft.trim();
    if (!trimmed) {
      commentHost.querySelector<HTMLTextAreaElement>('.fh-diff-comment-input')?.focus();
      return;
    }
    const refTag =
      state.currentInput.commitShort || (state.currentInput.sha ? state.currentInput.sha.slice(0, 7) : undefined);
    const block = buildDiffCommentBlock({ path: state.currentInput.path, selection: state.selection, sides: state.sides, refTag }, trimmed);
    opts.ctx.topics.insertIntoComposer(state.currentInput.topicId, block);
    opts.onCommentInserted?.(state.currentInput.topicId, block);
    state.selection = null;
    state.commentOpen = false;
    state.commentDraft = '';
    state.noticeMsg = opts.ctx.i18n.t('git.addedToMessage');
    paintStatus();
    paintCommentBar();
  };

  const paintCommentBar = (): void => {
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
          paintCommentBar();
          commentHost.querySelector<HTMLTextAreaElement>('.fh-diff-comment-input')?.focus();
        },
        onInput: (value) => {
          state.commentDraft = value;
        },
        onSubmit: submitComment,
        onCancel: () => {
          state.commentOpen = false;
          state.commentDraft = '';
          paintCommentBar();
        },
      }),
      commentHost,
    );
  };

  const rt: ViewerRuntime = { opts, state, statusHost, emptyHost, mountHost, commentHost, paintStatus, paintCommentBar };

  const clear = (message?: string): void => {
    state.seq += 1;
    state.currentInput = null;
    state.sides = null;
    state.selection = null;
    state.commentOpen = false;
    state.commentDraft = '';
    state.noticeMsg = '';
    destroyDiffHandle(state, mountHost);
    paintStatus();
    paintCommentBar();
    showViewerTemplate(rt, message ? renderEmptyState({ title: message }) : nothing);
  };

  return {
    el: root,
    load: (input: DiffEditorInput) => loadDiffIntoViewer(rt, input),
    clear,
    setLayout(next: 'unified' | 'split'): void {
      state.layout = next;
      if (state.handle && typeof state.handle.setLayout === 'function') state.handle.setLayout(next);
      opts.onLayoutChange?.(next);
    },
    getLayout: () => state.layout,
    canToggleLayout: () => Boolean(state.handle),
    setSelectionForTest(sel: DiffSelection | null): void {
      state.selection = sel;
      if (!sel) state.commentOpen = false;
      paintCommentBar();
    },
    dispose(): void {
      if (state.disposed) return;
      state.disposed = true;
      state.seq += 1;
      destroyDiffHandle(state, mountHost);
      render(nothing, statusHost);
      render(nothing, emptyHost);
      render(nothing, commentHost);
      root.remove();
    },
  };
}
