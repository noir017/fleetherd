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

function makePanelInitCtx(id: string): { ctx: FeaturePanelInitContext; setTitle: ReturnType<typeof vi.fn> } {
  const setTitle = vi.fn();
  const api = {
    id,
    group: 'editor',
    params: undefined,
    onDidVisibilityChange: () => ({ dispose: () => undefined }),
    onDidDimensionsChange: () => ({ dispose: () => undefined }),
    setTitle,
    setBadge: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  } as unknown as FeaturePanelRef;
  return { ctx: { id, api }, setTitle };
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
      { topicId: 'topic-beta', path: '/workspace/demo-repo/README.md', name: 'README.md' },
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
    expect(setTitle).toHaveBeenCalledWith('notes.txt *');

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

    editorPanel.dispose();
    expect(destroyEditor).toHaveBeenCalledTimes(1);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
