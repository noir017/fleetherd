import { Emitter } from '../../base/event.js';
import { type Disposable, DisposableStore, toDisposable } from '../../base/lifecycle.js';
import type { FilesPanel, FilesSource } from '../../panels/files.js';
import { createInstructionsPanel } from '../../panels/instructions.js';
import { definePlugin, type PluginContext, type SettingsSectionContribution, type WebuiPlugin } from '../../plugins/api.js';
import { post as defaultPost, text } from '../../services/api.js';
import { inlineCodeHtml } from './render.js';
import type { SettingsTopicRef, SettingsWebMessage } from './types.js';
import { createSettingsCatalogComponent } from './workbench-catalog.js';
import { createSettingsEditorComponent, resolveSettingsEditorTitle } from './workbench-editor.js';
import { createInstructionEditorComponent, resolveInstructionEditorTitle } from './workbench-instructions.js';
import {
  type GatewayCatalogSection,
  type InstructionEditorInput,
  isSettingsEditorInput,
  type SettingsEditorHandler,
  type SettingsEditorInput,
  type SettingsPluginBridge,
  type SettingsPluginDeps,
  type SettingsRuntime,
} from './workbench-types.js';

export type {
  GatewayCatalogSection,
  InstructionEditorInput,
  SettingsEditorInput,
  SettingsPluginBridge,
  SettingsPluginDeps,
} from './workbench-types.js';

const SETTINGS_EN_STRINGS: Record<string, string> = {
  'wb.settings.gatewayGroup': 'Gateway · config.yaml',
  'wb.settings.deviceGroup': 'This device',
  'wb.settings.searchPlaceholder': 'Search settings',
  'wb.settings.noTopic': 'Select a topic to load gateway settings.',
};

const SETTINGS_ZH_STRINGS: Record<string, string> = {
  'wb.settings.gatewayGroup': '网关 · config.yaml',
  'wb.settings.deviceGroup': '本设备',
  'wb.settings.searchPlaceholder': '搜索设置',
  'wb.settings.noTopic': '请先选择一个话题以加载网关设置。',
};

function deriveGatewaySections(msg: SettingsWebMessage | null): GatewayCatalogSection[] {
  const screen = msg?.settings;
  if (!screen || screen.level !== 'list') return [];
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const row of screen.rows || []) {
    const name = String(row.group ?? '').trim();
    if (!name) continue;
    if (!counts.has(name)) {
      counts.set(name, 0);
      order.push(name);
    }
    if (row.control?.kind === 'agent') {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return order.map((name) => {
    const agentCount = counts.get(name) ?? 0;
    return {
      id: name,
      label: name,
      ...(agentCount > 0 ? { count: agentCount } : {}),
      kind: 'group' as const,
    };
  });
}

function isSettingsWebMessage(value: unknown): value is SettingsWebMessage {
  if (!value || typeof value !== 'object') return false;
  const msg = value as Record<string, unknown>;
  return typeof msg.id === 'string' && ('settings' in msg || 'wasSettings' in msg);
}

function createSettingsRuntime(ctx: PluginContext, deps: SettingsPluginDeps): SettingsRuntime {
  const instrOk = deps.instrOk === true;
  const doc = deps.doc ?? document;
  const postFn = deps.post ?? defaultPost;
  const onDidChangeGateway = new Emitter<void>();
  const onDidChangeSelection = new Emitter<SettingsEditorInput | undefined>();
  const editors = new Set<SettingsEditorHandler>();
  const treePainters = new Map<FilesSource, () => void>();

  let gatewayMsg: SettingsWebMessage | null = null;
  let selection: SettingsEditorInput | undefined;

  const getTopics = (): readonly SettingsTopicRef[] => {
    if (deps.getTopics) return deps.getTopics();
    return ctx.topics.list().map((item) => ({ id: item.id, title: item.title }));
  };

  const getTopic = (): string => {
    if (deps.getTopic) return deps.getTopic();
    return ctx.topics.active()?.id ?? ctx.topics.list()[0]?.id ?? '';
  };

  const setGatewayMessage = (msg: SettingsWebMessage | null): void => {
    gatewayMsg = msg;
    onDidChangeGateway.fire();
  };

  const listDeviceSections = (): readonly SettingsSectionContribution[] =>
    deps.listDeviceSections().filter((s) => s.scope === 'device');

  const handleMessage = (msg: SettingsWebMessage | null | undefined): boolean => {
    let handled = false;
    for (const editor of editors) {
      if (editor.handleMessage(msg)) handled = true;
    }
    if (!handled && msg?.settings) {
      setGatewayMessage(msg);
      return true;
    }
    if (!handled && msg?.wasSettings) return true;
    return handled;
  };

  const refresh = (): void => {
    for (const editor of editors) editor.refresh();
  };

  const createInstructionSource = (input: InstructionEditorInput, onRefresh?: () => void): FilesSource | null => {
    if (!instrOk) return null;
    let captured: FilesSource | null = null;
    const dummyPage = doc.createElement('div');
    const dummyBody = doc.createElement('div');
    const dummyPreview = doc.createElement('div');
    const capturePanel: FilesPanel = {
      open(_topic, _path, src) {
        captured = src ?? null;
      },
      openEditor() {},
      close() {},
      isOpen: () => false,
      isCustomOpen: () => false,
      paintTree() {
        if (captured) treePainters.get(captured)?.();
      },
      currentSource: () => captured,
      previewEl: () => dummyPreview,
      repaint() {},
    };
    const panel = createInstructionsPanel({
      instrOk: true,
      settingsPage: dummyPage,
      settingsBody: dummyBody,
      filesPanel: capturePanel,
      getSettingsMsg: () => gatewayMsg,
      getSettingsTopic: () => getTopic(),
      getTopic,
      renderSettings: () => onRefresh?.(),
      text,
      inl: inlineCodeHtml,
      post: (path, body, tries) => postFn(path, body, tries),
    });
    if (input.orphans) panel.openOrphans();
    else if (input.agent) panel.open(input.agent, input.fileId);
    return captured;
  };

  const bridge: SettingsPluginBridge = {
    handleMessage,
    refresh,
    getMessage: () => gatewayMsg,
  };

  return {
    instrOk,
    bridge,
    onDidChangeGateway: onDidChangeGateway.event,
    onDidChangeDeviceSections: deps.onDidChangeDeviceSections,
    onDidChangeSelection: onDidChangeSelection.event,
    getGatewayMessage: () => gatewayMsg,
    setGatewayMessage,
    getGatewaySections: () => deriveGatewaySections(gatewayMsg),
    listDeviceSections,
    getSelection: () => selection,
    setSelection(input) {
      selection = input;
      onDidChangeSelection.fire(input);
    },
    registerEditor(handler) {
      editors.add(handler);
      return toDisposable(() => {
        editors.delete(handler);
      });
    },
    openSettings(input) {
      ctx.editors.open('settings', input ?? {});
      if (input) {
        for (const editor of editors) editor.focusSection(input);
      }
    },
    openInstruction(input) {
      ctx.editors.open('instruction', input);
    },
    createInstructionSource,
    registerTreePainter(source, paint): Disposable {
      treePainters.set(source, paint);
      return toDisposable(() => {
        if (treePainters.get(source) === paint) treePainters.delete(source);
      });
    },
    notifyTreePaint(source) {
      treePainters.get(source)?.();
    },
    getTopic,
    getTopics,
    dispose() {
      editors.clear();
      treePainters.clear();
      onDidChangeGateway.dispose();
      onDidChangeSelection.dispose();
    },
  };
}

export function createSettingsPlugin(deps: SettingsPluginDeps): WebuiPlugin {
  return definePlugin({
    id: 'settings',
    activate(ctx) {
      ctx.i18n.add('en', SETTINGS_EN_STRINGS);
      ctx.i18n.add('zh-CN', SETTINGS_ZH_STRINGS);

      const runtime = createSettingsRuntime(ctx, deps);
      ctx.subscriptions.add(runtime);

      const localSubs = new DisposableStore();
      ctx.subscriptions.add(localSubs);

      localSubs.add(
        ctx.events.on('topic.message', (ev) => {
          if (isSettingsWebMessage(ev.message)) {
            runtime.bridge.handleMessage(ev.message);
          }
        }),
      );
      if (deps.onSettingsMessage) {
        localSubs.add(deps.onSettingsMessage((msg) => runtime.bridge.handleMessage(msg)));
      }

      ctx.views.register({
        id: 'settings',
        title: ctx.i18n.t('settings.title'),
        icon: 'gear',
        part: 'sidebar',
        component: () => createSettingsCatalogComponent(ctx, runtime, deps),
      });

      ctx.activity.register({
        id: 'settings',
        title: ctx.i18n.t('settings.title'),
        icon: 'gear',
        view: 'settings',
        order: 100,
      });

      ctx.editors.register({
        kind: 'settings',
        title: (input) => resolveSettingsEditorTitle(ctx, runtime, input),
        component: () => createSettingsEditorComponent(ctx, runtime, deps),
      });

      ctx.editors.register({
        kind: 'instruction',
        title: (input) => resolveInstructionEditorTitle(ctx, input),
        component: () => createInstructionEditorComponent(ctx, runtime, deps),
      });

      ctx.commands.register(
        'settings.open',
        (input?: unknown) => {
          const target = isSettingsEditorInput(input) ? input : undefined;
          if (target) runtime.setSelection(target);
          runtime.openSettings(target);
        },
        { title: ctx.i18n.t('settings.title') },
      );

      deps.onReady?.(runtime.bridge);
    },
  });
}
