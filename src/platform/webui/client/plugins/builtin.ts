import { combineDisposables, type Disposable } from '../base/lifecycle.js';
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
