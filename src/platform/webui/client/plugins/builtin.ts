import { combineDisposables, type Disposable } from '../base/lifecycle.js';
import { createChangesPlugin, type ChangesPluginDeps } from '../features/changes/index.js';
import { createFilesPlugin, type FilesPluginDeps } from '../features/files/index.js';
import { createHistoryPlugin, type HistoryPluginDeps } from '../features/history/index.js';
import { createReaderPlugin, type ReaderPluginDeps } from '../features/reader/plugin.js';
import { createReviewsPlugin, type ReviewsPluginDeps } from '../features/reviews/index.js';
import { createSchedulesPlugin, type SchedulesPluginDeps } from '../features/schedules/index.js';
import { createSettingsPlugin, type SettingsPluginDeps } from '../features/settings/plugin.js';
import { createSkillsPlugin, type SkillsPluginDeps } from '../features/skills/index.js';
import { createStatusPlugin, type StatusPluginDeps } from '../features/status/index.js';
import { createTerminalPlugin, type TerminalPluginDeps } from '../features/terminal/plugin.js';
import { createTopicPlugin, type TopicPluginDeps } from '../features/topic/plugin.js';
import { createTopicsPlugin, type TopicsPluginDeps } from '../features/topics/plugin.js';
import { definePlugin, type WebuiPlugin } from './api.js';
import type { PluginManager } from './host.js';

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
}

export function createDefaultBuiltinPluginFactories(
  deps: BuiltinPluginsDeps,
): Required<BuiltinPluginFactories> {
  return {
    topics: () => createTopicsPlugin(deps.topics),
    topic: () => createTopicPlugin(deps.topic),
    history: () => createHistoryPlugin(deps.history),
    schedules: () => createSchedulesPlugin(deps.schedules),
    reviews: () => createReviewsPlugin(deps.reviews),
    skills: () => createSkillsPlugin(deps.skills),
    settings: () => createSettingsPlugin(deps.settings),
    changes: () => createChangesPlugin(deps.changes),
    files: () => createFilesPlugin(deps.files),
    terminal: () => createTerminalPlugin(deps.terminal),
    reader: () => createReaderPlugin(deps.reader),
    status: () => createStatusPlugin(deps.status),
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
