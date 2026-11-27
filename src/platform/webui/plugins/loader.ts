import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WebuiPluginConfig } from '../../../config/platform-schemas.js';
import {
  isSafeRelativePath,
  parsePluginManifest,
  type BootPluginEntry,
  type PluginManifest,
} from './manifest.js';

export const MANIFEST_FILENAME = 'fleetherd-plugin.json';

export interface LoadedPluginEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Canonical realpath of the plugin directory. */
  readonly dir: string;
  readonly config: unknown;
  readonly manifest: PluginManifest;
  /**
   * Exact allowlist of relative POSIX paths (e.g. `dist/client.js`) mapped to their canonical
   * absolute file path on disk. Only files listed here may be served by `GET /plugins/<id>/<file>`.
   */
  readonly allowedFiles: ReadonlyMap<string, string>;
  /** Frontend boot descriptor; omitted for server-only plugins. */
  readonly bootEntry?: BootPluginEntry;
}

export type SinglePluginResult =
  | { readonly ok: true; readonly plugin: LoadedPluginEntry }
  | { readonly ok: false; readonly reason: string };

export interface LoadPluginsOptions {
  readonly forbiddenRoots?: readonly string[];
  readonly log?: (msg: string) => void;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Content-Type for a whitelisted plugin asset; unknown/HTML extensions fall back to octet-stream. */
export function pluginMimeType(relPath: string): string {
  const ext = path.posix.extname(relPath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeForCompare(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** Whether `target` is equal to or nested inside `root` (both must be absolute). */
export function isPathWithin(target: string, root: string): boolean {
  const rel = path.relative(normalizeForCompare(root), normalizeForCompare(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function tryRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Security invariant 12: reject plugin directories inside `files.roots` or any agent working
 * directory. Checks both `path.resolve` and `fs.realpathSync` to block symlink escapes.
 * Returns the canonical realpath of `pluginDir`.
 */
export function assertSafePluginDir(pluginDir: string, forbiddenRoots: readonly string[]): string {
  const expanded = expandTilde(pluginDir);
  const resolved = path.resolve(expanded);
  let realDir: string;
  try {
    realDir = fs.realpathSync(resolved);
  } catch (e) {
    throw new Error(`plugin directory not accessible (${resolved}): ${e instanceof Error ? e.message : String(e)}`);
  }
  const st = fs.statSync(realDir);
  if (!st.isDirectory()) {
    throw new Error(`plugin path is not a directory: ${resolved}`);
  }
  for (const rawRoot of forbiddenRoots) {
    if (!rawRoot) continue;
    const resolvedRoot = path.resolve(expandTilde(rawRoot));
    const realRoot = tryRealpath(resolvedRoot);
    if (
      isPathWithin(resolved, resolvedRoot) ||
      isPathWithin(realDir, resolvedRoot) ||
      (realRoot !== undefined && (isPathWithin(resolved, realRoot) || isPathWithin(realDir, realRoot)))
    ) {
      throw new Error(`plugin directory "${pluginDir}" is inside forbidden root "${rawRoot}"`);
    }
  }
  return realDir;
}

function globToRegExp(pattern: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? '';
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`${out}$`);
}

function resolveContainedFile(realDir: string, relPosix: string): string {
  if (!isSafeRelativePath(relPosix)) {
    throw new Error(`unsafe relative path "${relPosix}"`);
  }
  const candidate = path.resolve(realDir, ...relPosix.split('/'));
  if (!isPathWithin(candidate, realDir)) {
    throw new Error(`path "${relPosix}" escapes plugin directory`);
  }
  const realFile = tryRealpath(candidate);
  if (!realFile) {
    throw new Error(`declared file "${relPosix}" does not exist`);
  }
  if (!isPathWithin(realFile, realDir)) {
    throw new Error(`declared file "${relPosix}" resolves outside plugin directory`);
  }
  if (!fs.statSync(realFile).isFile()) {
    throw new Error(`declared file "${relPosix}" is not a regular file`);
  }
  return realFile;
}

function walkPluginFiles(realDir: string): Array<{ relPosix: string; realFile: string }> {
  const results: Array<{ relPosix: string; realFile: string }> = [];
  const visitedDirs = new Set<string>([normalizeForCompare(realDir)]);

  const walk = (absDir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const nextAbs = path.join(absDir, ent.name);
      const nextRel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const realNext = tryRealpath(nextAbs);
      if (!realNext || !isPathWithin(realNext, realDir)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(realNext);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const key = normalizeForCompare(realNext);
        if (visitedDirs.has(key)) continue;
        visitedDirs.add(key);
        walk(nextAbs, nextRel);
      } else if (st.isFile()) {
        results.push({ relPosix: nextRel, realFile: realNext });
      }
    }
  };

  walk(realDir, '');
  return results;
}

function buildAllowedFiles(realDir: string, manifest: PluginManifest): Map<string, string> {
  const allowed = new Map<string, string>();
  if (manifest.client) {
    allowed.set(manifest.client, resolveContainedFile(realDir, manifest.client));
  }
  if (manifest.style) {
    allowed.set(manifest.style, resolveContainedFile(realDir, manifest.style));
  }
  if (manifest.assets && manifest.assets.length > 0) {
    const matchers = manifest.assets.map(globToRegExp);
    for (const { relPosix, realFile } of walkPluginFiles(realDir)) {
      if (matchers.some((re) => re.test(relPosix))) {
        allowed.set(relPosix, realFile);
      }
    }
  }
  return allowed;
}

function readManifestFromDir(realDir: string): PluginManifest {
  const manifestPath = path.join(realDir, MANIFEST_FILENAME);
  const realManifest = tryRealpath(manifestPath);
  if (!realManifest || !isPathWithin(realManifest, realDir)) {
    throw new Error(`missing or invalid ${MANIFEST_FILENAME}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(realManifest, 'utf8')) as unknown;
  } catch (e) {
    throw new Error(`failed to parse ${MANIFEST_FILENAME}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = parsePluginManifest(raw);
  if (!parsed.ok) throw new Error(`invalid ${MANIFEST_FILENAME}: ${parsed.error}`);
  return parsed.manifest;
}

export function loadSinglePlugin(
  entry: WebuiPluginConfig,
  forbiddenRoots: readonly string[] = [],
  seenIds?: ReadonlySet<string>
): SinglePluginResult {
  try {
    const realDir = assertSafePluginDir(entry.path, forbiddenRoots);
    const manifest = readManifestFromDir(realDir);
    if (seenIds?.has(manifest.id)) {
      return { ok: false, reason: `duplicate plugin id "${manifest.id}"` };
    }
    const allowedFiles = buildAllowedFiles(realDir, manifest);
    const bootEntry: BootPluginEntry | undefined =
      manifest.client || manifest.style
        ? {
            id: manifest.id,
            version: manifest.version,
            ...(manifest.client ? { client: `plugins/${manifest.id}/${manifest.client}` } : {}),
            ...(manifest.style ? { style: `plugins/${manifest.id}/${manifest.style}` } : {}),
          }
        : undefined;
    return {
      ok: true,
      plugin: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        dir: realDir,
        config: entry.config,
        manifest,
        allowedFiles,
        ...(bootEntry ? { bootEntry } : {}),
      },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function loadPlugins(
  entries: readonly WebuiPluginConfig[],
  options: LoadPluginsOptions = {}
): LoadedPluginEntry[] {
  const forbiddenRoots = options.forbiddenRoots ?? [];
  const log = options.log ?? ((msg: string) => console.warn(msg));
  const loaded: LoadedPluginEntry[] = [];
  const seenIds = new Set<string>();
  for (const entry of entries) {
    const result = loadSinglePlugin(entry, forbiddenRoots, seenIds);
    if (!result.ok) {
      log(`[webui] skipping plugin "${entry.path}": ${result.reason}`);
      continue;
    }
    seenIds.add(result.plugin.id);
    loaded.push(result.plugin);
  }
  return loaded;
}
