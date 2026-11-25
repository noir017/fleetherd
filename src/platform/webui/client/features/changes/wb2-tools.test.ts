/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { ContributionRegistry, WebuiEventBus, type PluginTopicsBridge } from '../../plugins/registry.js';
import { PluginManager } from '../../plugins/host.js';
import type { TopicInfo } from '../../plugins/api.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService } from '../../services/storage.js';
import { createChangesPlugin, CHANGES_PLUGIN_ID, CHANGES_TOOL_ID } from './plugin.js';
import { createFilesPlugin, FILES_PLUGIN_ID, FILE_EDITOR_KIND } from '../files/plugin.js';
import { createTerminalPlugin, TERMINAL_PLUGIN_ID, TERMINAL_TOOL_ID } from '../terminal/plugin.js';
import { createReaderPlugin, READER_PLUGIN_ID, READER_EDITOR_KIND, READER_OPEN_IMAGE_COMMAND } from '../reader/plugin.js';
import { Emitter } from '../../base/event.js';
import type { FeaturePanelInitContext } from './types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeStorage(): StorageService {
  const data = new Map<string, string>();
  return new StorageService('', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  });
}

function makeManager(topic?: TopicInfo) {
  const openEditor = vi.fn();
  const insertIntoComposer = vi.fn();
  const registry = new ContributionRegistry({ openEditor });
  const events = new WebuiEventBus();
  const storage = makeStorage();
  const api: ApiClient = {
    post: vi.fn(async () => jsonResponse({ ok: true })),
    get: vi.fn(async () => jsonResponse({ ok: true })),
    getJson: vi.fn(async () => ({}) as never),
    postJson: vi.fn(async () => ({}) as never),
  };
  const topics: PluginTopicsBridge = {
    list: () => (topic ? [topic] : []),
    active: () => topic,
    open: vi.fn(),
    insertIntoComposer,
  };
  const manager = new PluginManager({ registry, events, storage, api, topics });
  return { registry, events, manager, openEditor, insertIntoComposer };
}

function makePanelInitCtx(id: string): FeaturePanelInitContext {
  const vis = new Emitter<boolean>();
  const dim = new Emitter<{ readonly width: number; readonly height: number }>();
  return {
    id,
    api: {
      id,
      group: 'main',
      params: undefined,
      onDidVisibilityChange: vis.event,
      onDidDimensionsChange: dim.event,
      setTitle: vi.fn(),
      setBadge: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('wb2-tools mockup alignment checks', () => {
  it('changes tool auto-previews first file inline without switching editor, renders summary & mobile diff nav', async () => {
    const topic: TopicInfo = { id: 't1', title: 'Demo', lastAt: 1700000000000, dir: { name: 'repo', path: '/repo' } };
    const { registry, events, manager, openEditor } = makeManager(topic);

    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api/git/branches')) return jsonResponse({ ok: true, branches: ['main'], base: 'main' });
      if (url.includes('api/git/status')) {
        return jsonResponse({
          ok: true,
          repo: { branch: 'main', root: '/repo' },
          files: [
            { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 3 },
            { path: 'src/b.ts', status: 'added', additions: 7, deletions: 0 },
          ],
        });
      }
      if (url.includes('api/git/file')) {
        return jsonResponse({
          ok: true,
          path: 'src/a.ts',
          original: 'a\nold',
          modified: 'a\nnew',
          patch: '@@ -1,2 +1,2 @@\n a\n-old\n+new',
        });
      }
      return jsonResponse({ ok: false }, 404);
    });

    manager.register(createChangesPlugin({ fetchFn }), { builtin: true });
    await manager.activate(CHANGES_PLUGIN_ID);

    const panel = registry.getTopicTool(CHANGES_TOOL_ID)!.component();
    document.body.appendChild(panel.element);
    panel.init(undefined, makePanelInitCtx('tool:changes'));
    await flushMicrotasks();

    // Auto-selects first file inline without opening a separate editor tab.
    expect(openEditor).not.toHaveBeenCalled();
    expect(panel.element.querySelector('.fh-changes-summary')?.textContent).toContain('2');
    expect(panel.element.querySelector('.fh-changes-file.is-selected')).not.toBeNull();
    expect(panel.element.querySelector('.fh-changes-preview-bar')).not.toBeNull();

    // Clicking file row enters mobile diff drill-in without hijacking desktop editor.
    panel.element.querySelector<HTMLButtonElement>('.fh-changes-file-main')!.click();
    await flushMicrotasks();
    expect(openEditor).not.toHaveBeenCalled();
    expect(panel.element.classList.contains('is-mobile-diff')).toBe(true);
    expect(panel.element.querySelector('[data-changes-next-file]')).not.toBeNull();

    panel.element.querySelector<HTMLButtonElement>('[data-changes-mobile-back]')!.click();
    expect(panel.element.classList.contains('is-mobile-diff')).toBe(false);

    panel.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('file editor renders Source/Preview segmented control for Markdown and footer with revert action', async () => {
    const { registry, events, manager } = makeManager();

    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('preview=1')) return jsonResponse({ ok: true, html: '<h1>Doc</h1>' });
      if (url.includes('api/files/read')) {
        return jsonResponse({
          ok: true,
          path: '/repo/README.md',
          rel: 'README.md',
          name: 'README.md',
          kind: 'text',
          text: '# Doc\n',
          mtimeMs: 100,
          size: 6,
          eol: 'lf',
          sha256: 'abc',
        });
      }
      return jsonResponse({ ok: false }, 404);
    });

    manager.register(createFilesPlugin({ filesEnabled: true, fetchFn }), { builtin: true });
    await manager.activate(FILES_PLUGIN_ID);

    const editor = registry.getEditor(FILE_EDITOR_KIND)!.component();
    document.body.appendChild(editor.element);
    editor.init({ topicId: 't1', path: '/repo/README.md', name: 'README.md' }, makePanelInitCtx('ed:file'));
    await flushMicrotasks();

    expect(editor.element.querySelector('.fh-file-mode-seg')).not.toBeNull();
    expect(editor.element.querySelector('.fh-file-editor-foot-meta')?.textContent).toContain('LF');

    const ta = editor.element.querySelector<HTMLTextAreaElement>('.fh-file-textarea')!;
    ta.value = '# Changed\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editor.element.querySelector('[data-file-dirty-dot]')).not.toBeNull();

    const revertBtn = editor.element.querySelector<HTMLButtonElement>('[data-file-revert]')!;
    expect(revertBtn).not.toBeNull();
    revertBtn.click();
    expect(ta.value).toBe('# Doc\n');
    expect(editor.element.querySelector('[data-file-dirty-dot]')).toBeNull();

    editor.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('terminal places + next to tabs, uses trash for end session, and renders mobile key toolbar with Ctrl latch', async () => {
    const topic: TopicInfo = { id: 't1', title: 'Demo', lastAt: 1700000000000 };
    const { registry, events, manager } = makeManager(topic);

    manager.register(
      createTerminalPlugin({ boot: { terminal: true, terminalEnd: true } }),
      { builtin: true },
    );
    await manager.activate(TERMINAL_PLUGIN_ID);

    const panel = registry.getTopicTool(TERMINAL_TOOL_ID)!.component();
    document.body.appendChild(panel.element);
    panel.init({ topicId: 't1' }, makePanelInitCtx('tool:terminal'));

    const tabsWrap = panel.element.querySelector('.wb-term-tabs-wrap')!;
    expect(tabsWrap.querySelector('.wb-term-new')).not.toBeNull();
    expect(panel.element.querySelector('.wb-term-end .ic-trash')).not.toBeNull();

    const ctrlKey = panel.element.querySelector<HTMLButtonElement>('.wb-term-key[data-term-key="Control"]')!;
    expect(ctrlKey).not.toBeNull();
    ctrlKey.click();
    expect(ctrlKey.classList.contains('is-active')).toBe(true);
    panel.element.querySelector<HTMLButtonElement>('.wb-term-key[data-term-key="Escape"]')!.click();
    expect(ctrlKey.classList.contains('is-active')).toBe(false);

    panel.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('reader renders file icon in header and lightbox renders close button', async () => {
    const { registry, events, manager } = makeManager();
    const overlayHost = document.createElement('div');
    document.body.appendChild(overlayHost);

    manager.register(createReaderPlugin({ overlayHost }), { builtin: true });
    await manager.activate(READER_PLUGIN_ID);

    const comp = registry.getEditor(READER_EDITOR_KIND)!.component();
    expect(comp.element.querySelector('.wb-reader-icon .ic-note')).not.toBeNull();
    comp.dispose();

    await registry.commands.execute(READER_OPEN_IMAGE_COMMAND, { src: 'https://example.test/a.png', alt: 'a' });
    const closeBtn = overlayHost.querySelector<HTMLButtonElement>('.wb-lightbox-close');
    expect(closeBtn).not.toBeNull();
    closeBtn!.click();
    expect(overlayHost.querySelector<HTMLElement>('.wb-lightbox')?.hidden).toBe(true);

    manager.dispose();
    overlayHost.remove();
    events.dispose();
    registry.dispose();
  });
});
