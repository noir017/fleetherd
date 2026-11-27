import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import { text } from '../../../services/api.js';
import { workdirPickerHtml } from './markup.js';
import type {
  LaunchChoice,
  OfflineMachine,
  TranscriptIcons,
  TranscriptMessage,
  TranscriptTopicLike,
  WorkdirScreen,
} from './types.js';

export const SKELETON_HTML =
  '<div class="sk own"><i style="width:34%"></i></div>' +
  '<div class="sk"><i style="width:86%"></i><i style="width:73%"></i><i style="width:41%"></i></div>' +
  '<div class="sk own"><i style="width:52%"></i><i style="width:28%"></i></div>' +
  '<div class="sk"><i style="width:79%"></i><i style="width:62%"></i></div>';

const OFFLINE_RECENT_MS = 20 * 3600000;

export function offWhen(
  at: number,
  formatClock: (ms: number) => string,
  now = Date.now(),
): string {
  return now - at < OFFLINE_RECENT_MS ? formatClock(at) : new Date(at).toLocaleString();
}

export function forkNoteSignature(
  cur: TranscriptTopicLike | null | undefined,
  src: TranscriptTopicLike | null | undefined,
): string {
  if (!cur || !src) return '';
  return `${src.id}|${cur.forkTurn || ''}|${src.title || ''}`;
}

export function forkNoteMarkup(
  src: TranscriptTopicLike,
  forkTurn: number | undefined,
  icons: TranscriptIcons,
): string {
  return (
    (icons.icon.fork ?? '') +
    `<span>${text(tr('topic.forkedFromPrefix'))}</span>` +
    `<span class="fork-src">${text(src.title || tr('common.untitled'))}</span>` +
    (forkTurn ? `<span>${text(tr('topic.forkedTurn', { turn: forkTurn }))}</span>` : '')
  );
}

export interface LaunchOfflineView {
  readonly offSince: (name: string) => number;
  readonly offWhen: (at: number) => string;
  readonly offTitle: (name: string) => string;
}

export interface LaunchFoldState {
  readonly agents?: boolean;
  readonly workdir?: boolean;
}

export type LaunchFoldPart = 'agents' | 'workdir';

function launchCardHtml(
  a: LaunchChoice['groups'][number]['agents'][number],
  on: boolean,
  offSuffix: string,
  icons: TranscriptIcons,
): string {
  const harnessBadge =
    a.harness && a.harness !== 'custom'
      ? `<span class="ac-hc h-${text(a.harness)}">${text(a.harness)}</span>`
      : '';
  const checkMark =
    on && icons.icon.check ? `<span class="ac-check" aria-hidden="true">${icons.icon.check}</span>` : '';
  const modelPart = a.model
    ? `<span class="ac-sep" aria-hidden="true"> \u00b7 </span><span class="ac-model" title="${text(a.model)}">${text(a.model)}</span>`
    : '';
  return (
    `<button type="button" class="agent-card${on ? ' def' : ''}" data-agent="${text(a.id)}" title="/agent ${text(a.id)}${offSuffix}">` +
    `<span class="ac-top">${harnessBadge}<span class="ac-id">${text(a.id)}</span>${on ? `<span class="ac-tag">${text(tr('chat.defaultTag'))}</span>` : ''}${checkMark}</span>` +
    `<span class="ac-kind"><span>${text(a.kind)}</span>${modelPart}</span>` +
    '</button>'
  );
}

export function launchHtml(
  choice: LaunchChoice,
  icons: TranscriptIcons,
  offline: LaunchOfflineView,
  _cwd = '',
  fold: LaunchFoldState = {},
): string {
  let h =
    `<div class="launch-head"><div class="launch-title">${text(tr('chat.launchTitle'))}</div>` +
    `<div class="launch-sub">${text(tr('chat.launchSubPrefix'))}<b>${text(choice.current)}</b>${text(tr('chat.launchSubSuffix'))}</div>` +
    `<div class="launch-choice"${fold.agents ? '' : ' hidden'}>` +
    `<span class="launch-choice-item"><span class="launch-choice-k">${text(tr('chat.launchAgentLabel'))}</span><span class="launch-choice-agent">${text(choice.current)}</span></span>` +
    `<button type="button" class="launch-choice-change" data-launch-unfold="agents">${text(tr('chat.launchChange'))}</button>` +
    '</div></div>';
  h += `<div class="launch-agents"${fold.agents ? ' hidden' : ''}>`;
  const many = choice.groups.length > 1;
  for (let i = 0; i < choice.groups.length; i++) {
    const g = choice.groups[i];
    if (!g) continue;
    const off = offline.offSince(g.name);
    h += `<section class="launch-group${off ? ' off' : ''}">`;
    if (many || off) {
      h +=
        `<h3 class="launch-host">${text(g.name)} <span class="n">${g.agents.length}</span>` +
        (off
          ? `<span class="off" title="${text(offline.offTitle(g.name))}">${icons.icon.offline ?? ''}${text(tr('chat.offlineSince', { when: offline.offWhen(off) }))}</span>`
          : '') +
        '</h3>';
    }
    h += '<div class="launch-grid">';
    const offSuffix = off ? text(tr('chat.agentOffline', { name: g.name })) : '';
    for (let j = 0; j < g.agents.length; j++) {
      const a = g.agents[j];
      if (!a) continue;
      h += launchCardHtml(a, a.id === choice.current, offSuffix, icons);
    }
    h += '</div></section>';
  }
  h += '</div>';
  h += '<div class="launch-wd" hidden></div>';
  return h;
}

function withCurrentWorkdir(screen: WorkdirScreen, cwd: string): WorkdirScreen {
  return {
    ...screen,
    current: cwd,
    selectCurrent: { ...screen.selectCurrent, current: screen.selectCurrent.path === cwd },
    entries: (screen.entries ?? []).map((e) => ({ ...e, current: e.path === cwd })),
  };
}

export interface BannersDeps {
  readonly log: HTMLElement;
  readonly machineNoteEl: HTMLElement;
  readonly forkNote: HTMLElement;
  readonly getTopic: () => string;
  readonly getTopics: () => readonly TranscriptTopicLike[];
  readonly topicById: (id: string) => TranscriptTopicLike | null | undefined;
  readonly getData: () => Readonly<Record<string, TranscriptMessage | undefined>>;
  readonly getEls: () => Readonly<Record<string, HTMLElement | undefined>>;
  readonly isSynced: () => boolean;
  readonly isStale: () => boolean;
  readonly getLaunch: () => LaunchChoice | null;
  readonly isHistory: (m: TranscriptMessage | undefined) => boolean;
  readonly getIcons: () => TranscriptIcons;
  readonly formatStatusClock: (ms: number) => string;
  readonly paintTopics: () => void;
  readonly paintStatus: () => void;
  readonly switchTopic: (id: string) => void;
  readonly isNarrow: () => boolean;
  readonly setSidebar: (open: boolean) => void;
  readonly onLaunchShown?: (agentId: string) => void;
}

export interface BannersController extends Disposable {
  showSkeleton(): void;
  clearSkeleton(): void;
  hasMessages(): boolean;
  syncEmptyNote(): void;
  syncLaunch(want: boolean): void;
  hasLaunch(): boolean;
  getLaunchWorkdir(): WorkdirScreen | null;
  setLaunchAgent(agentId: string, opts?: { readonly fold?: boolean }): void;
  setLaunchWorkdir(screen: WorkdirScreen | null, loading?: boolean): void;
  clearLaunchWorkdirLoading(): void;
  setLaunchCwd(cwd: string, opts?: { readonly fold?: boolean }): void;
  unfoldLaunch(part?: LaunchFoldPart): void;
  takeMachines(list: readonly OfflineMachine[] | null | undefined): boolean;
  setMachines(list: readonly OfflineMachine[] | null | undefined): void;
  offSince(name: string): number;
  offWhen(at: number): string;
  offTitle(name: string): string;
  paintMachineNote(): void;
  paintForkNote(cur: TranscriptTopicLike | null | undefined): void;
  attachForkNoteClick(): Disposable;
  placeDivider(): void;
  showSyncing(): void;
  clearSyncing(): void;
  getSyncingEl(): HTMLElement | null;
  resetForTopicSwitch(): void;
  refreshI18n(): void;
}

class BannersControllerImpl implements BannersController {
  private readonly _deps: BannersDeps;
  private _skeleton = false;
  private _emptyEl: HTMLElement | null = null;
  private _launchEl: HTMLElement | null = null;
  private _launchSig = '';
  private _launchWorkdir: WorkdirScreen | null = null;
  private _launchFoldTopic = '';
  private _agentsFolded = false;
  private _wdFolded = false;
  private _launchCwd = '';
  private _dividerEl: HTMLElement | null = null;
  private _syncingEl: HTMLElement | null = null;
  private _forkNoteKey = '';
  private _offlineMachines: Record<string, number> = {};
  private _offlineSig = '[]';
  private readonly _disposables = new DisposableStore();

  constructor(deps: BannersDeps) {
    this._deps = deps;
  }

  offSince(name: string): number {
    return name && Object.prototype.hasOwnProperty.call(this._offlineMachines, name)
      ? (this._offlineMachines[name] ?? 0)
      : 0;
  }

  offWhen(at: number): string {
    return offWhen(at, this._deps.formatStatusClock);
  }

  offTitle(name: string): string {
    return tr('chat.machineOfflineTitle', { name, when: this.offWhen(this.offSince(name)) });
  }

  clearSkeleton(): void {
    if (!this._skeleton) return;
    this._skeleton = false;
    this._deps.log.innerHTML = '';
    this._emptyEl = null;
    this._launchEl = null;
    this._launchSig = '';
    this._launchWorkdir = null;
    this._dividerEl = null;
    this._syncingEl = null;
  }

  showSkeleton(): void {
    if (this._deps.log.firstChild) return;
    this._deps.log.innerHTML = SKELETON_HTML;
    this._skeleton = true;
  }

  hasMessages(): boolean {
    const els = this._deps.getEls();
    for (const k in els) {
      if (Object.prototype.hasOwnProperty.call(els, k)) return true;
    }
    return false;
  }

  hasLaunch(): boolean {
    return Boolean(this._launchEl);
  }

  getLaunchWorkdir(): WorkdirScreen | null {
    return this._launchWorkdir;
  }

  clearLaunchWorkdirLoading(): void {
    const host = this._launchEl?.querySelector<HTMLElement>('.launch-wd');
    if (host) host.classList.remove('loading');
  }

  getSyncingEl(): HTMLElement | null {
    return this._syncingEl;
  }

  paintMachineNote(): void {
    const curTopic = this._deps.getTopic();
    const topics = this._deps.getTopics();
    let cur: TranscriptTopicLike | null = null;
    for (let i = 0; i < topics.length; i++) {
      const row = topics[i];
      if (row && row.id === curTopic) {
        cur = row;
        break;
      }
    }
    const name = cur && cur.dir && cur.dir.host ? cur.dir.host : '';
    const off = this.offSince(name);
    if (!off || this._launchEl) {
      this._deps.machineNoteEl.hidden = true;
      this._deps.machineNoteEl.innerHTML = '';
      return;
    }
    this._deps.machineNoteEl.innerHTML =
      (this._deps.getIcons().icon.offline ?? '') +
      `<span>${text(tr('chat.machineOfflineNote', { name, when: this.offWhen(off) }))}</span>`;
    this._deps.machineNoteEl.title = this.offTitle(name);
    this._deps.machineNoteEl.hidden = false;
  }

  syncLaunch(want: boolean): void {
    const launch = this._deps.getLaunch();
    const active = want && Boolean(launch);
    const s = active ? JSON.stringify(launch) + this._offlineSig : '';
    if (s === this._launchSig && active === Boolean(this._launchEl)) return;
    const topicId = this._deps.getTopic();
    const sameTopic = active && topicId === this._launchFoldTopic;
    const keptWd = sameTopic ? this._launchWorkdir : null;
    const keptCwd = sameTopic ? this._launchCwd : '';
    if (!sameTopic) this._resetLaunchFold(active ? topicId : '');
    this._teardownLaunchEl();
    if (active && launch) this._mountLaunchEl(launch, topicId, keptWd, keptCwd, s);
    this._deps.paintStatus();
    this.paintMachineNote();
  }

  private _resetLaunchFold(topicId: string): void {
    this._launchFoldTopic = topicId;
    this._agentsFolded = false;
    this._wdFolded = false;
    this._launchCwd = '';
  }

  private _teardownLaunchEl(): void {
    if (this._launchEl?.parentNode) {
      this._launchEl.parentNode.removeChild(this._launchEl);
    }
    this._launchEl = null;
    this._launchSig = '';
    this._launchWorkdir = null;
  }

  private _mountLaunchEl(
    launch: LaunchChoice,
    topicId: string,
    keptWd: WorkdirScreen | null,
    keptCwd: string,
    sig: string,
  ): void {
    this.clearSkeleton();
    this._launchEl = this._deps.log.ownerDocument.createElement('div');
    this._launchEl.className = 'launch';
    const cwd = keptCwd || (this._deps.topicById(topicId)?.dir?.path ?? '');
    this._launchCwd = cwd;
    this._launchEl.innerHTML = launchHtml(
      launch,
      this._deps.getIcons(),
      {
        offSince: (name) => this.offSince(name),
        offWhen: (at) => this.offWhen(at),
        offTitle: (name) => this.offTitle(name),
      },
      cwd,
      { agents: this._agentsFolded, workdir: this._wdFolded },
    );
    this._deps.log.appendChild(this._launchEl);
    this._launchSig = sig;
    if (keptWd) this.setLaunchWorkdir(keptWd);
    else this._syncLaunchFoldDom();
    this._deps.onLaunchShown?.(launch.current);
  }

  setLaunchAgent(agentId: string, opts?: { readonly fold?: boolean }): void {
    if (!this._launchEl) return;
    const icons = this._deps.getIcons();
    const cards = this._launchEl.querySelectorAll<HTMLButtonElement>('button[data-agent]');
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (!card) continue;
      const on = card.getAttribute('data-agent') === agentId;
      card.classList.toggle('def', on);
      const top = card.querySelector('.ac-top');
      if (!top) continue;
      top.querySelector('.ac-tag')?.remove();
      top.querySelector('.ac-check')?.remove();
      if (on) {
        const tag = card.ownerDocument.createElement('span');
        tag.className = 'ac-tag';
        tag.textContent = tr('chat.defaultTag');
        top.appendChild(tag);
        if (icons.icon.check) {
          const chk = card.ownerDocument.createElement('span');
          chk.className = 'ac-check';
          chk.setAttribute('aria-hidden', 'true');
          chk.innerHTML = icons.icon.check;
          top.appendChild(chk);
        }
      }
    }
    const subB = this._launchEl.querySelector('.launch-sub b');
    if (subB) subB.textContent = agentId;
    const choiceAgent = this._launchEl.querySelector('.launch-choice-agent');
    if (choiceAgent) choiceAgent.textContent = agentId;
    const launch = this._deps.getLaunch();
    if (launch) this._launchSig = JSON.stringify(launch) + this._offlineSig;
    if (opts?.fold !== undefined) {
      this._agentsFolded = opts.fold;
      this._syncLaunchFoldDom();
    }
  }

  setLaunchWorkdir(screen: WorkdirScreen | null, loading = false): void {
    if (!this._launchEl) return;
    const host = this._launchEl.querySelector<HTMLElement>('.launch-wd');
    if (!host) return;
    host.classList.toggle('loading', loading);
    if (screen) {
      this._launchWorkdir = screen;
      const cwd = screen.current || screen.browsing;
      if (cwd) this._launchCwd = cwd;
      host.innerHTML = workdirPickerHtml(screen, this._deps.getIcons(), {
        kind: 'launch',
        folded: this._wdFolded,
        selectedPath: this._launchCwd || cwd,
      });
      this._syncLaunchFoldDom();
    } else if (!loading) {
      this._launchWorkdir = null;
      host.innerHTML = '';
      this._syncLaunchFoldDom();
    }
  }

  setLaunchCwd(cwd: string, opts?: { readonly fold?: boolean }): void {
    if (!this._launchEl || !cwd) return;
    this._launchCwd = cwd;
    if (opts?.fold !== undefined) this._wdFolded = opts.fold;
    if (this._launchWorkdir) {
      this._launchWorkdir = withCurrentWorkdir(this._launchWorkdir, cwd);
      const host = this._launchEl.querySelector<HTMLElement>('.launch-wd');
      if (host) {
        host.innerHTML = workdirPickerHtml(this._launchWorkdir, this._deps.getIcons(), {
          kind: 'launch',
          folded: this._wdFolded,
          selectedPath: cwd,
        });
      }
    }
    this._syncLaunchFoldDom();
  }

  unfoldLaunch(part?: LaunchFoldPart): void {
    if (!this._launchEl) return;
    if (!part || part === 'agents') this._agentsFolded = false;
    if (!part || part === 'workdir') this._wdFolded = false;
    this._syncLaunchFoldDom();
  }

  private _syncLaunchFoldDom(): void {
    if (!this._launchEl) return;
    const choiceEl = this._launchEl.querySelector<HTMLElement>('.launch-choice');
    if (choiceEl) choiceEl.hidden = !this._agentsFolded;
    const agentsEl = this._launchEl.querySelector<HTMLElement>('.launch-agents');
    if (agentsEl) agentsEl.hidden = this._agentsFolded;
    const wdEl = this._launchEl.querySelector<HTMLElement>('.launch-wd');
    if (wdEl) {
      wdEl.hidden = !this._launchWorkdir;
      const picker = wdEl.querySelector<HTMLElement>('.wd-picker');
      if (picker) {
        picker.classList.toggle('folded', this._wdFolded);
        const body = picker.querySelector<HTMLElement>('.wd-body');
        if (body) body.hidden = this._wdFolded;
        const hint = picker.querySelector<HTMLElement>('.wd-hint');
        if (hint) hint.hidden = this._wdFolded;
        const selected = picker.querySelector<HTMLElement>('.wd-selected');
        if (selected) {
          selected.hidden = !this._wdFolded;
          const code = selected.querySelector<HTMLElement>('.wd-path');
          const path = this._launchCwd || this._launchWorkdir?.current || this._launchWorkdir?.browsing || '';
          if (code && path) {
            code.textContent = path;
            code.title = path;
          }
        }
        const wdChange = picker.querySelector<HTMLButtonElement>('[data-launch-unfold="workdir"]');
        if (wdChange) wdChange.hidden = !this._wdFolded;
      }
    }
    this._launchEl.classList.toggle('agents-folded', this._agentsFolded);
    this._launchEl.classList.toggle('wd-folded', this._wdFolded);
  }

  syncEmptyNote(): void {
    const empty = !this.hasMessages();
    this.syncLaunch(Boolean(this._deps.getLaunch()) && empty);
    const want = this._deps.isStale() && empty && !this._launchEl;
    if (want === Boolean(this._emptyEl)) return;
    if (want) {
      this.clearSkeleton();
      this._emptyEl = this._deps.log.ownerDocument.createElement('div');
      this._emptyEl.className = 'empty';
      this._emptyEl.textContent = tr('chat.emptyNote');
      this._deps.log.appendChild(this._emptyEl);
    } else if (this._emptyEl) {
      if (this._emptyEl.parentNode) this._emptyEl.parentNode.removeChild(this._emptyEl);
      this._emptyEl = null;
    }
  }

  takeMachines(list: readonly OfflineMachine[] | null | undefined): boolean {
    const items = list ?? [];
    const sigNow = JSON.stringify(items);
    if (sigNow === this._offlineSig) return false;
    const next: Record<string, number> = {};
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item) next[item.name] = item.since;
    }
    this._offlineMachines = next;
    this._offlineSig = sigNow;
    return true;
  }

  setMachines(list: readonly OfflineMachine[] | null | undefined): void {
    if (!this.takeMachines(list)) return;
    this._deps.paintTopics();
    if (this._launchEl) this.syncLaunch(true);
  }

  paintForkNote(cur: TranscriptTopicLike | null | undefined): void {
    const src = cur && cur.forkOf ? this._deps.topicById(cur.forkOf) : null;
    const key = forkNoteSignature(cur, src);
    if (key === this._forkNoteKey) return;
    this._forkNoteKey = key;
    this._deps.forkNote.hidden = !src;
    if (!src) {
      this._deps.forkNote.innerHTML = '';
      this._deps.forkNote.removeAttribute('data-src');
      return;
    }
    this._deps.forkNote.innerHTML = forkNoteMarkup(src, cur?.forkTurn, this._deps.getIcons());
    this._deps.forkNote.setAttribute('data-src', src.id);
    this._deps.forkNote.title = tr('topic.backTo', { title: src.title || tr('common.untitled') });
  }

  attachForkNoteClick(): Disposable {
    const sub = addDisposableListener(this._deps.forkNote, 'click', () => {
      const id = this._deps.forkNote.getAttribute('data-src');
      if (!id || !this._deps.topicById(id)) return;
      this._deps.switchTopic(id);
      if (this._deps.isNarrow()) this._deps.setSidebar(false);
    });
    this._disposables.add(sub);
    return sub;
  }

  placeDivider(): void {
    const data = this._deps.getData();
    let last: ChildNode | null = null;
    for (let n: ChildNode | null = this._deps.log.firstChild; n; n = n.nextSibling) {
      const k = n instanceof Element ? n.getAttribute('data-k') : null;
      if (k && this._deps.isHistory(data[k])) last = n;
    }
    if (!last) {
      if (this._dividerEl && this._dividerEl.parentNode) {
        this._dividerEl.parentNode.removeChild(this._dividerEl);
      }
      this._dividerEl = null;
      return;
    }
    if (!this._dividerEl) {
      this._dividerEl = this._deps.log.ownerDocument.createElement('div');
      this._dividerEl.className = 'divider';
      this._dividerEl.textContent = tr('chat.dividerNote');
    }
    if (last.nextSibling !== this._dividerEl) {
      this._deps.log.insertBefore(this._dividerEl, last.nextSibling);
    }
  }

  showSyncing(): void {
    if (this._syncingEl || this._deps.isSynced() || this._skeleton || !this._deps.log.firstChild) {
      return;
    }
    this._syncingEl = this._deps.log.ownerDocument.createElement('div');
    this._syncingEl.className = 'syncing';
    this._syncingEl.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span>${text(tr('chat.syncNote'))}</span>`;
    this._deps.log.appendChild(this._syncingEl);
  }

  clearSyncing(): void {
    if (this._syncingEl && this._syncingEl.parentNode) {
      this._syncingEl.parentNode.removeChild(this._syncingEl);
    }
    this._syncingEl = null;
  }

  resetForTopicSwitch(): void {
    this._skeleton = false;
    this._emptyEl = null;
    this._launchEl = null;
    this._launchSig = '';
    this._launchWorkdir = null;
    this._launchFoldTopic = '';
    this._agentsFolded = false;
    this._wdFolded = false;
    this._launchCwd = '';
    this._dividerEl = null;
    this._syncingEl = null;
  }

  refreshI18n(): void {
    this._forkNoteKey = '';
    this._launchSig = '';
    if (this._launchEl) this.syncLaunch(true);
    if (this._emptyEl) this._emptyEl.textContent = tr('chat.emptyNote');
    if (this._dividerEl) this._dividerEl.textContent = tr('chat.dividerNote');
    if (this._syncingEl) {
      const sp = this._syncingEl.querySelectorAll('span');
      if (sp[1]) sp[1].textContent = tr('chat.syncNote');
    }
  }

  dispose(): void {
    this._disposables.dispose();
  }
}

export function createBannersController(deps: BannersDeps): BannersController {
  return new BannersControllerImpl(deps);
}
