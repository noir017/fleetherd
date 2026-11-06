import type { EffortSelector } from '../types.js';
import type { Harness } from './command-translate.js';
import { formatButtonId, parseButtonId } from './button-id.js';
import { resolvePageSize, truncateLabel } from './paging.js';

/**
 * `/effort` as data: the menu, its button ids, matching a typed level, and every string it says.
 *
 * ── Why it is not the model menu with another header ──────────────────────────────────────────
 * It very nearly is — a frozen option snapshot, a ● on the current entry, the value re-checked at
 * click time — and the daemon side mirrors PendingModelMenu for exactly those reasons. What differs
 * is the list. A model list runs to 93 entries and needs paging; an effort list is the handful of
 * levels one model supports (six on claude, five or six on codex and opencode, probed 2026-09-23),
 * so it has no pages at all. Folding it into the model menu would buy a page counter that never
 * shows and a union type on every model-menu call site, to save one small file.
 *
 * The other difference is who owns the list. Effort levels belong to the MODEL, not the session:
 * opencode offers them only for a model with reasoning variants, codex only for a model in its own
 * catalog, and switching model reshapes the list or removes it. That is why "no levels" has its own
 * per-harness explanation below instead of a single sentence.
 */

/** One selectable level, as the harness reports it. Tied to EffortSelector so the two cannot drift. */
export type EffortOption = EffortSelector['options'][number];

/** Marks the level the session is on. A label, not a button style: styles vary per platform. */
const CURRENT_MARK = '● ';

/** Pick-a-level button: `eff:<reqId>:<index into the menu's frozen option list>`. */
export const EFFORT_PICK_PREFIX = 'eff:';

/** A click on an effort menu, once its id has been decoded. */
export interface EffortButtonClick {
  reqId: string;
  index: number;
}

/** Build a pick button's id. */
export function effortPickButtonId(reqId: string, index: number): string {
  return formatButtonId(EFFORT_PICK_PREFIX, reqId, index);
}

/** Decode an effort-menu button id, or null when it is some other menu's (or malformed). */
export function parseEffortButtonId(buttonId: string): EffortButtonClick | null {
  const pick = parseButtonId(buttonId, EFFORT_PICK_PREFIX);
  return pick ? { reqId: pick.reqId, index: pick.n } : null;
}

/**
 * Whether this platform can carry an effort MENU, or must fall back to the text answer.
 *
 * The first two conditions are the model menu's, for the model menu's reasons (see
 * modelMenuSurface): a menu that can never be edited can never be retired either, and a one-level
 * list offers nothing to choose.
 *
 * The third is this menu's own. It has no pages, so a list longer than one page on this platform
 * is answered as text rather than drawn past the platform's button limit. No harness offers that
 * many levels today — the ceiling that matters is Lark's undeclared page size of six, which claude's
 * six levels exactly fill — so this is a guard against a seventh level arriving, not a path anyone
 * takes. When it is taken, it degrades to the answer every platform can read.
 */
export function effortMenuSurface(
  caps: { buttons?: boolean; editButtons?: boolean; menuPageSize?: number },
  optionCount: number
): 'menu' | 'text' {
  if (!caps.buttons || !caps.editButtons) return 'text';
  if (optionCount < 2) return 'text';
  return optionCount <= resolvePageSize(caps.menuPageSize) ? 'menu' : 'text';
}

/** One rendered menu: what to say, and what to offer. */
export interface EffortMenuView {
  text: string;
  buttons: Array<{ id: string; label: string }>;
}

/**
 * Render the menu.
 *
 * Buttons carry the VALUE (`xhigh`), not the harness's display name (`Xhigh`): the value is what
 * the footer prints and what `/effort <level>` takes, so the button, the footer and the typed form
 * all say the same word.
 */
export function buildEffortMenu(menu: {
  reqId: string;
  options: EffortOption[];
  current?: string;
}): EffortMenuView {
  const buttons = menu.options.map((o, i) => ({
    id: effortPickButtonId(menu.reqId, i),
    label: truncateLabel((o.value === menu.current ? CURRENT_MARK : '') + o.value),
  }));
  const text = `Effort: ${menu.current ?? 'unknown'}\nTap one, or \`/effort <level>\`.`;
  return { text, buttons };
}

/** Outcome of resolving a `/effort <query>` against the live list. */
export type EffortMatch =
  | { kind: 'none' }
  | { kind: 'one'; option: EffortOption }
  | { kind: 'many'; matches: EffortOption[] };

/**
 * Resolve a typed level: an exact value or name wins outright (case-insensitive), otherwise a
 * PREFIX of the value.
 *
 * Prefix rather than the model menu's substring, because these are short words that contain each
 * other: `high` is inside `xhigh`, so a substring match would make every non-exact query that
 * reaches for one of them ambiguous. A prefix keeps `/effort x` meaning `xhigh` and `/effort med`
 * meaning `medium`, which is the thumb-typed form worth supporting.
 *
 * Ambiguity is never resolved by guessing — `/effort m` on claude could be `medium` or `max`, and
 * those are the two ends of the scale.
 */
export function matchEfforts(options: EffortOption[], query: string): EffortMatch {
  const needle = query.trim().toLowerCase();
  const exact = options.find(
    (o) => o.value.toLowerCase() === needle || o.name.toLowerCase() === needle
  );
  if (exact) return { kind: 'one', option: exact };
  const matches = options.filter((o) => o.value.toLowerCase().startsWith(needle));
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'one', option: matches[0]! };
  return { kind: 'many', matches };
}

// ───────────────────────────── the strings, in one place ─────────────────────────────

/** The levels as one line, for the text answers. The list is short enough to always print whole. */
function levelList(options: EffortOption[]): string {
  return options.map((o) => `\`${o.value}\``).join(' · ');
}

/** The bare `/effort` text answer, for platforms that cannot carry a menu. */
export function effortSummaryText(selector: EffortSelector): string {
  return (
    `Effort: ${selector.current ?? 'unknown'}\n` +
    `Offered: ${levelList(selector.options)} — \`/effort <level>\` to switch.`
  );
}

/**
 * The session is up but its current model offers no effort levels — and why, per harness.
 *
 * Each of these is a finding rather than a guess, which is why they are separate sentences:
 *
 * - **codex** builds the list from its own model catalog (codex-acp `createReasoningEffortConfigOption`,
 *   emitted only when `supportedReasoningEfforts` is non-empty for the current model). A model the
 *   installed codex-cli does not know gets no list at all — probed 2026-09-23: `gpt-6-luna` had none
 *   under codex-cli 0.155.1 and a full one under 0.156.1, same codex-acp 1.13.0. So the fix is a
 *   newer codex-cli or a catalogued model, and the level meanwhile comes from config.toml.
 * - **opencode** offers levels only for a model with reasoning variants (none on
 *   `opencode/mimo-v2.6-flash-free`; switching to an Anthropic model adds them).
 * - **agy** (`agy acp` 1.5.1) offers a `thought_level` for Gemini and none for GPT-OSS or the
 *   Claude models.
 * - anything else gets the generic sentence, with no advice it cannot back up.
 */
export function effortNoSelectorText(harness: Harness | undefined, model: string | undefined): string {
  const on = model ? `\`${model}\`` : 'the current model';
  if (harness === 'codex') {
    return (
      `Codex offers no effort levels for ${on}. codex takes them from its own model catalog, and ` +
      'the installed codex-cli has none for this model (a newer codex-cli may). `/model` can ' +
      'switch to a model it knows; until then the level comes from `model_reasoning_effort` in ' +
      '~/.codex/config.toml.'
    );
  }
  if (harness === 'opencode') {
    return (
      `OpenCode offers no effort levels for ${on} — it has them only for models with reasoning ` +
      'variants. `/model` can switch to one that does.'
    );
  }
  if (harness === 'agy') {
    return (
      `agy offers no thinking level for ${on} — it has one only for its Gemini models. ` +
      '`/model` can switch to one that does.'
    );
  }
  return `This agent offers no effort levels for ${on}.`;
}

/**
 * The session could not be started, so there is nothing to choose from — and the reason why.
 * Same reasoning as modelStartFailedText: the real cause beats "send a message first".
 */
export function effortStartFailedText(reason: string): string {
  return `Could not start this agent, so its effort levels are unavailable:\n${reason}`;
}

/** No level matched. Lists the choices, since the whole list fits in one line. */
export function effortNoMatchText(query: string, options: EffortOption[]): string {
  return `No effort level matches "${query}". Offered: ${levelList(options)}.`;
}

export function effortAmbiguousText(query: string, matches: EffortOption[]): string {
  return `"${query}" could be ${levelList(matches)} — type more of it.`;
}

/**
 * Everything that can come of choosing a level, as data rather than as a message.
 *
 * The same arms as ModelChoiceResult and for the same reason: the click path has no user to
 * re-prompt, so every outcome needs its own sentence on the menu, and the exhaustive switch below
 * makes a new arm fail to compile rather than fall through to a generic failure.
 */
export type EffortChoiceResult =
  /** Switched; `effort` is what the harness reports afterwards. */
  | { kind: 'applied'; effort: string }
  /** The session offers no levels right now — its model changed under the menu, or it was reset. */
  | { kind: 'unavailable' }
  /** The model no longer offers this level — its list changed under the open menu. */
  | { kind: 'missing'; value: string }
  /** Another agent answers this conversation now, so this menu belongs to nobody. */
  | { kind: 'rebound'; agent: string }
  /** The conversation itself is gone (daemon restarted, or it was released). */
  | { kind: 'gone' }
  /** The harness refused, or this agent cannot switch at runtime. */
  | { kind: 'failed'; reason: string };

/**
 * Render a choice outcome for the user. Exhaustive: a new arm must be given words here.
 *
 * `applied` says "from the next message" because that is when every harness reads it: a level set
 * while a turn is running does not reach into that turn, and one set between turns has nothing to
 * apply to until the next one starts.
 */
export function effortChoiceText(result: EffortChoiceResult): string {
  switch (result.kind) {
    case 'applied':
      return `Effort set to \`${result.effort}\` for this conversation, from the next message.`;
    case 'unavailable':
      return 'This session offers no effort levels right now (its model may have changed). Run /effort again.';
    case 'missing':
      return `\`${result.value}\` is no longer offered — the model's levels changed. Run /effort again for the current list.`;
    case 'rebound':
      return `This conversation is answered by ${result.agent} now, so that menu no longer applies. Run /effort again.`;
    case 'gone':
      return 'That conversation is gone — send a message first, then /effort.';
    case 'failed':
      return `Could not set effort: ${result.reason}`;
    default: {
      const _exhaustive: never = result;
      return String(_exhaustive);
    }
  }
}

/** A click on a menu this daemon no longer knows about (used up, superseded, or restarted). */
export function effortMenuExpiredText(): string {
  return 'That effort menu has expired (superseded, or the gateway restarted). Run /effort again for a fresh one.';
}

/** What the previous menu becomes when a newer one is opened in the same conversation. */
export function effortMenuSupersededText(current: string | undefined): string {
  return `Effort: ${current ?? 'unknown'} — superseded by a newer /effort menu.`;
}
