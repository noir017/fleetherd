import type { GitMode, GitStatusFile } from '../../../../workbench.js';
import type { OpenEditorOptions, PluginContext } from '../../plugins/api.js';
import { createApiClient, type ApiClient } from '../../services/api.js';
import type {
  ChangesMode,
  ChangesPluginDeps,
  DiffCommentContext,
  DiffEditorInput,
  GitErrorPayload,
} from './types.js';

interface DiffOpenEditorOptions extends OpenEditorOptions {
  readonly id?: string;
}

export interface PatchLine {
  readonly text: string;
  readonly kind: 'add' | 'del' | 'hunk' | 'ctx';
}

export interface JsonResponse<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
}

export function resolveChangesApi(deps: ChangesPluginDeps): Pick<ApiClient, 'get' | 'post'> {
  if (deps.api) return deps.api;
  if (deps.fetchFn) return createApiClient({ fetchFn: deps.fetchFn });
  return createApiClient();
}

export function isFilesEnabled(deps: ChangesPluginDeps): boolean {
  if (typeof deps.filesEnabled === 'function') return Boolean(deps.filesEnabled());
  return deps.filesEnabled === true;
}

export async function fetchGitJson<T>(
  api: Pick<ApiClient, 'get'>,
  url: string,
): Promise<JsonResponse<T>> {
  const res = await api.get(url, { cache: 'no-store' });
  try {
    const data = (await res.json()) as T;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: res.status, data: null };
  }
}

export function isNoRepoError(payload: GitErrorPayload | null): boolean {
  return Boolean(payload && (payload.reason === 'not-git' || payload.reason === 'missing'));
}

export function isChangesMode(value: string | null): value is ChangesMode {
  return value === 'working' || value === 'branch' || value === 'committed' || value === 'commits';
}

export function baseQueryParam(mode: ChangesMode, base: string): string {
  return mode !== 'working' && mode !== 'commits' && base
    ? `&base=${encodeURIComponent(base)}`
    : '';
}

export function buildStatusUrl(topicId: string, mode: ChangesMode, base: string): string {
  return `/api/git/status?t=${encodeURIComponent(topicId)}&mode=${encodeURIComponent(mode)}${baseQueryParam(mode, base)}`;
}

export function buildBranchesUrl(topicId: string): string {
  return `/api/git/branches?t=${encodeURIComponent(topicId)}`;
}

export function buildLogUrl(topicId: string, skip: number): string {
  return `/api/git/log?t=${encodeURIComponent(topicId)}&skip=${skip}`;
}

export function buildCommitUrl(topicId: string, sha: string): string {
  return `/api/git/commit?t=${encodeURIComponent(topicId)}&sha=${encodeURIComponent(sha)}`;
}

export function buildDiffFileUrl(input: DiffEditorInput): string {
  if (input.source?.fileUrl) {
    return `${input.source.fileUrl}&path=${encodeURIComponent(input.path)}`;
  }
  const sha = input.sha || (input.ref && !isGitMode(input.ref) ? input.ref : '');
  if (sha) {
    return (
      `/api/git/commit-file?t=${encodeURIComponent(input.topicId)}` +
      `&sha=${encodeURIComponent(sha)}` +
      `&path=${encodeURIComponent(input.path)}`
    );
  }
  const mode: GitMode = input.mode ?? (isGitMode(input.ref) ? input.ref : 'working');
  const base = input.base ?? '';
  return (
    `/api/git/file?t=${encodeURIComponent(input.topicId)}` +
    `&mode=${encodeURIComponent(mode)}` +
    `${baseQueryParam(mode, base)}` +
    `&path=${encodeURIComponent(input.path)}`
  );
}

export function isGitMode(value: string | undefined): value is GitMode {
  return value === 'working' || value === 'branch' || value === 'committed';
}

export function gitStatusLetter(status: GitStatusFile['status']): string {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  return 'M';
}

export function gitStatusColorVar(status: GitStatusFile['status'], untracked?: boolean): string {
  if (status === 'deleted') return 'var(--fh-git-del)';
  if (status === 'added') return untracked ? 'var(--fh-git-new)' : 'var(--fh-git-add)';
  return 'var(--fh-git-mod)';
}

export function joinRepoPath(root: string, relPath: string): string {
  if (!root) return relPath;
  const sep = root.endsWith('/') || root.endsWith('\\') ? '' : '/';
  return `${root}${sep}${relPath}`;
}

export function pathBasename(filePath: string): string {
  const at = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return at < 0 ? filePath : filePath.slice(at + 1);
}

export function diffEditorTitle(input: unknown, fallbackTitle: string): string {
  if (!isDiffEditorInput(input)) return fallbackTitle;
  const base = pathBasename(input.path) || input.path;
  const refLabel = input.commitShort || (input.sha ? input.sha.slice(0, 7) : input.ref);
  return refLabel ? `${base} (${refLabel})` : `${base} (diff)`;
}

export function diffEditorPanelId(input: DiffEditorInput): string {
  let scope = 'working';
  if (input.source?.fileUrl) {
    scope = `source:${input.source.fileUrl}`;
  } else if (input.sha) {
    scope = `sha:${input.sha}`;
  } else if (input.mode === 'branch' || input.mode === 'committed') {
    scope = `${input.mode}:${input.base ?? ''}`;
  } else if (input.ref && !isGitMode(input.ref)) {
    scope = `ref:${input.ref}`;
  }
  return `diff:${encodeURIComponent(input.topicId)}:${encodeURIComponent(scope)}:${encodeURIComponent(input.path)}`;
}

export function openDiffEditor(ctx: PluginContext, input: unknown, opts?: OpenEditorOptions): void {
  if (isDiffEditorInput(input)) {
    const openOpts: DiffOpenEditorOptions = { ...opts, id: diffEditorPanelId(input) };
    ctx.editors.open('diff', input, openOpts);
    return;
  }
  ctx.editors.open('diff', input, opts);
}

export function isDiffEditorInput(value: unknown): value is DiffEditorInput {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.topicId === 'string' && obj.topicId.length > 0 && typeof obj.path === 'string' && obj.path.length > 0;
}

export function parsePatchLines(patch: string): PatchLine[] {
  const lines = String(patch || '').split('\n');
  return lines.map((text) => {
    if (text.startsWith('+') && !text.startsWith('+++')) return { text, kind: 'add' };
    if (text.startsWith('-') && !text.startsWith('---')) return { text, kind: 'del' };
    if (text.startsWith('@@')) return { text, kind: 'hunk' };
    return { text, kind: 'ctx' };
  });
}

export function buildDiffCommentBlock(ctx: DiffCommentContext, commentText: string): string {
  const { selection, sides, path, refTag } = ctx;
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  const doc = sides ? sides[selection.side === 'old' ? 'old' : 'new'] : null;
  const quoted = typeof doc === 'string' ? doc.split('\n').slice(from - 1, to).join('\n') : String(selection.text);
  let fence = '```';
  while (quoted.includes(fence)) fence += '`';
  const sideLabel = selection.side === 'old' ? 'old' : 'new';
  const refSuffix = refTag ? `, ${refTag}` : '';
  return (
    `${path}:L${from}${to !== from ? `-L${to}` : ''} (${sideLabel}${refSuffix})\n` +
    `${fence}\n` +
    `${quoted.replace(/\s+$/, '')}\n` +
    `${fence}\n` +
    `${commentText.trim()}`
  );
}

export function defaultFormatAgo(at: number): string {
  if (!at) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return `${Math.floor(diffHr / 24)}d`;
}
