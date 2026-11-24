import type { FilesPanelEntry, FilesPanelHit } from '../../../../adapter.js';
import { icon } from '../../../icons.js';
import { html, nothing, render } from '../../base/html.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  createTree,
  openConfirmDialog,
  renderActionBar,
  renderEmptyState,
  renderNotice,
  type TreeController,
  type TreeNode,
} from '../../components/index.js';
import { renderIcon } from '../../components/shared.js';
import type { PluginContext, TopicInfo } from '../../plugins/api.js';
import {
  baseName,
  buildTreeNodes,
  createFilesHttpClient,
  dirOf,
  fileErrorMessage,
  isFilesFeatureEnabled,
  isValidSegment,
  joinPath,
  resolveFilesApi,
  sepOf,
  toEditorDoc,
  type FilesHttpClient,
} from './helpers.js';
import type {
  FeaturePanelComponent,
  FeaturePanelInitContext,
  FilesPluginDeps,
  FilesTreeCacheEntry,
  FileTreeItemData,
  PartialFilesPanelFile,
} from './types.js';

interface FilesToolState {
  topicId: string;
  root: string;
  sep: '/' | '\\';
  currentDir: string;
  selectedPath: string;
  cache: Record<string, FilesTreeCacheEntry>;
  searchQuery: string;
  searchHits: readonly FilesPanelHit[] | null;
  searchTruncated: boolean;
  creating: { dir: boolean; name: string } | null;
  preview: { path: string; name: string; kind: string; snippet: string; dataUrl?: string } | null;
  notice: { text: string; tone: 'info' | 'ok' | 'warn' | 'err' } | null;
  loading: boolean;
  seq: number;
  previewSeq: number;
  disposed: boolean;
}

interface FilesToolContext {
  readonly ctx: PluginContext;
  readonly deps: FilesPluginDeps;
  readonly http: FilesHttpClient;
  readonly doc: Document;
  readonly state: FilesToolState;
  readonly tree: TreeController<FileTreeItemData>;
  readonly headerHost: HTMLElement;
  readonly noticeHost: HTMLElement;
  readonly hitsHost: HTMLElement;
  readonly treeEmptyHost: HTMLElement;
  readonly treeWrap: HTMLElement;
  readonly previewHost: HTMLElement;
  paintAll: () => void;
  refreshRoot: () => Promise<void>;
  loadDir: (dirPath: string) => Promise<void>;
  previewFile: (filePath: string) => Promise<void>;
  openInEditor: (filePath: string) => void;
  runSearch: () => Promise<void>;
  submitCreate: () => Promise<void>;
}

function paintToolHeader(tc: FilesToolContext): void {
  const { ctx, state, headerHost } = tc;
  render(
    html`<div class="fh-files-head-top">
        <span class="fh-files-root" title=${state.root}>${state.root ? baseName(state.root) || state.root : ctx.i18n.t('files.title')}</span>
        ${renderActionBar({
          compact: true,
          items: [
            {
              id: 'new-file',
              icon: icon('note'),
              title: ctx.i18n.t('files.newFile'),
              disabled: !state.root,
              onClick: () => {
                state.creating = { dir: false, name: '' };
                tc.paintAll();
              },
            },
            {
              id: 'new-dir',
              icon: icon('folder'),
              title: ctx.i18n.t('files.newFolder'),
              disabled: !state.root,
              onClick: () => {
                state.creating = { dir: true, name: '' };
                tc.paintAll();
              },
            },
            {
              id: 'refresh',
              icon: icon('refresh'),
              title: ctx.i18n.t('common.refresh'),
              disabled: !state.topicId || state.loading,
              onClick: () => void tc.refreshRoot(),
            },
          ],
        })}
      </div>
      <div class="fh-files-search">
        <input
          type="search"
          class="fh-input fh-files-search-input"
          placeholder=${ctx.i18n.t('files.searchPlaceholder')}
          .value=${state.searchQuery}
          @input=${(ev: Event) => {
            state.searchQuery = (ev.target as HTMLInputElement).value;
            if (!state.searchQuery.trim()) {
              state.searchHits = null;
              tc.paintAll();
            }
          }}
          @keydown=${(ev: KeyboardEvent) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              void tc.runSearch();
            }
          }}
        />
      </div>
      ${state.creating
        ? html`<div class="fh-files-create-row">
            <input
              type="text"
              class="fh-input fh-files-create-input"
              aria-label=${ctx.i18n.t('files.nameAria')}
              placeholder=${ctx.i18n.t('files.namePlaceholder')}
              .value=${state.creating.name}
              @input=${(ev: Event) => {
                if (state.creating) state.creating.name = (ev.target as HTMLInputElement).value;
              }}
              @keydown=${(ev: KeyboardEvent) => {
                if (ev.key === 'Enter') {
                  ev.preventDefault();
                  void tc.submitCreate();
                } else if (ev.key === 'Escape') {
                  state.creating = null;
                  tc.paintAll();
                }
              }}
            />
            <button type="button" class="fh-btn fh-btn--primary" data-files-create-go @click=${() => void tc.submitCreate()}>
              ${ctx.i18n.t('common.done')}
            </button>
            <button
              type="button"
              class="fh-btn fh-btn--ghost"
              @click=${() => {
                state.creating = null;
                tc.paintAll();
              }}
            >${ctx.i18n.t('common.cancel')}</button>
          </div>`
        : nothing}`,
    headerHost,
  );
}

function paintSearchHits(tc: FilesToolContext): void {
  const { ctx, state, hitsHost, treeWrap } = tc;
  if (!state.searchHits) {
    hitsHost.hidden = true;
    treeWrap.hidden = false;
    render(nothing, hitsHost);
    return;
  }
  hitsHost.hidden = false;
  treeWrap.hidden = true;
  const heading =
    state.searchHits.length === 0
      ? ctx.i18n.t('files.noMatches')
      : state.searchTruncated
        ? ctx.i18n.t('files.firstMatches', { count: state.searchHits.length })
        : ctx.i18n.t('files.matchesCount', { count: state.searchHits.length });
  render(
    html`<div class="fh-files-hits-head">${heading}</div>
      ${state.searchHits.map(
        (hit) => html`<button
          type="button"
          class="fh-files-hit-row"
          data-files-hit=${hit.path}
          @click=${() => {
            if (!hit.dir) tc.openInEditor(hit.path);
          }}
        >
          ${renderIcon(hit.dir ? icon('folder') : icon('note'), 'fh-icon')}
          <span>${hit.rel || hit.path}</span>
        </button>`,
      )}`,
    hitsHost,
  );
}

function paintPreview(tc: FilesToolContext): void {
  const { ctx, state, previewHost } = tc;
  if (!state.preview) {
    render(nothing, previewHost);
    return;
  }
  const p = state.preview;
  render(
    html`<div class="fh-files-preview-head">
        <span class="fh-files-preview-name" title=${p.path}>${p.name}</span>
        <button
          type="button"
          class="fh-btn fh-btn--primary"
          data-files-preview-open=${p.path}
          @click=${() => tc.openInEditor(p.path)}
        >${ctx.i18n.t('files.openInEditor')}</button>
      </div>
      ${p.kind === 'image' && p.dataUrl
        ? html`<img class="fh-files-preview-img" src=${p.dataUrl} alt=${p.name} />`
        : p.kind === 'text'
          ? html`<pre class="fh-files-preview-code">${p.snippet}</pre>`
          : renderEmptyState({ title: ctx.i18n.t('files.cannotShow') })}`,
    previewHost,
  );
}

function syncTree(tc: FilesToolContext): void {
  const { ctx, state, tree, treeEmptyHost, treeWrap } = tc;
  if (!isFilesFeatureEnabled(tc.deps)) {
    tree.setNodes([]);
    treeWrap.hidden = true;
    treeEmptyHost.hidden = false;
    render(renderEmptyState({ title: ctx.i18n.t('files.notEnabled') }), treeEmptyHost);
    return;
  }
  if (!state.topicId) {
    tree.setNodes([]);
    treeWrap.hidden = true;
    treeEmptyHost.hidden = false;
    render(renderEmptyState({ title: ctx.i18n.t('files.noActiveTopic') }), treeEmptyHost);
    return;
  }
  const nodes = buildTreeNodes(state.cache, '', state.sep);
  if (nodes.length === 0 && !state.loading) {
    tree.setNodes([]);
    treeWrap.hidden = true;
    treeEmptyHost.hidden = false;
    render(renderEmptyState({ title: ctx.i18n.t('files.emptyDir') }), treeEmptyHost);
    return;
  }
  render(nothing, treeEmptyHost);
  treeEmptyHost.hidden = true;
  treeWrap.hidden = Boolean(state.searchHits);
  tree.setNodes(nodes);
}

async function submitCreateEntry(tc: FilesToolContext): Promise<void> {
  const { ctx, deps, state, http, doc } = tc;
  const creating = state.creating;
  if (!creating || !state.root) return;
  const name = creating.name.trim();
  if (!isValidSegment(name)) {
    state.notice = { text: ctx.i18n.t('files.invalidSegment'), tone: 'err' };
    tc.paintAll();
    return;
  }
  const dir = state.currentDir || state.root;
  const abs = joinPath(dir, name, state.sep);
  const confirmed = await openConfirmDialog({
    title: creating.dir ? ctx.i18n.t('files.newFolder') : ctx.i18n.t('files.newFile'),
    body: ctx.i18n.t(creating.dir ? 'files.confirmCreateFolder' : 'files.confirmCreateFile', { path: name }),
    overlays: deps.overlays,
    doc,
  });
  if (!confirmed || state.disposed) return;

  try {
    const res = await http.post('create', { topic: state.topicId, path: abs, dir: creating.dir });
    if (state.disposed) return;
    if (!res.ok) {
      state.notice = { text: fileErrorMessage(ctx, res, res.body), tone: 'err' };
      tc.paintAll();
      return;
    }
    state.creating = null;
    await tc.loadDir(dir === state.root ? '' : dir);
    if (!creating.dir) tc.openInEditor(abs);
  } catch {
    if (state.disposed) return;
    state.notice = { text: ctx.i18n.t('common.reachDaemonError'), tone: 'err' };
    tc.paintAll();
  }
}

async function loadFilesDir(tc: FilesToolContext, dirPath: string): Promise<void> {
  const { state, deps, http, ctx } = tc;
  const topicId = state.topicId;
  if (!topicId || !isFilesFeatureEnabled(deps)) return;
  const mine = state.seq;
  try {
    const res = await http.get('list', { topic: topicId, path: dirPath });
    if (state.disposed || mine !== state.seq || state.topicId !== topicId) return;
    if (!res.ok) {
      state.notice = { text: fileErrorMessage(ctx, res, res.body), tone: 'err' };
      tc.paintAll();
      return;
    }
    const resolvedPath = typeof res.body.path === 'string' && res.body.path ? res.body.path : dirPath;
    if (dirPath === '') {
      state.root = resolvedPath;
      state.sep = sepOf(resolvedPath);
      state.currentDir = resolvedPath;
    }
    state.cache[dirPath] = {
      path: resolvedPath,
      entries: (res.body.entries as FilesPanelEntry[] | undefined) ?? [],
    };
    state.loading = false;
    state.notice = null;
    tc.paintAll();
  } catch {
    if (state.disposed || mine !== state.seq) return;
    state.loading = false;
    state.notice = { text: ctx.i18n.t('common.reachDaemonError'), tone: 'err' };
    tc.paintAll();
  }
}

async function loadFilePreview(tc: FilesToolContext, filePath: string): Promise<void> {
  const { state, deps, http, ctx } = tc;
  const topicId = state.topicId;
  if (!topicId || !isFilesFeatureEnabled(deps)) return;
  const mine = ++state.previewSeq;
  try {
    const res = await http.get('read', { topic: topicId, path: filePath });
    if (state.disposed || mine !== state.previewSeq) return;
    if (!res.ok) {
      state.notice = { text: fileErrorMessage(ctx, res, res.body), tone: 'err' };
      tc.paintAll();
      return;
    }
    const file = res.body as PartialFilesPanelFile;
    const snippet = toEditorDoc(file.text || '').split('\n').slice(0, 40).join('\n');
    state.preview = {
      path: file.path || filePath,
      name: file.name || baseName(filePath),
      kind: file.kind || '',
      snippet,
      dataUrl: file.dataUrl,
    };
    paintPreview(tc);
  } catch {
    if (state.disposed || mine !== state.previewSeq) return;
    state.notice = { text: ctx.i18n.t('common.reachDaemonError'), tone: 'err' };
    tc.paintAll();
  }
}

async function runFilesSearch(tc: FilesToolContext): Promise<void> {
  const { state, http, ctx } = tc;
  const q = state.searchQuery.trim();
  if (!q || !state.topicId) {
    state.searchHits = null;
    tc.paintAll();
    return;
  }
  try {
    const res = await http.get('search', { topic: state.topicId, q });
    if (state.disposed) return;
    if (!res.ok) {
      state.notice = { text: fileErrorMessage(ctx, res, res.body), tone: 'err' };
      tc.paintAll();
      return;
    }
    state.searchHits = (res.body.hits as FilesPanelHit[] | undefined) ?? [];
    state.searchTruncated = Boolean(res.body.truncated);
    tc.paintAll();
  } catch {
    if (state.disposed) return;
    state.notice = { text: ctx.i18n.t('common.reachDaemonError'), tone: 'err' };
    tc.paintAll();
  }
}

function bindFilesTopic(tc: FilesToolContext, topic: TopicInfo | undefined): void {
  const { state, deps } = tc;
  const nextId = topic?.dir?.path ? topic.id : '';
  if (nextId === state.topicId && state.topicId !== '') return;
  state.topicId = nextId;
  state.root = '';
  state.currentDir = '';
  state.selectedPath = '';
  state.cache = {};
  state.searchQuery = '';
  state.searchHits = null;
  state.creating = null;
  state.preview = null;
  state.notice = null;
  state.seq += 1;
  state.previewSeq += 1;
  if (!nextId || !isFilesFeatureEnabled(deps)) {
    state.loading = false;
    tc.paintAll();
    return;
  }
  void tc.refreshRoot();
}

function createFilesTreeController(
  ctx: PluginContext,
  doc: Document,
  state: FilesToolState,
  callbacks: {
    openInEditor: (filePath: string) => void;
    loadDir: (dirPath: string) => void;
    previewFile: (filePath: string) => void;
  },
): TreeController<FileTreeItemData> {
  return createTree<FileTreeItemData>(
    {
      nodes: [],
      ariaLabel: ctx.i18n.t('files.title'),
      chevronRightIcon: icon('chevronRight'),
      chevronDownIcon: icon('chevronDown'),
      renderNode: (node: TreeNode<FileTreeItemData>) => html`
        ${renderIcon(node.icon, 'fh-tree-icon')}
        <span class="fh-tree-label">${node.label}</span>
        ${node.data && !node.data.dir
          ? html`<button
              type="button"
              class="fh-btn fh-btn--ghost fh-btn--icon fh-files-open-btn"
              data-files-open-editor=${node.data.path}
              title=${ctx.i18n.t('files.openInEditor')}
              aria-label=${ctx.i18n.t('files.openInEditor')}
              @click=${(ev: MouseEvent) => {
                ev.stopPropagation();
                if (node.data) callbacks.openInEditor(node.data.path);
              }}
            >${renderIcon(icon('pencil'), 'fh-icon')}</button>`
          : nothing}
      `,
      onToggle: (node, expanded) => {
        if (!expanded || !node.data?.dir) return;
        state.currentDir = node.data.path;
        if (!state.cache[node.data.path]) callbacks.loadDir(node.data.path);
      },
      onActivate: (node) => {
        if (!node.data) return;
        if (node.data.dir) {
          state.currentDir = node.data.path;
          return;
        }
        state.selectedPath = node.data.path;
        state.currentDir = dirOf(node.data.path) || state.root;
        callbacks.previewFile(node.data.path);
      },
    },
    doc,
  );
}

export function createFilesToolPanel(
  ctx: PluginContext,
  deps: FilesPluginDeps,
): FeaturePanelComponent {
  const doc = deps.doc ?? document;
  const http = createFilesHttpClient(resolveFilesApi(deps));
  const store = new DisposableStore();

  const element = doc.createElement('div');
  element.className = 'fh-files-tool';
  const headerHost = doc.createElement('div');
  headerHost.className = 'fh-files-header';
  const noticeHost = doc.createElement('div');
  noticeHost.className = 'fh-files-notice';
  const hitsHost = doc.createElement('div');
  hitsHost.className = 'fh-files-hits';
  hitsHost.hidden = true;
  const treeEmptyHost = doc.createElement('div');
  treeEmptyHost.className = 'fh-files-tree-empty';
  const treeWrap = doc.createElement('div');
  treeWrap.className = 'fh-files-tree-wrap';
  const previewHost = doc.createElement('div');
  previewHost.className = 'fh-files-preview';
  element.append(headerHost, noticeHost, hitsHost, treeEmptyHost, treeWrap, previewHost);

  const state: FilesToolState = {
    topicId: '',
    root: '',
    sep: '/',
    currentDir: '',
    selectedPath: '',
    cache: {},
    searchQuery: '',
    searchHits: null,
    searchTruncated: false,
    creating: null,
    preview: null,
    notice: null,
    loading: false,
    seq: 0,
    previewSeq: 0,
    disposed: false,
  };

  const openInEditor = (filePath: string): void => {
    if (!state.topicId || !isFilesFeatureEnabled(deps)) return;
    ctx.editors.open('file', { topicId: state.topicId, path: filePath, name: baseName(filePath) });
  };

  const tree = store.add(
    createFilesTreeController(ctx, doc, state, {
      openInEditor,
      loadDir: (dirPath) => void loadFilesDir(tc, dirPath),
      previewFile: (filePath) => void loadFilePreview(tc, filePath),
    }),
  );
  treeWrap.appendChild(tree.el);

  const tc: FilesToolContext = {
    ctx,
    deps,
    http,
    doc,
    state,
    tree,
    headerHost,
    noticeHost,
    hitsHost,
    treeEmptyHost,
    treeWrap,
    previewHost,
    paintAll: () => {
      if (state.disposed) return;
      paintToolHeader(tc);
      render(
        state.notice ? renderNotice({ tone: state.notice.tone, message: state.notice.text }) : nothing,
        noticeHost,
      );
      paintSearchHits(tc);
      syncTree(tc);
      paintPreview(tc);
    },
    loadDir: (dirPath: string) => loadFilesDir(tc, dirPath),
    refreshRoot: async (): Promise<void> => {
      if (!state.topicId || !isFilesFeatureEnabled(deps)) return;
      state.seq += 1;
      state.cache = {};
      state.loading = true;
      state.notice = null;
      tc.paintAll();
      await loadFilesDir(tc, '');
    },
    previewFile: (filePath: string) => loadFilePreview(tc, filePath),
    openInEditor,
    runSearch: () => runFilesSearch(tc),
    submitCreate: () => submitCreateEntry(tc),
  };

  return {
    element,
    init(_params: unknown, _initCtx: FeaturePanelInitContext): void {
      store.add(
        ctx.events.on('topic.active', ({ topic }) => {
          bindFilesTopic(tc, topic);
        }),
      );
      bindFilesTopic(tc, ctx.topics.active());
    },
    focus(): void {
      element.focus?.();
    },
    dispose(): void {
      if (state.disposed) return;
      state.disposed = true;
      state.seq += 1;
      state.previewSeq += 1;
      store.dispose();
      render(nothing, headerHost);
      render(nothing, noticeHost);
      render(nothing, hitsHost);
      render(nothing, treeEmptyHost);
      render(nothing, previewHost);
      element.remove();
    },
  };
}
