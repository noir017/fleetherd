import type { FilesPanelEntry } from '../../../../adapter.js';
import { icon } from '../../../icons.js';
import type { TreeNode } from '../../components/index.js';
import type { PluginContext } from '../../plugins/api.js';
import { createApiClient, type ApiClient } from '../../services/api.js';
import type {
  FileEditorInput,
  FilesHttpResult,
  FilesPluginDeps,
  FilesTreeCacheEntry,
  FileTreeItemData,
} from './types.js';

export interface FilesHttpClient {
  get(route: string, params: Record<string, string | undefined>): Promise<FilesHttpResult>;
  post(route: string, body: Record<string, unknown>): Promise<FilesHttpResult>;
}

export function isFilesFeatureEnabled(deps: FilesPluginDeps): boolean {
  if (typeof deps.filesEnabled === 'function') return Boolean(deps.filesEnabled());
  return deps.filesEnabled === true;
}

export function resolveFilesApi(deps: FilesPluginDeps): Pick<ApiClient, 'get' | 'post'> {
  if (deps.api) return deps.api;
  if (deps.fetchFn) return createApiClient({ fetchFn: deps.fetchFn });
  return createApiClient();
}

export function createFilesHttpClient(api: Pick<ApiClient, 'get' | 'post'>): FilesHttpClient {
  return {
    async get(route, params): Promise<FilesHttpResult> {
      const qs: string[] = [];
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === '') continue;
        qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
      const path = `/api/files/${route}${qs.length > 0 ? `?${qs.join('&')}` : ''}`;
      const res = await api.get(path, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, status: res.status, body };
    },
    async post(route, body): Promise<FilesHttpResult> {
      const res = await api.post(`/api/files/${route}`, body, 1);
      const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, status: res.status, body: parsed };
    },
  };
}

export function fileErrorMessage(ctx: PluginContext, res: { status: number }, body?: Record<string, unknown>): string {
  if (body && typeof body.error === 'string' && body.error) return body.error;
  return res.status === 404
    ? ctx.i18n.t('files.notEnabled')
    : ctx.i18n.t('files.requestFailed', { status: res.status });
}

export function sepOf(root: string): '/' | '\\' {
  return root && root.includes('\\') && !root.includes('/') ? '\\' : '/';
}

export function joinPath(dir: string, name: string, sep: '/' | '\\'): string {
  if (!dir) return name;
  const last = dir.charAt(dir.length - 1);
  return dir + (last === '/' || last === '\\' ? '' : sep) + name;
}

export function dirOf(filePath: string): string {
  const at = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (at < 0) return '';
  if (at === 0) return filePath.charAt(0);
  if (at === 2 && /^[A-Za-z]:$/.test(filePath.slice(0, 2))) return filePath.slice(0, 3);
  return filePath.slice(0, at);
}

export function baseName(filePath: string): string {
  const at = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return at < 0 ? filePath : filePath.slice(at + 1);
}

export function isValidSegment(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
}

export function toEditorDoc(raw: unknown): string {
  return String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function fromEditorDoc(doc: string, eol: 'crlf' | 'lf'): string {
  const lf = String(doc || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

export function eolWarningText(ctx: PluginContext, warning: unknown, eol: 'crlf' | 'lf'): string {
  if (warning === 'cr') return ctx.i18n.t('files.eolCr');
  if (warning === 'mixed') return ctx.i18n.t('files.eolMixed', { eol: eol === 'crlf' ? 'CRLF' : 'LF' });
  return '';
}

export function isFileEditorInput(value: unknown): value is FileEditorInput {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.topicId === 'string' && obj.topicId.length > 0 && typeof obj.path === 'string' && obj.path.length > 0;
}

export function fileEditorTitle(input: unknown, fallbackTitle: string): string {
  if (!isFileEditorInput(input)) return fallbackTitle;
  return input.name || baseName(input.path) || input.path;
}

export function buildTreeNodes(
  cache: Readonly<Record<string, FilesTreeCacheEntry>>,
  key: string,
  sep: '/' | '\\',
): TreeNode<FileTreeItemData>[] {
  const entry = cache[key];
  if (!entry) return [];
  return entry.entries.map((item: FilesPanelEntry): TreeNode<FileTreeItemData> => {
    const abs = joinPath(entry.path, item.name, sep);
    const children = item.dir && cache[abs] ? buildTreeNodes(cache, abs, sep) : undefined;
    return {
      id: abs,
      label: item.name,
      icon: item.dir ? icon('folder') : icon('note'),
      hasChildren: item.dir,
      children,
      data: { path: abs, name: item.name, dir: item.dir },
    };
  });
}

export function isMarkdownFilename(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}
