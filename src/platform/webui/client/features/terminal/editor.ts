import { icon, type IconName } from '../../../icons.js';
import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { DisposableStore } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import type { EditorContribution } from '../../plugins/api.js';
import { buildTerminalIframeSrc } from './tabs-store.js';

type PanelComponent = ReturnType<EditorContribution['component']>;
type PanelInitContext = Parameters<PanelComponent['init']>[1];
type PanelRef = PanelInitContext['api'];

export const TERMINAL_EDITOR_KIND = 'terminal';

export interface TerminalEditorInput {
  readonly topicId: string;
  readonly tabId?: string;
  readonly title?: string;
  readonly primary?: boolean;
}

export interface TerminalEditorOptions {
  readonly doc: Document;
  readonly resolveIcon?: (name: IconName) => string;
  readonly getTopicTitle: (topicId: string) => string | undefined;
  readonly t?: (key: string) => string;
  readonly onRename?: (tabId: string, nextTitle: string) => void;
}

export function normalizeTerminalEditorInput(input: unknown): TerminalEditorInput | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<TerminalEditorInput>;
  if (typeof raw.topicId !== 'string' || !raw.topicId.trim()) return undefined;
  const topicId = raw.topicId.trim();
  const tabId = typeof raw.tabId === 'string' && raw.tabId.trim() ? raw.tabId.trim() : undefined;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined;
  const primary = typeof raw.primary === 'boolean' ? raw.primary : undefined;
  return { topicId, tabId, title, primary };
}

export function formatTerminalEditorTitle(
  input: unknown,
  getTopicTitle: (topicId: string) => string | undefined,
): string {
  const parsed = normalizeTerminalEditorInput(input);
  if (!parsed) return tr('term.title');
  return parsed.title ?? getTopicTitle(parsed.topicId) ?? tr('term.title');
}

function resolveSvg(resolveIcon: ((name: IconName) => string) | undefined, name: IconName): string {
  return resolveIcon ? resolveIcon(name) : icon(name);
}

export function createTerminalEditorComponent(opts: TerminalEditorOptions): PanelComponent {
  const { doc } = opts;
  const label = (key: string, fallback: string): string => {
    const translated = opts.t?.(key);
    return translated && translated !== key ? translated : fallback;
  };
  const element = doc.createElement('div');
  element.className = 'wb-terminal-editor';

  const header = doc.createElement('div');
  header.className = 'wb-term-editor-bar';

  const iconEl = doc.createElement('span');
  iconEl.className = 'wb-term-editor-icon';
  iconEl.innerHTML = resolveSvg(opts.resolveIcon, 'terminal');

  const titleEl = doc.createElement('span');
  titleEl.className = 'wb-term-editor-title';

  const renameBtn = doc.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'wb-icon-btn wb-term-editor-rename';
  const renameLabel = label('term.renameTab', tr('common.rename'));
  renameBtn.title = renameLabel;
  renameBtn.setAttribute('aria-label', renameLabel);
  renameBtn.innerHTML = resolveSvg(opts.resolveIcon, 'pencil');

  header.append(iconEl, titleEl, renameBtn);

  const body = doc.createElement('div');
  body.className = 'wb-term-editor-body';
  element.append(header, body);

  const disposables = new DisposableStore();
  let panelApi: PanelRef | undefined;
  let current: TerminalEditorInput | undefined;
  let iframe: HTMLIFrameElement | null = null;
  let renameInput: HTMLInputElement | null = null;

  const currentTitle = (): string => {
    if (!current) return tr('term.title');
    return current.title ?? opts.getTopicTitle(current.topicId) ?? tr('term.title');
  };

  const stopRename = (): void => {
    if (renameInput) {
      renameInput.remove();
      renameInput = null;
    }
    titleEl.hidden = false;
  };

  const applyTitle = (nextTitle: string): void => {
    if (current) {
      current = { ...current, title: nextTitle };
    }
    titleEl.textContent = nextTitle;
    panelApi?.setTitle(nextTitle);
    if (current?.tabId) {
      opts.onRename?.(current.tabId, nextTitle);
    }
  };

  const beginRename = (): void => {
    if (!current || renameInput) return;
    const initial = currentTitle();
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'wb-term-rename-input';
    input.value = initial;
    input.setAttribute('aria-label', renameLabel);
    renameInput = input;
    titleEl.hidden = true;
    header.insertBefore(input, renameBtn);
    focusSafely(input);
    input.select();

    let settled = false;
    const finish = (save: boolean): void => {
      if (settled) return;
      settled = true;
      const trimmed = input.value.trim();
      stopRename();
      if (save && trimmed) applyTitle(trimmed);
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  };

  const mountFrame = (next: TerminalEditorInput): void => {
    const tabId = next.tabId ?? `${next.topicId}:editor`;
    const primary = next.primary ?? false;
    const src = buildTerminalIframeSrc(next.topicId, tabId, primary);
    if (iframe && iframe.getAttribute('src') === src) return;
    if (iframe) iframe.remove();
    iframe = doc.createElement('iframe');
    iframe.setAttribute('title', currentTitle());
    iframe.setAttribute('src', src);
    iframe.setAttribute('data-topic-id', next.topicId);
    iframe.setAttribute('data-tab-id', tabId);
    iframe.className = 'on';
    body.appendChild(iframe);
  };

  const applyInput = (params: unknown): void => {
    const parsed = normalizeTerminalEditorInput(params);
    if (!parsed) return;
    current = parsed;
    const title = currentTitle();
    titleEl.textContent = title;
    panelApi?.setTitle(title);
    mountFrame(parsed);
  };

  disposables.add(addDisposableListener(titleEl, 'dblclick', () => beginRename()));
  disposables.add(addDisposableListener(renameBtn, 'click', () => beginRename()));

  return {
    element,
    init(params: unknown, panelCtx: PanelInitContext): void {
      panelApi = panelCtx.api;
      applyInput(params);
      disposables.add(
        panelCtx.api.onDidVisibilityChange((visible) => {
          if (!iframe) return;
          iframe.classList.toggle('on', visible);
          iframe.toggleAttribute('inert', !visible);
        }),
      );
    },
    update(params: unknown): void {
      applyInput(params);
    },
    focus(): void {
      focusSafely(iframe ?? body);
    },
    dispose(): void {
      stopRename();
      disposables.dispose();
      if (iframe) {
        iframe.remove();
        iframe = null;
      }
      panelApi = undefined;
      current = undefined;
    },
  };
}
