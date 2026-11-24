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
  renderStatusDot,
  renderSwitch,
  renderTag,
  renderTextInput,
} from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
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
}

function detailMetaText(skill: SkillPanelEntry, formatAgo: (at: number) => string): string {
  const parts = [`v${skill.version}`, tr('skills.created', { ago: formatIsoAgo(skill.createdAt, formatAgo) })];
  if (skill.status === 'expired') parts.unshift(tr('skills.expired'));
  if (skill.pinned) parts.push(tr('skills.pinned'));
  parts.push(
    skill.lastUsedAt
      ? tr('skills.lastUsed', { ago: formatIsoAgo(skill.lastUsedAt, formatAgo) })
      : tr('skills.neverUsed'),
  );
  parts.push(tr(skill.uses === 1 ? 'skills.useOne' : 'skills.useMany', { count: skill.uses }));
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
  readonly onRemoveFile: () => void;
  readonly onRevert: (id: string) => void;
  readonly onDismissError: () => void;
}

function renderEditorHeader(
  st: SkillEditorState,
  deps: ResolvedSkillsDeps,
  cb: EditorCallbacks,
): TemplateResult {
  const detail = st.detail!;
  const skill = detail.skill;
  const active = isSkillActive(skill);
  const dotStatus = !active ? 'idle' : skill.status === 'expired' ? 'warn' : 'ok';
  const icons = deps.icons();
  const copyLabel = st.copied ? tr('common.copied') : tr('skills.copyName');
  const copySvg = getSkillIcon(icons, st.copied ? 'check' : 'copy');

  return html`
    <div class="fh-skill-ed-head">
      <div class="fh-skill-ed-title-row">
        ${renderStatusDot({ status: dotStatus })}
        <h2 class="fh-skill-ed-name">${skill.name}</h2>
        <button
          type="button"
          class="fh-btn fh-btn--ghost fh-btn--icon fh-skill-copy"
          data-copy-skill=${skill.name}
          title=${copyLabel}
          aria-label=${copyLabel}
          @click=${cb.onCopyName}
        >${renderInlineSvg(copySvg)}</button>
        ${renderTag({ label: `v${skill.version}`, tone: 'neutral' })}
        ${skill.status === 'expired'
          ? renderTag({ label: tr('skills.expiredCap'), tone: 'warn', title: tr('skills.expiredTitle') })
          : nothing}
        ${skill.category ? renderTag({ label: skill.category, tone: 'neutral' }) : nothing}
      </div>
      <div class="fh-skill-ed-controls">
        ${renderSegmented({
          kind: 'value',
          ariaLabel: tr('skills.tierAria'),
          value: skill.resident ? 'resident' : 'library',
          options: [
            {
              value: 'resident',
              label: tr('skills.tabResident'),
              title: tr('skills.tierResidentTitle'),
              disabled: !active || st.saving,
            },
            {
              value: 'library',
              label: tr('skills.tabLibrary'),
              title: tr('skills.tierLibraryTitle'),
              disabled: !active || st.saving,
            },
          ],
          onChange: (val) => cb.onChangeTier(val === 'resident'),
        })}
        ${renderSwitch({
          checked: active,
          label: active ? tr('common.onCap') : tr('common.offCap'),
          ariaLabel: active ? tr('skills.onTitle') : tr('skills.offTitle'),
          disabled: st.saving,
          onChange: cb.onToggleEnabled,
        })}
        <button
          type="button"
          class="fh-btn fh-btn--secondary"
          data-sop="pin"
          ?disabled=${st.saving}
          @click=${cb.onTogglePin}
        >${skill.pinned ? tr('skills.unpin') : tr('skills.pin')}</button>
        <button
          type="button"
          class="fh-btn fh-btn--ghost fh-btn--icon"
          data-sop="refresh"
          title=${tr('skills.refreshTitle')}
          aria-label=${tr('skills.refreshTitle')}
          ?disabled=${st.loading || st.saving}
          @click=${cb.onRefresh}
        >${renderInlineSvg(getSkillIcon(icons, 'refresh'))}</button>
      </div>
    </div>
    <div class="fh-skill-ed-desc">${skill.description || tr('skills.noDesc')}</div>
    <div class="fh-skill-ed-meta">${detailMetaText(skill, deps.formatAgo)}</div>
    ${skill.warning ? renderNotice({ tone: 'warn', message: skill.warning }) : nothing}
    ${skill.problem
      ? renderNotice({ tone: 'err', message: `${tr('skills.notDelivered')}${skill.problem}` })
      : nothing}
  `;
}

function renderFilesBar(
  st: SkillEditorState,
  deps: ResolvedSkillsDeps,
  cb: EditorCallbacks,
): TemplateResult {
  const detail = st.detail!;
  const currentPath = st.newFileMode ? '' : detail.file.path;
  return html`
    <div class="fh-skill-ed-section">${tr('skills.files')}</div>
    <div class="fh-skill-ed-files">
      ${detail.files.map(
        (f) => html`<button
          type="button"
          class=${`fh-btn fh-btn--secondary fh-skill-file${currentPath === f.path ? ' is-active' : ''}`}
          data-file=${f.path}
          ?disabled=${st.loading || st.saving}
          @click=${() => cb.onSelectFile(f.path)}
        ><span>${f.path}</span><small>${deps.formatBytes(f.size)}</small></button>`,
      )}
      <button
        type="button"
        class="fh-btn fh-btn--ghost"
        data-sop="new-file"
        ?disabled=${st.loading || st.saving}
        @click=${cb.onStartNewFile}
      >${tr('skills.newFile')}</button>
    </div>
  `;
}

function renderHistorySection(
  st: SkillEditorState,
  deps: ResolvedSkillsDeps,
  cb: EditorCallbacks,
): TemplateResult {
  const history = st.detail!.history;
  return html`
    <div class="fh-skill-ed-section">${tr('skills.history')}</div>
    <div class="fh-skill-ed-history">
      ${history.length === 0
        ? html`<div class="fh-skill-ed-empty">${tr('skills.noHistory')}</div>`
        : history.map(
            (entry) => html`<div class="fh-skill-hist-row">
              <div class="fh-skill-hist-main">
                <div class="fh-skill-hist-action">${entry.action}</div>
                <div class="fh-skill-hist-meta">${historyMetaText(entry, deps.formatAgo)}</div>
              </div>
              ${entry.beforeVersion || entry.action === 'commit'
                ? html`<button
                    type="button"
                    class="fh-btn fh-btn--secondary"
                    data-revert=${entry.id}
                    ?disabled=${st.saving}
                    @click=${() => cb.onRevert(entry.id)}
                  >${tr('skills.restoreVersion')}</button>`
                : nothing}
            </div>`,
          )}
    </div>
  `;
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
): SkillPanelComponent {
  return new SkillEditorPanel(store, deps);
}

class SkillEditorPanel implements SkillPanelComponent {
  readonly element: HTMLElement;
  private readonly _store: SkillsStore;
  private readonly _deps: ResolvedSkillsDeps;
  private readonly _chromeHost: HTMLElement;
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
  };
  private _panelCtx: SkillPanelInitContext | null = null;
  private _cmHandle: EditorHandle | null = null;
  private _copyTimer: ReturnType<typeof setTimeout> | undefined;
  private _loadSeq = 0;
  private _mountSeq = 0;
  private _disposed = false;
  private readonly _cb: EditorCallbacks;

  constructor(store: SkillsStore, deps: ResolvedSkillsDeps) {
    this._store = store;
    this._deps = deps;
    const doc = deps.doc;

    this.element = doc.createElement('div');
    this.element.className = 'fh-skill-editor';
    this._chromeHost = doc.createElement('div');
    this._chromeHost.className = 'fh-skill-ed-chrome';
    this._surfaceHost = doc.createElement('div');
    this._surfaceHost.className = 'fh-skill-ed-surface';
    this._cmHost = doc.createElement('div');
    this._cmHost.className = 'fh-skill-ed-cm';
    this._cmHost.hidden = true;
    this._textarea = doc.createElement('textarea');
    this._textarea.className = 'fh-textarea fh-skill-ed-textarea skill-text';
    this._textarea.spellcheck = false;
    this._surfaceHost.append(this._cmHost, this._textarea);
    this._footerHost = doc.createElement('div');
    this._footerHost.className = 'fh-skill-ed-footer';
    this.element.append(this._chromeHost, this._surfaceHost, this._footerHost);

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
    render(nothing, this._chromeHost);
    render(nothing, this._footerHost);
    this.element.remove();
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
    this._st.error = null;
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
      },
      onSave: () => {
        void this._saveCurrentFile();
      },
      onRemoveFile: () => {
        void this._removeCurrentFile();
      },
      onRevert: (id) => {
        void this._revertEntry(id);
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
      this._surfaceHost.hidden = true;
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

    this._surfaceHost.hidden = false;
    const isSkillMd = !this._st.newFileMode && this._st.detail.file.path === 'SKILL.md';
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
        ${renderEditorHeader(this._st, this._deps, this._cb)}
        ${renderFilesBar(this._st, this._deps, this._cb)}
        <div class="fh-skill-ed-section">${this._st.newFileMode ? tr('skills.newFile') : this._st.detail.file.path}</div>
        <div class="fh-skill-ed-path">
          ${renderTextInput({
            id: 'fh-skill-ed-path',
            value: this._st.draftPath,
            placeholder: 'references/notes.md',
            ariaLabel: tr('skills.files'),
            readonly: isSkillMd,
            disabled: this._st.saving,
            onInput: this._cb.onPathInput,
          })}
        </div>
      `,
      this._chromeHost,
    );

    render(
      html`
        <div class="fh-skill-ed-actions">
          <button
            type="button"
            class="fh-btn fh-btn--primary"
            data-sop="save"
            ?disabled=${this._st.saving || this._st.loading}
            @click=${this._cb.onSave}
          >${this._st.saving ? tr('common.saving') : tr('common.save')}</button>
          ${!isSkillMd && !this._st.newFileMode
            ? html`<button
                type="button"
                class="fh-btn fh-btn--danger"
                data-sop="remove-file"
                ?disabled=${this._st.saving || this._st.loading}
                @click=${this._cb.onRemoveFile}
              >${tr('skills.removeFile')}</button>`
            : nothing}
        </div>
        ${renderHistorySection(this._st, this._deps, this._cb)}
      `,
      this._footerHost,
    );
  }
}
