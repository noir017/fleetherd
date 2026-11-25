import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { openConfirmDialog } from '../../components/dialog/index.js';
import { t as tr } from '../../i18n/index.js';
import { text } from '../../services/api.js';
import { subtreeOf } from './tree.js';
import type { RowMenuItem, ScheduleTaskLike, Topic, TopicIcons } from './types.js';

export interface RowMenuDeps {
  readonly rowMenu: HTMLElement;
  readonly doc?: Document;
  readonly win?: Window;
  readonly instanceId: string;
  readonly getIcons: () => TopicIcons;
  readonly getTopics: () => readonly Topic[];
  readonly topicById: (id: string) => Topic | null;
  readonly closeOtherMenus: () => void;
  readonly onStarTopic: (id: string) => void;
  readonly onCopyTopicRef: (id: string) => void;
  readonly onForkTopic: (id: string) => void;
  readonly onEndTopic: (id: string) => void;
  readonly onDeleteTopic: (id: string) => void;
  readonly getScheduleTask: (id: string) => ScheduleTaskLike | null | undefined;
  readonly onOpenTaskPage: (id: string, edit: boolean) => void;
  readonly onScheduleOp: (id: string, action: string, btn: HTMLElement | null) => void;
  readonly confirmFn?: (message: string) => boolean;
}

export interface RowMenuController extends Disposable {
  getKey(): string | null;
  isOpen(): boolean;
  open(btn: HTMLElement, key: string, items: readonly RowMenuItem[], onPick: (key: string) => void): void;
  close(focusBack?: boolean): void;
  follow(): void;
  openFor(btn: HTMLElement): void;
  attach(): Disposable;
}

const ROW_MENU_ITEMS = '[role="menuitem"]';

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

function asNode(target: EventTarget | null): Node | null {
  return target && typeof (target as Node).nodeType === 'number' ? (target as Node) : null;
}

function renderMenuItems(items: readonly RowMenuItem[]): string {
  let h = '';
  for (const it of items) {
    if (it.sep) {
      h += '<div class="rm-sep" role="separator"></div>';
      continue;
    }
    h +=
      `<button type="button" role="menuitem" data-rmk="${text(it.key)}"` +
      `${it.disabled ? ' disabled' : ''}${it.danger ? ' class="rm-del"' : ''}` +
      `${it.title ? ` title="${text(it.title)}"` : ''}>` +
      `${it.icon || ''}<span>${text(it.label)}</span></button>`;
  }
  return h;
}

function buildTopicMenuItems(
  t: Topic,
  topics: readonly Topic[],
  instanceId: string,
  icons: TopicIcons,
): RowMenuItem[] {
  const under = subtreeOf(t.id, topics).slice(1);
  let alive = 0;
  for (const child of under) if (child.live) alive++;
  const able = Boolean(t.live) || alive > 0;
  const busy = Boolean(t.running || t.asking);
  const canFork = !(t.agent && t.agent.canFork === false);
  const items: RowMenuItem[] = [
    {
      key: 'star',
      icon: icons.star,
      label: t.starred ? tr('topic.unstar') : tr('topic.star'),
      title: t.starred ? tr('topic.unstarTitle') : tr('topic.starTitle'),
    },
    {
      key: 'copy',
      icon: icons.copy,
      label: tr('topic.copyRef'),
      title: tr('topic.copyRefTitle', { ref: `${instanceId}:main/${t.id}` }),
    },
  ];
  if (canFork) {
    items.push({
      key: 'fork',
      icon: icons.fork,
      label: tr('topic.fork'),
      disabled: busy,
      title: busy ? tr('topic.forkBusyTitle') : tr('topic.forkTitle'),
    });
  }
  items.push(
    {
      key: 'end',
      icon: icons.power,
      label: alive
        ? tr(alive === 1 ? 'topic.endAgentSub' : 'topic.endAgentSubs', { count: alive })
        : tr('topic.endAgent'),
      disabled: !able,
      title: able
        ? alive
          ? tr(alive === 1 ? 'topic.endAgentSubTitle' : 'topic.endAgentSubsTitle', { count: alive })
          : tr('topic.endAgentTitle')
        : tr('topic.endAgentNoneTitle'),
    },
    { sep: true },
    { key: 'delete', icon: icons.trash, label: tr('topic.deleteTopic'), danger: true },
  );
  return items;
}

function buildTaskMenuItems(t: ScheduleTaskLike, icons: TopicIcons): RowMenuItem[] {
  const state = t.state || 'active';
  const items: RowMenuItem[] = [];
  if (state === 'active') {
    items.push({ key: 'pause', icon: icons.pause, label: tr('sched.pause'), title: tr('sched.pauseTitle') });
  }
  if (state === 'paused') {
    items.push({ key: 'resume', icon: icons.play, label: tr('sched.resume'), title: tr('sched.resumeTitle') });
  }
  if (state === 'active' || state === 'paused') {
    items.push(
      {
        key: 'run',
        icon: icons.clock,
        label: tr('sched.runNow'),
        disabled: Boolean(t.running),
        title: t.running ? tr('sched.runNowBusyTitle') : tr('sched.runNowTitle'),
      },
      {
        key: 'edit',
        icon: icons.pencil,
        label: tr('common.edit'),
        disabled: Boolean(t.running),
        title: t.running ? tr('sched.editBusyTitle') : tr('sched.editTitle'),
      },
    );
  }
  if (items.length) items.push({ sep: true });
  items.push({ key: 'remove', icon: icons.trash, label: tr('common.delete'), danger: true });
  return items;
}

class RowMenuControllerImpl implements RowMenuController {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly confirmFn?: (message: string) => boolean;
  private readonly rowMenu: HTMLElement;
  private readonly listeners = new DisposableStore();

  private rowMenuKey: string | null = null;
  private rowMenuBtn: HTMLElement | null = null;
  private rowMenuPick: ((key: string) => void) | null = null;

  constructor(private readonly deps: RowMenuDeps) {
    this.doc = deps.doc ?? document;
    this.win = deps.win ?? window;
    this.confirmFn = deps.confirmFn;
    this.rowMenu = deps.rowMenu;
  }

  getKey(): string | null {
    return this.rowMenuKey;
  }

  isOpen(): boolean {
    return !this.rowMenu.hidden;
  }

  private rowMenuButtons(): HTMLButtonElement[] {
    return Array.from(this.rowMenu.querySelectorAll<HTMLButtonElement>(ROW_MENU_ITEMS)).filter((b) => !b.disabled);
  }

  private positionRowMenu(btn: HTMLElement | null): void {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const w = this.rowMenu.offsetWidth || 210;
    const h = this.rowMenu.offsetHeight || 0;
    const left = Math.max(8, Math.min(r.right - w, this.win.innerWidth - 8 - w));
    let top = r.bottom + 4;
    if (top + h + 8 > this.win.innerHeight) top = Math.max(8, r.top - 4 - h);
    this.rowMenu.style.left = `${left}px`;
    this.rowMenu.style.top = `${top}px`;
  }

  open(
    btn: HTMLElement,
    key: string,
    items: readonly RowMenuItem[],
    onPick: (key: string) => void,
  ): void {
    this.rowMenu.innerHTML = renderMenuItems(items);
    this.deps.closeOtherMenus();
    if (this.rowMenuBtn && this.rowMenuBtn !== btn) this.rowMenuBtn.setAttribute('aria-expanded', 'false');
    this.rowMenuKey = key;
    this.rowMenuBtn = btn;
    this.rowMenuPick = onPick;
    this.rowMenu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    this.positionRowMenu(btn);
    this.rowMenuButtons()[0]?.focus();
  }

  close(focusBack = false): void {
    if (this.rowMenu.hidden) return;
    const btn = this.rowMenuBtn;
    this.rowMenu.hidden = true;
    this.rowMenuKey = null;
    this.rowMenuBtn = null;
    this.rowMenuPick = null;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (focusBack && btn && typeof btn.focus === 'function') btn.focus();
  }

  follow(): void {
    if (!this.rowMenuKey) return;
    const anchor = this.doc.querySelector<HTMLElement>(`[data-rm="${this.rowMenuKey}"]`);
    if (!anchor) {
      this.close(false);
      return;
    }
    this.rowMenuBtn = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    this.positionRowMenu(anchor);
  }

  private openTopicMenu(id: string, btn: HTMLElement): void {
    const t = this.deps.topicById(id);
    if (!t) return;
    const items = buildTopicMenuItems(t, this.deps.getTopics(), this.deps.instanceId, this.deps.getIcons());
    this.open(btn, btn.getAttribute('data-rm') || `topic:${id}`, items, (what) => {
      if (what === 'star') this.deps.onStarTopic(id);
      else if (what === 'copy') this.deps.onCopyTopicRef(id);
      else if (what === 'fork') this.deps.onForkTopic(id);
      else if (what === 'delete') this.deps.onDeleteTopic(id);
      else if (what === 'end') this.deps.onEndTopic(id);
    });
  }

  private openTaskMenu(id: string, btn: HTMLElement): void {
    const t = this.deps.getScheduleTask(id);
    if (!t) return;
    const items = buildTaskMenuItems(t, this.deps.getIcons());
    this.open(btn, btn.getAttribute('data-rm') || `task:${id}`, items, (what) => {
      if (what === 'edit') {
        this.deps.onOpenTaskPage(id, true);
        return;
      }
      if (what === 'remove') {
        const msg = tr('sched.confirmDeleteTask', { name: t.name || t.id });
        const confirmed = this.confirmFn
          ? Promise.resolve(this.confirmFn(msg))
          : openConfirmDialog({
              title: tr('common.delete'),
              body: msg,
              confirmLabel: tr('common.delete'),
              cancelLabel: tr('common.cancel'),
              danger: true,
              doc: this.doc,
            });
        void confirmed.then((ok) => {
          if (ok) this.deps.onScheduleOp(id, 'remove', null);
        });
        return;
      }
      this.deps.onScheduleOp(id, what, null);
    });
  }

  openFor(btn: HTMLElement): void {
    const key = btn.getAttribute('data-rm') || '';
    const cut = key.indexOf(':');
    if (cut < 0) return;
    const kind = key.slice(0, cut);
    const id = key.slice(cut + 1);
    if (!id) return;
    if (kind === 'task') this.openTaskMenu(id, btn);
    else this.openTopicMenu(id, btn);
  }

  attach(): Disposable {
    this.listeners.add(
      addDisposableListener(this.rowMenu, 'click', (e) => {
        const el = asElement(e.target);
        const item = el?.closest<HTMLButtonElement>('[data-rmk]');
        if (!item || item.disabled) return;
        const pick = this.rowMenuPick;
        const what = item.getAttribute('data-rmk');
        if (!pick || !what) return;
        this.close(false);
        pick(what);
      }),
    );
    this.listeners.add(
      addDisposableListener(this.rowMenu, 'keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
        const items = this.rowMenuButtons();
        if (!items.length) return;
        e.preventDefault();
        const active = this.doc.activeElement as HTMLButtonElement | null;
        const at = active ? items.indexOf(active) : -1;
        let next: number;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
        else next = at < 0 ? items.length - 1 : (at + items.length - 1) % items.length;
        items[next]?.focus();
      }),
    );
    this.listeners.add(
      addDisposableListener(this.rowMenu, 'focusout', (e) => {
        if (this.rowMenu.hidden) return;
        const to = asNode(e.relatedTarget);
        // iOS Safari reports relatedTarget=null before click; leave that to document click below.
        if (!to || this.rowMenu.contains(to) || (this.rowMenuBtn && this.rowMenuBtn.contains(to))) {
          return;
        }
        this.close(false);
      }),
    );
    this.listeners.add(
      addDisposableListener(this.doc, 'click', (e) => {
        if (this.rowMenu.hidden) return;
        const target = asNode(e.target);
        if (target && (this.rowMenu.contains(target) || (this.rowMenuBtn && this.rowMenuBtn.contains(target)))) {
          return;
        }
        this.close(false);
      }),
    );
    this.listeners.add(
      addDisposableListener(this.doc, 'scroll', () => { if (this.rowMenuKey) this.positionRowMenu(this.rowMenuBtn); }, true),
    );
    this.listeners.add(
      addDisposableListener(this.win, 'resize', () => { if (this.rowMenuKey) this.positionRowMenu(this.rowMenuBtn); }),
    );
    return this.listeners;
  }

  dispose(): void {
    this.listeners.dispose();
  }
}

export function createRowMenuController(deps: RowMenuDeps): RowMenuController {
  return new RowMenuControllerImpl(deps);
}
