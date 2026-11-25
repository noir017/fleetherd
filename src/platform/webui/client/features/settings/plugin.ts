import { Emitter } from '../../base/event.js';
import { type Disposable, DisposableStore, toDisposable } from '../../base/lifecycle.js';
import { buildInstructionSource, type FilesSource } from './instructions-source.js';
import { definePlugin, type PluginContext, type SettingsSectionContribution, type WebuiPlugin } from '../../plugins/api.js';
import { post as defaultPost, text } from '../../services/api.js';
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
  'wb.settings.clearSearch': 'Clear search',
  'wb.settings.matchCount': '{matched} / {total} matches',
  'wb.settings.noMatch': 'No settings match your filter.',
  'wb.settings.modified': 'Modified',
  'wb.settings.modifiedFilter': 'Modified ({count})',
  'wb.settings.reset': 'Reset',
  'wb.settings.initialValue': 'Initial: {value}',
  'wb.settings.gatewayTitle': 'Gateway settings',
  'wb.settings.gatewaySubtitle': 'Saved to config.yaml · applies to all topics',
  'wb.settings.deviceSubtitle': 'Stored in this browser only',
  'wb.settings.instrLabel': 'Instruction files',
  'wb.settings.instrHeaderHint': 'Read by agents on every platform and host',
  'wb.settings.instrSubtitle': 'Changes take effect immediately for all sessions. Version is verified before saving; refused if any agent exceeds its delivery cap.',
  'wb.settings.instrDiscard': 'Discard',
  'wb.settings.instrUnsaved': 'Unsaved changes · version {version}',
  'wb.settings.instrVersion': 'Version {version}',
  'wb.settings.mobileGatewayFooter': 'Changes save to config.yaml for all topics. Notifications, appearance, and language are in More.',
};

const SETTINGS_ZH_STRINGS: Record<string, string> = {
  'wb.settings.gatewayGroup': '网关 · config.yaml',
  'wb.settings.deviceGroup': '本设备',
  'wb.settings.searchPlaceholder': '搜索设置',
  'wb.settings.noTopic': '请先选择一个话题以加载网关设置。',
  'wb.settings.clearSearch': '清除搜索',
  'wb.settings.matchCount': '匹配 {matched} / {total} 项',
  'wb.settings.noMatch': '没有匹配的设置项。',
  'wb.settings.modified': '已修改',
  'wb.settings.modifiedFilter': '已修改 ({count})',
  'wb.settings.reset': '重置',
  'wb.settings.initialValue': '初始值：{value}',
  'wb.settings.gatewayTitle': '网关设置',
  'wb.settings.gatewaySubtitle': '保存到 config.yaml · 对所有话题生效',
  'wb.settings.deviceSubtitle': '只存在这个浏览器里',
  'wb.settings.instrLabel': '指令文件',
  'wb.settings.instrHeaderHint': '所有平台、所有主机上的智能体都读',
  'wb.settings.instrSubtitle': '改动对没人看着的会话也立刻生效。保存前核对版本；放到每台机器前先算一遍，有智能体会超过下发上限就拒绝。',
  'wb.settings.instrDiscard': '撤销',
  'wb.settings.instrUnsaved': '有未保存的改动 · 版本 {version}',
  'wb.settings.instrVersion': '版本 {version}',
  'wb.settings.mobileGatewayFooter': '改动保存到 config.yaml，对所有话题生效。通知、外观、语言在「更多」里。',
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
    if (!input.all && !input.orphans && !input.agent) return null;
    const title = input.title
      ?? (input.orphans
        ? ctx.i18n.t('instr.orphansTitle')
        : input.all
          ? ctx.i18n.t('wb.settings.instrLabel')
          : ctx.i18n.t('instr.agentTitle', { agent: input.agent ?? '' }));
    return buildInstructionSource({
      agent: input.orphans || input.all ? '' : (input.agent ?? ''),
      orphans: input.orphans,
      all: input.all,
      title,
      text,
      post: (path, body, tries) => postFn(path, body, tries),
      onPaintTree: (src) => treePainters.get(src)?.(),
      onClose: onRefresh,
    });
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
