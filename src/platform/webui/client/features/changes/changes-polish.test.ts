// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeViewApi, DiffOptions } from '../../../codeview/app.js';
import type { TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import { CommentDraftStore, formatMergedDiffComments } from './comment-queue.js';
import { diffEditorPanelId } from './diff-helpers.js';
import { computeTextHunks, extractPatchHunks, resolveNextHunkIndex } from './hunk-nav.js';
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
    group: 'main',
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

function makeHarness(activeTopic: TopicInfo) {
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
    list: () => [activeTopic],
    active: () => activeTopic,
    open: vi.fn(),
    insertIntoComposer,
  };
  const manager = new PluginManager({ registry, events, storage, api, topics });
  return { registry, events, manager, openEditor, insertIntoComposer };
}

const TOPIC: TopicInfo = {
  id: 'topic-1',
  title: 'Polish changes',
  lastAt: 1700000000000,
  dir: { name: 'repo', path: '/workspace/repo' },
};

const MULTI_HUNK_PATCH = [
  '@@ -1,3 +1,3 @@',
  ' a',
  '-old1',
  '+new1',
  ' b',
  '@@ -10,3 +10,3 @@',
  ' c',
  '-old2',
  '+new2',
  ' d',
  '@@ -20,3 +20,3 @@',
  ' e',
  '-old3',
  '+new3',
  ' f',
].join('\n');

describe('features/changes P3-3 polish', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('derives stable per-file panel IDs and reuses existing diff tabs without reloading', async () => {
    const idA = diffEditorPanelId({ topicId: 'topic-1', path: 'src/a.ts', mode: 'working', ref: 'working' });
    const idADefault = diffEditorPanelId({ topicId: 'topic-1', path: 'src/a.ts' });
    const idB = diffEditorPanelId({ topicId: 'topic-1', path: 'src/b.ts', mode: 'working' });
    const idCommit = diffEditorPanelId({ topicId: 'topic-1', path: 'src/a.ts', sha: 'deadbeef' });

    expect(idA).toBe(idADefault);
    expect(idA).not.toBe(idB);
    expect(idA).not.toBe(idCommit);

    const { registry, events, manager, openEditor } = makeHarness(TOPIC);
    let fileFetchCount = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('/api/git/branches')) return jsonResponse({ ok: true, branches: ['main'], base: 'main' });
      if (url.startsWith('/api/git/status')) {
        return jsonResponse({
          ok: true,
          repo: { root: '/workspace/repo', branch: 'feat/p3' },
          files: [
            { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
            { path: 'src/b.ts', status: 'added', additions: 2, deletions: 0 },
          ],
        });
      }
      if (url.startsWith('/api/git/file')) {
        fileFetchCount += 1;
        return jsonResponse({ ok: true, path: 'src/a.ts', original: 'a\nold', modified: 'a\nnew', patch: MULTI_HUNK_PATCH });
      }
      return jsonResponse({ ok: false }, 404);
    });

    manager.register(createChangesPlugin({ fetchFn }), { builtin: true });
    await manager.activate(CHANGES_PLUGIN_ID);

    const toolPanel = registry.getTopicTool(CHANGES_TOOL_ID)!.component();
    document.body.appendChild(toolPanel.element);
    toolPanel.init(undefined, makePanelInitCtx('tool:changes').ctx);
    await flushMicrotasks();

    const openBtns = toolPanel.element.querySelectorAll<HTMLButtonElement>('[data-open-diff-editor]');
    openBtns[0]!.click();
    openBtns[1]!.click();
    openBtns[0]!.click();

    expect(openEditor).toHaveBeenNthCalledWith(
      1,
      DIFF_EDITOR_KIND,
      expect.objectContaining({ topicId: 'topic-1', path: 'src/a.ts' }),
      expect.objectContaining({ id: idA }),
    );
    expect(openEditor).toHaveBeenNthCalledWith(
      2,
      DIFF_EDITOR_KIND,
      expect.objectContaining({ topicId: 'topic-1', path: 'src/b.ts' }),
      expect.objectContaining({ id: idB }),
    );
    expect(openEditor).toHaveBeenNthCalledWith(
      3,
      DIFF_EDITOR_KIND,
      expect.objectContaining({ topicId: 'topic-1', path: 'src/a.ts' }),
      expect.objectContaining({ id: idA }),
    );

    // Calling update() with the same diff input reuses loaded state without re-fetching.
    const editorPanel = registry.getEditor(DIFF_EDITOR_KIND)!.component();
    document.body.appendChild(editorPanel.element);
    const sameInput = { topicId: 'topic-1', path: 'src/a.ts', mode: 'working' as const, ref: 'working' };
    fileFetchCount = 0;
    editorPanel.init(sameInput, makePanelInitCtx(idA).ctx);
    await flushMicrotasks();
    expect(fileFetchCount).toBe(1);

    editorPanel.update?.(sameInput);
    await flushMicrotasks();
    expect(fileFetchCount).toBe(1);

    editorPanel.dispose();
    toolPanel.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('navigates hunks forward/backward with wrap-around, toolbar buttons, keyboard shortcuts, and scroll highlight', async () => {
    expect(extractPatchHunks(MULTI_HUNK_PATCH).map((h) => h.newStart)).toEqual([1, 10, 20]);
    expect(computeTextHunks('a\nb\nc\nd', 'a\nB\nc\nD').length).toBe(2);
    expect(resolveNextHunkIndex(-1, 3, 1)).toBe(0);
    expect(resolveNextHunkIndex(-1, 3, -1)).toBe(2);
    expect(resolveNextHunkIndex(2, 3, 1)).toBe(0);
    expect(resolveNextHunkIndex(0, 3, -1)).toBe(2);
    expect(resolveNextHunkIndex(0, 0, 1)).toBe(-1);

    const { registry, events, manager } = makeHarness(TOPIC);
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        ok: true,
        path: 'src/a.ts',
        original: 'old',
        modified: 'new',
        patch: MULTI_HUNK_PATCH,
      }),
    );

    manager.register(createChangesPlugin({ fetchFn, codeView: async () => null }), { builtin: true });
    await manager.activate(CHANGES_PLUGIN_ID);

    const editorPanel = registry.getEditor(DIFF_EDITOR_KIND)!.component();
    document.body.appendChild(editorPanel.element);
    editorPanel.init({ topicId: 'topic-1', path: 'src/a.ts', mode: 'working' }, makePanelInitCtx('diff:a').ctx);
    await flushMicrotasks();

    const scrollSpy = vi.fn();
    const hunkEls = editorPanel.element.querySelectorAll<HTMLElement>('[data-hunk-index]');
    expect(hunkEls.length).toBe(3);
    for (const el of hunkEls) el.scrollIntoView = scrollSpy;

    const counter = (): string =>
      editorPanel.element.querySelector('[data-hunk-counter]')?.textContent?.trim() ?? '';
    expect(counter()).toBe('0/3');

    const nextBtn = (): HTMLButtonElement =>
      editorPanel.element.querySelector<HTMLButtonElement>('[data-action-id="next-hunk"]')!;
    const prevBtn = (): HTMLButtonElement =>
      editorPanel.element.querySelector<HTMLButtonElement>('[data-action-id="prev-hunk"]')!;

    nextBtn().click();
    expect(counter()).toBe('1/3');
    expect(hunkEls[0]!.classList.contains('is-hunk-active')).toBe(true);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });

    // Wrap backward from 1/3 -> 3/3 via prev button
    prevBtn().click();
    expect(counter()).toBe('3/3');
    expect(hunkEls[2]!.classList.contains('is-hunk-active')).toBe(true);
    expect(hunkEls[0]!.classList.contains('is-hunk-active')).toBe(false);

    // Wrap forward from 3/3 -> 1/3 via keyboard shortcut `]`
    editorPanel.element.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }));
    expect(counter()).toBe('1/3');

    // Alt+F5 moves forward -> 2/3, Shift+Alt+F5 moves backward -> 1/3
    editorPanel.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', altKey: true, bubbles: true }));
    expect(counter()).toBe('2/3');
    editorPanel.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F5', altKey: true, shiftKey: true, bubbles: true }),
    );
    expect(counter()).toBe('1/3');

    // Typing `]` inside a textarea must not trigger hunk navigation
    const input = document.createElement('textarea');
    editorPanel.element.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }));
    expect(counter()).toBe('1/3');

    editorPanel.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });

  it('stages, edits, deletes, merges, and clears multi-segment comments across diff tabs while keeping direct send', async () => {
    const store = new CommentDraftStore();
    const first = store.add(
      'topic-1',
      { path: 'src/a.ts', selection: { side: 'new', from: 2, to: 3, text: 'x\ny' }, sides: null },
      'First note',
    );
    const second = store.add(
      'topic-1',
      { path: 'src/b.ts', selection: { side: 'old', from: 5, to: 5, text: 'z' }, sides: null, refTag: 'abc1234' },
      'Second note',
    );
    expect(store.count('topic-1')).toBe(2);
    expect(store.update('topic-1', first.id, 'Updated first note')).toBe(true);
    const preview = formatMergedDiffComments(store.list('topic-1'));
    expect(preview).toContain('1. src/a.ts:L2-L3 (new)');
    expect(preview).toContain('Updated first note');
    expect(preview).toContain('2. src/b.ts:L5 (old, abc1234)');
    expect(store.remove('topic-1', second.id)).toBe(true);
    expect(store.count('topic-1')).toBe(1);
    store.clear('topic-1');
    expect(store.count('topic-1')).toBe(0);
    store.dispose();

    const { registry, events, manager, insertIntoComposer } = makeHarness(TOPIC);
    const capturedByFile = new Map<string, DiffOptions>();
    const mockCodeView: CodeViewApi = {
      editor: vi.fn(),
      highlighter: vi.fn(async () => null),
      diff: vi.fn((_parent, opts) => {
        capturedByFile.set(opts.name, opts);
        return { setLayout: vi.fn(), destroy: vi.fn() };
      }),
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.includes('b.ts') ? 'src/b.ts' : 'src/a.ts';
      return jsonResponse({ ok: true, path, original: 'line1\nold2', modified: 'line1\nnew2' });
    });

    manager.register(createChangesPlugin({ fetchFn, codeView: async () => mockCodeView }), { builtin: true });
    await manager.activate(CHANGES_PLUGIN_ID);

    const editorDef = registry.getEditor(DIFF_EDITOR_KIND)!;
    const tabA = editorDef.component();
    const tabB = editorDef.component();
    document.body.append(tabA.element, tabB.element);
    tabA.init({ topicId: 'topic-1', path: 'src/a.ts', mode: 'working' }, makePanelInitCtx('diff:a').ctx);
    tabB.init({ topicId: 'topic-1', path: 'src/b.ts', mode: 'working' }, makePanelInitCtx('diff:b').ctx);
    await flushMicrotasks();

    // Stage comment 1 in tab A
    capturedByFile.get('src/a.ts')?.onSelect?.({ side: 'new', from: 2, to: 2, text: 'new2' });
    tabA.element.querySelector<HTMLButtonElement>('[data-diff-comment-open]')!.click();
    const taA = tabA.element.querySelector<HTMLTextAreaElement>('.fh-diff-comment-input')!;
    taA.value = 'Rename helper';
    taA.dispatchEvent(new Event('input', { bubbles: true }));
    tabA.element.querySelector<HTMLButtonElement>('[data-diff-comment-stage]')!.click();

    // Stage comment 2 in tab B
    capturedByFile.get('src/b.ts')?.onSelect?.({ side: 'old', from: 2, to: 2, text: 'old2' });
    tabB.element.querySelector<HTMLButtonElement>('[data-diff-comment-open]')!.click();
    const taB = tabB.element.querySelector<HTMLTextAreaElement>('.fh-diff-comment-input')!;
    taB.value = 'Keep fallback';
    taB.dispatchEvent(new Event('input', { bubbles: true }));
    tabB.element.querySelector<HTMLButtonElement>('[data-diff-comment-stage]')!.click();

    // Both tabs reflect the shared pending badge count = 2
    expect(tabA.element.querySelector('[data-diff-queue-count]')?.textContent?.trim()).toBe('2');
    expect(tabB.element.querySelector('[data-diff-queue-count]')?.textContent?.trim()).toBe('2');

    // Edit first staged comment inline
    const firstId = tabA.element.querySelector<HTMLElement>('[data-staged-id]')!.getAttribute('data-staged-id')!;
    tabA.element.querySelector<HTMLButtonElement>(`[data-staged-edit="${firstId}"]`)!.click();
    const editBox = tabA.element.querySelector<HTMLTextAreaElement>('.fh-diff-queue-edit-input')!;
    editBox.value = 'Rename helper cleanly';
    editBox.dispatchEvent(new Event('input', { bubbles: true }));
    tabA.element.querySelector<HTMLButtonElement>(`[data-staged-save="${firstId}"]`)!.click();

    // Merge & send all staged comments in one structured block
    tabA.element.querySelector<HTMLButtonElement>('[data-diff-queue-send]')!.click();
    expect(insertIntoComposer).toHaveBeenCalledTimes(1);
    const mergedText = insertIntoComposer.mock.calls[0]![1] as string;
    expect(mergedText).toContain('1. src/a.ts:L2 (new)');
    expect(mergedText).toContain('Rename helper cleanly');
    expect(mergedText).toContain('2. src/b.ts:L2 (old)');
    expect(mergedText).toContain('Keep fallback');

    // Queue is cleared in both tabs after merge-send
    expect(tabA.element.querySelector('[data-diff-queue-count]')).toBeNull();
    expect(tabB.element.querySelector('[data-diff-queue-count]')).toBeNull();

    // Stage and clear flow
    capturedByFile.get('src/a.ts')?.onSelect?.({ side: 'new', from: 1, to: 1, text: 'line1' });
    tabA.element.querySelector<HTMLButtonElement>('[data-diff-comment-open]')!.click();
    const taClear = tabA.element.querySelector<HTMLTextAreaElement>('.fh-diff-comment-input')!;
    taClear.value = 'Temp note';
    taClear.dispatchEvent(new Event('input', { bubbles: true }));
    tabA.element.querySelector<HTMLButtonElement>('[data-diff-comment-stage]')!.click();
    expect(tabA.element.querySelector('[data-diff-queue-count]')?.textContent?.trim()).toBe('1');
    tabA.element.querySelector<HTMLButtonElement>('[data-diff-queue-clear]')!.click();
    expect(tabA.element.querySelector('[data-diff-queue-count]')).toBeNull();

    tabA.dispose();
    tabB.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
