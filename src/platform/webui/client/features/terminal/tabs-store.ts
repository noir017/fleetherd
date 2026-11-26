export interface TerminalTab {
  readonly id: string;
  readonly topicId: string;
  readonly title: string;
  readonly customName: boolean;
  readonly primary: boolean;
}

export interface CloseTabResult {
  readonly closed: TerminalTab;
  readonly nextActive: TerminalTab | undefined;
}

export function buildTerminalIframeSrc(topicId: string, tabId: string, primary: boolean): string {
  const base = `term/?arg=${encodeURIComponent(topicId)}`;
  return primary ? base : `${base}&tab=${encodeURIComponent(tabId)}`;
}

export class TerminalTabStore {
  private readonly _tabsByTopic = new Map<string, TerminalTab[]>();
  private readonly _activeByTopic = new Map<string, string>();
  private readonly _seqByTopic = new Map<string, number>();

  getTabs(topicId: string): readonly TerminalTab[] {
    return this._tabsByTopic.get(topicId) ?? [];
  }

  getActiveTab(topicId: string): TerminalTab | undefined {
    const list = this._tabsByTopic.get(topicId);
    if (!list || list.length === 0) return undefined;
    const activeId = this._activeByTopic.get(topicId);
    if (activeId) {
      const match = list.find((tab) => tab.id === activeId);
      if (match) return match;
    }
    const fallback = list[0];
    if (fallback) this._activeByTopic.set(topicId, fallback.id);
    return fallback;
  }

  getTab(tabId: string): TerminalTab | undefined {
    for (const list of this._tabsByTopic.values()) {
      const found = list.find((tab) => tab.id === tabId);
      if (found) return found;
    }
    return undefined;
  }

  ensureDefaultTab(topicId: string, defaultTitle: string): TerminalTab {
    const existing = this.getActiveTab(topicId);
    if (existing) {
      this.syncTopicTitle(topicId, defaultTitle);
      return this.getActiveTab(topicId) ?? existing;
    }
    return this.createTab(topicId, defaultTitle);
  }

  createTab(topicId: string, baseTitle: string): TerminalTab {
    const list = this._tabsByTopic.get(topicId) ?? [];
    const nextSeq = (this._seqByTopic.get(topicId) ?? 0) + 1;
    this._seqByTopic.set(topicId, nextSeq);

    const isFirst = list.length === 0;
    const primary = isFirst && nextSeq === 1;
    const title = isFirst ? baseTitle : `${baseTitle} #${nextSeq}`;
    const tab: TerminalTab = {
      id: `${topicId}:${nextSeq}`,
      topicId,
      title,
      customName: false,
      primary,
    };

    const nextList = [...list, tab];
    this._tabsByTopic.set(topicId, nextList);
    this._activeByTopic.set(topicId, tab.id);
    return tab;
  }

  setActiveTab(topicId: string, tabId: string): TerminalTab | undefined {
    const list = this._tabsByTopic.get(topicId);
    if (!list) return undefined;
    const target = list.find((tab) => tab.id === tabId);
    if (!target) return undefined;
    this._activeByTopic.set(topicId, target.id);
    return target;
  }

  renameTab(tabId: string, rawTitle: string): TerminalTab | undefined {
    const trimmed = rawTitle.trim();
    if (!trimmed) return undefined;
    for (const [topicId, list] of this._tabsByTopic.entries()) {
      const idx = list.findIndex((tab) => tab.id === tabId);
      if (idx < 0) continue;
      const prev = list[idx];
      if (!prev) continue;
      const updated: TerminalTab = { ...prev, title: trimmed, customName: true };
      const nextList = [...list];
      nextList[idx] = updated;
      this._tabsByTopic.set(topicId, nextList);
      return updated;
    }
    return undefined;
  }

  closeTab(tabId: string): CloseTabResult | undefined {
    for (const [topicId, list] of this._tabsByTopic.entries()) {
      const idx = list.findIndex((tab) => tab.id === tabId);
      if (idx < 0) continue;
      const closed = list[idx];
      if (!closed) continue;
      const nextList = list.filter((tab) => tab.id !== tabId);
      if (nextList.length === 0) {
        this._tabsByTopic.delete(topicId);
        this._activeByTopic.delete(topicId);
        return { closed, nextActive: undefined };
      }
      this._tabsByTopic.set(topicId, nextList);
      const currentActive = this._activeByTopic.get(topicId);
      if (currentActive === tabId) {
        const nextIdx = Math.min(idx, nextList.length - 1);
        const nextActive = nextList[nextIdx];
        if (nextActive) this._activeByTopic.set(topicId, nextActive.id);
        return { closed, nextActive };
      }
      return { closed, nextActive: this.getActiveTab(topicId) };
    }
    return undefined;
  }

  syncTopicTitle(topicId: string, title: string): void {
    const list = this._tabsByTopic.get(topicId);
    if (!list || list.length === 0) return;
    let changed = false;
    const nextList = list.map((tab) => {
      if (tab.customName || !tab.primary) return tab;
      if (tab.title === title) return tab;
      changed = true;
      return { ...tab, title };
    });
    if (changed) this._tabsByTopic.set(topicId, nextList);
  }

  dropTopic(topicId: string): readonly TerminalTab[] {
    const removed = this._tabsByTopic.get(topicId) ?? [];
    this._tabsByTopic.delete(topicId);
    this._activeByTopic.delete(topicId);
    this._seqByTopic.delete(topicId);
    return removed;
  }

  pruneTopics(keep: Readonly<Record<string, unknown>>): readonly TerminalTab[] {
    const removed: TerminalTab[] = [];
    for (const topicId of Array.from(this._tabsByTopic.keys())) {
      if (keep[topicId]) continue;
      removed.push(...this.dropTopic(topicId));
    }
    return removed;
  }

  clear(): readonly TerminalTab[] {
    const removed: TerminalTab[] = [];
    for (const list of this._tabsByTopic.values()) {
      removed.push(...list);
    }
    this._tabsByTopic.clear();
    this._activeByTopic.clear();
    this._seqByTopic.clear();
    return removed;
  }
}
