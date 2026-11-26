import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, NOOP_DISPOSABLE } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import type { ComposerIcons, ComposerTopic } from './types.js';

export function fallbackCopy(value: string, doc: Document = document): boolean {
  const prev = doc.activeElement as HTMLElement | null;
  let ta: HTMLTextAreaElement | null = null;
  try {
    ta = doc.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    doc.body.appendChild(ta);
    ta.select();
    return Boolean(doc.execCommand('copy'));
  } catch {
    return false;
  } finally {
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    if (prev && typeof prev.focus === 'function') {
      try {
        prev.focus();
      } catch {
        // Ignore focus restoration errors.
      }
    }
  }
}

export function copyText(
  value: string,
  done: (ok: boolean) => void,
  nav: Navigator = navigator,
  doc: Document = document,
): void {
  if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    nav.clipboard.writeText(value).then(
      () => done(true),
      () => done(fallbackCopy(value, doc)),
    );
    return;
  }
  done(fallbackCopy(value, doc));
}

export function topicRef(topic: ComposerTopic, instanceId: string): string {
  return `${topic.title || tr('common.untitled')} (${instanceId}:main/${topic.id})`;
}

const copyTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export function flashCopyBtn(
  btn: HTMLElement,
  ok: boolean,
  restoreTitle: string,
  restoreLabel: string,
  icons: Pick<ComposerIcons, 'check' | 'cross' | 'copy'>,
): void {
  const say = ok ? tr('common.copied') : tr('common.copyFailed');
  btn.innerHTML = ok ? icons.check : icons.cross;
  btn.title = say;
  btn.setAttribute('aria-label', say);
  const existing = copyTimers.get(btn);
  if (existing !== undefined) clearTimeout(existing);
  copyTimers.set(
    btn,
    setTimeout(() => {
      btn.innerHTML = icons.copy;
      btn.title = restoreTitle;
      btn.setAttribute('aria-label', restoreLabel);
      copyTimers.delete(btn);
    }, 1500),
  );
}

export interface CopyRefDeps {
  readonly copyRefBtn: HTMLButtonElement | null;
  readonly note: HTMLElement;
  readonly instanceId: string;
  readonly doc: Document;
  readonly isHistoryOpen: () => boolean;
  readonly getHistoryRef: () => string | null;
  readonly getTopic: () => string;
  readonly topicById: (id: string) => ComposerTopic | undefined;
  readonly getIcons: () => ComposerIcons;
}

export interface CopyRefController {
  syncCopyRef(): void;
  copyTopicRef(id: string): void;
  attach(): Disposable;
  dispose(): void;
}

export function createCopyRefController(deps: CopyRefDeps): CopyRefController {
  let copyNoteTimer: ReturnType<typeof setTimeout> | null = null;

  function flashCopyNote(msg: string): void {
    deps.note.textContent = msg;
    if (copyNoteTimer !== null) clearTimeout(copyNoteTimer);
    copyNoteTimer = setTimeout(() => {
      copyNoteTimer = null;
      if (deps.note.textContent === msg) deps.note.textContent = '';
    }, 2500);
  }

  function syncCopyRef(): void {
    const btn = deps.copyRefBtn;
    if (!btn) return;
    if (deps.isHistoryOpen()) {
      const ref = deps.getHistoryRef();
      btn.hidden = !ref;
      btn.title = ref ? tr('topic.copyRefWith', { ref }) : tr('topic.copyRefBtn');
      return;
    }
    const cur = deps.topicById(deps.getTopic());
    btn.hidden = !cur;
    btn.title = cur ? tr('topic.copyRefWith', { ref: topicRef(cur, deps.instanceId) }) : tr('topic.copyRefBtn');
  }

  function copyTopicRef(id: string): void {
    const cur = deps.topicById(id);
    if (!cur) return;
    const ref = topicRef(cur, deps.instanceId);
    copyText(
      ref,
      (ok) => {
        flashCopyNote(ok ? tr('topic.copiedRef', { ref }) : tr('topic.copyRefFailed'));
      },
      navigator,
      deps.doc,
    );
  }

  function attach(): Disposable {
    const btn = deps.copyRefBtn;
    if (!btn) return NOOP_DISPOSABLE;
    return addDisposableListener(btn, 'click', () => {
      const cur = deps.topicById(deps.getTopic());
      const ref = deps.isHistoryOpen()
        ? deps.getHistoryRef()
        : cur
          ? topicRef(cur, deps.instanceId)
          : null;
      if (!ref) return;
      copyText(
        ref,
        (ok) => {
          flashCopyBtn(btn, ok, tr('topic.copyRefWith', { ref }), tr('topic.copyRefBtn'), deps.getIcons());
        },
        navigator,
        deps.doc,
      );
    });
  }

  function dispose(): void {
    if (copyNoteTimer !== null) {
      clearTimeout(copyNoteTimer);
      copyNoteTimer = null;
    }
  }

  return { syncCopyRef, copyTopicRef, attach, dispose };
}
