// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeViewApi, EditorOptions } from '../../../codeview/app.js';
import type { TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import {
  FILE_EDITOR_KIND,
  FILES_PLUGIN_ID,
  FILES_TOOL_ID,
  createFilesPlugin,
} from './plugin.js';
import type { FeaturePanelInitContext, FeaturePanelRef } from './types.js';

function makeMemoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makePanelInitCtx(id: string): {
  ctx: FeaturePanelInitContext;
  setTitle: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const setTitle = vi.fn();
  const focus = vi.fn();
  const close = vi.fn();
  const api = {
    id,
    group: 'editor',
    params: undefined,
    onDidVisibilityChange: () => ({ dispose: () => undefined }),
    onDidDimensionsChange: () => ({ dispose: () => undefined }),
    setTitle,
    setBadge: vi.fn(),
    focus,
    close,
  } as unknown as FeaturePanelRef;
  return { ctx: { id, api }, setTitle, focus, close };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function makeHarness(activeTopic: TopicInfo | undefined) {
  const currentTopic = activeTopic;
  const openEditor = vi.fn();
  const registry = new ContributionRegistry({ openEditor });
  const events = new WebuiEventBus();
  const storage = new StorageService('', makeMemoryStorage());
  const api: ApiClient = {
    post: vi.fn(async () => jsonResponse({ ok: true })),
    get: vi.fn(async () => jsonResponse({ ok: true })),
    getJson: vi.fn(async () => ({}) as never),
    postJson: vi.fn(async () => ({}) as never),
  };
  const topics: PluginTopicsBridge = {
    list: () => (currentTopic ? [currentTopic] : []),
    active: () => currentTopic,
    open: vi.fn(),
    insertIntoComposer: vi.fn(),
  };
  const manager = new PluginManager({ registry, events, storage, api, topics });
  return { registry, events, manager, openEditor };
}

const TOPIC_WITH_DIR: TopicInfo = {
  id: 'topic-beta',
  title: 'Edit docs',
  lastAt: 1700000000000,
  dir: { name: 'demo-repo', path: '/workspace/demo-repo' },
};

const TOPIC_WITHOUT_DIR: TopicInfo = {
  id: 'topic-nodir',
  title: 'No dir',
  lastAt: 1700000000000,
};

describe('features/files plugin', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('disables topic tool and blocks editor requests when files.enabled is false (Security invariant 9)', async () => {
    const { registry, events, manager, openEditor } = makeHarness(TOPIC_WITH_DIR);
    const fetchFn = vi.fn(async () => jsonResponse({ ok: true }));

    manager.register(createFilesPlugin({ filesEnabled: false, fetchFn }), { builtin: true });
    await manager.activate(FILES_PLUGIN_ID);

    const tool = registry.getTopicTool(FILES_TOOL_ID);
    expect(tool).toBeDefined();
    expect(tool?.defaultPart).toBe('secondary');
    expect(tool?.icon).toContain('<svg');
    expect(tool?.available(TOPIC_WITH_DIR)).toBe(false);
    expect(registry.listAvailableTopicTools(TOPIC_WITH_DIR)).toEqual([]);

    await registry.executeCommand('files.openFile', { topicId: 'topic-beta', path: '/workspace/demo-repo/a.ts' });
    expect(openEditor).not.toHaveBeenCalled();

    const editorPanel = registry.getEditor(FILE_EDITOR_KIND)!.component();
    document.body.appendChild(editorPanel.element);
    editorPanel.init({ topicId: 'topic-beta', path: '/workspace/demo-repo/a.ts' }, makePanelInitCtx('file:a').ctx);
    await flushMicrotasks();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(editorPanel.element.textContent).toContain('not enabled');

    editorPanel.dispose();
    manager.deactivate(FILES_PLUGIN_ID);
    expect(registry.getTopicTool(FILES_TOOL_ID)).toBeUndefined();
    expect(registry.getEditor(FILE_EDITOR_KIND)).toBeUndefined();

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('renders file tree using components/tree, lazy-loads directories, previews files, and opens them in editor', async () => {
    const { registry, events, manager, openEditor } = makeHarness(TOPIC_WITH_DIR);
    const fetchFn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/files/list') && !url.includes('path=')) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo',
          entries: [
            { name: 'src', dir: true },
            { name: 'README.md', dir: false },
          ],
        });
      }
      if (url.includes('/api/files/list') && url.includes('src')) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo/src',
          entries: [{ name: 'index.ts', dir: false }],
        });
      }
      if (url.includes('/api/files/read')) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo/README.md',
          rel: 'README.md',
          name: 'README.md',
          kind: 'text',
          text: '# Demo\nHello world',
          mtimeMs: 1000,
          size: 18,
          sha256: 'abc123',
          eol: 'lf',
        });
      }
      return jsonResponse({ ok: false }, 404);
    });

    manager.register(createFilesPlugin({ filesEnabled: true, fetchFn }), { builtin: true });
    await manager.activate(FILES_PLUGIN_ID);

    const tool = registry.getTopicTool(FILES_TOOL_ID)!;
    expect(tool.available(TOPIC_WITH_DIR)).toBe(true);
    expect(tool.available(TOPIC_WITHOUT_DIR)).toBe(false);

    const panel = tool.component();
    document.body.appendChild(panel.element);
    panel.init(undefined, makePanelInitCtx('files').ctx);
    await flushMicrotasks();

    expect(panel.element.querySelector('[role="tree"]')).not.toBeNull();
    expect(panel.element.querySelectorAll('[role="treeitem"]').length).toBe(2);

    // Expand directory -> lazy loads children
    const srcRow = panel.element.querySelector<HTMLElement>('[data-tree-id="/workspace/demo-repo/src"]')!;
    srcRow.click();
    await flushMicrotasks();
    expect(panel.element.querySelector('[data-tree-id="/workspace/demo-repo/src/index.ts"]')).not.toBeNull();

    // Click file -> renders inline preview with Open in editor button
    const readmeRow = panel.element.querySelector<HTMLElement>('[data-tree-id="/workspace/demo-repo/README.md"]')!;
    readmeRow.click();
    await flushMicrotasks();
    expect(panel.element.querySelector('.fh-files-preview-code')?.textContent).toContain('# Demo');

    // Click Open in editor button -> calls ctx.editors.open('file', ...)
    const openBtn = panel.element.querySelector<HTMLButtonElement>('[data-files-preview-open="/workspace/demo-repo/README.md"]')!;
    openBtn.click();
    expect(openEditor).toHaveBeenCalledWith(
      'file',
      {
        topicId: 'topic-beta',
        root: '/workspace/demo-repo',
        path: '/workspace/demo-repo/README.md',
        rel: 'README.md',
        name: 'README.md',
      },
      undefined,
    );

    panel.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('saves via version check (mtimeMs/size/sha256) and requires explicit force confirmation on 409 conflict', async () => {
    const { registry, events, manager } = makeHarness(TOPIC_WITH_DIR);
    let editorDoc = '';
    const captured: { opts: EditorOptions | null } = { opts: null };
    const destroyEditor = vi.fn();
    const mockCodeView: CodeViewApi = {
      diff: vi.fn(),
      highlighter: vi.fn(async () => null),
      editor: vi.fn((_parent, opts) => {
        captured.opts = opts;
        editorDoc = opts.doc;
        return {
          getDoc: () => editorDoc,
          setDoc: (v: string) => {
            editorDoc = v;
          },
          focus: vi.fn(),
          destroy: destroyEditor,
        };
      }),
    };

    const writeBodies: Array<Record<string, unknown>> = [];
    let writeCalls = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/files/read')) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo/notes.txt',
          rel: 'notes.txt',
          name: 'notes.txt',
          kind: 'text',
          text: 'hello\r\nworld',
          mtimeMs: 5000,
          size: 12,
          sha256: 'deadbeef',
          eol: 'crlf',
        });
      }
      if (url.includes('/api/files/write')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        writeBodies.push(body);
        writeCalls += 1;
        if (writeCalls === 1) {
          return jsonResponse({ ok: false, conflict: true, exists: true }, 409);
        }
        return jsonResponse({ ok: true, mtimeMs: 6000, size: 14, sha256: 'cafebabe' }, 200);
      }
      return jsonResponse({ ok: false }, 404);
    });

    manager.register(
      createFilesPlugin({ filesEnabled: true, fetchFn, codeView: async () => mockCodeView }),
      { builtin: true },
    );
    await manager.activate(FILES_PLUGIN_ID);

    const editorPanel = registry.getEditor(FILE_EDITOR_KIND)!.component();
    document.body.appendChild(editorPanel.element);
    const { ctx: initCtx, setTitle } = makePanelInitCtx('file:notes.txt');
    editorPanel.init({ topicId: 'topic-beta', path: '/workspace/demo-repo/notes.txt' }, initCtx);
    await flushMicrotasks();

    expect(captured.opts?.doc).toBe('hello\nworld');
    expect(setTitle).toHaveBeenCalledWith('notes.txt');

    // Edit document -> marks dirty
    editorDoc = 'hello\nupdated';
    captured.opts?.onChange?.(editorDoc);
    expect(setTitle).toHaveBeenCalledWith('● notes.txt');
    expect(editorPanel.element.querySelector('[data-file-dirty-dot]')).not.toBeNull();

    // First save sends version check fields (mtimeMs, size, sha256) and restores CRLF, no force
    editorPanel.element.querySelector<HTMLButtonElement>('[data-action-id="save"]')!.click();
    await flushMicrotasks();

    expect(writeBodies).toHaveLength(1);
    expect(writeBodies[0]).toEqual({
      topic: 'topic-beta',
      path: '/workspace/demo-repo/notes.txt',
      text: 'hello\r\nupdated',
      mtimeMs: 5000,
      size: 12,
      sha256: 'deadbeef',
    });
    expect(writeBodies[0]?.force).toBeUndefined();

    // 409 conflict displays banner with Overwrite button; clicking opens confirm dialog
    const overwriteBtn = editorPanel.element.querySelector<HTMLButtonElement>('[data-conflict-overwrite]')!;
    expect(overwriteBtn).not.toBeNull();
    overwriteBtn.click();
    await flushMicrotasks();

    // Confirm overwrite in dialog -> sends explicit force: true
    const confirmBtn = document.body.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]')!;
    expect(confirmBtn).not.toBeNull();
    confirmBtn.click();
    await flushMicrotasks();

    expect(writeBodies).toHaveLength(2);
    expect(writeBodies[1]).toEqual({
      topic: 'topic-beta',
      path: '/workspace/demo-repo/notes.txt',
      text: 'hello\r\nupdated',
      force: true,
    });
    expect(editorPanel.element.querySelector('[data-conflict-overwrite]')).toBeNull();
    expect(setTitle).toHaveBeenLastCalledWith('notes.txt');
    expect(editorPanel.element.querySelector('[data-file-dirty-dot]')).toBeNull();

    editorPanel.dispose();
    expect(destroyEditor).toHaveBeenCalledTimes(1);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('manages independent multi-file tabs with deduplication, dirty dot marks, and close confirmation', async () => {
    const { registry, events, manager, openEditor } = makeHarness(TOPIC_WITH_DIR);
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/files/read') && url.includes('a.ts')) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo/src/a.ts',
          rel: 'src/a.ts',
          name: 'a.ts',
          kind: 'text',
          text: 'export const a = 1;',
          mtimeMs: 100,
          size: 19,
          sha256: 'hash-a',
          eol: 'lf',
        });
      }
      if (url.includes('/api/files/read') && url.includes('b.ts')) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo/src/b.ts',
          rel: 'src/b.ts',
          name: 'b.ts',
          kind: 'text',
          text: 'export const b = 2;',
          mtimeMs: 200,
          size: 19,
          sha256: 'hash-b',
          eol: 'lf',
        });
      }
      if (url.includes('/api/files/write')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ ok: true, mtimeMs: 300, size: String(body.text ?? '').length, sha256: 'hash-saved' });
      }
      return jsonResponse({ ok: false }, 404);
    });

    manager.register(createFilesPlugin({ filesEnabled: true, fetchFn }), { builtin: true });
    await manager.activate(FILES_PLUGIN_ID);

    // Open two distinct files
    await registry.executeCommand('files.openFile', {
      topicId: 'topic-beta',
      root: '/workspace/demo-repo',
      rel: 'src/a.ts',
      path: '/workspace/demo-repo/src/a.ts',
    });
    await registry.executeCommand('files.openFile', {
      topicId: 'topic-beta',
      root: '/workspace/demo-repo',
      rel: 'src/b.ts',
      path: '/workspace/demo-repo/src/b.ts',
    });
    expect(openEditor).toHaveBeenCalledTimes(2);

    // Mount both independent editor tabs
    const editorDef = registry.getEditor(FILE_EDITOR_KIND)!;
    const panelA = editorDef.component();
    const panelB = editorDef.component();
    document.body.append(panelA.element, panelB.element);
    const initA = makePanelInitCtx('editor:file:1');
    const initB = makePanelInitCtx('editor:file:2');
    panelA.init(
      { topicId: 'topic-beta', root: '/workspace/demo-repo', rel: 'src/a.ts', path: '/workspace/demo-repo/src/a.ts' },
      initA.ctx,
    );
    panelB.init(
      { topicId: 'topic-beta', root: '/workspace/demo-repo', rel: 'src/b.ts', path: '/workspace/demo-repo/src/b.ts' },
      initB.ctx,
    );
    await flushMicrotasks();

    // Re-opening file A with abs path reuses and focuses existing tab instead of opening a 3rd tab
    await registry.executeCommand('files.openFile', {
      topicId: 'topic-beta',
      path: '/workspace/demo-repo/src/a.ts',
    });
    expect(openEditor).toHaveBeenCalledTimes(2);
    expect(initA.focus).toHaveBeenCalledTimes(1);

    // Edit file A -> only A becomes dirty with dot marker
    const taA = panelA.element.querySelector<HTMLTextAreaElement>('textarea')!;
    taA.value = 'export const a = 42;';
    taA.dispatchEvent(new Event('input'));
    expect(initA.setTitle).toHaveBeenLastCalledWith('● a.ts');
    expect(panelA.element.querySelector('[data-file-dirty-dot]')).not.toBeNull();
    expect(panelB.element.querySelector('[data-file-dirty-dot]')).toBeNull();

    // Closing clean tab B closes immediately without dialog
    panelB.element.querySelector<HTMLButtonElement>('[data-action-id="close"]')!.click();
    await flushMicrotasks();
    expect(initB.close).toHaveBeenCalledTimes(1);

    // Closing dirty tab A prompts confirmation; Cancel keeps it open
    panelA.element.querySelector<HTMLButtonElement>('[data-action-id="close"]')!.click();
    await flushMicrotasks();
    const cancelBtn = document.body.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')!;
    expect(cancelBtn).not.toBeNull();
    cancelBtn.click();
    await flushMicrotasks();
    expect(initA.close).not.toHaveBeenCalled();

    // Closing dirty tab A and confirming closes it
    panelA.element.querySelector<HTMLButtonElement>('[data-action-id="close"]')!.click();
    await flushMicrotasks();
    const confirmBtn = document.body.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]')!;
    expect(confirmBtn).not.toBeNull();
    confirmBtn.click();
    await flushMicrotasks();
    expect(initA.close).toHaveBeenCalledTimes(1);

    panelA.dispose();
    panelB.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('shows 409 conflict banner, keeps local edits when overwrite is cancelled, and reloads disk version cleanly', async () => {
    const { registry, events, manager } = makeHarness(TOPIC_WITH_DIR);
    let diskText = 'v1';
    let writeAttempts = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/files/read')) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo/doc.md',
          rel: 'doc.md',
          name: 'doc.md',
          kind: 'text',
          text: diskText,
          mtimeMs: diskText === 'v1' ? 100 : 200,
          size: diskText.length,
          sha256: diskText === 'v1' ? 'h1' : 'h2',
          eol: 'lf',
        });
      }
      if (url.includes('/api/files/write')) {
        writeAttempts += 1;
        return jsonResponse({ ok: false, conflict: true, exists: true, mtimeMs: 200, size: 12 }, 409);
      }
      return jsonResponse({ ok: false }, 404);
    });

    manager.register(createFilesPlugin({ filesEnabled: true, fetchFn }), { builtin: true });
    await manager.activate(FILES_PLUGIN_ID);

    const editorPanel = registry.getEditor(FILE_EDITOR_KIND)!.component();
    document.body.appendChild(editorPanel.element);
    const init = makePanelInitCtx('editor:file:conflict');
    editorPanel.init({ topicId: 'topic-beta', path: '/workspace/demo-repo/doc.md' }, init.ctx);
    await flushMicrotasks();

    const ta = editorPanel.element.querySelector<HTMLTextAreaElement>('textarea')!;
    ta.value = 'local edit';
    ta.dispatchEvent(new Event('input'));

    // Save hits 409 -> conflict banner appears
    editorPanel.element.querySelector<HTMLButtonElement>('[data-action-id="save"]')!.click();
    await flushMicrotasks();
    expect(writeAttempts).toBe(1);
    const banner = editorPanel.element.querySelector('[data-file-conflict]');
    expect(banner).not.toBeNull();
    expect(banner?.querySelector('[role="alert"]')).not.toBeNull();

    // Clicking overwrite then cancelling dialog does NOT send a force write
    editorPanel.element.querySelector<HTMLButtonElement>('[data-conflict-overwrite]')!.click();
    await flushMicrotasks();
    document.body.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')!.click();
    await flushMicrotasks();
    expect(writeAttempts).toBe(1);
    expect(editorPanel.element.querySelector('[data-file-conflict]')).not.toBeNull();
    expect(ta.value).toBe('local edit');

    // Disk changed to v2 -> clicking Reload from disk loads v2 and clears conflict & dirty
    diskText = 'v2 from disk';
    editorPanel.element.querySelector<HTMLButtonElement>('[data-conflict-reload]')!.click();
    await flushMicrotasks();

    expect(editorPanel.element.querySelector('[data-file-conflict]')).toBeNull();
    expect(editorPanel.element.querySelector('[data-file-dirty-dot]')).toBeNull();
    expect(editorPanel.element.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('v2 from disk');
    expect(init.setTitle).toHaveBeenLastCalledWith('doc.md');

    editorPanel.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('reveals current file in tree by expanding ancestors, highlighting, and scrolling to the node', async () => {
    const { registry, events, manager } = makeHarness(TOPIC_WITH_DIR);
    const fetchFn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/files/list') && !url.includes('path=')) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo',
          entries: [{ name: 'src', dir: true }],
        });
      }
      if (url.includes('/api/files/list') && url.includes(encodeURIComponent('/workspace/demo-repo/src/nested'))) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo/src/nested',
          entries: [{ name: 'deep.ts', dir: false }],
        });
      }
      if (url.includes('/api/files/list') && url.includes(encodeURIComponent('/workspace/demo-repo/src'))) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo/src',
          entries: [{ name: 'nested', dir: true }],
        });
      }
      if (url.includes('/api/files/read')) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo/src/nested/deep.ts',
          rel: 'src/nested/deep.ts',
          name: 'deep.ts',
          kind: 'text',
          text: 'export const deep = true;',
          mtimeMs: 100,
          size: 25,
          sha256: 'deephash',
          eol: 'lf',
        });
      }
      return jsonResponse({ ok: false }, 404);
    });

    manager.register(createFilesPlugin({ filesEnabled: true, fetchFn }), { builtin: true });
    await manager.activate(FILES_PLUGIN_ID);

    const toolPanel = registry.getTopicTool(FILES_TOOL_ID)!.component();
    const editorPanel = registry.getEditor(FILE_EDITOR_KIND)!.component();
    document.body.append(toolPanel.element, editorPanel.element);
    toolPanel.init(undefined, makePanelInitCtx('tool:files').ctx);
    editorPanel.init(
      {
        topicId: 'topic-beta',
        root: '/workspace/demo-repo',
        rel: 'src/nested/deep.ts',
        path: '/workspace/demo-repo/src/nested/deep.ts',
      },
      makePanelInitCtx('editor:file:deep').ctx,
    );
    await flushMicrotasks();

    // Before reveal, nested file is not yet loaded/visible in tree
    expect(toolPanel.element.querySelector('[data-tree-id="/workspace/demo-repo/src/nested/deep.ts"]')).toBeNull();

    const scrollSpy = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollSpy;

    // Click Reveal in file tree button in editor header
    const revealBtn = editorPanel.element.querySelector<HTMLButtonElement>('[data-action-id="reveal-in-tree"]')!;
    expect(revealBtn).not.toBeNull();
    revealBtn.click();
    await flushMicrotasks();
    await flushMicrotasks();

    const srcNode = toolPanel.element.querySelector('[data-tree-id="/workspace/demo-repo/src"]');
    const nestedNode = toolPanel.element.querySelector('[data-tree-id="/workspace/demo-repo/src/nested"]');
    const deepNode = toolPanel.element.querySelector('[data-tree-id="/workspace/demo-repo/src/nested/deep.ts"]');

    expect(srcNode?.getAttribute('aria-expanded')).toBe('true');
    expect(nestedNode?.getAttribute('aria-expanded')).toBe('true');
    expect(deepNode).not.toBeNull();
    expect(deepNode?.getAttribute('aria-selected')).toBe('true');
    expect(deepNode?.classList.contains('is-revealed')).toBe(true);
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    toolPanel.dispose();
    editorPanel.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('preserves UTF-8 BOM + CRLF on save and displays mixed-EOL notice banner', async () => {
    const { registry, events, manager } = makeHarness(TOPIC_WITH_DIR);
    const writeBodies: Array<Record<string, unknown>> = [];
    let editorDoc = '';
    let onChange: ((d: string) => void) | undefined;
    const mockCodeView: CodeViewApi = {
      diff: vi.fn(),
      highlighter: vi.fn(async () => null),
      editor: vi.fn((_parent, opts) => {
        editorDoc = opts.doc;
        onChange = opts.onChange;
        return {
          getDoc: () => editorDoc,
          setDoc: (next: string) => {
            editorDoc = next;
          },
          focus: vi.fn(),
          destroy: vi.fn(),
        };
      }),
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/files/read')) {
        return jsonResponse({
          ok: true,
          path: '/workspace/demo-repo/bom.txt',
          rel: 'bom.txt',
          name: 'bom.txt',
          kind: 'text',
          text: '\uFEFFalpha\r\nbeta\ngamma',
          mtimeMs: 7000,
          size: 20,
          sha256: 'abc123',
          eol: 'crlf',
          eolWarning: 'mixed',
        });
      }
      if (url.includes('/api/files/write')) {
        writeBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse({ ok: true, mtimeMs: 7001, size: 22, sha256: 'def456' }, 200);
      }
      return jsonResponse({ ok: false }, 404);
    });

    manager.register(
      createFilesPlugin({ filesEnabled: true, fetchFn, codeView: async () => mockCodeView }),
      { builtin: true },
    );
    await manager.activate(FILES_PLUGIN_ID);

    const editorPanel = registry.getEditor(FILE_EDITOR_KIND)!.component();
    document.body.appendChild(editorPanel.element);
    editorPanel.init({ topicId: 'topic-beta', path: '/workspace/demo-repo/bom.txt' }, makePanelInitCtx('file:bom.txt').ctx);
    await flushMicrotasks();

    expect(editorDoc).toBe('\uFEFFalpha\nbeta\ngamma');
    expect(editorPanel.element.textContent).toContain('CRLF');

    editorDoc = '\uFEFFalpha\nbeta\ngamma2';
    onChange?.(editorDoc);
    editorPanel.element.querySelector<HTMLButtonElement>('[data-action-id="save"]')!.click();
    await flushMicrotasks();

    expect(writeBodies).toHaveLength(1);
    expect(writeBodies[0]?.text).toBe('\uFEFFalpha\r\nbeta\r\ngamma2');

    editorPanel.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
