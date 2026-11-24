import { fuzzyMatch, type QuickPickItem } from '../../components/quickpick/index.js';
import type { TopicInfo } from '../../plugins/api.js';
import type { CommandEntry } from '../../services/commands.js';
import { parseKeybinding } from '../../services/keybindings.js';
import { renderPaletteIcon, type PaletteIconName } from './icons.js';
import type { KeybindingDisplayItem, KeybindingGroup, ResolvedKeybindingRow } from './types.js';

export type TranslateFn = (key: string, vars?: Record<string, unknown>) => string;

const KEY_LABELS: Readonly<Record<string, { readonly mac: string; readonly other: string }>> = {
  ' ': { mac: 'Space', other: 'Space' },
  escape: { mac: 'Esc', other: 'Esc' },
  enter: { mac: '↵', other: 'Enter' },
  tab: { mac: '⇥', other: 'Tab' },
  backspace: { mac: '⌫', other: 'Backspace' },
  delete: { mac: '⌦', other: 'Del' },
  arrowup: { mac: '↑', other: 'Up' },
  arrowdown: { mac: '↓', other: 'Down' },
  arrowleft: { mac: '←', other: 'Left' },
  arrowright: { mac: '→', other: 'Right' },
};

const CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  workbench: 'Workbench',
  palette: 'Palette',
  topics: 'Topics',
  topic: 'Topic',
  history: 'History',
  schedules: 'Schedules',
  reviews: 'Reviews',
  skills: 'Skills',
  settings: 'Settings',
  changes: 'Changes',
  files: 'Files',
  terminal: 'Terminal',
  reader: 'Reader',
  status: 'Status',
};

function formatKeyToken(key: string, isMac: boolean): string {
  const mapped = KEY_LABELS[key];
  if (mapped) return isMac ? mapped.mac : mapped.other;
  return key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1);
}

export function splitKeybindingTokens(spec: string, isMac: boolean): readonly string[] {
  try {
    const parsed = parseKeybinding(spec, isMac);
    const tokens: string[] = [];
    if (parsed.ctrl) tokens.push(isMac ? '⌃' : 'Ctrl');
    if (parsed.alt) tokens.push(isMac ? '⌥' : 'Alt');
    if (parsed.shift) tokens.push(isMac ? '⇧' : 'Shift');
    if (parsed.meta) tokens.push(isMac ? '⌘' : 'Meta');
    tokens.push(formatKeyToken(parsed.key, isMac));
    return tokens;
  } catch {
    return [spec];
  }
}

export function formatKeybinding(spec: string, isMac: boolean): string {
  const tokens = splitKeybindingTokens(spec, isMac);
  return isMac ? tokens.join('') : tokens.join('+');
}

function titleCaseWord(word: string): string {
  if (!word) return '';
  return word[0]!.toUpperCase() + word.slice(1);
}

export function inferCommandCategory(id: string): string {
  const rawPrefix = id.split('.', 1)[0]?.trim() ?? '';
  if (!rawPrefix) return 'General';
  return CATEGORY_ALIASES[rawPrefix.toLowerCase()] ?? titleCaseWord(rawPrefix);
}

export function formatCommandTitle(entry: CommandEntry): string {
  if (entry.meta?.title && entry.meta.title.trim()) {
    return entry.meta.title.trim();
  }
  const parts = entry.id.split('.');
  const tail = parts[parts.length - 1] ?? entry.id;
  const spaced = tail.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(' ');
}

function topicPriority(topic: TopicInfo, activeId: string | undefined): number {
  if (topic.id === activeId) return 0;
  if (topic.asking || topic.running) return 1;
  if (topic.starred) return 2;
  return 3;
}

function topicGroupLabel(topic: TopicInfo, activeId: string | undefined, t: TranslateFn): string {
  if (topic.id === activeId) return t('palette.groupActive');
  if (topic.asking || topic.running) return t('palette.groupRunning');
  if (topic.starred) return t('palette.groupStarred');
  return t('palette.groupRecent');
}

function topicIconName(topic: TopicInfo): PaletteIconName {
  if (topic.asking) return 'asking';
  if (topic.running) return 'running';
  if (topic.starred) return 'star';
  return 'topic';
}

function buildTopicDescription(topic: TopicInfo): string | undefined {
  const parts: string[] = [];
  if (topic.dir?.host) parts.push(topic.dir.host);
  if (topic.dir?.name) parts.push(topic.dir.name);
  if (topic.agent?.harness) {
    parts.push(topic.agent.id && topic.agent.id !== topic.agent.harness
      ? `${topic.agent.id} (${topic.agent.harness})`
      : topic.agent.harness);
  } else if (topic.agent?.id) {
    parts.push(topic.agent.id);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function buildTopicStatusParts(topic: TopicInfo, activeId: string | undefined, t: TranslateFn): string[] {
  const badges: string[] = [];
  if (topic.id === activeId) badges.push(t('palette.statusCurrent'));
  if (topic.asking) badges.push(t('palette.statusAsking'));
  else if (topic.running) badges.push(t('palette.statusRunning'));
  else if (topic.live) badges.push(t('palette.statusLive'));
  if (topic.starred) badges.push(t('palette.statusStarred'));
  if (topic.scheduled) badges.push(t('palette.statusScheduled'));
  return badges;
}

function buildTopicDetail(topic: TopicInfo, activeId: string | undefined, t: TranslateFn): string | undefined {
  const parts = buildTopicStatusParts(topic, activeId, t);
  const preview = topic.last?.trim();
  if (preview) {
    parts.push(preview.length > 80 ? `${preview.slice(0, 79)}…` : preview);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function buildTopicKeywords(topic: TopicInfo): readonly string[] {
  const words: string[] = [topic.id];
  if (topic.dir?.host) words.push(topic.dir.host);
  if (topic.dir?.name) words.push(topic.dir.name);
  if (topic.dir?.path) words.push(topic.dir.path);
  if (topic.agent?.id) words.push(topic.agent.id);
  if (topic.agent?.harness) words.push(topic.agent.harness);
  if (topic.stage) words.push(topic.stage);
  if (topic.task) words.push(topic.task);
  if (topic.running) words.push('running');
  if (topic.asking) words.push('asking');
  if (topic.starred) words.push('starred');
  if (topic.scheduled) words.push('scheduled');
  return words;
}

export function buildTopicQuickPickItems(
  topics: readonly TopicInfo[],
  activeId: string | undefined,
  t: TranslateFn,
): QuickPickItem<TopicInfo>[] {
  const sorted = [...topics].sort((a, b) => {
    const priDiff = topicPriority(a, activeId) - topicPriority(b, activeId);
    if (priDiff !== 0) return priDiff;
    return b.lastAt - a.lastAt;
  });

  return sorted.map((topic) => ({
    id: topic.id,
    label: topic.title.trim() || topic.id,
    description: buildTopicDescription(topic),
    detail: buildTopicDetail(topic, activeId, t),
    group: topicGroupLabel(topic, activeId, t),
    keywords: buildTopicKeywords(topic),
    icon: renderPaletteIcon(topicIconName(topic), `fh-palette-topic-ic${topic.running ? ' is-running' : ''}${topic.asking ? ' is-asking' : ''}`),
    shortcut: topic.id === activeId ? t('palette.statusCurrent') : undefined,
    data: topic,
  }));
}

export function buildCommandQuickPickItems(
  entries: readonly CommandEntry[],
  isMac: boolean,
): QuickPickItem<CommandEntry>[] {
  const normalized = entries.map((entry) => {
    const category = entry.meta?.category?.trim() || inferCommandCategory(entry.id);
    const title = formatCommandTitle(entry);
    const shortcut = entry.meta?.keybinding ? formatKeybinding(entry.meta.keybinding, isMac) : undefined;
    return { entry, category, title, shortcut };
  });

  normalized.sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category);
    if (catCmp !== 0) return catCmp;
    return a.title.localeCompare(b.title);
  });

  return normalized.map(({ entry, category, title, shortcut }) => ({
    id: entry.id,
    label: title,
    description: entry.id,
    group: category,
    keywords: [
      entry.id,
      category,
      ...(entry.meta?.keybinding ? [entry.meta.keybinding] : []),
      ...(shortcut ? [shortcut] : []),
    ],
    shortcut,
    data: entry,
  }));
}

function matchesKeybindingQuery(row: ResolvedKeybindingRow, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const hay = `${row.title} ${row.category} ${row.command} ${row.keybinding} ${row.display}`;
  return fuzzyMatch(q, hay) !== null;
}

export function collectKeybindingGroups(
  entries: readonly CommandEntry[],
  extra: readonly KeybindingDisplayItem[],
  query: string,
  isMac: boolean,
): KeybindingGroup[] {
  const seen = new Set<string>();
  const rows: ResolvedKeybindingRow[] = [];

  const pushRow = (
    command: string,
    keybinding: string,
    title: string,
    category: string,
  ): void => {
    const dedupKey = `${command}\0${keybinding.toLowerCase()}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    rows.push({
      command,
      title,
      category,
      keybinding,
      display: formatKeybinding(keybinding, isMac),
      tokens: splitKeybindingTokens(keybinding, isMac),
    });
  };

  for (const entry of entries) {
    if (!entry.meta?.keybinding) continue;
    const category = entry.meta.category?.trim() || inferCommandCategory(entry.id);
    pushRow(entry.id, entry.meta.keybinding, formatCommandTitle(entry), category);
  }

  for (const item of extra) {
    if (!item.keybinding) continue;
    const category = item.category?.trim() || inferCommandCategory(item.command);
    const title = item.title?.trim() || formatCommandTitle({ id: item.command, run: () => undefined });
    pushRow(item.command, item.keybinding, title, category);
  }

  const filtered = rows.filter((row) => matchesKeybindingQuery(row, query));
  filtered.sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category);
    if (catCmp !== 0) return catCmp;
    return a.title.localeCompare(b.title);
  });

  const groups: KeybindingGroup[] = [];
  let currentCategory: string | undefined;
  let currentItems: ResolvedKeybindingRow[] = [];

  for (const row of filtered) {
    if (row.category !== currentCategory) {
      currentCategory = row.category;
      currentItems = [];
      groups.push({ category: currentCategory, items: currentItems });
    }
    currentItems.push(row);
  }

  return groups;
}
