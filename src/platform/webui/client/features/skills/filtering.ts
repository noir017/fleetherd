import type { SkillPanelEntry } from '../../../../adapter.js';
import type { FilterBarGroup, FilterBarSortDef, FilterBarState } from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import { isSkillActive } from './types.js';

export type SkillGroupId = string;

export interface SkillGroupBucket {
  readonly id: SkillGroupId;
  readonly label: string;
  readonly items: readonly SkillPanelEntry[];
}

export function buildSkillSortDef(): FilterBarSortDef {
  return {
    value: 'name',
    dir: 'asc',
    options: [
      { value: 'name', label: tr('skills.title') },
      { value: 'uses', label: tr('skills.useMany', { count: 'N' }) },
      { value: 'lastUsed', label: tr('skills.lastUsed', { ago: '' }).trim() },
      { value: 'created', label: tr('skills.created', { ago: '' }).trim() },
    ],
  };
}

export function buildSkillFilterGroups(skills: readonly SkillPanelEntry[]): FilterBarGroup[] {
  let activeCount = 0;
  let archivedCount = 0;
  let expiredCount = 0;
  let pinnedCount = 0;
  const categoryCounts = new Map<string, number>();

  for (const skill of skills) {
    if (isSkillActive(skill)) activeCount++;
    else archivedCount++;
    if (skill.status === 'expired') expiredCount++;
    if (skill.pinned) pinnedCount++;
    if (skill.category) {
      categoryCounts.set(skill.category, (categoryCounts.get(skill.category) ?? 0) + 1);
    }
  }

  const groups: FilterBarGroup[] = [
    {
      id: 'status',
      label: tr('common.filter'),
      pinned: true,
      options: [
        { value: 'active', label: tr('common.onCap'), count: activeCount },
        { value: 'archived', label: tr('common.offCap'), count: archivedCount },
        ...(expiredCount > 0 ? [{ value: 'expired', label: tr('skills.expiredCap'), count: expiredCount }] : []),
        ...(pinnedCount > 0 ? [{ value: 'pinned', label: tr('skills.pinned'), count: pinnedCount }] : []),
      ],
    },
  ];

  if (categoryCounts.size > 0) {
    const categories = [...categoryCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cat, count]) => ({ value: cat, label: cat, count }));
    groups.push({
      id: 'category',
      label: tr('skills.tabLibrary'),
      pinned: false,
      options: categories,
    });
  }

  return groups;
}

function matchesQuery(skill: SkillPanelEntry, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (skill.name.toLowerCase().includes(needle)) return true;
  if (skill.description.toLowerCase().includes(needle)) return true;
  if (skill.category && skill.category.toLowerCase().includes(needle)) return true;
  return false;
}

function matchesStatus(skill: SkillPanelEntry, statuses: readonly string[] | undefined): boolean {
  if (!statuses || statuses.length === 0) return true;
  for (const status of statuses) {
    if (status === 'active' && isSkillActive(skill)) return true;
    if (status === 'archived' && !isSkillActive(skill)) return true;
    if (status === 'expired' && skill.status === 'expired') return true;
    if (status === 'pinned' && skill.pinned) return true;
  }
  return false;
}

function matchesCategory(skill: SkillPanelEntry, categories: readonly string[] | undefined): boolean {
  if (!categories || categories.length === 0) return true;
  return Boolean(skill.category && categories.includes(skill.category));
}

function parseTs(iso: string | undefined): number {
  const ts = iso ? Date.parse(iso) : 0;
  return Number.isFinite(ts) ? ts : 0;
}

function compareSkills(a: SkillPanelEntry, b: SkillPanelEntry, sort: string, dir: 'asc' | 'desc' | ''): number {
  const mult = dir === 'desc' ? -1 : 1;
  let cmp = 0;
  if (sort === 'uses') {
    cmp = a.uses - b.uses;
  } else if (sort === 'lastUsed') {
    cmp = parseTs(a.lastUsedAt) - parseTs(b.lastUsedAt);
  } else if (sort === 'created') {
    cmp = parseTs(a.createdAt) - parseTs(b.createdAt);
  } else {
    cmp = a.name.localeCompare(b.name);
  }
  if (cmp === 0) cmp = a.name.localeCompare(b.name);
  return cmp * mult;
}

export function filterSkills(skills: readonly SkillPanelEntry[], state: FilterBarState): SkillPanelEntry[] {
  const q = state.q.trim();
  const statuses = state.sel.status;
  const categories = state.sel.category;

  const filtered = skills.filter(
    (s) =>
      matchesQuery(s, q) &&
      matchesStatus(s, statuses) &&
      matchesCategory(s, categories),
  );

  return filtered.sort((a, b) => compareSkills(a, b, state.sort, state.dir));
}

export function groupSkills(skills: readonly SkillPanelEntry[]): SkillGroupBucket[] {
  const byCategory = new Map<string, SkillPanelEntry[]>();
  const uncategorized: SkillPanelEntry[] = [];
  const archived: SkillPanelEntry[] = [];

  for (const s of skills) {
    if (!isSkillActive(s)) {
      archived.push(s);
      continue;
    }
    const cat = s.category?.trim();
    if (cat) {
      const list = byCategory.get(cat);
      if (list) list.push(s);
      else byCategory.set(cat, [s]);
    } else {
      uncategorized.push(s);
    }
  }

  const buckets: SkillGroupBucket[] = [];
  for (const [cat, items] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    buckets.push({ id: `cat:${cat}`, label: cat, items });
  }
  if (uncategorized.length > 0) {
    buckets.push({
      id: 'uncategorized',
      label: buckets.length > 0 ? tr('skills.tabLibrary') : tr('skills.title'),
      items: uncategorized,
    });
  }
  if (archived.length > 0) {
    buckets.push({
      id: 'archived',
      label: tr('skills.offSection', { count: archived.length }),
      items: archived,
    });
  }
  return buckets;
}
