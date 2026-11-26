import type {
  SkillPanelDetail,
  SkillPanelEntry,
  SkillPanelHistoryEntry,
} from '../../../../adapter.js';
import type { EditorHandle } from '../../../codeview/app.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  openConfirmDialog,
  renderEmptyState,
  renderNotice,
  renderSegmented,
  renderSwitch,
  renderTextInput,
} from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext } from '../../plugins/api.js';
import {
  buildMetadataDiff,
  computeLineDiff,
  type DiffResult,
  extractEmbeddedHistoryContent,
} from './history-diff.js';
import type { SkillsStore } from './store.js';
import {
  formatIsoAgo,
  getSkillIcon,
  isSkillActive,
  parseSkillEditorInput,
  type ResolvedSkillsDeps,
  type SkillPanelComponent,
  type SkillPanelInitContext,
} from './types.js';

interface SkillEditorState {
  name: string;
  requestedFile?: string;
  detail: SkillPanelDetail | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  newFileMode: boolean;
  draftPath: string;
  draftContent: string;
  copied: boolean;
  usingCodeMirror: boolean;
  selectedHistoryId: string | null;
  historyDiffLoading: boolean;
  historyDiff: DiffResult | null;
}

function detailSubText(
  skill: SkillPanelEntry,
  formatAgo: (at: number) => string,
  tSkill: (key: string, fallback: string, vars?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (skill.description) parts.push(skill.description);
  if (skill.category) {
    parts.push(tSkill('wb.skills.categoryLabel', `Category ${skill.category}`, { category: skill.category }));
  }
  if (skill.agents && skill.agents.length > 0) {
    parts.push(tSkill('wb.skills.agentsLabel', `Sent to ${skill.agents.join(', ')}`, { agents: skill.agents.join(', ') }));
  }
  parts.push(
    skill.lastUsedAt
      ? tr('skills.lastUsed', { ago: formatIsoAgo(skill.lastUsedAt, formatAgo) })
      : tr('skills.neverUsed'),
  );
  parts.push(tSkill('wb.skills.versionNote', `v${skill.version}`, { version: skill.version }));
  return parts.join(' \u00b7 ');
}

function historyMetaText(entry: SkillPanelHistoryEntry, formatAgo: (at: number) => string): string {
  const parts = [formatIsoAgo(entry.at, formatAgo)];
  // Keep talkcode* compatibility alongside fleetherd* until legacy-name.ts is removed.
  if (entry.author && !/^(fleetherd|talkcode)(-|$)/.test(entry.author)) {
    parts.push(entry.author);
  }
  if (entry.note) parts.push(entry.note);
  if (entry.beforeVersion) {
    parts.push(`${entry.beforeVersion} \u2192 ${entry.afterVersion || tr('skills.noVersion')}`);
  }
  return parts.filter(Boolean).join(' \u00b7 ');
}

function isEditorDirty(st: SkillEditorState): boolean {
  if (!st.detail) return false;
  if (st.newFileMode) return st.draftPath.trim() !== '' || st.draftContent !== '';
  return st.draftPath !== st.detail.file.path || st.draftContent !== st.detail.file.content;
}

interface EditorCallbacks {
  readonly onCopyName: () => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onChangeTier: (resident: boolean) => void;
  readonly onTogglePin: () => void;
  readonly onRefresh: () => void;
  readonly onSelectFile: (path: string) => void;
  readonly onStartNewFile: () => void;
  readonly onPathInput: (path: string) => void;
  readonly onContentInput: (content: string) => void;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onRemoveFile: () => void;
  readonly onRevert: (id: string) => void;
  readonly onSelectHistory: (entry: SkillPanelHistoryEntry) => void;
  readonly onCloseHistoryDiff: () => void;
  readonly onDismissError: () => void;
}

function renderEditorTopBar(
  st: SkillEditorState,
  deps: ResolvedSkillsDeps,
  cb: EditorCallbacks,
): TemplateResult {
  const detail = st.detail!;
  const skill = detail.skill;
  const active = isSkillActive(skill);
  const icons = deps.icons();
  const copyLabel = st.copied ? tr('common.copied') : tr('skills.copyName');
  const copySvg = getSkillIcon(icons, st.copied ? 'check' : 'copy');

  return html`
    <div class="fh-skill-ed-bar">
      <h2 class="fh-skill-ed-name">${skill.name}</h2>
      <span class="fh-skill-pill">${skill.resident ? tr('skills.tabResident') : tr('skills.tabLibrary')}</span>
      ${!active ? html`<span class="fh-skill-pill">${tr('common.offCap')}</span>` : nothing}
      ${skill.status === 'expired'
        ? html`<span class="fh-skill-pill is-warn" title=${tr('skills.expiredTitle')}>${tr('skills.expiredCap')}</span>`
        : nothing}
      <span class="fh-skill-ed-sp"></span>
      <button
        type="button"
        class="fh-btn fh-btn--ghost fh-btn--icon fh-skill-copy"
        data-copy-skill=${skill.name}
        title=${copyLabel}
        aria-label=${copyLabel}
        @click=${cb.onCopyName}
      >${renderInlineSvg(copySvg)}</button>
      <button
        type="button"
        class="fh-btn fh-btn--ghost fh-btn--icon"
        data-sop="refresh"
        title=${tr('skills.refreshTitle')}
        aria-label=${tr('skills.refreshTitle')}
        ?disabled=${st.loading || st.saving}
        @click=${cb.onRefresh}
      >${renderInlineSvg(getSkillIcon(icons, 'refresh'))}</button>
      <button
        type="button"
        class="fh-btn fh-btn--primary fh-skill-save-btn"
        data-sop="save"
        ?disabled=${st.saving || st.loading}
        @click=${cb.onSave}
      >${st.saving ? tr('common.saving') : tr('common.save')}</button>
    </div>
  `;
}

function renderPropertiesCard(
  st: SkillEditorState,
  deps: ResolvedSkillsDeps,
  cb: EditorCallbacks,
  tSkill: (key: string, fallback: string, vars?: Record<string, unknown>) => string,
): TemplateResult {
  const skill = st.detail!.skill;
  const active = isSkillActive(skill);
  return html`
    <div class="fh-skill-ed-sub">${detailSubText(skill, deps.formatAgo, tSkill)}</div>
    ${skill.warning ? renderNotice({ tone: 'warn', message: skill.warning }) : nothing}
    ${skill.problem
      ? renderNotice({ tone: 'err', message: `${tr('skills.notDelivered')}${skill.problem}` })
      : nothing}
    <div class="fh-skill-card">
      <div class="fh-skill-ci">
        <span class="fh-skill-ci-l">${tSkill('wb.skills.tierLabel', 'Tier')}</span>
        <div class="fh-skill-ci-ctl">
          ${renderSegmented({
            kind: 'value',
            ariaLabel: tr('skills.tierAria'),
            value: skill.resident ? 'resident' : 'library',
            options: [
              {
                value: 'library',
                label: tr('skills.tabLibrary'),
                title: tr('skills.tierLibraryTitle'),
                disabled: !active || st.saving,
              },
              {
                value: 'resident',
                label: tr('skills.tabResident'),
                title: tr('skills.tierResidentTitle'),
                disabled: !active || st.saving,
              },
            ],
            onChange: (val) => cb.onChangeTier(val === 'resident'),
          })}
        </div>
        <span class="fh-skill-ci-h">${tSkill('wb.skills.tierHint', 'Resident skills appear in every agent’s skill list.')}</span>
      </div>
      <div class="fh-skill-ci">
        <span class="fh-skill-ci-l">${tSkill('wb.skills.enabledLabel', 'Enabled')}</span>
        <div class="fh-skill-ci-ctl">
          ${renderSwitch({
            checked: active,
            label: active ? tr('common.onCap') : tr('common.offCap'),
            ariaLabel: active ? tr('skills.onTitle') : tr('skills.offTitle'),
            disabled: st.saving,
            onChange: cb.onToggleEnabled,
          })}
        </div>
        <span class="fh-skill-ci-h">${tSkill('wb.skills.enabledHint', 'Turning off archives this skill.')}</span>
      </div>
      <div class="fh-skill-ci">
        <span class="fh-skill-ci-l">${tSkill('wb.skills.pinnedLabel', 'Pinned')}</span>
        <div class="fh-skill-ci-ctl">
          <button
            type="button"
            class=${`fh-btn fh-btn--secondary fh-skill-pin-btn${skill.pinned ? ' is-pinned' : ''}`}
            data-sop="pin"
            aria-pressed=${skill.pinned ? 'true' : 'false'}
            ?disabled=${st.saving}
            @click=${cb.onTogglePin}
          >${skill.pinned ? tr('skills.unpin') : tr('skills.pin')}</button>
        </div>
        <span class="fh-skill-ci-h">${tSkill('wb.skills.pinnedHint', 'Pinned skills do not expire when unused.')}</span>
      </div>
    </div>
  `;
}

function renderFilesBar(
  st: SkillEditorState,
  deps: ResolvedSkillsDeps,
  cb: EditorCallbacks,
  tSkill: (key: string, fallback: string, vars?: Record<string, unknown>) => string,
): TemplateResult {
  const detail = st.detail!;
  const icons = deps.icons();
  const fileSvg = getSkillIcon(icons, 'file');
  const plusSvg = getSkillIcon(icons, 'plus');
  const currentPath = st.newFileMode ? '' : detail.file.path;
  const dirty = isEditorDirty(st);
  return html`
    <div class="fh-skill-ed-section">${tr('skills.files')}</div>
    <div class="fh-skill-files-box">
      ${detail.files.map(
        (f) => {
          const active = currentPath === f.path;
          return html`<button
            type="button"
            class=${`fh-skill-file-row${active ? ' is-active' : ''}`}
            data-file=${f.path}
            ?disabled=${st.loading || st.saving}
            @click=${() => cb.onSelectFile(f.path)}
          >${renderInlineSvg(fileSvg)}<span class="fh-skill-file-path">${f.path}</span><span class="fh-skill-file-meta">${active && dirty ? tSkill('wb.skills.dirty', 'Modified') : deps.formatBytes(f.size)}</span></button>`;
        },
      )}
      <button
        type="button"
        class=${`fh-skill-file-row is-new${st.newFileMode ? ' is-active' : ''}`}
        data-sop="new-file"
        ?disabled=${st.loading || st.saving}
        @click=${cb.onStartNewFile}
      >${renderInlineSvg(plusSvg)}<span>${tr('skills.newFile')}</span></button>
    </div>
  `;
}

function renderEditorBoxHead(
  st: SkillEditorState,
  cb: EditorCallbacks,
  tSkill: (key: string, fallback: string, vars?: Record<string, unknown>) => string,
): TemplateResult {
  const detail = st.detail!;
  const isSkillMd = !st.newFileMode && detail.file.path === 'SKILL.md';
  const dirty = isEditorDirty(st);
  const statusText = dirty
    ? tSkill('wb.skills.unsavedVersion', `Unsaved changes · v${detail.file.version}`, { version: detail.file.version })
    : tSkill('wb.skills.versionNote', `v${detail.file.version}`, { version: detail.file.version });

  return html`
    <div class="fh-skill-ed-box-head">
      ${st.newFileMode
        ? html`<div class="fh-skill-ed-path">
            ${renderTextInput({
              id: 'fh-skill-ed-path',
              value: st.draftPath,
              placeholder: 'references/notes.md',
              ariaLabel: tr('skills.files'),
              disabled: st.saving,
              onInput: cb.onPathInput,
            })}
          </div>`
        : html`<b class="fh-skill-ed-box-name">${detail.file.path}</b>`}
      <span class="fh-skill-ed-box-dim">${statusText}</span>
      <span class="fh-skill-ed-sp"></span>
      ${dirty
        ? html`<button
            type="button"
            class="fh-btn fh-btn--secondary"
            data-sop="discard"
            ?disabled=${st.saving || st.loading}
            @click=${cb.onDiscard}
          >${tSkill('wb.skills.discard', 'Discard')}</button>`
        : nothing}
      ${!isSkillMd && !st.newFileMode
        ? html`<button
          type="button"
          class="fh-btn fh-btn--danger"
          data-sop="remove-file"
          ?disabled=${st.saving || st.loading}
          @click=${cb.onRemoveFile}
        >${tr('skills.removeFile')}</button>`
        : nothing}
    </div>
  `;
}

function renderHistorySection(
  st: SkillEditorState,
  deps: ResolvedSkillsDeps,
  cb: EditorCallbacks,
  tSkill: (key: string, fallback: string, vars?: Record<string, unknown>) => string,
): TemplateResult {
  const history = st.detail!.history;
  const selectedEntry = st.selectedHistoryId
    ? history.find((item) => item.id === st.selectedHistoryId) ?? null
    : null;
  return html`
    <div class="fh-skill-ed-section">${tr('skills.history')}</div>
    <div class="fh-skill-card fh-skill-ed-history">
      ${history.length === 0
        ? html`<div class="fh-skill-ed-empty">${tr('skills.noHistory')}</div>`
        : history.map(
            (entry, idx) => {
              const isSelected = st.selectedHistoryId === entry.id;
              const canRevert = Boolean(entry.beforeVersion || entry.action === 'commit');
              const shortId = entry.id.slice(0, 7);
              const isCurrent = idx === 0 && entry.afterVersion === st.detail!.skill.version;
              return html`<div class=${`fh-skill-hist-row${isSelected ? ' is-selected' : ''}`} data-history-id=${entry.id}>
                <div
                  class="fh-skill-hist-main"
                  role="button"
                  tabindex="0"
                  aria-expanded=${isSelected ? 'true' : 'false'}
                  @click=${() => cb.onSelectHistory(entry)}
                  @keydown=${(ev: KeyboardEvent) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      cb.onSelectHistory(entry);
                    }
                  }}
                >
                  <div class="fh-skill-hist-action"><code>${shortId}</code> <span>${entry.note || entry.action}</span></div>
                  <div class="fh-skill-hist-meta">${historyMetaText(entry, deps.formatAgo)}</div>
                </div>
                <div class="fh-skill-hist-actions">
                  ${isCurrent ? html`<span class="fh-skill-pill">${tSkill('wb.skills.current', 'Current')}</span>` : nothing}
                  <button
                    type="button"
                    class=${`fh-btn fh-btn--ghost fh-skill-hist-diff-btn${isSelected ? ' is-active' : ''}`}
                    data-history-diff=${entry.id}
                    aria-pressed=${isSelected ? 'true' : 'false'}
                    @click=${() => cb.onSelectHistory(entry)}
                  >${isSelected ? tSkill('wb.skills.hideDiff', 'Hide diff') : tSkill('wb.skills.diff', 'Diff')}</button>
                  ${canRevert
                    ? html`<button
                        type="button"
                        class="fh-btn fh-btn--secondary"
                        data-revert=${entry.id}
                        ?disabled=${st.saving}
                        @click=${() => cb.onRevert(entry.id)}
                      >${tr('skills.restoreVersion')}</button>`
                    : nothing}
                </div>
              </div>`;
            },
          )}
    </div>
    ${selectedEntry ? renderHistoryDiffPanel(st, selectedEntry, cb, tSkill) : nothing}
  `;
}

function renderHistoryDiffPanel(
  st: SkillEditorState,
  entry: SkillPanelHistoryEntry,
  cb: EditorCallbacks,
  tSkill: (key: string, fallback: string) => string,
): TemplateResult {
  const detail = st.detail!;
  const fromLabel = entry.beforeVersion || entry.id.slice(0, 7);
  const toLabel = `${tSkill('wb.skills.diffCurrent', 'Current')} (v${detail.skill.version})`;
  const canRevert = Boolean(entry.beforeVersion || entry.action === 'commit');
  const diff = st.historyDiff;

  return html`<div class="fh-skill-diff-panel" data-diff-entry=${entry.id}>
    <div class="fh-skill-diff-head">
      <div class="fh-skill-diff-title">
        <span class="fh-skill-diff-ref">${fromLabel}</span>
        <span class="fh-skill-diff-arrow" aria-hidden="true">\u2192</span>
        <span class="fh-skill-diff-ref">${toLabel}</span>
        ${diff
          ? html`<span class="fh-skill-diff-stats">
              <span class="fh-skill-diff-stat fh-skill-diff-stat--add">+${diff.added}</span>
              <span class="fh-skill-diff-stat fh-skill-diff-stat--del">-${diff.removed}</span>
            </span>`
          : nothing}
      </div>
      <div class="fh-skill-diff-actions">
        ${canRevert
          ? html`<button
              type="button"
              class="fh-btn fh-btn--secondary"
              data-diff-revert=${entry.id}
              ?disabled=${st.saving}
              @click=${() => cb.onRevert(entry.id)}
            >${tr('skills.restoreVersion')}</button>`
          : nothing}
        <button
          type="button"
          class="fh-btn fh-btn--ghost"
          data-diff-close="1"
          @click=${cb.onCloseHistoryDiff}
        >${tSkill('wb.skills.diffClose', 'Close diff')}</button>
      </div>
    </div>
    ${st.historyDiffLoading
      ? html`<div class="fh-skill-diff-empty">${tSkill('wb.skills.diffLoading', 'Loading diff\u2026')}</div>`
      : !diff || !diff.hasChanges
        ? html`<div class="fh-skill-diff-empty">${tSkill('wb.skills.diffNoChanges', 'No differences from current content.')}</div>`
        : html`${diff.source === 'metadata'
            ? html`<div class="fh-skill-diff-note">${tSkill(
                'wb.skills.diffMetadataNote',
                'Full snapshot for this older commit is not cached locally; showing version metadata diff.',
              )}</div>`
            : nothing}
          <div class="fh-skill-diff-body" role="region" aria-label=${`${fromLabel} -> ${toLabel}`}>
            ${diff.lines.map((line) => {
              if (line.kind === 'hunk') {
                return html`<div class="fh-skill-diff-line fh-skill-diff-line--hunk">${line.text}</div>`;
              }
              const cls =
                line.kind === 'add'
                  ? 'fh-skill-diff-line--add'
                  : line.kind === 'del'
                    ? 'fh-skill-diff-line--del'
                    : 'fh-skill-diff-line--ctx';
              const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
              return html`<div class=${`fh-skill-diff-line ${cls}`}>
                <span class="fh-skill-diff-ln">${line.oldLine ?? ''}</span>
                <span class="fh-skill-diff-ln">${line.newLine ?? ''}</span>
                <span class="fh-skill-diff-sign">${sign}</span>
                <span class="fh-skill-diff-code">${line.text}</span>
              </div>`;
            })}
          </div>`}
  </div>`;
}

function renderInlineSvg(markup: string): TemplateResult | typeof nothing {
  if (!markup) return nothing;
  const tpl = document.createElement('template');
  tpl.innerHTML = markup;
  return html`<span class="fh-icon" aria-hidden="true">${tpl.content}</span>`;
}

export function createSkillEditorPanel(
  store: SkillsStore,
  deps: ResolvedSkillsDeps,
  ctx?: PluginContext,
): SkillPanelComponent {
  return new SkillEditorPanel(store, deps, ctx);
}

class SkillEditorPanel implements SkillPanelComponent {
  readonly element: HTMLElement;
  private readonly _store: SkillsStore;
  private readonly _deps: ResolvedSkillsDeps;
  private readonly _ctx?: PluginContext;
  private readonly _headerHost: HTMLElement;
  private readonly _pageEl: HTMLElement;
  private readonly _colEl: HTMLElement;
  private readonly _chromeHost: HTMLElement;
  private readonly _editorBoxEl: HTMLElement;
  private readonly _editorBarHost: HTMLElement;
  private readonly _surfaceHost: HTMLElement;
  private readonly _cmHost: HTMLElement;
  private readonly _textarea: HTMLTextAreaElement;
  private readonly _footerHost: HTMLElement;
  private readonly _disposables = new DisposableStore();
  private readonly _st: SkillEditorState = {
    name: '',
    detail: null,
    loading: false,
    saving: false,
    error: null,
    newFileMode: false,
    draftPath: '',
    draftContent: '',
    copied: false,
    usingCodeMirror: false,
    selectedHistoryId: null,
    historyDiffLoading: false,
    historyDiff: null,
  };
  private _panelCtx: SkillPanelInitContext | null = null;
  private _cmHandle: EditorHandle | null = null;
  private _copyTimer: ReturnType<typeof setTimeout> | undefined;
  private _loadSeq = 0;
  private _mountSeq = 0;
  private _diffSeq = 0;
  private _selectedHistoryContent: string | null = null;
  private _disposed = false;
  private readonly _cb: EditorCallbacks;

  constructor(store: SkillsStore, deps: ResolvedSkillsDeps, ctx?: PluginContext) {
    this._store = store;
    this._deps = deps;
    this._ctx = ctx;
    const doc = deps.doc;

    this.element = doc.createElement('div');
    this.element.className = 'fh-skill-editor';
    this._headerHost = doc.createElement('div');
    this._headerHost.className = 'fh-skill-ed-bar-host';
    this._pageEl = doc.createElement('div');
    this._pageEl.className = 'fh-skill-ed-page';
    this._colEl = doc.createElement('div');
    this._colEl.className = 'fh-skill-ed-col';
    this._chromeHost = doc.createElement('div');
    this._chromeHost.className = 'fh-skill-ed-chrome';
    this._editorBoxEl = doc.createElement('div');
    this._editorBoxEl.className = 'fh-skill-ed-box';
    this._editorBarHost = doc.createElement('div');
    this._editorBarHost.className = 'fh-skill-ed-box-head-host';
    this._surfaceHost = doc.createElement('div');
    this._surfaceHost.className = 'fh-skill-ed-surface';
    this._cmHost = doc.createElement('div');
    this._cmHost.className = 'fh-skill-ed-cm';
    this._cmHost.hidden = true;
    this._textarea = doc.createElement('textarea');
    this._textarea.className = 'fh-textarea fh-skill-ed-textarea skill-text';
    this._textarea.spellcheck = false;
    this._surfaceHost.append(this._cmHost, this._textarea);
    this._editorBoxEl.append(this._editorBarHost, this._surfaceHost);
    this._footerHost = doc.createElement('div');
    this._footerHost.className = 'fh-skill-ed-footer';
    this._colEl.append(this._chromeHost, this._editorBoxEl, this._footerHost);
    this._pageEl.appendChild(this._colEl);
    this.element.append(this._headerHost, this._pageEl);

    this._cb = this._buildCallbacks();
    this._textarea.addEventListener('input', () => {
      this._cb.onContentInput(this._textarea.value);
    });
    this._textarea.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        this._cb.onSave();
      }
    });
  }

  init(params: unknown, ctx: SkillPanelInitContext): void {
    this._panelCtx = ctx;
    this._disposables.add(
      this._store.onDidMutateSkill((ev) => {
        if (this._disposed || !this._st.detail || ev.name !== this._st.detail.skill.name) return;
        const fresh = this._store.find(ev.name);
        if (fresh) {
          this._st.detail = { ...this._st.detail, skill: fresh };
          this._paint();
        }
      }),
    );
    const parsed = parseSkillEditorInput(params);
    if (parsed) {
      void this._loadSkill(parsed.name, parsed.file);
    } else {
      this._st.error = tr('skills.openFailed');
      this._paint();
    }
  }

  update(params: unknown): void {
    const parsed = parseSkillEditorInput(params);
    if (!parsed) return;
    if (parsed.name !== this._st.name || parsed.file !== this._st.detail?.file.path) {
      void this._loadSkill(parsed.name, parsed.file);
    }
  }

  focus(): void {
    if (this._cmHandle) this._cmHandle.focus();
    else this._textarea.focus();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._loadSeq++;
    this._destroyCodeMirror();
    if (this._copyTimer !== undefined) clearTimeout(this._copyTimer);
    this._disposables.dispose();
    render(nothing, this._headerHost);
    render(nothing, this._chromeHost);
    render(nothing, this._editorBarHost);
    render(nothing, this._footerHost);
    this.element.remove();
  }

  private _tSkill(key: string, fallback: string, vars?: Record<string, unknown>): string {
    if (!this._ctx) return fallback;
    const translated = this._ctx.i18n.t(key, vars);
    return translated === key ? fallback : translated;
  }

  private _updateTitle(): void {
    if (!this._panelCtx) return;
    const base = this._st.name || tr('skills.title');
    this._panelCtx.api.setTitle(isEditorDirty(this._st) ? `${base} *` : base);
  }

  private _destroyCodeMirror(): void {
    this._mountSeq++;
    if (this._cmHandle) {
      this._cmHandle.destroy();
      this._cmHandle = null;
    }
    this._st.usingCodeMirror = false;
    this._cmHost.hidden = true;
    this._cmHost.textContent = '';
  }

  private _syncEditorContent(filePath: string, content: string): void {
    this._destroyCodeMirror();
    this._textarea.value = content;
    this._textarea.hidden = false;
    const myMount = ++this._mountSeq;
    void this._deps
      .codeView()
      .then((cv) => {
        if (this._disposed || myMount !== this._mountSeq || !cv) return;
        this._cmHost.textContent = '';
        this._cmHost.hidden = false;
        try {
          this._cmHandle = cv.editor(this._cmHost, {
            doc: this._st.draftContent,
            name: filePath || 'SKILL.md',
            onChange: (nextDoc) => {
              this._st.draftContent = nextDoc;
              this._updateTitle();
              this._paint();
              this._refreshActiveDiff();
            },
            onSave: () => {
              void this._saveCurrentFile();
            },
          });
          this._st.usingCodeMirror = true;
          this._textarea.hidden = true;
        } catch {
          this._destroyCodeMirror();
          this._textarea.value = this._st.draftContent;
          this._textarea.hidden = false;
        }
      })
      .catch(() => {
        // Keep textarea fallback active.
      });
  }

  private _currentDocText(): string {
    return this._cmHandle ? this._cmHandle.getDoc() : this._textarea.value;
  }

  private async _confirmAction(message: string): Promise<boolean> {
    if (this._deps.confirm) return Boolean(await this._deps.confirm(message));
    return openConfirmDialog({
      title: this._st.name || tr('skills.title'),
      body: message,
      danger: true,
      overlays: this._deps.overlays,
      doc: this._deps.doc,
    });
  }

  private async _loadSkill(name: string, file?: string): Promise<void> {
    if (this._disposed || !name) return;
    this._st.name = name;
    this._st.requestedFile = file;
    this._st.loading = true;
    this._st.error = null;
    this._updateTitle();
    this._paint();

    const myLoad = ++this._loadSeq;
    const outcome = await this._store.show(name, file);
    if (this._disposed || myLoad !== this._loadSeq) return;
    this._st.loading = false;
    if (!outcome.ok || !outcome.detail) {
      this._st.error = outcome.error || tr('skills.openFailed');
      this._paint();
      return;
    }
    this._st.detail = outcome.detail;
    this._st.newFileMode = false;
    this._st.draftPath = outcome.detail.file.path;
    this._st.draftContent = outcome.detail.file.content;
    this._st.selectedHistoryId = null;
    this._st.historyDiffLoading = false;
    this._st.historyDiff = null;
    this._selectedHistoryContent = null;
    this._st.error = null;
    this._store.recordSnapshot(name, outcome.detail.file.path, outcome.detail.file.version, outcome.detail.file.content);
    const latestHist = outcome.detail.history[0];
    if (latestHist) {
      this._store.recordSnapshot(name, outcome.detail.file.path, `id:${latestHist.id}`, outcome.detail.file.content);
    }
    this._updateTitle();
    this._paint();
    this._syncEditorContent(this._st.draftPath, this._st.draftContent);
  }

  private async _saveCurrentFile(): Promise<void> {
    if (this._disposed || !this._st.detail || this._st.saving) return;
    const targetPath = this._st.draftPath.trim();
    const content = this._currentDocText();
    if (!targetPath) {
      this._st.error = tr('skills.filePathRequired');
      this._paint();
      return;
    }
    const skillName = this._st.detail.skill.name;
    // Security invariant #8: SKILL.md edits MUST pass the exact version from show().
    if (targetPath === 'SKILL.md' && (this._st.detail.file.path !== 'SKILL.md' || this._st.newFileMode)) {
      this._st.error = tr('skills.openSkillMd');
      this._paint();
      return;
    }
    this._st.saving = true;
    this._st.error = null;
    this._paint();
    const outcome =
      targetPath === 'SKILL.md'
        ? await this._store.patchSkillMd(skillName, this._st.detail.file.version, content)
        : await this._store.writeFile(skillName, targetPath, content);
    if (this._disposed) return;
    this._st.saving = false;
    if (!outcome.ok) {
      this._st.error = outcome.error || tr('common.didNotWork');
      this._paint();
      return;
    }
    await this._loadSkill(skillName, targetPath);
  }

  private async _removeCurrentFile(): Promise<void> {
    if (this._disposed || !this._st.detail || this._st.saving) return;
    const targetPath = this._st.draftPath.trim();
    if (!targetPath || targetPath === 'SKILL.md') return;
    const skillName = this._st.detail.skill.name;
    const ok = await this._confirmAction(tr('skills.confirmRemoveFile', { path: targetPath, name: skillName }));
    if (this._disposed || !ok) return;
    this._st.saving = true;
    this._st.error = null;
    this._paint();
    const outcome = await this._store.removeFile(skillName, targetPath);
    if (this._disposed) return;
    this._st.saving = false;
    if (!outcome.ok) {
      this._st.error = outcome.error || tr('common.didNotWork');
      this._paint();
      return;
    }
    await this._loadSkill(skillName, 'SKILL.md');
  }

  private async _revertEntry(id: string): Promise<void> {
    if (this._disposed || !this._st.detail || this._st.saving) return;
    const skillName = this._st.detail.skill.name;
    const ok = await this._confirmAction(tr('skills.confirmRevert'));
    if (this._disposed || !ok) return;
    this._st.saving = true;
    this._st.error = null;
    this._paint();
    const outcome = await this._store.revert(skillName, id);
    if (this._disposed) return;
    this._st.saving = false;
    if (!outcome.ok) {
      this._st.error = outcome.error || tr('common.didNotWork');
      this._paint();
      return;
    }
    await this._loadSkill(skillName, this._st.detail.file.path);
  }

  private _refreshActiveDiff(): void {
    if (!this._st.selectedHistoryId || !this._st.detail || this._st.historyDiffLoading) return;
    const entry = this._st.detail.history.find((h) => h.id === this._st.selectedHistoryId);
    if (!entry) return;
    const currentDoc = this._currentDocText();
    this._st.historyDiff =
      this._selectedHistoryContent !== null
        ? computeLineDiff(this._selectedHistoryContent, currentDoc)
        : buildMetadataDiff(entry, this._st.detail.skill, this._st.detail.file.content, currentDoc);
    this._paint();
  }

  private async _selectHistoryEntry(entry: SkillPanelHistoryEntry): Promise<void> {
    if (this._disposed || !this._st.detail) return;
    if (this._st.selectedHistoryId === entry.id) {
      this._diffSeq++;
      this._st.selectedHistoryId = null;
      this._st.historyDiffLoading = false;
      this._st.historyDiff = null;
      this._selectedHistoryContent = null;
      this._paint();
      return;
    }
    const myDiff = ++this._diffSeq;
    const detail = this._st.detail;
    const skillName = detail.skill.name;
    const filePath = detail.file.path;
    this._st.selectedHistoryId = entry.id;
    this._st.historyDiffLoading = true;
    this._st.historyDiff = null;
    this._selectedHistoryContent = null;
    this._paint();

    let historicalText: string | null = extractEmbeddedHistoryContent(entry);
    if (historicalText === null && this._deps.loadHistoryContent) {
      try {
        historicalText = (await this._deps.loadHistoryContent(skillName, entry, filePath)) ?? null;
      } catch {
        historicalText = null;
      }
    }
    if (this._disposed || myDiff !== this._diffSeq || !this._st.detail) return;
    if (historicalText === null && entry.beforeVersion) {
      historicalText = this._store.getSnapshot(skillName, filePath, entry.beforeVersion) ?? null;
    }
    if (historicalText === null) {
      historicalText = this._store.getSnapshot(skillName, filePath, `id:${entry.id}`) ?? null;
    }

    this._st.historyDiffLoading = false;
    this._selectedHistoryContent = historicalText;
    const currentDoc = this._currentDocText();
    this._st.historyDiff =
      historicalText !== null
        ? computeLineDiff(historicalText, currentDoc)
        : buildMetadataDiff(entry, this._st.detail.skill, this._st.detail.file.content, currentDoc);
    this._paint();
  }

  private _handleCopyName(): void {
    if (!this._st.detail) return;
    void this._deps.copyText(this._st.detail.skill.name).then((ok) => {
      if (this._disposed) return;
      if (!ok) {
        this._st.error = tr('skills.copyFailed');
        this._paint();
        return;
      }
      this._st.copied = true;
      this._paint();
      if (this._copyTimer !== undefined) clearTimeout(this._copyTimer);
      this._copyTimer = setTimeout(() => {
        this._copyTimer = undefined;
        this._st.copied = false;
        if (!this._disposed) this._paint();
      }, 1200);
    });
  }

  private _handleToggleEnabled(enabled: boolean): void {
    if (!this._st.detail) return;
    const skillName = this._st.detail.skill.name;
    this._st.detail = {
      ...this._st.detail,
      skill: { ...this._st.detail.skill, status: enabled ? 'active' : 'archived' },
    };
    this._paint();
    void this._store.setEnabled(skillName, enabled).then((outcome) => {
      if (this._disposed || outcome.ok) return;
      this._st.error = outcome.error || tr('common.didNotWork');
      const fresh = this._store.find(skillName);
      if (fresh && this._st.detail) this._st.detail = { ...this._st.detail, skill: fresh };
      this._paint();
    });
  }

  private _handleChangeTier(resident: boolean): void {
    if (!this._st.detail || !isSkillActive(this._st.detail.skill) || this._st.detail.skill.resident === resident) {
      return;
    }
    const skillName = this._st.detail.skill.name;
    this._st.detail = { ...this._st.detail, skill: { ...this._st.detail.skill, resident } };
    this._paint();
    void this._store.setResident(skillName, resident).then((outcome) => {
      if (this._disposed || outcome.ok) return;
      this._st.error = outcome.error || tr('common.didNotWork');
      const fresh = this._store.find(skillName);
      if (fresh && this._st.detail) this._st.detail = { ...this._st.detail, skill: fresh };
      this._paint();
    });
  }

  private _handleTogglePin(): void {
    if (!this._st.detail || this._st.saving) return;
    const skillName = this._st.detail.skill.name;
    const pinned = !this._st.detail.skill.pinned;
    this._st.saving = true;
    this._st.error = null;
    this._paint();
    void this._store.setPinned(skillName, pinned).then((outcome) => {
      if (this._disposed) return;
      this._st.saving = false;
      if (!outcome.ok) {
        this._st.error = outcome.error || tr('common.didNotWork');
        this._paint();
        return;
      }
      void this._loadSkill(skillName, this._st.detail?.file.path);
    });
  }

  private _buildCallbacks(): EditorCallbacks {
    return {
      onCopyName: () => this._handleCopyName(),
      onToggleEnabled: (enabled) => this._handleToggleEnabled(enabled),
      onChangeTier: (resident) => this._handleChangeTier(resident),
      onTogglePin: () => this._handleTogglePin(),
      onRefresh: () => {
        if (this._st.name) void this._loadSkill(this._st.name, this._st.detail?.file.path ?? this._st.requestedFile);
      },
      onSelectFile: (path) => {
        if (this._st.detail) void this._loadSkill(this._st.detail.skill.name, path);
      },
      onStartNewFile: () => {
        if (!this._st.detail) return;
        this._st.newFileMode = true;
        this._st.draftPath = '';
        this._st.draftContent = '';
        this._st.error = null;
        this._updateTitle();
        this._paint();
        this._syncEditorContent('notes.md', '');
      },
      onPathInput: (path) => {
        this._st.draftPath = path;
        this._updateTitle();
      },
      onContentInput: (content) => {
        this._st.draftContent = content;
        this._updateTitle();
        this._paint();
        this._refreshActiveDiff();
      },
      onSave: () => {
        void this._saveCurrentFile();
      },
      onDiscard: () => {
        if (!this._st.detail) return;
        this._st.newFileMode = false;
        this._st.draftPath = this._st.detail.file.path;
        this._st.draftContent = this._st.detail.file.content;
        this._st.error = null;
        if (this._cmHandle) this._cmHandle.setDoc(this._st.draftContent);
        this._textarea.value = this._st.draftContent;
        this._updateTitle();
        this._paint();
        this._refreshActiveDiff();
      },
      onRemoveFile: () => {
        void this._removeCurrentFile();
      },
      onRevert: (id) => {
        void this._revertEntry(id);
      },
      onSelectHistory: (entry) => {
        void this._selectHistoryEntry(entry);
      },
      onCloseHistoryDiff: () => {
        this._diffSeq++;
        this._st.selectedHistoryId = null;
        this._st.historyDiffLoading = false;
        this._st.historyDiff = null;
        this._selectedHistoryContent = null;
        this._paint();
      },
      onDismissError: () => {
        this._st.error = null;
        this._paint();
      },
    };
  }

  private _paint(): void {
    if (this._disposed) return;
    if (!this._st.detail) {
      this._editorBoxEl.hidden = true;
      render(nothing, this._headerHost);
      render(nothing, this._editorBarHost);
      render(
        html`
          ${this._st.error
            ? renderNotice({
                tone: 'err',
                message: this._st.error,
                dismissible: true,
                onDismiss: this._cb.onDismissError,
              })
            : nothing}
          ${this._st.loading
            ? renderEmptyState({ title: tr('common.loading') })
            : !this._st.error
              ? renderEmptyState({ title: tr('skills.openFailed') })
              : nothing}
        `,
        this._chromeHost,
      );
      render(nothing, this._footerHost);
      return;
    }

    this._editorBoxEl.hidden = false;
    const tSkill = (k: string, fb: string, vars?: Record<string, unknown>) => this._tSkill(k, fb, vars);
    render(renderEditorTopBar(this._st, this._deps, this._cb), this._headerHost);
    render(
      html`
        ${this._st.error
          ? renderNotice({
              tone: 'err',
              message: this._st.error,
              dismissible: true,
              onDismiss: this._cb.onDismissError,
            })
          : nothing}
        ${renderPropertiesCard(this._st, this._deps, this._cb, tSkill)}
        ${renderFilesBar(this._st, this._deps, this._cb, tSkill)}
      `,
      this._chromeHost,
    );
    render(renderEditorBoxHead(this._st, this._cb, tSkill), this._editorBarHost);

    render(
      html`
        ${renderHistorySection(this._st, this._deps, this._cb, tSkill)}
      `,
      this._footerHost,
    );
  }
}
