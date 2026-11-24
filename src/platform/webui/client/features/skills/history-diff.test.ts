// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SkillPanelDetail, SkillPanelEntry, SkillPanelOp } from '../../../../adapter.js';
import { Emitter } from '../../base/event.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService } from '../../services/storage.js';
import {
  buildMetadataDiff,
  computeLineDiff,
  createSkillsPlugin,
  SKILL_EDITOR_KIND,
  SKILLS_PLUGIN_ID,
  type SkillListResponse,
  type SkillOpResponse,
  type SkillPanelInitContext,
} from './index.js';

function makePanelInitCtx(id: string): SkillPanelInitContext {
  const onVis = new Emitter<boolean>();
  const onDim = new Emitter<{ readonly width: number; readonly height: number }>();
  return {
    id,
    api: {
      id,
      group: 'main',
      params: undefined,
      onDidVisibilityChange: onVis.event,
      onDidDimensionsChange: onDim.event,
      setTitle: vi.fn(),
      setBadge: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('features/skills history diff', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('computes unified line-level diffs with added, removed, context, and hunk lines', () => {
    const before = ['line 1', 'line 2', 'line 3', 'line 4'].join('\n');
    const after = ['line 1', 'line 2 updated', 'line 3', 'line 4', 'line 5'].join('\n');

    const diff = computeLineDiff(before, after, 1);
    expect(diff.hasChanges).toBe(true);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.lines.some((l) => l.kind === 'hunk')).toBe(true);
    expect(diff.lines.some((l) => l.kind === 'del' && l.text === 'line 2')).toBe(true);
    expect(diff.lines.some((l) => l.kind === 'add' && l.text === 'line 2 updated')).toBe(true);
    expect(diff.lines.some((l) => l.kind === 'add' && l.text === 'line 5')).toBe(true);

    const same = computeLineDiff(before, before);
    expect(same.hasChanges).toBe(false);
    expect(same.lines).toEqual([]);
  });

  it('builds metadata diff fallback and includes unsaved draft edits', () => {
    const skill: SkillPanelEntry = {
      name: 'ops-check',
      description: 'Ops check',
      version: 'v222',
      status: 'active',
      pinned: false,
      createdAt: '2026-11-20T00:00:00.000Z',
      uses: 1,
      agents: ['claude'],
      resident: false,
    };
    const entry = {
      id: 'aabbccddeeff',
      at: '2026-11-22T00:00:00.000Z',
      action: 'patch',
      beforeVersion: 'v111',
      afterVersion: 'v222',
    };
    const res = buildMetadataDiff(entry, skill, 'old line\n', 'old line\nnew draft\n');
    expect(res.source).toBe('metadata');
    expect(res.hasChanges).toBe(true);
    expect(res.lines.some((l) => l.kind === 'del' && l.text.includes('v111'))).toBe(true);
    expect(res.lines.some((l) => l.kind === 'add' && l.text === 'new draft')).toBe(true);
  });

  it('renders unified diff when selecting a history entry in SkillEditorPanel and preserves revert', async () => {
    const skill: SkillPanelEntry = {
      name: 'deploy-check',
      description: 'Deploy checklist',
      version: 'v222',
      status: 'active',
      pinned: false,
      createdAt: '2026-11-20T00:00:00.000Z',
      uses: 2,
      agents: ['claude'],
      resident: false,
    };
    const detail: SkillPanelDetail = {
      skill,
      files: [{ path: 'SKILL.md', size: 64 }],
      file: {
        path: 'SKILL.md',
        content: '# Deploy\nStep 1\nStep 2 (new)\nStep 3\n',
        version: 'v222',
      },
      history: [
        {
          id: '112233445566',
          at: '2026-11-23T12:00:00.000Z',
          action: 'patch',
          author: 'fleetherd-web',
          beforeVersion: 'v111',
          afterVersion: 'v222',
          note: 'Updated step 2',
        },
      ],
    };

    const opCalls: SkillPanelOp[] = [];
    const registry = new ContributionRegistry();
    const events = new WebuiEventBus();
    const storage = new StorageService();
    const api: ApiClient = {
      get: vi.fn(async () => new Response('{}')),
      post: vi.fn(async () => new Response('{}')),
      getJson: async <T>(path: string): Promise<T> => {
        if (path === '/api/skills') return { enabled: true, skills: [skill] } as SkillListResponse as T;
        throw new Error(`Unexpected GET ${path}`);
      },
      postJson: async <T>(_path: string, body: unknown): Promise<T> => {
        const op = body as SkillPanelOp;
        opCalls.push(op);
        if (op.action === 'show') return { ok: true, detail } as SkillOpResponse as T;
        return { ok: true, skills: [skill] } as SkillOpResponse as T;
      },
    };
    const topics: PluginTopicsBridge = {
      list: () => [],
      active: () => undefined,
      open: vi.fn(),
      insertIntoComposer: vi.fn(),
    };
    const manager = new PluginManager({ registry, events, storage, api, topics });

    manager.register(
      createSkillsPlugin({
        confirm: () => true,
        loadHistoryContent: async () => '# Deploy\nStep 1\nStep 2 (old)\n',
      }),
      { builtin: true },
    );
    await manager.activate(SKILLS_PLUGIN_ID);

    const editor = registry.getEditor(SKILL_EDITOR_KIND)!.component();
    document.body.appendChild(editor.element);
    editor.init({ name: 'deploy-check' }, makePanelInitCtx('skill:deploy-check'));
    await flushMicrotasks();

    // Select history entry via Diff button.
    const diffBtn = editor.element.querySelector<HTMLButtonElement>('[data-history-diff="112233445566"]')!;
    diffBtn.click();
    await flushMicrotasks();

    const panel = editor.element.querySelector<HTMLElement>('.fh-skill-diff-panel')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('.fh-skill-diff-stat--add')?.textContent).toBe('+2');
    expect(panel.querySelector('.fh-skill-diff-stat--del')?.textContent).toBe('-1');
    expect(panel.querySelectorAll('.fh-skill-diff-line--add').length).toBe(2);
    expect(panel.querySelectorAll('.fh-skill-diff-line--del').length).toBe(1);
    expect(panel.querySelectorAll('.fh-skill-diff-line--ctx').length).toBeGreaterThan(0);

    // Revert button inside diff panel still triggers revert op.
    const diffRevertBtn = panel.querySelector<HTMLButtonElement>('[data-diff-revert="112233445566"]')!;
    diffRevertBtn.click();
    await flushMicrotasks();
    expect(opCalls).toContainEqual({ action: 'revert', name: 'deploy-check', id: '112233445566' });

    editor.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
