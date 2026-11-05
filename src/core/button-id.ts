/**
 * The button `custom_id` grammar shared by every menu this gateway posts: `<prefix><reqId>:<n>`.
 *
 * ── Why it lives in core ──────────────────────────────────────────────────────
 * Ids used to be formatted by hand at each call site in `daemon/daemon.ts` and parsed a few lines
 * away. That worked while both halves sat in one file. The model menu breaks that: `core/model-menu.ts`
 * BUILDS the ids (it is the module that knows what is on which page) while `daemon.ts` parses the
 * click, and core may not import daemon. Two private copies of one grammar with nothing to catch
 * the drift is exactly the failure this repo's "single source of truth" rule exists to prevent, so
 * the grammar moved down here and both sides call it.
 *
 * ── Why the payload is two opaque fields ──────────────────────────────────────
 * Telegram caps `callback_data` at 64 bytes and its profile hashes anything longer — lossily, so an
 * over-long id comes back unresolvable and the button is dead. `<reqId>:<n>` keeps every id at ~16
 * bytes no matter how long the thing it names is; the daemon holds the real payload (labels, model
 * ids, command names) in memory keyed by reqId. Nothing user-visible ever enters an id.
 */

/** Format one button id. `n` is an index or a page — the prefix says which. */
export function formatButtonId(prefix: string, reqId: string, n: number): string {
  return `${prefix}${reqId}:${n}`;
}

/** Button prefix for agent command picker menus (bare /cc, /oc, /agy when session already has context). */
export const PICK_PREFIX = 'cmd:';

/**
 * Decode a command picker button id (`cmd:<reqId>:<index>`), or null when malformed or not a picker.
 */
export function parsePickButtonId(
  buttonId: string
): { reqId: string; index: number } | null {
  const parsed = parseButtonId(buttonId, PICK_PREFIX);
  return parsed ? { reqId: parsed.reqId, index: parsed.n } : null;
}

/**
 * Parse a `<prefix><reqId>:<n>` id, or null when the prefix does not match or the shape is invalid.
 *
 * `lastIndexOf` rather than `split`: a reqId is opaque and could itself contain a colon, so only
 * the final segment is the number.
 */
export function parseButtonId(
  buttonId: string,
  prefix: string
): { reqId: string; n: number } | null {
  if (!buttonId.startsWith(prefix)) return null;
  const rest = buttonId.slice(prefix.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return null;
  const reqId = rest.slice(0, sep);
  const nStr = rest.slice(sep + 1);
  // Accept only a non-negative integer string (reject empty/non-digit; Number('') would be 0).
  if (!reqId || !/^\d+$/.test(nStr)) return null;
  return { reqId, n: Number(nStr) };
}
