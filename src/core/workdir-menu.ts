import { formatButtonId, parseButtonId } from './button-id.js';
import { type Locale, tMenus } from './i18n/menus.js';
import { PAGE_SIZE, pageCount, pageOf, pageSlice, truncateLabel, wrapPage } from './paging.js';

/**
 * `/cd` as data: page math, labels, button ids, matching, and every string either surface says.
 *
 * ── Why this module exists ────────────────────────────────────────────────────
 * An agent's working directory was a deployment decision (`agents[].cwd`) and nothing else, so a
 * phone user driving a machine with a dozen projects on it could reach exactly one of them. The
 * missing half is per-CONVERSATION: "this topic is about shop-api, that one about the gateway".
 *
 * Harness-agnostic on purpose. Every runtime this gateway drives takes a working directory at
 * startup — ACP passes it to `session/new`, agy takes it as the child's cwd and its `--add-dir`
 * trust root — so `/cd` means the same thing under `/cc`, `/oc` and `/agy`, and nothing in this
 * file knows which one is bound.
 *
 * Deliberately shaped as a sibling of core/model-menu.ts rather than a generalisation of it. The
 * two menus agree on everything the platform imposes (page size, label budget, id grammar — all
 * shared through paging.ts and button-id.ts) and on nothing else: a model list arrives from the
 * harness over ACP and switching one is a live in-session call, while a directory list is read off
 * the local filesystem and switching one necessarily starts a new session (see workdirChoiceText).
 * Folding them together would have to encode that difference as a flag at every branch.
 *
 * Everything here is pure: the scan lives in daemon/workdir-scan.ts (it needs fs), the posting and
 * clicking in daemon/, and the two surfaces — menu and text — are built from these same functions
 * so a tap and a typed `/cd shop-api` cannot describe the same outcome differently.
 */

/** One selectable directory. `path` is absolute; `name` is what a human calls it. */
export interface WorkdirOption {
  path: string;
  name: string;
  /** The agent's own configured cwd — the directory it falls back to with no override. */
  root?: boolean;
}

/**
 * Directories per page when the caller names no platform size. Shared arithmetic with the model and
 * setting menus (core/paging.ts); a platform that declares `menuPageSize` overrides it.
 */
export const WORKDIR_PAGE_SIZE = PAGE_SIZE;

/** Marks the directory this conversation is currently working in. */
const CURRENT_MARK = '● ';

/** Marks the agent's configured root, so it reads as "back to the default" rather than a project. */
const ROOT_MARK = '⌂ ';

/**
 * Cap on how many directories a `/cd <query>` disambiguation lists — past this, the answer is a
 * narrower query rather than a longer message. Same bound as the model menu's, same reason.
 */
export const WORKDIR_MATCH_MAX = 12;

/** Pick-a-directory button: `wdr:<reqId>:<index into the menu's frozen option list>`. */
export const WORKDIR_PICK_PREFIX = 'wdr:';
/** Turn-the-page button: `wdp:<reqId>:<absolute page number>`. */
export const WORKDIR_PAGE_PREFIX = 'wdp:';

/** A click on a workdir menu, once its id has been decoded. */
export type WorkdirButtonClick =
  | { kind: 'pick'; reqId: string; index: number }
  | { kind: 'page'; reqId: string; page: number };

/** One rendered page: what to say, and what to offer. */
export interface WorkdirMenuView {
  text: string;
  buttons: Array<{ id: string; label: string }>;
  /** The page actually rendered (the requested one, wrapped into range). */
  page: number;
  pageCount: number;
}

/** How many pages a list of this size needs (at least one, so an empty list still renders). */
export function workdirPageCount(total: number, size?: number): number {
  return pageCount(total, size);
}

/** The page a given index falls on. */
export function workdirPageOf(index: number, size?: number): number {
  return pageOf(index, size);
}

/** Position of `path` in the list, or -1. */
export function workdirIndexOf(options: WorkdirOption[], path: string | undefined): number {
  return path === undefined ? -1 : options.findIndex((o) => o.path === path);
}

/**
 * Whether this platform can carry a workdir MENU, or must fall back to the text answer.
 *
 * Both capability flags are required, for the reason modelMenuSurface records: a menu that can be
 * posted but never edited can never be paged and never retired, so its buttons keep answering for a
 * choice the conversation has moved past.
 *
 * A one-option list also gets text: the only directory on offer is the one already in use, and a
 * menu whose single button re-picks the status quo is a tap that does nothing.
 */
export function workdirMenuSurface(
  caps: { buttons?: boolean; editButtons?: boolean },
  optionCount: number
): 'menu' | 'text' {
  return Boolean(caps.buttons) && Boolean(caps.editButtons) && optionCount >= 2 ? 'menu' : 'text';
}

/** Build a pick button's id (index is into the menu's frozen list, not into the page). */
export function workdirPickButtonId(reqId: string, index: number): string {
  return formatButtonId(WORKDIR_PICK_PREFIX, reqId, index);
}

/** Build a page button's id (absolute page number). */
export function workdirPageButtonId(reqId: string, page: number): string {
  return formatButtonId(WORKDIR_PAGE_PREFIX, reqId, page);
}

/** Decode a workdir-menu button id, or null when it is some other menu's (or malformed). */
export function parseWorkdirButtonId(buttonId: string): WorkdirButtonClick | null {
  const pick = parseButtonId(buttonId, WORKDIR_PICK_PREFIX);
  if (pick) return { kind: 'pick', reqId: pick.reqId, index: pick.n };
  const page = parseButtonId(buttonId, WORKDIR_PAGE_PREFIX);
  if (page) return { kind: 'page', reqId: page.reqId, page: page.n };
  return null;
}

/**
 * Render one page of the menu.
 *
 * Indices are absolute and page navigation wraps, both for the reasons buildModelMenu records:
 * a pick id must keep naming the same directory across page turns, and a hidden or disabled edge
 * button either moves every other button between pages or looks live while doing nothing.
 */
export function buildWorkdirMenu(menu: {
  reqId: string;
  options: WorkdirOption[];
  current?: string;
  page: number;
  /** Items per page; omitted means this platform declared none (core/paging.ts PAGE_SIZE). */
  pageSize?: number;
  locale?: Locale;
}): WorkdirMenuView {
  const { reqId, options, current, locale = 'en' } = menu;
  const pageTotal = workdirPageCount(options.length, menu.pageSize);
  const page = wrapPage(menu.page, pageTotal);

  const { start, items } = pageSlice(options, page, menu.pageSize);
  const buttons = items.map((o, i) => ({
    id: workdirPickButtonId(reqId, start + i),
    label: truncateLabel((o.path === current ? CURRENT_MARK : o.root ? ROOT_MARK : '') + o.name),
  }));

  if (pageTotal > 1) {
    buttons.push(
      { id: workdirPageButtonId(reqId, (page - 1 + pageTotal) % pageTotal), label: tMenus(locale, 'workdir_menu_prev') },
      { id: workdirPageButtonId(reqId, (page + 1) % pageTotal), label: tMenus(locale, 'workdir_menu_next') }
    );
  }

  // The consequence is stated on the menu itself, not only in the ack, because it is the one thing
  // a user cannot undo by tapping again: the directory a session runs in is fixed when that session
  // starts, so moving means starting over. Better read before the tap than after.
  //
  // The page counter appears only when there IS more than one page — which, since platforms began
  // declaring their own page size, is no longer the common case. "page 1/1" is a line of noise
  // above the answer, and the setting menu has always left it out for the same reason.
  const currentLabel = current ?? tMenus(locale, 'model_menu_unknown');
  const pageNote = pageTotal > 1 ? tMenus(locale, 'workdir_menu_page_note', { page: page + 1, total: pageTotal }) : '';
  const text = tMenus(locale, 'workdir_menu_text', { current: currentLabel, count: options.length, pageNote });

  return { text, buttons, page, pageCount: pageTotal };
}

/** Outcome of resolving a `/cd <query>` against the scanned list. */
export type WorkdirMatch =
  | { kind: 'none' }
  | { kind: 'one'; option: WorkdirOption }
  | { kind: 'many'; matches: WorkdirOption[] };

/**
 * Resolve a query to a directory: an exact path wins outright, otherwise any substring of path or
 * name.
 *
 * Exact-first for the reason matchModels documents: one project's path is routinely a prefix of
 * another's (`~/workspace/shop-api` inside `~/workspace/shop-api-web`), so a user who typed a
 * full path correctly must not be answered with an ambiguity prompt.
 */
export function matchWorkdirs(options: WorkdirOption[], query: string): WorkdirMatch {
  const exact = options.find((o) => o.path === query);
  if (exact) return { kind: 'one', option: exact };
  const needle = query.toLowerCase();
  const matches = options.filter(
    (o) => o.path.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle)
  );
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'one', option: matches[0]! };
  return { kind: 'many', matches };
}

// ───────────────────────────── the strings, in one place ─────────────────────────────

/** The `/cd` text answer, for platforms that cannot carry a menu (or a list of one). */
export function workdirSummaryText(current: string, options: WorkdirOption[], locale: Locale = 'en'): string {
  const others = options.filter((o) => o.path !== current).slice(0, WORKDIR_MATCH_MAX);
  if (others.length === 0) {
    return tMenus(locale, 'workdir_summary_empty', { current });
  }
  const list = others.map((o) => `\`/cd ${o.name}\` — ${o.path}`).join('\n');
  return tMenus(locale, 'workdir_summary_list', { current, list });
}

/** The agent's root cannot be read (deleted, or a typo in `agents[].cwd`). */
export function workdirUnreadableText(root: string, reason: string, locale: Locale = 'en'): string {
  return tMenus(locale, 'workdir_unreadable', { root, reason });
}

export function workdirNoMatchText(query: string, locale: Locale = 'en'): string {
  return tMenus(locale, 'workdir_no_match', { query });
}

export function workdirAmbiguousText(query: string, matches: WorkdirOption[], locale: Locale = 'en'): string {
  const shown = matches.slice(0, WORKDIR_MATCH_MAX);
  const more = matches.length - shown.length;
  const list = shown.map((o) => `\`/cd ${o.path}\``).join('\n');
  const moreText = more > 0 ? tMenus(locale, 'workdir_ambiguous_more', { count: more }) : '';
  return tMenus(locale, 'workdir_ambiguous', { query, count: matches.length, list, more: moreText });
}

/**
 * Everything that can come of choosing a directory, as data rather than as a message.
 *
 * A union for the reason ModelChoiceResult is one: the caller is a click handler with no user to
 * re-prompt, so each outcome has to become a specific sentence on the menu itself, and an
 * exhaustive switch makes a new outcome fail to compile rather than render as a dead button.
 */
export type WorkdirChoiceResult =
  /** Moved; the agent's next turn starts a fresh session in `path`. */
  | { kind: 'applied'; path: string }
  /** Already working there — nothing was reset, which is why this is not folded into `applied`. */
  | { kind: 'unchanged'; path: string }
  /** The directory is gone since the menu was built (renamed, deleted). */
  | { kind: 'missing'; path: string }
  /** Another agent answers this conversation now, so this menu's option list belongs to nobody. */
  | { kind: 'rebound'; agent: string }
  /** Nowhere to record the choice — a deployment running without a conversation store. */
  | { kind: 'failed'; reason: string };

/** Render a choice outcome for the user. Exhaustive: a new arm must be given words here. */
export function workdirChoiceText(result: WorkdirChoiceResult, locale: Locale = 'en'): string {
  switch (result.kind) {
    case 'applied':
      return tMenus(locale, 'workdir_applied', { path: result.path });
    case 'unchanged':
      return tMenus(locale, 'workdir_unchanged', { path: result.path });
    case 'missing':
      return tMenus(locale, 'workdir_missing', { path: result.path });
    case 'rebound':
      return tMenus(locale, 'workdir_rebound', { agent: result.agent });
    case 'failed':
      return tMenus(locale, 'workdir_failed', { reason: result.reason });
    default: {
      const _exhaustive: never = result;
      return String(_exhaustive);
    }
  }
}

/** A click on a menu this daemon no longer knows about (used up, superseded, or restarted). */
export function workdirMenuExpiredText(locale: Locale = 'en'): string {
  return tMenus(locale, 'workdir_expired');
}

/** What the previous menu becomes when a newer one is opened in the same conversation. */
export function workdirMenuSupersededText(current: string | undefined, locale: Locale = 'en'): string {
  const currentLabel = current ?? tMenus(locale, 'model_menu_unknown');
  return tMenus(locale, 'workdir_superseded', { current: currentLabel });
}
