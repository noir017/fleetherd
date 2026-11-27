import type { GitCommitSummary, GitMode, GitStatusFile } from '../../../../workbench.js';
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
  openDiffEditor,
  resolveChangesApi,
} from './diff-helpers.js';
import type { CommentDraftStore } from './comment-queue.js';
import { createDiffViewer, type DiffViewerController } from './diff-view.js';
import type { HunkNavState } from './hunk-nav.js';
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
  mobileDiffOpen: boolean;
  hunkState: HunkNavState;
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
  readonly rootEl: HTMLElement;
  readonly headerHost: HTMLElement;
  readonly noticeHost: HTMLElement;
  readonly listHost: HTMLElement;
  readonly previewBarHost: HTMLElement;
  readonly mobileFootHost: HTMLElement;
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
  if (file.additions === 0 && file.deletions === 0) {
    return html`<span class="fh-changes-stat-dim">0</span>`;
  }
  return html`${file.additions > 0
      ? html`<span class="fh-changes-stat-add" style="color:var(--fh-git-add)">+${file.additions}</span>`
      : nothing}${file.deletions > 0
      ? html`<span class="fh-changes-stat-del" style="color:var(--fh-git-del)">\u2212${file.deletions}</span>`
      : nothing}`;
}

function modeLabelText(ctx: PluginContext, mode: ChangesMode): string {
  if (mode === 'branch') return ctx.i18n.t('git.modeBranch');
  if (mode === 'committed') return ctx.i18n.t('git.modeCommitted');
  if (mode === 'commits') return ctx.i18n.t('git.modeCommits');
  return ctx.i18n.t('git.modeWorking');
}

function splitFilePath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return { name: path, dir: '' };
  return { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

function activeFileList(state: ChangesToolState): readonly GitStatusFile[] {
  return state.commit ? state.commitFiles : state.files;
}

function selectFileInline(ct: ChangesToolCtx, path: string, openMobile: boolean): void {
  const { state } = ct;
  if (!state.topicId) return;
  state.selectedPath = path;
  if (openMobile) state.mobileDiffOpen = true;
  syncMobileClass(ct);
  paintList(ct);
  paintPreviewChrome(ct);
  void ct.viewer.load(buildDiffInput(state, path));
}

function syncMobileClass(ct: ChangesToolCtx): void {
  ct.rootEl.classList.toggle('is-mobile-diff', ct.state.mobileDiffOpen && Boolean(ct.state.selectedPath));
}

function renderSummaryBar(ct: ChangesToolCtx): TemplateResult | typeof nothing {
  const { ctx, state } = ct;
  const list = activeFileList(state);
  if (list.length === 0) return nothing;
  let adds = 0;
  let dels = 0;
  for (const f of list) {
    if (!f.binary && !f.statsUnknown) {
      adds += f.additions;
      dels += f.deletions;
    }
  }
  const base = state.commit
    ? state.commit.short || state.commit.sha.slice(0, 7)
    : state.mode === 'working'
      ? 'HEAD'
      : state.base || 'HEAD';
  return html`<div class="fh-changes-summary">
    <span>${ctx.i18n.t('changes.summary', { base, count: list.length })}</span>
    <span class="fh-changes-summary-stats">
      <span style="color:var(--fh-git-add)">+${adds}</span>
      <span style="color:var(--fh-git-del)">\u2212${dels}</span>
    </span>
  </div>`;
}

function paintPreviewChrome(ct: ChangesToolCtx): void {
  const { ctx, state, previewBarHost, mobileFootHost } = ct;
  if (state.disposed) return;
  if (!state.selectedPath) {
    render(nothing, previewBarHost);
    render(nothing, mobileFootHost);
    return;
  }
  const list = activeFileList(state);
  const idx = list.findIndex((f) => f.path === state.selectedPath);
  const curFile = idx >= 0 ? list[idx] : undefined;
  const { name, dir } = splitFilePath(state.selectedPath);
  const hunkTotal = state.hunkState.total;
  const hunkLabel =
    hunkTotal > 0
      ? ctx.i18n.t('changes.hunkCounter', {
          current: state.hunkState.activeIndex >= 0 ? state.hunkState.activeIndex + 1 : 0,
          total: hunkTotal,
        })
      : '';

  render(
    html`<div class="fh-changes-preview-bar">
      <button
        type="button"
        class="fh-btn fh-btn--ghost fh-changes-mobile-back"
        data-changes-mobile-back
        @click=${() => {
          state.mobileDiffOpen = false;
          syncMobileClass(ct);
        }}
      >${renderIcon(icon('chevronLeft'), 'fh-icon')}<span>${ctx.i18n.t('changes.backToList')}</span></button>
      <div class="fh-changes-preview-meta">
        <span class="fh-changes-preview-name" title=${state.selectedPath}>${name}</span>
        ${dir ? html`<span class="fh-changes-preview-dir">${dir}</span>` : nothing}
      </div>
      <div class="fh-changes-preview-acts">
        ${hunkLabel ? html`<span class="fh-diff-hunk-counter">${hunkLabel}</span>` : nothing}
        ${renderActionBar({
          compact: true,
          items: [
            {
              id: 'prev-hunk',
              icon: icon('arrowUp'),
              title: ctx.i18n.t('changes.prevHunk'),
              disabled: hunkTotal <= 0,
              onClick: () => ct.viewer.navigateHunk(-1),
            },
            {
              id: 'next-hunk',
              icon: icon('arrowDown'),
              title: ctx.i18n.t('changes.nextHunk'),
              disabled: hunkTotal <= 0,
              onClick: () => ct.viewer.navigateHunk(1),
            },
            {
              id: 'open-editor',
              icon: icon('diff'),
              title: ctx.i18n.t('changes.openInEditor'),
              onClick: () => openDiffEditor(ctx, buildDiffInput(state, state.selectedPath)),
            },
          ],
        })}
      </div>
    </div>`,
    previewBarHost,
  );

  const canStep = list.length > 1 && idx >= 0;
  render(
    list.length > 0 && curFile
      ? html`<div class="fh-changes-mobile-foot">
          <button
            type="button"
            class="fh-changes-step-btn"
            data-changes-prev-file
            ?disabled=${!canStep}
            @click=${() => {
              const next = list[(idx - 1 + list.length) % list.length];
              if (next) selectFileInline(ct, next.path, true);
            }}
          >\u2039 ${ctx.i18n.t('changes.prevFile')}</button>
          <span class="fh-changes-step-count">${ctx.i18n.t('changes.fileCounter', { current: idx + 1, total: list.length })}</span>
          <button
            type="button"
            class="fh-changes-step-btn"
            data-changes-next-file
            ?disabled=${!canStep}
            @click=${() => {
              const next = list[(idx + 1) % list.length];
              if (next) selectFileInline(ct, next.path, true);
            }}
          >${ctx.i18n.t('changes.nextFile')} \u203A</button>
        </div>`
      : nothing,
    mobileFootHost,
  );
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
  const { name, dir } = splitFilePath(file.path);
  return html`<div
    class=${`fh-changes-file${selected ? ' is-selected' : ''}`}
    data-changes-path=${file.path}
    data-git-status=${file.status}
  >
    <button
      type="button"
      class="fh-changes-file-main"
      @click=${() => {
        selectFileInline(ct, file.path, true);
      }}
      @dblclick=${() => {
        if (state.topicId) openDiffEditor(ctx, buildDiffInput(state, file.path));
      }}
    >
      <span class="fh-changes-badge" style=${`color:${colorVar}`}>${gitStatusLetter(file.status)}</span>
      <span class="fh-changes-path-wrap" title=${file.path}>
        <span class="fh-changes-path">${file.path}</span>
        <span class="fh-changes-name">${name}</span>
        ${dir ? html`<span class="fh-changes-dir">${dir}</span>` : nothing}
      </span>
      <span class="fh-changes-stats">${renderFileStats(ctx, file)}</span>
      <span class="fh-changes-chevron" aria-hidden="true">${renderIcon(icon('chevronRight'), 'fh-icon')}</span>
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
          if (state.topicId) openDiffEditor(ctx, buildDiffInput(state, file.path));
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
  render(
    html`${renderSummaryBar(ct)}<div class="fh-changes-files">${state.files.map((f) => renderFileRow(ct, f, true))}</div>`,
    listHost,
  );
}

function paintHeader(ct: ChangesToolCtx): void {
  const { ctx, state, headerHost } = ct;
  if (state.disposed) return;
  const showBase = state.mode === 'branch' || state.mode === 'committed';
  const branchText = state.repo?.branch
    ? `${state.repo.branch} · ${modeLabelText(ctx, state.mode)}`
    : modeLabelText(ctx, state.mode);
  render(
    html`<div class="fh-changes-head-top">
        <span class="fh-changes-branch" title=${branchText}>${branchText}</span>
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
  paintPreviewChrome(ct);
  syncMobileClass(ct);
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
    state.mobileDiffOpen = false;
    ct.viewer.clear();
    state.emptyReason = emptyChangesReason(ctx, state.mode, state.base);
  } else if (state.selectedPath && !state.files.some((f) => f.path === state.selectedPath)) {
    state.selectedPath = '';
    state.mobileDiffOpen = false;
    ct.viewer.clear(ctx.i18n.t('git.fileGone'));
  } else if (!state.selectedPath && state.files[0]) {
    state.selectedPath = state.files[0].path;
    void ct.viewer.load(buildDiffInput(state, state.files[0].path));
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
  ct.state.mobileDiffOpen = false;
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
  ct.state.mobileDiffOpen = false;
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
  commentQueue?: CommentDraftStore,
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
  const previewBarHost = doc.createElement('div');
  previewBarHost.className = 'fh-changes-preview-bar-host';
  const mobileFootHost = doc.createElement('div');
  mobileFootHost.className = 'fh-changes-mobile-foot-host';

  const api = resolveChangesApi(deps);
  const viewer = store.add(
    createDiffViewer({
      ctx,
      api,
      codeView: deps.codeView ?? (async () => null),
      initialLayout: 'unified',
      doc,
      commentQueue,
      onHunkChange: (next) => {
        state.hunkState = next;
        paintPreviewChrome(ct);
      },
    }),
  );
  previewHost.append(previewBarHost, viewer.el, mobileFootHost);
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
    mobileDiffOpen: false,
    hunkState: { activeIndex: -1, total: 0 },
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
    rootEl: element,
    headerHost,
    noticeHost,
    listHost,
    previewBarHost,
    mobileFootHost,
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
      render(nothing, previewBarHost);
      render(nothing, mobileFootHost);
      element.remove();
    },
  };
}
