import { addDisposableListener, focusSafely } from '../../../base/dom.js';
import { DisposableStore } from '../../../base/lifecycle.js';
import {
  createMenu,
  openQuickPick,
  type MenuController,
  type MenuEntry,
  type QuickPickController,
  type QuickPickItem,
} from '../../../components/index.js';
import { t as tr } from '../../../i18n/index.js';
import type { ComposerController } from '../composer/index.js';
import { createComposerController } from '../composer/index.js';
import type { TopicStatusController } from '../status/index.js';
import { createTopicStatusController } from '../status/index.js';
import type { TranscriptController } from '../transcript/index.js';
import { createTranscriptController, extractMessageMarkdown } from '../transcript/index.js';
import { buildTopicEditorDom, resolveTopicEditorIcons } from './dom.js';
import { createTopicHeaderController, type TopicHeaderController } from './header.js';
import {
  parseTopicEditorInput,
  type MessageMenuTarget,
  type TopicEditorDeps,
  type TopicEditorElements,
  type TopicEditorHandle,
  type TopicEditorIcons,
  type TopicEditorMenuEntry,
  type TopicPanelInitContext,
  type TopicStreamState,
} from './types.js';

function buildMessageMenuEntries(
  groups: readonly (readonly TopicEditorMenuEntry[])[],
  target: MessageMenuTarget,
  resolveIcon?: (name: string) => string,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const group of groups) {
    if (!group || group.length === 0) continue;
    if (entries.length > 0) entries.push({ kind: 'separator' });
    for (const resolved of group) {
      const iconSvg = resolved.item.icon
        ? resolveIcon
          ? resolveIcon(resolved.item.icon)
          : resolved.item.icon
        : undefined;
      entries.push({
        id: resolved.item.id,
        label: resolved.item.label,
        icon: iconSvg,
        title: resolved.disabledReason ?? resolved.item.title,
        disabled: resolved.disabled,
        danger: resolved.item.danger,
        onSelect: () => {
          void resolved.item.run(target);
        },
      });
    }
  }
  return entries;
}

export class TopicEditorPanel implements TopicEditorHandle {
  readonly element: HTMLElement;
  readonly els: TopicEditorElements;

  private readonly _doc: Document;
  private readonly _win: Window;
  private readonly _icons: TopicEditorIcons;
  private readonly _listeners = new DisposableStore();
  private _header: TopicHeaderController | null = null;
  private _messageMenu: MenuController | null = null;
  private _activeQuickPick: QuickPickController<string> | null = null;
  private _panelCtx: TopicPanelInitContext | null = null;
  private _topicId = '';
  private _streamState: TopicStreamState;
  private _disposed = false;

  private _transcript: TranscriptController | null = null;
  private _status: TopicStatusController | null = null;
  private _composer: ComposerController | null = null;

  constructor(private readonly _deps: TopicEditorDeps) {
    this._doc = _deps.doc ?? document;
    this._win = _deps.win ?? window;
    this._icons = resolveTopicEditorIcons(_deps.icons);
    this._streamState = _deps.getStreamState?.() ?? 'open';
    this.els = buildTopicEditorDom(this._doc, this._icons);
    this.element = this.els.root;
  }

  get transcript(): TranscriptController | null {
    return this._transcript;
  }

  get status(): TopicStatusController | null {
    return this._status;
  }

  get composer(): ComposerController | null {
    return this._composer;
  }

  getTopicId(): string {
    return this._topicId;
  }

  getPanelId(): string | undefined {
    return this._panelCtx?.id;
  }

  init(params: unknown, ctx: TopicPanelInitContext): void {
    if (this._disposed) return;
    if (this._panelCtx !== null) {
      this._panelCtx = ctx;
      if (params !== undefined) this.update(params);
      else this.refreshHeader();
      return;
    }
    this._panelCtx = ctx;
    this._topicId = parseTopicEditorInput(params);
    this.els.root.dataset.topicId = this._topicId;

    this._header = createTopicHeaderController({
      els: this.els,
      doc: this._doc,
      win: this._win,
      overlays: this._deps.overlays,
      resolveIcon: (name) => this._resolveIcon(name),
      getTopicTools: this._deps.getTopicTools,
      onToggleTopicTool: this._deps.onToggleTopicTool,
      getTitleMenuGroups: this._deps.getTitleMenuGroups,
      onBack: this._deps.onBack,
      onToggleSidebar: this._deps.onToggleSidebar,
    });

    this._initSubControllers();
    this._wireQuickPickInterception();
    this._wireMessageContextMenu();
    this._listeners.add(
      addDisposableListener(this.els.powerBtn, 'click', () => {
        this._composer?.command('/kill');
      }),
    );

    if (this._topicId) {
      this._composer?.loadDraft(this._topicId);
    }
    this.refreshHeader();
    this._deps.onMount?.(this);
  }

  update(params: unknown): void {
    if (this._disposed) return;
    const nextId = parseTopicEditorInput(params);
    if (nextId === this._topicId) {
      this.refreshHeader();
      return;
    }
    const prevId = this._topicId;
    if (prevId) {
      this._composer?.stashDraft(prevId);
    }
    this._header?.closeMenu();
    this._messageMenu?.close(false);
    this._closeQuickPick();
    this._status?.closeModelPop();
    this._transcript?.resetForTopicSwitch(nextId);

    this._topicId = nextId;
    this.els.root.dataset.topicId = nextId;

    if (nextId) {
      this._composer?.loadDraft(nextId);
    } else if (this.els.input.value) {
      this.els.input.value = '';
    }
    this._deps.onTopicChange?.(nextId, prevId);
    this.refreshHeader();
  }

  refreshHeader(): void {
    if (this._disposed) return;
    const topic = this._topicId ? this._deps.getTopicInfo(this._topicId) : undefined;
    const title = topic?.title || tr('common.untitled');
    this._panelCtx?.api.setTitle(title);
    this._header?.refresh(topic, this._streamState);
    this.els.stopBtn.hidden = !topic?.running;
    this.els.composerForm.classList.toggle('is-running', Boolean(topic?.running));
    this._syncStatusRow(topic?.dir, topic?.live, topic?.agent?.harness);
  }

  private _syncStatusRow(
    dir: { readonly name?: string; readonly path?: string } | undefined,
    live: boolean | undefined,
    harness: string | undefined,
  ): void {
    const dirText = dir?.path || dir?.name || '';
    this.els.dirEl.textContent = dirText;
    this.els.dirEl.title = dir?.path || dirText;
    this.els.dirEl.hidden = !dirText;
    this.els.powerBtn.hidden = !live;
    if (harness) {
      this.els.statusRowEl.dataset.harness = harness;
    } else {
      delete this.els.statusRowEl.dataset.harness;
    }
  }

  setStreamState(state: TopicStreamState): void {
    if (this._disposed || this._streamState === state) return;
    this._streamState = state;
    this.refreshHeader();
  }

  openTitleMenu(): void {
    if (this._disposed) return;
    this._header?.openMenu();
  }

  insertIntoComposer(text: string): void {
    if (this._disposed || !text) return;
    const input = this.els.input;
    const current = input.value;
    const sep = current && !/\s$/.test(current) ? '\n' : '';
    input.value = `${current}${sep}${text}`;
    const end = input.value.length;
    try {
      input.setSelectionRange(end, end);
    } catch {
      // Ignore selection errors when textarea is detached.
    }
    if (this._composer) {
      this._composer.grow();
      this._composer.suggest();
      if (this._topicId) this._composer.stashDraft(this._topicId);
    } else {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    focusSafely(input);
  }

  async openModelQuickPick(optId: string | null = null): Promise<boolean> {
    const adapter = this._deps.quickPick;
    const topicId = this._topicId;
    if (this._disposed || !adapter || !topicId) return false;
    this._closeQuickPick();

    if (optId) {
      if (!adapter.listOptionChoices || !adapter.selectOption) return false;
      const result = await adapter.listOptionChoices(topicId, optId);
      const items: QuickPickItem<string>[] = result.items.map((o) => ({
        id: o.value,
        label: o.name || o.value,
        description: o.current ? tr('common.on') : o.description,
        data: o.value,
      }));
      const qp = openQuickPick<string>({
        items,
        placeholder: result.title || tr('common.filter'),
        overlays: this._deps.overlays,
        doc: this._doc,
      });
      this._activeQuickPick = qp;
      const picked = await qp.promise;
      if (this._activeQuickPick === qp) this._activeQuickPick = null;
      if (picked?.data !== undefined) {
        await adapter.selectOption(topicId, optId, picked.data);
      }
      return true;
    }

    if (!adapter.listModels || !adapter.selectModel) return false;
    const models = await adapter.listModels(topicId);
    const items: QuickPickItem<string>[] = models.map((m) => ({
      id: m.value,
      label: m.value,
      description: m.name && m.name !== m.value ? m.name : undefined,
      detail: m.configured ? tr('chat.defaultTag') : undefined,
      data: m.value,
    }));
    const qp = openQuickPick<string>({
      items,
      placeholder: tr('modelPop.filterModels'),
      overlays: this._deps.overlays,
      doc: this._doc,
    });
    this._activeQuickPick = qp;
    const picked = await qp.promise;
    if (this._activeQuickPick === qp) this._activeQuickPick = null;
    if (picked?.data !== undefined) {
      await adapter.selectModel(topicId, picked.data);
    }
    return true;
  }

  focus(): void {
    if (this._disposed) return;
    focusSafely(this.els.input);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._topicId) {
      this._composer?.stashDraft(this._topicId);
    }
    this._deps.onDispose?.(this);
    this._closeQuickPick();
    this._messageMenu?.dispose();
    this._messageMenu = null;
    this._header?.dispose();
    this._header = null;
    this._transcript?.dispose();
    this._transcript = null;
    this._status?.dispose();
    this._status = null;
    this._composer?.dispose();
    this._composer = null;
    this._listeners.dispose();
    this.element.remove();
  }

  private _resolveIcon(name: string): string {
    if (name.startsWith('<svg')) return name;
    const resolved = this._deps.resolveIcon?.(name);
    if (resolved) return resolved;
    const map = this._icons as unknown as Readonly<Record<string, string | undefined>>;
    return map[name] ?? '';
  }

  private _initSubControllers(): void {
    const getTopicId = (): string => this._topicId;
    const factories = this._deps.controllers;

    if (factories?.createTranscript) {
      this._transcript = factories.createTranscript(this.els, getTopicId);
    } else if (this._deps.transcriptDeps) {
      const baseDeps = this._deps.transcriptDeps(this.els, getTopicId);
      this._transcript = createTranscriptController({
        ...baseDeps,
        quoteToComposer: baseDeps.quoteToComposer ?? ((text) => this.insertIntoComposer(text)),
        openMessageMenu: baseDeps.openMessageMenu ?? ((key, anchor) => this._openMessageMenuFromAnchor(key, anchor)),
        openTurnDiffSideBySide:
          baseDeps.openTurnDiffSideBySide ??
          (this._deps.onOpenTurnDiffSideBySide
            ? (turn) => this._deps.onOpenTurnDiffSideBySide!(this._topicId, turn, this._panelCtx?.id)
            : undefined),
        canOpenSideDiff: baseDeps.canOpenSideDiff ?? this._deps.canOpenSideDiff,
      });
      this._transcript.attachEvents(this._doc);
    }

    if (factories?.createStatus) {
      this._status = factories.createStatus(this.els, getTopicId);
    } else if (this._deps.statusDeps) {
      this._status = createTopicStatusController(this._deps.statusDeps(this.els, getTopicId));
      this._status.attach();
    }

    if (factories?.createComposer) {
      this._composer = factories.createComposer(this.els, getTopicId);
    } else if (this._deps.composerDeps) {
      this._composer = createComposerController(this._deps.composerDeps(this.els, getTopicId));
      this._composer.attach();
    }
  }

  private _wireQuickPickInterception(): void {
    if (!this._deps.quickPick) return;
    this._listeners.add(
      addDisposableListener(
        this.els.statusEl,
        'click',
        (ev: MouseEvent) => {
          const target = ev.target;
          if (!(target instanceof Element)) return;
          if (target.closest('.st-perm')) return;
          const optBtn = target.closest<HTMLButtonElement>('.st-opt');
          if (optBtn && !optBtn.disabled && this._deps.quickPick?.listOptionChoices) {
            const oid = optBtn.getAttribute('data-opt');
            if (!oid) return;
            ev.preventDefault();
            ev.stopImmediatePropagation();
            void this.openModelQuickPick(oid);
            return;
          }
          if (target.closest('.st-model') && this._deps.quickPick?.listModels) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            void this.openModelQuickPick(null);
          }
        },
        true,
      ),
    );
  }

  private _wireMessageContextMenu(): void {
    if (!this._deps.getMessageMenuGroups) return;
    this._messageMenu = createMenu({
      doc: this._doc,
      win: this._win,
      overlays: this._deps.overlays,
      align: 'start',
      className: 'wb-topic-message-menu',
    });
    this._listeners.add(
      addDisposableListener(this.els.log, 'contextmenu', (ev: MouseEvent) => {
        const target = ev.target;
        if (!(target instanceof Element)) return;
        const msgEl = target.closest<HTMLElement>('[data-k]');
        if (!msgEl) return;
        if (this._openMessageMenuForElement(msgEl, { x: ev.clientX, y: ev.clientY })) {
          ev.preventDefault();
        }
      }),
    );
  }

  private _openMessageMenuFromAnchor(key: string, anchor: HTMLElement): void {
    const msgEl =
      anchor.closest<HTMLElement>('[data-k]') ??
      Array.from(this.els.log.children).find(
        (c): c is HTMLElement => c instanceof HTMLElement && c.getAttribute('data-k') === key,
      ) ??
      null;
    if (!msgEl) return;
    this._openMessageMenuForElement(msgEl, anchor);
  }

  private _openMessageMenuForElement(
    msgEl: HTMLElement,
    anchor: HTMLElement | { readonly x: number; readonly y: number },
  ): boolean {
    if (!this._deps.getMessageMenuGroups || !this._messageMenu) return false;
    const messageKey = msgEl.getAttribute('data-k') ?? '';
    const msg =
      messageKey && typeof this._transcript?.getMessage === 'function'
        ? this._transcript.getMessage(messageKey)
        : undefined;
    const payload: MessageMenuTarget = {
      topicId: this._topicId,
      messageKey,
      text: msg ? extractMessageMarkdown(msg, msgEl) : (msgEl.textContent ?? '').trim(),
      element: msgEl,
    };
    const groups = this._deps.getMessageMenuGroups(payload);
    const entries = buildMessageMenuEntries(groups, payload, (name) => this._resolveIcon(name));
    if (entries.length === 0) return false;
    this._messageMenu.open(anchor, entries);
    return true;
  }

  private _closeQuickPick(): void {
    if (!this._activeQuickPick) return;
    this._activeQuickPick.dispose();
    this._activeQuickPick = null;
  }
}

export function createTopicEditorPanel(deps: TopicEditorDeps): TopicEditorHandle {
  return new TopicEditorPanel(deps);
}
