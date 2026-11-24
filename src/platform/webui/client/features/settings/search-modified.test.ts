// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SettingsScreen } from '../../../../../types.js';
import { Emitter } from '../../base/event.js';
import type { TopicInfo } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, WebuiEventBus } from '../../plugins/registry.js';
import { createApiClient } from '../../services/api.js';
import { StorageService } from '../../services/storage.js';
import { createSettingsPlugin, type SettingsPluginBridge } from './plugin.js';
import {
  captureBaseline,
  computeModifiedMap,
  matchesSearchWords,
  rowBaselineKey,
  type SettingBaselineEntry,
  tokenizeQuery,
} from './search-modified.js';
import type { SettingsWebMessage } from './types.js';
import type { WorkbenchPanelInitContext } from './workbench-types.js';

function makePanelInitCtx(id: string): WorkbenchPanelInitContext {
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

function makeScreen(overrides?: { switchOn?: boolean; perm?: string }): Extract<SettingsScreen, { level: 'list' }> {
  const switchOn = overrides?.switchOn ?? false;
  const perm = overrides?.perm ?? 'auto';
  return {
    level: 'list',
    groups: [{ name: 'General' }, { name: 'Security' }],
    rows: [
      {
        group: 'General',
        label: 'Auto Reply',
        hint: 'Send automatic acknowledgements',
        buttonId: 'sw:auto',
        control: { kind: 'switch', on: switchOn, set: switchOn ? 'sts:auto:0' : 'sts:auto:1' },
      },
      {
        group: 'Security',
        label: 'Permission Level',
        hint: 'Controls tool approvals',
        buttonId: 'ch:perm',
        control: {
          kind: 'choice',
          options: [
            { label: 'auto', buttonId: 'stp:auto', current: perm === 'auto' },
            { label: 'ask', buttonId: 'stp:ask', current: perm === 'ask' },
            { label: 'plan', buttonId: 'stp:plan', current: perm === 'plan' },
          ],
        },
      },
    ],
  };
}

function makeMsg(screen: SettingsScreen, id = 'm1'): SettingsWebMessage {
  return { id, own: false, html: '', at: 0, buttons: [], reactions: [], settings: screen };
}

describe('features/settings search & modified indicators', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('captures baseline values and detects modified switch and choice rows with reset button ids', () => {
    const baseline = new Map<string, SettingBaselineEntry>();
    const initial = makeScreen({ switchOn: false, perm: 'auto' });
    captureBaseline(initial, baseline);
    expect(computeModifiedMap(initial, baseline).size).toBe(0);

    const updated = makeScreen({ switchOn: true, perm: 'ask' });
    const modified = computeModifiedMap(updated, baseline);
    expect(modified.size).toBe(2);

    const switchKey = rowBaselineKey(updated.rows[0]!);
    const permKey = rowBaselineKey(updated.rows[1]!);
    expect(modified.get(switchKey)).toEqual({
      key: switchKey,
      initialValue: 'off',
      currentValue: 'on',
      resetButtonId: 'sts:auto:0',
    });
    expect(modified.get(permKey)).toEqual({
      key: permKey,
      initialValue: 'auto',
      currentValue: 'ask',
      resetButtonId: 'stp:auto',
    });

    expect(tokenizeQuery('  Auto   Reply ')).toEqual(['auto', 'reply']);
    expect(matchesSearchWords('Auto Reply setting', ['auto', 'reply'])).toBe(true);
    expect(matchesSearchWords('Auto Reply setting', ['security'])).toBe(false);
  });

  it('filters settings live in the editor with match count, clear button, modified markers, and reset action', async () => {
    const registry = new ContributionRegistry();
    const events = new WebuiEventBus();
    const storage = new StorageService();
    const topics: readonly TopicInfo[] = [{ id: 't1', title: 'Main', lastAt: 1000 }];
    const postCalls: Array<{ path: string; body: unknown }> = [];
    let bridge: SettingsPluginBridge | undefined;

    const manager = new PluginManager({
      registry,
      events,
      storage,
      api: createApiClient(),
      topics: {
        list: () => topics,
        active: () => topics[0],
        open: vi.fn(),
        insertIntoComposer: vi.fn(),
      },
    });

    manager.register(
      createSettingsPlugin({
        instrOk: false,
        listDeviceSections: () => [],
        post: async (path, body) => {
          postCalls.push({ path, body });
          return new Response('{}', { status: 200 });
        },
        onReady: (b) => {
          bridge = b;
        },
      }),
      { builtin: true },
    );
    await manager.activateAll();

    const editor = registry.getEditor('settings')!.component();
    document.body.appendChild(editor.element);
    editor.init({}, makePanelInitCtx('settings:1'));

    // Initial load establishes baseline; no items marked modified.
    bridge!.handleMessage(makeMsg(makeScreen({ switchOn: false, perm: 'auto' })));
    expect(editor.element.querySelectorAll('.set-item.is-modified').length).toBe(0);
    expect(editor.element.querySelector<HTMLButtonElement>('.wb-set-mod-filter')!.hidden).toBe(true);

    // Search by keyword filters rows and updates match count.
    const searchInput = editor.element.querySelector<HTMLInputElement>('.wb-set-search-input')!;
    const clearBtn = editor.element.querySelector<HTMLButtonElement>('.wb-set-search-clear')!;
    const countEl = editor.element.querySelector<HTMLElement>('.wb-set-search-count')!;

    searchInput.value = 'permission';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(clearBtn.hidden).toBe(false);
    expect(countEl.hidden).toBe(false);
    expect(countEl.textContent).toContain('1 / 2');
    const items = Array.from(editor.element.querySelectorAll<HTMLElement>('.set-item'));
    expect(items[0]?.hidden).toBe(true);
    expect(items[1]?.hidden).toBe(false);

    // Non-matching query displays empty state.
    searchInput.value = 'nonexistent-xyz';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editor.element.querySelector<HTMLElement>('.wb-set-search-empty')!.hidden).toBe(false);

    // Clear button restores all items.
    clearBtn.click();
    expect(searchInput.value).toBe('');
    expect(countEl.hidden).toBe(true);
    expect(items.every((el) => !el.hidden)).toBe(true);

    // Updated screen marks modified setting with left bar/badge + reset button + modified filter pill.
    bridge!.handleMessage(makeMsg(makeScreen({ switchOn: true, perm: 'auto' })));
    const modItems = editor.element.querySelectorAll<HTMLElement>('.set-item.is-modified');
    expect(modItems.length).toBe(1);
    expect(modItems[0]?.querySelector('.wb-set-mod-badge')?.textContent).toBe('Modified');

    const modFilterBtn = editor.element.querySelector<HTMLButtonElement>('.wb-set-mod-filter')!;
    expect(modFilterBtn.hidden).toBe(false);
    expect(modFilterBtn.textContent).toContain('1');

    // Toggling modified filter hides unmodified rows.
    modFilterBtn.click();
    const afterFilterItems = Array.from(editor.element.querySelectorAll<HTMLElement>('.set-item'));
    expect(afterFilterItems[0]?.hidden).toBe(false);
    expect(afterFilterItems[1]?.hidden).toBe(true);

    // Clicking Reset posts api/click with the baseline reset buttonId.
    const resetBtn = editor.element.querySelector<HTMLButtonElement>('.wb-set-reset-btn')!;
    expect(resetBtn).not.toBeNull();
    resetBtn.click();
    expect(postCalls).toContainEqual({
      path: 'api/click',
      body: { topic: 't1', messageId: 'm1', buttonId: 'sts:auto:0' },
    });

    editor.dispose();
    manager.dispose();
    events.dispose();
    registry.dispose();
  });
});
