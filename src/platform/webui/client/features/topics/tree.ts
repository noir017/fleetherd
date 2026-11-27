import { t as tr, type MessageKey } from '../../i18n/index.js';
import { text } from '../../services/api.js';
import { subtreeRun } from './age.js';
import type {
  FilterBarGroup,
  FilterBarOption,
  FilterBarState,
  SplitTitleResult,
  Topic,
  TopicAgentDisplay,
  TopicConversation,
  TopicForest,
  TopicRowsResult,
  TopicTree,
  TreeRow,
  TreeWalker,
} from './types.js';

export const NEEDS_ORDER: Readonly<Record<string, number>> = {
  answer: 0,
  failed: 1,
  review: 2,
};

export const NEEDS_WHAT: Readonly<Record<string, MessageKey>> = {
  answer: 'topic.needsAnswer',
  failed: 'topic.needsFailed',
  review: 'topic.needsReview',
};

export const STATE_KEYS = ['needs', 'running', 'idle', 'none'] as const;

export function runOwners(topics: readonly Topic[]): Record<string, string> {
  const byId: Record<string, Topic> = {};
  const out: Record<string, string> = {};
  for (const t of topics) byId[t.id] = t;
  for (const start of topics) {
    let cur: Topic | undefined = start;
    let hops = 0;
    while (cur && hops++ < 32) {
      if (cur.scheduled) {
        out[start.id] = cur.id;
        break;
      }
      if (!cur.parent || cur.parent === cur.id) break;
      cur = byId[cur.parent];
    }
  }
  return out;
}

export function topicTree(list: readonly Topic[]): TopicTree {
  const byId: Record<string, Topic> = {};
  const kids: Record<string, Topic[]> = {};
  const forks: Record<string, Topic[]> = {};
  const roots: Topic[] = [];
  for (const item of list) byId[item.id] = item;
  for (const item of list) {
    const p = item.parent;
    const f = item.forkOf;
    if (p && p !== item.id && byId[p]) {
      (kids[p] ??= []).push(item);
    } else if (f && f !== item.id && byId[f]) {
      (forks[f] ??= []).push(item);
    } else {
      roots.push(item);
    }
  }
  return { visible: [...list], byId, kids, forks, roots };
}

export function hangsOff(t: Topic, byId: Readonly<Record<string, Topic>>): string | null {
  if (t.parent && byId[t.parent]) return t.parent;
  if (t.forkOf && byId[t.forkOf]) return t.forkOf;
  return null;
}

function highestUnderState(
  t: Topic,
  kids: Readonly<Record<string, Topic[]>>,
  depth: number,
): string {
  const ch = kids[t.id] ?? [];
  let state = '';
  for (let k = 0; k < ch.length && depth < 32; k++) {
    const c = ch[k];
    if (!c) continue;
    const mine = c.asking ? 'asking' : c.stage === 'failed' ? 'failed' : c.running ? 'running' : '';
    const deeper = highestUnderState(c, kids, depth + 1);
    const pick = [mine, deeper, state];
    state = pick.includes('asking')
      ? 'asking'
      : pick.includes('failed')
        ? 'failed'
        : pick.includes('running')
          ? 'running'
          : '';
  }
  return state;
}

function collectForcedOpen(
  activeTopicId: string,
  byId: Readonly<Record<string, Topic>>,
): Record<string, boolean> {
  const open: Record<string, boolean> = {};
  let up: Topic | undefined = byId[activeTopicId];
  let hops = 0;
  let next: string | null = null;
  while (up && (next = hangsOff(up, byId)) && hops++ < 32) {
    if (up.parent === next) open[next] = true;
    up = byId[next];
  }
  return open;
}

export function createTreeWalker(
  tree: TopicTree,
  activeTopicId: string,
  folded: Readonly<Record<string, boolean>>,
): TreeWalker {
  const { byId, kids } = tree;
  const forks = tree.forks ?? {};
  const open = collectForcedOpen(activeTopicId, byId);
  const rows: TreeRow[] = [];
  const seen: Record<string, boolean> = {};

  function walk(t: Topic, depth: number): void {
    if (seen[t.id]) return;
    seen[t.id] = true;
    const ch = kids[t.id] ?? [];
    const shut = ch.length > 0 && folded[t.id] !== false && !open[t.id];
    rows.push({
      t,
      depth,
      kids: ch.length,
      shut,
      under: shut ? highestUnderState(t, kids, 0) : '',
    });
    if (!shut) {
      for (const child of ch) walk(child, depth + 1);
    }
    const fk = forks[t.id] ?? [];
    for (const fork of fk) walk(fork, depth);
  }

  function rest(keep?: Readonly<Record<string, unknown>> | null): void {
    for (const item of tree.visible) {
      if (keep && !keep[item.id]) continue;
      let hidden = false;
      let ancestor: Topic | undefined = item;
      let n = 0;
      let by: string | null = null;
      while (ancestor && (by = hangsOff(ancestor, byId)) && n++ < 32) {
        if (ancestor.parent === by && seen[by] && folded[by] !== false && !open[by]) {
          hidden = true;
          break;
        }
        ancestor = byId[by];
      }
      if (!seen[item.id] && !hidden) walk(item, 0);
    }
  }

  return { rows, walk, rest };
}

export function busyBelow(id: string, topics: readonly Topic[]): boolean {
  return subtreeRun(id, topics).busy;
}

export function rowRunning(t: Topic, topics: readonly Topic[]): boolean {
  return Boolean(t.running) || busyBelow(t.id, topics);
}

export function needsYou(t: Topic, activeTopicId: string): boolean {
  if (t.id === activeTopicId || !t.stage || NEEDS_ORDER[t.stage] === undefined) return false;
  return !t.parent || t.stage === 'answer';
}

export function stateRank(t: Topic, topics: readonly Topic[], activeTopicId: string): number {
  if (needsYou(t, activeTopicId)) return 0;
  if (rowRunning(t, topics)) return 1;
  return t.live ? 2 : 3;
}

export function listRank(t: Topic, topics: readonly Topic[], activeTopicId: string): number {
  const r = stateRank(t, topics, activeTopicId);
  return r === 0 ? 0 : !t.title ? 1 : r + 1;
}

export function splitTitle(title: string): SplitTitleResult {
  const m = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(title);
  if (!m) return { tag: '', rest: title };
  return { tag: m[1] ?? '', rest: m[2] ?? '' };
}

export function agentOf(t: Topic): TopicAgentDisplay | null {
  let id = '';
  let harness = '';
  if (t.agent && t.agent.id) {
    id = t.agent.id;
    harness = t.agent.harness || '';
  } else {
    id = splitTitle(t.title || '').tag;
  }
  if (!id) return null;
  const host = t.dir && t.dir.host;
  const at = id.indexOf('@');
  const label = at > 0 && host && id.slice(at + 1) === host ? id.slice(0, at) : id;
  return { id, label, harness };
}

export function agentTagHtml(t: Topic): string {
  const a = agentOf(t);
  if (!a) return '';
  return `<span class="agent-tag${a.harness ? ` h-${text(a.harness)}` : ''}" title="${text(`Agent: ${a.id}`)}">${text(a.label)}</span>`;
}

export function buildTopicForest(topics: readonly Topic[], activeTopicId: string): TopicForest {
  const runs = runOwners(topics);
  const list = topics.filter((t) => !runs[t.id]);
  const tree = topicTree(list);
  const convs: Record<string, TopicConversation> = {};
  const convOrder: string[] = [];
  const seen: Record<string, boolean> = {};

  function mark(t: Topic, id: string): void {
    if (seen[t.id]) return;
    seen[t.id] = true;
    const c = convs[id];
    if (!c) return;
    const rank = stateRank(t, topics, activeTopicId);
    c.members.push(t);
    if (rank < c.rank) c.rank = rank;
    if (t.starred) c.starred = true;
    const agent = agentOf(t);
    if (agent) c.agents[agent.label] = true;
    c.hosts[t.dir && t.dir.host ? t.dir.host : '__local'] = true;
    const ch = [...(tree.kids[t.id] ?? []), ...(tree.forks[t.id] ?? [])];
    for (const child of ch) mark(child, id);
  }

  function start(t: Topic): void {
    if (seen[t.id]) return;
    convs[t.id] = { members: [], rank: 3, starred: false, agents: {}, hosts: {} };
    convOrder.push(t.id);
    mark(t, t.id);
  }

  for (const r of tree.roots) start(r);
  for (const v of tree.visible) start(v);
  return { ...tree, convs, convOrder };
}

export function buildTabForest(full: TopicForest, tab: string): TopicForest {
  const isStarredTab = tab === 'starred';
  const convs: Record<string, TopicConversation> = {};
  const convOrder: string[] = [];
  const keepId: Record<string, boolean> = {};
  const byId: Record<string, Topic> = {};

  for (const cid of full.convOrder) {
    const c = full.convs[cid];
    if (!c) continue;
    if (isStarredTab ? !c.starred : c.starred && c.rank >= 3) continue;
    convs[cid] = c;
    convOrder.push(cid);
    for (const member of c.members) {
      keepId[member.id] = true;
      byId[member.id] = member;
    }
  }

  return {
    visible: full.visible.filter((t) => Boolean(keepId[t.id])),
    byId,
    roots: full.roots.filter((t) => Boolean(keepId[t.id])),
    kids: full.kids,
    forks: full.forks,
    convs,
    convOrder,
  };
}

function countForestGroups(
  forest: TopicForest,
  stateOpts: FilterBarOption[],
  starredOpts: FilterBarOption[],
): { agents: Record<string, number>; hosts: Record<string, number> } {
  const agents: Record<string, number> = {};
  const hosts: Record<string, number> = {};

  for (const t of forest.visible) {
    const who = agentOf(t);
    if (who && agents[who.label] === undefined) agents[who.label] = 0;
    const host = t.dir && t.dir.host ? t.dir.host : '__local';
    if (hosts[host] === undefined) hosts[host] = 0;
  }

  for (const cid of forest.convOrder) {
    const c = forest.convs[cid];
    if (!c) continue;
    const stateOpt = stateOpts[c.rank];
    if (stateOpt && typeof stateOpt.count === 'number') stateOpt.count++;
    const starTarget = c.starred ? starredOpts[0] : starredOpts[1];
    if (starTarget && typeof starTarget.count === 'number') starTarget.count++;
    for (const a of Object.keys(c.agents)) agents[a] = (agents[a] ?? 0) + 1;
    for (const h of Object.keys(c.hosts)) hosts[h] = (hosts[h] ?? 0) + 1;
  }
  return { agents, hosts };
}

export function buildTopicFilterGroups(
  forest: TopicForest,
  tab: string,
): { groups: FilterBarGroup[]; total: number } {
  const stateOpts: FilterBarOption[] = [
    { value: 'needs', label: tr('filter.needsYou'), short: tr('filter.needsShort'), icon: 'bell', count: 0 },
    { value: 'running', label: tr('filter.running'), short: tr('filter.runShort'), icon: 'play', count: 0 },
    { value: 'idle', label: tr('filter.idle'), short: tr('filter.idle'), icon: 'dot', count: 0 },
    { value: 'none', label: tr('filter.noAgent'), short: tr('filter.noneShort'), icon: 'offline', count: 0 },
  ];
  const starredOpts: FilterBarOption[] = [
    { value: 'starred', label: tr('filter.starred'), icon: 'star', count: 0 },
    { value: 'plain', label: tr('filter.unstarred'), count: 0 },
  ];
  const { agents, hosts } = countForestGroups(forest, stateOpts, starredOpts);

  const agentOpts: FilterBarOption[] = Object.keys(agents)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((a) => ({ value: a, label: a, count: agents[a] ?? 0 }));
  const hostOpts: FilterBarOption[] = Object.keys(hosts)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((hv) => ({
      value: hv,
      label: hv === '__local' ? tr('filter.local') : hv,
      icon: 'globe',
      count: hosts[hv] ?? 0,
    }));

  const groups: FilterBarGroup[] = [
    { id: 'state', label: tr('filter.state'), options: stateOpts },
  ];
  if (tab !== 'starred') groups.push({ id: 'starred', label: tr('filter.starred'), options: starredOpts });
  if (agentOpts.length) groups.push({ id: 'agent', label: tr('filter.agent'), options: agentOpts });
  groups.push({ id: 'host', label: tr('filter.host'), options: hostOpts });
  return { groups, total: forest.convOrder.length };
}

export function topicHay(t: Topic): string {
  const agent = agentOf(t);
  let hay = `${t.title || ''} ${agent ? agent.id : ''}`;
  if (t.dir) hay += ` ${t.dir.name || ''} ${t.dir.path || ''} ${t.dir.host || ''}`;
  return hay.toLowerCase();
}

function matchesSelection(
  conv: TopicConversation,
  sel: Readonly<Record<string, readonly string[] | undefined>>,
): boolean {
  const stateSel = sel.state;
  const rankKey = STATE_KEYS[conv.rank];
  if (stateSel && stateSel.length && (!rankKey || !stateSel.includes(rankKey))) return false;
  const starSel = sel.starred;
  if (starSel && starSel.length && !starSel.includes(conv.starred ? 'starred' : 'plain')) return false;
  const agentSel = sel.agent;
  if (agentSel && agentSel.length) {
    if (!Object.keys(conv.agents).some((a) => agentSel.includes(a))) return false;
  }
  const hostSel = sel.host;
  if (hostSel && hostSel.length) {
    if (!Object.keys(conv.hosts).some((h) => hostSel.includes(h))) return false;
  }
  return true;
}

export function convMatch(
  conv: TopicConversation,
  words: readonly string[],
  sel: Readonly<Record<string, readonly string[] | undefined>>,
): boolean {
  if (!matchesSelection(conv, sel)) return false;
  if (!words.length) return true;
  for (const member of conv.members) {
    const hay = topicHay(member);
    if (words.every((w) => hay.includes(w))) return true;
  }
  return false;
}

function filterForestConversations(
  forest: TopicForest,
  filterState: FilterBarState | null,
): { keep: Record<string, number> | null; matched: number; filtering: boolean } {
  if (!filterState) return { keep: null, matched: forest.convOrder.length, filtering: false };
  const anySel = Object.values(filterState.sel).some((vals) => Boolean(vals && vals.length));
  if (!filterState.q.trim() && !anySel) {
    return { keep: null, matched: forest.convOrder.length, filtering: false };
  }
  const words = filterState.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const keep: Record<string, number> = {};
  let matched = 0;
  for (const cid of forest.convOrder) {
    const conv = forest.convs[cid];
    if (!conv || !convMatch(conv, words, filterState.sel)) continue;
    matched++;
    for (const m of conv.members) keep[m.id] = 1;
  }
  return { keep, matched, filtering: true };
}

export function buildTopicRows(
  forest: TopicForest,
  topics: readonly Topic[],
  activeTopicId: string,
  folded: Readonly<Record<string, boolean>>,
  filterState: FilterBarState | null,
): TopicRowsResult {
  const { keep, matched, filtering } = filterForestConversations(forest, filterState);
  const walker = createTreeWalker(forest, activeTopicId, folded);
  const dividers: Record<number, boolean> = {};

  const pinned = forest.visible
    .filter((t) => (!keep || Boolean(keep[t.id])) && needsYou(t, activeTopicId))
    .sort((a, b) => {
      const oa = a.stage ? (NEEDS_ORDER[a.stage] ?? 99) : 99;
      const ob = b.stage ? (NEEDS_ORDER[b.stage] ?? 99) : 99;
      return oa - ob || (b.lastAt || 0) - (a.lastAt || 0);
    });
  for (const p of pinned) walker.walk(p, 0);

  const afterPinned = walker.rows.length;
  const candidates = keep ? forest.roots.filter((r) => Boolean(keep[r.id])) : forest.roots;
  const ordered = candidates.slice().sort((a, b) => {
    const ra = listRank(a, topics, activeTopicId);
    const rb = listRank(b, topics, activeTopicId);
    let d = ra - rb;
    if (d) return d;
    if (ra === 0) {
      const oa = a.stage ? (NEEDS_ORDER[a.stage] ?? 99) : 99;
      const ob = b.stage ? (NEEDS_ORDER[b.stage] ?? 99) : 99;
      d = oa - ob;
    }
    return d || (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
  });
  for (const r of ordered) walker.walk(r, 0);
  walker.rest(keep);

  if (afterPinned && afterPinned < walker.rows.length) dividers[afterPinned] = true;
  let stars = 0;
  for (const v of forest.visible) if (v.starred) stars++;
  return {
    rows: walker.rows,
    dividers,
    stars,
    matched,
    total: forest.convOrder.length,
    filtering,
  };
}

export function subtreeOf(id: string, topics: readonly Topic[]): Topic[] {
  const byId: Record<string, Topic> = {};
  for (const t of topics) byId[t.id] = t;
  const out: Topic[] = [];
  const seen: Record<string, boolean> = {};
  const stack: string[] = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || seen[cur]) continue;
    seen[cur] = true;
    const t = byId[cur];
    if (t) out.push(t);
    const kids: string[] = [];
    for (const item of topics) if (item.parent === cur) kids.push(item.id);
    for (let j = kids.length - 1; j >= 0; j--) {
      const kid = kids[j];
      if (kid) stack.push(kid);
    }
  }
  return out;
}

export function idleTopics(topics: readonly Topic[]): Topic[] {
  const starred: Topic[] = [];
  const rest: Topic[] = [];
  for (const t of topics) {
    if (!t.live || t.running || t.asking || busyBelow(t.id, topics)) continue;
    (t.starred ? starred : rest).push(t);
  }
  return starred.concat(rest);
}
