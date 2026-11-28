import type { Topic } from '../../../topics.js';

export type { Topic };

export interface TopicIcons {
  readonly more: string;
  readonly star: string;
  readonly chevronRight: string;
  readonly chevronDown: string;
  readonly fork: string;
  readonly offline: string;
  readonly search: string;
  readonly cross: string;
  readonly filter: string;
  readonly sort: string;
  readonly arrowUp: string;
  readonly arrowDown: string;
  readonly copy: string;
  readonly power: string;
  readonly trash: string;
  readonly pause: string;
  readonly play: string;
  readonly clock: string;
  readonly pencil: string;
  readonly [key: string]: string | undefined;
}

export interface SubtreeRunInfo {
  readonly busy: boolean;
  readonly since: number;
}

export interface TopicAgeInfo {
  readonly at: number;
  readonly run: boolean;
}

export interface SplitTitleResult {
  readonly tag: string;
  readonly rest: string;
}

export interface TopicAgentDisplay {
  readonly id: string;
  readonly label: string;
  readonly harness: string;
}

export interface TopicTree {
  visible: Topic[];
  byId: Record<string, Topic>;
  kids: Record<string, Topic[]>;
  forks: Record<string, Topic[]>;
  roots: Topic[];
}

export interface TopicConversation {
  members: Topic[];
  rank: number;
  starred: boolean;
  agents: Record<string, boolean>;
  hosts: Record<string, boolean>;
}

export interface TopicForest extends TopicTree {
  convs: Record<string, TopicConversation>;
  convOrder: string[];
}

export interface TreeRow {
  t: Topic;
  depth: number;
  kids: number;
  shut: boolean;
  under: string;
}

export interface TreeWalker {
  rows: TreeRow[];
  walk: (t: Topic, depth: number) => void;
  rest: (keep?: Readonly<Record<string, unknown>> | null) => void;
}

export interface TopicRowsResult {
  rows: TreeRow[];
  dividers: Record<number, boolean>;
  stars: number;
  matched: number;
  total: number;
  filtering: boolean;
}

export interface RowHtmlOpts {
  cls?: string;
  attrs: string;
  key?: string;
  legend?: string;
  dot?: string;
  title?: string;
  sub?: string;
  time?: string;
  badge?: string;
  mark?: string;
  moreTitle?: string;
}

export interface TreeRowOpts {
  attr: string;
  menu: string;
  cls?: string;
  tail?: string;
  attrs?: string;
  sub?: string;
  time?: string;
  moreTitle?: string;
}

export interface FilterBarOption {
  value: string;
  label: string;
  short?: string;
  icon?: string;
  count?: number;
}

export interface FilterBarGroup {
  id: string;
  label: string;
  pinned?: boolean;
  options: FilterBarOption[];
}

export interface FilterBarSortOption {
  value: string;
  label: string;
}

export interface FilterBarSortDef {
  options: FilterBarSortOption[];
  value?: string;
  dir?: string;
}

export interface FilterBarState {
  q: string;
  sel: Record<string, string[] | undefined>;
  sort: string;
  dir: string;
  open: boolean;
}

export interface FilterBarOpts {
  key: string;
  placeholder?: string;
  groups?: FilterBarGroup[];
  sort?: FilterBarSortDef | null;
  onChange?: (state: FilterBarState) => void;
}

export interface FilterBar {
  el: HTMLElement;
  state: () => FilterBarState;
  active: () => boolean;
  setGroups: (groups: FilterBarGroup[] | null) => void;
  setCounts: (shown: number, total: number) => void;
  clear: () => void;
  destroy: () => void;
  refreshI18n: (
    placeholder?: string,
    sortOptions?: readonly FilterBarSortOption[] | Readonly<Record<string, string>>,
  ) => void;
}

export interface RowMenuSeparator {
  readonly sep: true;
}

export interface RowMenuActionItem {
  readonly sep?: false;
  readonly key: string;
  readonly icon?: string;
  readonly label: string;
  readonly title?: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}

export type RowMenuItem = RowMenuSeparator | RowMenuActionItem;

export interface CreateTopicSeed {
  readonly text: string;
  readonly draft: string;
}

export interface TopicSnapshotPayload {
  readonly topic?: string;
  readonly epoch?: number;
  readonly last?: string;
  readonly stale?: boolean;
  readonly messages?: readonly unknown[];
  readonly hasMore?: boolean;
  readonly oldestSeq?: number;
  /** An answer to `?since=`: `messages` are only what changed, `gone` what was removed. */
  readonly delta?: boolean;
  readonly gone?: readonly string[];
  readonly seqs?: readonly number[];
}

export interface ScheduleTaskLike {
  readonly id: string;
  readonly name?: string;
  readonly state?: string;
  readonly running?: boolean;
}
