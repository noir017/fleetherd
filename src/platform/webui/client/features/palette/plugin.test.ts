// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, type PluginTopicsBridge, WebuiEventBus } from '../../plugins/registry.js';
import type { ApiClient } from '../../services/api.js';
import { CommandRegistry } from '../../services/commands.js';
import { KeybindingService } from '../../services/keybindings.js';
import { OverlayManager } from '../../services/overlays.js';
import { StorageService, type StorageLike } from '../../services/storage.js';
import { createPalettePlugin, PALETTE_COMMAND_IDS, type PalettePluginDeps } from './index.js';

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

interface HarnessOptions {
  readonly topics?: readonly TopicInfo[];
  readonly activeTopicId?: string;
  readonly isMac?: boolean;
  readonly wireKeybindingsDep?: boolean;
  readonly extraKeybindings?: PalettePluginDeps['extraKeybindings'];
  readonly onCommandError?: PalettePluginDeps['onCommandError'];
}

async function createHarness(opts: HarnessOptions = {}) {
  const commands = new CommandRegistry();
  const isMac = opts.isMac ?? false;
  const keybindings = new KeybindingService({
    executeCommand: (id, ...args) => commands.execute(id, ...args),
    isMac,
  });
  const registry = new ContributionRegistry({ commands, keybindings });
  const events = new WebuiEventBus();
  const storage = new StorageService('', makeMemoryStorage());
  const overlays = new OverlayManager();
  const topicList: readonly TopicInfo[] = opts.topics ?? [
    {
      id: 'topic-alpha',
      title: 'Alpha Deployment',
      lastAt: 300,
      running: true,
      dir: { name: 'infra', path: '/srv/infra', host: 'uniagent' },
      agent: { id: 'claude', harness: 'claude' },
      last: 'Deploying container...',
    },
    {
      id: 'topic-beta',
      title: 'Beta Workbench',
      lastAt: 500,
      starred: true,
      dir: { name: 'fleetherd', path: '/srv/fleetherd', host: 'laptop' },
      agent: { id: 'codex', harness: 'codex' },
    },
    {
      id: 'topic-gamma',
      title: 'Gamma Notes',
      lastAt: 100,
    },
  ];
  const openTopic = vi.fn();
  const topics: PluginTopicsBridge = {
    list: () => topicList,
    active: () => topicList.find((t) => t.id === (opts.activeTopicId ?? 'topic-gamma')),
    open: openTopic,
    insertIntoComposer: vi.fn(),
  };
  const api: ApiClient = {
    get: vi.fn(async () => new Response('{}')),
    post: vi.fn(async () => new Response('{}')),
    async getJson<T>(): Promise<T> {
      return {} as T;
    },
    async postJson<T>(): Promise<T> {
      return {} as T;
    },
  };

  const manager = new PluginManager({
    registry,
    events,
    topics,
    api,
    storage,
  });

  const plugin = createPalettePlugin({
    commands,
    keybindings: opts.wireKeybindingsDep === false ? undefined : keybindings,
    extraKeybindings: opts.extraKeybindings,
    overlays,
    isMac,
    onCommandError: opts.onCommandError,
  });
  manager.register(plugin, { builtin: true });
  await manager.activate('palette');

  return {
    commands,
    keybindings,
    registry,
    events,
    overlays,
    manager,
    openTopic,
    disposeAll: () => {
      manager.dispose();
      overlays.dispose();
      keybindings.dispose();
      registry.dispose();
      events.dispose();
    },
  };
}

describe('features/palette/plugin', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens topic quick-open on Mod+K, fuzzy-matches with highlights, and jumps on Enter', async () => {
    const h = await createHarness({ activeTopicId: 'topic-gamma' });
    try {
      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);

      // Mod+K works even when focused inside an input/textarea
      const handled = h.keybindings.handleKeydown({
        key: 'k',
        ctrlKey: true,
        target: textarea,
      });
      expect(handled).toBe(true);

      const qp = document.querySelector<HTMLElement>('.fh-palette-topics');
      expect(qp).not.toBeNull();

      // Displays topic groups, platform/agent metadata, and active status
      const rows = Array.from(qp!.querySelectorAll<HTMLElement>('.fh-qp-row'));
      expect(rows.map((r) => r.dataset.qpId)).toEqual(['topic-gamma', 'topic-alpha', 'topic-beta']);
      expect(qp!.textContent).toContain('uniagent · infra · claude');
      expect(qp!.textContent).toContain('Running');
      expect(qp!.textContent).toContain('Current');

      // Fuzzy match highlights title characters and narrows list
      const input = qp!.querySelector<HTMLInputElement>('.fh-qp-input')!;
      input.value = 'btwb';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const filteredRows = qp!.querySelectorAll<HTMLElement>('.fh-qp-row');
      expect(filteredRows.length).toBe(1);
      expect(filteredRows[0]?.dataset.qpId).toBe('topic-beta');
      expect(qp!.querySelectorAll('.fh-qp-mark').length).toBeGreaterThan(0);

      // Enter opens the matched topic and closes the QuickPick
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(h.openTopic).toHaveBeenCalledWith('topic-beta');
      expect(document.querySelector('.fh-palette-topics')).toBeNull();
    } finally {
      h.disposeAll();
    }
  });

  it('opens command palette on Mod+Shift+P, filters commands, and executes on keyboard Enter', async () => {
    const h = await createHarness();
    try {
      const splitSpy = vi.fn();
      const refreshSpy = vi.fn();
      h.commands.register('workbench.action.splitEditor', splitSpy, {
        title: 'Split Editor Right',
        category: 'Layout',
        keybinding: 'Mod+\\',
      });
      h.commands.register('reviews.refresh', refreshSpy, {
        title: 'Refresh Reviews',
        category: 'Reviews',
      });

      const handled = h.keybindings.handleKeydown({
        key: 'P',
        ctrlKey: true,
        shiftKey: true,
      });
      expect(handled).toBe(true);

      const qp = document.querySelector<HTMLElement>('.fh-palette-commands');
      expect(qp).not.toBeNull();

      // Lists registered commands with category and formatted shortcut
      expect(qp!.textContent).toContain('Layout');
      expect(qp!.textContent).toContain('Split Editor Right');
      expect(qp!.textContent).toContain('Ctrl+\\');
      expect(qp!.textContent).toContain('Refresh Reviews');

      // Filter down to commands matching "re" and select with ArrowDown + Enter
      const input = qp!.querySelector<HTMLInputElement>('.fh-qp-input')!;
      input.value = 'refresh';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      expect(qp!.querySelectorAll('.fh-qp-row').length).toBe(1);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      await Promise.resolve();
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.fh-palette-commands')).toBeNull();

      // Re-open, navigate with ArrowDown, and execute another command
      await h.commands.execute(PALETTE_COMMAND_IDS.commands);
      const qp2 = document.querySelector<HTMLElement>('.fh-palette-commands')!;
      const input2 = qp2.querySelector<HTMLInputElement>('.fh-qp-input')!;
      input2.value = 'split';
      input2.dispatchEvent(new Event('input', { bubbles: true }));
      input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      await Promise.resolve();
      expect(splitSpy).toHaveBeenCalledTimes(1);
    } finally {
      h.disposeAll();
    }
  });

  it('forwards command execution errors to onCommandError without throwing', async () => {
    const onCommandError = vi.fn();
    const h = await createHarness({ onCommandError });
    try {
      const boom = new Error('boom');
      h.commands.register('demo.fail', async () => {
        throw boom;
      }, { title: 'Failing Command' });

      await h.commands.execute(PALETTE_COMMAND_IDS.commands);
      const input = document.querySelector<HTMLInputElement>('.fh-palette-commands .fh-qp-input')!;
      input.value = 'Failing Command';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      await vi.waitFor(() => {
        expect(onCommandError).toHaveBeenCalledWith('demo.fail', boom);
      });
    } finally {
      h.disposeAll();
    }
  });

  it('renders grouped keyboard shortcuts dialog on Mod+/ and filters live', async () => {
    const h = await createHarness({
      extraKeybindings: () => [
        { command: 'custom.ping', keybinding: 'Alt+P', title: 'Ping Host', category: 'Tools' },
      ],
    });
    try {
      h.commands.register('workbench.action.toggleSidebar', () => undefined, {
        title: 'Toggle Sidebar',
        category: 'Layout',
        keybinding: 'Mod+B',
      });
      h.commands.register('workbench.action.noShortcut', () => undefined, {
        title: 'No Shortcut Command',
        category: 'Layout',
      });

      const handled = h.keybindings.handleKeydown({ key: '/', ctrlKey: true });
      expect(handled).toBe(true);

      const dialog = document.querySelector<HTMLElement>('.fh-palette-kb-dialog');
      expect(dialog).not.toBeNull();

      // Grouped tables only include commands with keybindings
      const groupNames = Array.from(dialog!.querySelectorAll<HTMLElement>('.fh-palette-kb-group'))
        .map((el) => el.dataset.kbGroup);
      expect(groupNames).toEqual(['Layout', 'Palette', 'Tools']);
      expect(dialog!.textContent).toContain('Toggle Sidebar');
      expect(dialog!.textContent).toContain('Ping Host');
      expect(dialog!.textContent).not.toContain('No Shortcut Command');
      expect(dialog!.querySelectorAll('kbd.fh-palette-kbd').length).toBeGreaterThan(0);

      // Search filters rows live
      const search = dialog!.querySelector<HTMLInputElement>('.fh-palette-kb-input')!;
      search.value = 'sidebar';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const rows = dialog!.querySelectorAll<HTMLElement>('.fh-palette-kb-row');
      expect(rows.length).toBe(1);
      expect(rows[0]?.dataset.kbCommand).toBe('workbench.action.toggleSidebar');

      // Non-matching query displays empty message
      search.value = 'zzzz-no-match';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      expect(dialog!.querySelectorAll('.fh-palette-kb-row').length).toBe(0);
      expect(dialog!.querySelector('.fh-palette-kb-empty')).not.toBeNull();

      // Escape via OverlayManager closes the dialog
      expect(h.overlays.handleEscape()).toBe(true);
      expect(document.querySelector('.fh-palette-kb-dialog')).toBeNull();
    } finally {
      h.disposeAll();
    }
  });

  it('toggles same palette overlay and replaces a different active overlay', async () => {
    const h = await createHarness();
    try {
      await h.commands.execute(PALETTE_COMMAND_IDS.quickOpenTopic);
      expect(document.querySelector('.fh-palette-topics')).not.toBeNull();

      // Opening commands closes topics first
      await h.commands.execute(PALETTE_COMMAND_IDS.commands);
      expect(document.querySelector('.fh-palette-topics')).toBeNull();
      expect(document.querySelector('.fh-palette-commands')).not.toBeNull();

      // Invoking commands again toggles it closed
      await h.commands.execute(PALETTE_COMMAND_IDS.commands);
      expect(document.querySelector('.fh-palette-commands')).toBeNull();
    } finally {
      h.disposeAll();
    }
  });

  it('cleans up open overlays, commands, and keybindings on plugin deactivate/dispose', async () => {
    const h = await createHarness();
    try {
      await h.commands.execute(PALETTE_COMMAND_IDS.keybindings);
      expect(document.querySelector('.fh-palette-kb-dialog')).not.toBeNull();

      h.manager.deactivate('palette');

      expect(document.querySelector('.fh-palette-kb-dialog')).toBeNull();
      expect(h.commands.has(PALETTE_COMMAND_IDS.quickOpenTopic)).toBe(false);
      expect(h.commands.has(PALETTE_COMMAND_IDS.commands)).toBe(false);
      expect(h.commands.has(PALETTE_COMMAND_IDS.keybindings)).toBe(false);
      expect(h.keybindings.handleKeydown({ key: 'k', ctrlKey: true })).toBe(false);
      expect(h.keybindings.handleKeydown({ key: 'P', ctrlKey: true, shiftKey: true })).toBe(false);
      expect(h.keybindings.handleKeydown({ key: '/', ctrlKey: true })).toBe(false);
    } finally {
      h.disposeAll();
    }
  });
});
