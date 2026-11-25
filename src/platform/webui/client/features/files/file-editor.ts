import type { EditorHandle } from '../../../codeview/app.js';
import { icon } from '../../../icons.js';
import { addDisposableListener } from '../../base/dom.js';
import { html, nothing, render } from '../../base/html.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import {
  openConfirmDialog,
  renderActionBar,
  renderEmptyState,
  renderNotice,
  renderSegmented,
  type ActionItem,
} from '../../components/index.js';
import type { PluginContext } from '../../plugins/api.js';
import {
  baseName,
  canonicalFileKey,
  createFilesHttpClient,
  dirOf,
  eolWarningText,
  fileEditorTitle,
  fileErrorMessage,
  fromEditorDoc,
  isFileEditorInput,
  isFilesFeatureEnabled,
  isMarkdownFilename,
  relativePath,
  resolveFilesApi,
  toEditorDoc,
  type FilesHttpClient,
} from './helpers.js';
import type { FileTabStore } from './tab-store.js';
import type {
  FeaturePanelComponent,
  FeaturePanelInitContext,
  FeaturePanelRef,
  FileEditorInput,
  FilesPluginDeps,
  FileVersionBase,
  PartialFilesPanelFile,
} from './types.js';

interface EditorState {
  input: FileEditorInput | null;
  tabKey: string;
  path: string;
  rel: string;
  name: string;
  kind: 'text' | 'image' | 'binary' | 'big' | '';
  base: FileVersionBase | null;
  sha256: string;
  eol: 'crlf' | 'lf';
  eolWarning: string;
  savedDoc: string;
  dirty: boolean;
  busy: boolean;
  previewing: boolean;
  previewHtml: string;
  conflict: { deleted: boolean; mtimeMs?: number; size?: number } | null;
  notice: { text: string; tone: 'info' | 'ok' | 'warn' | 'err' } | null;
  view: EditorHandle | null;
  seq: number;
  disposed: boolean;
}

interface EditorContext {
  readonly ctx: PluginContext;
  readonly deps: FilesPluginDeps;
  readonly tabStore?: FileTabStore;
  readonly http: FilesHttpClient;
  readonly doc: Document;
  readonly state: EditorState;
  readonly headerEl: HTMLElement;
  readonly bannersEl: HTMLElement;
  readonly emptyEl: HTMLElement;
  readonly editorEl: HTMLElement;
  readonly previewEl: HTMLElement;
  readonly footerEl: HTMLElement;
  panelApi: FeaturePanelRef | null;
  panelId: string;
  paintAll: () => void;
  loadFile: (input: FileEditorInput) => Promise<void>;
  save: (force: boolean) => Promise<boolean>;
  togglePreview: () => Promise<void>;
  requestClose: () => Promise<boolean>;
  confirmReloadIfDirty: () => Promise<void>;
}

function buildSaveBody(state: EditorState, docText: string, force: boolean): Record<string, unknown> {
  const topic = state.input?.topicId ?? '';
  const body: Record<string, unknown> = {
    topic,
    path: state.path,
    text: fromEditorDoc(docText, state.eol),
  };
  // Security invariant 9: send version metadata unless user explicitly chose force overwrite.
  if (force) {
    body.force = true;
  } else if (state.base) {
    body.mtimeMs = state.base.mtimeMs;
    body.size = state.base.size;
    if (state.sha256) body.sha256 = state.sha256;
  }
  return body;
}

function destroyEditorView(state: EditorState): void {
  if (!state.view) return;
  try {
    state.view.destroy();
  } catch {
    // Ignore teardown errors from a replaced editor.
  }
  state.view = null;
}

function paintEditorHeader(ec: EditorContext): void {
  const { ctx, state, headerEl } = ec;
  const items: ActionItem[] = [];
  if (state.kind === 'text') {
    items.push({
      id: 'save',
      label: state.dirty ? ctx.i18n.t('files.saveDirty') : ctx.i18n.t('common.save'),
      variant: 'primary',
      disabled: !state.dirty || state.busy,
      onClick: () => void ec.save(false),
    });
  }
  if (state.input) {
    items.push({
      id: 'reveal-in-tree',
      icon: icon('folder'),
      title: ctx.i18n.t('files.revealInTree'),
      onClick: () => {
        if (!state.input) return;
        void ctx.commands.execute('files.revealInTree', {
          topicId: state.input.topicId,
          path: state.path || state.input.path,
        });
      },
    });
    items.push({
      id: 'reload',
      icon: icon('refresh'),
      title: ctx.i18n.t('files.reloadDisk'),
      disabled: state.busy,
      onClick: () => {
        void ec.confirmReloadIfDirty();
      },
    });
    items.push({
      id: 'close',
      icon: icon('cross'),
      title: ctx.i18n.t('files.closeTab'),
      disabled: state.busy,
      onClick: () => {
        void ec.requestClose();
      },
    });
  }

  render(
    html`<div class="fh-file-editor-meta">
        ${state.dirty
          ? html`<span class="fh-file-dirty-dot" data-file-dirty-dot aria-label=${ctx.i18n.t('files.unsavedDotAria')}></span>`
          : nothing}
        <span class="fh-file-editor-path" title=${state.rel || state.path}>${state.rel || state.path}</span>
        ${state.dirty ? html`<span class="fh-file-dirty" data-file-dirty>${ctx.i18n.t('files.unsavedChanges')}</span>` : nothing}
      </div>
      <div class="fh-file-editor-controls">
        ${state.kind === 'text' && isMarkdownFilename(state.name)
          ? renderSegmented({
              kind: 'value',
              className: 'fh-file-mode-seg',
              ariaLabel: ctx.i18n.t('files.preview'),
              value: state.previewing ? 'preview' : 'source',
              options: [
                { value: 'source', label: ctx.i18n.t('files.sourceMode') },
                { value: 'preview', label: ctx.i18n.t('files.previewMode') },
              ],
              onChange: (val) => {
                if ((val === 'preview') !== state.previewing) void ec.togglePreview();
              },
            })
          : nothing}
        ${items.length > 0 ? renderActionBar({ items, compact: true }) : nothing}
      </div>`,
    headerEl,
  );
}

function paintEditorFooter(ec: EditorContext): void {
  const { ctx, state, footerEl } = ec;
  if (state.kind !== 'text' || !state.input) {
    render(nothing, footerEl);
    return;
  }
  const eolLabel = state.eol === 'crlf' ? 'CRLF' : 'LF';
  render(
    html`<span class="fh-file-editor-foot-meta">${ctx.i18n.t('files.versionCheckHint', { eol: eolLabel })}</span>
      ${state.dirty
        ? html`<button
            type="button"
            class="fh-btn fh-btn--ghost fh-file-revert-btn"
            data-file-revert
            ?disabled=${state.busy}
            @click=${() => {
              if (!state.view) return;
              state.view.setDoc(state.savedDoc);
              state.dirty = false;
              state.conflict = null;
              updatePanelTitle(ec);
              ec.paintAll();
            }}
          >${ctx.i18n.t('files.revert')}</button>`
        : nothing}`,
    footerEl,
  );
}

function paintEditorBanners(ec: EditorContext): void {
  const { ctx, deps, state, bannersEl } = ec;
  const conflictBanner = state.conflict
    ? html`<div class="fh-file-conflict-wrap" data-file-conflict>
        ${renderNotice({
          tone: 'warn',
          role: 'alert',
          className: 'fh-file-conflict-banner',
          title: ctx.i18n.t('files.conflictTitle'),
          message: state.conflict.deleted
            ? ctx.i18n.t('files.conflictDeleted')
            : ctx.i18n.t('files.conflictChanged'),
          actions: html`<button
              type="button"
              class="fh-btn fh-btn--secondary"
              data-conflict-reload
              @click=${() => {
                state.conflict = null;
                if (state.input) void ec.loadFile(state.input);
              }}
            >${ctx.i18n.t('files.reloadDisk')}</button>
            <button
              type="button"
              class="fh-btn fh-btn--danger"
              data-conflict-overwrite
              @click=${async () => {
                const ok = await openConfirmDialog({
                  title: ctx.i18n.t('files.overwrite'),
                  body: ctx.i18n.t('files.confirmOverwrite', { name: state.rel || state.name }),
                  confirmLabel: ctx.i18n.t('files.overwrite'),
                  danger: true,
                  overlays: deps.overlays,
                  doc: ec.doc,
                });
                if (!ok || state.disposed) return;
                state.conflict = null;
                await ec.save(true);
              }}
            >${ctx.i18n.t('files.keepLocalOverwrite')}</button>
            <button
              type="button"
              class="fh-btn fh-btn--ghost"
              data-conflict-cancel
              @click=${() => {
                state.conflict = null;
                ec.paintAll();
              }}
            >${ctx.i18n.t('common.cancel')}</button>`,
        })}
      </div>`
    : nothing;

  const eolBanner = state.eolWarning
    ? renderNotice({ tone: 'info', message: state.eolWarning })
    : nothing;

  const statusBanner = state.notice
    ? renderNotice({
        tone: state.notice.tone,
        message: state.notice.text,
        dismissible: true,
        onDismiss: () => {
          state.notice = null;
          paintEditorBanners(ec);
        },
      })
    : nothing;

  render(html`${conflictBanner}${eolBanner}${statusBanner}`, bannersEl);
}

async function mountTextEditor(ec: EditorContext, initialDoc: string, seq: number): Promise<void> {
  const { state, emptyEl, editorEl, deps, ctx, doc } = ec;
  destroyEditorView(state);
  render(nothing, emptyEl);
  emptyEl.hidden = true;
  editorEl.textContent = '';
  editorEl.hidden = false;

  let cv = null;
  try {
    cv = deps.codeView ? await deps.codeView() : null;
  } catch {
    cv = null;
  }
  if (state.disposed || seq !== state.seq) return;

  const onDirtyChange = (nextDoc: string): void => {
    const nextDirty = nextDoc !== state.savedDoc;
    if (nextDirty !== state.dirty) {
      state.dirty = nextDirty;
      updatePanelTitle(ec);
      paintEditorHeader(ec);
      paintEditorFooter(ec);
    }
  };

  if (cv && typeof cv.editor === 'function') {
    state.view = cv.editor(editorEl, {
      doc: initialDoc,
      name: state.name,
      onChange: onDirtyChange,
      onSave: () => void ec.save(false),
    });
    return;
  }

  const ta = doc.createElement('textarea');
  ta.className = 'fh-file-textarea';
  ta.spellcheck = false;
  ta.value = initialDoc;
  ta.setAttribute('aria-label', state.name || ctx.i18n.t('files.fileContentsAria'));
  ta.addEventListener('input', () => onDirtyChange(ta.value));
  ta.addEventListener('keydown', (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      void ec.save(false);
    }
  });
  editorEl.appendChild(ta);
  state.view = {
    getDoc: () => ta.value,
    setDoc: (v: string) => {
      ta.value = v;
    },
    focus: () => ta.focus(),
    destroy: () => ta.remove(),
  };
}

function updatePanelTitle(ec: EditorContext): void {
  const base = fileEditorTitle(ec.state.input, ec.ctx.i18n.t('files.title'));
  ec.panelApi?.setTitle(ec.state.dirty ? `● ${base}` : base);
  if (ec.tabStore && ec.state.tabKey) {
    ec.tabStore.setDirty(ec.state.tabKey, ec.state.dirty);
  }
}

function handleSaveResponse(
  ec: EditorContext,
  res: { ok: boolean; status: number; body: Record<string, unknown> },
  sentDoc: string,
): boolean {
  const { state, ctx } = ec;
  if (res.ok) {
    state.base = { mtimeMs: Number(res.body.mtimeMs), size: Number(res.body.size) };
    if (typeof res.body.sha256 === 'string' && res.body.sha256) {
      state.sha256 = res.body.sha256;
    }
    if (state.view && state.view.getDoc() === sentDoc) {
      state.savedDoc = sentDoc;
      state.dirty = false;
      updatePanelTitle(ec);
    }
    state.conflict = null;
    state.notice = { text: ctx.i18n.t('files.saved', { name: state.rel || state.name, extra: '' }), tone: 'ok' };
    ec.paintAll();
    return true;
  }
  if (res.status === 409 || Boolean(res.body?.conflict)) {
    state.conflict = {
      deleted: res.body?.exists === false,
      mtimeMs: typeof res.body?.mtimeMs === 'number' ? res.body.mtimeMs : undefined,
      size: typeof res.body?.size === 'number' ? res.body.size : undefined,
    };
    ec.paintAll();
    return false;
  }
  state.notice = { text: fileErrorMessage(ctx, res, res.body), tone: 'err' };
  ec.paintAll();
  return false;
}

async function saveEditorFile(ec: EditorContext, force: boolean): Promise<boolean> {
  const { state, http, ctx } = ec;
  if (!isFilesFeatureEnabled(ec.deps)) {
    state.notice = { text: ctx.i18n.t('files.notEnabled'), tone: 'err' };
    ec.paintAll();
    return false;
  }
  if (state.kind !== 'text' || !state.path || !state.view || state.busy) return false;

  const sentDoc = state.view.getDoc();
  const body = buildSaveBody(state, sentDoc, force);
  state.busy = true;
  ec.paintAll();

  try {
    const res = await http.post('write', body);
    if (state.disposed) return false;
    state.busy = false;
    return handleSaveResponse(ec, res, sentDoc);
  } catch {
    if (state.disposed) return false;
    state.busy = false;
    state.notice = { text: ctx.i18n.t('files.saveReachErr'), tone: 'err' };
    ec.paintAll();
    return false;
  }
}

async function applyLoadedFile(ec: EditorContext, data: PartialFilesPanelFile, seq: number): Promise<void> {
  const { state, emptyEl, editorEl, previewEl, ctx, doc } = ec;
  state.path = data.path || state.input?.path || '';
  state.rel = data.rel || state.input?.rel || '';
  state.name = data.name || baseName(state.path);
  state.kind = data.kind || '';
  state.base = { mtimeMs: Number(data.mtimeMs), size: Number(data.size) };
  state.eol = data.eol === 'crlf' ? 'crlf' : 'lf';
  state.sha256 = data.sha256 || '';
  state.eolWarning = eolWarningText(ctx, data.eolWarning, state.eol);
  state.savedDoc = toEditorDoc(data.text || '');
  state.dirty = false;
  state.previewing = false;
  state.previewHtml = '';
  state.conflict = null;
  state.notice = data.note ? { text: data.note, tone: 'info' } : null;
  previewEl.hidden = true;
  updatePanelTitle(ec);
  ec.paintAll();

  if (data.kind === 'image') {
    destroyEditorView(state);
    render(nothing, emptyEl);
    emptyEl.hidden = true;
    editorEl.textContent = '';
    editorEl.hidden = false;
    const img = doc.createElement('img');
    img.className = 'fh-file-image';
    img.alt = state.name;
    img.src = data.dataUrl || '';
    editorEl.appendChild(img);
    return;
  }
  if (data.kind === 'text') {
    await mountTextEditor(ec, state.savedDoc, seq);
    return;
  }
  destroyEditorView(state);
  editorEl.textContent = '';
  editorEl.hidden = true;
  emptyEl.hidden = false;
  render(renderEmptyState({ title: data.note || ctx.i18n.t('files.cannotShow') }), emptyEl);
}

async function runLoadEditorFile(ec: EditorContext, input: FileEditorInput): Promise<void> {
  const { state, deps, http, ctx, emptyEl, editorEl } = ec;
  const seq = ++state.seq;
  state.input = input;
  state.conflict = null;
  state.notice = null;
  destroyEditorView(state);
  editorEl.textContent = '';
  editorEl.hidden = true;
  emptyEl.hidden = false;
  if (!isFilesFeatureEnabled(deps)) {
    state.kind = '';
    render(renderEmptyState({ title: ctx.i18n.t('files.notEnabled') }), emptyEl);
    ec.paintAll();
    return;
  }
  render(renderEmptyState({ title: ctx.i18n.t('common.loading') }), emptyEl);
  ec.paintAll();
  try {
    const res = await http.get('read', { topic: input.topicId, path: input.path });
    if (state.disposed || seq !== state.seq) return;
    if (!res.ok) {
      state.notice = { text: fileErrorMessage(ctx, res, res.body), tone: 'err' };
      render(nothing, emptyEl);
      ec.paintAll();
      return;
    }
    await applyLoadedFile(ec, res.body as PartialFilesPanelFile, seq);
  } catch {
    if (state.disposed || seq !== state.seq) return;
    state.notice = { text: ctx.i18n.t('common.reachDaemonError'), tone: 'err' };
    ec.paintAll();
  }
}

async function runToggleMarkdownPreview(ec: EditorContext): Promise<void> {
  const { state, deps, http, ctx, previewEl, editorEl } = ec;
  if (!state.input || state.kind !== 'text') return;
  if (state.previewing) {
    state.previewing = false;
    previewEl.hidden = true;
    editorEl.hidden = false;
    ec.paintAll();
    return;
  }
  const seq = ++state.seq;
  try {
    const res = await http.get('read', { topic: state.input.topicId, path: state.path, preview: '1' });
    if (state.disposed || seq !== state.seq) return;
    if (!res.ok) {
      state.notice = { text: fileErrorMessage(ctx, res, res.body), tone: 'err' };
      ec.paintAll();
      return;
    }
    const rendered = typeof res.body.html === 'string' && res.body.html ? res.body.html : '';
    if (rendered) {
      previewEl.innerHTML = `<div class="b">${rendered}</div>`;
      deps.codeBlocks?.(previewEl);
    } else {
      render(renderEmptyState({ title: ctx.i18n.t('files.nothingToRender') }), previewEl);
    }
    previewEl.hidden = false;
    editorEl.hidden = true;
    state.previewing = true;
    ec.paintAll();
  } catch {
    if (state.disposed || seq !== state.seq) return;
    state.notice = { text: ctx.i18n.t('common.reachDaemonError'), tone: 'err' };
    ec.paintAll();
  }
}

function createInitialEditorState(): EditorState {
  return {
    input: null,
    tabKey: '',
    path: '',
    rel: '',
    name: '',
    kind: '',
    base: null,
    sha256: '',
    eol: 'lf',
    eolWarning: '',
    savedDoc: '',
    dirty: false,
    busy: false,
    previewing: false,
    previewHtml: '',
    conflict: null,
    notice: null,
    view: null,
    seq: 0,
    disposed: false,
  };
}

async function requestEditorClose(ec: EditorContext): Promise<boolean> {
  const { state, ctx, deps, doc } = ec;
  if (state.disposed) return false;
  if (state.dirty) {
    const confirmed = await openConfirmDialog({
      title: ctx.i18n.t('files.closeTab'),
      body: ctx.i18n.t('files.confirmDiscard', {
        name: state.rel || state.name || ctx.i18n.t('files.thisFile'),
      }),
      confirmLabel: ctx.i18n.t('files.discardAndClose'),
      danger: true,
      overlays: deps.overlays,
      doc,
    });
    if (!confirmed || state.disposed) return false;
  }
  ec.panelApi?.close();
  return true;
}

async function confirmReloadEditorIfDirty(ec: EditorContext): Promise<void> {
  const { state, ctx, deps, doc } = ec;
  if (!state.input || state.busy) return;
  if (state.dirty && !state.conflict) {
    const confirmed = await openConfirmDialog({
      title: ctx.i18n.t('files.reloadDisk'),
      body: ctx.i18n.t('files.confirmDiscard', {
        name: state.rel || state.name || ctx.i18n.t('files.thisFile'),
      }),
      confirmLabel: ctx.i18n.t('files.reloadDisk'),
      danger: true,
      overlays: deps.overlays,
      doc,
    });
    if (!confirmed || state.disposed) return;
  }
  await ec.loadFile(state.input);
}

function createEditorDom(doc: Document): {
  element: HTMLElement;
  headerEl: HTMLElement;
  bannersEl: HTMLElement;
  emptyEl: HTMLElement;
  editorEl: HTMLElement;
  previewEl: HTMLElement;
  footerEl: HTMLElement;
} {
  const element = doc.createElement('div');
  element.className = 'fh-file-editor';
  const headerEl = doc.createElement('div');
  headerEl.className = 'fh-file-editor-head';
  const bannersEl = doc.createElement('div');
  bannersEl.className = 'fh-file-editor-banners';
  const emptyEl = doc.createElement('div');
  emptyEl.className = 'fh-file-editor-empty';
  const editorEl = doc.createElement('div');
  editorEl.className = 'fh-file-editor-body';
  editorEl.hidden = true;
  const previewEl = doc.createElement('div');
  previewEl.className = 'fh-file-editor-preview';
  previewEl.hidden = true;
  const footerEl = doc.createElement('div');
  footerEl.className = 'fh-file-editor-foot';
  element.append(headerEl, bannersEl, emptyEl, editorEl, previewEl, footerEl);
  return { element, headerEl, bannersEl, emptyEl, editorEl, previewEl, footerEl };
}

export function createFileEditorPanel(
  ctx: PluginContext,
  deps: FilesPluginDeps,
  tabStore?: FileTabStore,
): FeaturePanelComponent {
  const doc = deps.doc ?? document;
  const http = createFilesHttpClient(resolveFilesApi(deps));
  const store = new DisposableStore();
  let tabSub: Disposable | null = null;

  const { element, headerEl, bannersEl, emptyEl, editorEl, previewEl, footerEl } = createEditorDom(doc);

  const state = createInitialEditorState();

  const ec: EditorContext = {
    ctx,
    deps,
    tabStore,
    http,
    doc,
    state,
    headerEl,
    bannersEl,
    emptyEl,
    editorEl,
    previewEl,
    footerEl,
    panelApi: null,
    panelId: '',
    paintAll: () => {
      if (state.disposed) return;
      paintEditorHeader(ec);
      paintEditorBanners(ec);
      paintEditorFooter(ec);
    },
    loadFile: (input: FileEditorInput) => runLoadEditorFile(ec, input),
    save: (force: boolean) => saveEditorFile(ec, force),
    togglePreview: () => runToggleMarkdownPreview(ec),
    requestClose: () => requestEditorClose(ec),
    confirmReloadIfDirty: () => confirmReloadEditorIfDirty(ec),
  };

  store.add(
    addDisposableListener(element, 'keydown', (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) {
        ev.preventDefault();
        void ec.save(false);
      }
    }),
  );

  const applyParams = (params: unknown): void => {
    if (!isFileEditorInput(params)) {
      tabSub?.dispose();
      tabSub = null;
      state.tabKey = '';
      state.input = null;
      destroyEditorView(state);
      editorEl.textContent = '';
      editorEl.hidden = true;
      emptyEl.hidden = false;
      render(renderEmptyState({ title: ctx.i18n.t('files.cannotShow') }), emptyEl);
      ec.paintAll();
      return;
    }
    const rel = params.rel ?? (params.root ? relativePath(params.root, params.path) : undefined) ?? (dirOf(params.path) ? params.path : params.path);
    const cleanInput: FileEditorInput = {
      ...params,
      name: params.name ?? baseName(params.path),
      rel,
    };
    const nextKey = canonicalFileKey(cleanInput);
    if (state.tabKey === nextKey && state.dirty) {
      tabStore?.setActive(nextKey);
      state.view?.focus();
      return;
    }
    if (state.tabKey !== nextKey) {
      tabSub?.dispose();
      state.tabKey = nextKey;
      if (tabStore) {
        tabSub = tabStore.register({
          key: nextKey,
          panelId: ec.panelId,
          input: cleanInput,
          title: cleanInput.name ?? baseName(cleanInput.path),
          dirty: false,
          panelApi: ec.panelApi,
          focus: () => {
            ec.panelApi?.focus();
            state.view?.focus();
          },
          requestClose: () => ec.requestClose(),
        });
      }
    }
    void ec.loadFile(cleanInput);
  };

  return {
    element,
    init(params: unknown, initCtx: FeaturePanelInitContext): void {
      ec.panelApi = initCtx.api;
      ec.panelId = initCtx.id;
      store.add(
        initCtx.api.onDidVisibilityChange((visible) => {
          if (visible && state.tabKey) tabStore?.setActive(state.tabKey);
        }),
      );
      applyParams(params);
    },
    update(params: unknown): void {
      applyParams(params);
    },
    focus(): void {
      if (state.tabKey) tabStore?.setActive(state.tabKey);
      state.view?.focus();
    },
    dispose(): void {
      if (state.disposed) return;
      state.disposed = true;
      state.seq += 1;
      tabSub?.dispose();
      tabSub = null;
      destroyEditorView(state);
      store.dispose();
      render(nothing, headerEl);
      render(nothing, bannersEl);
      render(nothing, emptyEl);
      editorEl.textContent = '';
      previewEl.textContent = '';
      element.remove();
    },
  };
}
