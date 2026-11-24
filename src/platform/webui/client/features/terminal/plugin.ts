import { icon, type IconName } from '../../../icons.js';
import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { DisposableStore, toDisposable } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import {
  definePlugin,
  type PluginContext,
  type TopicInfo,
  type TopicToolContribution,
  type WebuiPlugin,
} from '../../plugins/api.js';
import { type BootConfig, readBootConfig } from '../../services/boot.js';
import type { StorageService } from '../../services/storage.js';
import { createTerminalController, type TerminalController } from './index.js';

type PanelComponent = ReturnType<TopicToolContribution['component']>;
type PanelInitContext = Parameters<PanelComponent['init']>[1];
type PanelRef = PanelInitContext['api'];

export const TERMINAL_PLUGIN_ID = 'terminal';
export const TERMINAL_TOOL_ID = 'terminal';
export const TERMINAL_TOGGLE_COMMAND = 'terminal.toggle';
export const TERMINAL_END_SESSION_COMMAND = 'terminal.endSession';

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
  readonly termName: HTMLSpanElement;
  readonly termMinBtn: HTMLButtonElement;
  readonly termEndBtn: HTMLButtonElement;
  readonly termHost: HTMLDivElement;
  readonly chatShim: HTMLDivElement;
  readonly chatHeadShim: HTMLDivElement;
  readonly composerShim: HTMLDivElement;
  readonly termBtnShim: HTMLButtonElement;
  readonly termElShim: HTMLDivElement;
  readonly termGripShim: HTMLDivElement;
}

function createTerminalDom(
  doc: Document,
  canEnd: boolean,
  resolveIcon: ((name: IconName) => string) | undefined,
): TerminalDomParts {
  const bar = doc.createElement('div');
  bar.className = 'wb-term-bar';

  const termName = doc.createElement('span');
  termName.className = 'term-name';
  termName.textContent = tr('common.untitled');

  const termMinBtn = doc.createElement('button');
  termMinBtn.type = 'button';
  termMinBtn.className = 'wb-icon-btn wb-term-min';
  termMinBtn.title = tr('term.minTitle');
  termMinBtn.setAttribute('aria-label', tr('term.minBtnTitle'));
  termMinBtn.innerHTML = resolveSvg(resolveIcon, 'chevronDown');

  const termEndBtn = doc.createElement('button');
  termEndBtn.type = 'button';
  termEndBtn.className = 'wb-icon-btn wb-term-end';
  termEndBtn.title = tr('term.endTitle');
  termEndBtn.setAttribute('aria-label', tr('term.endTitle'));
  termEndBtn.hidden = !canEnd;
  termEndBtn.innerHTML = resolveSvg(resolveIcon, 'cross');

  bar.append(termName, termMinBtn, termEndBtn);

  const termHost = doc.createElement('div');
  termHost.className = 'wb-term-frames';

  return {
    bar,
    termName,
    termMinBtn,
    termEndBtn,
    termHost,
    chatShim: doc.createElement('div'),
    chatHeadShim: doc.createElement('div'),
    composerShim: doc.createElement('div'),
    termBtnShim: doc.createElement('button'),
    termElShim: doc.createElement('div'),
    termGripShim: doc.createElement('div'),
  };
}

interface TerminalSessionState {
  readonly doc: Document;
  readonly boot: Pick<BootConfig, 'terminal' | 'terminalEnd'>;
  readonly dom: TerminalDomParts;
  readonly ctrl: TerminalController;
  readonly ctx: PluginContext;
  readonly deps: TerminalPluginDeps;
  activeTopicId: string;
  panelVisible: boolean;
  currentPanelApi: PanelRef | undefined;
  syncActiveTopic(nextTopicId: string): void;
  minimizeView(): void;
}

function createTerminalPanelComponent(state: TerminalSessionState): PanelComponent {
  const element = state.doc.createElement('div');
  element.className = 'wb-terminal-panel';
  const mountDisposables = new DisposableStore();

  return {
    element,
    init(params: unknown, panelCtx: PanelInitContext): void {
      state.currentPanelApi = panelCtx.api;
      element.append(state.dom.bar, state.dom.termHost);
      const paramTopic = extractTopicId(params);
      state.activeTopicId = paramTopic ?? state.ctx.topics.active()?.id ?? state.activeTopicId;
      state.panelVisible = true;
      if (state.boot.terminal && state.activeTopicId) {
        state.ctrl.show();
      } else {
        state.ctrl.apply();
      }

      mountDisposables.add(
        panelCtx.api.onDidVisibilityChange((visible) => {
          state.panelVisible = visible;
          if (!state.boot.terminal) return;
          if (visible && state.activeTopicId) {
            state.ctrl.show();
          } else {
            state.ctrl.minimize();
          }
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
      state.panelVisible = false;
      state.currentPanelApi = undefined;
      // Minimize rather than drop so background ttyd sessions stay alive when the panel closes.
      state.ctrl.minimize();
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
          state.ctrl.show();
          return true;
        }
        if (opened === false) {
          state.panelVisible = false;
          state.ctrl.minimize();
          return false;
        }
        return state.ctrl.isOpen(targetTopic);
      }
      if (state.ctrl.isOpen(targetTopic)) {
        state.minimizeView();
        return false;
      }
      state.panelVisible = true;
      state.ctrl.show();
      return true;
    },
    { title: tr('term.title') },
  );

  state.ctx.commands.register(
    TERMINAL_END_SESSION_COMMAND,
    async (arg?: unknown): Promise<boolean> => {
      const targetTopic = extractTopicId(arg) ?? state.ctx.topics.active()?.id ?? state.activeTopicId;
      if (!state.boot.terminal || !state.boot.terminalEnd || !targetTopic) return false;
      const prevTopic = state.activeTopicId;
      state.activeTopicId = targetTopic;
      try {
        await state.ctrl.end();
        return state.ctrl.getState(targetTopic) === undefined;
      } finally {
        state.activeTopicId = prevTopic;
        if (prevTopic && prevTopic !== targetTopic) {
          state.ctrl.paintFrames();
        }
      }
    },
    { title: tr('term.endTitle') },
  );
}

export function createTerminalPlugin(deps: TerminalPluginDeps = {}): WebuiPlugin {
  return definePlugin({
    id: TERMINAL_PLUGIN_ID,
    activate(ctx: PluginContext): void {
      const doc = deps.doc ?? document;
      const boot = deps.boot ?? readBootConfig(doc);
      const dom = createTerminalDom(doc, Boolean(boot.terminalEnd), deps.resolveIcon);

      const getTopicTitle = (topicId: string): string | undefined => {
        const active = ctx.topics.active();
        if (active && active.id === topicId) return active.title;
        return ctx.topics.list().find((t) => t.id === topicId)?.title;
      };

      const state: TerminalSessionState = {
        doc,
        boot,
        dom,
        ctrl: undefined as unknown as TerminalController,
        ctx,
        deps,
        activeTopicId: ctx.topics.active()?.id ?? '',
        panelVisible: false,
        currentPanelApi: undefined,
        syncActiveTopic(nextTopicId: string): void {
          state.activeTopicId = nextTopicId;
          if (!boot.terminal) return;
          if (state.panelVisible && state.activeTopicId) {
            state.ctrl.show();
          } else {
            state.ctrl.apply();
          }
        },
        minimizeView(): void {
          state.panelVisible = false;
          state.ctrl.minimize();
          if (deps.minimizePanel) {
            deps.minimizePanel();
          } else {
            state.currentPanelApi?.close();
          }
        },
      };

      (state as { ctrl: TerminalController }).ctrl = createTerminalController({
        enabled: Boolean(boot.terminal),
        canEnd: Boolean(boot.terminalEnd),
        chat: dom.chatShim,
        chatHead: dom.chatHeadShim,
        composer: dom.composerShim,
        termBtn: dom.termBtnShim,
        termHost: dom.termHost,
        termEl: dom.termElShim,
        termGrip: dom.termGripShim,
        termName: dom.termName,
        termMinBtn: dom.termMinBtn,
        termEndBtn: dom.termEndBtn,
        getTopic: () => state.activeTopicId,
        getTopicTitle,
        isOverlayCovering: () => false,
        atBottom: () => false,
        toBottom: () => undefined,
        post: deps.post,
        storage: deps.storage,
        win: deps.win,
        doc,
        confirmFn: deps.confirmFn,
        alertFn: deps.alertFn,
      });

      ctx.subscriptions.add(state.ctrl);
      ctx.subscriptions.add(
        addDisposableListener(dom.termMinBtn, 'click', () => {
          state.panelVisible = false;
          if (deps.minimizePanel) {
            deps.minimizePanel();
          } else {
            state.currentPanelApi?.close();
          }
        }),
      );

      ctx.subscriptions.add(
        toDisposable(() => {
          state.panelVisible = false;
          state.currentPanelApi = undefined;
          state.ctrl.pruneFrames({});
          dom.bar.remove();
          dom.termHost.remove();
        }),
      );

      ctx.events.on('topic.active', ({ id }) => {
        state.syncActiveTopic(id ?? '');
      });

      ctx.events.on('topic.list', ({ topics }) => {
        const keep: Record<string, true> = {};
        for (const topic of topics) {
          keep[topic.id] = true;
        }
        state.ctrl.pruneFrames(keep);
        state.ctrl.paintFrames();
      });

      ctx.topicTools.register({
        id: TERMINAL_TOOL_ID,
        title: tr('term.title'),
        icon: 'terminal',
        defaultPart: 'panel',
        available: (topic) => Boolean(boot.terminal && isValidTopic(topic)),
        component: () => createTerminalPanelComponent(state),
      });

      registerTerminalCommands(state);
    },
  });
}
