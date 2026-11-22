import type { ModelSelector } from '../types.js';
import { type Locale, tMenus } from './i18n/menus.js';
import { formatButtonId, parseButtonId } from './button-id.js';
import { PAGE_SIZE, pageCount, pageOf, pageSlice, truncateLabel, wrapPage } from './paging.js';

/**
 * `/model` as data: page math, labels, button ids, matching, and every string either surface says.
 *
 * ── Why this module exists ────────────────────────────────────────────────────
 * `/model` had one surface — a line of text and a substring switch — because 93 models is past
 * what a message can list and past the 25-button cap that made a flat menu impossible. But a
 * substring is only usable if you already know roughly what you are looking for, and from a phone
 * you usually do not: the whole question is "what are my options". A paginated menu answers that
 * in taps, and a page is a pure function of (options, current, page), so all of it lives here and
 * `daemon/` is left with the parts that genuinely need a socket — posting, editing, and clicking.
 *
 * Both surfaces are built from these functions, deliberately. The ack a click produces and the ack
 * `/model glm` produces are the same sentence because they are the same call; a menu and a text
 * answer disagreeing about what just happened is the kind of drift this file removes.
 */

/** One selectable model, as the harness reports it. Tied to ModelSelector so the two cannot drift. */
export type ModelOption = ModelSelector['options'][number];

/**
 * Models per page when the caller names no platform size. The arithmetic is shared with the
 * `/setting` menu (core/paging.ts), which has the same one-button-per-row Telegram constraint; this
 * alias keeps the model-menu vocabulary reading as itself at the call sites.
 *
 * A platform that declares `menuPageSize` overrides it — the daemon passes that number down, and
 * passes the SAME number again on every page click (see PendingModelMenu.pageSize), because a menu
 * drawn at one size and paged at another turns to the wrong page.
 */
export const MODEL_PAGE_SIZE = PAGE_SIZE;

/** Marks the model currently serving the session. A label, not a button style: styles vary per platform. */
const CURRENT_MARK = '● ';

/**
 * Cap on how many models a `/model <query>` disambiguation lists. Past this the list stops being
 * scannable on a phone, and the answer is a narrower query rather than a longer message.
 */
export const MODEL_MATCH_MAX = 12;

/** Pick-a-model button: `mdl:<reqId>:<index into the menu's frozen option list>`. */
export const MODEL_PICK_PREFIX = 'mdl:';
/** Turn-the-page button: `mpg:<reqId>:<absolute page number>`. */
export const MODEL_PAGE_PREFIX = 'mpg:';

/** A click on a model menu, once its id has been decoded. */
export type ModelButtonClick =
  | { kind: 'pick'; reqId: string; index: number }
  | { kind: 'page'; reqId: string; page: number };

/** One rendered page: what to say, and what to offer. */
export interface ModelMenuView {
  text: string;
  buttons: Array<{ id: string; label: string }>;
  /** The page actually rendered (the requested one, wrapped into range). */
  page: number;
  pageCount: number;
}

/** How many pages a list of this size needs (at least one, so an empty list still renders). */
export function modelPageCount(total: number, size?: number): number {
  return pageCount(total, size);
}

/** The page a given index falls on. */
export function modelPageOf(index: number, size?: number): number {
  return pageOf(index, size);
}

/** Position of `value` in the list, or -1 — including when the harness reports a model it does not list. */
export function modelIndexOf(options: ModelOption[], value: string | undefined): number {
  return value === undefined ? -1 : options.findIndex((o) => o.value === value);
}

/**
 * Whether this platform can carry a model MENU, or must fall back to the text answer.
 *
 * Both flags are required, and the second is the interesting one: posting buttons is not enough if
 * they can never be changed. On a platform with no edit endpoint (LINE, QQ) the menu could never be
 * paged, and — worse — never retired: after a pick, its buttons would stay live above the ack and
 * answer "expired" forever, which looks interactive and is not. A text answer is not a degraded
 * menu there, it is the complete answer those platforms have always had.
 *
 * A one-model selector also gets text: a menu whose only action is to re-pick what is already
 * running is a tap that does nothing.
 *
 * Read with falsy checks rather than `=== false` — a capability object that omits the field (an
 * older stub, a hand-built fake) must resolve to the safe surface, not the unsupported one.
 */
export function modelMenuSurface(
  caps: { buttons?: boolean; editButtons?: boolean },
  optionCount: number
): 'menu' | 'text' {
  if (!caps.buttons || !caps.editButtons) return 'text';
  return optionCount >= 2 ? 'menu' : 'text';
}

/**
 * Display label for one option, disambiguated and truncated.
 *
 * The harness's `name` is the readable half ("(nvidia) GLM-5.1" against
 * "newapi/glm-5.1-nvidia"), but it is only unique by convention — two providers can offer the same
 * model under the same name, and a menu with two identical buttons is a menu you cannot use. So a
 * name that is not unique in THIS list falls back to the id, which always is.
 */
function labelFor(option: ModelOption, nameCounts: Map<string, number>): string {
  const name = option.name.trim();
  const unique = name.length > 0 && (nameCounts.get(name) ?? 0) === 1;
  return unique ? name : option.value;
}

/** Build a pick button's id (index is into the menu's frozen list, not into the page). */
export function modelPickButtonId(reqId: string, index: number): string {
  return formatButtonId(MODEL_PICK_PREFIX, reqId, index);
}

/** Build a page button's id (absolute page number). */
export function modelPageButtonId(reqId: string, page: number): string {
  return formatButtonId(MODEL_PAGE_PREFIX, reqId, page);
}

/** Decode a model-menu button id, or null when it is some other menu's (or malformed). */
export function parseModelButtonId(buttonId: string): ModelButtonClick | null {
  const pick = parseButtonId(buttonId, MODEL_PICK_PREFIX);
  if (pick) return { kind: 'pick', reqId: pick.reqId, index: pick.n };
  const page = parseButtonId(buttonId, MODEL_PAGE_PREFIX);
  if (page) return { kind: 'page', reqId: page.reqId, page: page.n };
  return null;
}

/**
 * Render one page of the menu.
 *
 * Two decisions worth keeping:
 *
 * **Indices are absolute, never page-relative.** A pick id names a position in the frozen list the
 * menu was opened with, so paging cannot make a button mean a different model than it did when it
 * was drawn — the one way this design could silently switch to a model nobody chose.
 *
 * **Page navigation WRAPS instead of disappearing at the edges.** Hiding ◀ on the first page shifts
 * every other button up by one position between pages, and a disabled button does not exist on
 * Telegram at all — so the alternatives are a moving target or a button that looks live and does
 * nothing. Wrapping keeps the layout fixed and every button honest.
 */
export function buildModelMenu(menu: {
  reqId: string;
  options: ModelOption[];
  current?: string;
  page: number;
  /** Items per page; omitted means this platform declared none (core/paging.ts PAGE_SIZE). */
  pageSize?: number;
  locale?: Locale;
}): ModelMenuView {
  const { reqId, options, current, locale = 'en' } = menu;
  const pageTotal = modelPageCount(options.length, menu.pageSize);
  // Wrap into range, tolerating a negative or out-of-range request.
  const page = wrapPage(menu.page, pageTotal);

  const nameCounts = new Map<string, number>();
  for (const o of options) {
    const name = o.name.trim();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const { start, items } = pageSlice(options, page, menu.pageSize);
  const buttons = items.map((o, i) => ({
    id: modelPickButtonId(reqId, start + i),
    label: truncateLabel(
      (o.value === current ? CURRENT_MARK : '') + labelFor(o, nameCounts)
    ),
  }));

  if (pageTotal > 1) {
    buttons.push(
      { id: modelPageButtonId(reqId, (page - 1 + pageTotal) % pageTotal), label: tMenus(locale, 'model_menu_prev') },
      { id: modelPageButtonId(reqId, (page + 1) % pageTotal), label: tMenus(locale, 'model_menu_next') }
    );
  }

  // The shortcut is repeated on every page on purpose: it is the only way to reach a model without
  // paging to it, and the page a user happens to be on is the one they will read. The page counter
  // itself only appears when there is more than one page (see buildWorkdirMenu).
  const currentLabel = current ?? tMenus(locale, 'model_menu_unknown');
  const pageNote = pageTotal > 1 ? tMenus(locale, 'model_menu_page_note', { page: page + 1, total: pageTotal }) : '';
  const text = tMenus(locale, 'model_menu_text', { current: currentLabel, count: options.length, pageNote });

  return { text, buttons, page, pageCount: pageTotal };
}

/** Outcome of resolving a `/model <query>` against the live list. */
export type ModelMatch =
  | { kind: 'none' }
  | { kind: 'one'; option: ModelOption }
  | { kind: 'many'; matches: ModelOption[] };

/**
 * Resolve a query to a model: an exact id wins outright, otherwise any substring of id or name.
 *
 * The exact-first rule is load-bearing, not a micro-optimisation: `opencode/glm-5` is a substring of
 * `opencode/glm-5.1`, so a user who types the full id of the shorter one would otherwise get an
 * ambiguity prompt for a name they spelled perfectly.
 *
 * Ambiguity is never resolved by guessing — picking one silently changes which model answers.
 */
export function matchModels(options: ModelOption[], query: string): ModelMatch {
  const exact = options.find((o) => o.value === query);
  if (exact) return { kind: 'one', option: exact };
  const needle = query.toLowerCase();
  const matches = options.filter(
    (o) => o.value.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle)
  );
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'one', option: matches[0]! };
  return { kind: 'many', matches };
}

// ───────────────────────────── the strings, in one place ─────────────────────────────

/** The bare `/model` text answer, for platforms that cannot carry a menu. */
export function modelSummaryText(selector: ModelSelector, locale: Locale = 'en'): string {
  const currentLabel = selector.current ?? tMenus(locale, 'model_menu_unknown');
  return tMenus(locale, 'model_summary_text', { current: currentLabel, count: selector.options.length });
}

/**
 * The harness offers no model choice at all.
 *
 * No longer "not yet" — the gateway starts the session before asking (see warmModelSelector), so
 * reaching this text means the agent genuinely exposes no model selector. The `claude` harness is
 * the real example: it takes its model from ANTHROPIC_MODEL and never advertises a picker.
 */
export function modelNoSelectorText(locale: Locale = 'en'): string {
  return tMenus(locale, 'model_no_selector');
}

/**
 * The session could not be started, so there is nothing to choose from — and the reason why.
 *
 * Worth its own text because the old code answered "send a message, then /model" to a missing
 * binary and an un-logged-in harness alike, which sent the user to do the one thing guaranteed to
 * fail the same way.
 */
export function modelStartFailedText(reason: string, locale: Locale = 'en'): string {
  return tMenus(locale, 'model_start_failed', { reason });
}

export function modelNoMatchText(query: string, locale: Locale = 'en'): string {
  return tMenus(locale, 'model_no_match', { query });
}

export function modelAmbiguousText(query: string, matches: ModelOption[], locale: Locale = 'en'): string {
  const shown = matches.slice(0, MODEL_MATCH_MAX);
  const more = matches.length - shown.length;
  const list = shown.map((o) => `\`/model ${o.value}\` — ${o.name}`).join('\n');
  const moreText = more > 0 ? tMenus(locale, 'model_ambiguous_more', { count: more }) : '';
  return tMenus(locale, 'model_ambiguous', { query, count: matches.length, list, more: moreText });
}

/**
 * Everything that can come of choosing a model, as data rather than as a message.
 *
 * A union rather than a thrown error or a boolean because the caller is a click handler with no
 * user to re-prompt: each of these has to become a specific sentence on the menu itself, and the
 * exhaustive switch below makes a new outcome fail to compile rather than fall through to a
 * generic failure — which, on a button, is indistinguishable from a dead one.
 */
export type ModelChoiceResult =
  /** Switched; `model` is what the harness reports afterwards, which can differ from what was asked. */
  | { kind: 'applied'; model: string }
  /** No live session or no selector right now (the conversation was reset, the child disposed). */
  | { kind: 'unavailable' }
  /** The harness no longer offers this id — its list changed under the open menu. */
  | { kind: 'missing'; value: string }
  /** Another agent answers this conversation now, so this menu belongs to nobody. */
  | { kind: 'rebound'; agent: string }
  /** The conversation itself is gone (daemon restarted, or it was released). */
  | { kind: 'gone' }
  /** The harness refused, or this agent cannot switch at runtime. */
  | { kind: 'failed'; reason: string };

/** Render a choice outcome for the user. Exhaustive: a new arm must be given words here. */
export function modelChoiceText(result: ModelChoiceResult, locale: Locale = 'en'): string {
  switch (result.kind) {
    case 'applied':
      return tMenus(locale, 'model_applied', { model: result.model });
    case 'unavailable':
      return tMenus(locale, 'model_unavailable');
    case 'missing':
      return tMenus(locale, 'model_missing', { value: result.value });
    case 'rebound':
      return tMenus(locale, 'model_rebound', { agent: result.agent });
    case 'gone':
      return tMenus(locale, 'model_gone');
    case 'failed':
      return tMenus(locale, 'model_failed', { reason: result.reason });
    default: {
      const _exhaustive: never = result;
      return String(_exhaustive);
    }
  }
}

/** A click on a menu this daemon no longer knows about (used up, superseded, or restarted). */
export function modelMenuExpiredText(locale: Locale = 'en'): string {
  return tMenus(locale, 'model_expired');
}

/** What the previous menu becomes when a newer one is opened in the same conversation. */
export function modelMenuSupersededText(current: string | undefined, locale: Locale = 'en'): string {
  const currentLabel = current ?? tMenus(locale, 'model_menu_unknown');
  return tMenus(locale, 'model_superseded', { current: currentLabel });
}
