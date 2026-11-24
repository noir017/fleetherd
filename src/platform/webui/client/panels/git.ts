import type { GitCommitSummary, GitMode, GitStatusFile } from '../../../adapter.js';
import type { CodeViewApi, DiffHandle, DiffSelection } from '../../codeview/app.js';
import { icon } from '../../icons.js';
import { t } from '../i18n/index.js';

export interface GitCustomSource {
  title?: string;
  statusUrl: string;
  fileUrl: string;
}

export type GitPanelMode = GitMode | 'commits';

export interface GitPanelDeps {
  getTopic: () => string;
  input: HTMLTextAreaElement;
  text: (s: unknown) => string;
  schedAgo: (at: number) => string;
  narrow: () => boolean;
  codeView: () => Promise<CodeViewApi | null>;
  closeMenus: () => void;
}

export interface GitPanel {
  open: (source?: GitCustomSource) => void;
  close: () => void;
  isOpen: () => boolean;
  onTurnEnd: () => void;
  repaint: () => void;
}

declare global {
  interface Window {
    openGitWindow?: (source?: GitCustomSource) => void;
    openFileEditor?: (path: string) => void;
  }
}

interface GitRepoInfo {
  root: string;
  branch?: string;
  base?: string;
}

interface GitCommitDetail extends GitCommitSummary {
  body?: string;
}

interface GitErrorPayload {
  ok?: boolean;
  reason?: string;
  text?: string;
  error?: string;
}

interface GitStatusPayload extends GitErrorPayload {
  repo?: GitRepoInfo;
  files?: GitStatusFile[];
  truncated?: boolean;
}

interface GitBranchesPayload extends GitErrorPayload {
  branches?: string[];
  base?: string;
}

interface GitLogPayload extends GitErrorPayload {
  repo?: GitRepoInfo;
  commits?: GitCommitSummary[];
  more?: boolean;
}

interface GitCommitPayload extends GitErrorPayload {
  repo?: GitRepoInfo;
  commit?: GitCommitDetail;
  files?: GitStatusFile[];
  truncated?: boolean;
}

interface GitFilePayload extends GitErrorPayload {
  path?: string;
  original?: string;
  modified?: string;
  patch?: string;
  binary?: boolean;
  tooLarge?: boolean;
  patchTooLarge?: boolean;
}

interface GitDom {
  win: HTMLElement;
  title: HTMLElement;
  branch: HTMLElement;
  modes: HTMLElement;
  base: HTMLSelectElement;
  files: HTMLElement;
  diff: HTMLElement;
  note: HTMLElement;
  sel: HTMLElement;
  selWhat: HTMLElement;
  comment: HTMLElement;
  commentWhat: HTMLElement;
  commentText: HTMLTextAreaElement;
  layoutBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
  toggleBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  commentOpenBtn: HTMLButtonElement;
  commentAddBtn: HTMLButtonElement;
  commentCancelBtn: HTMLButtonElement;
}

interface GitState {
  source: GitCustomSource | null;
  mode: GitPanelMode;
  base: string;
  root: string;
  repo: GitRepoInfo | null;
  files: GitStatusFile[];
  path: string;
  sel: DiffSelection | null;
  branchError: string;
  statusSeq: number;
  fileSeq: number;
  view: DiffHandle | null;
  kind: '' | 'code' | 'text';
  sides: { old: string; new: string } | null;
  commits: GitCommitSummary[];
  commitMore: boolean;
  commit: GitCommitDetail | null;
  commitFiles: GitStatusFile[];
  bodyOpen: boolean;
  logSeq: number;
  commitSeq: number;
  pick: boolean;
  loading: boolean;
  notGit: boolean;
  // Separate from notGit (cleared by Commits) and branchError (non-repo failures) so a later status refreshes stale branches.
  branchStale: boolean;
  layout: 'unified' | 'split';
}

interface GitCtx {
  state: GitState;
  dom: GitDom;
  deps: GitPanelDeps;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing element #' + id);
  return el as T;
}

function queryDom(): GitDom {
  return {
    win: byId('git'),
    title: byId('git-title'),
    branch: byId('git-branch'),
    modes: byId('git-modes'),
    base: byId<HTMLSelectElement>('git-base'),
    files: byId('git-files'),
    diff: byId('git-diff'),
    note: byId('git-note'),
    sel: byId('git-sel'),
    selWhat: byId('git-sel-what'),
    comment: byId('git-comment'),
    commentWhat: byId('git-comment-what'),
    commentText: byId<HTMLTextAreaElement>('git-comment-text'),
    layoutBtn: byId<HTMLButtonElement>('git-layout'),
    refreshBtn: byId<HTMLButtonElement>('git-refresh'),
    toggleBtn: byId<HTMLButtonElement>('git-toggle'),
    closeBtn: byId<HTMLButtonElement>('git-close'),
    commentOpenBtn: byId<HTMLButtonElement>('git-comment-open'),
    commentAddBtn: byId<HTMLButtonElement>('git-comment-add'),
    commentCancelBtn: byId<HTMLButtonElement>('git-comment-cancel'),
  };
}

function isNoRepo(d: GitErrorPayload | null): boolean {
  return Boolean(d && (d.reason === 'not-git' || d.reason === 'missing'));
}

function fetchJson<T>(url: string): Promise<{ ok: boolean; d: T | null }> {
  return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then((r) =>
    r.json().then(
      (d: T) => ({ ok: r.ok, d }),
      () => ({ ok: false, d: null })
    )
  );
}

function commitTag(state: GitState): string {
  const c = state.commit;
  if (!c) return '';
  return c.short || String(c.sha || '').slice(0, 7);
}

function baseParam(state: GitState): string {
  // Working and commits never use a base; omit it so a stale picker value cannot hit the daemon's check.
  return state.mode !== 'working' && state.base ? '&base=' + encodeURIComponent(state.base) : '';
}

function statusUrl(state: GitState, topic: string): string {
  if (state.source) return state.source.statusUrl;
  return 'api/git/status?t=' + encodeURIComponent(topic) + '&mode=' + encodeURIComponent(state.mode) + baseParam(state);
}

function fileUrl(state: GitState, topic: string, path: string): string {
  if (state.source) return state.source.fileUrl + '&path=' + encodeURIComponent(path);
  // Read a file opened inside a commit from that commit, never the working tree.
  if (state.commit) {
    return (
      'api/git/commit-file?t=' +
      encodeURIComponent(topic) +
      '&sha=' +
      encodeURIComponent(state.commit.sha) +
      '&path=' +
      encodeURIComponent(path)
    );
  }
  return (
    'api/git/file?t=' +
    encodeURIComponent(topic) +
    '&mode=' +
    encodeURIComponent(state.mode) +
    baseParam(state) +
    '&path=' +
    encodeURIComponent(path)
  );
}

function setNote(dom: GitDom, message: string, bad: boolean): void {
  dom.note.hidden = !message;
  dom.note.className = bad ? 'bad' : '';
  dom.note.textContent = message || '';
}

function destroyView(state: GitState): void {
  if (state.view && typeof state.view.destroy === 'function') {
    try {
      state.view.destroy();
    } catch {
      // ignore teardown errors from a replaced editor
    }
  }
  state.view = null;
  state.kind = '';
}

function hideComment(dom: GitDom): void {
  dom.comment.hidden = true;
  dom.commentText.value = '';
}

function clearSelection(state: GitState, dom: GitDom): void {
  state.sel = null;
  dom.sel.hidden = true;
}

function clearDiffPane(state: GitState, dom: GitDom): void {
  state.fileSeq += 1;
  state.loading = false;
  clearSelection(state, dom);
  hideComment(dom);
  destroyView(state);
}

function paintBase(state: GitState, dom: GitDom, base?: string): void {
  if (state.source || state.mode === 'working' || state.mode === 'commits') {
    dom.base.hidden = true;
    return;
  }
  if (base && !state.base) state.base = base;
  if (!state.base && dom.base.options.length) {
    state.base = dom.base.value || dom.base.options[0]?.value || '';
  }
  if (state.base) dom.base.value = state.base;
  dom.base.hidden = dom.base.options.length === 0;
}

function renderBlank(
  dom: GitDom,
  text: (s: unknown) => string,
  title: string,
  sub?: string,
  act?: string,
  actLabel?: string
): void {
  dom.layoutBtn.hidden = true;
  dom.diff.innerHTML =
    '<div class="git-blank"><div class="gb-title">' +
    text(title) +
    '</div>' +
    (sub ? '<div class="gb-sub">' + text(sub) + '</div>' : '') +
    (act ? '<button type="button" data-gact="' + text(act) + '">' + text(actLabel || act) + '</button>' : '') +
    '</div>';
}

function renderBlankNoRepo(dom: GitDom, text: (s: unknown) => string, d: GitErrorPayload): void {
  if (d.reason === 'missing') {
    renderBlank(dom, text, t('git.dirNotFound'), d.text || t('git.dirNotFoundSub'));
  } else {
    renderBlank(dom, text, t('git.notGit'), d.text || t('git.notGitSub'));
  }
}

function paintNoChanges(ctx: GitCtx): void {
  const { state, dom, deps } = ctx;
  if (state.source) {
    renderBlank(dom, deps.text, t('git.noChangesTurn'), '');
    return;
  }
  const base = state.base || t('git.baseBranchFallback');
  if (state.mode === 'working') {
    renderBlank(dom, deps.text, t('git.noChanges'), t('git.noChangesWorkingSub'), 'commits', t('git.seeCommits'));
  } else if (state.mode === 'branch') {
    renderBlank(
      dom,
      deps.text,
      t('git.noChangesBranch', { base }),
      t('git.noChangesBranchSub', { base }),
      'commits',
      t('git.seeCommits')
    );
  } else {
    renderBlank(
      dom,
      deps.text,
      t('git.noChangesCommitted', { base }),
      t('git.noChangesCommittedSub', { base }),
      'commits',
      t('git.seeCommits')
    );
  }
}

function renderFileRow(state: GitState, f: GitStatusFile, withEdit: boolean, text: (s: unknown) => string): string {
  const letter = f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M';
  const stat = f.binary
    ? '<span class="gf-del">bin</span>'
    : f.statsUnknown
      ? '<span class="gf-nostat" title="' + text(t('git.countsNotReadTitle')) + '">' + text(t('git.countsNotRead')) + '</span>'
      : '<span class="gf-add">+' + f.additions + '</span> <span class="gf-del">\u2212' + f.deletions + '</span>';
  const abs = state.root
    ? (state.root.charAt(state.root.length - 1) === '/' ? state.root : state.root + '/') + f.path
    : f.path;
  // Offer Edit only when the file window is enabled (window.openFileEditor is assigned only when FILES_OK).
  const edit =
    withEdit && typeof window.openFileEditor === 'function'
      ? '<button type="button" class="gf-edit" data-gedit="' +
        text(abs) +
        '" title="' +
        text(t('git.editFileTitle')) +
        '">' +
        text(t('common.edit')) +
        '</button>'
      : '';
  return (
    '<div class="git-file' +
    (f.path === state.path ? ' on' : '') +
    '" data-gpath="' +
    text(f.path) +
    '" role="button" tabindex="0">' +
    '<span class="gf-status ' +
    f.status +
    '">' +
    letter +
    '</span>' +
    '<span class="gf-path" title="' +
    text(f.path) +
    '">' +
    text(f.path) +
    '</span>' +
    '<span class="gf-stat">' +
    stat +
    '</span>' +
    edit +
    '</div>'
  );
}

function renderCommitRow(state: GitState, c: GitCommitSummary, deps: Pick<GitPanelDeps, 'text' | 'schedAgo'>): string {
  const sha = c.sha || '';
  const on = Boolean(state.commit && state.commit.sha === sha);
  return (
    '<div class="git-commit' +
    (on ? ' on' : '') +
    '" data-gsha="' +
    deps.text(sha) +
    '" role="button" tabindex="0" title="' +
    deps.text(c.subject || '') +
    '">' +
    '<span class="gc-subject">' +
    deps.text(c.subject || '') +
    '</span>' +
    '<span class="gc-meta"><span class="gc-sha">' +
    deps.text(c.short || sha.slice(0, 7)) +
    '</span>' +
    '<span class="gc-author">' +
    deps.text(c.author || '') +
    '</span>' +
    '<span class="gc-when">' +
    deps.text(deps.schedAgo(c.at)) +
    '</span></span></div>'
  );
}

function paintCommits(ctx: GitCtx): void {
  const { state, dom, deps } = ctx;
  if (!state.commits.length) {
    dom.files.innerHTML = '';
    return;
  }
  let html = '';
  for (const c of state.commits) html += renderCommitRow(state, c, deps);
  // Paged by skip (no cursor in contract); a new commit between pages may repeat a row until refresh.
  if (state.commitMore) html += '<button type="button" class="git-more" data-gmore>' + deps.text(t('git.loadMore')) + '</button>';
  dom.files.innerHTML = html;
}

function paintCommit(ctx: GitCtx): void {
  const { state, dom, deps } = ctx;
  const c = state.commit;
  if (!c) {
    paintCommits(ctx);
    return;
  }
  let html =
    '<div class="git-back" data-gback role="button" tabindex="0">' +
    icon('chevronLeft') +
    '<span>' + deps.text(t('git.modeCommits')) + '</span></div>' +
    '<div class="git-commit-head">' +
    '<div class="gch-subject">' +
    deps.text(c.subject || '') +
    '</div>' +
    '<div class="gch-meta"><span class="gch-sha">' +
    deps.text(commitTag(state)) +
    '</span>' +
    '<span>' +
    deps.text(c.author || '') +
    '</span><span>' +
    deps.text(deps.schedAgo(c.at)) +
    '</span></div>';
  if (c.body) {
    html +=
      '<button type="button" class="gch-toggle" data-gbody>' +
      deps.text(state.bodyOpen ? t('git.hideDetails') : t('git.showDetails')) +
      '</button>' +
      '<pre class="gch-body"' +
      (state.bodyOpen ? '' : ' hidden') +
      '>' +
      deps.text(c.body) +
      '</pre>';
  }
  html += '</div>';
  for (const f of state.commitFiles) html += renderFileRow(state, f, false, deps.text);
  dom.files.innerHTML = html;
}

function paintFiles(ctx: GitCtx): void {
  let html = '';
  for (const f of ctx.state.files) html += renderFileRow(ctx.state, f, true, ctx.deps.text);
  ctx.dom.files.innerHTML = html;
}

function paintList(ctx: GitCtx): void {
  if (ctx.state.commit) paintCommit(ctx);
  else if (ctx.state.mode === 'commits') paintCommits(ctx);
  else paintFiles(ctx);
}

function paintPatch(patch: string, text: (s: unknown) => string): string {
  const lines = String(patch || '').split('\n');
  let out = '';
  for (const line of lines) {
    const cls =
      line.charAt(0) === '+' && line.slice(0, 3) !== '+++'
        ? 'pa'
        : line.charAt(0) === '-' && line.slice(0, 3) !== '---'
          ? 'pd'
          : line.slice(0, 2) === '@@'
            ? 'ph'
            : '';
    out += cls ? '<span class="' + cls + '">' + text(line) + '</span>\n' : text(line) + '\n';
  }
  return out;
}

function buildCommentBlock(state: GitState, commentText: string): string {
  const sel = state.sel;
  if (!sel) return '';
  const from = Math.min(sel.from, sel.to);
  const to = Math.max(sel.from, sel.to);
  const doc = state.sides ? state.sides[sel.side === 'old' ? 'old' : 'new'] : null;
  const quoted = typeof doc === 'string' ? doc.split('\n').slice(from - 1, to).join('\n') : String(sel.text);
  let fence = String.fromCharCode(96, 96, 96);
  while (quoted.indexOf(fence) >= 0) fence += String.fromCharCode(96);
  const tag = commitTag(state);
  return (
    state.path +
    ':L' +
    from +
    (to !== from ? '-L' + to : '') +
    (sel.side === 'old' ? ' (old' : ' (new') +
    (tag ? ', ' + tag : '') +
    ')\n' +
    fence +
    '\n' +
    quoted.replace(/\s+$/, '') +
    '\n' +
    fence +
    '\n' +
    commentText.trim()
  );
}

function insertMessage(input: HTMLTextAreaElement, s: string): void {
  const cur = input.value.replace(/\s+$/, '');
  input.value = (cur ? cur + '\n\n' : '') + s;
  // Programmatic assignment fires no input event; dispatch it so the composer grows and refreshes hints.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

function onSelect(ctx: GitCtx, sel: DiffSelection | null): void {
  ctx.state.sel = sel || null;
  if (!sel) {
    ctx.dom.sel.hidden = true;
    return;
  }
  const from = Math.min(sel.from, sel.to);
  const to = Math.max(sel.from, sel.to);
  const range = from + (to !== from ? '\u2013' + to : '');
  ctx.dom.selWhat.textContent = t('git.selLines', {
    side: sel.side === 'old' ? t('git.sideOriginal') : t('git.sideNew'),
    range,
  });
  ctx.dom.sel.hidden = false;
  hideComment(ctx.dom);
}

function renderDiff(ctx: GitCtx, d: GitFilePayload, mine: number): void {
  const { state, dom, deps } = ctx;
  dom.diff.innerHTML = '';
  deps.codeView().then(
    (cv) => {
      if (mine !== state.fileSeq) return;
      if (cv && typeof cv.diff === 'function') {
        state.kind = 'code';
        state.sides = { old: String(d.original || ''), new: String(d.modified || '') };
        state.view = cv.diff(dom.diff, {
          name: d.path || state.path,
          original: d.original || '',
          modified: d.modified || '',
          layout: state.layout,
          onSelect: (sel) => onSelect(ctx, sel),
        });
        dom.layoutBtn.hidden = false;
        dom.layoutBtn.textContent = state.layout === 'split' ? t('git.unified') : t('git.split');
      } else {
        state.kind = 'text';
        state.view = null;
        dom.diff.innerHTML = d.patch
          ? '<pre class="git-patch">' + paintPatch(d.patch, deps.text) + '</pre>'
          : '<div class="git-empty">' + deps.text(t('git.noTextDiff')) + '</div>';
        dom.layoutBtn.hidden = true;
      }
    },
    () => {
      if (mine !== state.fileSeq) return;
      state.kind = 'text';
      dom.diff.innerHTML = '<pre class="git-patch">' + paintPatch(d.patch || '', deps.text) + '</pre>';
      dom.layoutBtn.hidden = true;
    }
  );
}

function openFile(ctx: GitCtx, path: string): void {
  const { state, dom, deps } = ctx;
  if (path === state.path && state.loading) return;
  state.pick = false;
  state.path = path;
  clearSelection(state, dom);
  hideComment(dom);
  destroyView(state);
  paintList(ctx);
  dom.diff.innerHTML = '<div class="git-empty">' + deps.text(t('common.loading')) + '</div>';
  dom.layoutBtn.hidden = true;
  const mine = ++state.fileSeq;
  state.loading = true;
  fetchJson<GitFilePayload>(fileUrl(state, deps.getTopic(), path))
    .then((res) => {
      if (mine !== state.fileSeq) return;
      state.loading = false;
      const d = res.d;
      if (!res.ok || !d || !d.ok) {
        dom.diff.innerHTML =
          '<div class="git-empty">' + deps.text((d && (d.text || d.error)) || t('git.readFileFailed')) + '</div>';
        return;
      }
      if (d.tooLarge) {
        dom.diff.innerHTML =
          '<div class="git-empty">' +
          deps.text(d.patchTooLarge ? t('git.patchTooLarge') : t('git.fileTooLarge')) +
          '</div>';
        return;
      }
      if (d.binary) {
        dom.diff.innerHTML = '<div class="git-empty">' + deps.text(t('git.binaryFile')) + '</div>';
        return;
      }
      renderDiff(ctx, d, mine);
    })
    .catch(() => {
      if (mine !== state.fileSeq) return;
      state.loading = false;
      dom.diff.innerHTML = '<div class="git-empty">' + deps.text(t('common.reachServerError')) + '</div>';
    });
}

function autoOpen(ctx: GitCtx, list: readonly GitStatusFile[]): void {
  if (ctx.state.path || !list.length) return;
  const shouldOpen = ctx.state.pick && !ctx.deps.narrow();
  ctx.state.pick = false;
  const first = list[0];
  if (shouldOpen && first) openFile(ctx, first.path);
  else renderBlank(ctx.dom, ctx.deps.text, t('git.selectFile'));
}

function loadBranches(ctx: GitCtx): void {
  const { state, dom, deps } = ctx;
  if (state.source) return;
  fetch('api/git/branches?t=' + encodeURIComponent(deps.getTopic()), {
    credentials: 'same-origin',
    cache: 'no-store',
  })
    .then((r) => r.json() as Promise<GitBranchesPayload | null>)
    .then((d) => {
      if (!d || !d.ok) {
        state.branchError = (d && d.text) || t('git.readBranchesFailed');
        state.branchStale = isNoRepo(d);
        if (!state.notGit) setNote(dom, state.branchError, true);
        return;
      }
      const was = state.branchError;
      state.branchError = '';
      state.branchStale = false;
      if (was && dom.note.textContent === was) setNote(dom, '', false);
      const list = d.branches || [];
      if (!list.length) return;
      dom.base.innerHTML = '';
      for (const name of list) {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        dom.base.appendChild(o);
      }
      const had = state.base;
      if (!state.base) state.base = d.base || list[0] || '';
      paintBase(state, dom, d.base);
      if (!had && state.base && (state.mode === 'branch' || state.mode === 'committed')) loadStatus(ctx);
    })
    .catch(() => {
      state.branchError = t('git.readBranchesFailed');
      if (!state.notGit) setNote(dom, state.branchError, true);
    });
}

function handleStatusFailure(ctx: GitCtx, d: GitStatusPayload | null): void {
  const { state, dom, deps } = ctx;
  state.repo = null;
  state.root = '';
  state.files = [];
  state.path = '';
  clearDiffPane(state, dom);
  dom.files.innerHTML = '';
  dom.branch.textContent = '';
  dom.diff.textContent = '';
  dom.layoutBtn.hidden = true;
  if (d && isNoRepo(d)) {
    state.notGit = true;
    setNote(dom, '', false);
    renderBlankNoRepo(dom, deps.text, d);
    return;
  }
  state.notGit = false;
  setNote(dom, (d && (d.text || d.error)) || t('git.readChangesFailed'), true);
}

function applyStatusResult(ctx: GitCtx, d: GitStatusPayload): void {
  const { state, dom, deps } = ctx;
  state.notGit = false;
  state.repo = d.repo || null;
  state.root = (d.repo && d.repo.root) || '';
  state.files = d.files || [];
  dom.branch.textContent = (d.repo && d.repo.branch) || '';
  paintBase(state, dom, d.repo?.base);
  if (state.branchStale) {
    state.branchError = '';
    loadBranches(ctx);
  }
  paintFiles(ctx);
  if (d.truncated) {
    setNote(dom, t('git.tooManyChanges'), true);
    if (!state.files.length) {
      renderBlank(dom, deps.text, t('git.incompleteList'), t('git.incompleteListSub'));
    }
  } else {
    setNote(dom, state.branchError, Boolean(state.branchError));
    if (!state.files.length) paintNoChanges(ctx);
  }
  if (state.path && !state.files.some((f) => f.path === state.path)) {
    state.path = '';
    clearDiffPane(state, dom);
    dom.diff.innerHTML = '<div class="git-empty">' + deps.text(t('git.fileGone')) + '</div>';
    dom.layoutBtn.hidden = true;
  } else {
    autoOpen(ctx, state.files);
  }
}

function loadStatus(ctx: GitCtx): void {
  const mine = ++ctx.state.statusSeq;
  ctx.dom.refreshBtn.disabled = true;
  fetchJson<GitStatusPayload>(statusUrl(ctx.state, ctx.deps.getTopic()))
    .then((res) => {
      if (mine !== ctx.state.statusSeq) return;
      ctx.dom.refreshBtn.disabled = false;
      if (!res.ok || !res.d || !res.d.ok) {
        handleStatusFailure(ctx, res.d);
        return;
      }
      applyStatusResult(ctx, res.d);
    })
    .catch(() => {
      if (mine !== ctx.state.statusSeq) return;
      ctx.dom.refreshBtn.disabled = false;
      setNote(ctx.dom, t('common.reachServerError'), true);
    });
}

function handleLogNoRepo(ctx: GitCtx, d: GitLogPayload): void {
  const { state, dom, deps } = ctx;
  state.notGit = true;
  state.commits = [];
  state.commitMore = false;
  state.repo = null;
  state.root = '';
  dom.branch.textContent = '';
  state.commit = null;
  state.commitFiles = [];
  clearDiffPane(state, dom);
  paintCommits(ctx);
  setNote(dom, '', false);
  renderBlankNoRepo(dom, deps.text, d);
}

function applyLogResult(ctx: GitCtx, d: GitLogPayload, more: boolean): void {
  const { state, dom, deps } = ctx;
  state.notGit = false;
  if (!more) state.commits = [];
  for (const c of d.commits || []) state.commits.push(c);
  state.commitMore = Boolean(d.more);
  if (d.repo) {
    state.repo = d.repo;
    state.root = d.repo.root || '';
    dom.branch.textContent = d.repo.branch || '';
  }
  if (!state.commit) {
    setNote(dom, '', false);
    paintCommits(ctx);
    if (!state.commits.length) {
      renderBlank(dom, deps.text, t('git.noCommits'), t('git.noCommitsSub'));
    }
  }
}

function loadLog(ctx: GitCtx, more: boolean): void {
  const { state, dom, deps } = ctx;
  if (state.source || state.mode !== 'commits') return;
  const skip = more ? state.commits.length : 0;
  const mine = ++state.logSeq;
  dom.refreshBtn.disabled = true;
  const moreBtn = dom.files.querySelector<HTMLButtonElement>('[data-gmore]');
  if (moreBtn) moreBtn.disabled = true;
  const url = 'api/git/log?t=' + encodeURIComponent(deps.getTopic()) + '&skip=' + skip;
  fetchJson<GitLogPayload>(url)
    .then((res) => {
      if (mine !== state.logSeq) return;
      dom.refreshBtn.disabled = false;
      if (moreBtn) moreBtn.disabled = false;
      const d = res.d;
      if (!res.ok || !d || !d.ok) {
        if (d && isNoRepo(d)) {
          handleLogNoRepo(ctx, d);
          return;
        }
        setNote(
          dom,
          (d && (d.text || d.error)) || (more ? t('git.readMoreCommitsFailed') : t('git.readCommitsFailed')),
          true
        );
        if (!state.commit) paintCommits(ctx);
        return;
      }
      applyLogResult(ctx, d, more);
    })
    .catch(() => {
      if (mine !== state.logSeq) return;
      dom.refreshBtn.disabled = false;
      if (moreBtn) moreBtn.disabled = false;
      setNote(dom, t('common.reachServerError'), true);
    });
}

function openCommit(ctx: GitCtx, sha: string): void {
  const { state, dom, deps } = ctx;
  const known = state.commits.find((c) => c.sha === sha) || null;
  state.commit = known || { sha, short: String(sha).slice(0, 7), subject: '', author: '', at: 0, parents: 0 };
  state.commitFiles = [];
  state.path = '';
  state.bodyOpen = false;
  state.pick = true;
  clearDiffPane(state, dom);
  paintCommit(ctx);
  setNote(dom, '', false);
  dom.diff.innerHTML = '<div class="git-empty">' + deps.text(t('common.loading')) + '</div>';
  dom.layoutBtn.hidden = true;
  const mine = ++state.commitSeq;
  const url = 'api/git/commit?t=' + encodeURIComponent(deps.getTopic()) + '&sha=' + encodeURIComponent(sha);
  fetchJson<GitCommitPayload>(url)
    .then((res) => {
      if (mine !== state.commitSeq) return;
      const d = res.d;
      if (!res.ok || !d || !d.ok) {
        state.commitFiles = [];
        paintCommit(ctx);
        setNote(dom, (d && (d.text || d.error)) || t('git.readCommitFailed'), true);
        dom.diff.textContent = '';
        return;
      }
      state.commit = d.commit || state.commit;
      state.commitFiles = d.files || [];
      state.root = (d.repo && d.repo.root) || state.root;
      paintCommit(ctx);
      setNote(dom, d.truncated ? t('git.tooManyCommitFiles') : '', Boolean(d.truncated));
      if (!state.commitFiles.length) {
        renderBlank(dom, deps.text, t('git.commitNoFiles'), '');
        return;
      }
      autoOpen(ctx, state.commitFiles);
    })
    .catch(() => {
      if (mine !== state.commitSeq) return;
      setNote(dom, t('common.reachServerError'), true);
    });
}

function backToCommits(ctx: GitCtx): void {
  ctx.state.commit = null;
  ctx.state.commitFiles = [];
  ctx.state.path = '';
  ctx.state.commitSeq += 1;
  clearDiffPane(ctx.state, ctx.dom);
  paintCommits(ctx);
  setNote(ctx.dom, '', false);
  renderBlank(ctx.dom, ctx.deps.text, t('git.pickCommit'), t('git.pickCommitSub'));
}

function setMode(ctx: GitCtx, mode: GitPanelMode): void {
  const { state, dom, deps } = ctx;
  if (state.source || mode === state.mode) return;
  state.mode = mode;
  state.path = '';
  state.commit = null;
  state.commitFiles = [];
  state.commits = [];
  state.commitMore = false;
  state.bodyOpen = false;
  // Bump all four sequences so in-flight responses from the previous view cannot paint into the new mode.
  state.statusSeq += 1;
  state.logSeq += 1;
  state.commitSeq += 1;
  clearDiffPane(state, dom);
  dom.diff.innerHTML = '';
  dom.layoutBtn.hidden = true;
  setNote(dom, '', false);
  dom.base.hidden = mode === 'working' || mode === 'commits';
  for (const el of dom.modes.querySelectorAll('[data-gm]')) {
    el.classList.toggle('on', el.getAttribute('data-gm') === mode);
  }
  state.pick = true;
  if (mode === 'commits') {
    dom.files.innerHTML = '<div class="git-empty">' + deps.text(t('common.loading')) + '</div>';
    renderBlank(dom, deps.text, t('git.pickCommit'), t('git.pickCommitSub'));
    loadLog(ctx, false);
  } else {
    loadStatus(ctx);
  }
}

function openWindow(ctx: GitCtx, source?: GitCustomSource): void {
  const { state, dom } = ctx;
  state.source = source || null;
  state.mode = 'working';
  state.base = '';
  state.root = '';
  state.branchError = '';
  state.branchStale = false;
  state.repo = null;
  state.files = [];
  state.path = '';
  state.commits = [];
  state.commit = null;
  state.commitFiles = [];
  state.commitMore = false;
  state.bodyOpen = false;
  state.notGit = false;
  state.pick = !source;
  state.statusSeq += 1;
  state.logSeq += 1;
  state.commitSeq += 1;
  clearDiffPane(state, dom);
  setNote(dom, '', false);
  dom.modes.hidden = Boolean(state.source);
  dom.base.hidden = true;
  dom.base.innerHTML = '';
  dom.title.textContent = state.source ? state.source.title || t('git.title') : t('git.title');
  dom.branch.textContent = '';
  dom.files.innerHTML = '<div class="git-empty">' + ctx.deps.text(t('common.loading')) + '</div>';
  dom.diff.innerHTML = '';
  dom.layoutBtn.hidden = true;
  for (const el of dom.modes.querySelectorAll('[data-gm]')) {
    el.classList.toggle('on', el.getAttribute('data-gm') === 'working');
  }
  dom.win.hidden = false;
  if (!state.source) loadBranches(ctx);
  loadStatus(ctx);
  dom.closeBtn.focus();
}

function closeWindow(ctx: GitCtx): void {
  const { state, dom } = ctx;
  if (dom.win.hidden) return;
  dom.win.hidden = true;
  state.statusSeq += 1;
  state.logSeq += 1;
  state.commitSeq += 1;
  state.pick = false;
  state.commit = null;
  state.commitFiles = [];
  state.commits = [];
  clearDiffPane(state, dom);
  dom.diff.textContent = '';
  dom.files.textContent = '';
  state.files = [];
  state.path = '';
}

function isGitPanelMode(value: string | null): value is GitPanelMode {
  return value === 'working' || value === 'branch' || value === 'committed' || value === 'commits';
}

function bindFileListEvents(ctx: GitCtx): void {
  const { state, dom } = ctx;
  dom.files.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const edit = target.closest('[data-gedit]');
    if (edit) {
      const p = edit.getAttribute('data-gedit');
      if (p !== null && typeof window.openFileEditor === 'function') window.openFileEditor(p);
      return;
    }
    if (target.closest('[data-gback]')) {
      backToCommits(ctx);
      return;
    }
    if (target.closest('[data-gmore]')) {
      loadLog(ctx, true);
      return;
    }
    const body = target.closest<HTMLElement>('[data-gbody]');
    if (body) {
      state.bodyOpen = !state.bodyOpen;
      const pre = body.parentElement?.querySelector<HTMLElement>('.gch-body');
      if (pre) pre.hidden = !state.bodyOpen;
      body.textContent = state.bodyOpen ? t('git.hideDetails') : t('git.showDetails');
      return;
    }
    const sha = target.closest('[data-gsha]')?.getAttribute('data-gsha');
    if (sha) {
      openCommit(ctx, sha);
      return;
    }
    const path = target.closest('[data-gpath]')?.getAttribute('data-gpath');
    if (path) openFile(ctx, path);
  });

  dom.files.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    // Keep Enter/Space on inner buttons (Edit, Load more, details) from also activating the row.
    if (target.closest('[data-gedit]') || target.closest('[data-gmore]') || target.closest('[data-gbody]')) return;
    const sha = target.closest('[data-gsha]')?.getAttribute('data-gsha');
    if (sha) {
      e.preventDefault();
      openCommit(ctx, sha);
      return;
    }
    if (target.closest('[data-gback]')) {
      e.preventDefault();
      backToCommits(ctx);
      return;
    }
    const path = target.closest('[data-gpath]')?.getAttribute('data-gpath');
    if (path) {
      e.preventDefault();
      openFile(ctx, path);
    }
  });
}

function bindControlEvents(ctx: GitCtx): void {
  const { state, dom, deps } = ctx;
  dom.toggleBtn.addEventListener('click', () => {
    deps.closeMenus();
    openWindow(ctx);
  });
  dom.closeBtn.addEventListener('click', () => closeWindow(ctx));
  dom.win.addEventListener('click', (e) => {
    if (e.target === dom.win) closeWindow(ctx);
  });
  dom.refreshBtn.addEventListener('click', () => {
    if (state.mode === 'commits' && !state.source) loadLog(ctx, false);
    else loadStatus(ctx);
  });
  dom.layoutBtn.addEventListener('click', () => {
    state.layout = state.layout === 'split' ? 'unified' : 'split';
    dom.layoutBtn.textContent = state.layout === 'split' ? t('git.unified') : t('git.split');
    if (state.view && typeof state.view.setLayout === 'function') state.view.setLayout(state.layout);
  });
  dom.base.addEventListener('change', () => {
    state.base = dom.base.value || '';
    state.path = '';
    state.pick = false;
    clearDiffPane(state, dom);
    dom.diff.innerHTML = '';
    loadStatus(ctx);
  });
  dom.modes.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-gm]') : null;
    const mode = btn ? btn.getAttribute('data-gm') : null;
    if (isGitPanelMode(mode)) setMode(ctx, mode);
  });
  dom.diff.addEventListener('click', (e) => {
    const act = e.target instanceof Element ? e.target.closest('[data-gact]') : null;
    if (act && act.getAttribute('data-gact') === 'commits') setMode(ctx, 'commits');
  });
  dom.commentOpenBtn.addEventListener('click', () => {
    if (!state.sel) return;
    const from = Math.min(state.sel.from, state.sel.to);
    const to = Math.max(state.sel.from, state.sel.to);
    const tag = commitTag(state);
    dom.commentWhat.textContent =
      state.path +
      ':L' +
      from +
      (to !== from ? '-L' + to : '') +
      (state.sel.side === 'old' ? t('git.oldSide') : t('git.newSide')) +
      (tag ? ' \u00b7 ' + tag : '');
    dom.comment.hidden = false;
    dom.commentText.value = '';
    dom.commentText.focus();
  });
  dom.commentAddBtn.addEventListener('click', () => {
    if (!state.sel) return;
    if (!dom.commentText.value.trim()) {
      dom.commentText.focus();
      return;
    }
    insertMessage(deps.input, buildCommentBlock(state, dom.commentText.value));
    hideComment(dom);
    clearSelection(state, dom);
    setNote(dom, t('git.addedToMessage'), false);
  });
  dom.commentCancelBtn.addEventListener('click', () => hideComment(dom));
}

export function createGitPanel(deps: GitPanelDeps): GitPanel {
  const dom = queryDom();
  const state: GitState = {
    source: null,
    mode: 'working',
    base: '',
    root: '',
    repo: null,
    files: [],
    path: '',
    sel: null,
    branchError: '',
    statusSeq: 0,
    fileSeq: 0,
    view: null,
    kind: '',
    sides: null,
    commits: [],
    commitMore: false,
    commit: null,
    commitFiles: [],
    bodyOpen: false,
    logSeq: 0,
    commitSeq: 0,
    pick: false,
    loading: false,
    notGit: false,
    branchStale: false,
    layout: window.innerWidth < 900 ? 'unified' : 'split',
  };
  const ctx: GitCtx = { state, dom, deps };

  const open = (source?: GitCustomSource): void => openWindow(ctx, source);
  // Cross-file contract: turn-changes view in features/topic/transcript/markup.ts checks and calls window.openGitWindow.
  window.openGitWindow = open;
  bindControlEvents(ctx);
  bindFileListEvents(ctx);

  return {
    open,
    close: () => closeWindow(ctx),
    isOpen: () => !dom.win.hidden,
    onTurnEnd: () => {
      if (dom.win.hidden) return;
      if (state.mode === 'commits') loadLog(ctx, false);
      else loadStatus(ctx);
    },
    repaint: () => {
      if (dom.win.hidden) return;
      if (!state.source) dom.title.textContent = t('git.title');
      if (!dom.layoutBtn.hidden) dom.layoutBtn.textContent = state.layout === 'split' ? t('git.unified') : t('git.split');
      paintList(ctx);
      if (!state.path && !state.files.length && !state.notGit && state.mode !== 'commits') paintNoChanges(ctx);
    },
  };
}
