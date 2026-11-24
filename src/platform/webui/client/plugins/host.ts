import { Emitter, type Event } from '../base/event.js';
import { type Disposable, toDisposable } from '../base/lifecycle.js';
import type { PluginContext, WebuiPlugin } from './api.js';
import { createPluginContext, type CreatePluginContextOptions } from './registry.js';

export type PluginStatus = 'registered' | 'activating' | 'active' | 'failed' | 'deactivated';

export type PluginErrorPhase = 'activate' | 'deactivate';

export interface PluginErrorRecord {
  readonly pluginId: string;
  readonly phase: PluginErrorPhase;
  readonly error: unknown;
  readonly message: string;
  readonly timestamp: number;
}

export interface PluginRecordView {
  readonly id: string;
  readonly builtin: boolean;
  readonly status: PluginStatus;
  readonly error?: PluginErrorRecord;
}

export interface RegisterPluginOptions {
  readonly builtin?: boolean;
}

export interface PluginManagerOptions extends Omit<CreatePluginContextOptions, 'builtin'> {
  readonly onError?: (record: PluginErrorRecord) => void;
  readonly now?: () => number;
}

interface PluginEntry {
  readonly plugin: WebuiPlugin;
  readonly builtin: boolean;
  status: PluginStatus;
  ctx?: PluginContext;
  error?: PluginErrorRecord;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

export class PluginManager implements Disposable {
  private readonly _options: PluginManagerOptions;
  private readonly _now: () => number;
  private readonly _entries = new Map<string, PluginEntry>();
  private readonly _errors: PluginErrorRecord[] = [];
  private readonly _onDidChange = new Emitter<void>();
  private readonly _onDidError = new Emitter<PluginErrorRecord>();
  private _disposed = false;

  readonly onDidChange: Event<void> = this._onDidChange.event;
  readonly onDidError: Event<PluginErrorRecord> = this._onDidError.event;

  constructor(options: PluginManagerOptions) {
    this._options = options;
    this._now = options.now ?? (() => Date.now());
  }

  register(plugin: WebuiPlugin, options: RegisterPluginOptions = {}): Disposable {
    if (this._disposed) {
      throw new Error('PluginManager is disposed');
    }
    if (!plugin.id || !plugin.id.trim()) {
      throw new Error('Plugin id must not be empty');
    }
    if (this._entries.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    const entry: PluginEntry = {
      plugin,
      builtin: options.builtin === true,
      status: 'registered',
    };
    this._entries.set(plugin.id, entry);
    this._onDidChange.fire();
    return toDisposable(() => {
      if (this._entries.get(plugin.id) !== entry) return;
      this._deactivateEntry(entry);
      this._entries.delete(plugin.id);
      this._onDidChange.fire();
    });
  }

  has(id: string): boolean {
    return this._entries.has(id);
  }

  getStatus(id: string): PluginStatus | undefined {
    return this._entries.get(id)?.status;
  }

  list(): readonly PluginRecordView[] {
    return [...this._entries.values()].map((entry) => ({
      id: entry.plugin.id,
      builtin: entry.builtin,
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  getErrors(): readonly PluginErrorRecord[] {
    return [...this._errors];
  }

  async activate(id: string): Promise<boolean> {
    if (this._disposed) return false;
    const entry = this._entries.get(id);
    if (!entry) throw new Error(`Unknown plugin: ${id}`);
    if (entry.status === 'active' || entry.status === 'activating') return entry.status === 'active';

    entry.status = 'activating';
    entry.error = undefined;
    const ctx = createPluginContext(entry.plugin.id, {
      ...this._options,
      builtin: entry.builtin,
    });
    entry.ctx = ctx;
    this._onDidChange.fire();

    try {
      await entry.plugin.activate(ctx);
      if (this._disposed || this._entries.get(id) !== entry) {
        this._disposeSubscriptionsSafe(entry);
        return false;
      }
      entry.status = 'active';
      this._onDidChange.fire();
      return true;
    } catch (err) {
      // Roll back partial contributions registered before activation threw.
      this._disposeSubscriptionsSafe(entry);
      const record = this._recordError(entry.plugin.id, 'activate', err);
      entry.error = record;
      entry.status = 'failed';
      this._onDidChange.fire();
      return false;
    }
  }

  async activateAll(): Promise<readonly string[]> {
    const activated: string[] = [];
    for (const id of [...this._entries.keys()]) {
      if (this._disposed) break;
      const ok = await this.activate(id);
      if (ok) activated.push(id);
    }
    return activated;
  }

  deactivate(id: string): void {
    const entry = this._entries.get(id);
    if (!entry) return;
    if (this._deactivateEntry(entry)) {
      this._onDidChange.fire();
    }
  }

  deactivateAll(): void {
    let changed = false;
    const entries = [...this._entries.values()].reverse();
    for (const entry of entries) {
      if (this._deactivateEntry(entry)) changed = true;
    }
    if (changed) this._onDidChange.fire();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const entries = [...this._entries.values()].reverse();
    for (const entry of entries) {
      this._deactivateEntry(entry);
    }
    this._entries.clear();
    this._onDidChange.dispose();
    this._onDidError.dispose();
  }

  private _deactivateEntry(entry: PluginEntry): boolean {
    if (entry.status !== 'active' && entry.status !== 'activating' && !entry.ctx) {
      return false;
    }
    try {
      entry.plugin.deactivate?.();
    } catch (err) {
      const record = this._recordError(entry.plugin.id, 'deactivate', err);
      entry.error = record;
    } finally {
      this._disposeSubscriptionsSafe(entry);
      entry.status = 'deactivated';
    }
    return true;
  }

  private _disposeSubscriptionsSafe(entry: PluginEntry): void {
    const ctx = entry.ctx;
    entry.ctx = undefined;
    if (!ctx) return;
    try {
      ctx.subscriptions.dispose();
    } catch (err) {
      const record = this._recordError(entry.plugin.id, 'deactivate', err);
      entry.error = record;
    }
  }

  private _recordError(pluginId: string, phase: PluginErrorPhase, err: unknown): PluginErrorRecord {
    const record: PluginErrorRecord = {
      pluginId,
      phase,
      error: err,
      message: errorMessage(err),
      timestamp: this._now(),
    };
    this._errors.push(record);
    try {
      this._options.onError?.(record);
    } catch {
      // Never let a status-bar error reporter break plugin isolation.
    }
    this._onDidError.fire(record);
    return record;
  }
}
