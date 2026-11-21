import type { FilesPanelEntry, FilesPanelFile, FilesPanelHit, FilesPanelKind } from '../../../adapter.js';
import type { CodeViewApi, EditorHandle } from '../../codeview/app.js';
import { icon } from '../../icons.js';

export interface FilesHttpResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export interface FilesSource {
  title: string;
  get: (route: string, params: Record<string, string | undefined>) => Promise<FilesHttpResult>;
  post: (route: string, body: Record<string, unknown>) => Promise<FilesHttpResult>;
  renderTree: (activePath: string) => string;
  said: () => string;
  onClose?: () => void;
}

export interface FilesPanelDeps {
  filesOk: boolean;
  instrOk: boolean;
  getTopic: () => string;
  text: (s: unknown) => string;
  post: (path: string, body: unknown, tries: number) => Promise<Response>;
  codeView: () => Promise<CodeViewApi | null>;
  codeBlocks: (root: Element) => void;
  closeMenus: () => void;
}

export interface FilesPanel {
  open: (topic: string, path?: string, src?: FilesSource | null) => void;
  openEditor: (path: string) => void;
  close: () => void;
  isOpen: () => boolean;
  isCustomOpen: () => boolean;
  paintTree: () => void;
  currentSource: () => FilesSource | null;
  previewEl: () => HTMLElement;
}

interface FilesDom {
  win: HTMLElement;
  title: HTMLElement;
  where: HTMLElement;
  treeList: HTMLElement;
  treeHead: HTMLElement;
  searchRow: HTMLElement;
  hits: HTMLElement;
  crumbs: HTMLElement;
  editor: HTMLElement;
  preview: HTMLElement;
  note: HTMLElement;
  eol: HTMLElement;
  conflict: HTMLElement;
  conflictText: HTMLElement;
  saveBtn: HTMLButtonElement;
  previewBtn: HTMLButtonElement;
  renameBtn: HTMLButtonElement;
  deleteBtn: HTMLButtonElement;
  dirtyTag: HTMLElement;
  newRow: HTMLElement;
  newName: HTMLInputElement;
  renameRow: HTMLElement;
  renameName: HTMLInputElement;
  renameWhat: HTMLElement;
  treeToggle: HTMLButtonElement;
  q: HTMLInputElement;
  toggleBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
  qGoBtn: HTMLButtonElement;
  newFileBtn: HTMLButtonElement;
  newDirBtn: HTMLButtonElement;
  newGoBtn: HTMLButtonElement;
  newCancelBtn: HTMLButtonElement;
  renameGoBtn: HTMLButtonElement;
  renameCancelBtn: HTMLButtonElement;
  reloadBtn: HTMLButtonElement;
  overwriteBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
}

interface TreeNode {
  path: string;
  entries: FilesPanelEntry[];
}

interface FilesState {
  topic: string;
  root: string;
  dir: string;
  path: string;
  rel: string;
  name: string;
  kind: FilesPanelKind | '';
  base: { mtimeMs: number; size: number } | null;
  saved: string;
  dirty: boolean;
  view: EditorHandle | null;
  seq: number;
  nodes: Record<string, TreeNode>;
  openDirs: Record<string, boolean>;
  newIsDir: boolean;
  previewing: boolean;
  busy: boolean;
  eol: 'crlf' | 'lf';
  sha: string;
  sep: '/' | '\\';
  src: FilesSource | null;
  rename: { path: string; dir: boolean } | null;
}

interface FilesCtx {
  state: FilesState;
  dom: FilesDom;
  deps: FilesPanelDeps;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing element #' + id);
  return el as T;
}

function queryDom(): FilesDom {
  return {
    win: byId('files'),
    title: byId('files-title'),
    where: byId('files-where'),
    treeList: byId('files-tree-list'),
    treeHead: byId('files-tree-head'),
    searchRow: byId('files-search-row'),
    hits: byId('files-hits'),
    crumbs: byId('files-crumbs'),
    editor: byId('files-editor'),
    preview: byId('files-preview'),
    note: byId('files-note'),
    eol: byId('files-eol'),
    conflict: byId('files-conflict'),
    conflictText: byId('files-conflict-text'),
    saveBtn: byId<HTMLButtonElement>('files-save'),
    previewBtn: byId<HTMLButtonElement>('files-preview-toggle'),
    renameBtn: byId<HTMLButtonElement>('files-rename-open'),
    deleteBtn: byId<HTMLButtonElement>('files-delete'),
    dirtyTag: byId('files-dirty'),
    newRow: byId('files-new-row'),
    newName: byId<HTMLInputElement>('files-new-name'),
    renameRow: byId('files-rename-row'),
    renameName: byId<HTMLInputElement>('files-rename-name'),
    renameWhat: byId('files-rename-what'),
    treeToggle: byId<HTMLButtonElement>('files-tree-toggle'),
    q: byId<HTMLInputElement>('files-q'),
    toggleBtn: byId<HTMLButtonElement>('files-toggle'),
    closeBtn: byId<HTMLButtonElement>('files-close'),
    refreshBtn: byId<HTMLButtonElement>('files-refresh'),
    qGoBtn: byId<HTMLButtonElement>('files-q-go'),
    newFileBtn: byId<HTMLButtonElement>('files-new-file'),
    newDirBtn: byId<HTMLButtonElement>('files-new-dir'),
    newGoBtn: byId<HTMLButtonElement>('files-new-go'),
    newCancelBtn: byId<HTMLButtonElement>('files-new-cancel'),
    renameGoBtn: byId<HTMLButtonElement>('files-rename-go'),
    renameCancelBtn: byId<HTMLButtonElement>('files-rename-cancel'),
    reloadBtn: byId<HTMLButtonElement>('files-reload'),
    overwriteBtn: byId<HTMLButtonElement>('files-overwrite'),
    cancelBtn: byId<HTMLButtonElement>('files-cancel'),
  };
}

function fileMsg(r: { status: number }, d?: Record<string, unknown>): string {
  if (d && typeof d.error === 'string' && d.error) return d.error;
  return r.status === 404 ? 'The file window is not enabled on this daemon.' : 'That request failed (' + r.status + ').';
}

// Remote hosts are POSIX, but local Windows workspaces use backslashes; derive separator from daemon root.
function fxSepOf(root: string): '/' | '\\' {
  return root && root.indexOf('\\') >= 0 && root.indexOf('/') < 0 ? '\\' : '/';
}

function fxAbs(dir: string, name: string, sep: '/' | '\\'): string {
  if (!dir) return name;
  const last = dir.charAt(dir.length - 1);
  return dir + (last === '/' || last === '\\' ? '' : sep) + name;
}

function fxDirOf(p: string): string {
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (at < 0) return '';
  if (at === 0) return p.charAt(0);
  if (at === 2 && /^[A-Za-z]:$/.test(p.slice(0, 2))) return p.slice(0, 3);
  return p.slice(0, at);
}

export function fxBase(p: string): string {
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return at < 0 ? p : p.slice(at + 1);
}

function fxToDoc(raw: unknown): string {
  return String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// Editor normalizes to LF; restore reported CRLF on save so untouched endings round-trip.
function fxFromDoc(doc: string, eol: 'crlf' | 'lf'): string {
  const lf = String(doc || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

function shortRoot(p: string): string {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] || '/' : p || '/';
}

function say(dom: FilesDom, msg: string): void {
  dom.note.hidden = !msg;
  dom.note.textContent = msg || '';
}

function confirmLeave(state: FilesState): boolean {
  if (!state.dirty) return true;
  return confirm('Discard the unsaved changes to ' + (state.rel || state.name || 'this file') + '?');
}

function setDirty(state: FilesState, dom: FilesDom, v: boolean): void {
  state.dirty = Boolean(v);
  dom.dirtyTag.hidden = !state.dirty;
  dom.saveBtn.disabled = !(state.kind === 'text' && state.dirty);
  dom.saveBtn.textContent = state.dirty ? 'Save *' : 'Save';
}

function paintActions(state: FilesState, dom: FilesDom): void {
  dom.saveBtn.disabled = !(state.kind === 'text' && state.dirty);
  dom.previewBtn.hidden = !(state.kind === 'text' && /.(md|markdown)$/i.test(state.name));
  dom.previewBtn.textContent = state.previewing ? 'Edit' : 'Preview';
  dom.renameBtn.disabled = !state.path;
  dom.deleteBtn.disabled = !state.path;
}

function paintMode(state: FilesState, dom: FilesDom): void {
  const on = Boolean(state.src);
  dom.win.classList.toggle('instr', on);
  dom.treeHead.hidden = on;
  dom.searchRow.hidden = on;
  dom.crumbs.hidden = on;
  dom.renameBtn.hidden = on;
  dom.deleteBtn.hidden = on;
  dom.treeToggle.title = on ? 'Instruction files' : 'Files';
}

function rowHtml(
  state: FilesState,
  abs: string,
  name: string,
  dir: boolean,
  depth: number,
  text: (s: unknown) => string
): string {
  const pad = 6 + depth * 12;
  if (dir) {
    const open = Boolean(state.openDirs[abs]);
    // Use a div, not a button: inner rename/delete buttons would nest buttons (invalid HTML, breaks screen readers).
    return (
      '<div class="fx-row fx-dirrow">' +
      '<button type="button" class="fx-main" data-fx-dir="' +
      text(abs) +
      '" style="padding-left:' +
      pad +
      'px">' +
      '<span class="fx-caret">' +
      (open ? icon('chevronDown') : icon('chevronRight')) +
      '</span>' +
      icon('folder') +
      '<span class="fx-name">' +
      text(name) +
      '</span></button>' +
      '<button type="button" class="fx-act" data-fx-dir-rename="' +
      text(abs) +
      '" title="Rename folder" aria-label="Rename folder ' +
      text(name) +
      '">' +
      icon('pencil') +
      '</button>' +
      '<button type="button" class="fx-act" data-fx-dir-delete="' +
      text(abs) +
      '" title="Delete empty folder" aria-label="Delete folder ' +
      text(name) +
      '">' +
      icon('trash') +
      '</button></div>'
    );
  }
  return (
    '<button type="button" class="fx-row' +
    (state.path === abs ? ' on' : '') +
    '" data-fx-file="' +
    text(abs) +
    '" style="padding-left:' +
    pad +
    'px">' +
    '<span class="fx-caret blank"></span>' +
    icon('note') +
    '<span class="fx-name">' +
    text(name) +
    '</span></button>'
  );
}

function paintTree(ctx: FilesCtx): void {
  const { state, dom, deps } = ctx;
  if (state.src) {
    dom.treeList.innerHTML = state.src.renderTree(state.path);
    return;
  }
  let h = '';
  const walk = (key: string, depth: number): void => {
    const node = state.nodes[key];
    if (!node) return;
    for (const e of node.entries || []) {
      const abs = fxAbs(node.path, e.name, state.sep);
      h += rowHtml(state, abs, e.name, e.dir, depth, deps.text);
      if (e.dir && state.openDirs[abs]) walk(abs, depth + 1);
    }
  };
  walk('', 0);
  dom.treeList.innerHTML = h || '<div class="skills-empty">Empty directory.</div>';
}

function paintCrumbs(ctx: FilesCtx): void {
  const { state, dom, deps } = ctx;
  if (!state.root) {
    dom.crumbs.innerHTML = '';
    return;
  }
  let h = '<button type="button" data-fx-crumb="' + deps.text(state.root) + '">' + deps.text(shortRoot(state.root)) + '</button>';
  const rel =
    state.dir && state.dir !== state.root && state.dir.indexOf(state.root + '/') === 0
      ? state.dir.slice(state.root.length + 1)
      : '';
  let acc = state.root;
  if (rel) {
    for (const part of rel.split('/')) {
      acc = fxAbs(acc, part, state.sep);
      h += '<span class="fx-sep">/</span><button type="button" data-fx-crumb="' + deps.text(acc) + '">' + deps.text(part) + '</button>';
    }
  }
  if (state.name) h += '<span class="fx-sep">/</span><span class="fx-crumb-file">' + deps.text(state.name) + '</span>';
  dom.crumbs.innerHTML = h;
}

function eolWarningText(eolWarning: unknown, eol: 'crlf' | 'lf'): string {
  if (eolWarning === 'cr') return 'This file uses CR line endings; saving will normalize them to LF.';
  if (eolWarning === 'mixed') {
    return 'This file mixes line endings; saving will normalize them to ' + (eol === 'crlf' ? 'CRLF' : 'LF') + '.';
  }
  return '';
}

function forgetTreeBelow(state: FilesState, abs: string): void {
  for (const k of Object.keys(state.nodes)) {
    if (k === abs || k.indexOf(abs + state.sep) === 0) delete state.nodes[k];
  }
  delete state.openDirs[abs];
}

function isValidSegment(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && name.indexOf('/') < 0;
}

function clearOpenFile(state: FilesState, dom: FilesDom): void {
  state.dirty = false;
  state.seq++;
  state.path = '';
  state.rel = '';
  state.name = '';
  state.kind = '';
  state.base = null;
  state.view = null;
  state.eol = 'lf';
  state.sha = '';
  dom.eol.hidden = true;
  dom.eol.textContent = '';
  setDirty(state, dom, false);
  dom.title.textContent = 'Files';
  dom.where.textContent = state.root;
  dom.crumbs.innerHTML = '';
  dom.editor.textContent = '';
  dom.preview.hidden = true;
  dom.preview.innerHTML = '';
  dom.conflict.hidden = true;
  dom.previewBtn.hidden = true;
  dom.renameBtn.disabled = true;
  dom.deleteBtn.disabled = true;
  paintActions(state, dom);
}

function apiGet(ctx: FilesCtx, route: string, params: Record<string, string | undefined>): Promise<FilesHttpResult> {
  if (ctx.state.src) return ctx.state.src.get(route, params);
  const qs: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return fetch('api/files/' + route + (qs.length ? '?' + qs.join('&') : ''), { credentials: 'same-origin' }).then(
    (r) =>
      r
        .json()
        .catch(() => ({}))
        .then((d: Record<string, unknown>) => ({ ok: r.ok, status: r.status, body: d }))
  );
}

function apiPost(ctx: FilesCtx, route: string, body: Record<string, unknown>): Promise<FilesHttpResult> {
  if (ctx.state.src) return ctx.state.src.post(route, body);
  return ctx.deps.post('api/files/' + route, body, 1).then((r) =>
    r
      .json()
      .catch(() => ({}))
      .then((d: Record<string, unknown>) => ({ ok: r.ok, status: r.status, body: d }))
  );
}

function revealDir(ctx: FilesCtx, abs: string): void {
  const { state } = ctx;
  if (!state.root || abs.indexOf(state.root) !== 0) return;
  const rel = abs === state.root ? '' : abs.slice(state.root.length + 1);
  const parts = rel ? rel.split('/') : [];
  const chain: Array<{ key: string; abs: string }> = [{ key: '', abs: state.root }];
  let cur = state.root;
  for (const part of parts) {
    cur = fxAbs(cur, part, state.sep);
    chain.push({ key: cur, abs: cur });
  }
  let at = 0;
  const next = (): void => {
    if (at >= chain.length) {
      for (const c of chain) state.openDirs[c.key] = true;
      paintTree(ctx);
      return;
    }
    const c = chain[at++];
    if (!c || state.nodes[c.key]) {
      next();
      return;
    }
    apiGet(ctx, 'list', { topic: state.topic, path: c.key }).then((res) => {
      if (res.ok) {
        state.nodes[c.key] = {
          path: typeof res.body.path === 'string' && res.body.path ? res.body.path : c.abs,
          entries: (res.body.entries as FilesPanelEntry[] | undefined) || [],
        };
      }
      next();
    }, next);
  };
  next();
}

function reloadDir(ctx: FilesCtx, abs: string): void {
  const key = abs === ctx.state.root ? '' : abs;
  apiGet(ctx, 'list', { topic: ctx.state.topic, path: key })
    .then((res) => {
      if (!res.ok) return;
      ctx.state.nodes[key] = {
        path: typeof res.body.path === 'string' && res.body.path ? res.body.path : abs,
        entries: (res.body.entries as FilesPanelEntry[] | undefined) || [],
      };
      paintTree(ctx);
    })
    .catch(() => {});
}

function refreshTree(ctx: FilesCtx, keepDir: string): void {
  ctx.state.nodes = {};
  ctx.state.openDirs = { '': true };
  ctx.state.dir = keepDir || ctx.state.root;
  paintTree(ctx);
  apiGet(ctx, 'list', { topic: ctx.state.topic, path: '' })
    .then((res) => {
      if (!res.ok) {
        say(ctx.dom, fileMsg(res, res.body));
        return;
      }
      ctx.state.nodes[''] = {
        path: ctx.state.root,
        entries: (res.body.entries as FilesPanelEntry[] | undefined) || [],
      };
      paintTree(ctx);
      if (keepDir && keepDir !== ctx.state.root) revealDir(ctx, keepDir);
    })
    .catch(() => say(ctx.dom, 'Could not reach the daemon.'));
}

function toggleDir(ctx: FilesCtx, abs: string): void {
  const { state, dom } = ctx;
  if (state.openDirs[abs]) {
    delete state.openDirs[abs];
    paintTree(ctx);
    return;
  }
  state.openDirs[abs] = true;
  state.dir = abs;
  dom.win.classList.remove('tree-open');
  if (state.nodes[abs]) {
    paintTree(ctx);
    return;
  }
  apiGet(ctx, 'list', { topic: state.topic, path: abs })
    .then((res) => {
      if (!res.ok) {
        delete state.openDirs[abs];
        say(dom, fileMsg(res, res.body));
        return;
      }
      state.nodes[abs] = {
        path: typeof res.body.path === 'string' && res.body.path ? res.body.path : abs,
        entries: (res.body.entries as FilesPanelEntry[] | undefined) || [],
      };
      paintTree(ctx);
    })
    .catch(() => say(dom, 'Could not reach the daemon.'));
}

function saveFile(ctx: FilesCtx, force: boolean): Promise<boolean> {
  const { state, dom } = ctx;
  if (state.kind !== 'text' || !state.path || !state.view || state.busy) return Promise.resolve(false);
  const doc = state.view.getDoc();
  const body: Record<string, unknown> = { topic: state.topic, path: state.path, text: fxFromDoc(doc, state.eol) };
  // Security invariant 9: send read version unless user explicitly chose force overwrite.
  if (force) {
    body.force = true;
  } else if (state.base) {
    body.mtimeMs = state.base.mtimeMs;
    body.size = state.base.size;
    if (state.sha) body.sha256 = state.sha;
  }
  const sent = doc;
  state.busy = true;
  dom.saveBtn.disabled = true;
  return apiPost(ctx, 'write', body).then(
    (res) => {
      state.busy = false;
      if (res.ok) {
        state.base = { mtimeMs: Number(res.body.mtimeMs), size: Number(res.body.size) };
        if (typeof res.body.sha256 === 'string' && res.body.sha256) state.sha = res.body.sha256;
        if (state.view && state.view.getDoc() === sent) {
          state.saved = sent;
          setDirty(state, dom, false);
        }
        dom.conflict.hidden = true;
        say(dom, 'Saved ' + (state.rel || state.name) + '.' + (state.src ? state.src.said() : ''));
        paintActions(state, dom);
        return true;
      }
      if (res.body && res.body.conflict) {
        dom.conflict.hidden = false;
        dom.conflictText.textContent =
          res.body.exists === false
            ? 'That file was deleted on the machine since you opened it. Your changes are still here.'
            : 'That file changed on the machine since you opened it. Reload it, overwrite it, or cancel and keep editing.';
        paintActions(state, dom);
        return false;
      }
      say(dom, fileMsg(res, res.body));
      paintActions(state, dom);
      return false;
    },
    () => {
      state.busy = false;
      say(dom, 'Could not reach the daemon; the file was not saved.');
      paintActions(state, dom);
      return false;
    }
  );
}

function makeEditor(ctx: FilesCtx, doc: string): void {
  const { state, dom, deps } = ctx;
  dom.editor.textContent = '';
  state.view = null;
  const seq = ++state.seq;
  deps.codeView().then((cv) => {
    if (seq !== state.seq) return;
    if (cv && cv.editor) {
      state.view = cv.editor(dom.editor, {
        doc,
        name: state.name,
        onChange: (next) => setDirty(state, dom, next !== state.saved),
        onSave: () => {
          void saveFile(ctx, false);
        },
      });
      if (state.view && state.view.focus) state.view.focus();
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'fx-text';
      ta.spellcheck = false;
      ta.value = doc;
      ta.setAttribute('aria-label', state.name || 'File contents');
      ta.addEventListener('input', () => setDirty(state, dom, ta.value !== state.saved));
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          void saveFile(ctx, false);
        }
      });
      dom.editor.appendChild(ta);
      state.view = {
        getDoc: () => ta.value,
        setDoc: (v) => {
          ta.value = v;
        },
        focus: () => ta.focus(),
        destroy: () => {},
      };
    }
  });
}

function paintFile(ctx: FilesCtx, d: Partial<FilesPanelFile>): void {
  const { state, dom, deps } = ctx;
  state.path = d.path || '';
  state.rel = d.rel || '';
  state.name = d.name || fxBase(state.path);
  state.kind = d.kind || '';
  state.dir = d.dir || fxDirOf(state.path);
  state.base = { mtimeMs: Number(d.mtimeMs), size: Number(d.size) };
  state.eol = d.eol === 'crlf' ? 'crlf' : 'lf';
  state.sha = d.sha256 || '';
  const warnText = eolWarningText(d.eolWarning, state.eol);
  dom.eol.hidden = !warnText;
  dom.eol.textContent = warnText;
  state.saved = fxToDoc(d.text || '');
  state.previewing = false;
  state.view = null;
  dom.preview.hidden = true;
  dom.preview.innerHTML = '';
  dom.editor.hidden = false;
  dom.conflict.hidden = true;
  dom.title.textContent = state.name;
  dom.where.textContent = state.rel || state.path;
  dom.newRow.hidden = true;
  dom.renameRow.hidden = true;
  state.rename = null;
  say(dom, d.note || '');
  setDirty(state, dom, false);
  paintCrumbs(ctx);
  if (d.kind === 'image') {
    dom.editor.textContent = '';
    const wrap = document.createElement('div');
    wrap.id = 'files-image';
    const img = document.createElement('img');
    img.alt = state.name;
    img.src = d.dataUrl || '';
    wrap.appendChild(img);
    dom.editor.appendChild(wrap);
  } else if (d.kind === 'text') {
    makeEditor(ctx, state.saved);
  } else {
    dom.editor.innerHTML = '<div class="skills-empty">' + deps.text(d.note || 'This file cannot be shown here.') + '</div>';
  }
  paintActions(state, dom);
  paintTree(ctx);
}

function openFile(ctx: FilesCtx, path: string, skipConfirm?: boolean): void {
  const { state, dom } = ctx;
  if (!path || !state.topic) return;
  if (!skipConfirm && !confirmLeave(state)) return;
  const seq = ++state.seq;
  say(dom, '');
  dom.conflict.hidden = true;
  dom.win.classList.remove('tree-open');
  apiGet(ctx, 'read', { topic: state.topic, path })
    .then((res) => {
      if (seq !== state.seq) return;
      if (!res.ok) {
        say(dom, fileMsg(res, res.body));
        return;
      }
      paintFile(ctx, res.body as Partial<FilesPanelFile>);
    })
    .catch(() => {
      if (seq === state.seq) say(dom, 'Could not reach the daemon.');
    });
}

function newStart(ctx: FilesCtx, dir: boolean): void {
  if (!ctx.state.root) return;
  ctx.state.newIsDir = dir;
  ctx.dom.newRow.hidden = false;
  ctx.dom.newName.value = '';
  ctx.dom.newName.focus();
}

function newGo(ctx: FilesCtx): void {
  const { state, dom } = ctx;
  const name = String(dom.newName.value || '').trim();
  if (!isValidSegment(name)) {
    say(dom, 'A name is one path segment, with no slash.');
    return;
  }
  const dir = state.dir || state.root;
  const abs = fxAbs(dir, name, state.sep);
  const where = state.rel ? fxDirOf(state.rel) : '';
  if (!confirm('Create the ' + (state.newIsDir ? 'folder' : 'file') + ' "' + (where ? where + '/' : '') + name + '"?')) {
    return;
  }
  apiPost(ctx, 'create', { topic: state.topic, path: abs, dir: state.newIsDir })
    .then((res) => {
      if (!res.ok) {
        say(dom, fileMsg(res, res.body));
        return;
      }
      dom.newRow.hidden = true;
      reloadDir(ctx, dir);
      if (!state.newIsDir) openFile(ctx, abs);
    })
    .catch(() => say(dom, 'Could not reach the daemon.'));
}

function showRename(dom: FilesDom, what: string, value: string): void {
  dom.renameRow.hidden = false;
  dom.renameWhat.textContent = what;
  dom.renameName.value = value;
  dom.renameName.focus();
  dom.renameName.select();
}

function applyDirRename(ctx: FilesCtx, targetPath: string, to: string): void {
  const { state, dom } = ctx;
  if (state.path && state.path.indexOf(targetPath + state.sep) === 0) {
    state.path = to + state.path.slice(targetPath.length);
    state.dir = fxDirOf(state.path);
    state.rel = state.path.indexOf(state.root + state.sep) === 0 ? state.path.slice(state.root.length + 1) : '';
    dom.where.textContent = state.rel || state.path;
    paintCrumbs(ctx);
  }
  forgetTreeBelow(state, targetPath);
  say(dom, 'Renamed.');
  refreshTree(ctx, to);
}

// Re-point in place instead of re-reading so unsaved edits and dirty mark survive rename.
function applyFileRename(ctx: FilesCtx, targetPath: string, to: string): void {
  const { state, dom } = ctx;
  state.path = to;
  state.name = fxBase(to);
  state.rel = to.indexOf(state.root + state.sep) === 0 ? to.slice(state.root.length + 1) : '';
  state.dir = fxDirOf(to);
  dom.title.textContent = state.name;
  dom.where.textContent = state.rel || state.path;
  paintCrumbs(ctx);
  const oldDir = fxDirOf(targetPath);
  reloadDir(ctx, oldDir);
  if (state.dir !== oldDir) reloadDir(ctx, state.dir);
  say(dom, state.dirty ? 'Renamed. The unsaved changes are still here.' : 'Renamed.');
}

function renameGo(ctx: FilesCtx): void {
  const { state, dom } = ctx;
  const target = state.rename;
  if (!target) return;
  const name = String(dom.renameName.value || '').trim();
  if (!isValidSegment(name)) {
    say(dom, 'A name is one path segment, with no slash.');
    return;
  }
  const to = fxAbs(fxDirOf(target.path), name, state.sep);
  if (to === target.path) {
    dom.renameRow.hidden = true;
    state.rename = null;
    return;
  }
  const shown = target.dir ? fxBase(target.path) : state.rel || state.name;
  if (!confirm('Rename "' + shown + '" to "' + name + '"?')) return;
  apiPost(ctx, 'rename', { topic: state.topic, from: target.path, to })
    .then((res) => {
      if (!res.ok) {
        say(dom, fileMsg(res, res.body));
        return;
      }
      dom.renameRow.hidden = true;
      state.rename = null;
      if (target.dir) applyDirRename(ctx, target.path, to);
      else applyFileRename(ctx, target.path, to);
    })
    .catch(() => say(dom, 'Could not reach the daemon.'));
}

function deleteGo(ctx: FilesCtx): void {
  const { state, dom } = ctx;
  if (!state.path) return;
  if (!confirm('Delete "' + (state.rel || state.name) + '"? This cannot be undone.')) return;
  const dir = state.dir;
  apiPost(ctx, 'remove', { topic: state.topic, path: state.path })
    .then((res) => {
      if (!res.ok) {
        say(dom, fileMsg(res, res.body));
        return;
      }
      clearOpenFile(state, dom);
      say(dom, res.body.removed === false ? 'It was already gone.' : 'Deleted.');
      reloadDir(ctx, dir);
    })
    .catch(() => say(dom, 'Could not reach the daemon.'));
}

function deleteDir(ctx: FilesCtx, abs: string): void {
  const { state, dom } = ctx;
  const inside = Boolean(state.path) && (state.path === abs || state.path.indexOf(abs + state.sep) === 0);
  if (inside && !confirmLeave(state)) return;
  if (!confirm('Delete the folder "' + fxBase(abs) + '"? Only an empty folder can be deleted, and this cannot be undone.')) {
    return;
  }
  const parent = fxDirOf(abs);
  apiPost(ctx, 'remove', { topic: state.topic, path: abs })
    .then((res) => {
      if (!res.ok) {
        say(dom, fileMsg(res, res.body));
        return;
      }
      if (inside) clearOpenFile(state, dom);
      if (state.dir === abs || state.dir.indexOf(abs + state.sep) === 0) state.dir = parent;
      forgetTreeBelow(state, abs);
      say(dom, res.body.removed === false ? 'It was already gone.' : 'Deleted.');
      reloadDir(ctx, parent);
      paintTree(ctx);
    })
    .catch(() => say(dom, 'Could not reach the daemon.'));
}

function searchGo(ctx: FilesCtx): void {
  const { state, dom, deps } = ctx;
  const q = String(dom.q.value || '').trim();
  if (!q) {
    dom.hits.hidden = true;
    dom.hits.innerHTML = '';
    paintTree(ctx);
    return;
  }
  apiGet(ctx, 'search', { topic: state.topic, q })
    .then((res) => {
      if (!res.ok) {
        say(dom, fileMsg(res, res.body));
        return;
      }
      const hits = (res.body.hits as FilesPanelHit[] | undefined) || [];
      let h =
        '<div class="fx-hit-head">' +
        (hits.length ? (res.body.truncated ? 'First ' : '') + hits.length + ' matches' : 'No matches') +
        '</div>';
      for (const hit of hits) {
        h +=
          '<button type="button" class="fx-row" data-fx-file="' +
          deps.text(hit.path) +
          '">' +
          (hit.dir ? icon('folder') : icon('note')) +
          '<span class="fx-name">' +
          deps.text(hit.rel || hit.path) +
          '</span></button>';
      }
      dom.hits.innerHTML = h;
      dom.hits.hidden = false;
    })
    .catch(() => say(dom, 'Could not reach the daemon.'));
}

function togglePreview(ctx: FilesCtx): void {
  const { state, dom, deps } = ctx;
  if (!state.path || state.kind !== 'text') return;
  if (state.previewing) {
    state.previewing = false;
    dom.preview.hidden = true;
    dom.editor.hidden = false;
    paintActions(state, dom);
    return;
  }
  const seq = ++state.seq;
  apiGet(ctx, 'read', { topic: state.topic, path: state.path, preview: '1' })
    .then((res) => {
      if (seq !== state.seq) return;
      if (!res.ok) {
        say(dom, fileMsg(res, res.body));
        return;
      }
      dom.preview.innerHTML =
        typeof res.body.html === 'string' && res.body.html
          ? '<div class="b">' + res.body.html + '</div>'
          : '<div class="skills-empty">Nothing to render.</div>';
      deps.codeBlocks(dom.preview);
      dom.preview.hidden = false;
      dom.editor.hidden = true;
      state.previewing = true;
      paintActions(state, dom);
    })
    .catch(() => say(dom, 'Could not reach the daemon.'));
}

function openWindow(ctx: FilesCtx, t: string, path?: string, src?: FilesSource | null): void {
  const { state, dom, deps } = ctx;
  if (!(deps.filesOk || src) || !t) return;
  if (!dom.win.hidden && (state.topic !== t || state.src !== (src || null)) && !confirmLeave(state)) return;
  state.topic = t;
  state.src = src || null;
  paintMode(state, dom);
  dom.win.hidden = false;
  dom.win.classList.toggle('tree-open', !path);
  dom.title.textContent = state.src ? state.src.title : 'Files';
  dom.where.textContent = '';
  dom.crumbs.innerHTML = '';
  say(dom, '');
  dom.newRow.hidden = true;
  dom.renameRow.hidden = true;
  state.rename = null;
  dom.conflict.hidden = true;
  dom.preview.hidden = true;
  dom.preview.innerHTML = '';
  dom.eol.hidden = true;
  dom.eol.textContent = '';
  dom.hits.hidden = true;
  dom.hits.innerHTML = '';
  dom.editor.textContent = '';
  state.nodes = {};
  state.openDirs = { '': true };
  state.dir = '';
  state.path = '';
  state.rel = '';
  state.name = '';
  state.kind = '';
  state.base = null;
  state.saved = '';
  state.eol = 'lf';
  state.sha = '';
  state.view = null;
  state.previewing = false;
  setDirty(state, dom, false);
  paintActions(state, dom);
  dom.treeList.innerHTML = '<div class="skills-empty">Loading\u2026</div>';
  apiGet(ctx, 'list', { topic: t, path: '' })
    .then((res) => {
      if (state.topic !== t) return;
      if (!res.ok) {
        dom.treeList.innerHTML = '';
        say(dom, fileMsg(res, res.body));
        return;
      }
      state.root = typeof res.body.path === 'string' ? res.body.path : '';
      state.sep = fxSepOf(state.root);
      state.dir = state.root;
      state.nodes[''] = { path: state.root, entries: (res.body.entries as FilesPanelEntry[] | undefined) || [] };
      dom.where.textContent = state.root;
      paintTree(ctx);
      if (path) openFile(ctx, path);
    })
    .catch(() => say(dom, 'Could not reach the daemon.'));
}

function closeWindow(ctx: FilesCtx): void {
  const { state, dom } = ctx;
  if (dom.win.hidden) return;
  if (!confirmLeave(state)) return;
  dom.win.hidden = true;
  if (state.src) {
    const prev = state.src;
    state.src = null;
    paintMode(state, dom);
    prev.onClose?.();
  }
  dom.win.classList.remove('tree-open');
  state.seq++;
  state.view = null;
  state.path = '';
  state.kind = '';
  state.dirty = false;
  dom.editor.textContent = '';
  dom.preview.textContent = '';
  dom.preview.hidden = true;
  dom.hits.hidden = true;
  dom.hits.innerHTML = '';
  dom.conflict.hidden = true;
  dom.eol.hidden = true;
  dom.eol.textContent = '';
}

function refreshRoot(ctx: FilesCtx): void {
  const { state, dom } = ctx;
  if (!state.root) return;
  state.nodes = {};
  state.openDirs = { '': true };
  state.dir = state.root;
  const want = state.path;
  apiGet(ctx, 'list', { topic: state.topic, path: '' })
    .then((res) => {
      if (!res.ok) {
        say(dom, fileMsg(res, res.body));
        return;
      }
      state.root = typeof res.body.path === 'string' && res.body.path ? res.body.path : state.root;
      state.sep = fxSepOf(state.root);
      state.nodes[''] = { path: state.root, entries: (res.body.entries as FilesPanelEntry[] | undefined) || [] };
      paintTree(ctx);
      if (want) openFile(ctx, want);
    })
    .catch(() => say(dom, 'Could not reach the daemon.'));
}

function bindTreeAndNavEvents(ctx: FilesCtx): void {
  const { dom } = ctx;
  dom.treeToggle.addEventListener('click', () => dom.win.classList.toggle('tree-open'));
  dom.closeBtn.addEventListener('click', () => closeWindow(ctx));
  dom.win.addEventListener('click', (e) => {
    if (e.target === dom.win) closeWindow(ctx);
  });
  dom.refreshBtn.addEventListener('click', () => refreshRoot(ctx));
  dom.treeList.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const renameDir = target.closest('[data-fx-dir-rename]')?.getAttribute('data-fx-dir-rename');
    if (renameDir) {
      ctx.state.rename = { path: renameDir, dir: true };
      showRename(dom, 'Rename folder', fxBase(renameDir));
      return;
    }
    const delDir = target.closest('[data-fx-dir-delete]')?.getAttribute('data-fx-dir-delete');
    if (delDir) {
      deleteDir(ctx, delDir);
      return;
    }
    const dir = target.closest('[data-fx-dir]')?.getAttribute('data-fx-dir');
    if (dir) {
      toggleDir(ctx, dir);
      return;
    }
    const file = target.closest('[data-fx-file]')?.getAttribute('data-fx-file');
    if (file) openFile(ctx, file);
  });
  dom.hits.addEventListener('click', (e) => {
    const file = e.target instanceof Element ? e.target.closest('[data-fx-file]')?.getAttribute('data-fx-file') : null;
    if (file) openFile(ctx, file);
  });
  dom.crumbs.addEventListener('click', (e) => {
    const crumb = e.target instanceof Element ? e.target.closest('[data-fx-crumb]')?.getAttribute('data-fx-crumb') : null;
    if (crumb) revealDir(ctx, crumb);
  });
  dom.qGoBtn.addEventListener('click', () => searchGo(ctx));
  dom.q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchGo(ctx);
    }
  });
}

function bindActionAndConflictEvents(ctx: FilesCtx): void {
  const { state, dom } = ctx;
  dom.newFileBtn.addEventListener('click', () => newStart(ctx, false));
  dom.newDirBtn.addEventListener('click', () => newStart(ctx, true));
  dom.newGoBtn.addEventListener('click', () => newGo(ctx));
  dom.newCancelBtn.addEventListener('click', () => {
    dom.newRow.hidden = true;
  });
  dom.newName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      newGo(ctx);
    }
  });
  dom.saveBtn.addEventListener('click', () => {
    void saveFile(ctx, false);
  });
  dom.previewBtn.addEventListener('click', () => togglePreview(ctx));
  dom.renameBtn.addEventListener('click', () => {
    if (!state.path) return;
    state.rename = { path: state.path, dir: false };
    showRename(dom, 'Rename file', state.name);
  });
  dom.renameGoBtn.addEventListener('click', () => renameGo(ctx));
  dom.renameCancelBtn.addEventListener('click', () => {
    dom.renameRow.hidden = true;
    state.rename = null;
  });
  dom.renameName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      renameGo(ctx);
    }
  });
  dom.deleteBtn.addEventListener('click', () => deleteGo(ctx));
  dom.reloadBtn.addEventListener('click', () => {
    dom.conflict.hidden = true;
    // Keep dirty mark until the read lands so a failed reload still warns on close.
    openFile(ctx, state.path, true);
  });
  dom.overwriteBtn.addEventListener('click', () => {
    dom.conflict.hidden = true;
    void saveFile(ctx, true);
  });
  dom.cancelBtn.addEventListener('click', () => {
    dom.conflict.hidden = true;
    paintActions(state, dom);
  });
}

export function createFilesPanel(deps: FilesPanelDeps): FilesPanel {
  const dom = queryDom();
  const state: FilesState = {
    topic: '',
    root: '',
    dir: '',
    path: '',
    rel: '',
    name: '',
    kind: '',
    base: null,
    saved: '',
    dirty: false,
    view: null,
    seq: 0,
    nodes: {},
    openDirs: {},
    newIsDir: false,
    previewing: false,
    busy: false,
    eol: 'lf',
    sha: '',
    sep: '/',
    src: null,
    rename: null,
  };
  const ctx: FilesCtx = { state, dom, deps };

  const openEditor = (path: string): void => {
    const topic = deps.getTopic();
    if (dom.win.hidden || state.topic !== topic || state.src) openWindow(ctx, topic, path);
    else openFile(ctx, path);
  };

  // Security invariant 9: expose the header button and window.openFileEditor only when files.enabled.
  if (deps.filesOk) {
    dom.toggleBtn.hidden = false;
    window.openFileEditor = openEditor;
    dom.toggleBtn.addEventListener('click', () => {
      deps.closeMenus();
      openWindow(ctx, deps.getTopic());
    });
  }

  if (deps.filesOk || deps.instrOk) {
    bindTreeAndNavEvents(ctx);
    bindActionAndConflictEvents(ctx);
  }

  document.addEventListener('keydown', (e) => {
    if (dom.win.hidden) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      void saveFile(ctx, false);
    }
  });

  return {
    open: (topic, path, src) => openWindow(ctx, topic, path, src),
    openEditor,
    close: () => closeWindow(ctx),
    isOpen: () => !dom.win.hidden,
    isCustomOpen: () => Boolean(state.src) && !dom.win.hidden,
    paintTree: () => paintTree(ctx),
    currentSource: () => state.src,
    previewEl: () => dom.preview,
  };
}
