import { addDisposableListener } from '../../../base/dom.js';
import { DisposableStore } from '../../../base/lifecycle.js';
import { createAttachmentsController } from './attachments.js';
import { copyText, createCopyRefController } from './clipboard.js';
import { createDraftStore } from './drafts.js';
import { createSlashHintsController } from './slash-hints.js';
import type { ComposerAttachment, ComposerController, ComposerDeps } from './types.js';
import { createUnsentController } from './unsent.js';
import { createVoiceController } from './voice.js';

export * from './types.js';
export * from './image-shrink.js';
export * from './attachments.js';
export * from './drafts.js';
export * from './voice.js';
export * from './slash-hints.js';
export * from './clipboard.js';
export * from './unsent.js';

class ComposerControllerImpl implements ComposerController {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly listeners = new DisposableStore();
  private readonly drafts: ReturnType<typeof createDraftStore>;
  private readonly slashHints: ReturnType<typeof createSlashHintsController>;
  private readonly attachments: ReturnType<typeof createAttachmentsController>;
  private readonly copyRef: ReturnType<typeof createCopyRefController>;
  private readonly unsent: ReturnType<typeof createUnsentController>;
  private readonly voice: ReturnType<typeof createVoiceController>;
  private lastGrowLen = 0;
  private lastGrowHeight = 0;
  private singleLineHeight = 0;

  constructor(private readonly deps: ComposerDeps) {
    this.doc = deps.doc ?? document;
    this.win = deps.win ?? window;
    const storage = deps.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    this.drafts = createDraftStore(storage);
    this.slashHints = createSlashHintsController({
      input: deps.els.input,
      hints: deps.els.hints,
      onPick: () => this.grow(),
    });
    this.attachments = createAttachmentsController({
      chips: deps.els.chips,
      picker: deps.els.picker,
      attachBtn: deps.els.attachBtn,
      note: deps.els.note,
      doc: this.doc,
      getTopic: deps.getTopic,
      isHistoryOpen: deps.isHistoryOpen,
      openShot: deps.openShot,
      appendDraftFile: (topicId, file) => this.drafts.appendFile(topicId, file),
      onQueuedSendReady: () => this.send(),
    });
    this.copyRef = createCopyRefController({
      copyRefBtn: deps.els.copyRefBtn,
      note: deps.els.note,
      instanceId: deps.instanceId,
      doc: this.doc,
      isHistoryOpen: deps.isHistoryOpen,
      getHistoryRef: deps.getHistoryRef,
      getTopic: deps.getTopic,
      topicById: deps.topicById,
      getIcons: deps.getIcons,
    });
    this.unsent = createUnsentController({
      doc: this.doc,
      storage,
      getTopic: deps.getTopic,
      topicById: deps.topicById,
      getEpoch: deps.getEpoch,
      settleAdopted: deps.settleAdopted,
      cacheSave: deps.cacheSave,
      copyText: (value, done) => copyText(value, done, navigator, this.doc),
      topicStatus: deps.topicStatus,
      transcript: deps.transcript,
      postFn: deps.postFn,
      now: deps.now,
    });
    this.voice = createVoiceController({
      micBtn: deps.els.micBtn,
      note: deps.els.note,
      overlays: deps.overlays,
      doc: this.doc,
      win: this.win,
      getTopic: deps.getTopic,
      getIcons: deps.getIcons,
      appendDictation: (into, dictated) => this.appendDictation(into, dictated),
      dispatchAudio: (audioFiles) => this.unsent.dispatch('', audioFiles),
      postFn: deps.postFn,
      now: deps.now,
    });
  }

  grow(): void {
    const input = this.deps.els.input;
    const len = input.value.length;
    const shrank = len < this.lastGrowLen;
    this.lastGrowLen = len;
    // Avoid forcing a full-document reflow via height='auto' when the textarea cannot shrink.
    if (!shrank && this.lastGrowHeight > 0) {
      const sh = input.scrollHeight;
      if (sh === this.lastGrowHeight) return;
      if (sh > this.lastGrowHeight) {
        input.style.height = `${sh}px`;
        this.lastGrowHeight = sh;
        return;
      }
    }
    if (shrank && this.singleLineHeight > 0 && this.lastGrowHeight <= this.singleLineHeight) {
      return;
    }
    input.style.height = 'auto';
    const next = input.scrollHeight;
    input.style.height = `${next}px`;
    this.lastGrowHeight = next;
    if (len === 0 && next > 0) this.singleLineHeight = next;
  }

  renderChips(): void {
    this.attachments.renderChips();
  }

  stashDraft(id: string): void {
    this.drafts.stash(
      id,
      this.deps.els.input.value,
      this.deps.els.input.selectionStart,
      this.deps.els.input.selectionEnd,
      this.attachments.getFiles(),
    );
  }

  loadDraft(id: string): void {
    const d = id ? this.drafts.get(id) : undefined;
    const next = d ? d.text : '';
    const list = d ? d.files : [];
    const chipsChange = this.attachments.getFiles().length > 0 || list.length > 0;
    this.attachments.setFiles(list);
    if (chipsChange) this.attachments.renderChips();
    if (this.deps.els.input.value !== next) {
      this.deps.els.input.value = next;
      this.slashHints.suggest();
      this.grow();
    }
    if (d) {
      try {
        this.deps.els.input.setSelectionRange(d.s, d.e);
      } catch {
        // Ignore selection errors on unfocused or hidden inputs.
      }
    }
    this.attachments.notePending();
  }

  loadDraftIfEmpty(id: string): void {
    if (this.drafts.has(id) && !this.deps.els.input.value && !this.attachments.getFiles().length) {
      this.loadDraft(id);
    }
  }

  seedDraft(id: string, draftText: string): void {
    this.drafts.seed(id, draftText);
    this.loadDraft(id);
  }

  hasDraft(id: string): boolean {
    return this.drafts.has(id);
  }

  recallContent(content: string): void {
    if (!this.deps.els.input.value.trim()) {
      this.deps.els.input.value = content;
      this.grow();
      this.stashDraft(this.deps.getTopic());
      this.deps.els.input.focus();
    }
  }

  private appendDictation(into: string, dictated: string): void {
    if (!dictated) return;
    const curTopic = this.deps.getTopic();
    if (into && into !== curTopic) {
      this.drafts.appendText(into, dictated);
      return;
    }
    const cur = this.deps.els.input.value;
    const sep = cur && !/\s$/.test(cur) ? ' ' : '';
    this.deps.els.input.value = `${cur}${sep}${dictated}`;
    this.deps.els.input.selectionStart = this.deps.els.input.selectionEnd = this.deps.els.input.value.length;
    this.grow();
    if (curTopic) this.stashDraft(curTopic);
    this.deps.els.input.focus();
  }

  setCommands(list: Parameters<ComposerController['setCommands']>[0]): void {
    this.slashHints.setCommands(list);
  }

  suggest(): void {
    this.slashHints.suggest();
  }

  isHintsOpen(): boolean {
    return this.slashHints.isOpen();
  }

  closeHints(): void {
    this.slashHints.close();
  }

  isRecording(): boolean {
    return this.voice.isRecording();
  }

  micLabel(): void {
    this.voice.micLabel();
  }

  stopRec(keep: boolean): void {
    this.voice.stopRec(keep);
  }

  send(): void {
    const curTopic = this.deps.getTopic();
    if (this.attachments.hasPending(curTopic)) {
      this.attachments.queueSend(curTopic);
      return;
    }
    const typed = this.deps.els.input.value;
    if (!typed.trim() && !this.attachments.getFiles().length) return;
    const attached = this.attachments.clearFiles();
    this.deps.els.input.value = '';
    this.attachments.renderChips();
    this.slashHints.suggest();
    this.grow();
    this.unsent.dispatch(typed, attached);
    this.stashDraft(curTopic);
  }

  command(cmdText: string): void {
    if (this.deps.getTopic()) this.unsent.dispatch(cmdText, []);
  }

  dispatch(typed: string, attached: readonly ComposerAttachment[]): void {
    this.unsent.dispatch(typed, attached);
  }

  deliver(nonce: string): void {
    this.unsent.deliver(nonce);
  }

  setLocal(nonce: string, state: Parameters<ComposerController['setLocal']>[1]): void {
    this.unsent.setLocal(nonce, state);
  }

  hasOutbox(nonce: string): boolean {
    return this.unsent.hasOutbox(nonce);
  }

  dropUnsent(nonce: string): void {
    this.unsent.dropUnsent(nonce);
  }

  retireLocalNonce(nonce: string): void {
    this.unsent.retireLocalNonce(nonce);
  }

  showUnsent(topicId: string): void {
    this.unsent.showUnsent(topicId);
  }

  settleUnsure(): void {
    this.unsent.settleUnsure();
  }

  adoptLegacy(msg: Parameters<ComposerController['adoptLegacy']>[0]): boolean {
    return this.unsent.adoptLegacy(msg);
  }

  claim(msg: Parameters<ComposerController['claim']>[0]): void {
    this.unsent.claim(msg);
  }

  copyLocal(nonce: string, btn: HTMLElement): void {
    this.unsent.copyLocal(nonce, btn);
  }

  discardLocal(nonce: string): void {
    this.unsent.discardLocal(nonce);
  }

  copyText(value: string, done: (ok: boolean) => void): void {
    copyText(value, done, navigator, this.doc);
  }

  syncCopyRef(): void {
    this.copyRef.syncCopyRef();
  }

  copyTopicRef(id: string): void {
    this.copyRef.copyTopicRef(id);
  }

  forgetTopic(id: string): void {
    this.unsent.forgetTopic(id);
    this.drafts.forget(id);
  }

  pruneTopics(known: Readonly<Record<string, unknown>>): void {
    this.drafts.prune(known);
    this.unsent.pruneTopics(known);
  }

  keepOnly(keep: Readonly<Record<string, unknown>>): void {
    this.drafts.keepOnly(keep);
    this.unsent.keepOnly(keep);
  }

  onLocaleChange(): void {
    this.voice.micLabel();
  }

  attach(): void {
    this.listeners.add(this.attachments.attach());
    this.listeners.add(this.drafts.attachWindowEvents(this.doc, this.win, () => this.stashDraft(this.deps.getTopic())));
    this.listeners.add(this.voice.attach());
    this.listeners.add(this.slashHints.attach());
    this.listeners.add(this.copyRef.attach());

    this.listeners.add(
      addDisposableListener(this.deps.els.input, 'input', () => {
        this.grow();
        this.slashHints.suggest();
        this.drafts.scheduleStash(() => this.stashDraft(this.deps.getTopic()));
      }),
    );
    this.listeners.add(
      addDisposableListener(this.deps.els.input, 'keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.send();
          return;
        }
        if (e.shiftKey || e.altKey || this.deps.isNarrow()) return;
        e.preventDefault();
        this.send();
      }),
    );
    if (this.deps.els.composerForm) {
      this.listeners.add(
        addDisposableListener(this.deps.els.composerForm, 'submit', (e) => {
          e.preventDefault();
          this.send();
        }),
      );
    }
    if (this.deps.els.killBtn) {
      this.listeners.add(
        addDisposableListener(this.deps.els.killBtn, 'click', () => {
          this.command('/kill');
        }),
      );
    }
    if (this.deps.els.stopBtn) {
      this.listeners.add(
        addDisposableListener(this.deps.els.stopBtn, 'click', () => {
          this.command('/stop');
        }),
      );
    }
  }

  dispose(): void {
    this.listeners.dispose();
    this.drafts.clearTimer();
    this.voice.dispose();
    this.copyRef.dispose();
  }
}

export function createComposerController(deps: ComposerDeps): ComposerController {
  return new ComposerControllerImpl(deps);
}
