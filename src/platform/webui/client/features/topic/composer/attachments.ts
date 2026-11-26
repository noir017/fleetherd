import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import { readBase64, shrinkPhoto, willShrink, withMime } from './image-shrink.js';
import type { ComposerAttachment } from './types.js';

export function formatPastedName(mime: string | undefined, seq: number): string {
  const type = mime || 'image/png';
  const slash = type.indexOf('/');
  const raw = slash > 0 ? type.slice(slash + 1) : 'png';
  const ext = raw.split(';')[0]?.split('+')[0] || 'png';
  return `pasted-${seq}.${ext}`;
}

export interface AttachmentsDeps {
  readonly chips: HTMLElement;
  readonly picker: HTMLInputElement;
  readonly attachBtn: HTMLElement | null;
  readonly note: HTMLElement;
  readonly doc: Document;
  readonly getTopic: () => string;
  readonly isHistoryOpen: () => boolean;
  readonly openShot: (img: HTMLImageElement) => void;
  readonly appendDraftFile: (topicId: string, file: ComposerAttachment) => void;
  readonly onQueuedSendReady: () => void;
}

export interface AttachmentsController {
  getFiles(): ComposerAttachment[];
  setFiles(list: ComposerAttachment[]): void;
  clearFiles(): ComposerAttachment[];
  renderChips(): void;
  hasPending(topicId: string): boolean;
  queueSend(topicId: string): void;
  notePending(): void;
  clearPendingNote(): void;
  take(list: ArrayLike<File> | null, rename?: (file: File) => string): void;
  attach(): Disposable;
}

function countUp(map: Record<string, number>, id: string): void {
  map[id] = (map[id] || 0) + 1;
}

function countDown(map: Record<string, number>, id: string): void {
  const cur = map[id] || 0;
  if (cur > 1) map[id] = cur - 1;
  else delete map[id];
}

class AttachmentsControllerImpl implements AttachmentsController {
  private files: ComposerAttachment[] = [];
  // Keep DOM nodes in a WeakMap rather than on the attachment object because api/send is .strict().
  private readonly chipEls = new WeakMap<ComposerAttachment, HTMLSpanElement>();
  private readonly pendingBy: Record<string, number> = {};
  private readonly shrinkingBy: Record<string, number> = {};
  private queuedSend: { topic: string } | null = null;
  private noteOwner: string | null = null;
  private pastes = 0;

  constructor(private readonly deps: AttachmentsDeps) {}

  private pastedName(f: File): string {
    this.pastes += 1;
    return formatPastedName(f.type, this.pastes);
  }

  private chipFor(file: ComposerAttachment): HTMLSpanElement {
    const cached = this.chipEls.get(file);
    if (cached) return cached;
    const el = this.deps.doc.createElement('span');
    el.className = 'chip';
    if (/^image\//.test(file.mime) && file.data) {
      const img = this.deps.doc.createElement('img');
      img.className = 'thumb';
      img.alt = file.name;
      // CSP is img-src 'self' data:, so thumbnails must use data: URLs rather than blob: URLs.
      img.src = `data:${file.mime};base64,${file.data}`;
      el.appendChild(img);
    }
    const nameEl = this.deps.doc.createElement('span');
    nameEl.className = 'chip-name';
    nameEl.textContent = file.name;
    el.appendChild(nameEl);

    const removeBtn = this.deps.doc.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'chip-x';
    removeBtn.title = tr('composer.removeFile', { name: file.name });
    removeBtn.setAttribute('aria-label', removeBtn.title);
    removeBtn.textContent = '\u00d7';
    el.appendChild(removeBtn);

    this.chipEls.set(file, el);
    return el;
  }

  getFiles(): ComposerAttachment[] {
    return this.files;
  }

  setFiles(list: ComposerAttachment[]): void {
    this.files = list;
  }

  clearFiles(): ComposerAttachment[] {
    const prev = this.files;
    this.files = [];
    return prev;
  }

  renderChips(): void {
    this.deps.chips.textContent = '';
    for (let i = 0; i < this.files.length; i++) {
      const file = this.files[i];
      if (!file) continue;
      const el = this.chipFor(file);
      const last = el.lastElementChild;
      if (last) last.setAttribute('data-drop', String(i));
      this.deps.chips.appendChild(el);
    }
  }

  hasPending(topicId: string): boolean {
    return Boolean(this.pendingBy[topicId]);
  }

  queueSend(topicId: string): void {
    this.queuedSend = { topic: topicId };
    this.notePending();
  }

  clearPendingNote(): void {
    if (this.noteOwner !== null && this.deps.note.textContent === this.noteOwner) {
      this.deps.note.textContent = '';
    }
    this.noteOwner = null;
  }

  notePending(): void {
    const n = this.shrinkingBy[this.deps.getTopic()] || 0;
    if (!n) {
      this.clearPendingNote();
      return;
    }
    if (this.noteOwner === null && this.deps.note.textContent) return;
    this.noteOwner = n > 1 ? tr('composer.compressingMany', { count: n }) : tr('composer.compressingOne');
    this.deps.note.textContent = this.noteOwner;
  }

  private settled(into: string, tookCanvas: boolean): void {
    countDown(this.pendingBy, into);
    if (tookCanvas) countDown(this.shrinkingBy, into);
    if (into === this.deps.getTopic()) this.notePending();
    if (this.pendingBy[into]) return;
    const queued = this.queuedSend;
    if (!queued || queued.topic !== into) return;
    this.queuedSend = null;
    if (into === this.deps.getTopic()) this.deps.onQueuedSendReady();
  }

  private processFile(file: File, into: string, rename?: (f: File) => string): void {
    let name = (rename ? rename(file) : file.name) || 'file';
    const tookCanvas = willShrink(file);
    countUp(this.pendingBy, into);
    if (tookCanvas) countUp(this.shrinkingBy, into);
    this.notePending();

    shrinkPhoto(file, this.deps.doc)
      .then((out) => {
        const blob: Blob = out ? out.blob : file;
        const mime = out ? out.blob.type : file.type || '';
        if (out) name = withMime(name, mime);
        return readBase64(blob).then((data) => {
          if (data === null) {
            if (into === this.deps.getTopic()) {
              this.noteOwner = null;
              this.deps.note.textContent = tr('composer.readFileFailed', { name });
            } else {
              console.warn(`fleetherd: could not read ${name}; it was not attached`);
            }
            return;
          }
          const attachment: ComposerAttachment = { name, mime, data };
          if (!into || into === this.deps.getTopic()) {
            this.files.push(attachment);
            this.renderChips();
            return;
          }
          this.deps.appendDraftFile(into, attachment);
        });
      })
      .then(
        () => this.settled(into, tookCanvas),
        (err) => {
          console.warn(`fleetherd: could not prepare ${name}; it was not attached`, err);
          this.settled(into, tookCanvas);
        },
      );
  }

  take(list: ArrayLike<File> | null, rename?: (f: File) => string): void {
    if (!list) return;
    const into = this.deps.getTopic();
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f) this.processFile(f, into, rename);
    }
  }

  attach(): Disposable {
    const store = new DisposableStore();
    store.add(
      addDisposableListener(this.deps.chips, 'click', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const dropBtn = target.closest('button[data-drop]');
        if (dropBtn) {
          this.files.splice(Number(dropBtn.getAttribute('data-drop')), 1);
          this.renderChips();
          return;
        }
        const thumb = target.closest<HTMLImageElement>('img.thumb');
        if (thumb) this.deps.openShot(thumb);
      }),
    );
    store.add(
      addDisposableListener(
        this.deps.chips,
        'error',
        (e) => {
          const target = e.target;
          if (target instanceof HTMLElement && target.classList.contains('thumb')) {
            target.style.display = 'none';
          }
        },
        true,
      ),
    );
    store.add(
      addDisposableListener(this.deps.picker, 'change', () => {
        this.take(this.deps.picker.files);
        this.deps.picker.value = '';
      }),
    );
    if (this.deps.attachBtn) {
      store.add(
        addDisposableListener(this.deps.attachBtn, 'click', () => {
          this.deps.picker.click();
        }),
      );
    }
    store.add(
      addDisposableListener(this.deps.doc, 'dragover', (e) => {
        e.preventDefault();
      }),
    );
    store.add(
      addDisposableListener(this.deps.doc, 'drop', (e) => {
        e.preventDefault();
        if (this.deps.isHistoryOpen()) return;
        if (e.dataTransfer && e.dataTransfer.files) this.take(e.dataTransfer.files);
      }),
    );
    store.add(
      addDisposableListener(this.deps.doc, 'paste', (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items || this.deps.isHistoryOpen()) return;
        const found: File[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (!item || item.kind !== 'file') continue;
          const file = item.getAsFile();
          if (file) found.push(file);
        }
        if (!found.length) return;
        e.preventDefault();
        this.take(found, (f) => this.pastedName(f));
      }),
    );
    return store;
  }
}

export function createAttachmentsController(deps: AttachmentsDeps): AttachmentsController {
  return new AttachmentsControllerImpl(deps);
}
