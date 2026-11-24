import type { GitCommitSummary, GitMode, GitStatusFile } from '../../../../adapter.js';
import { icon } from '../../../icons.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  renderActionBar,
  renderEmptyState,
  renderNotice,
  renderSegmented,
} from '../../components/index.js';
import { renderIcon } from '../../components/shared.js';
import type { PluginContext, TopicInfo } from '../../plugins/api.js';
import type { ApiClient } from '../../services/api.js';
import {
  buildBranchesUrl,
  buildCommitUrl,
  buildLogUrl,
  buildStatusUrl,
  defaultFormatAgo,
  fetchGitJson,
  gitStatusColorVar,
  gitStatusLetter,
  isChangesMode,
  isFilesEnabled,
  isNoRepoError,
  joinRepoPath,
  resolveChangesApi,
} from './diff-helpers.js';
import { createDiffViewer, type DiffViewerController } from './diff-view.js';
import type {
  ChangesMode,
  ChangesPluginDeps,
  DiffEditorInput,
  FeaturePanelComponent,
  FeaturePanelInitContext,
  GitBranchesPayload,
  GitCommitDetail,
  GitCommitPayload,
  GitLogPayload,
  GitRepoInfo,
  GitStatusPayload,
} from './types.js';

interface EmptyReason {
  readonly title: string;
  readonly description?: string;
  readonly showCommitsAction?: boolean;
}

interface ChangesToolState {
  topicId: string;
  mode: ChangesMode;
  base: string;
  branches: string[];
  repo: GitRepoInfo | null;
  files: GitStatusFile[];
  selectedPath: string;
  commits: GitCommitSummary[];
  commitMore: boolean;
  commit: GitCommitDetail | null;
  commitFiles: GitStatusFile[];
  bodyOpen: boolean;
  notice: { text: string; tone: 'err' | 'warn' | 'info' } | null;
  emptyReason: EmptyReason | null;
  loading: boolean;
  statusSeq: number;
  logSeq: number;
  commitSeq: number;
  disposed: boolean;
}

interface ChangesToolCtx {
  readonly ctx: PluginContext;
  readonly deps: ChangesPluginDeps;
  readonly api: Pick<ApiClient, 'get'>;
  readonly formatAgo: (at: number) => string;
  readonly state: ChangesToolState;
  readonly viewer: DiffViewerController;
  readonly headerHost: HTMLElement;
  readonly noticeHost: HTMLElement;
  readonly listHost: HTMLElement;
}

function buildDiffInput(state: ChangesToolState, path: string): DiffEditorInput {
  if (state.commit) {
    const shortRef = state.commit.short || state.commit.sha.slice(0, 7);
    return {
      topicId: state.topicId,
      path,
      ref: shortRef,
      sha: state.commit.sha,
      commitShort: shortRef,
    };
  }
  const mode: GitMode = state.mode === 'commits' ? 'working' : state.mode;
  return {
    topicId: state.topicId,
    path,
    ref: mode === 'working' ? 'working' : state.base || mode,
    mode,
    base: mode === 'working' ? undefined : state.base || undefined,
  };
}

function emptyChangesReason(ctx: PluginContext, mode: ChangesMode, baseName: string): EmptyReason {
  const base = baseName || ctx.i18n.t('git.baseBranchFallback');
  if (mode === 'working') {
    return {
      title: ctx.i18n.t('git.noChanges'),
      description: ctx.i18n.t('git.noChangesWorkingSub'),
      showCommitsAction: true,
    };
  }
  if (mode === 'branch') {
    return {
      title: ctx.i18n.t('git.noChangesBranch', { base }),
      description: ctx.i18n.t('git.noChangesBranchSub', { base }),
      showCommitsAction: true,
    };
  }
  return {
    title: ctx.i18n.t('git.noChangesCommitted', { base }),
    description: ctx.i18n.t('git.noChangesCommittedSub', { base }),
    showCommitsAction: true,
  };
}

function renderFileStats(ctx: PluginContext, file: GitStatusFile): TemplateResult {
  if (file.binary) return html`<span class="fh-changes-stat-del">bin</span>`;
  if (file.statsUnknown) {
    return html`<span class="fh-changes-stat-dim" title=${ctx.i18n.t('git.countsNotReadTitle')}>
      ${ctx.i18n.t('git.countsNotRead')}
    </span>`;
  }
  return html`<span class="fh-changes-stat-add" style="color:var(--fh-git-add)">+${file.additions}</span>
    <span class="fh-changes-stat-del" style="color:var(--fh-git-del)">\u2212${file.deletions}</span>`;
}

function paintNotice(ct: ChangesToolCtx): void {
  if (ct.state.disposed) return;
  render(
    ct.state.notice ? renderNotice({ tone: ct.state.notice.tone, message: ct.state.notice.text }) : nothing,
    ct.noticeHost,
  );
}

function renderFileRow(ct: ChangesToolCtx, file: GitStatusFile, allowEdit: boolean): TemplateResult {
  const { ctx, deps, state } = ct;
  const selected = file.path === state.selectedPath;
  const colorVar = gitStatusColorVar(file.status);
  const absPath = joinRepoPath(state.repo?.root ?? '', file.path);
  return html`<div
    class=${`fh-changes-file${selected ? ' is-selected' : ''}`}
    data-changes-path=${file.path}
    data-git-status=${file.status}
  >
    <button
      type="button"
      class="fh-changes-file-main"
      @click=${() => {
        if (!state.topicId) return;
        state.selectedPath = file.path;
        paintList(ct);
        void ct.viewer.load(buildDiffInput(state, file.path));
      }}
    >
      <span class="fh-changes-badge" style=${`color:${colorVar}`}>${gitStatusLetter(file.status)}</span>
      <span class="fh-changes-path" title=${file.path}>${file.path}</span>
      <span class="fh-changes-stats">${renderFileStats(ctx, file)}</span>
    </button>
    <div class="fh-changes-row-actions">
      <button
        type="button"
        class="fh-btn fh-btn--ghost fh-btn--icon"
        data-open-diff-editor=${file.path}
        title=${ctx.i18n.t('changes.openInEditor')}
        aria-label=${ctx.i18n.t('changes.openInEditor')}
        @click=${(ev: MouseEvent) => {
          ev.stopPropagation();
          if (state.topicId) ctx.editors.open('diff', buildDiffInput(state, file.path));
        }}
      >${renderIcon(icon('diff'), 'fh-icon')}</button>
      ${allowEdit && isFilesEnabled(deps)
        ? html`<button
            type="button"
            class="fh-btn fh-btn--ghost fh-btn--icon"
            data-open-file-editor=${absPath}
            title=${ctx.i18n.t('git.editFileTitle')}
            aria-label=${ctx.i18n.t('git.editFileTitle')}
            @click=${(ev: MouseEvent) => {
              ev.stopPropagation();
              ctx.editors.open('file', { topicId: state.topicId, path: absPath });
            }}
          >${renderIcon(icon('pencil'), 'fh-icon')}</button>`
        : nothing}
    </div>
  </div>`;
}

function renderCommitDetail(ct: ChangesToolCtx, commit: GitCommitDetail): TemplateResult {
  const { ctx, state, formatAgo } = ct;
  return html`
    <div class="fh-changes-commit-nav">
      <button
        type="button"
        class="fh-btn fh-btn--ghost"
        data-changes-back
        @click=${() => {
          state.commit = null;
          state.commitFiles = [];
          state.selectedPath = '';
          ct.viewer.clear(ctx.i18n.t('git.pickCommit'));
          paintList(ct);
        }}
      >${renderIcon(icon('chevronLeft'), 'fh-icon')}<span>${ctx.i18n.t('git.modeCommits')}</span></button>
    </div>
    <div class="fh-changes-commit-head">
      <div class="fh-changes-commit-subject">${commit.subject}</div>
      <div class="fh-changes-commit-meta">
        <span>${commit.short || commit.sha.slice(0, 7)}</span>
        <span>${commit.author}</span>
        <span>${formatAgo(commit.at)}</span>
      </div>
      ${commit.body
        ? html`<button
              type="button"
              class="fh-btn fh-btn--ghost"
              @click=${() => {
                state.bodyOpen = !state.bodyOpen;
                paintList(ct);
              }}
            >${state.bodyOpen ? ctx.i18n.t('git.hideDetails') : ctx.i18n.t('git.showDetails')}</button>
            ${state.bodyOpen ? html`<pre class="fh-changes-commit-body">${commit.body}</pre>` : nothing}`
        : nothing}
    </div>
    <div class="fh-changes-files">
      ${state.commitFiles.map((f) => renderFileRow(ct, f, false))}
    </div>
  `;
}

function renderCommitsList(ct: ChangesToolCtx): TemplateResult {
  const { ctx, state, formatAgo } = ct;
  if (state.commits.length === 0) {
    return renderEmptyState({
      title: state.emptyReason?.title ?? ctx.i18n.t('git.noCommits'),
      description: state.emptyReason?.description ?? ctx.i18n.t('git.noCommitsSub'),
    });
  }
  return html`<div class="fh-changes-commits">
    ${state.commits.map(
      (c) => html`<button
        type="button"
        class="fh-changes-commit-row"
        data-commit-sha=${c.sha}
        @click=${() => void openCommit(ct, c.sha)}
      >
        <span class="fh-changes-commit-subject">${c.subject}</span>
        <span class="fh-changes-commit-meta">
          <span>${c.short || c.sha.slice(0, 7)}</span>
          <span>${c.author}</span>
          <span>${formatAgo(c.at)}</span>
        </span>
      </button>`,
    )}
    ${state.commitMore
      ? html`<button type="button" class="fh-btn fh-btn--secondary" data-commits-more @click=${() => void loadLog(ct, true)}>
          ${ctx.i18n.t('git.loadMore')}
        </button>`
      : nothing}
  </div>`;
}

function paintList(ct: ChangesToolCtx): void {
  const { ctx, state, listHost } = ct;
  if (state.disposed) return;
  if (!state.topicId) {
    render(renderEmptyState({ title: ctx.i18n.t('changes.noActiveTopic') }), listHost);
    return;
  }
  if (state.loading && state.files.length === 0 && state.commits.length === 0 && !state.commit) {
    render(renderEmptyState({ title: ctx.i18n.t('common.loading') }), listHost);
    return;
  }
  if (state.commit) {
    render(renderCommitDetail(ct, state.commit), listHost);
    return;
  }
  if (state.mode === 'commits') {
    render(renderCommitsList(ct), listHost);
    return;
  }
  if (state.files.length === 0) {
    render(
      renderEmptyState({
        title: state.emptyReason?.title ?? ctx.i18n.t('git.noChanges'),
        description: state.emptyReason?.description,
        action: state.emptyReason?.showCommitsAction
          ? { label: ctx.i18n.t('git.seeCommits'), onClick: () => setMode(ct, 'commits') }
          : undefined,
      }),
      listHost,
    );
    return;
  }
  render(html`<div class="fh-changes-files">${state.files.map((f) => renderFileRow(ct, f, true))}</div>`, listHost);
}

function paintHeader(ct: ChangesToolCtx): void {
  const { ctx, state, headerHost } = ct;
  if (state.disposed) return;
  const showBase = state.mode === 'branch' || state.mode === 'committed';
  render(
    html`<div class="fh-changes-head-top">
        <span class="fh-changes-branch">${state.repo?.branch ?? ''}</span>
        ${renderActionBar({
          compact: true,
          items: [
            {
              id: 'refresh',
              icon: icon('refresh'),
              title: ctx.i18n.t('git.refreshTitle'),
              disabled: !state.topicId || state.loading,
              onClick: () => refreshCurrent(ct),
            },
          ],
        })}
      </div>
      <div class="fh-changes-modes">
        ${renderSegmented({
          kind: 'nav',
          ariaLabel: ctx.i18n.t('git.compareAria'),
          value: state.mode,
          options: [
            { value: 'working', label: ctx.i18n.t('git.modeWorking') },
            { value: 'branch', label: ctx.i18n.t('git.modeBranch') },
            { value: 'committed', label: ctx.i18n.t('git.modeCommitted') },
            { value: 'commits', label: ctx.i18n.t('git.modeCommits') },
          ],
          onChange: (val) => {
            if (isChangesMode(val)) setMode(ct, val);
          },
        })}
      </div>
      ${showBase && state.branches.length > 0
        ? html`<select
            class="fh-changes-base"
            aria-label=${ctx.i18n.t('git.baseTitle')}
            .value=${state.base}
            @change=${(ev: Event) => {
              state.base = (ev.target as HTMLSelectElement).value;
              state.selectedPath = '';
              ct.viewer.clear();
              void loadStatus(ct);
            }}
          >
            ${state.branches.map((b) => html`<option value=${b} ?selected=${b === state.base}>${b}</option>`)}
          </select>`
        : nothing}`,
    headerHost,
  );
}

function paintAll(ct: ChangesToolCtx): void {
  paintHeader(ct);
  paintNotice(ct);
  paintList(ct);
}

async function loadBranches(ct: ChangesToolCtx): Promise<void> {
  const topicId = ct.state.topicId;
  if (!topicId) return;
  try {
    const res = await fetchGitJson<GitBranchesPayload>(ct.api, buildBranchesUrl(topicId));
    if (ct.state.disposed || ct.state.topicId !== topicId || !res.ok || !res.data?.ok) return;
    ct.state.branches = res.data.branches ?? [];
    if (!ct.state.base) ct.state.base = res.data.base || ct.state.branches[0] || '';
    paintHeader(ct);
  } catch {
    // Branch list is secondary; status error handles connectivity feedback.
  }
}

function handleStatusFailure(ct: ChangesToolCtx, d: GitStatusPayload | null): void {
  const { ctx, state } = ct;
  state.files = [];
  state.repo = null;
  state.selectedPath = '';
  ct.viewer.clear();
  if (d && isNoRepoError(d)) {
    state.notice = null;
    const isMissing = d.reason === 'missing';
    state.emptyReason = {
      title: ctx.i18n.t(isMissing ? 'git.dirNotFound' : 'git.notGit'),
      description: d.text || ctx.i18n.t(isMissing ? 'git.dirNotFoundSub' : 'git.notGitSub'),
    };
  } else {
    state.notice = { text: (d && (d.text || d.error)) || ctx.i18n.t('git.readChangesFailed'), tone: 'err' };
  }
  paintAll(ct);
}

function handleStatusSuccess(ct: ChangesToolCtx, d: GitStatusPayload): void {
  const { ctx, state } = ct;
  state.repo = d.repo ?? null;
  state.files = d.files ?? [];
  state.notice = d.truncated ? { text: ctx.i18n.t('git.tooManyChanges'), tone: 'warn' } : null;
  if (state.files.length === 0) {
    state.selectedPath = '';
    ct.viewer.clear();
    state.emptyReason = emptyChangesReason(ctx, state.mode, state.base);
  } else if (state.selectedPath && !state.files.some((f) => f.path === state.selectedPath)) {
    state.selectedPath = '';
    ct.viewer.clear(ctx.i18n.t('git.fileGone'));
  }
  paintAll(ct);
}

async function loadStatus(ct: ChangesToolCtx): Promise<void> {
  const topicId = ct.state.topicId;
  if (!topicId) return;
  const mine = ++ct.state.statusSeq;
  ct.state.loading = true;
  ct.state.emptyReason = null;
  paintHeader(ct);
  paintList(ct);
  try {
    const res = await fetchGitJson<GitStatusPayload>(ct.api, buildStatusUrl(topicId, ct.state.mode, ct.state.base));
    if (ct.state.disposed || mine !== ct.state.statusSeq || ct.state.topicId !== topicId) return;
    ct.state.loading = false;
    if (!res.ok || !res.data?.ok) {
      handleStatusFailure(ct, res.data);
      return;
    }
    handleStatusSuccess(ct, res.data);
  } catch {
    if (ct.state.disposed || mine !== ct.state.statusSeq) return;
    ct.state.loading = false;
    ct.state.notice = { text: ct.ctx.i18n.t('common.reachServerError'), tone: 'err' };
    paintAll(ct);
  }
}

function applyLogResponse(ct: ChangesToolCtx, ok: boolean, d: GitLogPayload | null, more: boolean): void {
  if (!ok || !d?.ok) {
    ct.state.notice = { text: (d && (d.text || d.error)) || ct.ctx.i18n.t('git.readCommitsFailed'), tone: 'err' };
    paintAll(ct);
    return;
  }
  ct.state.commits = more ? [...ct.state.commits, ...(d.commits ?? [])] : [...(d.commits ?? [])];
  ct.state.commitMore = Boolean(d.more);
  if (d.repo) ct.state.repo = d.repo;
  ct.state.notice = null;
  paintAll(ct);
}

async function loadLog(ct: ChangesToolCtx, more: boolean): Promise<void> {
  const topicId = ct.state.topicId;
  if (!topicId) return;
  const mine = ++ct.state.logSeq;
  const skip = more ? ct.state.commits.length : 0;
  ct.state.loading = true;
  paintHeader(ct);
  try {
    const res = await fetchGitJson<GitLogPayload>(ct.api, buildLogUrl(topicId, skip));
    if (ct.state.disposed || mine !== ct.state.logSeq || ct.state.topicId !== topicId) return;
    ct.state.loading = false;
    applyLogResponse(ct, res.ok, res.data, more);
  } catch {
    if (ct.state.disposed || mine !== ct.state.logSeq) return;
    ct.state.loading = false;
    ct.state.notice = { text: ct.ctx.i18n.t('common.reachServerError'), tone: 'err' };
    paintAll(ct);
  }
}

function applyCommitResponse(ct: ChangesToolCtx, ok: boolean, d: GitCommitPayload | null): void {
  if (!ok || !d?.ok) {
    ct.state.notice = { text: (d && (d.text || d.error)) || ct.ctx.i18n.t('git.readCommitFailed'), tone: 'err' };
    ct.viewer.clear();
    paintNotice(ct);
    paintList(ct);
    return;
  }
  ct.state.commit = d.commit ?? ct.state.commit;
  ct.state.commitFiles = d.files ?? [];
  ct.state.notice = d.truncated ? { text: ct.ctx.i18n.t('git.tooManyCommitFiles'), tone: 'warn' } : null;
  ct.viewer.clear(ct.state.commitFiles.length === 0 ? ct.ctx.i18n.t('git.commitNoFiles') : ct.ctx.i18n.t('git.selectFile'));
  paintNotice(ct);
  paintList(ct);
}

async function openCommit(ct: ChangesToolCtx, sha: string): Promise<void> {
  const topicId = ct.state.topicId;
  if (!topicId) return;
  const mine = ++ct.state.commitSeq;
  const known = ct.state.commits.find((c) => c.sha === sha);
  ct.state.commit = known ?? { sha, short: sha.slice(0, 7), subject: '', author: '', at: 0, parents: 0 };
  ct.state.commitFiles = [];
  ct.state.selectedPath = '';
  ct.state.bodyOpen = false;
  ct.viewer.clear(ct.ctx.i18n.t('common.loading'));
  paintList(ct);
  try {
    const res = await fetchGitJson<GitCommitPayload>(ct.api, buildCommitUrl(topicId, sha));
    if (ct.state.disposed || mine !== ct.state.commitSeq || ct.state.topicId !== topicId) return;
    applyCommitResponse(ct, res.ok, res.data);
  } catch {
    if (ct.state.disposed || mine !== ct.state.commitSeq) return;
    ct.state.notice = { text: ct.ctx.i18n.t('common.reachServerError'), tone: 'err' };
    paintNotice(ct);
  }
}

function setMode(ct: ChangesToolCtx, next: ChangesMode): void {
  if (next === ct.state.mode) return;
  ct.state.mode = next;
  ct.state.selectedPath = '';
  ct.state.commit = null;
  ct.state.commitFiles = [];
  ct.state.commits = [];
  ct.state.commitMore = false;
  ct.state.notice = null;
  ct.state.emptyReason = null;
  ct.state.statusSeq += 1;
  ct.state.logSeq += 1;
  ct.state.commitSeq += 1;
  ct.viewer.clear();
  paintHeader(ct);
  paintNotice(ct);
  if (next === 'commits') void loadLog(ct, false);
  else void loadStatus(ct);
}

function refreshCurrent(ct: ChangesToolCtx): void {
  if (!ct.state.topicId) return;
  if (ct.state.mode === 'commits') void loadLog(ct, false);
  else void loadStatus(ct);
}

function bindTopic(ct: ChangesToolCtx, topic: TopicInfo | undefined): void {
  const nextId = topic?.dir?.path ? topic.id : '';
  if (nextId === ct.state.topicId && ct.state.topicId !== '') return;
  ct.state.topicId = nextId;
  ct.state.repo = null;
  ct.state.files = [];
  ct.state.branches = [];
  ct.state.base = '';
  ct.state.selectedPath = '';
  ct.state.commits = [];
  ct.state.commit = null;
  ct.state.commitFiles = [];
  ct.state.notice = null;
  ct.state.emptyReason = null;
  ct.state.statusSeq += 1;
  ct.state.logSeq += 1;
  ct.state.commitSeq += 1;
  ct.viewer.clear();
  paintAll(ct);
  if (!nextId) return;
  void loadBranches(ct);
  refreshCurrent(ct);
}

export function createChangesToolPanel(
  ctx: PluginContext,
  deps: ChangesPluginDeps,
): FeaturePanelComponent {
  const doc = deps.doc ?? document;
  const store = new DisposableStore();

  const element = doc.createElement('div');
  element.className = 'fh-changes-tool';
  const headerHost = doc.createElement('div');
  headerHost.className = 'fh-changes-header';
  const noticeHost = doc.createElement('div');
  noticeHost.className = 'fh-changes-notice';
  const listHost = doc.createElement('div');
  listHost.className = 'fh-changes-list';
  const previewHost = doc.createElement('div');
  previewHost.className = 'fh-changes-preview';

  const api = resolveChangesApi(deps);
  const viewer = store.add(
    createDiffViewer({
      ctx,
      api,
      codeView: deps.codeView ?? (async () => null),
      initialLayout: 'unified',
      doc,
    }),
  );
  previewHost.appendChild(viewer.el);
  element.append(headerHost, noticeHost, listHost, previewHost);

  const state: ChangesToolState = {
    topicId: '',
    mode: 'working',
    base: '',
    branches: [],
    repo: null,
    files: [],
    selectedPath: '',
    commits: [],
    commitMore: false,
    commit: null,
    commitFiles: [],
    bodyOpen: false,
    notice: null,
    emptyReason: null,
    loading: false,
    statusSeq: 0,
    logSeq: 0,
    commitSeq: 0,
    disposed: false,
  };

  const ct: ChangesToolCtx = {
    ctx,
    deps,
    api,
    formatAgo: deps.formatAgo ?? defaultFormatAgo,
    state,
    viewer,
    headerHost,
    noticeHost,
    listHost,
  };

  return {
    element,
    init(_params: unknown, _initCtx: FeaturePanelInitContext): void {
      store.add(ctx.events.on('topic.active', ({ topic }) => bindTopic(ct, topic)));
      store.add(
        ctx.events.on('topic.turnEnd', ({ topicId }) => {
          if (topicId && topicId === state.topicId) refreshCurrent(ct);
        }),
      );
      bindTopic(ct, ctx.topics.active());
    },
    focus(): void {
      element.focus?.();
    },
    dispose(): void {
      if (state.disposed) return;
      state.disposed = true;
      state.statusSeq += 1;
      state.logSeq += 1;
      state.commitSeq += 1;
      store.dispose();
      render(nothing, headerHost);
      render(nothing, noticeHost);
      render(nothing, listHost);
      element.remove();
    },
  };
}
