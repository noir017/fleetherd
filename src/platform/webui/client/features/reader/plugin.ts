import type { CodeViewApi, EditorHandle } from '../../../codeview/app.js';
import { icon } from '../../../icons.js';
import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { type Disposable, DisposableStore, toDisposable } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import {
  definePlugin,
  type EditorContribution,
  type PluginContext,
  type WebuiPlugin,
} from '../../plugins/api.js';
import { text } from '../../services/api.js';
import { type BootConfig, readBootConfig } from '../../services/boot.js';
import type { OverlayManager } from '../../services/overlays.js';
import { createCodeViewLoader, createLightbox, formatByteSize } from './index.js';

type PanelComponent = ReturnType<EditorContribution['component']>;
type PanelInitContext = Parameters<PanelComponent['init']>[1];
type PanelRef = PanelInitContext['api'];

export const READER_PLUGIN_ID = 'reader';
export const READER_EDITOR_KIND = 'reader';
export const READER_OPEN_COMMAND = 'reader.open';
export const READER_OPEN_IMAGE_COMMAND = 'reader.openImage';

export interface ReaderEditorInput {
  readonly viewUrl: string;
  readonly title?: string;
  readonly downloadUrl?: string;
}

export interface ReaderImageInput {
  readonly src: string;
  readonly alt?: string;
  readonly restoreFocus?: HTMLElement | null;
}

export interface ReaderPluginDeps {
  readonly boot?: Pick<BootConfig, 'codeview'>;
  readonly overlays?: OverlayManager;
  readonly codeView?: () => Promise<CodeViewApi | null>;
  readonly codeBlocks?: (root: Element) => void;
  readonly lightbox?: HTMLElement;
  readonly lightboxImg?: HTMLImageElement;
  readonly overlayHost?: HTMLElement;
  readonly fetchFn?: typeof fetch;
  readonly warn?: (message: string, err: unknown) => void;
  readonly win?: Window;
  readonly doc?: Document;
}

interface ReaderPayload {
  readonly error?: string;
  readonly shown?: number;
  readonly size?: number;
  readonly text?: unknown;
  readonly html?: string;
  readonly name?: string;
}

interface ResolvedReaderInput {
  readonly viewUrl: string;
  readonly title: string;
  readonly hasExplicitTitle: boolean;
  readonly downloadUrl?: string;
}

function isElementLike(value: unknown): value is Element {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { getAttribute?: unknown }).getAttribute === 'function',
  );
}

export function normalizeReaderInput(input: unknown): ResolvedReaderInput {
  if (isElementLike(input)) {
    const rawTitle = (input.textContent ?? '').trim();
    const downloadUrl = input.getAttribute('href') ?? undefined;
    return {
      viewUrl: input.getAttribute('data-view') ?? '',
      title: rawTitle || tr('common.untitled'),
      hasExplicitTitle: rawTitle.length > 0,
      downloadUrl,
    };
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const rawTitle =
      typeof obj.title === 'string'
        ? obj.title.trim()
        : typeof obj.name === 'string'
          ? obj.name.trim()
          : '';
    const viewUrl = typeof obj.viewUrl === 'string' ? obj.viewUrl : '';
    const downloadUrl =
      typeof obj.downloadUrl === 'string'
        ? obj.downloadUrl
        : typeof obj.href === 'string'
          ? obj.href
          : undefined;
    return {
      viewUrl,
      title: rawTitle || tr('common.untitled'),
      hasExplicitTitle: rawTitle.length > 0,
      downloadUrl,
    };
  }
  return {
    viewUrl: '',
    title: tr('common.untitled'),
    hasExplicitTitle: false,
  };
}

function normalizeImageInput(input: unknown, altArg?: unknown): ReaderImageInput | null {
  if (typeof input === 'string' && input.trim()) {
    return {
      src: input,
      alt: typeof altArg === 'string' ? altArg : '',
    };
  }
  if (input && typeof input === 'object') {
    const obj = input as { src?: unknown; alt?: unknown; restoreFocus?: unknown };
    if (typeof obj.src === 'string' && obj.src.trim()) {
      const restoreFocus =
        obj.restoreFocus instanceof HTMLElement
          ? obj.restoreFocus
          : isElementLike(input) && input instanceof HTMLElement
            ? input
            : null;
      return {
        src: obj.src,
        alt: typeof obj.alt === 'string' ? obj.alt : '',
        restoreFocus,
      };
    }
  }
  return null;
}

interface ReaderEditorRuntime {
  readonly doc: Document;
  readonly fetchFn: typeof fetch;
  readonly codeView: () => Promise<CodeViewApi | null>;
  readonly codeBlocks?: (root: Element) => void;
  readonly warnFn: (message: string, err: unknown) => void;
}

interface ReaderEditorDom {
  readonly element: HTMLDivElement;
  readonly nameEl: HTMLSpanElement;
  readonly downloadEl: HTMLAnchorElement;
  readonly bodyEl: HTMLDivElement;
}

function createReaderEditorDom(doc: Document): ReaderEditorDom {
  const element = doc.createElement('div');
  element.className = 'wb-reader-editor';

  const header = doc.createElement('div');
  header.className = 'wb-reader-bar';

  const iconEl = doc.createElement('span');
  iconEl.className = 'wb-reader-icon';
  iconEl.innerHTML = icon('note');

  const nameEl = doc.createElement('span');
  nameEl.className = 'wb-reader-name';

  const downloadEl = doc.createElement('a');
  downloadEl.className = 'wb-reader-download';
  downloadEl.textContent = tr('common.download');
  downloadEl.setAttribute('download', '');
  downloadEl.hidden = true;

  header.append(iconEl, nameEl, downloadEl);

  const bodyEl = doc.createElement('div');
  bodyEl.className = 'wb-reader-body';
  bodyEl.tabIndex = -1;

  element.append(header, bodyEl);
  return { element, nameEl, downloadEl, bodyEl };
}

function formatPartialNote(payload: ReaderPayload): string {
  const shown = typeof payload.shown === 'number' ? payload.shown : 0;
  const size = typeof payload.size === 'number' ? payload.size : 0;
  if (shown >= size) return '';
  const label = tr('reader.partial', {
    shown: formatByteSize(shown),
    size: formatByteSize(size),
  });
  return `<div class="reader-note">${text(label)}</div>`;
}

function createReaderEditorComponent(runtime: ReaderEditorRuntime): PanelComponent {
  const { doc, fetchFn, codeView, codeBlocks, warnFn } = runtime;
  const { element, nameEl, downloadEl, bodyEl } = createReaderEditorDom(doc);

  let api: PanelRef | undefined;
  let readSeq = 0;
  let disposed = false;
  let editor: EditorHandle | null = null;

  const say = (msg: string): void => {
    bodyEl.innerHTML = `<div class="empty">${text(msg)}</div>`;
  };

  const dropEditor = (): void => {
    if (editor) {
      editor.destroy();
      editor = null;
    }
    bodyEl.classList.remove('cv');
  };

  const renderDoc = (note: string, htmlContent: string): void => {
    bodyEl.innerHTML = `${note}<div class="b">${htmlContent}</div>`;
    codeBlocks?.(bodyEl);
    bodyEl.scrollTop = 0;
  };

  const mountCodeEditor = (
    mine: number,
    note: string,
    bodyText: string,
    fileName: string,
    fallbackHtml: string,
  ): void => {
    const plainFallback = fallbackHtml || `<pre class="src">${text(bodyText)}</pre>`;
    void codeView().then((cv) => {
      if (disposed || mine !== readSeq) return;
      if (!cv) {
        renderDoc(note, plainFallback);
        return;
      }
      bodyEl.classList.add('cv');
      bodyEl.innerHTML = note;
      const host = doc.createElement('div');
      host.className = 'cv-host';
      bodyEl.appendChild(host);
      try {
        editor = cv.editor(host, { doc: bodyText, name: fileName, readOnly: true });
      } catch (err) {
        warnFn('code view failed, showing plain text:', err);
        dropEditor();
        renderDoc(note, plainFallback);
      }
    });
  };

  const load = (rawInput: unknown): void => {
    dropEditor();
    const resolved = normalizeReaderInput(rawInput);
    nameEl.textContent = resolved.title;
    nameEl.title = resolved.title;
    api?.setTitle(resolved.title);

    if (resolved.downloadUrl !== undefined) {
      downloadEl.setAttribute('href', resolved.downloadUrl);
      downloadEl.hidden = false;
    } else {
      downloadEl.removeAttribute('href');
      downloadEl.hidden = true;
    }

    const mine = ++readSeq;
    if (!resolved.viewUrl) {
      say(tr('reader.cannotShow'));
      return;
    }

    say(tr('common.loading'));
    void fetchFn(resolved.viewUrl, { credentials: 'same-origin' })
      .then((res) =>
        res.json().then((body: unknown) => ({
          ok: res.ok,
          status: res.status,
          body: (body && typeof body === 'object' ? body : {}) as ReaderPayload,
        })),
      )
      .then((res) => {
        if (disposed || mine !== readSeq) return;
        if (!res.ok) {
          say(
            res.status === 404
              ? tr('reader.gone')
              : res.body.error || tr('reader.cannotShow'),
          );
          return;
        }
        const j = res.body;
        if (!resolved.hasExplicitTitle && typeof j.name === 'string' && j.name.trim()) {
          nameEl.textContent = j.name;
          nameEl.title = j.name;
          api?.setTitle(j.name);
        }
        const note = formatPartialNote(j);
        const htmlContent = typeof j.html === 'string' ? j.html : '';
        if (typeof j.text !== 'string') {
          renderDoc(note, htmlContent);
          return;
        }
        const fileName = typeof j.name === 'string' && j.name ? j.name : resolved.title;
        mountCodeEditor(mine, note, j.text, fileName, htmlContent);
      })
      .catch(() => {
        if (!disposed && mine === readSeq) {
          say(tr('common.reachServerError'));
        }
      });
  };

  return {
    element,
    init(params: unknown, panelCtx: PanelInitContext): void {
      api = panelCtx.api;
      load(params);
    },
    update(params: unknown): void {
      load(params);
    },
    focus(): void {
      if (editor) {
        editor.focus();
      } else {
        focusSafely(bodyEl);
      }
    },
    dispose(): void {
      disposed = true;
      readSeq++;
      dropEditor();
      bodyEl.textContent = '';
      api = undefined;
    },
  };
}

interface LightboxOverlayController extends Disposable {
  open(input: ReaderImageInput): void;
  close(): void;
  isOpen(): boolean;
}

function createLightboxOverlay(deps: ReaderPluginDeps, doc: Document): LightboxOverlayController {
  const disposables = new DisposableStore();
  let ownedElement = false;
  let lightboxEl = deps.lightbox;
  let lightboxImg = deps.lightboxImg;

  if (!lightboxEl || !lightboxImg) {
    lightboxEl = doc.createElement('div');
    lightboxEl.id = 'lightbox';
    lightboxEl.className = 'wb-lightbox';
    lightboxEl.hidden = true;
    lightboxImg = doc.createElement('img');
    lightboxImg.alt = '';
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wb-lightbox-close';
    closeBtn.setAttribute('aria-label', tr('common.close'));
    closeBtn.innerHTML = icon('cross');
    lightboxEl.append(lightboxImg, closeBtn);
    (deps.overlayHost ?? doc.body).appendChild(lightboxEl);
    ownedElement = true;
  }

  const lb = createLightbox({ lightbox: lightboxEl, lightboxImg });
  disposables.add(lb);

  let overlaySub: Disposable | undefined;

  const clearOverlaySub = (): void => {
    const sub = overlaySub;
    overlaySub = undefined;
    sub?.dispose();
  };

  const close = (): void => {
    clearOverlaySub();
    lb.close();
  };

  // Sync OverlayManager stack when backdrop click closes the lightbox.
  disposables.add(
    addDisposableListener(lightboxEl, 'click', () => {
      if (!lb.isOpen()) clearOverlaySub();
    }),
  );

  disposables.add(
    toDisposable(() => {
      close();
      if (ownedElement) lightboxEl?.remove();
    }),
  );

  return {
    open(input: ReaderImageInput): void {
      clearOverlaySub();
      lb.open({ src: input.src, alt: input.alt ?? '' });
      if (deps.overlays) {
        overlaySub = deps.overlays.push({
          id: 'reader.lightbox',
          close: () => {
            overlaySub = undefined;
            lb.close();
          },
          restoreFocus: input.restoreFocus ?? null,
        });
      }
    },
    close,
    isOpen: () => lb.isOpen(),
    dispose: () => disposables.dispose(),
  };
}

export function createReaderPlugin(deps: ReaderPluginDeps = {}): WebuiPlugin {
  return definePlugin({
    id: READER_PLUGIN_ID,
    activate(ctx: PluginContext): void {
      const doc = deps.doc ?? document;
      const boot = deps.boot ?? readBootConfig(doc);
      const fetchFn =
        deps.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
      const warnFn = deps.warn ?? ((msg: string, err: unknown) => console.warn(msg, err));
      const codeView =
        deps.codeView ??
        createCodeViewLoader(boot.codeview, {
          win: deps.win,
          doc,
          warn: warnFn,
        });

      const runtime: ReaderEditorRuntime = {
        doc,
        fetchFn,
        codeView,
        codeBlocks: deps.codeBlocks,
        warnFn,
      };

      ctx.editors.register({
        kind: READER_EDITOR_KIND,
        title: (input) => normalizeReaderInput(input).title,
        component: () => createReaderEditorComponent(runtime),
      });

      const lightbox = createLightboxOverlay(deps, doc);
      ctx.subscriptions.add(lightbox);

      ctx.commands.register(READER_OPEN_COMMAND, (input: unknown): boolean => {
        const resolved = normalizeReaderInput(input);
        if (!resolved.viewUrl) return false;
        ctx.editors.open(READER_EDITOR_KIND, {
          viewUrl: resolved.viewUrl,
          title: resolved.hasExplicitTitle ? resolved.title : undefined,
          downloadUrl: resolved.downloadUrl,
        } satisfies ReaderEditorInput);
        return true;
      });

      ctx.commands.register(
        READER_OPEN_IMAGE_COMMAND,
        (input: unknown, altArg?: unknown): boolean => {
          const resolved = normalizeImageInput(input, altArg);
          if (!resolved) return false;
          lightbox.open(resolved);
          return true;
        },
      );
    },
  });
}
