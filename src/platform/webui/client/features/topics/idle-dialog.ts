import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import { post, text } from '../../services/api.js';
import type { Topic } from './types.js';

export interface IdleDialogElements {
  readonly idleBtn: HTMLElement;
  readonly idleDialog: HTMLElement;
  readonly idleTitle: HTMLElement;
  readonly idleWhy: HTMLElement;
  readonly idleList: HTMLElement;
  readonly idleGo: HTMLButtonElement;
  readonly idleCancel: HTMLButtonElement;
}

export interface IdleDialogDeps {
  readonly els: IdleDialogElements;
  readonly getIdleTopics: () => Topic[];
  readonly closeOtherMenus: () => void;
  readonly postFn?: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
}

export interface IdleDialogController extends Disposable {
  open(): void;
  close(): void;
  isOpen(): boolean;
  attach(): Disposable;
}

interface CloseIdleResponse {
  readonly closed: readonly string[];
  readonly kept: readonly string[];
}

export function createIdleDialogController(deps: IdleDialogDeps): IdleDialogController {
  const { idleBtn, idleDialog, idleTitle, idleWhy, idleList, idleGo, idleCancel } = deps.els;
  const postFn = deps.postFn ?? post;
  const listeners = new DisposableStore();

  let idleIds: string[] = [];
  let idleSeq = 0;

  function idleFailed(why: string): void {
    idleTitle.textContent = why;
    idleGo.disabled = false;
  }

  function open(): void {
    const list = deps.getIdleTopics();
    if (!list.length) return;
    idleIds = [];
    let h = '';
    for (const t of list) {
      idleIds.push(t.id);
      const where = t.dir ? `${t.dir.host ? `${t.dir.host} · ` : ''}${t.dir.name}` : '';
      h +=
        `<li data-idle="${text(t.id)}"><span class="idle-main"><span class="idle-name">${text(t.title || tr('common.untitled'))}</span>` +
        `${where ? `<span class="idle-dir">${text(where)}</span>` : ''}</span><span class="idle-out"></span></li>`;
    }
    idleList.innerHTML = h;
    idleTitle.textContent = tr(list.length === 1 ? 'idle.confirmTitleOne' : 'idle.confirmTitleMany', {
      count: list.length,
    });
    idleWhy.hidden = false;
    idleGo.hidden = false;
    idleGo.disabled = false;
    idleGo.textContent = tr('idle.closeAgents');
    idleCancel.textContent = tr('common.cancel');
    idleDialog.hidden = false;
    idleCancel.focus();
  }

  function close(): void {
    if (idleDialog.hidden) return;
    idleDialog.hidden = true;
    idleSeq++;
    idleList.textContent = '';
  }

  function go(): void {
    idleGo.disabled = true;
    const mine = ++idleSeq;
    void postFn('api/topics/close-idle', { topics: idleIds }, 0)
      .then((r) => (r.ok ? (r.json() as Promise<CloseIdleResponse>) : null))
      .then(
        (d) => {
          if (mine !== idleSeq) return;
          if (!d) {
            idleFailed(tr('idle.refused'));
            return;
          }
          const rows = idleList.querySelectorAll<HTMLLIElement>('li');
          const closed: Record<string, boolean> = {};
          for (const id of d.closed) closed[id] = true;
          for (const row of rows) {
            const out = row.querySelector<HTMLElement>('.idle-out');
            const id = row.getAttribute('data-idle') ?? '';
            const ok = Boolean(closed[id]);
            if (out) {
              out.textContent = ok ? tr('idle.closed') : tr('idle.leftRunning');
              out.className = `idle-out${ok ? '' : ' kept'}`;
            }
          }
          const n = d.closed.length;
          const k = d.kept.length;
          idleTitle.textContent =
            tr(n === 1 ? 'idle.closedTitleOne' : 'idle.closedTitleMany', { count: n }) +
            (k ? tr('idle.keptSuffix', { count: k }) : '');
          idleWhy.hidden = true;
          idleGo.hidden = true;
          idleCancel.textContent = tr('common.done');
          idleCancel.focus();
        },
        () => {
          if (mine === idleSeq) idleFailed(tr('common.reachServerError'));
        },
      );
  }

  function attach(): Disposable {
    listeners.add(
      addDisposableListener(idleBtn, 'click', () => {
        deps.closeOtherMenus();
        open();
      }),
    );
    listeners.add(addDisposableListener(idleGo, 'click', go));
    listeners.add(addDisposableListener(idleCancel, 'click', close));
    listeners.add(
      addDisposableListener(idleDialog, 'click', (e) => {
        if (e.target === idleDialog) close();
      }),
    );
    return listeners;
  }

  return {
    open,
    close,
    isOpen: () => !idleDialog.hidden,
    attach,
    dispose: () => listeners.dispose(),
  };
}
