import { describe, expect, it } from 'vitest';

import { buildTerminalIframeSrc, TerminalTabStore } from './tabs-store.js';

describe('features/terminal/tabs-store', () => {
  it('builds primary and extra tab iframe URLs with single topic arg', () => {
    expect(buildTerminalIframeSrc('t1', 't1:1', true)).toBe('term/?arg=t1');
    expect(buildTerminalIframeSrc('t1', 't1:2', false)).toBe('term/?arg=t1&tab=t1%3A2');
    expect(buildTerminalIframeSrc('a/b', 'a/b:2', false)).toBe('term/?arg=a%2Fb&tab=a%2Fb%3A2');
  });

  it('creates, switches, renames, closes, and prunes tabs per topic', () => {
    const store = new TerminalTabStore();

    const first = store.ensureDefaultTab('t1', 'Alpha');
    expect(first).toEqual({
      id: 't1:1',
      topicId: 't1',
      title: 'Alpha',
      customName: false,
      primary: true,
    });

    const second = store.createTab('t1', 'Alpha');
    expect(second.id).toBe('t1:2');
    expect(second.title).toBe('Alpha #2');
    expect(second.primary).toBe(false);
    expect(store.getActiveTab('t1')?.id).toBe('t1:2');

    expect(store.setActiveTab('t1', 't1:1')?.id).toBe('t1:1');
    expect(store.getActiveTab('t1')?.id).toBe('t1:1');

    // Empty/whitespace rename is rejected.
    expect(store.renameTab('t1:1', '   ')).toBeUndefined();
    expect(store.renameTab('t1:1', '  Build Shell  ')?.title).toBe('Build Shell');
    expect(store.getTab('t1:1')?.customName).toBe(true);

    // Topic title sync does not overwrite custom-named tabs.
    store.syncTopicTitle('t1', 'Renamed Topic');
    expect(store.getTab('t1:1')?.title).toBe('Build Shell');

    // Closing active tab selects adjacent remaining tab.
    const closedFirst = store.closeTab('t1:1');
    expect(closedFirst?.closed.id).toBe('t1:1');
    expect(closedFirst?.nextActive?.id).toBe('t1:2');
    expect(store.getActiveTab('t1')?.id).toBe('t1:2');

    // Closing last tab clears the topic's tab list.
    const closedSecond = store.closeTab('t1:2');
    expect(closedSecond?.closed.id).toBe('t1:2');
    expect(closedSecond?.nextActive).toBeUndefined();
    expect(store.getTabs('t1')).toHaveLength(0);

    // Pruning drops only removed topics.
    store.ensureDefaultTab('t1', 'Alpha');
    store.ensureDefaultTab('t2', 'Beta');
    const pruned = store.pruneTopics({ t1: true });
    expect(pruned.map((tab) => tab.topicId)).toEqual(['t2']);
    expect(store.getTabs('t1')).toHaveLength(1);
    expect(store.getTabs('t2')).toHaveLength(0);

    const cleared = store.clear();
    expect(cleared).toHaveLength(1);
    expect(store.getTabs('t1')).toHaveLength(0);
  });
});
