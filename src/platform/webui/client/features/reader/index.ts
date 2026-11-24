import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import type { CodeViewApi, EditorHandle } from '../../../codeview/app.js';
import { t as tr } from '../../i18n/index.js';
import { text } from '../../services/api.js';

export interface CodeViewLoaderDeps {
  readonly win?: Window;
  readonly doc?: Document;
  readonly importModule?: (url: string) => Promise<unknown>;
  readonly warn?: (message: string, err: unknown) => void;
}

export interface LightboxDeps {
  readonly lightbox: HTMLElement;
  readonly lightboxImg: HTMLImageElement;
}

export interface LightboxController extends Disposable {
  open(img: Pick<HTMLImageElement, 'src' | 'alt'>): void;
  close(): void;
  isOpen(): boolean;
}

export interface ReaderDeps {
  readonly reader: HTMLElement;
  readonly readerName: HTMLElement;
  readonly readerGet: HTMLElement;
  readonly readerBody: HTMLElement;
  readonly readerClose: HTMLElement;
  readonly codeView: () => Promise<CodeViewApi | null>;
  readonly codeBlocks: (root: Element) => void;
  readonly fetchFn?: typeof fetch;
  readonly warn?: (message: string, err: unknown) => void;
  readonly doc?: Document;
}

export interface ReaderController extends Disposable {
  open(link: Element): void;
  close(): void;
  isOpen(): boolean;
}

interface ReaderPayload {
  readonly error?: string;
  readonly shown?: number;
  readonly size?: number;
  readonly text?: unknown;
  readonly html?: string;
  readonly name?: string;
}

type WindowWithCodeView = Window & { __fhCodeView?: CodeViewApi };

export function formatByteSize(bytes: number): string {
  return bytes < 1048576
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;
}

function extractCodeViewApi(mod: unknown): CodeViewApi | null {
  if (!mod || typeof mod !== 'object') return null;
  const candidate = (mod as { default?: unknown }).default ?? mod;
  if (candidate && typeof candidate === 'object' && 'editor' in candidate) {
    return candidate as CodeViewApi;
  }
  return null;
}

export function createCodeViewLoader(
  bundleUrl: string | null | undefined,
  deps: CodeViewLoaderDeps = {},
): () => Promise<CodeViewApi | null> {
  const win = deps.win ?? window;
  const doc = deps.doc ?? document;
  const warnFn = deps.warn ?? ((msg: string, err: unknown) => console.warn(msg, err));
  let pending: Promise<CodeViewApi | null> | null = null;
  let warned = false;

  return () => {
    const injected = (win as WindowWithCodeView).__fhCodeView;
    if (injected) return Promise.resolve(injected);
    if (!bundleUrl) return Promise.resolve(null);
    if (pending) return pending;
    const resolved = new URL(bundleUrl, doc.baseURI).href;
    const load = deps.importModule
      ? deps.importModule(resolved)
      : (import(resolved) as Promise<unknown>);
    pending = load
      .then((mod) => extractCodeViewApi(mod))
      .catch((err: unknown) => {
        if (!warned) {
          warned = true;
          warnFn('code view unavailable, showing plain text:', err);
        }
        return null;
      });
    return pending;
  };
}

export function createLightbox(deps: LightboxDeps): LightboxController {
  const disposables = new DisposableStore();

  const close = (): void => {
    if (deps.lightbox.hidden) return;
    deps.lightbox.hidden = true;
    deps.lightboxImg.removeAttribute('src');
  };

  const open = (img: Pick<HTMLImageElement, 'src' | 'alt'>): void => {
    deps.lightboxImg.src = img.src;
    deps.lightboxImg.alt = img.alt;
    deps.lightbox.hidden = false;
  };

  disposables.add(addDisposableListener(deps.lightbox, 'click', close));

  return {
    open,
    close,
    isOpen: () => !deps.lightbox.hidden,
    dispose: () => disposables.dispose(),
  };
}

export function createReader(deps: ReaderDeps): ReaderController {
  const doc = deps.doc ?? document;
  const fetchFn = deps.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const warnFn = deps.warn ?? ((msg: string, err: unknown) => console.warn(msg, err));
  const disposables = new DisposableStore();

  let readSeq = 0;
  let editor: EditorHandle | null = null;

  const say = (msg: string): void => {
    deps.readerBody.innerHTML = `<div class="empty">${text(msg)}</div>`;
  };

  const dropEditor = (): void => {
    if (editor) {
      editor.destroy();
      editor = null;
    }
    deps.readerBody.classList.remove('cv');
  };

  const renderDoc = (note: string, htmlContent: string): void => {
    deps.readerBody.innerHTML = `${note}<div class="b">${htmlContent}</div>`;
    deps.codeBlocks(deps.readerBody);
    deps.readerBody.scrollTop = 0;
  };

  const mountCodeEditor = (
    mine: number,
    note: string,
    bodyText: string,
    fileName: string,
    fallbackHtml: string,
  ): void => {
    void deps.codeView().then((cv) => {
      if (mine !== readSeq) return;
      if (!cv) {
        renderDoc(note, fallbackHtml);
        return;
      }
      deps.readerBody.classList.add('cv');
      deps.readerBody.innerHTML = note;
      const host = doc.createElement('div');
      host.className = 'cv-host';
      deps.readerBody.appendChild(host);
      try {
        editor = cv.editor(host, { doc: bodyText, name: fileName, readOnly: true });
      } catch (err) {
        warnFn('code view failed, showing plain text:', err);
        dropEditor();
        renderDoc(note, fallbackHtml);
      }
    });
  };

  const open = (link: Element): void => {
    dropEditor();
    const label = link.textContent ?? '';
    deps.readerName.textContent = label;
    deps.readerName.title = label;
    const href = link.getAttribute('href');
    if (href !== null) deps.readerGet.setAttribute('href', href);
    else deps.readerGet.removeAttribute('href');
    say(tr('common.loading'));
    deps.reader.hidden = false;
    deps.readerBody.focus();

    const mine = ++readSeq;
    const viewUrl = link.getAttribute('data-view') ?? '';
    void fetchFn(viewUrl, { credentials: 'same-origin' })
      .then((res) =>
        res.json().then((body: unknown) => ({
          ok: res.ok,
          status: res.status,
          body: (body && typeof body === 'object' ? body : {}) as ReaderPayload,
        })),
      )
      .then((res) => {
        if (mine !== readSeq) return;
        if (!res.ok) {
          say(
            res.status === 404
              ? tr('reader.gone')
              : res.body.error || tr('reader.cannotShow'),
          );
          return;
        }
        const j = res.body;
        const shown = typeof j.shown === 'number' ? j.shown : 0;
        const size = typeof j.size === 'number' ? j.size : 0;
        const note =
          shown < size
            ? `<div class="reader-note">${text(tr('reader.partial', { shown: formatByteSize(shown), size: formatByteSize(size) }))}</div>`
            : '';
        const htmlContent = typeof j.html === 'string' ? j.html : '';
        if (typeof j.text !== 'string') {
          renderDoc(note, htmlContent);
          return;
        }
        mountCodeEditor(mine, note, j.text, typeof j.name === 'string' ? j.name : label, htmlContent);
      })
      .catch(() => {
        if (mine === readSeq) say(tr('common.reachServerError'));
      });
  };

  const close = (): void => {
    if (deps.reader.hidden) return;
    deps.reader.hidden = true;
    readSeq++;
    dropEditor();
    deps.readerBody.textContent = '';
  };

  disposables.add(addDisposableListener(deps.readerClose, 'click', close));
  disposables.add(
    addDisposableListener(deps.reader, 'click', (ev) => {
      if (ev.target === deps.reader) close();
    }),
  );

  return {
    open,
    close,
    isOpen: () => !deps.reader.hidden,
    dispose: () => {
      dropEditor();
      disposables.dispose();
    },
  };
}
