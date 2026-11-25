import type {
  HistoryPanelHit,
  HistoryPanelPage,
  HistoryPanelSession,
} from '../../../../adapter.js';
import { icon } from '../../../icons.js';
import type { WebMessage } from '../../../protocol.js';
import type { WebHistoryRead } from '../../../room.js';
import type { FilterBarGroup, FilterBarOption, FilterBarState } from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import type { EditorContribution, ViewContribution } from '../../plugins/api.js';

export type HistoryPanelComponent = ReturnType<ViewContribution['component']>;
export type HistoryEditorComponent = ReturnType<EditorContribution['component']>;
export type HistoryPanelInitContext = Parameters<HistoryEditorComponent['init']>[1];

export interface HistoryEditorInput {
  readonly id: string;
  readonly title?: string;
  readonly query?: string;
}

export interface HistoryIcons {
  readonly copy: string;
  readonly check: string;
  readonly cross: string;
  readonly search: string;
  readonly filter: string;
  readonly arrowUp: string;
  readonly arrowDown: string;
  readonly chevronLeft: string;
  readonly globe: string;
  readonly [key: string]: string | undefined;
}

export interface HistoryPluginDeps {
  readonly doc?: Document;
  readonly win?: Window;
  readonly getIcons?: () => Partial<HistoryIcons>;
  readonly msgMarkup?: (key: string, msg: WebMessage, isHist: boolean) => { cls: string; h: string };
  readonly codeBlocks?: (root: Element) => void;
  readonly forgetOpenedPrefix?: (prefix: string) => void;
  readonly openShot?: (img: Element) => void;
  readonly toggleAll?: (key: string | null) => void;
  readonly toggleLine?: (line: Element) => void;
  readonly copyText?: (s: string, done: (ok: boolean) => void) => void;
  readonly onOpenSession?: (input: HistoryEditorInput) => void;
  readonly onCloseEditor?: (id: string) => void;
  readonly onExportSessions?: (items: readonly HistoryEditorInput[]) => void | Promise<void>;
}

export interface HistorySearchResponse {
  readonly enabled?: boolean;
  readonly hits?: HistoryPanelHit[];
  readonly more?: boolean;
  readonly error?: string;
}

export type HistoryPageResponse = Partial<HistoryPanelPage> & { readonly error?: string };
export type HistoryReadResponse = Partial<WebHistoryRead> & { readonly error?: string };

export const DEFAULT_HISTORY_ICONS: HistoryIcons = {
  copy: icon('copy'),
  check: icon('check'),
  cross: icon('cross'),
  search: icon('search'),
  filter: icon('filter'),
  arrowUp: icon('arrowUp'),
  arrowDown: icon('arrowDown'),
  chevronLeft: icon('chevronLeft'),
  globe: icon('globe'),
  refresh: icon('refresh'),
};

export function resolveHistoryIcons(deps: HistoryPluginDeps): HistoryIcons {
  const custom = deps.getIcons?.();
  return custom ? { ...DEFAULT_HISTORY_ICONS, ...custom } : DEFAULT_HISTORY_ICONS;
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return tr('common.networkError');
}

export function formatHistoryTime(at: number): string {
  try {
    const d = new Date(at);
    const o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleString(undefined, o);
  } catch {
    return '';
  }
}

export function formatHistoryShortTime(at: number, nowMs: number = Date.now()): string {
  try {
    const d = new Date(at);
    const now = new Date(nowMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return `${hh}:${mm}`;
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const isYesterday =
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate();
    if (isYesterday) return `${hh}:${mm}`;
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    if (d.getFullYear() === now.getFullYear()) return `${mo}-${day}`;
    return `${d.getFullYear()}-${mo}-${day}`;
  } catch {
    return '';
  }
}

export interface HistoryDateGroup<T> {
  readonly key: string;
  readonly label: string;
  readonly items: T[];
}

export function groupHistoryByDate<T>(
  items: readonly T[],
  getAt: (item: T) => number,
  nowMs: number = Date.now(),
): HistoryDateGroup<T>[] {
  const now = new Date(nowMs);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const groups: HistoryDateGroup<T>[] = [];
  const byKey = new Map<string, HistoryDateGroup<T>>();

  for (const item of items) {
    const d = new Date(getAt(item));
    let key: string;
    let label: string;
    if (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    ) {
      key = 'today';
      label = tr('sched.today');
    } else if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      key = 'yesterday';
      label = tr('sched.yesterday');
    } else {
      const monthIdx = d.getMonth();
      const monthKey = `age.month${monthIdx}` as Parameters<typeof tr>[0];
      key = `m:${d.getFullYear()}-${String(monthIdx + 1).padStart(2, '0')}`;
      label = d.getFullYear() === now.getFullYear() ? tr(monthKey) : `${d.getFullYear()} ${tr(monthKey)}`;
    }
    let grp = byKey.get(key);
    if (!grp) {
      grp = { key, label, items: [] };
      byKey.set(key, grp);
      groups.push(grp);
    }
    grp.items.push(item);
  }
  return groups;
}

export function historyAgentClass(agent: string | undefined): string {
  const a = (agent || '').toLowerCase();
  if (a.includes('claude') || a === 'cc') return 'fh-hc fh-hc--claude';
  if (a.includes('codex') || a === 'cx') return 'fh-hc fh-hc--codex';
  if (a.includes('opencode') || a === 'op') return 'fh-hc fh-hc--opencode';
  if (a.includes('agy') || a === 'ag') return 'fh-hc fh-hc--agy';
  if (a.includes('gemini')) return 'fh-hc fh-hc--gemini';
  if (a.includes('dsh')) return 'fh-hc fh-hc--dsh';
  return 'fh-hc';
}

export function formatHistoryRef(title: string | undefined, id: string | number): string {
  return `${title || tr('history.untitled')} (#${id})`;
}

export function readOnlySentence(session: HistoryPanelSession, topicHere: boolean): string {
  if (topicHere) return tr('history.roHere');
  if (session.topic) return tr('history.roCleared');
  return tr('history.roOther', { platform: session.platform || tr('history.anotherPlatform') });
}

export function normalizeHistoryEditorInput(input: unknown): HistoryEditorInput | null {
  if (typeof input === 'string' || typeof input === 'number') {
    const id = String(input).trim();
    return id ? { id } : null;
  }
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const rawId = rec.id ?? rec.session;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') return null;
  const id = String(rawId).trim();
  if (!id) return null;
  return {
    id,
    title: typeof rec.title === 'string' ? rec.title : undefined,
    query: typeof rec.query === 'string' ? rec.query : undefined,
  };
}

export function historyEditorTitle(input: unknown): string {
  const parsed = normalizeHistoryEditorInput(input);
  if (!parsed) return tr('sidebar.history');
  return parsed.title || `${tr('sidebar.history')} #${parsed.id}`;
}

export function defaultMsgMarkup(_key: string, msg: WebMessage): { cls: string; h: string } {
  const cls = msg.own ? 'msg own' : 'msg';
  return { cls, h: `<div class="msg-body">${msg.html || ''}</div>` };
}

export function copyWithFallback(
  value: string,
  deps: HistoryPluginDeps,
  done: (ok: boolean) => void,
): void {
  if (deps.copyText) {
    deps.copyText(value, done);
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value).then(
      () => done(true),
      () => done(false),
    );
    return;
  }
  done(false);
}

export function formatHistoryExportMarkdown(
  records: ReadonlyArray<{
    readonly id: string;
    readonly title?: string;
    readonly messages?: readonly WebMessage[];
  }>,
): string {
  const sections: string[] = [];
  for (const rec of records) {
    const heading = `# ${rec.title || tr('history.untitled')} (#${rec.id})`;
    const lines = [heading];
    for (const msg of rec.messages ?? []) {
      const who = msg.own ? 'User' : 'Assistant';
      const body = (msg.html || '').replace(/<[^>]+>/g, '').trim();
      lines.push(`\n## ${who}\n\n${body}`);
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n---\n\n');
}

export function buildHistoryFilterGroups(
  items: ReadonlyArray<{ readonly agent?: string; readonly platform?: string }>,
  icons: HistoryIcons,
): FilterBarGroup[] {
  const agents = new Map<string, number>();
  const platforms = new Map<string, number>();
  for (const item of items) {
    const agent = item.agent || tr('history.noAgent');
    const platform = item.platform || tr('history.unknown');
    agents.set(agent, (agents.get(agent) ?? 0) + 1);
    platforms.set(platform, (platforms.get(platform) ?? 0) + 1);
  }
  const groups: FilterBarGroup[] = [];
  if (platforms.size > 1) {
    const options: FilterBarOption[] = [...platforms.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, icon: icons.globe, count }));
    groups.push({ id: 'platform', label: tr('filter.host'), options });
  }
  if (agents.size > 1) {
    const options: FilterBarOption[] = [...agents.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
    groups.push({ id: 'agent', label: tr('filter.agent'), options });
  }
  return groups;
}

export function filterHistoryRecords<T extends { readonly agent?: string; readonly platform?: string }>(
  items: readonly T[],
  state: FilterBarState,
): T[] {
  const platSel = state.sel.platform;
  const agentSel = state.sel.agent;
  if ((!platSel || platSel.length === 0) && (!agentSel || agentSel.length === 0)) {
    return [...items];
  }
  return items.filter((item) => {
    const platform = item.platform || tr('history.unknown');
    const agent = item.agent || tr('history.noAgent');
    if (platSel && platSel.length > 0 && !platSel.includes(platform)) return false;
    if (agentSel && agentSel.length > 0 && !agentSel.includes(agent)) return false;
    return true;
  });
}
