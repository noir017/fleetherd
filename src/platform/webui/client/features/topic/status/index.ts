import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import { hasCountdown, renderBareStatus, statusSegments } from './format.js';
import { createModelPopController, PERM_OPT_ID, type ModelPopElements } from './model-pop.js';
import { createPendingQueueController } from './pending-queue.js';
import type {
  AgentStatus,
  LocalPendingItem,
  OptionPeekResponse,
  StatusIcons,
  StatusOption,
  StatusPermissions,
  WebPendingItem,
} from './types.js';

export * from './types.js';
export * from './format.js';
export * from './pending-queue.js';
export * from './model-pop.js';

export const STATUS_TICK_MS = 30000;
export const PEEK_DEBOUNCE_MS = 400;

export interface TopicStatusDeps {
  readonly statusEl: HTMLElement | null;
  readonly pendingQueueEl: HTMLElement | null;
  readonly modelPopEls: ModelPopElements;
  readonly doc?: Document;
  readonly getTopic: () => string;
  readonly isSynced: () => boolean;
  readonly hasLauncher: () => boolean;
  readonly hasMessages: () => boolean;
  readonly narrow: () => boolean;
  readonly getIcons: () => StatusIcons;
  readonly inl: (s: string) => string;
  readonly setNote: (msg: string) => void;
  readonly onRetireLocalNonce: (nonce: string) => void;
  readonly onRecallContent: (content: string) => void;
  readonly now?: () => number;
  readonly fetchFn?: typeof fetch;
  readonly postFn?: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
}

export interface TopicStatusController extends Disposable {
  attach(): void;
  setStatus(s: AgentStatus | null | undefined): void;
  paintStatus(): void;
  armStatusTick(): void;
  schedulePeek(): void;
  peekOptions(): void;
  onMessageArrived(): void;
  onAgentChosen(): void;
  openModelPop(): void;
  openOptPop(id: string): void;
  closeModelPop(): void;
  setPending(items: readonly WebPendingItem[] | null | undefined): void;
  paintPending(): void;
  addLocalPending(item: LocalPendingItem): void;
  hasLocalPending(nonce: string): boolean;
  removeLocalPending(nonce: string): boolean;
  onLocaleChange(): void;
}

interface PeekState {
  topic: string | null;
  agent: string;
  model: string;
  options: StatusOption[];
  permissions: StatusPermissions | null;
  seq: number;
  timer: ReturnType<typeof setTimeout> | null;
}

class TopicStatusControllerImpl implements TopicStatusController {
  private readonly doc: Document;
  private readonly nowFn: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly listeners = new DisposableStore();
  private readonly pop: ReturnType<typeof createModelPopController>;
  private readonly pendingQueue: ReturnType<typeof createPendingQueueController>;

  private agentStatus: AgentStatus | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private statusHtml = '';
  private chosenTopic: string | null = null;
  private readonly opk: PeekState = {
    topic: null,
    agent: '',
    model: '',
    options: [],
    permissions: null,
    seq: 0,
    timer: null,
  };

  constructor(private readonly deps: TopicStatusDeps) {
    this.doc = deps.doc ?? document;
    this.nowFn = deps.now ?? (() => Date.now());
    this.fetchFn = deps.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.pop = createModelPopController({
      els: deps.modelPopEls,
      doc: this.doc,
      getTopic: deps.getTopic,
      getIcons: deps.getIcons,
      narrow: deps.narrow,
      inl: deps.inl,
      resolveOptName: (id) => this.resolveOptName(id),
      onVisibilityChange: () => this.paintStatus(),
      onListLoaded: (t) => {
        if (t === deps.getTopic() && !this.agentStatus) this.peekOptions();
      },
      onModelChosen: (t, model) => {
        if (t === deps.getTopic() && this.agentStatus) {
          this.agentStatus = { ...this.agentStatus, model };
        }
      },
      onOptionChosen: (t) => {
        if (t === deps.getTopic()) this.peekOptions();
      },
      onPermChosen: (t, level) => {
        if (t !== deps.getTopic()) return;
        if (this.agentStatus?.permissions) {
          this.agentStatus = { ...this.agentStatus, permissions: { ...this.agentStatus.permissions, level: level as StatusPermissions['level'], unset: false } };
        }
        if (this.opk.topic === t && this.opk.permissions) {
          this.opk.permissions = { ...this.opk.permissions, level: level as StatusPermissions['level'], unset: false };
        }
        this.paintStatus();
      },
      setNote: deps.setNote,
      fetchFn: deps.fetchFn,
      postFn: deps.postFn,
    });
    this.pendingQueue = createPendingQueueController({
      pendingQueueEl: deps.pendingQueueEl,
      getTopic: deps.getTopic,
      getIcons: deps.getIcons,
      onRetireLocalNonce: deps.onRetireLocalNonce,
      onRecallContent: deps.onRecallContent,
      postFn: deps.postFn,
    });
  }

  private opkFor(t: string): readonly StatusOption[] {
    return this.opk.topic === t ? this.opk.options : [];
  }

  private resolveOptName(id: string): string {
    if (id === PERM_OPT_ID) return tr('status.permLabel');
    const list = (this.agentStatus && this.agentStatus.options) || this.opkFor(this.deps.getTopic());
    for (const item of list) {
      if (item.id === id) return item.name;
    }
    return tr('modelPop.settingFallback');
  }

  armStatusTick(): void {
    const want = hasCountdown(this.agentStatus) && this.doc.visibilityState !== 'hidden';
    if (want && !this.statusTimer) {
      this.statusTimer = setInterval(() => this.paintStatus(), STATUS_TICK_MS);
    } else if (!want && this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  peekOptions(): void {
    const t = this.deps.getTopic();
    if (!t || this.agentStatus) return;
    const n = ++this.opk.seq;
    // Claim the topic immediately so repaints while the request is in flight do not re-trigger peek.
    if (this.opk.topic !== t) {
      this.opk.topic = t;
      this.opk.agent = '';
      this.opk.model = '';
      this.opk.options = [];
      this.opk.permissions = null;
    }
    this.fetchFn(`api/options?peek=1&t=${encodeURIComponent(t)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<OptionPeekResponse>) : null))
      .then(
        (j) => {
          if (n !== this.opk.seq || t !== this.opk.topic || !j) return;
          this.opk.agent = j.agent || '';
          this.opk.model = j.model || '';
          this.opk.options = j.options ? [...j.options] : [];
          this.opk.permissions = j.permissions ?? null;
          this.paintStatus();
        },
        () => {},
      );
  }

  schedulePeek(): void {
    if (this.opk.timer) clearTimeout(this.opk.timer);
    this.opk.timer = setTimeout(() => {
      this.opk.timer = null;
      this.peekOptions();
    }, PEEK_DEBOUNCE_MS);
  }

  private renderStatusHtml(t: string, openModel: boolean, openOptId: string | null): string {
    const s = this.agentStatus;
    const opkSame = this.opk.topic === t;
    if (s) {
      return statusSegments(s, this.nowFn(), Boolean(this.deps.statusEl?.classList.contains('open')), {
        fallbackOptions: this.opkFor(t),
        fallbackPermissions: opkSame ? this.opk.permissions : null,
        openModel,
        openOptId,
      });
    }
    const chosen = Boolean(t && this.chosenTopic === t);
    const bare = Boolean(
      t && this.deps.isSynced() && (chosen || (!this.deps.hasLauncher() && this.deps.hasMessages())),
    );
    if (!bare) return '';
    if (this.opk.topic !== t) this.schedulePeek();
    return renderBareStatus({
      agent: opkSame ? this.opk.agent : '',
      model: (opkSame && this.opk.model) || tr('status.model'),
      options: this.opkFor(t),
      permissions: opkSame ? this.opk.permissions : null,
      openModel,
      openOptId,
    });
  }

  paintStatus(): void {
    const statusEl = this.deps.statusEl;
    if (!statusEl) return;
    const t = this.deps.getTopic();
    // Ask the live launcher element rather than the sync snapshot so the switch appears immediately
    // after picking an agent in a new topic, before the first reply reports a status.
    const openModel = this.pop.isOpen() && !this.pop.currentOpt();
    const openOptId = this.pop.currentOpt();
    const html = this.renderStatusHtml(t, openModel, openOptId);
    if (html === this.statusHtml) return;
    this.statusHtml = html;
    statusEl.innerHTML = html;
    statusEl.hidden = !html;
  }

  setStatus(s: AgentStatus | null | undefined): void {
    this.agentStatus = s || null;
    this.paintStatus();
    this.armStatusTick();
  }

  onMessageArrived(): void {
    if (!this.agentStatus) {
      this.paintStatus();
      this.schedulePeek();
    }
  }

  onAgentChosen(): void {
    const t = this.deps.getTopic();
    if (!t) return;
    this.chosenTopic = t;
    this.pop.close();
    this.opk.topic = t;
    this.opk.agent = '';
    this.opk.model = '';
    this.opk.options = [];
    this.opk.permissions = null;
    if (this.opk.timer) {
      clearTimeout(this.opk.timer);
      this.opk.timer = null;
    }
    this.paintStatus();
  }

  openModelPop(): void {
    this.pop.openModel();
  }

  openOptPop(id: string): void {
    this.pop.openOption(id);
  }

  closeModelPop(): void {
    this.pop.close();
  }

  setPending(items: readonly WebPendingItem[] | null | undefined): void {
    this.pendingQueue.setPending(items);
  }

  paintPending(): void {
    this.pendingQueue.paint();
  }

  addLocalPending(item: LocalPendingItem): void {
    this.pendingQueue.addLocal(item);
  }

  hasLocalPending(nonce: string): boolean {
    return this.pendingQueue.hasLocal(nonce);
  }

  removeLocalPending(nonce: string): boolean {
    return this.pendingQueue.removeLocal(nonce);
  }

  onLocaleChange(): void {
    this.statusHtml = '';
    this.paintStatus();
    this.pop.refreshI18n();
  }

  private togglePermPop(): void {
    const sameTopic = this.opk.topic === this.deps.getTopic();
    const perms = this.agentStatus?.permissions ?? (sameTopic ? this.opk.permissions : null);
    const agent = this.agentStatus?.agent || (sameTopic ? this.opk.agent : '');
    if (!perms || !agent) return;
    if (this.pop.isOpen() && this.pop.currentOpt() === PERM_OPT_ID) this.pop.close();
    else this.pop.openPermissions(agent, perms);
  }

  private toggleOptPop(ob: HTMLButtonElement): void {
    if (ob.disabled) return;
    const oid = ob.getAttribute('data-opt');
    if (!oid) return;
    if (this.pop.isOpen() && this.pop.currentOpt() === oid) this.pop.close();
    else this.pop.openOption(oid);
  }

  private handleStatusClick(target: Element): void {
    if (target.closest('.st-perm')) {
      this.togglePermPop();
      return;
    }
    const ob = target.closest<HTMLButtonElement>('.st-opt');
    if (ob) {
      this.toggleOptPop(ob);
      return;
    }
    if (target.closest('.st-model')) {
      if (this.pop.isOpen() && !this.pop.currentOpt()) this.pop.close();
      else this.pop.openModel();
      return;
    }
    this.deps.statusEl?.classList.toggle('open');
    this.paintStatus();
  }

  attach(): void {
    const statusEl = this.deps.statusEl;
    this.listeners.add(this.pendingQueue.attach());
    this.listeners.add(this.pop.attach());
    if (statusEl) {
      this.listeners.add(
        addDisposableListener(statusEl, 'click', (e) => {
          if (e.target instanceof Element) this.handleStatusClick(e.target);
        }),
      );
    }
    this.listeners.add(
      addDisposableListener(this.doc, 'visibilitychange', () => {
        if (this.doc.visibilityState !== 'hidden') this.paintStatus();
        this.armStatusTick();
      }),
    );
  }

  dispose(): void {
    this.listeners.dispose();
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.opk.timer) {
      clearTimeout(this.opk.timer);
      this.opk.timer = null;
    }
  }
}

export function createTopicStatusController(deps: TopicStatusDeps): TopicStatusController {
  return new TopicStatusControllerImpl(deps);
}
