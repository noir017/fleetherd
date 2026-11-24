import { icon, type IconName } from '../../../icons.js';
import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { DisposableStore, toDisposable } from '../../base/lifecycle.js';
import { createMenu, type MenuController, type MenuEntry } from '../../components/menu/index.js';
import { escapeAttrValue } from '../../components/shared.js';
import { createTabs, type TabItem, type TabsController } from '../../components/tabs/index.js';
import { t as tr } from '../../i18n/index.js';
import {
  definePlugin,
  type PluginContext,
  type TopicInfo,
  type TopicToolContribution,
  type WebuiPlugin,
} from '../../plugins/api.js';
import { post as defaultPost } from '../../services/api.js';
import { type BootConfig, readBootConfig } from '../../services/boot.js';
import type { StorageService } from '../../services/storage.js';
import {
  createTerminalEditorComponent,
  formatTerminalEditorTitle,
  TERMINAL_EDITOR_KIND,
  type TerminalEditorInput,
} from './editor.js';
import { buildTerminalIframeSrc, type TerminalTab, TerminalTabStore } from './tabs-store.js';

type PanelComponent = ReturnType<TopicToolContribution['component']>;
type PanelInitContext = Parameters<PanelComponent['init']>[1];
type PanelRef = PanelInitContext['api'];

export const TERMINAL_PLUGIN_ID = 'terminal';
export const TERMINAL_TOOL_ID = 'terminal';
export const TERMINAL_PANEL_ID = `tool:${TERMINAL_TOOL_ID}`;
export const TERMINAL_TOGGLE_COMMAND = 'terminal.toggle';
export const TERMINAL_END_SESSION_COMMAND = 'terminal.endSession';
export const TERMINAL_NEW_TAB_COMMAND = 'terminal.newTab';
export const TERMINAL_CLOSE_TAB_COMMAND = 'terminal.closeTab';
export const TERMINAL_RENAME_TAB_COMMAND = 'terminal.renameTab';
export const TERMINAL_MOVE_TO_SECONDARY_COMMAND = 'terminal.moveToSecondary';
export const TERMINAL_MOVE_TO_PANEL_COMMAND = 'terminal.moveToPanel';
export const TERMINAL_OPEN_IN_EDITOR_COMMAND = 'terminal.openInEditor';

const WORKBENCH_MOVE_VIEW_TO_SECONDARY = 'workbench.action.moveViewToSecondary';
const WORKBENCH_MOVE_VIEW_TO_PANEL = 'workbench.action.moveViewToPanel';
const MAIN_EDITOR_GROUP = 'main';

export { TERMINAL_EDITOR_KIND };
export type { TerminalEditorInput, TerminalTab };

export interface TerminalPluginDeps {
  readonly boot?: Pick<BootConfig, 'terminal' | 'terminalEnd'>;
  readonly toggleTool?: (topicId: string) => boolean | void;
  readonly minimizePanel?: () => void;
  readonly post?: (path: string, body: unknown, tries: number) => Promise<Response>;
  readonly storage?: StorageService;
  readonly resolveIcon?: (name: IconName) => string;
  readonly win?: Window;
  readonly doc?: Document;
  readonly confirmFn?: (message: string) => boolean;
  readonly alertFn?: (message: string) => void;
}

interface TerminalPanelParams {
  readonly topicId?: string;
}

interface TermEndErrorBody {
  readonly error?: string;
}

const TERMINAL_I18N_EN: Record<string, string> = {
  'term.newTab': 'New terminal',
  'term.closeTab': 'Close terminal tab',
  'term.renameTab': 'Rename terminal',
  'term.renamePlaceholder': 'Terminal name',
  'term.moveToSecondary': 'Move to Secondary Side Bar',
  'term.moveToPanel': 'Move to Bottom Panel',
  'term.openInEditor': 'Open in Editor (Split Right)',
  'term.moreActions': 'Terminal actions',
  'term.emptyHint': 'No open terminals',
};

const TERMINAL_I18N_ZH: Record<string, string> = {
  'term.newTab': '新建终端',
  'term.closeTab': '关闭终端标签',
  'term.renameTab': '重命名终端',
  'term.renamePlaceholder': '终端名称',
  'term.moveToSecondary': '移到副侧栏',
  'term.moveToPanel': '移到底部面板',
  'term.openInEditor': '在编辑器区打开（右侧分屏）',
  'term.moreActions': '终端操作',
  'term.emptyHint': '暂无打开的终端',
};

function isValidTopic(topic: TopicInfo | undefined): topic is TopicInfo {
  return Boolean(topic && typeof topic.id === 'string' && topic.id.trim().length > 0);
}

function extractTopicId(params: unknown): string | undefined {
  if (typeof params === 'string' && params.trim()) return params.trim();
  if (params && typeof params === 'object') {
    const candidate = (params as TerminalPanelParams).topicId;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function resolveSvg(resolveIcon: ((name: IconName) => string) | undefined, name: IconName): string {
  return resolveIcon ? resolveIcon(name) : icon(name);
}

interface TerminalDomParts {
  readonly bar: HTMLDivElement;
  readonly tabsWrap: HTMLDivElement;
  readonly tabs: TabsController;
  readonly termName: HTMLSpanElement;
  readonly actions: HTMLDivElement;
  readonly newTabBtn: HTMLButtonElement;
  readonly moveBtn: HTMLButtonElement;
  readonly openEditorBtn: HTMLButtonElement;
  readonly moreBtn: HTMLButtonElement;
  readonly termMinBtn: HTMLButtonElement;
  readonly termEndBtn: HTMLButtonElement;
  readonly termHost: HTMLDivElement;
  readonly emptyState: HTMLDivElement;
  readonly emptyNewBtn: HTMLButtonElement;
  readonly menu: MenuController;
}

function makeIconButton(
  doc: Document,
  cls: string,
  title: string,
  svg: string,
  ariaLabel = title,
): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = `wb-icon-btn ${cls}`;
  btn.title = title;
  btn.setAttribute('aria-label', ariaLabel);
  btn.innerHTML = svg;
  return btn;
}

function createTerminalDom(
  doc: Document,
  win: Window,
  canEnd: boolean,
  resolveIcon: ((name: IconName) => string) | undefined,
  t: (key: string) => string,
  onSelectTab: (tabId: string) => void,
  onCloseTab: (tabId: string) => void,
): TerminalDomParts {
  const bar = doc.createElement('div');
  bar.className = 'wb-term-bar';

  const tabsWrap = doc.createElement('div');
  tabsWrap.className = 'wb-term-tabs-wrap';

  const tabs = createTabs(
    {
      items: [],
      activeId: '',
      singleTabMode: 'bar',
      className: 'wb-term-tabs',
      ariaLabel: tr('term.title'),
      closeIcon: resolveSvg(resolveIcon, 'cross'),
      onSelect: onSelectTab,
      onClose: onCloseTab,
    },
    doc,
  );
  tabsWrap.appendChild(tabs.el);

  const termName = doc.createElement('span');
  termName.className = 'term-name wb-term-sr-only';
  termName.textContent = tr('common.untitled');

  const actions = doc.createElement('div');
  actions.className = 'wb-term-actions';

  const newTabBtn = makeIconButton(doc, 'wb-term-new', t('term.newTab'), resolveSvg(resolveIcon, 'plus'));
  const moveBtn = makeIconButton(
    doc,
    'wb-term-move-right',
    t('term.moveToSecondary'),
    resolveSvg(resolveIcon, 'chevronRight'),
  );
  const openEditorBtn = makeIconButton(
    doc,
    'wb-term-open-editor',
    t('term.openInEditor'),
    resolveSvg(resolveIcon, 'diff'),
  );
  const moreBtn = makeIconButton(doc, 'wb-term-more', t('term.moreActions'), resolveSvg(resolveIcon, 'more'));
  const termMinBtn = makeIconButton(
    doc,
    'wb-term-min',
    tr('term.minTitle'),
    resolveSvg(resolveIcon, 'chevronDown'),
    tr('term.minBtnTitle'),
  );
  const termEndBtn = makeIconButton(doc, 'wb-term-end', tr('term.endTitle'), resolveSvg(resolveIcon, 'cross'));
  termEndBtn.hidden = !canEnd;

  actions.append(newTabBtn, moveBtn, openEditorBtn, moreBtn, termMinBtn, termEndBtn);
  bar.append(tabsWrap, termName, actions);

  const termHost = doc.createElement('div');
  termHost.className = 'wb-term-frames';

  const emptyState = doc.createElement('div');
  emptyState.className = 'wb-term-empty';
  emptyState.hidden = true;
  const emptyHint = doc.createElement('span');
  emptyHint.className = 'wb-term-empty-hint';
  emptyHint.textContent = t('term.emptyHint');
  const emptyNewBtn = doc.createElement('button');
  emptyNewBtn.type = 'button';
  emptyNewBtn.className = 'fh-btn fh-btn--secondary wb-term-empty-new';
  emptyNewBtn.textContent = t('term.newTab');
  emptyState.append(emptyHint, emptyNewBtn);
  termHost.appendChild(emptyState);

  const menu = createMenu({ doc, win, align: 'end', className: 'wb-term-menu' });

  return {
    bar,
    tabsWrap,
    tabs,
    termName,
    actions,
    newTabBtn,
    moveBtn,
    openEditorBtn,
    moreBtn,
    termMinBtn,
    termEndBtn,
    termHost,
    emptyState,
    emptyNewBtn,
    menu,
  };
}

interface TerminalSessionState {
  readonly doc: Document;
  readonly win: Window;
  readonly boot: Pick<BootConfig, 'terminal' | 'terminalEnd'>;
  readonly dom: TerminalDomParts;
  readonly store: TerminalTabStore;
  readonly frames: Map<string, HTMLIFrameElement>;
  readonly openTopics: Map<string, 'open' | 'min'>;
  readonly ctx: PluginContext;
  readonly deps: TerminalPluginDeps;
  readonly post: (path: string, body: unknown, tries: number) => Promise<Response>;
  readonly confirm: (message: string) => boolean;
  readonly alert: (message: string) => void;
  activeTopicId: string;
  panelVisible: boolean;
  currentPanelApi: PanelRef | undefined;
  panelEl: HTMLElement | undefined;
  renamingTabId: string | undefined;
  getTopicTitle(topicId: string): string | undefined;
  syncActiveTopic(nextTopicId: string): void;
  showTopic(topicId?: string): void;
  minimizeTopic(topicId?: string): void;
  minimizeView(): void;
  createTab(topicId?: string): TerminalTab | undefined;
  selectTab(tabId: string): void;
  closeTab(tabId?: string): boolean;
  renameTab(tabId: string, nextTitle: string): boolean;
  startInlineRename(tabId?: string): boolean;
  cancelInlineRename(): void;
  moveToPart(part: 'secondary' | 'panel'): Promise<boolean>;
  openInEditor(arg?: unknown): boolean;
  endTopicSession(topicId?: string): Promise<boolean>;
  paint(): void;
  pruneTopics(keep: Readonly<Record<string, unknown>>): void;
  disposeAll(): void;
}

function mountTabIframe(state: TerminalSessionState, tab: TerminalTab): HTMLIFrameElement {
  const existing = state.frames.get(tab.id);
  if (existing) return existing;
  const frame = state.doc.createElement('iframe');
  frame.setAttribute('title', tab.title);
  frame.setAttribute('src', buildTerminalIframeSrc(tab.topicId, tab.id, tab.primary));
  frame.setAttribute('data-tab-id', tab.id);
  frame.setAttribute('data-topic-id', tab.topicId);
  state.frames.set(tab.id, frame);
  state.dom.termHost.appendChild(frame);
  return frame;
}

function dropTabIframe(state: TerminalSessionState, tabId: string): void {
  const frame = state.frames.get(tabId);
  if (frame) {
    frame.remove();
    state.frames.delete(tabId);
  }
}

function updateMoveButton(state: TerminalSessionState): void {
  const inSecondary = state.currentPanelApi?.group === 'secondary';
  const title = inSecondary ? state.ctx.i18n.t('term.moveToPanel') : state.ctx.i18n.t('term.moveToSecondary');
  const iconName: IconName = inSecondary ? 'chevronDown' : 'chevronRight';
  state.dom.moveBtn.title = title;
  state.dom.moveBtn.setAttribute('aria-label', title);
  state.dom.moveBtn.innerHTML = resolveSvg(state.deps.resolveIcon, iconName);
  if (state.panelEl && state.currentPanelApi) {
    state.panelEl.setAttribute('data-dock-part', String(state.currentPanelApi.group));
  }
}

function buildTabMenuEntries(state: TerminalSessionState, tab: TerminalTab | undefined): readonly MenuEntry[] {
  const inSecondary = state.currentPanelApi?.group === 'secondary';
  const inPanel = !inSecondary && state.currentPanelApi?.group !== 'sidebar';
  const t = (key: string): string => state.ctx.i18n.t(key);
  const entries: MenuEntry[] = [
    {
      id: 'new',
      label: t('term.newTab'),
      icon: resolveSvg(state.deps.resolveIcon, 'plus'),
      onSelect: () => {
        state.createTab();
      },
    },
    {
      id: 'rename',
      label: t('term.renameTab'),
      icon: resolveSvg(state.deps.resolveIcon, 'pencil'),
      disabled: !tab,
      onSelect: () => {
        if (tab) state.startInlineRename(tab.id);
      },
    },
    { kind: 'separator' },
    {
      id: 'move-secondary',
      label: t('term.moveToSecondary'),
      icon: resolveSvg(state.deps.resolveIcon, 'chevronRight'),
      disabled: inSecondary,
      onSelect: () => {
        void state.moveToPart('secondary');
      },
    },
    {
      id: 'move-panel',
      label: t('term.moveToPanel'),
      icon: resolveSvg(state.deps.resolveIcon, 'chevronDown'),
      disabled: inPanel,
      onSelect: () => {
        void state.moveToPart('panel');
      },
    },
    {
      id: 'open-editor',
      label: t('term.openInEditor'),
      icon: resolveSvg(state.deps.resolveIcon, 'diff'),
      disabled: !state.activeTopicId,
      onSelect: () => {
        state.openInEditor(tab ? { topicId: tab.topicId, tabId: tab.id, title: tab.title, primary: tab.primary } : undefined);
      },
    },
  ];
  if (tab) {
    entries.push(
      { kind: 'separator' },
      {
        id: 'close',
        label: t('term.closeTab'),
        icon: resolveSvg(state.deps.resolveIcon, 'cross'),
        danger: true,
        onSelect: () => {
          state.closeTab(tab.id);
        },
      },
    );
  }
  return entries;
}

function attachInlineRenameInput(state: TerminalSessionState, tab: TerminalTab): void {
  const tabBtn = state.dom.tabs.el.querySelector<HTMLElement>(`[data-tab-id="${escapeAttrValue(tab.id)}"]`);
  const tabItemEl = tabBtn?.closest<HTMLElement>('.fh-tab');
  if (!tabBtn || !tabItemEl) return;

  tabBtn.hidden = true;
  const input = state.doc.createElement('input');
  input.type = 'text';
  input.className = 'wb-term-rename-input';
  input.value = tab.title;
  input.placeholder = state.ctx.i18n.t('term.renamePlaceholder');
  input.setAttribute('aria-label', state.ctx.i18n.t('term.renameTab'));
  input.setAttribute('data-rename-tab-id', tab.id);
  tabItemEl.insertBefore(input, tabBtn);
  focusSafely(input);
  input.select();

  let settled = false;
  const finish = (save: boolean): void => {
    if (settled) return;
    settled = true;
    const nextValue = input.value;
    state.renamingTabId = undefined;
    input.remove();
    tabBtn.hidden = false;
    if (save) {
      state.renameTab(tab.id, nextValue);
    } else {
      state.paint();
    }
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      finish(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function createTerminalPanelComponent(state: TerminalSessionState): PanelComponent {
  const element = state.doc.createElement('div');
  element.className = 'wb-terminal-panel';
  const mountDisposables = new DisposableStore();

  return {
    element,
    init(params: unknown, panelCtx: PanelInitContext): void {
      state.currentPanelApi = panelCtx.api;
      state.panelEl = element;
      element.append(state.dom.bar, state.dom.termHost);
      const paramTopic = extractTopicId(params);
      state.activeTopicId = paramTopic ?? state.ctx.topics.active()?.id ?? state.activeTopicId;
      state.panelVisible = true;
      updateMoveButton(state);
      if (state.boot.terminal && state.activeTopicId) {
        state.showTopic(state.activeTopicId);
      } else {
        state.paint();
      }

      mountDisposables.add(
        panelCtx.api.onDidVisibilityChange((visible) => {
          state.panelVisible = visible;
          if (!state.boot.terminal) return;
          if (visible && state.activeTopicId) {
            state.showTopic(state.activeTopicId);
          } else {
            state.minimizeTopic(state.activeTopicId);
          }
        }),
      );
      mountDisposables.add(
        panelCtx.api.onDidDimensionsChange(() => {
          updateMoveButton(state);
        }),
      );
    },
    update(params: unknown): void {
      const nextTopic = extractTopicId(params) ?? state.ctx.topics.active()?.id ?? '';
      state.syncActiveTopic(nextTopic);
    },
    focus(): void {
      const activeFrame = state.dom.termHost.querySelector<HTMLIFrameElement>('iframe.on');
      focusSafely(activeFrame ?? state.dom.termHost);
    },
    dispose(): void {
      mountDisposables.dispose();
      state.cancelInlineRename();
      state.dom.menu.close(false);
      state.panelVisible = false;
      state.currentPanelApi = undefined;
      state.panelEl = undefined;
      // Minimize rather than drop so background ttyd sessions stay alive when the panel closes.
      state.minimizeTopic(state.activeTopicId);
      if (state.dom.bar.parentNode === element) element.removeChild(state.dom.bar);
      if (state.dom.termHost.parentNode === element) element.removeChild(state.dom.termHost);
    },
  };
}

function registerTerminalCommands(state: TerminalSessionState): void {
  state.ctx.commands.register(
    TERMINAL_TOGGLE_COMMAND,
    (arg?: unknown): boolean => {
      const targetTopic = extractTopicId(arg) ?? state.ctx.topics.active()?.id ?? state.activeTopicId;
      if (!state.boot.terminal || !targetTopic) return false;
      state.activeTopicId = targetTopic;
      if (state.deps.toggleTool) {
        const opened = state.deps.toggleTool(targetTopic);
        if (opened === true) {
          state.panelVisible = true;
          state.showTopic(targetTopic);
          return true;
        }
        if (opened === false) {
          state.panelVisible = false;
          state.minimizeTopic(targetTopic);
          return false;
        }
        return state.openTopics.get(targetTopic) === 'open';
      }
      if (state.openTopics.get(targetTopic) === 'open') {
        state.minimizeView();
        return false;
      }
      state.panelVisible = true;
      state.showTopic(targetTopic);
      return true;
    },
    { title: tr('term.title') },
  );

  state.ctx.commands.register(
    TERMINAL_END_SESSION_COMMAND,
    async (arg?: unknown): Promise<boolean> => {
      const targetTopic = extractTopicId(arg) ?? state.ctx.topics.active()?.id ?? state.activeTopicId;
      if (!state.boot.terminal || !state.boot.terminalEnd || !targetTopic) return false;
      return state.endTopicSession(targetTopic);
    },
    { title: tr('term.endTitle') },
  );

  state.ctx.commands.register(
    TERMINAL_NEW_TAB_COMMAND,
    (arg?: unknown): TerminalTab | undefined => state.createTab(extractTopicId(arg)),
    { title: state.ctx.i18n.t('term.newTab') },
  );

  state.ctx.commands.register(
    TERMINAL_CLOSE_TAB_COMMAND,
    (arg?: unknown): boolean => state.closeTab(typeof arg === 'string' ? arg : undefined),
    { title: state.ctx.i18n.t('term.closeTab') },
  );

  state.ctx.commands.register(
    TERMINAL_RENAME_TAB_COMMAND,
    (tabId?: unknown, nextTitle?: unknown): boolean => {
      const id = typeof tabId === 'string' && tabId.trim() ? tabId.trim() : undefined;
      if (typeof nextTitle === 'string') {
        const target = id ?? state.store.getActiveTab(state.activeTopicId)?.id;
        return target ? state.renameTab(target, nextTitle) : false;
      }
      return state.startInlineRename(id);
    },
    { title: state.ctx.i18n.t('term.renameTab') },
  );

  state.ctx.commands.register(
    TERMINAL_MOVE_TO_SECONDARY_COMMAND,
    (): Promise<boolean> => state.moveToPart('secondary'),
    { title: state.ctx.i18n.t('term.moveToSecondary') },
  );

  state.ctx.commands.register(
    TERMINAL_MOVE_TO_PANEL_COMMAND,
    (): Promise<boolean> => state.moveToPart('panel'),
    { title: state.ctx.i18n.t('term.moveToPanel') },
  );

  state.ctx.commands.register(
    TERMINAL_OPEN_IN_EDITOR_COMMAND,
    (arg?: unknown): boolean => state.openInEditor(arg),
    { title: state.ctx.i18n.t('term.openInEditor') },
  );
}

function bindDomListeners(state: TerminalSessionState): void {
  const { dom, ctx, deps } = state;

  ctx.subscriptions.add(
    addDisposableListener(dom.newTabBtn, 'click', () => {
      state.createTab();
    }),
  );
  ctx.subscriptions.add(
    addDisposableListener(dom.emptyNewBtn, 'click', () => {
      state.createTab();
    }),
  );
  ctx.subscriptions.add(
    addDisposableListener(dom.moveBtn, 'click', () => {
      const targetPart = state.currentPanelApi?.group === 'secondary' ? 'panel' : 'secondary';
      void state.moveToPart(targetPart);
    }),
  );
  ctx.subscriptions.add(
    addDisposableListener(dom.openEditorBtn, 'click', () => {
      state.openInEditor();
    }),
  );
  ctx.subscriptions.add(
    addDisposableListener(dom.moreBtn, 'click', () => {
      const activeTab = state.store.getActiveTab(state.activeTopicId);
      dom.menu.open(dom.moreBtn, buildTabMenuEntries(state, activeTab));
    }),
  );
  ctx.subscriptions.add(
    addDisposableListener(dom.termMinBtn, 'click', () => {
      state.minimizeTopic(state.activeTopicId);
      state.panelVisible = false;
      if (deps.minimizePanel) {
        deps.minimizePanel();
      } else {
        state.currentPanelApi?.close();
      }
    }),
  );
  ctx.subscriptions.add(
    addDisposableListener(dom.termEndBtn, 'click', () => {
      void state.endTopicSession();
    }),
  );
  ctx.subscriptions.add(
    addDisposableListener(dom.tabs.el, 'dblclick', (ev) => {
      const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-tab-id]');
      const tabId = target?.getAttribute('data-tab-id');
      if (!tabId) return;
      ev.preventDefault();
      state.startInlineRename(tabId);
    }),
  );
  ctx.subscriptions.add(
    addDisposableListener(dom.tabs.el, 'contextmenu', (ev) => {
      const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-tab-id]');
      const tabId = target?.getAttribute('data-tab-id');
      if (!tabId) return;
      const tab = state.store.getTab(tabId);
      if (!tab) return;
      ev.preventDefault();
      dom.menu.open({ x: ev.clientX, y: ev.clientY }, buildTabMenuEntries(state, tab));
    }),
  );
}

class TerminalSession implements TerminalSessionState {
  readonly doc: Document;
  readonly win: Window;
  readonly boot: Pick<BootConfig, 'terminal' | 'terminalEnd'>;
  readonly dom: TerminalDomParts;
  readonly store = new TerminalTabStore();
  readonly frames = new Map<string, HTMLIFrameElement>();
  readonly openTopics = new Map<string, 'open' | 'min'>();
  readonly ctx: PluginContext;
  readonly deps: TerminalPluginDeps;
  readonly post: (path: string, body: unknown, tries: number) => Promise<Response>;
  readonly confirm: (message: string) => boolean;
  readonly alert: (message: string) => void;
  activeTopicId: string;
  panelVisible = false;
  currentPanelApi: PanelRef | undefined;
  panelEl: HTMLElement | undefined;
  renamingTabId: string | undefined;

  constructor(ctx: PluginContext, deps: TerminalPluginDeps) {
    this.ctx = ctx;
    this.deps = deps;
    this.doc = deps.doc ?? document;
    this.win = deps.win ?? window;
    this.boot = deps.boot ?? readBootConfig(this.doc);
    this.post = deps.post ?? defaultPost;
    this.confirm = deps.confirmFn ?? ((msg: string) => this.win.confirm(msg));
    this.alert = deps.alertFn ?? ((msg: string) => this.win.alert(msg));
    this.activeTopicId = ctx.topics.active()?.id ?? '';
    this.dom = createTerminalDom(
      this.doc,
      this.win,
      Boolean(this.boot.terminalEnd),
      deps.resolveIcon,
      (key) => this.ctx.i18n.t(key),
      (tabId) => this.selectTab(tabId),
      (tabId) => {
        this.closeTab(tabId);
      },
    );
  }

  getTopicTitle(topicId: string): string | undefined {
    const active = this.ctx.topics.active();
    if (active && active.id === topicId) return active.title;
    return this.ctx.topics.list().find((t) => t.id === topicId)?.title;
  }

  syncActiveTopic(nextTopicId: string): void {
    this.cancelInlineRename();
    this.activeTopicId = nextTopicId;
    if (!this.boot.terminal) return;
    if (this.panelVisible && this.activeTopicId) {
      this.showTopic(this.activeTopicId);
    } else {
      this.paint();
    }
  }

  showTopic(topicId?: string): void {
    const target = topicId ?? this.activeTopicId;
    if (!this.boot.terminal || !target) return;
    this.activeTopicId = target;
    this.openTopics.set(target, 'open');
    const defaultTitle = this.getTopicTitle(target) || tr('common.untitled');
    const tab = this.store.ensureDefaultTab(target, defaultTitle);
    mountTabIframe(this, tab);
    this.paint();
  }

  minimizeTopic(topicId?: string): void {
    const target = topicId ?? this.activeTopicId;
    if (!this.boot.terminal || !target || !this.openTopics.has(target)) return;
    this.openTopics.set(target, 'min');
    this.paint();
  }

  minimizeView(): void {
    this.panelVisible = false;
    this.minimizeTopic(this.activeTopicId);
    if (this.deps.minimizePanel) {
      this.deps.minimizePanel();
    } else {
      this.currentPanelApi?.close();
    }
  }

  createTab(topicId?: string): TerminalTab | undefined {
    const target = topicId ?? this.activeTopicId ?? this.ctx.topics.active()?.id ?? '';
    if (!this.boot.terminal || !target) return undefined;
    this.cancelInlineRename();
    this.activeTopicId = target;
    this.openTopics.set(target, 'open');
    const baseTitle = this.getTopicTitle(target) || tr('common.untitled');
    const tab = this.store.createTab(target, baseTitle);
    mountTabIframe(this, tab);
    this.paint();
    return tab;
  }

  selectTab(tabId: string): void {
    const tab = this.store.getTab(tabId);
    if (!tab) return;
    this.cancelInlineRename();
    this.store.setActiveTab(tab.topicId, tab.id);
    if (tab.topicId === this.activeTopicId) {
      this.openTopics.set(tab.topicId, 'open');
      mountTabIframe(this, tab);
    }
    this.paint();
  }

  closeTab(tabId?: string): boolean {
    const targetId = tabId ?? this.store.getActiveTab(this.activeTopicId)?.id;
    if (!targetId) return false;
    if (this.renamingTabId === targetId) this.cancelInlineRename();
    const result = this.store.closeTab(targetId);
    if (!result) return false;
    dropTabIframe(this, result.closed.id);
    if (!result.nextActive) {
      this.openTopics.delete(result.closed.topicId);
    } else {
      mountTabIframe(this, result.nextActive);
    }
    this.paint();
    return true;
  }

  renameTab(tabId: string, nextTitle: string): boolean {
    const updated = this.store.renameTab(tabId, nextTitle);
    if (!updated) return false;
    const frame = this.frames.get(updated.id);
    if (frame) frame.setAttribute('title', updated.title);
    this.paint();
    return true;
  }

  startInlineRename(tabId?: string): boolean {
    const targetId = tabId ?? this.store.getActiveTab(this.activeTopicId)?.id;
    if (!targetId) return false;
    const tab = this.store.getTab(targetId);
    if (!tab) return false;
    this.renamingTabId = tab.id;
    this.paint();
    attachInlineRenameInput(this, tab);
    return true;
  }

  cancelInlineRename(): void {
    if (!this.renamingTabId) return;
    this.renamingTabId = undefined;
    const existing = this.dom.tabs.el.querySelector<HTMLInputElement>('.wb-term-rename-input');
    existing?.remove();
    this.paint();
  }

  async moveToPart(part: 'secondary' | 'panel'): Promise<boolean> {
    if (!this.boot.terminal) return false;
    const panelId = this.currentPanelApi?.id ?? TERMINAL_PANEL_ID;
    const cmd = part === 'secondary' ? WORKBENCH_MOVE_VIEW_TO_SECONDARY : WORKBENCH_MOVE_VIEW_TO_PANEL;
    try {
      const res = await this.ctx.commands.execute(cmd, panelId);
      updateMoveButton(this);
      return res !== false;
    } catch {
      return false;
    }
  }

  openInEditor(arg?: unknown): boolean {
    if (!this.boot.terminal) return false;
    const input = resolveEditorOpenInput(this, arg);
    if (!input) return false;
    this.ctx.editors.open(TERMINAL_EDITOR_KIND, input, {
      position: { group: MAIN_EDITOR_GROUP, direction: 'right' },
    });
    return true;
  }

  async endTopicSession(topicId?: string): Promise<boolean> {
    const target = topicId ?? this.activeTopicId;
    if (!this.boot.terminal || !this.boot.terminalEnd || !target || !this.openTopics.has(target)) return false;
    const title = this.getTopicTitle(target) || tr('common.untitled');
    if (!this.confirm(tr('term.confirmEnd', { title }))) return false;
    try {
      const res = await this.post('api/terminal/end', { topic: target }, 0);
      if (!res.ok) {
        let error = tr('term.endFailed');
        try {
          const body = (await res.json()) as TermEndErrorBody | null;
          if (body && body.error) error = body.error;
        } catch {
          // Use generic fallback message when response is not JSON.
        }
        this.alert(error);
        return false;
      }
      for (const tab of this.store.dropTopic(target)) {
        dropTabIframe(this, tab.id);
      }
      this.openTopics.delete(target);
      this.paint();
      return true;
    } catch {
      this.alert(tr('term.endReachErr'));
      return false;
    }
  }

  paint(): void {
    paintTerminalState(this);
  }

  pruneTopics(keep: Readonly<Record<string, unknown>>): void {
    for (const tab of this.store.pruneTopics(keep)) {
      dropTabIframe(this, tab.id);
      this.openTopics.delete(tab.topicId);
    }
    this.paint();
  }

  disposeAll(): void {
    this.cancelInlineRename();
    this.dom.menu.dispose();
    this.dom.tabs.dispose();
    for (const tab of this.store.clear()) {
      dropTabIframe(this, tab.id);
    }
    for (const frame of this.frames.values()) {
      frame.remove();
    }
    this.frames.clear();
    this.openTopics.clear();
    this.panelVisible = false;
    this.currentPanelApi = undefined;
    this.panelEl = undefined;
    this.dom.bar.remove();
    this.dom.termHost.remove();
  }
}

export function createTerminalPlugin(deps: TerminalPluginDeps = {}): WebuiPlugin {
  return definePlugin({
    id: TERMINAL_PLUGIN_ID,
    activate(ctx: PluginContext): void {
      ctx.i18n.add('en', TERMINAL_I18N_EN);
      ctx.i18n.add('zh-CN', TERMINAL_I18N_ZH);

      const state = new TerminalSession(ctx, deps);
      bindDomListeners(state);
      ctx.subscriptions.add(toDisposable(() => state.disposeAll()));

      ctx.events.on('topic.active', ({ id }) => {
        state.syncActiveTopic(id ?? '');
      });

      ctx.events.on('topic.list', ({ topics }) => {
        const keep: Record<string, true> = {};
        for (const topic of topics) {
          keep[topic.id] = true;
          state.store.syncTopicTitle(topic.id, topic.title);
        }
        state.pruneTopics(keep);
      });

      ctx.topicTools.register({
        id: TERMINAL_TOOL_ID,
        title: tr('term.title'),
        icon: 'terminal',
        defaultPart: 'panel',
        available: (topic) => Boolean(state.boot.terminal && isValidTopic(topic)),
        component: () => createTerminalPanelComponent(state),
      });

      ctx.editors.register({
        kind: TERMINAL_EDITOR_KIND,
        title: (input) => formatTerminalEditorTitle(input, (topicId) => state.getTopicTitle(topicId)),
        component: () =>
          createTerminalEditorComponent({
            doc: state.doc,
            resolveIcon: deps.resolveIcon,
            getTopicTitle: (topicId) => state.getTopicTitle(topicId),
            t: (key) => ctx.i18n.t(key),
            onRename: (tabId, nextTitle) => {
              state.renameTab(tabId, nextTitle);
            },
          }),
      });

      registerTerminalCommands(state);
    },
  });
}

function resolveEditorOpenInput(state: TerminalSessionState, arg: unknown): TerminalEditorInput | undefined {
  if (typeof arg === 'string' && arg.trim()) {
    const byTab = state.store.getTab(arg.trim());
    if (byTab) {
      return { topicId: byTab.topicId, tabId: byTab.id, title: byTab.title, primary: byTab.primary };
    }
    return { topicId: arg.trim(), title: state.getTopicTitle(arg.trim()) };
  }
  if (arg && typeof arg === 'object') {
    const raw = arg as Partial<TerminalEditorInput>;
    if (typeof raw.topicId === 'string' && raw.topicId.trim()) {
      return {
        topicId: raw.topicId.trim(),
        tabId: raw.tabId,
        title: raw.title ?? state.getTopicTitle(raw.topicId.trim()),
        primary: raw.primary,
      };
    }
  }
  const topicId = state.activeTopicId || state.ctx.topics.active()?.id || '';
  if (!topicId) return undefined;
  const activeTab = state.store.getActiveTab(topicId);
  if (activeTab) {
    return {
      topicId: activeTab.topicId,
      tabId: activeTab.id,
      title: activeTab.title,
      primary: activeTab.primary,
    };
  }
  return { topicId, title: state.getTopicTitle(topicId) ?? tr('term.title'), primary: true };
}

function paintTerminalState(state: TerminalSessionState): void {
  const topic = state.activeTopicId;
  const topicTabs = topic ? state.store.getTabs(topic) : [];
  const activeTab = topic ? state.store.getActiveTab(topic) : undefined;
  const isOpen = Boolean(topic && state.openTopics.get(topic) === 'open' && activeTab);

  const tabItems: TabItem[] = topicTabs.map((tab) => ({
    id: tab.id,
    label: tab.title,
    icon: resolveSvg(state.deps.resolveIcon, 'terminal'),
    title: tab.title,
    closable: true,
  }));
  state.dom.tabs.update({
    items: tabItems,
    activeId: activeTab?.id ?? '',
  });

  const titleText = activeTab?.title ?? (topic ? state.getTopicTitle(topic) : undefined) ?? tr('common.untitled');
  state.dom.termName.textContent = titleText;
  state.dom.termEndBtn.hidden = !state.boot.terminalEnd;
  state.dom.emptyState.hidden = topicTabs.length > 0 || !topic;
  updateMoveButton(state);

  for (const [tabId, frame] of state.frames.entries()) {
    const live = isOpen && activeTab?.id === tabId;
    frame.classList.toggle('on', live);
    frame.toggleAttribute('inert', !live);
  }
}
