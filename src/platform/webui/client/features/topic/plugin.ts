import { toDisposable } from '../../base/lifecycle.js';
import { openConfirmDialog } from '../../components/dialog/index.js';
import { t as tr } from '../../i18n/index.js';
import { definePlugin, type PluginContext, type TopicInfo, type WebuiPlugin } from '../../plugins/api.js';
import type { ContributionRegistry } from '../../plugins/registry.js';
import type { OverlayManager } from '../../services/overlays.js';
import { copyText as copyTextToClipboard } from './composer/clipboard.js';
import {
  createTopicEditorPanel,
  parseTopicEditorInput,
  type MessageMenuTarget,
  type TopicEditorControllerFactories,
  type TopicEditorDeps,
  type TopicEditorHandle,
  type TopicEditorIcons,
  type TopicEditorMenuEntry,
  type TopicEditorQuickPickAdapter,
  type TopicEditorToolDescriptor,
  type TopicStreamState,
} from './editor/index.js';
import {
  DIFF_EDITOR_KIND,
  formatQuoteReply,
  openTurnDiffSideBySide,
  polishLabel,
  TOPIC_POLISH_EN,
  TOPIC_POLISH_ZH,
  type TurnChangesStatusResponse,
} from './transcript/index.js';

export const TOPIC_PLUGIN_ID = 'topic';
export const TOPIC_EDITOR_KIND = 'topic';

export const TOPIC_COMMANDS = {
  focusComposer: 'topic.focusComposer',
  stopTurn: 'topic.stopTurn',
  killAgent: 'topic.killAgent',
  copyRef: 'topic.copyRef',
  openTurnDiff: 'topic.openTurnDiff',
} as const;

export interface TopicPluginDeps {
  readonly registry?: ContributionRegistry;
  readonly overlays?: OverlayManager;
  readonly instanceId?: string;
  readonly icons?: Partial<TopicEditorIcons>;
  readonly resolveIcon?: (name: string) => string;
  readonly getStreamState?: () => TopicStreamState;
  readonly getTopicTools?: (topic: TopicInfo) => readonly TopicEditorToolDescriptor[];
  readonly isToolActive?: (toolId: string, topicId: string) => boolean;
  readonly getToolBadge?: (toolId: string, topicId: string) => number | string | null;
  readonly onToggleTopicTool?: (toolId: string, topicId: string) => void;
  readonly getTitleMenuGroups?: (topic: TopicInfo) => readonly (readonly TopicEditorMenuEntry[])[];
  readonly getMessageMenuGroups?: (target: MessageMenuTarget) => readonly (readonly TopicEditorMenuEntry[])[];
  readonly onCopyRef?: (topicId: string) => void;
  readonly onForkTopic?: (topicId: string) => void;
  readonly onKillAgent?: (topicId: string) => void;
  readonly onStopTurn?: (topicId: string) => void;
  readonly onCloseIdle?: () => void;
  readonly onDeleteTopic?: (topicId: string) => void;
  readonly onOpenTurnDiff?: (topicId: string, turn: number, panelId?: string) => Promise<number | void> | number | void;
  readonly hasIdleAgents?: () => boolean;
  readonly copyText?: (text: string) => void;
  readonly onBack?: () => void;
  readonly onToggleSidebar?: () => void;
  readonly onTopicChange?: (nextTopicId: string, prevTopicId: string) => void;
  readonly onEditorCreated?: (handle: TopicEditorHandle) => void;
  readonly onEditorFocused?: (handle: TopicEditorHandle) => void;
  readonly onEditorDisposed?: (handle: TopicEditorHandle) => void;
  readonly onRegisterInsertHandler?: (handler: (topicId: string, text: string) => boolean) => void;
  readonly controllers?: TopicEditorControllerFactories;
  readonly transcriptDeps?: TopicEditorDeps['transcriptDeps'];
  readonly statusDeps?: TopicEditorDeps['statusDeps'];
  readonly composerDeps?: TopicEditorDeps['composerDeps'];
  readonly quickPick?: TopicEditorQuickPickAdapter;
  readonly doc?: Document;
  readonly win?: Window;
  readonly storage?: Storage;
}

function asTopicInfo(target: unknown): TopicInfo | undefined {
  if (!target || typeof target !== 'object' || !('id' in target)) return undefined;
  const candidate = target as Partial<TopicInfo>;
  return typeof candidate.id === 'string' && candidate.id ? (candidate as TopicInfo) : undefined;
}

function asMessageTarget(target: unknown): MessageMenuTarget | undefined {
  if (!target || typeof target !== 'object') return undefined;
  const candidate = target as Partial<MessageMenuTarget>;
  return typeof candidate.text === 'string' && typeof candidate.topicId === 'string'
    ? (candidate as MessageMenuTarget)
    : undefined;
}

function resolveTopicById(ctx: PluginContext, id: string): TopicInfo | undefined {
  if (!id) return undefined;
  const active = ctx.topics.active();
  if (active && active.id === id) return active;
  return ctx.topics.list().find((t) => t.id === id);
}

function hasAnyIdleTopic(ctx: PluginContext, deps: TopicPluginDeps): boolean {
  if (deps.hasIdleAgents) return deps.hasIdleAgents();
  return ctx.topics.list().some((t) => Boolean(t.live && !t.running && !t.asking));
}

function registerTopicMenus(ctx: PluginContext, deps: TopicPluginDeps, instanceId: string): void {
  ctx.menus.register('topic.title', {
    id: 'topic.title.copyRef',
    label: tr('topic.copyRef'),
    icon: 'copy',
    group: '1_info',
    order: 10,
    when: (target) => Boolean(asTopicInfo(target)),
    run: (target) => {
      const topic = asTopicInfo(target);
      if (!topic) return;
      void ctx.commands.execute(TOPIC_COMMANDS.copyRef, topic.id);
    },
  });

  ctx.menus.register('topic.title', {
    id: 'topic.title.fork',
    label: tr('topic.fork'),
    icon: 'fork',
    title: tr('topic.forkTitle'),
    group: '2_actions',
    order: 10,
    when: (target) => {
      const topic = asTopicInfo(target);
      return Boolean(topic && topic.agent?.canFork !== false);
    },
    disabled: (target) => {
      const topic = asTopicInfo(target);
      return topic && (topic.running || topic.asking) ? tr('topic.forkBusyTitle') : false;
    },
    run: (target) => {
      const topic = asTopicInfo(target);
      if (topic) deps.onForkTopic?.(topic.id);
    },
  });

  ctx.menus.register('topic.title', {
    id: 'topic.title.endAgent',
    label: tr('topic.endAgent'),
    icon: 'power',
    title: tr('topic.endAgentTitle'),
    group: '2_actions',
    order: 20,
    when: (target) => Boolean(asTopicInfo(target)),
    disabled: (target) => {
      const topic = asTopicInfo(target);
      return topic && !topic.live ? tr('topic.endAgentNoneTitle') : false;
    },
    run: (target) => {
      const topic = asTopicInfo(target);
      if (topic) void ctx.commands.execute(TOPIC_COMMANDS.killAgent, topic.id);
    },
  });

  ctx.menus.register('topic.title', {
    id: 'topic.title.closeIdle',
    label: tr('menu.closeIdle'),
    icon: 'pause',
    title: tr('menu.closeIdleTitle'),
    group: '2_actions',
    order: 30,
    when: () => hasAnyIdleTopic(ctx, deps),
    run: () => {
      deps.onCloseIdle?.();
    },
  });

  ctx.menus.register('topic.title', {
    id: 'topic.title.delete',
    label: tr('topic.deleteTopic'),
    icon: 'trash',
    group: '9_danger',
    order: 10,
    danger: true,
    when: (target) => Boolean(asTopicInfo(target)),
    run: (target) => {
      const topic = asTopicInfo(target);
      if (!topic) return;
      const title = topic.title || tr('common.untitled');
      void openConfirmDialog({
        title: tr(topic.starred ? 'topics.confirmDeleteStarredTitle' : 'topics.confirmDeleteTitle', { title }),
        body: tr('topics.confirmDeleteBody'),
        confirmLabel: tr('common.delete'),
        danger: true,
        doc: deps.doc,
        overlays: deps.overlays,
      }).then((ok) => {
        if (ok) deps.onDeleteTopic?.(topic.id);
      });
    },
  });

  ctx.menus.register('message', {
    id: 'topic.message.copy',
    label: tr('common.copy'),
    icon: 'copy',
    group: '1_clipboard',
    order: 10,
    when: (target) => Boolean(asMessageTarget(target)?.text),
    run: (target) => {
      const msg = asMessageTarget(target);
      if (!msg?.text) return;
      if (deps.copyText) {
        deps.copyText(msg.text);
      } else {
        copyTextToClipboard(msg.text, () => {}, typeof navigator !== 'undefined' ? navigator : undefined, deps.doc);
      }
    },
  });

  ctx.menus.register('message', {
    id: 'topic.message.quote',
    label: polishLabel('msg.quoteReply'),
    icon: 'undo',
    group: '1_clipboard',
    order: 20,
    when: (target) => Boolean(asMessageTarget(target)?.text),
    run: (target) => {
      const msg = asMessageTarget(target);
      if (!msg?.text) return;
      const quoted = formatQuoteReply(msg.text);
      if (quoted) ctx.topics.insertIntoComposer(msg.topicId, quoted);
    },
  });

  void instanceId;
}

function registerTopicCommands(
  ctx: PluginContext,
  deps: TopicPluginDeps,
  instanceId: string,
  findEditor: (topicId?: string) => TopicEditorHandle | undefined,
  openTurnDiff: (topicId: string, turn: number, panelId?: string) => Promise<number>,
): void {
  ctx.commands.register(
    TOPIC_COMMANDS.focusComposer,
    (topicId?: unknown) => {
      const id = typeof topicId === 'string' ? topicId : ctx.topics.active()?.id;
      const editor = findEditor(id);
      editor?.focus?.();
      return Boolean(editor);
    },
    { title: tr('composer.placeholder') },
  );

  ctx.commands.register(
    TOPIC_COMMANDS.stopTurn,
    (topicId?: unknown) => {
      const id = typeof topicId === 'string' ? topicId : ctx.topics.active()?.id;
      if (!id) return false;
      if (deps.onStopTurn) {
        deps.onStopTurn(id);
        return true;
      }
      const editor = findEditor(id);
      if (editor?.composer) {
        editor.composer.command('/stop');
        return true;
      }
      return false;
    },
    { title: tr('composer.stop') },
  );

  ctx.commands.register(
    TOPIC_COMMANDS.killAgent,
    (topicId?: unknown) => {
      const id = typeof topicId === 'string' ? topicId : ctx.topics.active()?.id;
      if (!id) return false;
      if (deps.onKillAgent) {
        deps.onKillAgent(id);
        return true;
      }
      const editor = findEditor(id);
      if (editor?.composer) {
        editor.composer.command('/kill');
        return true;
      }
      return false;
    },
    { title: tr('topic.endAgent') },
  );

  ctx.commands.register(
    TOPIC_COMMANDS.copyRef,
    (topicId?: unknown) => {
      const id = typeof topicId === 'string' ? topicId : ctx.topics.active()?.id;
      if (!id) return false;
      if (deps.onCopyRef) {
        deps.onCopyRef(id);
        return true;
      }
      const editor = findEditor(id);
      if (editor?.composer) {
        editor.composer.copyTopicRef(id);
        return true;
      }
      const topic = resolveTopicById(ctx, id);
      const ref = `${instanceId}:main/${id}`;
      const line = topic?.title ? `${topic.title} (${ref})` : ref;
      if (deps.copyText) {
        deps.copyText(line);
      } else {
        copyTextToClipboard(line, () => {}, typeof navigator !== 'undefined' ? navigator : undefined, deps.doc);
      }
      return true;
    },
    { title: tr('topic.copyRef') },
  );

  ctx.commands.register(
    TOPIC_COMMANDS.openTurnDiff,
    async (arg?: unknown, maybeTopicId?: unknown) => {
      let topicId = ctx.topics.active()?.id ?? '';
      let turn = 0;
      let panelId: string | undefined;
      if (typeof arg === 'number') {
        turn = arg;
        if (typeof maybeTopicId === 'string' && maybeTopicId) topicId = maybeTopicId;
      } else if (arg && typeof arg === 'object') {
        const rec = arg as { readonly topicId?: unknown; readonly turn?: unknown; readonly panelId?: unknown };
        if (typeof rec.topicId === 'string' && rec.topicId) topicId = rec.topicId;
        if (typeof rec.turn === 'number') turn = rec.turn;
        if (typeof rec.panelId === 'string' && rec.panelId) panelId = rec.panelId;
      }
      if (!topicId || !turn) return 0;
      const editor = findEditor(topicId);
      return openTurnDiff(topicId, turn, panelId ?? editor?.getPanelId());
    },
    { title: polishLabel('msg.openDiffSideBySide') },
  );
}

function registerTopicEditor(
  ctx: PluginContext,
  deps: TopicPluginDeps,
  state: {
    readonly mountedEditors: Set<TopicEditorHandle>;
    getStreamState: () => TopicStreamState;
    setLastFocused: (handle: TopicEditorHandle | null) => void;
    getLastFocused: () => TopicEditorHandle | null;
    readonly openTurnDiff: (topicId: string, turn: number, panelId?: string) => Promise<number>;
  },
): void {
  const resolveTools = (topic: TopicInfo): readonly TopicEditorToolDescriptor[] => {
    if (deps.getTopicTools) return deps.getTopicTools(topic);
    if (!deps.registry) return [];
    return deps.registry.listAvailableTopicTools(topic).map((tool) => ({
      id: tool.id,
      title: tool.title,
      icon: tool.icon,
      active: deps.isToolActive?.(tool.id, topic.id) ?? false,
      badge: deps.getToolBadge?.(tool.id, topic.id) ?? null,
    }));
  };
  const resolveTitleMenus = (topic: TopicInfo): readonly (readonly TopicEditorMenuEntry[])[] =>
    deps.getTitleMenuGroups ? deps.getTitleMenuGroups(topic) : deps.registry ? deps.registry.listMenuGroups('topic.title', topic) : [];
  const resolveMessageMenus = (target: MessageMenuTarget): readonly (readonly TopicEditorMenuEntry[])[] =>
    deps.getMessageMenuGroups ? deps.getMessageMenuGroups(target) : deps.registry ? deps.registry.listMenuGroups('message', target) : [];
  const canOpenSideDiff = (): boolean =>
    Boolean(deps.onOpenTurnDiff || deps.registry?.getEditor(DIFF_EDITOR_KIND));

  ctx.editors.register({
    kind: TOPIC_EDITOR_KIND,
    title: (input) => {
      const id = parseTopicEditorInput(input);
      const topic = resolveTopicById(ctx, id);
      return topic?.title || id || tr('common.untitled');
    },
    component: () =>
      createTopicEditorPanel({
        getTopicInfo: (id) => resolveTopicById(ctx, id),
        getStreamState: state.getStreamState,
        getTopicTools: resolveTools,
        onToggleTopicTool: deps.onToggleTopicTool,
        getTitleMenuGroups: resolveTitleMenus,
        getMessageMenuGroups: resolveMessageMenus,
        onOpenTurnDiffSideBySide: async (topicId, turn, panelId) => {
          await state.openTurnDiff(topicId, turn, panelId);
        },
        canOpenSideDiff,
        onBack: deps.onBack,
        onToggleSidebar: deps.onToggleSidebar,
        onTopicChange: deps.onTopicChange,
        onMount: (handle) => {
          state.mountedEditors.add(handle);
          state.setLastFocused(handle);
          deps.onEditorCreated?.(handle);
        },
        onFocus: (handle) => {
          if (state.mountedEditors.has(handle)) {
            state.setLastFocused(handle);
            deps.onEditorFocused?.(handle);
          }
        },
        onDispose: (handle) => {
          state.mountedEditors.delete(handle);
          if (state.getLastFocused() === handle) state.setLastFocused(null);
          deps.onEditorDisposed?.(handle);
        },
        resolveIcon: deps.resolveIcon,
        icons: deps.icons,
        overlays: deps.overlays,
        controllers: deps.controllers,
        transcriptDeps: deps.transcriptDeps,
        statusDeps: deps.statusDeps,
        composerDeps: deps.composerDeps,
        quickPick: deps.quickPick,
        doc: deps.doc,
        win: deps.win,
        storage: deps.storage,
      }),
  });
}

export function createTopicPlugin(deps: TopicPluginDeps = {}): WebuiPlugin {
  return definePlugin({
    id: TOPIC_PLUGIN_ID,
    activate(ctx: PluginContext): void {
      ctx.i18n.add('en', TOPIC_POLISH_EN);
      ctx.i18n.add('zh-CN', TOPIC_POLISH_ZH);
      const instanceId = deps.instanceId ?? 'web';
      const mountedEditors = new Set<TopicEditorHandle>();
      let lastFocusedEditor: TopicEditorHandle | null = null;
      let streamState: TopicStreamState = deps.getStreamState?.() ?? 'open';

      const findEditor = (topicId?: string): TopicEditorHandle | undefined => {
        if (topicId) {
          for (const ed of mountedEditors) {
            if (ed.getTopicId() === topicId) return ed;
          }
        }
        if (lastFocusedEditor && mountedEditors.has(lastFocusedEditor)) return lastFocusedEditor;
        for (const ed of mountedEditors) return ed;
        return undefined;
      };

      const openTurnDiff = async (topicId: string, turn: number, panelId?: string): Promise<number> => {
        if (deps.onOpenTurnDiff) {
          const res = await deps.onOpenTurnDiff(topicId, turn, panelId);
          return typeof res === 'number' ? res : 1;
        }
        return openTurnDiffSideBySide({
          topicId,
          turn,
          panelId,
          fetchStatus: (url) => ctx.api.get<TurnChangesStatusResponse>(url),
          openDiffEditor: (input, opts) => ctx.editors.open(DIFF_EDITOR_KIND, input, opts),
          fallbackCommand: (input, opts) => ctx.commands.execute('changes.openDiff', input, opts),
        });
      };

      registerTopicEditor(ctx, deps, {
        mountedEditors,
        getStreamState: () => streamState,
        setLastFocused: (h) => {
          lastFocusedEditor = h;
        },
        getLastFocused: () => lastFocusedEditor,
        openTurnDiff,
      });

      registerTopicMenus(ctx, deps, instanceId);
      registerTopicCommands(ctx, deps, instanceId, findEditor, openTurnDiff);

      if (deps.onRegisterInsertHandler) {
        deps.onRegisterInsertHandler((topicId: string, text: string) => {
          const editor = findEditor(topicId);
          if (!editor) return false;
          editor.insertIntoComposer(text);
          return true;
        });
      }

      const refreshAll = (): void => {
        for (const editor of mountedEditors) {
          editor.refreshHeader();
        }
      };

      ctx.events.on('topic.list', () => refreshAll());
      ctx.events.on('topic.active', () => refreshAll());
      ctx.events.on('locale.change', () => refreshAll());
      ctx.events.on('stream.state', ({ state }) => {
        streamState = state;
        for (const editor of mountedEditors) {
          editor.setStreamState(state);
        }
      });

      if (deps.registry) {
        ctx.subscriptions.add(deps.registry.onDidChangeTopicTools(() => refreshAll()));
        ctx.subscriptions.add(deps.registry.onDidChangeMenus((where) => {
          if (where === 'topic.title') refreshAll();
        }));
      }

      ctx.subscriptions.add(
        toDisposable(() => {
          mountedEditors.clear();
          lastFocusedEditor = null;
        }),
      );
    },
  });
}
