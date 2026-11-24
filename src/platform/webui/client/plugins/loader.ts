import { type Disposable, DisposableStore, toDisposable } from '../base/lifecycle.js';
import { type BootPluginConfig, readBootConfig } from '../services/boot.js';
import type { WebuiPlugin } from './api.js';
import type { PluginManager } from './host.js';

export type BootPluginEntry = BootPluginConfig;

export type PluginLoadFailurePhase = 'style' | 'import' | 'validate' | 'register' | 'activate';

export interface PluginLoadFailure {
  readonly pluginId: string;
  readonly version: string;
  readonly phase: PluginLoadFailurePhase;
  readonly message: string;
  readonly error: unknown;
  readonly timestamp: number;
}

export type PluginModuleImporter = (url: string) => Promise<unknown>;

export interface ExternalPluginLoaderOptions {
  readonly manager: PluginManager;
  readonly doc?: Document;
  readonly importer?: PluginModuleImporter;
  readonly basePath?: string;
  readonly onError?: (failure: PluginLoadFailure) => void;
  readonly now?: () => number;
}

export interface ExternalPluginLoadSummary {
  readonly loaded: readonly string[];
  readonly styleOnly: readonly string[];
  readonly failures: readonly PluginLoadFailure[];
}

export interface LoadedExternalPlugins extends ExternalPluginLoadSummary, Disposable {}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const FORBIDDEN_PATH_CHARS_RE = /[\x00-\x1f\x7f\\?#]/;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function decodeSegmentStrict(segment: string): string {
  let prev = segment;
  for (let i = 0; i < 2; i++) {
    let next: string;
    try {
      next = decodeURIComponent(prev);
    } catch {
      throw new Error(`Malformed percent-encoding in plugin asset path: ${segment}`);
    }
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

function assertValidPluginId(pluginId: string): void {
  if (!pluginId || !pluginId.trim() || pluginId === '.' || pluginId === '..' || /[/\\\x00-\x1f\x7f\s]/.test(pluginId)) {
    throw new Error(`Invalid plugin id: ${pluginId}`);
  }
}

function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath) return '';
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

function extractPluginRelativePath(pluginId: string, rawAssetPath: string): string {
  const slashPrefix = `/plugins/${pluginId}/`;
  const relPrefix = `plugins/${pluginId}/`;
  if (rawAssetPath.startsWith(slashPrefix)) return rawAssetPath.slice(slashPrefix.length);
  if (rawAssetPath.startsWith(relPrefix)) return rawAssetPath.slice(relPrefix.length);
  if (rawAssetPath.startsWith('/') || rawAssetPath.startsWith('plugins/')) {
    throw new Error(`Plugin "${pluginId}" asset path must stay within /plugins/${pluginId}/: ${rawAssetPath}`);
  }
  return rawAssetPath;
}

function isTraversalSegment(segment: string, decoded: string): boolean {
  return (
    segment === '.' ||
    segment === '..' ||
    decoded === '.' ||
    decoded === '..' ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0')
  );
}

/**
 * Resolves a plugin's declared client or style asset path to a same-origin `/plugins/<id>/<file>` URL.
 * Accepts manifest-relative paths (`dist/client.js`), server boot-config paths (`plugins/<id>/dist/client.js`),
 * or already-prefixed paths (`/plugins/<id>/dist/client.js`), rejecting cross-origin URLs and path traversal.
 */
export function resolvePluginAssetUrl(pluginId: string, rawAssetPath: string, basePath = ''): string {
  assertValidPluginId(pluginId);
  if (!rawAssetPath || SCHEME_RE.test(rawAssetPath) || rawAssetPath.startsWith('//') || FORBIDDEN_PATH_CHARS_RE.test(rawAssetPath)) {
    throw new Error(`Unsafe plugin asset path for "${pluginId}": ${rawAssetPath}`);
  }
  const rel = extractPluginRelativePath(pluginId, rawAssetPath);
  const segments = rel.split('/');
  if (segments.length === 0 || segments.some((seg) => !seg)) {
    throw new Error(`Invalid plugin asset path for "${pluginId}": ${rawAssetPath}`);
  }
  for (const segment of segments) {
    if (isTraversalSegment(segment, decodeSegmentStrict(segment))) {
      throw new Error(`Path traversal is not allowed in plugin asset path for "${pluginId}": ${rawAssetPath}`);
    }
  }
  return `${normalizeBasePath(basePath)}/plugins/${pluginId}/${rel}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validatePluginCandidate(candidate: Record<string, unknown>, expectedId: string): WebuiPlugin {
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) {
    throw new Error(`Plugin "${expectedId}" export is missing a valid string id`);
  }
  if (candidate.id !== expectedId) {
    throw new Error(`Plugin id mismatch: boot config declared "${expectedId}", module exported "${candidate.id}"`);
  }
  if (typeof candidate.activate !== 'function') {
    throw new Error(`Plugin "${expectedId}" must export an activate(ctx) function`);
  }
  if (candidate.deactivate !== undefined && typeof candidate.deactivate !== 'function') {
    throw new Error(`Plugin "${expectedId}" deactivate export must be a function`);
  }
  return candidate as unknown as WebuiPlugin;
}

export function extractWebuiPlugin(mod: unknown, expectedId: string): WebuiPlugin {
  if (!isRecord(mod)) {
    throw new Error(`Plugin "${expectedId}" module must export an object`);
  }
  if (isRecord(mod.default)) {
    return validatePluginCandidate(mod.default, expectedId);
  }
  if (isRecord(mod.plugin)) {
    return validatePluginCandidate(mod.plugin, expectedId);
  }
  if (typeof mod.activate === 'function') {
    if (mod.id !== undefined) {
      if (typeof mod.id !== 'string' || mod.id !== expectedId) {
        throw new Error(`Plugin id mismatch: boot config declared "${expectedId}", module exported "${String(mod.id)}"`);
      }
    }
    if (mod.deactivate !== undefined && typeof mod.deactivate !== 'function') {
      throw new Error(`Plugin "${expectedId}" deactivate export must be a function`);
    }
    const activate = mod.activate as WebuiPlugin['activate'];
    const deactivate = mod.deactivate as WebuiPlugin['deactivate'];
    return deactivate ? { id: expectedId, activate, deactivate } : { id: expectedId, activate };
  }
  throw new Error(`Plugin "${expectedId}" module must export default plugin, named "plugin", or "activate"`);
}

function injectPluginStylesheet(doc: Document | undefined, pluginId: string, href: string): Disposable {
  if (!doc?.head) {
    throw new Error(`Cannot inject stylesheet for plugin "${pluginId}": document.head is unavailable`);
  }
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.setAttribute('data-plugin-id', pluginId);
  doc.head.appendChild(link);
  return toDisposable(() => {
    link.remove();
  });
}

const defaultImporter: PluginModuleImporter = (url) => import(/* @vite-ignore */ url);

export class ExternalPluginLoader implements Disposable {
  private readonly _manager: PluginManager;
  private readonly _doc: Document | undefined;
  private readonly _importer: PluginModuleImporter;
  private readonly _basePath: string;
  private readonly _onError?: (failure: PluginLoadFailure) => void;
  private readonly _now: () => number;
  private readonly _subscriptions = new DisposableStore();
  private readonly _seenIds = new Set<string>();
  private readonly _loaded: string[] = [];
  private readonly _styleOnly: string[] = [];
  private readonly _failures: PluginLoadFailure[] = [];
  private _disposed = false;

  constructor(options: ExternalPluginLoaderOptions) {
    this._manager = options.manager;
    this._doc = options.doc ?? (typeof document !== 'undefined' ? document : undefined);
    this._importer = options.importer ?? defaultImporter;
    this._basePath = normalizeBasePath(options.basePath);
    this._onError = options.onError;
    this._now = options.now ?? (() => Date.now());
  }

  getFailures(): readonly PluginLoadFailure[] {
    return [...this._failures];
  }

  async loadFromBootConfig(): Promise<ExternalPluginLoadSummary> {
    const plugins = this._doc ? readBootConfig(this._doc).plugins : [];
    return this.load(plugins);
  }

  async load(entries: readonly BootPluginEntry[]): Promise<ExternalPluginLoadSummary> {
    for (const entry of entries) {
      if (this._disposed) break;
      await this._loadSingle(entry);
    }
    return {
      loaded: [...this._loaded],
      styleOnly: [...this._styleOnly],
      failures: [...this._failures],
    };
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._subscriptions.dispose();
  }

  private async _loadSingle(entry: BootPluginEntry): Promise<void> {
    if (this._seenIds.has(entry.id)) {
      this._recordFailure(entry, 'validate', new Error(`Duplicate external plugin id: ${entry.id}`));
      return;
    }
    this._seenIds.add(entry.id);

    const styleResult = this._loadStyle(entry);
    if (!styleResult.ok) return;
    const styleSub = styleResult.disposable;

    if (!entry.client) {
      if (styleSub) {
        if (this._disposed) {
          styleSub.dispose();
        } else {
          this._subscriptions.add(styleSub);
          this._styleOnly.push(entry.id);
        }
      }
      return;
    }

    const plugin = await this._importAndValidate(entry);
    if (!plugin || this._disposed) {
      styleSub?.dispose();
      return;
    }

    await this._registerAndActivate(entry, plugin, styleSub);
  }

  private _loadStyle(entry: BootPluginEntry): { readonly ok: true; readonly disposable?: Disposable } | { readonly ok: false } {
    if (!entry.style) return { ok: true };
    try {
      const href = resolvePluginAssetUrl(entry.id, entry.style, this._basePath);
      return { ok: true, disposable: injectPluginStylesheet(this._doc, entry.id, href) };
    } catch (err) {
      this._recordFailure(entry, 'style', err);
      return { ok: false };
    }
  }

  private async _importAndValidate(entry: BootPluginEntry): Promise<WebuiPlugin | undefined> {
    let mod: unknown;
    try {
      const clientUrl = resolvePluginAssetUrl(entry.id, entry.client!, this._basePath);
      mod = await this._importer(clientUrl);
    } catch (err) {
      this._recordFailure(entry, 'import', err);
      return undefined;
    }
    if (this._disposed) return undefined;
    try {
      return extractWebuiPlugin(mod, entry.id);
    } catch (err) {
      this._recordFailure(entry, 'validate', err);
      return undefined;
    }
  }

  private async _registerAndActivate(
    entry: BootPluginEntry,
    plugin: WebuiPlugin,
    styleSub: Disposable | undefined,
  ): Promise<void> {
    let regSub: Disposable;
    try {
      regSub = this._manager.register(plugin, { builtin: false });
    } catch (err) {
      styleSub?.dispose();
      this._recordFailure(entry, 'register', err);
      return;
    }

    const ok = await this._manager.activate(plugin.id);
    if (this._disposed) {
      styleSub?.dispose();
      regSub.dispose();
      return;
    }
    if (!ok) {
      styleSub?.dispose();
      this._subscriptions.add(regSub);
      const record = this._manager.list().find((item) => item.id === entry.id)?.error;
      const err = record?.error ?? new Error(record?.message ?? `Plugin "${entry.id}" failed to activate`);
      this._recordFailure(entry, 'activate', err);
      return;
    }

    if (styleSub) this._subscriptions.add(styleSub);
    this._subscriptions.add(regSub);
    this._loaded.push(entry.id);
  }

  private _recordFailure(entry: BootPluginEntry, phase: PluginLoadFailurePhase, err: unknown): void {
    const failure: PluginLoadFailure = {
      pluginId: entry.id,
      version: entry.version,
      phase,
      message: errorMessage(err),
      error: err,
      timestamp: this._now(),
    };
    this._failures.push(failure);
    try {
      this._onError?.(failure);
    } catch {
      // Never let an error reporter break plugin isolation.
    }
  }
}

export async function loadExternalPlugins(
  options: ExternalPluginLoaderOptions & { readonly plugins?: readonly BootPluginEntry[] },
): Promise<LoadedExternalPlugins> {
  const loader = new ExternalPluginLoader(options);
  const summary = options.plugins !== undefined ? await loader.load(options.plugins) : await loader.loadFromBootConfig();
  return {
    ...summary,
    dispose: () => loader.dispose(),
  };
}
