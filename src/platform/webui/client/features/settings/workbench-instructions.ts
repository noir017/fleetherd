import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { DisposableStore } from '../../base/lifecycle.js';
import { icon } from '../../../icons.js';
import type { FilesHttpResult, FilesSource } from '../../panels/files.js';
import type { PluginContext } from '../../plugins/api.js';
import { text } from '../../services/api.js';
import {
  type InstructionEditorInput,
  isInstructionEditorInput,
  type SettingsPluginDeps,
  type SettingsRuntime,
  type WorkbenchPanelComponent,
  type WorkbenchPanelInitContext,
} from './workbench-types.js';

interface InstructionFileBase {
  mtimeMs: number;
  size: number;
}

interface InstructionEditorState {
  source: FilesSource | null;
  fileId: string;
  rel: string;
  name: string;
  base: InstructionFileBase | null;
  sha: string;
  eol: 'lf' | 'crlf';
  saved: string;
  dirty: boolean;
  busy: boolean;
  seq: number;
  disposed: boolean;
}

interface InstructionEditorDom {
  root: HTMLElement;
  titleEl: HTMLElement;
  whereEl: HTMLElement;
  noteEl: HTMLElement;
  eolEl: HTMLElement;
  conflictEl: HTMLElement;
  conflictTextEl: HTMLElement;
  reloadBtn: HTMLButtonElement;
  overwriteBtn: HTMLButtonElement;
  cancelConflictBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  treeEl: HTMLElement;
  editorWrap: HTMLElement;
  textarea: HTMLTextAreaElement;
  emptyEl: HTMLElement;
}

function normalizeToEditorDoc(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function restoreLineEndings(doc: string, eol: 'lf' | 'crlf'): string {
  return eol === 'crlf' ? doc.replace(/\n/g, '\r\n') : doc;
}

function formatError(ctx: PluginContext, res: FilesHttpResult): string {
  if (typeof res.body.error === 'string' && res.body.error) return res.body.error;
  return ctx.i18n.t('files.requestFailed', { status: res.status });
}

function formatEolWarning(ctx: PluginContext, warning: unknown, eol: 'lf' | 'crlf'): string {
  if (warning === 'cr') return ctx.i18n.t('files.eolCr');
  if (warning === 'mixed') return ctx.i18n.t('files.eolMixed', { eol: eol === 'crlf' ? 'CRLF' : 'LF' });
  return '';
}

function buildEditorDom(doc: Document, ctx: PluginContext): InstructionEditorDom {
  const root = doc.createElement('div');
  root.className = 'wb-instr-editor';

  const head = doc.createElement('div');
  head.className = 'wb-instr-head';
  head.innerHTML =
    '<div class="wb-instr-titles">' +
    '<h2 class="wb-instr-title"></h2>' +
    '<span class="wb-instr-where"></span>' +
    '</div>' +
    '<div class="wb-instr-actions">' +
    '<button type="button" class="fh-btn fh-btn--secondary wb-instr-refresh" title="' +
    text(ctx.i18n.t('common.refresh')) +
    '" aria-label="' +
    text(ctx.i18n.t('common.refresh')) +
    '">' +
    icon('refresh') +
    '</button>' +
    '<button type="button" class="fh-btn fh-btn--primary wb-instr-save" disabled>' +
    text(ctx.i18n.t('common.save')) +
    '</button>' +
    '</div>';

  const noteEl = doc.createElement('div');
  noteEl.className = 'wb-instr-note';
  noteEl.setAttribute('role', 'status');
  noteEl.hidden = true;

  const eolEl = doc.createElement('div');
  eolEl.className = 'wb-instr-eol';
  eolEl.hidden = true;

  const conflictEl = doc.createElement('div');
  conflictEl.className = 'wb-instr-conflict';
  conflictEl.setAttribute('role', 'alert');
  conflictEl.hidden = true;
  conflictEl.innerHTML =
    '<span class="wb-instr-conflict-text"></span>' +
    '<div class="wb-instr-conflict-actions">' +
    '<button type="button" class="fh-btn fh-btn--secondary wb-instr-reload">' +
    text(ctx.i18n.t('files.reloadDisk')) +
    '</button>' +
    '<button type="button" class="fh-btn fh-btn--danger wb-instr-overwrite">' +
    text(ctx.i18n.t('files.overwrite')) +
    '</button>' +
    '<button type="button" class="fh-btn fh-btn--secondary wb-instr-cancel">' +
    text(ctx.i18n.t('common.cancel')) +
    '</button>' +
    '</div>';

  const body = doc.createElement('div');
  body.className = 'wb-instr-body';

  const treeEl = doc.createElement('aside');
  treeEl.className = 'wb-instr-tree';
  treeEl.setAttribute('aria-label', ctx.i18n.t('files.instrFiles'));

  const editorWrap = doc.createElement('div');
  editorWrap.className = 'wb-instr-pane';

  const emptyEl = doc.createElement('div');
  emptyEl.className = 'wb-instr-empty';

  const textarea = doc.createElement('textarea');
  textarea.className = 'wb-instr-text fx-text';
  textarea.spellcheck = false;
  textarea.hidden = true;
  textarea.setAttribute('aria-label', ctx.i18n.t('files.fileContentsAria'));

  editorWrap.append(emptyEl, textarea);
  body.append(treeEl, editorWrap);
  root.append(head, noteEl, eolEl, conflictEl, body);

  return {
    root,
    titleEl: head.querySelector<HTMLElement>('.wb-instr-title')!,
    whereEl: head.querySelector<HTMLElement>('.wb-instr-where')!,
    noteEl,
    eolEl,
    conflictEl,
    conflictTextEl: conflictEl.querySelector<HTMLElement>('.wb-instr-conflict-text')!,
    reloadBtn: conflictEl.querySelector<HTMLButtonElement>('.wb-instr-reload')!,
    overwriteBtn: conflictEl.querySelector<HTMLButtonElement>('.wb-instr-overwrite')!,
    cancelConflictBtn: conflictEl.querySelector<HTMLButtonElement>('.wb-instr-cancel')!,
    refreshBtn: head.querySelector<HTMLButtonElement>('.wb-instr-refresh')!,
    saveBtn: head.querySelector<HTMLButtonElement>('.wb-instr-save')!,
    treeEl,
    editorWrap,
    textarea,
    emptyEl,
  };
}

function setNote(dom: InstructionEditorDom, msg: string): void {
  dom.noteEl.textContent = msg;
  dom.noteEl.hidden = !msg;
}

function syncSaveButton(ctx: PluginContext, state: InstructionEditorState, dom: InstructionEditorDom): void {
  dom.saveBtn.textContent = state.dirty ? ctx.i18n.t('files.saveDirty') : ctx.i18n.t('common.save');
  dom.saveBtn.disabled = state.busy || !state.fileId || !state.source;
}

function paintTree(state: InstructionEditorState, dom: InstructionEditorDom): void {
  if (!state.source) {
    dom.treeEl.textContent = '';
    return;
  }
  dom.treeEl.innerHTML = state.source.renderTree(state.fileId);
}

function firstEditableFileId(dom: InstructionEditorDom): string {
  const btn = dom.treeEl.querySelector<HTMLButtonElement>('button[data-fx-file]');
  return btn?.getAttribute('data-fx-file') ?? '';
}

function applyReadPayload(
  ctx: PluginContext,
  state: InstructionEditorState,
  dom: InstructionEditorDom,
  fileId: string,
  body: Record<string, unknown>,
  panelCtx: WorkbenchPanelInitContext | null,
): void {
  const eol: 'lf' | 'crlf' = body.eol === 'crlf' ? 'crlf' : 'lf';
  const rel = typeof body.rel === 'string' && body.rel ? body.rel : fileId;
  const name = typeof body.name === 'string' && body.name ? body.name : rel;
  const rawText = typeof body.text === 'string' ? body.text : '';
  const docText = normalizeToEditorDoc(rawText);

  state.fileId = fileId;
  state.rel = rel;
  state.name = name;
  state.eol = eol;
  state.base = { mtimeMs: Number(body.mtimeMs ?? 0), size: Number(body.size ?? 0) };
  state.sha = typeof body.sha256 === 'string' ? body.sha256 : '';
  state.saved = docText;
  state.dirty = false;

  dom.whereEl.textContent = rel;
  dom.conflictEl.hidden = true;
  const warn = formatEolWarning(ctx, body.eolWarning, eol);
  dom.eolEl.textContent = warn;
  dom.eolEl.hidden = !warn;
  setNote(dom, typeof body.note === 'string' ? body.note : '');

  dom.emptyEl.hidden = true;
  dom.textarea.hidden = false;
  dom.textarea.value = docText;
  dom.textarea.setAttribute('aria-label', name || ctx.i18n.t('files.fileContentsAria'));
  panelCtx?.api.setTitle(state.source ? `${state.source.title} · ${name}` : name);
  paintTree(state, dom);
  syncSaveButton(ctx, state, dom);
}

export function resolveInstructionEditorTitle(ctx: PluginContext, input: unknown): string {
  if (isInstructionEditorInput(input)) {
    if (input.title) return input.title;
    if (input.orphans) return ctx.i18n.t('instr.orphansTitle');
    if (input.agent) return ctx.i18n.t('instr.agentTitle', { agent: input.agent });
  }
  return ctx.i18n.t('instr.title');
}

interface InstructionEditorEnv {
  readonly ctx: PluginContext;
  readonly runtime: SettingsRuntime;
  readonly dom: InstructionEditorDom;
  readonly state: InstructionEditorState;
  readonly getPanelCtx: () => WorkbenchPanelInitContext | null;
}

async function openInstructionFile(env: InstructionEditorEnv, fileId: string): Promise<void> {
  const { ctx, runtime, dom, state } = env;
  if (!runtime.instrOk || !state.source || !fileId || state.disposed) return;
  const seq = ++state.seq;
  setNote(dom, '');
  dom.conflictEl.hidden = true;
  try {
    const res = await state.source.get('read', { path: fileId });
    if (state.disposed || seq !== state.seq) return;
    if (!res.ok) {
      setNote(dom, formatError(ctx, res));
      return;
    }
    applyReadPayload(ctx, state, dom, fileId, res.body, env.getPanelCtx());
  } catch {
    if (!state.disposed && seq === state.seq) setNote(dom, ctx.i18n.t('common.reachDaemonError'));
  }
}

async function loadInstructionList(env: InstructionEditorEnv, preferredFileId?: string): Promise<void> {
  const { ctx, runtime, dom, state } = env;
  if (!runtime.instrOk || !state.source || state.disposed) return;
  const seq = ++state.seq;
  setNote(dom, '');
  dom.conflictEl.hidden = true;
  dom.emptyEl.hidden = false;
  dom.emptyEl.textContent = ctx.i18n.t('common.loading');
  try {
    const res = await state.source.get('list', {});
    if (state.disposed || seq !== state.seq) return;
    if (!res.ok) {
      const errMsg = formatError(ctx, res);
      dom.emptyEl.textContent = errMsg;
      setNote(dom, errMsg);
      return;
    }
    paintTree(state, dom);
    const target = preferredFileId || state.fileId || firstEditableFileId(dom);
    if (target) {
      await openInstructionFile(env, target);
      return;
    }
    dom.textarea.hidden = true;
    dom.emptyEl.hidden = false;
    dom.emptyEl.textContent = ctx.i18n.t('instr.noHarnessFile');
    syncSaveButton(ctx, state, dom);
  } catch {
    if (!state.disposed && seq === state.seq) {
      dom.emptyEl.textContent = ctx.i18n.t('common.reachDaemonError');
    }
  }
}

function buildWriteRequest(state: InstructionEditorState, sent: string, force: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    path: state.fileId,
    text: restoreLineEndings(sent, state.eol),
  };
  // Security invariant 10: normal save always carries read version (mtimeMs/size/sha256); force requires explicit conflict confirm.
  if (force) {
    body.force = true;
  } else if (state.base) {
    body.mtimeMs = state.base.mtimeMs;
    body.size = state.base.size;
    if (state.sha) body.sha256 = state.sha;
  }
  return body;
}

function applySaveSuccess(
  env: InstructionEditorEnv,
  res: FilesHttpResult,
  sent: string,
): boolean {
  const { ctx, dom, state } = env;
  state.base = { mtimeMs: Number(res.body.mtimeMs ?? 0), size: Number(res.body.size ?? 0) };
  if (typeof res.body.sha256 === 'string' && res.body.sha256) state.sha = res.body.sha256;
  if (dom.textarea.value === sent) {
    state.saved = sent;
    state.dirty = false;
  }
  dom.conflictEl.hidden = true;
  const extra = state.source ? state.source.said() : '';
  setNote(dom, ctx.i18n.t('files.saved', { name: state.rel || state.name, extra }));
  syncSaveButton(ctx, state, dom);
  return true;
}

function applySaveFailure(env: InstructionEditorEnv, res: FilesHttpResult): boolean {
  const { ctx, dom, state } = env;
  if (res.body.conflict) {
    dom.conflictEl.hidden = false;
    dom.conflictTextEl.textContent =
      res.body.exists === false ? ctx.i18n.t('files.conflictDeleted') : ctx.i18n.t('files.conflictChanged');
  } else {
    setNote(dom, formatError(ctx, res));
  }
  syncSaveButton(ctx, state, dom);
  return false;
}

async function saveInstructionFile(env: InstructionEditorEnv, force: boolean): Promise<boolean> {
  const { ctx, runtime, dom, state } = env;
  if (!runtime.instrOk || !state.source || !state.fileId || state.busy || state.disposed) return false;
  const sent = dom.textarea.value;
  const body = buildWriteRequest(state, sent, force);
  state.busy = true;
  syncSaveButton(ctx, state, dom);
  try {
    const res = await state.source.post('write', body);
    state.busy = false;
    if (state.disposed) return false;
    return res.ok ? applySaveSuccess(env, res, sent) : applySaveFailure(env, res);
  } catch {
    state.busy = false;
    if (!state.disposed) {
      setNote(dom, ctx.i18n.t('files.saveReachErr'));
      syncSaveButton(ctx, state, dom);
    }
    return false;
  }
}

export function createInstructionEditorComponent(
  ctx: PluginContext,
  runtime: SettingsRuntime,
  deps: SettingsPluginDeps,
): WorkbenchPanelComponent {
  const doc = deps.doc ?? document;
  const dom = buildEditorDom(doc, ctx);
  const disposables = new DisposableStore();
  const painterSub = new DisposableStore();
  disposables.add(painterSub);

  const state: InstructionEditorState = {
    source: null,
    fileId: '',
    rel: '',
    name: '',
    base: null,
    sha: '',
    eol: 'lf',
    saved: '',
    dirty: false,
    busy: false,
    seq: 0,
    disposed: false,
  };

  let panelCtx: WorkbenchPanelInitContext | null = null;
  let currentInput: InstructionEditorInput = {};
  const env: InstructionEditorEnv = { ctx, runtime, dom, state, getPanelCtx: () => panelCtx };

  const applyInput = (params: unknown): void => {
    currentInput = isInstructionEditorInput(params) ? params : {};
    const title = resolveInstructionEditorTitle(ctx, currentInput);
    dom.titleEl.textContent = title;
    panelCtx?.api.setTitle(title);

    // Security invariant 10: never issue /api/instructions* requests when instructions.enabled is off.
    if (!runtime.instrOk) {
      state.source = null;
      state.fileId = '';
      dom.treeEl.textContent = '';
      dom.textarea.hidden = true;
      dom.emptyEl.hidden = false;
      dom.emptyEl.textContent = ctx.i18n.t('instr.notAvailable');
      syncSaveButton(ctx, state, dom);
      return;
    }

    const source = currentInput.source ?? runtime.createInstructionSource(currentInput);
    if (!source) {
      dom.textarea.hidden = true;
      dom.emptyEl.hidden = false;
      dom.emptyEl.textContent = ctx.i18n.t('instr.notAvailable');
      syncSaveButton(ctx, state, dom);
      return;
    }
    state.source = source;
    painterSub.clear();
    painterSub.add(runtime.registerTreePainter(source, () => paintTree(state, dom)));
    void loadInstructionList(env, currentInput.fileId);
  };

  disposables.add(
    addDisposableListener(dom.treeEl, 'click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const btn = target?.closest<HTMLButtonElement>('button[data-fx-file]');
      const id = btn?.getAttribute('data-fx-file');
      if (id) void openInstructionFile(env, id);
    }),
  );
  disposables.add(
    addDisposableListener(dom.textarea, 'input', () => {
      state.dirty = dom.textarea.value !== state.saved;
      syncSaveButton(ctx, state, dom);
    }),
  );
  disposables.add(
    addDisposableListener(dom.textarea, 'keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void saveInstructionFile(env, false);
      }
    }),
  );
  disposables.add(addDisposableListener(dom.saveBtn, 'click', () => void saveInstructionFile(env, false)));
  disposables.add(addDisposableListener(dom.refreshBtn, 'click', () => void loadInstructionList(env, state.fileId)));
  disposables.add(addDisposableListener(dom.reloadBtn, 'click', () => void openInstructionFile(env, state.fileId)));
  disposables.add(addDisposableListener(dom.overwriteBtn, 'click', () => void saveInstructionFile(env, true)));
  disposables.add(
    addDisposableListener(dom.cancelConflictBtn, 'click', () => {
      dom.conflictEl.hidden = true;
    }),
  );

  return {
    element: dom.root,
    init(params, initCtx) {
      panelCtx = initCtx;
      applyInput(params);
    },
    update(params) {
      applyInput(params);
    },
    focus() {
      if (!dom.textarea.hidden) focusSafely(dom.textarea);
    },
    dispose() {
      state.disposed = true;
      state.seq++;
      state.source?.onClose?.();
      state.source = null;
      disposables.dispose();
    },
  };
}
