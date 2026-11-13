import type { AgentDef } from '../config/schema.js';
import type { AgentCatalog, OfflineMachine } from '../types.js';
import { parseButtonId, formatButtonId } from './button-id.js';
import { shortModelName } from './runtime-footer.js';
import { pageCount, pageSlice, truncateLabel, wrapPage } from './paging.js';

/**
 * `/agent` as data: which agents there are, grouped, as a two-level button menu and as text.
 *
 * ── Why a menu of agents at all ───────────────────────────────────────────────
 * The agent commands (`/cc`, `/oc`) are keyed by HARNESS (core/command-translate.ts), which was
 * enough while every agent ran on this machine: one Claude Code was all there was. With agents on
 * other machines (`agents[].host`) a deployment has two of the same harness as a matter of course —
 * Claude Code here and Claude Code on the build box — and `/cc` can only ever name the first. This
 * menu names agents by id, so every one of them is reachable from a phone.
 *
 * ── Why grouped ───────────────────────────────────────────────────────────────
 * A flat list of N machines × M harnesses is unreadable at a glance, and the question a user is
 * answering is two questions anyway: which machine, then which agent on it. So the first level
 * lists groups and the second their agents. A group is `agents[].group`, else the agent's host,
 * else the gateway's own machine. With one group the first level is skipped: a question with one
 * answer is not a question.
 *
 * Pure, like the other menus here (workdir-menu.ts, model-menu.ts): the posting, the pending-menu
 * state and the binding itself live in daemon/.
 */

/** The group of agents that run on the gateway's own machine and name no group of their own. */
export const LOCAL_GROUP = 'this machine';

export interface AgentGroup {
  name: string;
  agents: AgentDef[];
  /** Every agent in it runs on a host the gateway cannot reach right now (offlinePlaces). */
  offline?: true;
}

/** What the menus say after an offline machine's name. */
const OFFLINE_NOTE = 'offline';

/** What an agent is grouped under (see the header). */
export function agentGroupOf(def: AgentDef): string {
  return agentPlaceOf(def) ?? LOCAL_GROUP;
}

/**
 * The name of where an agent runs, when there is one to give: its group, else its host. An agent
 * on the gateway's own machine that names no group has none — the web UI's topic list, which shows
 * this beside each topic's directory, has nothing worth saying about it, and `LOCAL_GROUP` is a
 * menu heading rather than a name. One function so the list and the `/agent` menu cannot call the
 * same machine two different things.
 */
export function agentPlaceOf(def: AgentDef): string | undefined {
  return def.group ?? def.host;
}

/**
 * Agents by group, groups in the order their first agent appears in config.yaml. A group named in
 * `offline` (offlinePlaces' names) is marked, so every menu built from it says so.
 */
export function agentGroups(agents: readonly AgentDef[], offline?: ReadonlySet<string>): AgentGroup[] {
  const groups = new Map<string, AgentDef[]>();
  for (const def of agents) {
    const name = agentGroupOf(def);
    groups.set(name, [...(groups.get(name) ?? []), def]);
  }
  return [...groups].map(([name, list]) => ({ name, agents: list, ...(offline?.has(name) ? { offline: true as const } : {}) }));
}

/**
 * The machines, by the name agentPlaceOf gives them, that cannot be reached: those whose every
 * agent runs on a host in `offlineHosts` (host id → since when). A place with an agent elsewhere —
 * a `group` spanning two hosts, or one with an agent on this machine — still has someone to answer,
 * so it is not listed. `since` is when the last of its hosts went: the place has been unreachable
 * as a whole only from then. In config order, like the groups.
 */
export function offlinePlaces(agents: readonly AgentDef[], offlineHosts: ReadonlyMap<string, number>): OfflineMachine[] {
  const places = new Map<string, number | undefined>();
  for (const def of agents) {
    const name = agentPlaceOf(def);
    if (name === undefined) continue;
    const since = def.host ? offlineHosts.get(def.host) : undefined;
    const seen = places.has(name) ? places.get(name) : 0;
    // undefined marks a place with an agent that can be reached; it stays that way.
    places.set(name, seen === undefined || since === undefined ? undefined : Math.max(seen, since));
  }
  return [...places].flatMap(([name, since]) => (since === undefined ? [] : [{ name, since }]));
}

/** Choose a group: `agg:<reqId>:<group index>`. */
export const AGENT_GROUP_PREFIX = 'agg:';
/** Choose an agent: `aga:<reqId>:<index into the flat agent list>`. */
export const AGENT_PICK_PREFIX = 'aga:';
/** Back to the groups: `agb:<reqId>:0`. */
export const AGENT_BACK_PREFIX = 'agb:';
/** Turn the page within a group: `agp:<reqId>:<group index * 1000 + page>`. */
export const AGENT_PAGE_PREFIX = 'agp:';

export type AgentButtonClick =
  | { kind: 'group'; reqId: string; group: number }
  | { kind: 'pick'; reqId: string; index: number }
  | { kind: 'back'; reqId: string }
  | { kind: 'page'; reqId: string; group: number; page: number };

export function parseAgentButtonId(id: string): AgentButtonClick | null {
  const group = parseButtonId(id, AGENT_GROUP_PREFIX);
  if (group) return { kind: 'group', reqId: group.reqId, group: group.n };
  const pick = parseButtonId(id, AGENT_PICK_PREFIX);
  if (pick) return { kind: 'pick', reqId: pick.reqId, index: pick.n };
  const back = parseButtonId(id, AGENT_BACK_PREFIX);
  if (back) return { kind: 'back', reqId: back.reqId };
  const page = parseButtonId(id, AGENT_PAGE_PREFIX);
  if (page) return { kind: 'page', reqId: page.reqId, group: Math.floor(page.n / 1000), page: page.n % 1000 };
  return null;
}

/** Marks the agent answering this conversation now. */
const CURRENT_MARK = '● ';

export interface AgentMenuView {
  text: string;
  buttons: Array<{ id: string; label: string }>;
}

function agentLabel(def: AgentDef, current: string | undefined): string {
  const harness = def.harness === 'custom' ? '' : ` · ${def.harness}`;
  return truncateLabel(`${def.id === current ? CURRENT_MARK : ''}${def.id}${harness}`);
}

/**
 * One screen of the menu: the groups (`group` undefined, and more than one group), or one group's
 * agents. `flat` is every agent in menu order — group by group — which is what a pick's index
 * points into, so a click resolves to the same agent whichever page it was on.
 *
 * `purpose: 'retry'` is the same menu asking which agent a failed turn goes to (core/turn-retry.ts)
 * rather than which one answers the topic — the daemon decides what the pick does.
 */
export function buildAgentMenu(opts: {
  reqId: string;
  groups: readonly AgentGroup[];
  current: string | undefined;
  group?: number;
  page?: number;
  pageSize: number;
  purpose?: 'answer' | 'retry';
}): AgentMenuView {
  const { reqId, groups, current, pageSize } = opts;
  const currentGroup = groups.findIndex((g) => g.agents.some((a) => a.id === current));
  if (opts.group === undefined && groups.length > 1) {
    return {
      text: `Which machine? ${current ? `(now: ${current})` : ''}`.trim(),
      buttons: groups.map((g, i) => ({
        id: formatButtonId(AGENT_GROUP_PREFIX, reqId, i),
        label: truncateLabel(`${i === currentGroup ? CURRENT_MARK : ''}${g.name} (${g.agents.length})${g.offline ? ` · ${OFFLINE_NOTE}` : ''}`),
      })),
    };
  }
  const gi = Math.min(Math.max(opts.group ?? 0, 0), groups.length - 1);
  const group = groups[gi]!;
  const offset = groups.slice(0, gi).reduce((n, g) => n + g.agents.length, 0);
  const pages = pageCount(group.agents.length, pageSize);
  const page = wrapPage(opts.page ?? 0, pages);
  const slice = pageSlice(group.agents, page, pageSize);
  const buttons = slice.items.map((def, i) => ({
    id: formatButtonId(AGENT_PICK_PREFIX, reqId, offset + slice.start + i),
    label: agentLabel(def, current),
  }));
  if (pages > 1) {
    buttons.push(
      { id: formatButtonId(AGENT_PAGE_PREFIX, reqId, gi * 1000 + wrapPage(page - 1, pages)), label: '‹' },
      { id: formatButtonId(AGENT_PAGE_PREFIX, reqId, gi * 1000 + wrapPage(page + 1, pages)), label: '›' }
    );
  }
  if (groups.length > 1) buttons.push({ id: formatButtonId(AGENT_BACK_PREFIX, reqId, 0), label: '‹ machines' });
  const where = groups.length > 1 ? ` on ${group.name}` : '';
  const pageNote = pages > 1 ? ` (${page + 1}/${pages})` : '';
  // Said, not refused: the machine may well be back by the time anyone writes.
  const offline = group.offline ? `\n${group.name} is ${OFFLINE_NOTE}: its agents cannot answer until it is back.` : '';
  const question = opts.purpose === 'retry' ? `Retry with which agent${where}?` : `Which agent${where} should answer this topic?`;
  return { text: `${question}${pageNote}${offline}`, buttons };
}

/**
 * What an agent is, said the way a person choosing between them would say it: the harness as its own
 * project spells it, since `opencode` and `agy` are config keys rather than names. A custom harness
 * is whatever its command is — `codebuddy`, not `custom`, which says nothing about what will answer.
 * The command's last path segment only: `/usr/local/bin/` is where it lives, not what it is.
 */
export function agentKindOf(def: AgentDef): string {
  switch (def.harness) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    case 'agy':
      return 'Antigravity';
    case 'gemini':
      return 'Gemini CLI';
    case 'dsh':
      return 'DeepSeek Harness';
    case 'custom':
      return def.command?.split(/[\\/]/).pop() || def.id;
    default: {
      const _exhaustive: never = def.harness;
      return _exhaustive;
    }
  }
}

/**
 * Every agent, grouped as the `/agent` menu groups them, in the shape a page lays out as a choice
 * (`AgentCatalog`). `current` is who answers if nobody picks.
 *
 * Not the menu's two levels: a page has room to show every machine at once, and a choice that
 * takes one tap where the menu takes two is the reason for laying it out at all.
 */
export function agentCatalog(groups: readonly AgentGroup[], current: string): AgentCatalog {
  return {
    current,
    groups: groups.map((g) => ({
      name: g.name,
      agents: g.agents.map((def) => {
        // Short, as the footer and the status strip say it: on a card 150px wide the vendor prefix
        // (`opencode/`) was all that fit, and it is the one part the kind line already says.
        const model = def.model ? shortModelName(def.model) : undefined;
        return { id: def.id, harness: def.harness, kind: agentKindOf(def), ...(model ? { model } : {}) };
      }),
    })),
  };
}

/** Every agent in menu order — what a pick's index points into (see buildAgentMenu). */
export function flatAgents(groups: readonly AgentGroup[]): AgentDef[] {
  return groups.flatMap((g) => g.agents);
}

/** The text form, for a platform with no buttons, and the answer to a `/agent` that named nothing. */
export function agentListText(groups: readonly AgentGroup[], current: string | undefined): string {
  const lines = ['Agents (`/agent <id>` chooses one for this topic):'];
  for (const g of groups) {
    if (groups.length > 1) lines.push(`${g.name}${g.offline ? ` (${OFFLINE_NOTE})` : ''}:`);
    else if (g.offline) lines.push(`(${g.name} is ${OFFLINE_NOTE})`);
    for (const def of g.agents) {
      const mark = def.id === current ? '● ' : '  ';
      lines.push(`${groups.length > 1 ? '  ' : ''}${mark}${def.id} — ${def.harness}${def.model ? ` (${def.model})` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * The agent a typed `/agent <query>` names: an exact id (case-insensitive) first, else the one id
 * containing it. Ambiguous or unknown answers are values, so the caller can say which.
 */
export function matchAgent(
  agents: readonly AgentDef[],
  query: string
): { kind: 'one'; def: AgentDef } | { kind: 'none' } | { kind: 'many'; ids: string[] } {
  const q = query.trim().toLowerCase();
  const exact = agents.find((a) => a.id.toLowerCase() === q);
  if (exact) return { kind: 'one', def: exact };
  const partial = agents.filter((a) => a.id.toLowerCase().includes(q));
  if (partial.length === 1) return { kind: 'one', def: partial[0]! };
  return partial.length === 0 ? { kind: 'none' } : { kind: 'many', ids: partial.map((a) => a.id) };
}
