import type { ClientContext, SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';
import type { SessionOption } from '../types.js';
import type { AgentDef } from '../config/schema.js';
import { HARNESS_FACTS } from '../core/harness-facts.js';
import { levelMode } from '../core/permission-levels.js';
import type {
  AgentStreamHandlers,
  EffortSelector,
  ModelSelector,
  SessionMemory,
  SessionModeSelector,
} from './agent.js';
import { HARNESS_PROFILES } from './harness/index.js';

/** ACP's well-known id for the model selector among a session's config options. */
export const MODEL_CONFIG_ID = 'model';

/** ACP's spec-reserved category for the reasoning-effort selector (SessionConfigOptionCategory). */
const THOUGHT_LEVEL_CATEGORY = 'thought_level';

/** A config option of the `select` kind — the only kind a level can be chosen from. */
export type SelectConfigOption = Extract<SessionConfigOption, { type: 'select' }>;

/**
 * The prefix ACP keeps for categories it does not define: "Category names beginning with `_` are
 * free for custom use … names that do not begin with `_` are reserved for the ACP spec"
 * (SessionConfigOptionCategory, @agentclientprotocol/sdk 0.29.0).
 */
const CUSTOM_CATEGORY_PREFIX = '_';

/** ACP's spec-reserved category for the session-mode selector (SessionConfigOptionCategory). */
const MODE_CATEGORY = 'mode';

/**
 * Pull the live model's display name out of an ACP `configOptions` list (as returned by session/new
 * and refreshed by `config_option_update`).
 *
 * Why bother, when the config already names a model: for some agents it doesn't. The `claude` harness
 * takes its model from the ANTHROPIC_MODEL env var (the only source that survives Claude Code
 * rewriting settings.model), so `agents[].model` is empty and the config knows only an alias like
 * `opus[1m]` — never the concrete model actually serving the turn. The harness resolves that alias
 * itself and reports the result here, so this is the only accurate source.
 *
 * Shape (SessionConfigOption): the model selector is `{id:'model', type:'select', currentValue,
 * options}` where options are either flat SessionConfigSelectOption[] or grouped
 * SessionConfigSelectGroup[] ({group, options}). Returns undefined when the agent exposes no model
 * selector; falls back to the raw `currentValue` when the option isn't listed at all (an
 * allowlisted-but-unlisted model still reports a currentValue).
 *
 * Label choice, in order:
 *
 * 1. **The concrete model out of the option's `description`.** Neither the id nor the display name
 *    carries a version on the claude harness — it offers `opus[1m]` / "Opus", which says which
 *    family is running but not which release, so a footer reading `opus[1m]` never changed when the
 *    model behind that alias did. The description is where the harness states it, verbatim:
 *    "Opus 4.8 with 1M context · Best for everyday, complex tasks" (probed live against
 *    claude-agent-acp 0.58.1). Parsed to `opus-4-8`, which is the model, spelled the way it is
 *    everywhere else. `[1m]` drops out with it, and nothing is lost: the footer's own context
 *    segment already reads `/ 1M` beside it, so the qualifier was saying twice what one number says.
 * 2. The option's human-readable `name`, when it doesn't LOSE a qualifier the id carries — the
 *    fallback for a harness whose descriptions carry no version (see nameKeepsQualifiers).
 * 3. The raw `currentValue`, when the option isn't listed at all.
 */
export function liveModelName(options: SessionConfigOption[] | null | undefined): string | undefined {
  const opt = options?.find((o) => o.id === MODEL_CONFIG_ID);
  if (!opt || opt.type !== 'select') return undefined;
  const current = opt.currentValue;
  if (typeof current !== 'string' || current.length === 0) return undefined;
  // Flatten grouped options so both shapes are searched the same way.
  const flat = opt.options.flatMap((entry) =>
    'group' in entry ? entry.options : [entry]
  );
  const selected = flat.find((o) => o.value === current);
  const concrete = concreteModelName(selected?.description);
  if (concrete) return concrete;
  const name = selected?.name;
  if (!name) return current;
  return nameKeepsQualifiers(name, current) ? name : current;
}

/**
 * `<family>-<version>` pulled out of an option description, or undefined when it doesn't state one.
 *
 * The shape being read is the headline before the `·` separator — "Opus 4.8 with 1M context",
 * "Sonnet 5", "Haiku 4.5", "Fable 5.1" — of which only the leading family and version are the
 * model's identity; the rest is either a qualifier the footer already shows or marketing.
 *
 * Deliberately strict, and undefined on anything that doesn't match: this runs for every harness,
 * and a description that is a sentence rather than a model name (opencode writes none at all) must
 * fall through to the name/id path rather than yield a plausible-looking wrong answer.
 */
function concreteModelName(description: string | null | undefined): string | undefined {
  if (!description) return undefined;
  const headline = description.split('·')[0]!.trim();
  const m = /^([A-Za-z][A-Za-z0-9]*)\s+(\d+(?:\.\d+)*)(?:\s|$)/.exec(headline);
  if (!m) return undefined;
  return `${m[1]!.toLowerCase()}-${m[2]!.replace(/\./g, '-')}`;
}

/**
 * Whether `name` still conveys every bracketed qualifier present in the option `id` (e.g. `[1m]`).
 * Compared loosely — bracket-free and case-insensitive — so "Sonnet 5 (1M context)" counts as
 * carrying `[1m]`, while a bare "Opus" does not carry it for id `opus[1m]`.
 *
 * Only reached when the description states no version. Where one is stated it wins outright, and
 * the qualifier is dropped on purpose — see liveModelName.
 */
function nameKeepsQualifiers(name: string, id: string): boolean {
  const haystack = name.toLowerCase().replace(/[[\]()\s]/g, '');
  return [...id.matchAll(/\[([^\]]+)\]/g)].every((m) =>
    haystack.includes(m[1]!.toLowerCase().replace(/\s/g, ''))
  );
}

/**
 * The session's reasoning effort, read out of its ACP `configOptions` for the footer.
 *
 * Found by `category`, not by `id`, because the harnesses disagree on the id and agree on the
 * category — probed 2026-09-23: claude-agent-acp 0.81.0 and opencode 2.0.14 both call it `effort`,
 * codex-acp (codex-cli 0.155.1) calls it `reasoning_effort`, and all three tag it
 * `category: "thought_level"`, which is the ACP spec's own name for this selector. The spec calls
 * category "UX only", and UX is exactly what this is: nothing but the footer reads the answer.
 *
 * Returns undefined — segment omitted — in three situations, each of them deliberate:
 * - no such option. opencode offers one only while the current model has reasoning variants (none
 *   on `opencode/mimo-v2.6-flash-free`; switching to `anthropic/claude-opus-4-8` adds it), and dsh
 *   and gemini have none at all;
 * - `default`, which is where claude and opencode start. It means "whatever the model defaults to"
 *   and names no level, so printing it would look like a level while telling the reader nothing;
 * - a non-string currentValue (a boolean option filed under the category by some future harness).
 *
 * The raw value is returned rather than the option's display name: the values are already the
 * words (`high`, `xhigh`, `max`), and on codex the name is a sentence.
 */
export function liveEffortName(options: SessionConfigOption[] | null | undefined): string | undefined {
  const opt = options?.find((o) => o.category === THOUGHT_LEVEL_CATEGORY);
  if (!opt) return undefined;
  const current = opt.currentValue;
  if (typeof current !== 'string' || current.length === 0 || current === 'default') return undefined;
  return current;
}

/**
 * The effort option itself, found the way liveEffortName finds it — by category, because the id is
 * the one thing the three harnesses disagree on. Its `id` is what `session/set_config_option` must
 * be sent, so the caller never spells `effort` or `reasoning_effort` itself.
 */
export function effortOption(options: SessionConfigOption[] | null | undefined): SelectConfigOption | undefined {
  const opt = options?.find((o) => o.category === THOUGHT_LEVEL_CATEGORY);
  return opt?.type === 'select' ? opt : undefined;
}

/**
 * The session's effort levels as a selector for `/effort`, or undefined when the current model
 * offers none.
 *
 * Differs from liveEffortName in the one place the two readers want different things: `default`
 * is KEPT as `current`. The footer drops it because it names no level; a menu must show it,
 * because on claude and opencode it is one of the choices, and a menu with no ● anywhere would
 * leave the user unable to tell where they are.
 *
 * An option with no choices is reported as no selector: a menu of nothing is not a menu.
 */
export function effortSelectorOf(options: SessionConfigOption[] | null | undefined): EffortSelector | undefined {
  const opt = effortOption(options);
  if (!opt) return undefined;
  const levels = opt.options
    .flatMap((entry) => ('group' in entry ? entry.options : [entry]))
    .map((o) => ({ value: o.value, name: o.name || o.value }));
  if (levels.length === 0) return undefined;
  return { current: opt.currentValue || undefined, options: levels };
}

/**
 * The session's own settings — every `select` config option in a custom (`_`) category — for the
 * status strip and the generic switch (SessionOption).
 *
 * Only the custom categories, and only by category: the model, effort and mode selectors each have
 * a path of their own that remembers the person's choice, and a reserved category the gateway does
 * not handle (`model_config`, which claude-agent-acp reports) or an option with no category at all
 * must not grow a button nobody designed for it. A boolean option is skipped: there is no switch
 * for one, and an option with no choices is no setting to show.
 */
export function customOptionsOf(options: SessionConfigOption[] | null | undefined): SessionOption[] {
  return (options ?? []).flatMap((opt) => {
    if (opt.type !== 'select' || !opt.category?.startsWith(CUSTOM_CATEGORY_PREFIX)) return [];
    const choices = opt.options
      .flatMap((entry) => ('group' in entry ? entry.options : [entry]))
      .map((o) => ({ value: o.value, name: o.name || o.value, ...(o.description ? { description: o.description } : {}) }));
    if (choices.length === 0) return [];
    return [{ id: opt.id, name: opt.name || opt.id, ...(opt.currentValue ? { current: opt.currentValue } : {}), options: choices }];
  });
}

/**
 * Re-apply a conversation's `/effort` choice to a freshly started or reloaded session, returning
 * the option list the harness reports afterwards (undefined when nothing was sent).
 *
 * This is not the model's belt-and-braces: without it the choice is lost on the very first idle
 * reclaim. Probed 2026-09-23 by setting `low`, killing the child and `session/load`ing the same
 * session into a new one — claude-agent-acp 0.81.0 and codex-acp 1.13.0 both came back at `high`
 * (their defaults for the model), opencode 2.0.14 came back at `low`. So two of three harnesses
 * treat the level as process state, not session state.
 *
 * Also run after a runtime `/model`, because the effort list belongs to the model: opencode's
 * variants differ per model, and codex falls back to the new model's default when the old level is
 * not among its levels.
 *
 * Best-effort, like applyModelPreference and for its reasons — never fails the turn. A level the
 * current model does not offer is skipped with a log line rather than forced: the preference stays
 * recorded, so a later switch back to a model that has it picks it up again, and the footer shows
 * the level that is really in force meanwhile.
 */
export async function applyEffortPreference(
  ctx: Pick<ClientContext, 'request'>,
  sessionId: string,
  def: AgentDef,
  options: SessionConfigOption[] | undefined,
  want: string | undefined
): Promise<SessionConfigOption[] | undefined> {
  if (!want) return undefined;
  const opt = effortOption(options);
  if (!opt) {
    console.log(`[acp] agent "${def.id}": effort "${want}" not applied — the current model offers no effort levels`);
    return undefined;
  }
  if (opt.currentValue === want) return undefined; // already there — don't spend a round trip
  const offered = opt.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
  if (!offered.some((o) => o.value === want)) {
    console.warn(
      `[acp] agent "${def.id}": effort "${want}" is not offered by the current model; ` +
        `staying at "${opt.currentValue}". Offered: ${offered.map((o) => o.value).join(', ')}`
    );
    return undefined;
  }
  try {
    const res = await ctx.request('session/set_config_option', {
      sessionId,
      configId: opt.id,
      value: want,
    });
    console.log(`[acp] agent "${def.id}": effort re-applied as "${want}"`);
    return res?.configOptions ?? undefined;
  } catch (err) {
    console.warn(
      `[acp] agent "${def.id}": could not re-apply effort "${want}" (${err instanceof Error ? err.message : err}); ` +
        `staying at "${opt.currentValue}"`
    );
    return undefined;
  }
}

/**
 * Enforce a model on a started session — `agents[].model` or the conversation's `/model` choice on
 * session/new, the choice alone on session/load — returning the option list the harness reports
 * afterwards (undefined when nothing was applied, so the caller keeps what the session reported).
 *
 * The whole list rather than just the resulting model name, because the model is not the only
 * thing a model switch changes: the effort levels belong to the model too, and the caller re-applies
 * `/effort` against the list this returns — reading it off session/new instead would validate the
 * level against the model the session was just switched AWAY from.
 *
 * Why this exists: session/new carries the model only as a `_meta.model` hint, which the spec lets
 * an agent ignore — and opencode does. Verified against the deployed harness: with
 * `_meta.model: 'anthropic/claude-opus-5'` it still reported `opencode/big-pickle` (its own
 * default), while `session/set_config_option` set it correctly. So a configured model was silently
 * not taking effect, and the only visible symptom was the footer naming a model nobody asked for.
 *
 * Best-effort by design — a harness with no model selector, an unknown model id, or an agent that
 * rejects the request must not fail the turn. Anything unexpected is logged once and the session
 * proceeds on whatever the harness chose, which is strictly better than refusing to answer. The
 * mismatch stays visible in the footer either way.
 */
export async function applyModelPreference(
  ctx: Pick<ClientContext, 'request'>,
  sessionId: string,
  def: AgentDef,
  /** The session's option list as it just reported it (session/new or session/load). */
  options: SessionConfigOption[] | undefined,
  /** The model to enforce — a `/model` choice, or the configured one; undefined enforces nothing. */
  want: string | undefined
): Promise<SessionConfigOption[] | undefined> {
  if (!want) return undefined;
  const profile = HARNESS_PROFILES[def.harness];
  const wireWant = profile.encodeModelWire ? profile.encodeModelWire(want) : want;
  const display = (v: string): string => (profile.decodeModelDisplay ? profile.decodeModelDisplay(v) : v);

  const opt = (options ?? []).find((o) => o.id === MODEL_CONFIG_ID);
  // No model selector at all (the claude harness pins its model via ANTHROPIC_MODEL instead):
  // nothing to set, and saying so at debug avoids a scary warning for a supported setup.
  if (!opt || opt.type !== 'select') {
    console.debug(`[acp] agent "${def.id}" exposes no model selector; leaving model.${want ? ` (configured "${want}" applies only if the harness reads it elsewhere)` : ''}`);
    return undefined;
  }
  if (opt.currentValue === wireWant) return undefined; // already correct — don't spend a round trip

  // Only offer ids the agent actually lists; a typo would otherwise surface as an opaque rejection.
  const offered = opt.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
  if (offered.length > 0 && !offered.some((o) => o.value === wireWant)) {
    console.warn(
      `[acp] agent "${def.id}": model "${want}" is not among the models it offers; ` +
        `continuing with "${display(opt.currentValue)}". Available: ${offered.map((o) => display(o.value)).join(', ')}`
    );
    return undefined;
  }

  try {
    const res = await ctx.request('session/set_config_option', {
      sessionId,
      configId: MODEL_CONFIG_ID,
      value: wireWant,
    });
    console.log(`[acp] agent "${def.id}": model set to "${want}"`);
    return res?.configOptions ?? undefined;
  } catch (err) {
    console.warn(
      `[acp] agent "${def.id}": could not set model "${want}" (${err instanceof Error ? err.message : err}); ` +
        `continuing with "${opt.currentValue}"`
    );
    return undefined;
  }
}

/**
 * Pin `agents[].options` on a started session — the harness's own config options that fleetherd has
 * no menu for, e.g. cursor's `context` (`256k` / `500k`) and `fast`.
 *
 * Why this exists: an option the client cannot render is one the person cannot choose, and a
 * harness that offers it only when the client advertises a picker (cursor does — see
 * isCursorAgent) would otherwise leave it at whatever its own config last said. Pinning it here
 * makes the value a property of the agent definition, on the agent's own host, instead of a file
 * the CLI rewrites behind the gateway's back.
 *
 * Order matters and is enforced by the caller: after the model, because the option set belongs to
 * the model, and before the conversation's `/effort`, so a level chosen in chat still wins over a
 * pinned `reasoning_effort`.
 *
 * Best-effort like its siblings — never fails a turn. An id the current model does not offer, or a
 * value it does not list, is skipped with a log line rather than forced: a model switch reshapes
 * the set (cursor's `effort` becomes `reasoning_effort`, `thinking` appears or goes), and a pin
 * meant for one model must not take the next one's session down.
 */
export async function applyPinnedOptions(
  ctx: Pick<ClientContext, 'request'>,
  sessionId: string,
  def: AgentDef,
  options: SessionConfigOption[] | undefined,
  pinned: AgentDef['options']
): Promise<SessionConfigOption[] | undefined> {
  const entries = Object.entries(pinned ?? {});
  if (entries.length === 0) return undefined;
  let current = options;
  let changed = false;
  for (const [id, raw] of entries) {
    const want = String(raw);
    const opt = current?.find((o) => o.id === id);
    if (!opt || opt.type !== 'select') {
      console.debug(`[acp] agent "${def.id}": pinned option "${id}" is not offered by this session; leaving it`);
      continue;
    }
    if (opt.currentValue === want) continue; // already there — don't spend a round trip
    const offered = opt.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
    if (offered.length > 0 && !offered.some((o) => o.value === want)) {
      console.warn(
        `[acp] agent "${def.id}": pinned option "${id}" does not offer "${want}" here; ` +
          `staying at "${opt.currentValue}". Offered: ${offered.map((o) => o.value).join(', ')}`
      );
      continue;
    }
    try {
      const res = await ctx.request('session/set_config_option', { sessionId, configId: id, value: want });
      current = res?.configOptions ?? current;
      changed = true;
      console.log(`[acp] agent "${def.id}": option "${id}" pinned to "${want}"`);
    } catch (err) {
      console.warn(
        `[acp] agent "${def.id}": could not pin option "${id}" to "${want}" ` +
          `(${err instanceof Error ? err.message : err}); staying at "${opt.currentValue}"`
      );
    }
  }
  return changed ? current : undefined;
}

/**
 * How a session's mode is read and set, by the route its harness offers. Measured 2026-11-18
 * (project-reports/acp-permission-modes-20261118.md): claude-agent-acp, codex-acp and CodeBuddy
 * report the `modes` field on session/new and take `session/set_mode`; opencode reports no `modes`,
 * only a config option of category `mode`, set with `session/set_config_option`. `modes` is used
 * where it exists, since it is the protocol's mode surface proper; the config option otherwise —
 * found by its category, the protocol's, not by its id, the harness's.
 */
export type ModeControl = SessionModeSelector &
  ({ via: 'set_mode' } | { via: 'config_option'; configId: string });

/** The session's mode control, or undefined when it reports neither route (or no modes on it). */
export function modeControlOf(
  modes: SessionModeState | null | undefined,
  options: SessionConfigOption[] | null | undefined
): ModeControl | undefined {
  if (modes && modes.availableModes.length > 0) {
    return {
      via: 'set_mode',
      current: modes.currentModeId || undefined,
      options: modes.availableModes.map((m) => ({ value: m.id, name: m.name || m.id })),
    };
  }
  const opt = options?.find((o) => o.category === MODE_CATEGORY);
  if (opt?.type !== 'select') return undefined;
  const choices = opt.options
    .flatMap((entry) => ('group' in entry ? entry.options : [entry]))
    .map((o) => ({ value: o.value, name: o.name || o.value }));
  if (choices.length === 0) return undefined;
  return { via: 'config_option', configId: opt.id, current: opt.currentValue || undefined, options: choices };
}

/**
 * Whether this agent's modes are left out of its permission levels — read for the settings
 * screen, and never set — so that it is offered `ask` and `auto` alone.
 *
 * agy, for two reasons. Its modes could not be measured on 2026-11-18 (the probing machine's login
 * had expired, and `session/new` answers `Authentication required` before it reports any), so
 * nothing says what they do now. And what was measured before says its names do not mean what the
 * levels' do: on 1.5.1 (2026-11-06) its `default` — "Ask before edits and commands" — asked before
 * a command but wrote into its working directory without asking, so `ask` there would be a level
 * that lets edits through unseen. The gateway's half still holds for agy: `ask` puts whatever it
 * does ask to the person, and its own mode stays as it is (applyPermissionLevel).
 */
function modesLeftOut(def: AgentDef): boolean {
  return HARNESS_FACTS[def.harness].ignoresSessionModes;
}

/** The `modes` a session/new or session/load answer carried, if any. */
export function reportedModes(res: { modes?: SessionModeState | null } | null | undefined): SessionModeState | undefined {
  return res?.modes ?? undefined;
}

/** What a session reports about its mode, as the two places ACP carries it. */
export interface ModeState {
  modes: SessionModeState | undefined;
  options: SessionConfigOption[] | undefined;
}

/**
 * Put a session in the mode its agent's permission level means (`agents[].permissions`,
 * core/permission-levels.ts), returning what the harness reports afterwards (undefined when nothing
 * was sent).
 *
 * Run when a session starts or reloads — after the model and the pinned options, since both can
 * reshape the option set — and when the level is changed from chat (applyPermissions). Not after
 * every turn or model switch: the harness moves its own mode when the person approves leaving
 * `plan` ("Yes, and auto-accept edits"), and putting it back behind them would undo the answer they
 * just gave. A reload does put the level back, because claude and CodeBuddy reload at their
 * default mode and opencode at the last one (measured 2026-11-18): the level is where a session
 * starts.
 *
 * Best-effort like its siblings — never fails a turn. A level with no mode on offer leaves the
 * mode alone with a log line: the gateway's half of the level still holds, since answerPermission
 * reads the level per request.
 */
export async function applyPermissionLevel(
  ctx: Pick<ClientContext, 'request'>,
  sessionId: string,
  def: AgentDef,
  state: ModeState
): Promise<Partial<ModeState> | undefined> {
  if (def.permissions === undefined || modesLeftOut(def)) return undefined;
  const control = modeControlOf(state.modes, state.options);
  const offered = (control?.options ?? []).map((m) => m.value);
  const pinned = def.options['mode'];
  const want = levelMode(def.permissions, offered, pinned === undefined ? undefined : String(pinned));
  if (!control || !want) {
    console.log(
      `[acp] agent "${def.id}": permissions "${def.permissions}" has no session mode here` +
        (control ? ` (offered: ${offered.join(', ')}); staying at "${control.current}"` : ' (it reports no modes)')
    );
    return undefined;
  }
  if (control.current === want) return undefined; // already there — don't spend a round trip
  try {
    let after: Partial<ModeState>;
    if (control.via === 'set_mode') {
      await ctx.request('session/set_mode', { sessionId, modeId: want });
      // set_mode answers with nothing to read back; the harness's own current_mode_update (or
      // config_option_update) follows, and is folded in the same way when it does.
      after = { modes: { availableModes: state.modes?.availableModes ?? [], currentModeId: want } };
    } else {
      const res = await ctx.request('session/set_config_option', { sessionId, configId: control.configId, value: want });
      after = res?.configOptions ? { options: res.configOptions } : {};
    }
    console.log(`[acp] agent "${def.id}": mode set to "${want}" for permissions "${def.permissions}"`);
    return after;
  } catch (err) {
    console.warn(
      `[acp] agent "${def.id}": could not set mode "${want}" for permissions "${def.permissions}" ` +
        `(${err instanceof Error ? err.message : err}); staying at "${control.current}"`
    );
    return undefined;
  }
}

/** The session's modes for the settings screen — undefined where they are left out (modesLeftOut). */
export function permissionModesOf(def: AgentDef, state: ModeState): SessionModeSelector | undefined {
  if (modesLeftOut(def)) return undefined;
  const control = modeControlOf(state.modes, state.options);
  return control ? { ...(control.current ? { current: control.current } : {}), options: control.options } : undefined;
}

/**
 * Per-session runtime state for model, effort, custom options, and permission mode.
 *
 * Composed by `AcpSession` (composition over inheritance): holds the session's live config options,
 * modes, and persisted `/model` & `/effort` preferences, and drives all `session/set_config_option`
 * and `session/set_mode` updates in the required dependency order.
 */
export class AcpOptionState {
  /**
   * Model the harness reports as actually serving this session (from the session/new or session/load
   * config options). Undefined when the agent exposes no model selector; the footer then falls back
   * to the configured value. Cleared on child reset so a rebuilt child re-reports.
   */
  liveModel: string | undefined;
  /**
   * The session's config options as the harness last reported them (session/new, session/load,
   * set_config_option, config_option_update). Kept whole across idle reclaims so `/model` still
   * sees the choice list while the child is down.
   */
  liveConfigOptions: SessionConfigOption[] | undefined;
  /**
   * The session's `modes` as the harness last reported them (session/new, session/load, a mode it
   * was set to, current_mode_update) — kept across reclaims like liveConfigOptions.
   */
  liveModes: SessionModeState | undefined;
  /** Model chosen at runtime for THIS conversation (`/model`), outranking `agents[].model`. */
  modelPreference: string | undefined;
  /** Reasoning effort chosen at runtime for THIS conversation (`/effort`). */
  effortPreference: string | undefined;

  constructor(
    private readonly def: AgentDef,
    conversationId: string,
    store?: SessionMemory
  ) {
    this.modelPreference = store?.conversationChoice?.(conversationId, def.id, 'model');
    this.effortPreference = store?.conversationChoice?.(conversationId, def.id, 'effort');
  }

  /** Capture config options and modes reported when a session opens (`session/new`, `load`, `fork`). */
  captureOpened(options: SessionConfigOption[] | null | undefined, modes: SessionModeState | undefined): void {
    this.liveConfigOptions = options ?? undefined;
    this.liveModes = modes;
    this.liveModel = liveModelName(this.liveConfigOptions);
  }

  /** Update from a mid-session `config_option_update`. */
  onConfigOptions(options: SessionConfigOption[] | null | undefined): void {
    if (!options) return;
    this.liveConfigOptions = options;
    this.liveModel = liveModelName(options) ?? this.liveModel;
  }

  /** Update from a mid-session `current_mode_update`. */
  onModeChanged(modeId: string): void {
    if (this.liveModes) this.liveModes = { ...this.liveModes, currentModeId: modeId };
  }

  /** Clear per-child model name on teardown; keep `liveConfigOptions` / `liveModes` / preferences. */
  resetChild(): void {
    this.liveModel = undefined;
  }

  /** The model the session's selector is on, by id — what agy's window table is keyed on. */
  currentModelValue(): string | undefined {
    const opt = this.liveConfigOptions?.find((o) => o.id === MODEL_CONFIG_ID);
    return opt?.type === 'select' && typeof opt.currentValue === 'string' ? opt.currentValue : this.liveModel;
  }

  /** The model to enforce on a reloaded session: the person's choice, or (for agy) the configured one too. */
  modelAfterLoad(): string | undefined {
    return this.modelPreference ?? (HARNESS_PROFILES[this.def.harness].forgetsModelOnLoad ? this.def.model : undefined);
  }

  /** The model hint to pass on `session/new` / `session/fork`. */
  initialModelHint(): string | undefined {
    return this.modelPreference ?? this.def.model;
  }

  /**
   * Tell a new set of handlers what the session already knows about itself: live model, effort,
   * and custom settings (harnesses do not re-send these unless they change).
   */
  reportSessionFacts(handlers: AgentStreamHandlers): void {
    if (this.liveModel) handlers.onModel?.(this.liveModel);
    const effort = liveEffortName(this.liveConfigOptions);
    if (effort) handlers.onEffort?.(effort);
    if (this.liveConfigOptions) handlers.onOptions?.(customOptionsOf(this.liveConfigOptions));
  }

  async reapplyEffort(ctx: Pick<ClientContext, 'request'>, sessionId: string, fallback?: string): Promise<void> {
    const after = await applyEffortPreference(ctx, sessionId, this.def, this.liveConfigOptions, this.effortPreference ?? fallback);
    if (after) this.liveConfigOptions = after;
  }

  async reapplyPinned(ctx: Pick<ClientContext, 'request'>, sessionId: string): Promise<void> {
    const after = await applyPinnedOptions(ctx, sessionId, this.def, this.liveConfigOptions, this.def.options);
    if (after) this.liveConfigOptions = after;
  }

  async reapplyPermissionLevel(ctx: Pick<ClientContext, 'request'>, sessionId: string): Promise<void> {
    const after = await applyPermissionLevel(ctx, sessionId, this.def, {
      modes: this.liveModes,
      options: this.liveConfigOptions,
    });
    if (after?.modes) this.liveModes = after.modes;
    if (after?.options) this.liveConfigOptions = after.options;
  }

  /**
   * Apply a started session's runtime choices in the required order: model first, then pinned
   * options, permission level mode, and finally effort (since option sets and effort levels
   * depend on the active model, and user `/effort` outranks a pinned `reasoning_effort`).
   */
  async reapplyPreferences(
    ctx: Pick<ClientContext, 'request'>,
    sessionId: string,
    model: string | undefined
  ): Promise<void> {
    const split = model ? HARNESS_PROFILES[this.def.harness].splitModelOption?.(model, this.liveConfigOptions) : undefined;
    const afterModel = await applyModelPreference(ctx, sessionId, this.def, this.liveConfigOptions, split?.model ?? model);
    if (afterModel) {
      this.liveConfigOptions = afterModel;
      this.liveModel = liveModelName(afterModel) ?? this.liveModel;
    }
    await this.reapplyPinned(ctx, sessionId);
    await this.reapplyPermissionLevel(ctx, sessionId);
    await this.reapplyEffort(ctx, sessionId, split?.effort);
  }

  modelSelector(): ModelSelector | undefined {
    const opt = this.liveConfigOptions?.find((o) => o.id === MODEL_CONFIG_ID);
    if (!opt || opt.type !== 'select') return undefined;
    const decode = HARNESS_PROFILES[this.def.harness].decodeModelDisplay;
    const display = (v: string): string => (decode ? decode(v) : v);
    const options = opt.options
      .flatMap((entry) => ('group' in entry ? entry.options : [entry]))
      .map((o) => ({ value: display(o.value), name: o.name || display(o.value) }));
    return {
      current: typeof opt.currentValue === 'string' ? display(opt.currentValue) : undefined,
      options,
    };
  }

  async setModel(
    value: string,
    live?: { ctx: Pick<ClientContext, 'request'>; sessionId: string }
  ): Promise<string> {
    const encode = HARNESS_PROFILES[this.def.harness].encodeModelWire;
    const wire = encode ? encode(value) : value;
    if (!live) {
      this.modelPreference = value;
      console.log(`[acp] agent "${this.def.id}": model "${value}" deferred — no live child, applies on next turn`);
      return value;
    }
    const res = await live.ctx.request('session/set_config_option', {
      sessionId: live.sessionId,
      configId: MODEL_CONFIG_ID,
      value: wire,
    });
    this.modelPreference = value;
    this.liveConfigOptions = res?.configOptions ?? this.liveConfigOptions;
    await this.reapplyPinned(live.ctx, live.sessionId);
    await this.reapplyEffort(live.ctx, live.sessionId);
    this.liveModel = liveModelName(this.liveConfigOptions) ?? value;
    console.log(`[acp] agent "${this.def.id}": model switched to "${value}" at runtime`);
    return this.liveModel;
  }

  effortSelector(): EffortSelector | undefined {
    return effortSelectorOf(this.liveConfigOptions);
  }

  async setEffort(
    value: string,
    live?: { ctx: Pick<ClientContext, 'request'>; sessionId: string }
  ): Promise<string> {
    if (!live) {
      this.effortPreference = value;
      console.log(`[acp] agent "${this.def.id}": effort "${value}" deferred — no live child, applies on next turn`);
      return value;
    }
    const opt = effortOption(this.liveConfigOptions);
    if (!opt) throw new Error('the current model offers no effort levels');
    const res = await live.ctx.request('session/set_config_option', {
      sessionId: live.sessionId,
      configId: opt.id,
      value,
    });
    this.effortPreference = value;
    this.liveConfigOptions = res?.configOptions ?? this.liveConfigOptions;
    console.log(`[acp] agent "${this.def.id}": effort switched to "${value}" at runtime`);
    return effortOption(this.liveConfigOptions)?.currentValue || value;
  }

  sessionOptions(): SessionOption[] | undefined {
    return this.liveConfigOptions ? customOptionsOf(this.liveConfigOptions) : undefined;
  }

  async setOption(
    id: string,
    value: string,
    live?: { ctx: Pick<ClientContext, 'request'>; sessionId: string }
  ): Promise<SessionOption[]> {
    if (!live) throw new Error('the agent has no live session to change');
    if (!customOptionsOf(this.liveConfigOptions).some((o) => o.id === id)) {
      throw new Error(`the agent offers no setting "${id}"`);
    }
    const res = await live.ctx.request('session/set_config_option', {
      sessionId: live.sessionId,
      configId: id,
      value,
    });
    this.liveConfigOptions = res?.configOptions ?? this.liveConfigOptions;
    this.liveModel = liveModelName(this.liveConfigOptions) ?? this.liveModel;
    console.log(`[acp] agent "${this.def.id}": setting "${id}" set to "${value}"`);
    return customOptionsOf(this.liveConfigOptions);
  }

  permissionModes(): SessionModeSelector | undefined {
    return permissionModesOf(this.def, { modes: this.liveModes, options: this.liveConfigOptions });
  }
}
