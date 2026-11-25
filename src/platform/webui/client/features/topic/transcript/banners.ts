import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import { text } from '../../../services/api.js';
import type {
  LaunchAgent,
  LaunchChoice,
  OfflineMachine,
  TranscriptIcons,
  TranscriptMessage,
  TranscriptTopicLike,
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

function findLaunchAgent(choice: LaunchChoice, id: string): LaunchAgent | undefined {
  for (const g of choice.groups) {
    for (const a of g.agents) {
      if (a.id === id) return a;
    }
  }
  return undefined;
}

function launchDirsHtml(agent: LaunchAgent | undefined, activeCwd?: string): string {
  if (!agent) return '';
  const seen = new Set<string>();
  const list: string[] = [];
  if (agent.root) {
    seen.add(agent.root);
    list.push(agent.root);
  }
  for (const d of agent.dirs ?? []) {
    if (d && !seen.has(d)) {
      seen.add(d);
      list.push(d);
    }
  }
  if (list.length === 0) return '';
  const chosen = activeCwd && seen.has(activeCwd) ? activeCwd : list[0];
  let h = `<section class="launch-dirs" data-launch-dirs-for="${text(agent.id)}">`;
  h += `<h3 class="launch-host">${text(tr('chat.launchDirsTitle', { agent: agent.id }))}</h3>`;
  h += '<div class="launch-dir-grid">';
  for (const d of list) {
    const on = d === chosen;
    h += `<button type="button" class="launch-dir${on ? ' on' : ''}" data-cwd="${text(d)}" data-cwd-agent="${text(agent.id)}" title="${text(d)}">${text(d)}</button>`;
  }
  h += `<button type="button" class="launch-dir more" data-cwd-more="1">${text(tr('chat.launchOtherDir'))}</button>`;
  h += '</div></section>';
  return h;
}

export function launchHtml(
  choice: LaunchChoice,
  icons: TranscriptIcons,
  offline: LaunchOfflineView,
  activeCwd?: string,
): string {
  let h =
    `<div class="launch-head"><div class="launch-title">${text(tr('chat.launchTitle'))}</div>` +
    `<div class="launch-sub">${text(tr('chat.launchSubPrefix'))}<b>${text(choice.current)}</b>${text(tr('chat.launchSubSuffix'))}</div></div>`;
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
    for (let j = 0; j < g.agents.length; j++) {
      const a = g.agents[j];
      if (!a) continue;
      const on = a.id === choice.current;
      const offSuffix = off ? text(tr('chat.agentOffline', { name: g.name })) : '';
      const harnessBadge =
        a.harness && a.harness !== 'custom'
          ? `<span class="ac-hc h-${text(a.harness)}">${text(a.harness)}</span>`
          : '';
      const checkMark = on && icons.icon.check
        ? `<span class="ac-check" aria-hidden="true">${icons.icon.check}</span>`
        : '';
      h +=
        `<button type="button" class="agent-card${on ? ' def' : ''}" data-agent="${text(a.id)}" title="/agent ${text(a.id)}${offSuffix}">` +
        `<span class="ac-top">${harnessBadge}<span class="ac-id">${text(a.id)}</span>${on ? `<span class="ac-tag">${text(tr('chat.defaultTag'))}</span>` : ''}${checkMark}</span>` +
        `<span class="ac-kind"><span>${text(a.kind)}</span>${a.model ? `<span class="ac-sep" aria-hidden="true"> \u00b7 </span><span class="ac-model" title="${text(a.model)}">${text(a.model)}</span>` : ''}</span>` +
        '</button>';
    }
    h += '</div></section>';
  }
  h += launchDirsHtml(findLaunchAgent(choice, choice.current), activeCwd);
  return h;
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
}

export interface BannersController extends Disposable {
  showSkeleton(): void;
  clearSkeleton(): void;
  hasMessages(): boolean;
  syncEmptyNote(): void;
  syncLaunch(want: boolean): void;
  hasLaunch(): boolean;
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
    const activeCwd = this._deps.topicById(this._deps.getTopic())?.dir?.path ?? '';
    const s = active ? JSON.stringify(launch) + this._offlineSig + activeCwd : '';
    if (s === this._launchSig && active === Boolean(this._launchEl)) return;
    if (this._launchEl && this._launchEl.parentNode) {
      this._launchEl.parentNode.removeChild(this._launchEl);
    }
    this._launchEl = null;
    this._launchSig = '';
    if (active && launch) {
      this.clearSkeleton();
      this._launchEl = this._deps.log.ownerDocument.createElement('div');
      this._launchEl.className = 'launch';
      this._launchEl.innerHTML = launchHtml(launch, this._deps.getIcons(), {
        offSince: (name) => this.offSince(name),
        offWhen: (at) => this.offWhen(at),
        offTitle: (name) => this.offTitle(name),
      }, activeCwd);
      this._deps.log.appendChild(this._launchEl);
      this._launchSig = s;
    }
    this._deps.paintStatus();
    this.paintMachineNote();
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
