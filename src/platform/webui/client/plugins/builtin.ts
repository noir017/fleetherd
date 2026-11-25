import { combineDisposables, type Disposable } from '../base/lifecycle.js';
import type { ChangesPluginDeps } from '../features/changes/types.js';
import type { FilesPluginDeps } from '../features/files/types.js';
import type { HistoryPluginDeps } from '../features/history/helpers.js';
import type { PalettePluginDeps } from '../features/palette/types.js';
import type { ReaderPluginDeps } from '../features/reader/plugin.js';
import type { ReviewsPluginDeps } from '../features/reviews/types.js';
import type { SchedulesPluginDeps } from '../features/schedules/types.js';
import type { SettingsPluginDeps } from '../features/settings/workbench-types.js';
import type { SkillsPluginDeps } from '../features/skills/types.js';
import { createStatusPlugin, type StatusPluginDeps } from '../features/status/index.js';
import { createTerminalPlugin, type TerminalPluginDeps } from '../features/terminal/plugin.js';
import { createTopicPlugin, type TopicPluginDeps } from '../features/topic/plugin.js';
import { createTopicsPlugin, type TopicsPluginDeps } from '../features/topics/plugin.js';
import { definePlugin, type WebuiPlugin } from './api.js';
import type { PluginManager } from './host.js';
import {
  createExtrasLoader,
  createLazyChangesPlugin,
  createLazyFilesPlugin,
  createLazyHistoryPlugin,
  createLazyPalettePlugin,
  createLazyReaderPlugin,
  createLazyReviewsPlugin,
  createLazySchedulesPlugin,
  createLazySettingsPlugin,
  createLazySkillsPlugin,
  type ExtrasLoader,
} from './lazy-extras.js';

export const BUILTIN_PLUGIN_IDS = [
  'topics',
  'topic',
  'history',
  'schedules',
  'reviews',
  'skills',
  'settings',
  'changes',
  'files',
  'terminal',
  'reader',
  'status',
  'palette',
] as const;

export type BuiltinPluginId = (typeof BUILTIN_PLUGIN_IDS)[number];

const BUILTIN_ID_SET: ReadonlySet<string> = new Set<string>(BUILTIN_PLUGIN_IDS);

export type BuiltinPluginFactory = () => WebuiPlugin;

export type BuiltinPluginFactories = {
  readonly [K in BuiltinPluginId]?: BuiltinPluginFactory;
};

export interface BuiltinPluginsDeps {
  readonly topics?: TopicsPluginDeps;
  readonly topic?: TopicPluginDeps;
  readonly history?: HistoryPluginDeps;
  readonly schedules?: SchedulesPluginDeps;
  readonly reviews?: ReviewsPluginDeps;
  readonly skills?: SkillsPluginDeps;
  readonly settings: SettingsPluginDeps;
  readonly changes?: ChangesPluginDeps;
  readonly files?: FilesPluginDeps;
  readonly terminal?: TerminalPluginDeps;
  readonly reader?: ReaderPluginDeps;
  readonly status?: StatusPluginDeps;
  readonly palette?: PalettePluginDeps;
  readonly extrasLoader?: ExtrasLoader;
}

export function createDefaultBuiltinPluginFactories(
  deps: BuiltinPluginsDeps,
): Required<BuiltinPluginFactories> {
  const loader = deps.extrasLoader ?? createExtrasLoader();
  return {
    topics: () => createTopicsPlugin(deps.topics),
    topic: () => createTopicPlugin(deps.topic),
    history: () => createLazyHistoryPlugin(loader, deps.history),
    schedules: () => createLazySchedulesPlugin(loader, deps.schedules),
    reviews: () => createLazyReviewsPlugin(loader, deps.reviews),
    skills: () => createLazySkillsPlugin(loader, deps.skills),
    settings: () => createLazySettingsPlugin(loader, deps.settings),
    changes: () => createLazyChangesPlugin(loader, deps.changes),
    files: () => createLazyFilesPlugin(loader, deps.files),
    terminal: () => createTerminalPlugin(deps.terminal),
    reader: () => createLazyReaderPlugin(loader, deps.reader),
    status: () => createStatusPlugin(deps.status),
    palette: () => createLazyPalettePlugin(loader, deps.palette),
  };
}

export function isBuiltinPluginId(id: string): id is BuiltinPluginId {
  return BUILTIN_ID_SET.has(id);
}

export function createPlaceholderBuiltinPlugin(id: BuiltinPluginId): WebuiPlugin {
  return definePlugin({
    id,
    activate() {
      // Placeholder until the corresponding P1-5..P1-12 feature plugin is wired in.
    },
  });
}

export function createBuiltinPlugins(factories: BuiltinPluginFactories = {}): readonly WebuiPlugin[] {
  return BUILTIN_PLUGIN_IDS.map((id) => {
    const factory = factories[id];
    const plugin = factory ? factory() : createPlaceholderBuiltinPlugin(id);
    if (plugin.id !== id) {
      throw new Error(`Built-in plugin factory for "${id}" returned mismatched id "${plugin.id}"`);
    }
    return plugin;
  });
}

export function registerBuiltinPlugins(
  manager: PluginManager,
  factories: BuiltinPluginFactories = {},
): Disposable {
  const plugins = createBuiltinPlugins(factories);
  const disposables = plugins.map((plugin) => manager.register(plugin, { builtin: true }));
  return combineDisposables(...disposables);
}
