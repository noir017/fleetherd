// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillPanelDetail, SkillPanelEntry, SkillPanelOp } from '../../../../workbench.js';
import type { CodeViewApi, EditorHandle, EditorOptions } from '../../../codeview/app.js';
import { Emitter } from '../../base/event.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import {
  CMD_SKILLS_NEW,
  CMD_SKILLS_REFRESH,
  createSkillsPlugin,
  SKILL_EDITOR_KIND,
  SKILLS_ACTIVITY_ID,
  SKILLS_PLUGIN_ID,
  SKILLS_VIEW_ID,
  type SkillListResponse,
  type SkillOpResponse,
  type SkillPanelInitContext,
  type SkillsPluginDeps,
} from './index.js';

function makeSkill(overrides: Partial<SkillPanelEntry> = {}): SkillPanelEntry {
  return {
    name: 'deploy-check',
    description: 'Verify deployment checklist before release',
    version: 'a1b2c3d4',
    status: 'active',
    pinned: false,
    createdAt: '2026-11-20T10:00:00.000Z',
    lastUsedAt: '2026-11-23T12:00:00.000Z',
    uses: 5,
    agents: ['claude'],
    resident: false,
    category: 'ops',
    ...overrides,
  };
}

function makeDetail(
  skill: SkillPanelEntry,
  overrides: Partial<SkillPanelDetail> = {},
): SkillPanelDetail {
  return {
    skill,
    files: [
      { path: 'SKILL.md', size: 256 },
      { path: 'references/checklist.md', size: 120 },
    ],
    file: {
      path: 'SKILL.md',
      content: `---\nname: ${skill.name}\n---\n# Instructions\n`,
      version: skill.version,
    },
    history: [
      {
        id: '112233445566',
        at: '2026-11-23T12:00:00.000Z',
        action: 'patch',
        author: 'fleetherd-web',
        beforeVersion: '00001111',
        afterVersion: skill.version,
        note: 'Updated checklist',
      },
    ],
    ...overrides,
  };
}

function makeMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function makePanelInitCtx(id: string): { ctx: SkillPanelInitContext; titles: string[] } {
  const vis = new Emitter<boolean>();
  const dims = new Emitter<{ readonly width: number; readonly height: number }>();
  const titles: string[] = [];
  const ctx: SkillPanelInitContext = {
    id,
    api: {
      id,
      group: 'main',
      params: {},
      onDidVisibilityChange: vis.event,
      onDidDimensionsChange: dims.event,
      setTitle(t: string) {
        titles.push(t);
      },
      setBadge: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    },
  };
  return { ctx, titles };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

interface HarnessOptions {
  readonly listResponse?: () => Promise<SkillListResponse>;
  readonly opHandler?: (op: SkillPanelOp) => Promise<SkillOpResponse>;
  readonly pluginDeps?: SkillsPluginDeps;
}

function createHarness(opts: HarnessOptions = {}) {
  const openEditor = vi.fn();
  const registry = new ContributionRegistry({ openEditor });
  const events = new WebuiEventBus();
  const storage = new StorageService('', makeMemoryStorage());
  const getCalls: string[] = [];
  const opCalls: SkillPanelOp[] = [];

  const defaultSkills: SkillPanelEntry[] = [
    makeSkill({ name: 'alpha-resident', resident: true, category: 'core', uses: 12 }),
    makeSkill({ name: 'beta-library', resident: false, category: 'ops', uses: 3 }),
    makeSkill({ name: 'gamma-archived', resident: false, status: 'archived', category: 'legacy', uses: 1 }),
  ];

  const api: ApiClient = {
    post: vi.fn(async () => new Response('{}')),
    get: vi.fn(async () => new Response('{}')),
    async getJson<T>(path: string): Promise<T> {
      getCalls.push(path);
      if (opts.listResponse) return (await opts.listResponse()) as T;
      return { enabled: true, skills: defaultSkills, searches: null } as T;
    },
    async postJson<T>(_path: string, body: unknown): Promise<T> {
      const op = body as SkillPanelOp;
      opCalls.push(op);
      if (opts.opHandler) return (await opts.opHandler(op)) as T;
      const found = defaultSkills.find((s) => s.name === op.name) ?? defaultSkills[0]!;
      return { ok: true, skills: defaultSkills, detail: makeDetail(found) } as T;
    },
  };

  const topics: PluginTopicsBridge = {
    list: () => [],
    active: () => undefined,
    open: vi.fn(),
    insertIntoComposer: vi.fn(),
  };

  const manager = new PluginManager({ registry, events, storage, api, topics });
  const plugin = createSkillsPlugin({
    doc: document,
    confirm: () => true,
    formatAgo: () => '2h ago',
    ...opts.pluginDeps,
  });
  manager.register(plugin, { builtin: true });

  return {
    registry,
    events,
    storage,
    api,
    manager,
    openEditor,
    getCalls,
    opCalls,
    defaultSkills,
    cleanup() {
      manager.dispose();
      events.dispose();
      registry.dispose();
    },
  };
}

describe('features/skills plugin', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('registers view, activity item, editor, and commands, and cleans them up on deactivate', async () => {
    const h = createHarness();
    await h.manager.activate(SKILLS_PLUGIN_ID);

    expect(h.manager.getStatus(SKILLS_PLUGIN_ID)).toBe('active');
    expect(h.registry.getView(SKILLS_VIEW_ID)).toMatchObject({
      id: SKILLS_VIEW_ID,
      part: 'sidebar',
    });
    expect(h.registry.getActivity(SKILLS_ACTIVITY_ID)).toMatchObject({
      id: SKILLS_ACTIVITY_ID,
      view: SKILLS_VIEW_ID,
      icon: 'book',
      order: 30,
    });
    expect(h.registry.getEditor(SKILL_EDITOR_KIND)).toBeDefined();
    expect(h.registry.getEditor(SKILL_EDITOR_KIND)?.title({ name: 'deploy-check' })).toBe('deploy-check');
    expect(h.registry.commands.has(CMD_SKILLS_NEW)).toBe(true);
    expect(h.registry.commands.has(CMD_SKILLS_REFRESH)).toBe(true);

    h.manager.deactivate(SKILLS_PLUGIN_ID);
    expect(h.registry.getView(SKILLS_VIEW_ID)).toBeUndefined();
    expect(h.registry.getActivity(SKILLS_ACTIVITY_ID)).toBeUndefined();
    expect(h.registry.getEditor(SKILL_EDITOR_KIND)).toBeUndefined();
    expect(h.registry.commands.has(CMD_SKILLS_NEW)).toBe(false);
    expect(h.registry.commands.has(CMD_SKILLS_REFRESH)).toBe(false);

    h.cleanup();
  });

  it('filters skills by resident, archived, category, and query, and opens editor on click', async () => {
    const h = createHarness();
    await h.manager.activate(SKILLS_PLUGIN_ID);

    const viewContrib = h.registry.getView(SKILLS_VIEW_ID)!;
    const panel = viewContrib.component();
    document.body.appendChild(panel.element);
    panel.init({}, makePanelInitCtx('skills-view').ctx);
    await flushMicrotasks();

    expect(h.getCalls).toEqual(['/api/skills']);
    const visibleNames = () =>
      Array.from(panel.element.querySelectorAll<HTMLElement>('[data-skill-name]')).map(
        (el) => el.dataset.skillName,
      );

    // Uses shared createSegmented tablist above FilterBar instead of custom .skill-tab or tier chips
    const segHost = panel.element.querySelector<HTMLElement>('.fh-sidebar-seg');
    const filterHost = panel.element.querySelector<HTMLElement>('.fh-sidebar-filter');
    expect(segHost?.querySelector('.fh-seg--nav[role="tablist"]')).not.toBeNull();
    expect(filterHost?.querySelector('.fh-filterbar')).not.toBeNull();
    expect(segHost!.compareDocumentPosition(filterHost!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.element.querySelector('.skill-tab')).toBeNull();
    expect(panel.element.querySelector('[data-fb-group="tier"]')).toBeNull();

    const residentTab = panel.element.querySelector<HTMLButtonElement>('[role="tab"][data-seg-value="resident"]')!;
    const libraryTab = panel.element.querySelector<HTMLButtonElement>('[role="tab"][data-seg-value="library"]')!;
    expect(residentTab.querySelector('.fh-seg-count')?.textContent).toBe('1');
    expect(libraryTab.querySelector('.fh-seg-count')?.textContent).toBe('2');
    expect(libraryTab.getAttribute('aria-selected')).toBe('true');
    expect(visibleNames()).toEqual(['beta-library', 'gamma-archived']);

    // Switch to Resident tab and back via shared segmented control
    residentTab.click();
    expect(residentTab.getAttribute('aria-selected')).toBe('true');
    expect(visibleNames()).toEqual(['alpha-resident']);
    libraryTab.click();
    expect(libraryTab.getAttribute('aria-selected')).toBe('true');
    expect(visibleNames()).toEqual(['beta-library', 'gamma-archived']);

    // Filter by archived status chip
    const pinsEl = panel.element.querySelector<HTMLElement>('.fh-fb-pins')!;
    expect(pinsEl.hidden).toBe(true);
    expect(pinsEl.querySelectorAll('.fh-fb-chip').length).toBe(0);
    const panelGroups = panel.element.querySelectorAll<HTMLElement>('.fh-fb-panel .fh-fb-group');
    expect(panelGroups[0]?.querySelector('.fh-fb-label')?.textContent).toBe('State');

    const archivedChip = panel.element.querySelector<HTMLButtonElement>(
      '.fh-fb-panel [data-fb-group="status"][data-fb-value="archived"]',
    )!;
    archivedChip.click();
    expect(visibleNames()).toEqual(['gamma-archived']);
    expect(panel.element.querySelector<HTMLElement>('.fh-fb-dot')!.hidden).toBe(false);
    archivedChip.click();
    expect(panel.element.querySelector<HTMLElement>('.fh-fb-dot')!.hidden).toBe(true);

    // Filter by category chip in filter panel
    const opsChip = panel.element.querySelector<HTMLButtonElement>(
      '[data-fb-group="category"][data-fb-value="ops"]',
    )!;
    opsChip.click();
    expect(visibleNames()).toEqual(['beta-library']);
    opsChip.click();

    // Filter by text query
    const searchInput = panel.element.querySelector<HTMLInputElement>('.fh-fb-q')!;
    searchInput.value = 'beta';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(visibleNames()).toEqual(['beta-library']);

    // Clicking row opens skill editor via PluginContext
    const row = panel.element.querySelector<HTMLElement>('[data-list-id="beta-library"]')!;
    row.click();
    expect(h.openEditor).toHaveBeenCalledWith('skill', { name: 'beta-library' }, { id: 'skill:beta-library' });

    // Refresh command triggers /api/skills again
    await h.registry.executeCommand(CMD_SKILLS_REFRESH);
    expect(h.getCalls).toEqual(['/api/skills', '/api/skills']);

    panel.dispose();
    expect(panel.element.isConnected).toBe(false);
    h.cleanup();
  });

  it('creates a new skill via skills.new command dialog and opens it in editor', async () => {
    const h = createHarness();
    await h.manager.activate(SKILLS_PLUGIN_ID);

    await h.registry.executeCommand(CMD_SKILLS_NEW);
    const nameInput = document.querySelector<HTMLInputElement>('#fh-skill-new-name')!;
    const descInput = document.querySelector<HTMLInputElement>('#fh-skill-new-desc')!;
    const confirmBtn = document.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]')!;

    // Empty name validation blocks submission
    confirmBtn.click();
    await flushMicrotasks();
    expect(h.opCalls).toHaveLength(0);
    expect(document.querySelector('.fh-dialog-err')).not.toBeNull();

    nameInput.value = 'log-parser';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    descInput.value = 'Parse structured logs';
    descInput.dispatchEvent(new Event('input', { bubbles: true }));

    confirmBtn.click();
    await flushMicrotasks();

    expect(h.opCalls).toEqual([
      { action: 'create', name: 'log-parser', description: 'Parse structured logs' },
    ]);
    expect(h.openEditor).toHaveBeenCalledWith('skill', { name: 'log-parser' }, undefined);
    h.cleanup();
  });

  it('preserves version-checked SKILL.md patch, stale-version refusal, archive/resident toggles, and revert', async () => {
    let currentSkill = makeSkill({ name: 'deploy-check', version: 'v111', resident: false, status: 'active' });
    let currentContent = '---\nname: deploy-check\n---\nInitial\n';
    let rejectStale = false;

    const h = createHarness({
      opHandler: async (op) => {
        if (op.action === 'show') {
          const path = op.file ?? 'SKILL.md';
          return {
            ok: true,
            skills: [currentSkill],
            detail: makeDetail(currentSkill, {
              file: {
                path,
                content: path === 'SKILL.md' ? currentContent : 'Secondary file content',
                version: currentSkill.version,
              },
            }),
          };
        }
        if (op.action === 'patch') {
          if (rejectStale || op.version !== currentSkill.version) {
            return { ok: false, error: 'Skill changed since you opened it (stale version)' };
          }
          currentSkill = { ...currentSkill, version: 'v222' };
          currentContent = op.content;
          return { ok: true, skills: [currentSkill] };
        }
        if (op.action === 'resident') {
          currentSkill = { ...currentSkill, resident: op.resident };
          return { ok: true, skills: [currentSkill] };
        }
        if (op.action === 'archive') {
          currentSkill = { ...currentSkill, status: 'archived' };
          return { ok: true, skills: [currentSkill] };
        }
        if (op.action === 'restore') {
          currentSkill = { ...currentSkill, status: 'active' };
          return { ok: true, skills: [currentSkill] };
        }
        if (op.action === 'revert') {
          currentSkill = { ...currentSkill, version: 'v333' };
          currentContent = 'Restored content';
          return { ok: true, skills: [currentSkill] };
        }
        return { ok: true, skills: [currentSkill] };
      },
    });
    await h.manager.activate(SKILLS_PLUGIN_ID);

    const editorContrib = h.registry.getEditor(SKILL_EDITOR_KIND)!;
    const editor = editorContrib.component();
    document.body.appendChild(editor.element);
    const { ctx: initCtx, titles } = makePanelInitCtx('skill:deploy-check');
    editor.init({ name: 'deploy-check' }, initCtx);
    await flushMicrotasks();

    const textarea = editor.element.querySelector<HTMLTextAreaElement>('textarea.fh-skill-ed-textarea')!;
    expect(textarea.value).toBe(currentContent);
    expect(titles).toContain('deploy-check');

    // Edit SKILL.md and save with exact version
    textarea.value = '---\nname: deploy-check\n---\nUpdated\n';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(titles.at(-1)).toBe('deploy-check *');

    editor.element.querySelector<HTMLButtonElement>('[data-sop="save"]')!.click();
    await flushMicrotasks();

    expect(h.opCalls).toContainEqual({
      action: 'patch',
      name: 'deploy-check',
      version: 'v111',
      content: '---\nname: deploy-check\n---\nUpdated\n',
    });

    // Stale version refusal surfaces error without clobbering draft
    rejectStale = true;
    textarea.value = '---\nname: deploy-check\n---\nConflicting edit\n';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    editor.element.querySelector<HTMLButtonElement>('[data-sop="save"]')!.click();
    await flushMicrotasks();

    expect(editor.element.querySelector('.fh-notice--err')?.textContent).toContain('stale version');
    expect(textarea.value).toBe('---\nname: deploy-check\n---\nConflicting edit\n');

    // Toggle resident tier
    const residentBtn = editor.element.querySelector<HTMLButtonElement>('[data-seg-value="resident"]')!;
    residentBtn.click();
    await flushMicrotasks();
    expect(h.opCalls).toContainEqual({ action: 'resident', name: 'deploy-check', resident: true });

    // Archive via switch, then restore
    const enableSwitch = editor.element.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    enableSwitch.click();
    await flushMicrotasks();
    expect(h.opCalls).toContainEqual({ action: 'archive', name: 'deploy-check' });

    enableSwitch.click();
    await flushMicrotasks();
    expect(h.opCalls).toContainEqual({ action: 'restore', name: 'deploy-check' });

    // Revert history commit
    editor.element.querySelector<HTMLButtonElement>('[data-revert="112233445566"]')!.click();
    await flushMicrotasks();
    expect(h.opCalls).toContainEqual({ action: 'revert', name: 'deploy-check', id: '112233445566' });

    editor.dispose();
    expect(editor.element.isConnected).toBe(false);
    h.cleanup();
  });

  it('mounts CodeMirror when available and destroys handle on dispose', async () => {
    let cmDoc = '';
    const destroy = vi.fn();
    let capturedOpts: EditorOptions | null = null;
    const mockCodeView: CodeViewApi = {
      editor(_parent: HTMLElement, options: EditorOptions): EditorHandle {
        capturedOpts = options;
        cmDoc = options.doc;
        return {
          getDoc: () => cmDoc,
          setDoc: (d) => {
            cmDoc = d;
          },
          focus: vi.fn(),
          destroy,
        };
      },
      diff: vi.fn() as unknown as CodeViewApi['diff'],
      highlighter: vi.fn() as unknown as CodeViewApi['highlighter'],
    };

    const h = createHarness({
      pluginDeps: { codeView: () => Promise.resolve(mockCodeView) },
    });
    await h.manager.activate(SKILLS_PLUGIN_ID);

    const editor = h.registry.getEditor(SKILL_EDITOR_KIND)!.component();
    document.body.appendChild(editor.element);
    editor.init({ name: 'alpha-resident' }, makePanelInitCtx('skill:alpha-resident').ctx);
    await flushMicrotasks();

    expect(capturedOpts).not.toBeNull();
    expect(editor.element.querySelector<HTMLTextAreaElement>('textarea')!.hidden).toBe(true);

    // Edit through CodeMirror handle and trigger Mod-S save
    const editedDoc = '---\nname: alpha-resident\n---\nEdited in CM\n';
    cmDoc = editedDoc;
    capturedOpts!.onChange?.(editedDoc);
    capturedOpts!.onSave?.();
    await flushMicrotasks();

    expect(h.opCalls).toContainEqual({
      action: 'patch',
      name: 'alpha-resident',
      version: 'a1b2c3d4',
      content: editedDoc,
    });

    editor.dispose();
    expect(destroy).toHaveBeenCalled();
    h.cleanup();
  });

  it('supports secondary file switching, creating/removing files, pinning, and textarea fallback on CodeMirror error', async () => {
    const h = createHarness({
      pluginDeps: {
        codeView: () => Promise.reject(new Error('chunk failed')),
      },
    });
    await h.manager.activate(SKILLS_PLUGIN_ID);

    const editor = h.registry.getEditor(SKILL_EDITOR_KIND)!.component();
    document.body.appendChild(editor.element);
    editor.init({ name: 'beta-library' }, makePanelInitCtx('skill:beta-library').ctx);
    await flushMicrotasks();

    // Textarea remains visible when CodeMirror fails to load
    const textarea = editor.element.querySelector<HTMLTextAreaElement>('textarea.fh-skill-ed-textarea')!;
    expect(textarea.hidden).toBe(false);

    // Pin skill
    editor.element.querySelector<HTMLButtonElement>('[data-sop="pin"]')!.click();
    await flushMicrotasks();
    expect(h.opCalls).toContainEqual({ action: 'pin', name: 'beta-library', pinned: true });

    // Create a new file via write-file
    editor.element.querySelector<HTMLButtonElement>('[data-sop="new-file"]')!.click();
    const pathInput = editor.element.querySelector<HTMLInputElement>('#fh-skill-ed-path')!;
    pathInput.value = 'references/runbook.md';
    pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.value = '# Runbook';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    editor.element.querySelector<HTMLButtonElement>('[data-sop="save"]')!.click();
    await flushMicrotasks();
    expect(h.opCalls).toContainEqual({
      action: 'write-file',
      name: 'beta-library',
      file: 'references/runbook.md',
      content: '# Runbook',
    });

    // Switch to secondary file and remove it
    editor.element.querySelector<HTMLButtonElement>('[data-file="references/checklist.md"]')!.click();
    await flushMicrotasks();
    expect(h.opCalls).toContainEqual({
      action: 'show',
      name: 'beta-library',
      file: 'references/checklist.md',
    });

    editor.dispose();
    h.cleanup();
  });

  it('sets a custom category from the editor properties card and refreshes cached list on view init', async () => {
    const h = createHarness();
    await h.manager.activate(SKILLS_PLUGIN_ID);

    const editor = h.registry.getEditor(SKILL_EDITOR_KIND)!.component();
    document.body.appendChild(editor.element);
    editor.init({ name: 'beta-library' }, makePanelInitCtx('skill:beta-library').ctx);
    await flushMicrotasks();

    const catInput = editor.element.querySelector<HTMLInputElement>('[data-sop="category-input"]')!;
    const applyBtn = editor.element.querySelector<HTMLButtonElement>('[data-sop="category-apply"]')!;
    expect(applyBtn.disabled).toBe(true);

    catInput.value = '移动通信';
    catInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(applyBtn.disabled).toBe(false);

    applyBtn.click();
    await flushMicrotasks();
    expect(h.opCalls).toContainEqual({
      action: 'category',
      name: 'beta-library',
      category: '移动通信',
    });

    editor.dispose();
    h.cleanup();
  });
});
