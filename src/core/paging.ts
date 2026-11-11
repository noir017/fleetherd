/**
 * The platform-imposed shape of a button menu: how many items fit on a page, and how long a label
 * may be.
 *
 * ── Why it lives on its own ───────────────────────────────────────────────────
 * `/model` needed paging first and did the math inline; `/setting` needs exactly the same math for
 * the value level of its menu (a model list is the longest thing either of them offers). Two copies
 * of "how big is a page, and which page is index N on" is the drift this repo's single-source rule
 * exists to prevent — and it is the kind that shows up as a button that turns to the wrong page,
 * long after the change that caused it.
 *
 * ── Why the page size is a parameter and not a constant ───────────────────────
 * It was a constant, and the constant was 6 — the number that fits every platform including the
 * tightest. That made `/cd` unusable on the deployment it was written for: a workspace of ten
 * projects is two pages, so *choosing a directory* meant paging, every time. Six is the right
 * answer for a platform that has not said otherwise and the wrong one for Telegram, which is where
 * these menus are actually read. So the size now comes from the platform (`menuPageSize` in
 * PlatformCapabilities) and is threaded through every function here; PAGE_SIZE stays as the default
 * for a profile that declares nothing.
 */

/**
 * Items per page when a platform declares no `menuPageSize` of its own.
 *
 * Deliberately the most conservative number rather than a good one: it is what a profile gets when
 * nobody has checked its button limits, and the failure mode of guessing high there is a message
 * the platform rejects outright. LINE bundles at most 4 buttons per template and QQ 5 per row, so
 * anything a profile has not thought about stays small.
 */
export const PAGE_SIZE = 6;

/**
 * Ceiling on a page size a platform may declare.
 *
 * This was Discord's number — 25 components a message, less the three a menu may add beyond its
 * items (◀ Prev, Next ▶, ◀ Back), so 22 — until the web UI asked for more (2026-10-31). A browser has
 * no component limit; it draws a menu as a grid, and what bounds a page there is a phone screen: 24
 * model ids at two a row measured 620px in Chromium at 390px wide, which is one screen with the
 * question above it, where 30 is not. So the ceiling is now the largest page that is still a screen,
 * and a chat platform's own physical limit is held against its declaration where that platform is
 * tested — `platform/menu-page-size.test.ts` holds Discord to its 25. The clamp still does what it
 * always did: keep a typo in a profile from producing a page nobody can use.
 */
export const PAGE_SIZE_MAX = 24;

/**
 * Ceiling on a `/cd` page when a platform declares `workdirPageSize`.
 *
 * Higher than PAGE_SIZE_MAX because the two menus are bounded by different things. A page of model
 * ids is a wall of long labels, and 24 is what still fits one phone screen; a page of directory
 * names is short labels whose only real bound is the scan — daemon/workdir-scan.ts stops at 60
 * sub-directories and always prepends the agent's root, so 61 options is the most a menu can ever
 * hold. The web UI asked for it on 2026-11-11: a 32-directory workspace was two pages there for no
 * reason a browser imposes, only the shared ceiling. Kept equal to that scan bound so the two
 * numbers cannot drift into a page that pages nothing.
 */
export const WORKDIR_PAGE_SIZE_MAX = 61;

/**
 * The page size to actually use, given what a platform declared (or didn't).
 *
 * One function so the default and the clamp are applied identically everywhere: a menu posted with
 * one size and paged with another turns to the wrong page, which is precisely the class of drift
 * this module exists to prevent. `max` is the ceiling for the menu being resolved — the shared
 * PAGE_SIZE_MAX unless a platform declared a `workdirPageSize`, which carries its own.
 */
export function resolvePageSize(declared: number | undefined, max: number = PAGE_SIZE_MAX): number {
  if (declared === undefined || !Number.isFinite(declared)) return PAGE_SIZE;
  return Math.min(max, Math.max(1, Math.trunc(declared)));
}

/** How many pages a list of this size needs (at least one, so an empty list still renders). */
export function pageCount(total: number, size: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / Math.max(1, size)));
}

/** The page a given index falls on. */
export function pageOf(index: number, size: number = PAGE_SIZE): number {
  return Math.floor(Math.max(0, index) / Math.max(1, size));
}

/**
 * Wrap a requested page into range, tolerating a negative or out-of-range number.
 *
 * Wrapping rather than clamping because page navigation WRAPS: hiding ◀ on the first page shifts
 * every other button up by one position between pages, and a disabled button does not exist on
 * Telegram at all — so the alternatives are a moving target or a button that looks live and does
 * nothing. See buildModelMenu.
 */
export function wrapPage(page: number, count: number): number {
  const total = Math.max(1, count);
  return ((Math.trunc(page) % total) + total) % total;
}

/** The slice of `items` shown on `page`, plus the absolute index the slice starts at. */
export function pageSlice<T>(
  items: readonly T[],
  page: number,
  size: number = PAGE_SIZE
): { start: number; items: T[] } {
  const step = Math.max(1, size);
  const start = page * step;
  return { start, items: items.slice(start, start + step) };
}

/** Longest button label; longer ones are ellipsised. Telegram is the tightest of the four. */
export const LABEL_MAX = 40;

/**
 * Ellipsise to the label budget. Never applied to the button's id, which is what a click actually
 * carries — a truncated label still resolves to the whole value it names.
 */
export function truncateLabel(label: string): string {
  return label.length <= LABEL_MAX ? label : `${label.slice(0, LABEL_MAX - 1)}…`;
}
