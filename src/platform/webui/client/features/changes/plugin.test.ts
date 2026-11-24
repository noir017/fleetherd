// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeViewApi, DiffOptions, DiffSelection } from '../../../codeview/app.js';
import type { TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import {
  CHANGES_PLUGIN_ID,
  CHANGES_TOOL_ID,
  DIFF_EDITOR_KIND,
  createChangesPlugin,
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
    group: 'secondary',
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
  let currentTopic = activeTopic;
  const openEditor = vi.fn();
  const insertIntoComposer = vi.fn();
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
    insertIntoComposer,
  };
  const manager = new PluginManager({ registry, events, storage, api, topics });
  const setActive = (next: TopicInfo | undefined): void => {
    currentTopic = next;
    events.emit('topic.active', { id: next?.id, topic: next });
  };
  return { registry, events, manager, openEditor, insertIntoComposer, setActive };
}

const TOPIC_WITH_DIR: TopicInfo = {
  id: 'topic-alpha',
  title: 'Refactor client',
  lastAt: 1700000000000,
  dir: { name: 'demo-repo', path: '/workspace/demo-repo' },
};

const TOPIC_WITHOUT_DIR: TopicInfo = {
  id: 'topic-coord',
  title: 'Coordination',
  lastAt: 1700000000000,
};

describe('features/changes plugin', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('registers topic tool and diff editor with available(topic) gating and cleans up on dispose', async () => {
    const { registry, events, manager } = makeHarness(TOPIC_WITH_DIR);
    manager.register(createChangesPlugin(), { builtin: true });
    await manager.activate(CHANGES_PLUGIN_ID);

    const tool = registry.getTopicTool(CHANGES_TOOL_ID);
    expect(tool).toBeDefined();
    expect(tool?.defaultPart).toBe('secondary');
    expect(tool?.icon).toContain('<svg');
    expect(tool?.available(TOPIC_WITH_DIR)).toBe(true);
    expect(tool?.available(TOPIC_WITHOUT_DIR)).toBe(false);
    expect(registry.listAvailableTopicTools(TOPIC_WITH_DIR).map((t) => t.id)).toEqual([CHANGES_TOOL_ID]);
    expect(registry.listAvailableTopicTools(TOPIC_WITHOUT_DIR)).toEqual([]);

    const editor = registry.getEditor(DIFF_EDITOR_KIND);
    expect(editor).toBeDefined();
    expect(editor?.title({ topicId: 'topic-alpha', path: 'src/app.ts', ref: 'working' })).toBe('app.ts (working)');
    expect(editor?.title({ topicId: 'topic-alpha', path: 'src/app.ts', sha: 'abcdef123456' })).toBe('app.ts (abcdef1)');

    manager.deactivate(CHANGES_PLUGIN_ID);
    expect(registry.getTopicTool(CHANGES_TOOL_ID)).toBeUndefined();
    expect(registry.getEditor(DIFF_EDITOR_KIND)).toBeUndefined();
    expect(registry.commands.has('changes.openDiff')).toBe(false);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('lists changed files with git status colors, switches to commits, opens diff editor, and sends comments straight to composer', async () => {
    const { registry, events, manager, openEditor, insertIntoComposer, setActive } = makeHarness(TOPIC_WITH_DIR);
    const captured: { diffOpts: DiffOptions | null } = { diffOpts: null };
    const destroyDiff = vi.fn();
    const setLayout = vi.fn();
    const mockCodeView: CodeViewApi = {
      editor: vi.fn(),
      highlighter: vi.fn(async () => null),
      diff: vi.fn((_parent, opts) => {
        captured.diffOpts = opts;
        return { setLayout, destroy: destroyDiff };
      }),
    };

    const fetchFn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('/api/git/branches')) {
        return jsonResponse({ ok: true, branches: ['main', 'develop'], base: 'main' });
      }
      if (url.startsWith('/api/git/status')) {
        return jsonResponse({
          ok: true,
          repo: { root: '/workspace/demo-repo', branch: 'feat/demo', base: 'main' },
          files: [
            { path: 'src/app.ts', status: 'modified', additions: 5, deletions: 2 },
            { path: 'src/new.ts', status: 'added', additions: 10, deletions: 0 },
            { path: 'src/old.ts', status: 'deleted', additions: 0, deletions: 4 },
          ],
        });
      }
      if (url.startsWith('/api/git/file')) {
        return jsonResponse({
          ok: true,
          path: 'src/app.ts',
          original: 'line1\nold line\nline3',
          modified: 'line1\nnew line\nline3',
          patch: '@@ -1,3 +1,3 @@\n line1\n-old line\n+new line\n line3',
        });
      }
      if (url.startsWith('/api/git/log')) {
        return jsonResponse({
          ok: true,
          commits: [{ sha: '1234567890abcdef', short: '1234567', subject: 'Initial commit', author: 'Alex', at: Date.now() - 60000, parents: 0 }],
          more: false,
        });
      }
      if (url.startsWith('/api/git/commit?')) {
        return jsonResponse({
          ok: true,
          commit: { sha: '1234567890abcdef', short: '1234567', subject: 'Initial commit', author: 'Alex', at: Date.now() - 60000, parents: 0 },
          files: [{ path: 'README.md', status: 'added', additions: 3, deletions: 0 }],
        });
      }
      return jsonResponse({ ok: false }, 404);
    });

    manager.register(
      createChangesPlugin({ fetchFn, codeView: async () => mockCodeView, filesEnabled: false }),
      { builtin: true },
    );
    await manager.activate(CHANGES_PLUGIN_ID);

    const tool = registry.getTopicTool(CHANGES_TOOL_ID)!;
    const panel = tool.component();
    document.body.appendChild(panel.element);
    panel.init(undefined, makePanelInitCtx('changes').ctx);
    await flushMicrotasks();

    const rows = panel.element.querySelectorAll<HTMLElement>('.fh-changes-file');
    expect(rows.length).toBe(3);
    expect(rows[0]?.querySelector('.fh-changes-badge')?.getAttribute('style')).toContain('--fh-git-mod');
    expect(rows[1]?.querySelector('.fh-changes-badge')?.getAttribute('style')).toContain('--fh-git-add');
    expect(rows[2]?.querySelector('.fh-changes-badge')?.getAttribute('style')).toContain('--fh-git-del');
    // filesEnabled=false so edit file button must not be rendered.
    expect(panel.element.querySelector('[data-open-file-editor]')).toBeNull();

    // Open in diff editor button calls ctx.editors.open('diff', ...)
    const openBtn = panel.element.querySelector<HTMLButtonElement>('[data-open-diff-editor="src/app.ts"]')!;
    openBtn.click();
    expect(openEditor).toHaveBeenCalledWith(
      'diff',
      expect.objectContaining({ topicId: 'topic-alpha', path: 'src/app.ts', ref: 'working', mode: 'working' }),
      expect.objectContaining({ id: 'diff:topic-alpha:working:src%2Fapp.ts' }),
    );

    // Click file row to preview inline diff, select lines, and submit comment directly to composer
    rows[0]!.querySelector<HTMLButtonElement>('.fh-changes-file-main')!.click();
    await flushMicrotasks();
    expect(captured.diffOpts).not.toBeNull();

    const selection: DiffSelection = { side: 'new', from: 2, to: 2, text: 'new line' };
    captured.diffOpts?.onSelect?.(selection);

    panel.element.querySelector<HTMLButtonElement>('[data-diff-comment-open]')!.click();
    const ta = panel.element.querySelector<HTMLTextAreaElement>('.fh-diff-comment-input')!;
    ta.value = 'Please rename this variable.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    panel.element.querySelector<HTMLButtonElement>('[data-diff-comment-submit]')!.click();

    expect(insertIntoComposer).toHaveBeenCalledTimes(1);
    expect(insertIntoComposer).toHaveBeenCalledWith(
      'topic-alpha',
      expect.stringContaining('src/app.ts:L2 (new)\n```\nnew line\n```\nPlease rename this variable.'),
    );

    // Switch to Commits mode and open a commit
    const commitsBtn = panel.element.querySelector<HTMLButtonElement>('[data-seg-value="commits"]')!;
    commitsBtn.click();
    await flushMicrotasks();
    const commitRow = panel.element.querySelector<HTMLButtonElement>('[data-commit-sha="1234567890abcdef"]')!;
    expect(commitRow).not.toBeNull();
    commitRow.click();
    await flushMicrotasks();
    expect(panel.element.querySelector('[data-changes-path="README.md"]')).not.toBeNull();

    // Switching active topic clears previous state and reloads for new topic
    setActive(TOPIC_WITHOUT_DIR);
    expect(panel.element.querySelectorAll('.fh-changes-file').length).toBe(0);

    panel.dispose();
    expect(destroyDiff).toHaveBeenCalled();

    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('opens standalone diff editor, toggles split/unified layout, and inserts comments into the target topic', async () => {
    const { registry, events, manager, insertIntoComposer } = makeHarness(TOPIC_WITH_DIR);
    const captured: { diffOpts: DiffOptions | null } = { diffOpts: null };
    const setLayout = vi.fn();
    const destroy = vi.fn();
    const mockCodeView: CodeViewApi = {
      editor: vi.fn(),
      highlighter: vi.fn(async () => null),
      diff: vi.fn((_parent, opts) => {
        captured.diffOpts = opts;
        return { setLayout, destroy };
      }),
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/api/git/commit-file');
      expect(url).toContain('sha=abc1234');
      return jsonResponse({
        ok: true,
        path: 'src/util.ts',
        original: 'a\nb',
        modified: 'a\nc',
      });
    });

    manager.register(
      createChangesPlugin({ fetchFn, codeView: async () => mockCodeView, narrow: () => false }),
      { builtin: true },
    );
    await manager.activate(CHANGES_PLUGIN_ID);

    const editorDef = registry.getEditor(DIFF_EDITOR_KIND)!;
    const editorPanel = editorDef.component();
    document.body.appendChild(editorPanel.element);
    const { ctx: initCtx, setTitle } = makePanelInitCtx('diff:src/util.ts');
    editorPanel.init({ topicId: 'topic-alpha', path: 'src/util.ts', ref: 'abc1234', sha: 'abc1234' }, initCtx);
    await flushMicrotasks();

    expect(setTitle).toHaveBeenCalledWith('util.ts (abc1234)');
    expect(captured.diffOpts?.layout).toBe('split');

    editorPanel.element.querySelector<HTMLButtonElement>('[data-action-id="layout"]')!.click();
    expect(setLayout).toHaveBeenCalledWith('unified');

    captured.diffOpts?.onSelect?.({ side: 'new', from: 2, to: 2, text: 'c' });
    editorPanel.element.querySelector<HTMLButtonElement>('[data-diff-comment-open]')!.click();
    const ta = editorPanel.element.querySelector<HTMLTextAreaElement>('.fh-diff-comment-input')!;
    ta.value = 'Check edge case';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    editorPanel.element.querySelector<HTMLButtonElement>('[data-diff-comment-submit]')!.click();

    expect(insertIntoComposer).toHaveBeenCalledWith(
      'topic-alpha',
      expect.stringContaining('src/util.ts:L2 (new, abc1234)'),
    );

    editorPanel.dispose();
    expect(destroy).toHaveBeenCalledTimes(1);

    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
