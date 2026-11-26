import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { configDir } from '../../../config/load.js';
import type { TopicSnapshot } from '../protocol.js';
import type { RoomEventKind, WebRoom } from '../room.js';
import type { Topic } from '../topics.js';
import { isPathWithin, type LoadedPluginEntry } from './loader.js';
import { isSafeRelativePath, PLUGIN_ID_RE } from './manifest.js';

export interface Disposable {
  dispose(): void;
}

export type PluginRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export type PluginTopicSnapshot = TopicSnapshot;

export type PluginEventKind = RoomEventKind;

export interface PluginHost {
  readonly id: string;
  readonly config: unknown;
  readonly log: (msg: string) => void;
  readonly routes: {
    get(path: string, handler: PluginRouteHandler): void;
    post(path: string, handler: PluginRouteHandler): void;
  };
  readonly topics: {
    list(): Topic[];
    get(id: string): PluginTopicSnapshot | undefined;
    send(id: string, text: string): Promise<void>;
  };
  readonly events: {
    on(kind: PluginEventKind, cb: (event: unknown) => void): Disposable;
    push(type: string, data: unknown): void;
  };
  readonly storage: {
    read(): Promise<unknown>;
    write(value: unknown): Promise<void>;
  };
}

export interface ServerPluginModule {
  activate(host: PluginHost): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface PluginHostManagerOptions {
  readonly room: WebRoom;
  readonly plugins: readonly LoadedPluginEntry[];
  readonly storageDir?: string;
  readonly log?: (msg: string) => void;
}

type RouteMethod = 'GET' | 'POST';

interface ActivePluginState {
  readonly id: string;
  readonly routes: Map<string, PluginRouteHandler>;
  readonly subscriptions: Set<Disposable>;
  deactivate?: () => void | Promise<void>;
  disposed: boolean;
}

const VALID_EVENT_KINDS: ReadonlySet<string> = new Set<PluginEventKind>(['topic', 'message', 'turn']);
const PLUGIN_EVENT_TYPE_RE = /^[a-zA-Z0-9._:-]{1,80}$/;

/**
 * Normalize a plugin-relative HTTP route path to a canonical leading-slash form (e.g. `/`, `/ping`).
 * Rejects NUL bytes, backslashes, query/hash fragments, and `.` / `..` segments.
 */
export function normalizePluginRoutePath(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('\\') || raw.includes('?') || raw.includes('#')) return null;
  const parts = raw.split('/');
  const clean: string[] = [];
  for (const seg of parts) {
    if (seg === '') continue;
    if (seg === '.' || seg === '..') return null;
    clean.push(seg);
  }
  return clean.length === 0 ? '/' : `/${clean.join('/')}`;
}

function routeKey(method: RouteMethod, normalizedPath: string): string {
  return `${method} ${normalizedPath}`;
}

function resolveServerEntry(plugin: LoadedPluginEntry): string | null {
  const rel = plugin.manifest.server;
  if (!rel) return null;
  if (!isSafeRelativePath(rel)) {
    throw new Error(`unsafe server entrypoint "${rel}"`);
  }
  const candidate = path.resolve(plugin.dir, ...rel.split('/'));
  if (!isPathWithin(candidate, plugin.dir)) {
    throw new Error(`server entrypoint "${rel}" escapes plugin directory`);
  }
  const realFile = fs.realpathSync(candidate);
  if (!isPathWithin(realFile, plugin.dir)) {
    throw new Error(`server entrypoint "${rel}" resolves outside plugin directory`);
  }
  if (!fs.statSync(realFile).isFile()) {
    throw new Error(`server entrypoint "${rel}" is not a regular file`);
  }
  return realFile;
}

function extractPluginModule(imported: unknown): ServerPluginModule {
  if (imported && typeof imported === 'object') {
    const rec = imported as Record<string, unknown>;
    if (typeof rec.activate === 'function') {
      return {
        activate: rec.activate as ServerPluginModule['activate'],
        ...(typeof rec.deactivate === 'function'
          ? { deactivate: rec.deactivate as NonNullable<ServerPluginModule['deactivate']> }
          : {}),
      };
    }
    const def = rec.default;
    if (def && typeof def === 'object' && typeof (def as Record<string, unknown>).activate === 'function') {
      const defRec = def as Record<string, unknown>;
      return {
        activate: defRec.activate as ServerPluginModule['activate'],
        ...(typeof defRec.deactivate === 'function'
          ? { deactivate: defRec.deactivate as NonNullable<ServerPluginModule['deactivate']> }
          : {}),
      };
    }
  }
  throw new Error('server plugin module must export an activate(host) function');
}

function resolveStorageFile(storageDir: string, pluginId: string): string {
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw new Error(`invalid plugin id for storage: "${pluginId}"`);
  }
  const baseDir = path.resolve(storageDir);
  const file = path.resolve(baseDir, `${pluginId}.json`);
  if (path.dirname(file) !== baseDir) {
    throw new Error(`plugin storage path escapes base directory for "${pluginId}"`);
  }
  return file;
}

function createPluginStorage(
  storageDir: string,
  pluginId: string
): PluginHost['storage'] {
  const targetFile = resolveStorageFile(storageDir, pluginId);
  const baseDir = path.dirname(targetFile);
  let writeTail: Promise<void> = Promise.resolve();

  const writeAtomic = async (value: unknown): Promise<void> => {
    const serialized = JSON.stringify(value === undefined ? null : value, null, 2);
    if (serialized === undefined) {
      throw new TypeError(`plugin "${pluginId}" storage value is not JSON-serializable`);
    }
    await fs.promises.mkdir(baseDir, { recursive: true, mode: 0o700 });
    const tmpFile = path.join(baseDir, `.${pluginId}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(tmpFile, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.chmod(tmpFile, 0o600);
      await fs.promises.rename(tmpFile, targetFile);
    } catch (e) {
      await fs.promises.rm(tmpFile, { force: true }).catch(() => {});
      throw e;
    }
  };

  return {
    async read(): Promise<unknown> {
      try {
        const raw = await fs.promises.readFile(targetFile, 'utf8');
        return JSON.parse(raw) as unknown;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw e;
      }
    },
    write(value: unknown): Promise<void> {
      const next = writeTail.then(() => writeAtomic(value));
      writeTail = next.catch(() => {});
      return next;
    },
  };
}

export class PluginHostManager {
  private readonly room: WebRoom;
  private readonly plugins: readonly LoadedPluginEntry[];
  private readonly storageDir: string;
  private readonly logFn: (msg: string) => void;
  private readonly active = new Map<string, ActivePluginState>();
  private disposed = false;

  constructor(opts: PluginHostManagerOptions) {
    this.room = opts.room;
    this.plugins = opts.plugins;
    this.storageDir = opts.storageDir ?? path.join(configDir(), 'plugins');
    this.logFn = opts.log ?? ((msg: string) => console.log(msg));
  }

  get activePluginIds(): string[] {
    return [...this.active.keys()];
  }

  async activateAll(): Promise<void> {
    if (this.disposed) return;
    for (const plugin of this.plugins) {
      if (!plugin.manifest.server || this.active.has(plugin.id)) continue;
      await this.activateOne(plugin);
    }
  }

  private async activateOne(plugin: LoadedPluginEntry): Promise<void> {
    const state: ActivePluginState = {
      id: plugin.id,
      routes: new Map(),
      subscriptions: new Set(),
      disposed: false,
    };
    try {
      const serverFile = resolveServerEntry(plugin);
      if (!serverFile) return;
      const imported: unknown = await import(pathToFileURL(serverFile).href);
      const mod = extractPluginModule(imported);
      const host = this.buildHost(plugin, state);
      this.active.set(plugin.id, state);
      await mod.activate(host);
      if (mod.deactivate) state.deactivate = mod.deactivate;
    } catch (e) {
      this.cleanupState(state);
      this.active.delete(plugin.id);
      this.logFn(
        `[webui:plugin:${plugin.id}] failed to activate server plugin: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private buildHost(plugin: LoadedPluginEntry, state: ActivePluginState): PluginHost {
    const pluginLog = (msg: string): void => {
      this.logFn(`[webui:plugin:${plugin.id}] ${msg}`);
    };
    const registerRoute = (method: RouteMethod, routePath: string, handler: PluginRouteHandler): void => {
      if (state.disposed || this.disposed) {
        throw new Error(`plugin "${plugin.id}" is disposed`);
      }
      const normalized = normalizePluginRoutePath(routePath);
      if (!normalized) {
        throw new Error(`invalid route path "${routePath}" for plugin "${plugin.id}"`);
      }
      state.routes.set(routeKey(method, normalized), handler);
    };

    const storage = createPluginStorage(this.storageDir, plugin.id);

    return {
      id: plugin.id,
      config: plugin.config,
      log: pluginLog,
      routes: {
        get: (routePath, handler) => registerRoute('GET', routePath, handler),
        post: (routePath, handler) => registerRoute('POST', routePath, handler),
      },
      topics: {
        list: () => this.room.topicList(),
        get: (id) => this.room.snapshot(id),
        send: async (id, text) => {
          const trimmed = text.trim();
          if (!trimmed) throw new Error('plugin topic message must not be empty');
          // Security invariant 12: plugin messages are always visible and explicitly attributed
          // to the plugin in the conversation transcript; never hidden or injected into prompts.
          const visibleText = `[plugin:${plugin.id}] ${trimmed}`;
          const outcome = this.room.submit({ topic: id, text: visibleText });
          if (outcome === 'unknown-topic') {
            throw new Error(`no such topic: ${id}`);
          }
        },
      },
      events: {
        on: (kind, cb) => {
          if (!VALID_EVENT_KINDS.has(kind)) {
            throw new Error(`unsupported plugin event kind "${String(kind)}"`);
          }
          if (state.disposed || this.disposed) {
            return { dispose: () => {} };
          }
          const unsub = this.room.onRoomEvent(kind, (payload) => {
            try {
              cb(payload);
            } catch (e) {
              pluginLog(`event "${kind}" listener failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          });
          let done = false;
          const disposable: Disposable = {
            dispose: () => {
              if (done) return;
              done = true;
              unsub();
              state.subscriptions.delete(disposable);
            },
          };
          state.subscriptions.add(disposable);
          return disposable;
        },
        push: (type, data) => {
          if (state.disposed || this.disposed) return;
          if (!PLUGIN_EVENT_TYPE_RE.test(type)) {
            throw new Error(`invalid plugin SSE event type "${type}"`);
          }
          this.room.broadcastPluginEvent(plugin.id, type, data);
        },
      },
      storage,
    };
  }

  async dispatchRoute(
    req: IncomingMessage,
    res: ServerResponse,
    pluginId: string,
    subpath: string
  ): Promise<boolean> {
    if (this.disposed || !PLUGIN_ID_RE.test(pluginId)) return false;
    const method = req.method === 'POST' ? 'POST' : req.method === 'GET' ? 'GET' : null;
    if (!method) return false;
    const state = this.active.get(pluginId);
    if (!state || state.disposed) return false;
    const normalized = normalizePluginRoutePath(subpath);
    if (!normalized) return false;
    const handler = state.routes.get(routeKey(method, normalized));
    if (!handler) return false;
    try {
      await handler(req, res);
    } catch (e) {
      this.logFn(
        `[webui:plugin:${pluginId}] route ${method} ${normalized} failed: ${e instanceof Error ? e.message : String(e)}`
      );
      if (!res.headersSent) {
        const body = Buffer.from(JSON.stringify({ error: 'plugin route failed' }), 'utf8');
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': body.length,
        });
        res.end(body);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const states = [...this.active.values()];
    this.active.clear();
    for (const state of states) {
      this.cleanupState(state);
    }
    for (const state of states) {
      if (!state.deactivate) continue;
      try {
        await state.deactivate();
      } catch (e) {
        this.logFn(
          `[webui:plugin:${state.id}] deactivate failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  private cleanupState(state: ActivePluginState): void {
    state.disposed = true;
    state.routes.clear();
    for (const sub of [...state.subscriptions]) {
      try {
        sub.dispose();
      } catch {
        // Ignore teardown errors during plugin cleanup.
      }
    }
    state.subscriptions.clear();
  }
}
