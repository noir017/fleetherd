import { describe, expect, it } from 'vitest';
import type { TopicInfo } from '../../plugins/api.js';
import type { CommandEntry } from '../../services/commands.js';
import {
  buildCommandQuickPickItems,
  buildTopicQuickPickItems,
  collectKeybindingGroups,
  formatCommandTitle,
  formatKeybinding,
  inferCommandCategory,
  splitKeybindingTokens,
} from './format.js';
import { PALETTE_I18N_EN } from './i18n.js';

const enT = (key: string): string => PALETTE_I18N_EN[key] ?? key;

describe('features/palette/format', () => {
  it('formats keybindings for non-Mac and Mac platforms', () => {
    expect(formatKeybinding('Mod+K', false)).toBe('Ctrl+K');
    expect(formatKeybinding('Mod+Shift+P', false)).toBe('Ctrl+Shift+P');
    expect(formatKeybinding('Mod+/', false)).toBe('Ctrl+/');
    expect(formatKeybinding('Mod+Alt+B', false)).toBe('Ctrl+Alt+B');

    expect(formatKeybinding('Mod+K', true)).toBe('⌘K');
    expect(formatKeybinding('Mod+Shift+P', true)).toBe('⇧⌘P');
    expect(formatKeybinding('Mod+Alt+B', true)).toBe('⌥⌘B');
    expect(splitKeybindingTokens('Mod+Shift+P', false)).toEqual(['Ctrl', 'Shift', 'P']);
    expect(splitKeybindingTokens('Mod+Shift+P', true)).toEqual(['⇧', '⌘', 'P']);
  });

  it('falls back gracefully on unparseable keybinding specs', () => {
    expect(splitKeybindingTokens('Mod+', false)).toEqual(['Mod+']);
    expect(formatKeybinding('Mod+', false)).toBe('Mod+');
  });

  it('infers categories and humanizes command titles', () => {
    expect(inferCommandCategory('workbench.action.splitEditor')).toBe('Workbench');
    expect(inferCommandCategory('palette.quickOpenTopic')).toBe('Palette');
    expect(inferCommandCategory('customTool.doThing')).toBe('CustomTool');

    expect(
      formatCommandTitle({ id: 'workbench.action.splitEditor', run: () => undefined }),
    ).toBe('Split Editor');
    expect(
      formatCommandTitle({
        id: 'reviews.refresh',
        run: () => undefined,
        meta: { title: 'Refresh Reviews' },
      }),
    ).toBe('Refresh Reviews');
  });

  it('ranks topics by active, running/asking, starred, then recency and includes platform/status metadata', () => {
    const topics: TopicInfo[] = [
      {
        id: 't-recent',
        title: 'Old chat',
        lastAt: 100,
        dir: { name: 'docs', path: '/srv/docs' },
      },
      {
        id: 't-starred',
        title: 'Pinned project',
        lastAt: 200,
        starred: true,
        dir: { name: 'fleetherd', path: '/srv/fleetherd', host: 'uniagent' },
        agent: { id: 'claude-main', harness: 'claude' },
      },
      {
        id: 't-running',
        title: 'Build runner',
        lastAt: 150,
        running: true,
        last: 'Compiling release artifacts...',
        agent: { id: 'codex', harness: 'codex' },
      },
      {
        id: 't-active',
        title: 'Current topic',
        lastAt: 50,
        live: true,
      },
    ];

    const items = buildTopicQuickPickItems(topics, 't-active', enT);
    expect(items.map((i) => i.id)).toEqual(['t-active', 't-running', 't-starred', 't-recent']);
    expect(items[0]?.group).toBe('Current');
    expect(items[0]?.shortcut).toBe('Current');
    expect(items[1]?.group).toBe('Running');
    expect(items[1]?.detail).toContain('Running');
    expect(items[1]?.detail).toContain('Compiling release artifacts...');
    expect(items[2]?.group).toBe('Starred');
    expect(items[2]?.description).toBe('uniagent · fleetherd · claude-main (claude)');
    expect(items[2]?.keywords).toContain('uniagent');
    expect(items[2]?.keywords).toContain('claude');
    expect(items[3]?.group).toBe('Recent');
  });

  it('builds sorted command items and grouped keybindings with deduplication and filtering', () => {
    const entries: CommandEntry[] = [
      {
        id: 'workbench.action.splitEditor',
        run: () => undefined,
        meta: { title: 'Split Editor', category: 'Layout', keybinding: 'Mod+\\' },
      },
      {
        id: 'palette.quickOpenTopic',
        run: () => undefined,
        meta: { title: 'Quick Open Topic', category: 'Palette', keybinding: 'Mod+K' },
      },
      {
        id: 'reviews.refresh',
        run: () => undefined,
        meta: { title: 'Refresh Reviews' },
      },
    ];

    const cmdItems = buildCommandQuickPickItems(entries, false);
    expect(cmdItems.map((c) => c.id)).toEqual([
      'workbench.action.splitEditor',
      'palette.quickOpenTopic',
      'reviews.refresh',
    ]);
    expect(cmdItems[0]?.group).toBe('Layout');
    expect(cmdItems[0]?.shortcut).toBe('Ctrl+\\');
    expect(cmdItems[2]?.shortcut).toBeUndefined();

    const groups = collectKeybindingGroups(
      entries,
      [
        { command: 'palette.quickOpenTopic', keybinding: 'mod+k', title: 'Duplicate' },
        { command: 'custom.focus', keybinding: 'Alt+F', title: 'Focus Custom', category: 'Custom' },
      ],
      '',
      false,
    );
    expect(groups.map((g) => g.category)).toEqual(['Custom', 'Layout', 'Palette']);
    expect(groups[2]?.items).toHaveLength(1);

    const filtered = collectKeybindingGroups(entries, [], 'split', false);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.items[0]?.command).toBe('workbench.action.splitEditor');
  });
});
