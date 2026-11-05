import type { Config, SessionScope } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import type { SettingsScreen, SettingsScreenOption, SettingsScreenRow } from '../types.js';
import { formatButtonId, parseButtonId } from './button-id.js';
import { matchModels, type ModelOption } from './model-menu.js';
import { pageCount, pageOf, pageSlice, truncateLabel, wrapPage } from './paging.js';
/**
 * `/setting` as data: which config.yaml fields are editable from chat, what each accepts, when a
 * change takes effect, and every string either surface says.
 *
 * ── What this is for ──────────────────────────────────────────────────────────
 * Changing config.yaml otherwise means reaching the machine the daemon runs on, editing YAML, and
 * restarting — and a restart stops every resident agent child. A handful of those fields are not
 * deployment plumbing at all but a decision someone makes on a Tuesday: which agent answers by
 * default, what model an agent should default to, how long an idle conversation keeps its process.
 * Those are exactly the fields that stayed on the user surface instead of being frozen into
 * EXPERIENCE (see config/README.md), and they were paying the heaviest edit cost in the product.
 *
 * ── Why a table rather than a switch ──────────────────────────────────────────
 * One entry per setting drives all of it: the menu rows, the `/help`-style text list, value
 * validation, the config path that gets patched, and the ack sentence. That is the same
 * single-source rule GENERIC_COMMANDS and REVERSE_COMMANDS follow — a settings screen that lists a
 * field it cannot actually write (or writes one it never listed) is the drift worth designing out.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────────
 * `access.allowFrom`, platform credentials, the `agents[]` shape (harness/command/args/env/cwd) and
 * `routing.pipeline`. Those are refused BY NAME (see NOT_EDITABLE) rather than merely absent,
 * because "nothing happened" is the failure mode this repo avoids. The reasons differ and are worth
 * keeping distinct: the allowlist is the one field where a wrong tap locks the operator out of their
 * own bot with no path back from chat; credentials have no business in a chat log; a routing rule is
 * a structure, not a value a picker can offer.
 *
 * ── Its relationship to `/model` ──────────────────────────────────────────────
 * `/model` sets a RUNTIME override for one conversation and is forgotten on restart. `/setting
 * model.<agent>` writes the persisted default. The override outranks the default (see
 * agent-acp.ts applyModelPreference), so an ack says so when one is in the way.
 */

/** The settings this gateway can write. Everything else is refused by name. */
export type SettingId = 'agent' | 'model' | 'delegation' | 'idle' | 'scope' | 'stream' | 'voice' | 'cleanup';

/**
 * When a change reaches the running daemon.
 *
 * - `live`     — the runtime re-reads this value per message, so patching the in-memory Config is
 *                the whole job.
 * - `next-session` — the value is read when an agent child is spawned, so a resident one keeps the
 *                old value until it is disposed (`/new`, an idle reclaim, a restart).
 * - `restart`  — written to the file only. Used where applying it live would change something
 *                under the user's feet more surprisingly than a restart would.
 */
export type SettingEffect = 'live' | 'next-session' | 'restart';

/** One selectable value of a setting. `raw` is what the parser accepts; `label` is what a button shows. */
export interface SettingOption {
  raw: string;
  /**
   * What a chat button shows. It stays whole — a button has one line, so the value and its
   * explanation are joined with a dash.
   */
  label: string;
  /**
   * The value alone, for a screen that draws the label and its explanation as two lines (the web
   * UI's settings screen). Absent where `label` has no explanation to separate.
   */
  title?: string;
  /** The explanation `label` appends after its dash, when there is one. */
  detail?: string;
}

/**
 * One line of the settings screen: a setting, its target when it has one, and its current value.
 *
 * Built fresh from the Config every time a menu is opened or a list is printed, so the value shown
 * is never a cached one. Row ORDER is stable (see settingsRows) because a menu button carries an
 * index into it.
 */
export interface SettingRow {
  id: SettingId;
  /** The agent a per-agent setting applies to; absent for global ones. */
  target?: string;
  /** Menu label, e.g. `Default model · cc`. */
  label: string;
  /** Current value, already formatted for display. */
  value: string;
  effect: SettingEffect;
}

/**
 * What the daemon knows that the config does not: which agent is answering here, and what models it
 * currently offers.
 */
export interface SettingsContext {
  /** The agent answering the conversation `/setting` was typed in — the default target of `model`. */
  boundAgent: string;
  /**
   * Models that agent offers right now, as its live ACP session reports them; empty when there is
   * no live session or the harness reports no selector.
   *
   * Empty for every OTHER agent too, by construction: a model list only exists on a live session,
   * and this conversation has at most one. That is why a value MENU for `model` is offered only for
   * `boundAgent`, and any other agent's model is set by typing the name.
   */
  models: readonly ModelOption[];
}

/** Where a setting lives in the config tree. */
export type SettingLocation =
  /** A fixed path (`session.scope`, `routing.default`). */
  | { kind: 'path'; path: string[] }
  /**
   * A field of one `agents[]` entry, named by AGENT ID rather than by index. The index has to be
   * resolved against the file at write time — see daemon/settings-store.ts.
   */
  | { kind: 'agent'; agentId: string; key: 'model' };

/** Outcome of reading a user-supplied value for a setting. */
export type ParsedSettingValue =
  | {
      kind: 'value';
      /** The value to write. `undefined` means DELETE the key (fall back to the schema default). */
      value: string | number | boolean | undefined;
      /** How the ack spells it. */
      display: string;
      /** An extra sentence the ack should carry (e.g. a model name the agent never advertised). */
      note?: string;
    }
  | { kind: 'invalid'; reason: string };

// ─────────────────────────────── the table ───────────────────────────────

/** Scope options, with what each one means in one clause. */
const SCOPE_OPTIONS = [
  ['per_thread', 'a topic / thread is its own conversation'],
  ['per_channel', 'every lane of a channel shares one'],
  ['per_user', 'one conversation per person, anywhere'],
  ['shared', 'one conversation for the whole deployment'],
] as const satisfies ReadonlyArray<readonly [SessionScope, string]>;

/**
 * Idle-reclaim presets.
 *
 * Offered as buttons because the useful answers are few and far apart — the question is "minutes,
 * an hour, or half a day", not a number. The typed form still takes any `<n>m` / `<n>h`.
 */
const IDLE_PRESETS = ['off', '15m', '1h', '4h', '12h'] as const;

/** Upper bound on a typed idle window: past a month the value is a typo, not a policy. */
const MAX_IDLE_MS = 30 * 24 * 3_600_000;

/** Tokens that clear an optional field back to its default (`agents[].model`). */
const CLEAR_TOKENS = new Set(['-', 'default', 'unset', 'clear', 'none']);

/**
 * Most options a text answer lists before it stops being scannable on a phone. Past this the answer
 * is a narrower query (or the menu), not a longer message — the same cap MODEL_MATCH_MAX sets.
 */
const DETAIL_OPTION_MAX = 12;

/**
 * Config keys `/setting` recognizes and refuses, with the reason.
 *
 * Keyed by the first dot-segment of what the user typed, so `access`, `access.allowFrom` and
 * `allowFrom` all land on the same sentence. Refusing by name rather than answering "unknown
 * setting" is the point: these are real fields with real names, and the useful reply says where to
 * change them and why they are not here.
 */
const NOT_EDITABLE: Record<string, string> = {
  access: 'the authorization allowlist',
  allowfrom: 'the authorization allowlist',
  platforms: 'platform credentials and instances',
  token: 'platform credentials and instances',
  agents: 'an agent definition beyond its model',
  harness: 'an agent definition beyond its model',
  command: 'an agent definition beyond its model',
  args: 'an agent definition beyond its model',
  env: 'an agent definition beyond its model',
  cwd: 'an agent definition beyond its model',
  hooks: "an agent's pre-launch hook",
  prelaunch: "an agent's pre-launch hook",
  routing: 'the routing pipeline',
  pipeline: 'the routing pipeline',
  display: 'reply decoration (header / footer / reactions)',
  header: 'reply decoration (header / footer / reactions)',
  footer: 'reply decoration (header / footer / reactions)',
  reactions: 'reply decoration (header / footer / reactions)',
  chat: 'per-platform response gating',
  requiremention: 'per-platform response gating',
  allowbots: 'per-platform response gating',
  channels: 'per-platform response gating',
  autothread: 'per-platform response gating',
  tools: 'the streaming experience',
  inbound: 'the streaming experience',
  attachments: 'the streaming experience',
  ipc: 'the streaming experience',
  // Reached only when no row matched — i.e. anything under `voice.` other than its two switches,
  // or a switch itself on a deployment with no `voice:` block.
  voice: 'voice transcription beyond its two switches',
  cleanup: 'voice transcription beyond its two switches',
  transcriber: 'voice transcription beyond its two switches',
  vocabulary: 'voice transcription beyond its two switches',
};

/**
 * Why each refused group is refused. Split from NOT_EDITABLE so a group's reason is written once,
 * however many spellings reach it.
 */
const REFUSAL_REASON: Record<string, string> = {
  'the authorization allowlist':
    'one wrong value there locks you out of your own bot, and chat is the surface you would be locked out of',
  'platform credentials and instances':
    'they need a restart, and a credential has no business in a chat log',
  'an agent definition beyond its model':
    'how an agent is launched is an edit to its definition, not a value to pick from a list',
  "an agent's pre-launch hook":
    'it is a shell command this machine runs, and setting one from chat would be running commands on it remotely',
  'the routing pipeline': 'a routing rule is a structure, not a single value to pick',
  'reply decoration (header / footer / reactions)': 'it is not wired into /setting',
  'per-platform response gating': 'it is not wired into /setting',
  'the streaming experience':
    'it is not in config.yaml at all — those values are frozen in the code on purpose (see src/config/README.md)',
  'voice transcription beyond its two switches':
    'the transcriber is an endpoint and a key, the vocabulary is a list, and turning the feature on is a `voice:` block to add, not a value to pick (`/setting voice` and `/setting cleanup` appear once it exists)',
};

/** Full config paths accepted as aliases for the short keys, so both spellings work. */
const KEY_ALIASES: Record<string, SettingId> = {
  agent: 'agent',
  'routing.default': 'agent',
  default: 'agent',
  model: 'model',
  delegation: 'delegation',
  'delegation.confirm': 'delegation',
  scope: 'scope',
  'session.scope': 'scope',
  idle: 'idle',
  idletimeout: 'idle',
  'session.idletimeoutms': 'idle',
  stream: 'stream',
  streaming: 'stream',
  'stream.enabled': 'stream',
  voice: 'voice',
  'voice.confirm': 'voice',
  voiceconfirm: 'voice',
  cleanup: 'cleanup',
  'voice.cleanup': 'cleanup',
  voicecleanup: 'cleanup',
  'voice-cleanup': 'cleanup',
};

// ─────────────────────────────── reading ───────────────────────────────

/** `cc · claude`, or just the id when the harness name says nothing (custom). */
function agentLabel(cfg: Pick<Config, 'agents'>, id: string): string {
  const name = agentDisplayName(
    cfg.agents.find((a) => a.id === id),
    id
  );
  return name === id ? id : `${id} · ${name}`;
}

/** `off` / `15m` / `1h` — the same vocabulary the parser accepts, so a read value can be typed back. */
export function formatIdle(ms: number): string {
  if (ms <= 0) return 'off';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

/** What an unset `agents[].model` means: the harness picks. */
const MODEL_UNSET = '(harness default)';

/**
 * Every row of the settings screen, in a stable order.
 *
 * `model` expands to one row per configured agent — a deployment with two harnesses has two
 * defaults to set, and folding them into one row would make the screen lie about which one it
 * shows. Order is config order, so the rows (and therefore the button indices) are stable across
 * restarts.
 */
export function settingsRows(cfg: Config): SettingRow[] {
  const rows: SettingRow[] = [
    {
      id: 'agent',
      label: 'Default agent',
      value: agentLabel(cfg, cfg.routing.default),
      effect: 'live',
    },
  ];
  for (const agent of cfg.agents) {
    rows.push({
      id: 'model',
      target: agent.id,
      label: `Default model · ${agent.id}`,
      value: agent.model ?? MODEL_UNSET,
      effect: 'next-session',
    });
  }
  rows.push(
    {
      id: 'delegation',
      label: 'Confirm sub-agent starts',
      value: cfg.delegation.confirm ? 'on' : 'off',
      effect: 'live',
    },
    {
      id: 'idle',
      label: 'Idle reclaim',
      value: formatIdle(cfg.session.idleTimeoutMs),
      effect: 'live',
    },
    {
      id: 'scope',
      label: 'Conversation scope',
      value: cfg.session.scope,
      effect: 'restart',
    },
    {
      id: 'stream',
      label: 'Live streaming',
      value: cfg.stream.enabled ? 'on' : 'off',
      effect: 'live',
    }
  );
  // Only where transcription is configured: a switch for a feature that is off is a row that can
  // be set and does nothing. Last, so the rows above keep their indices either way.
  if (cfg.voice) {
    rows.push(
      {
        id: 'voice',
        label: 'Confirm voice transcripts',
        value: cfg.voice.confirm ? 'on' : 'off',
        effect: 'live',
      },
      {
        id: 'cleanup',
        label: 'Clean up voice transcripts',
        value: cfg.voice.cleanup ? 'on' : 'off',
        effect: 'live',
      }
    );
  }
  return rows;
}

/** One sentence on what a setting decides — the detail screen's subtitle. */
export function settingDescription(row: SettingRow): string {
  switch (row.id) {
    case 'agent':
      return 'Which agent answers when no routing rule matches.';
    case 'model':
      return `The model \`${row.target}\` starts its sessions with. \`/model\` still overrides it for one conversation.`;
    case 'delegation':
      return (
        'Whether `task-new` waits for you to tap Start on a card listing every sub-task (`on`, the ' +
        'default), or starts each one at once and posts a card showing what started (`off`). Off ' +
        'reaches only conversations you talk to directly; a sub-agent\'s own topic still asks. ' +
        'Only you can change this; no agent command reaches it.'
      );
    case 'idle':
      return 'How long a conversation may sit quiet before its agent child is stopped. It resumes on the next message.';
    case 'scope':
      return 'What counts as one conversation — a thread, a channel, a person, or the whole deployment.';
    case 'stream':
      return (
        'Whether a reply is typed out by editing one message as it arrives (`on`), or sent whole once ' +
        'each part is finished (`off`, the default). Off costs no edits, so a long reply can never run ' +
        'into a platform’s per-message edit cap; either way a segment is sent at every tool boundary.'
      );
    case 'voice':
      return (
        'Whether a voice message’s transcript waits for your ✅ Send (`on`, the default) or goes to the ' +
        'agent at once (`off`). Either way the transcript is shown in the chat, labelled as one.'
      );
    case 'cleanup':
      return (
        'Whether a voice message is also written up as the message you meant — fillers, repeats and ' +
        'self-corrections removed — and shown above the words as heard, with ✅ Send sending that ' +
        'version (`on`, the default); or transcribed word for word only (`off`).'
      );
    default: {
      const _exhaustive: never = row.id;
      return String(_exhaustive);
    }
  }
}

/** How the ack describes when the change lands. */
function effectText(row: SettingRow): string {
  switch (row.effect) {
    case 'live':
      return 'in effect now';
    case 'next-session':
      return `applies to ${row.target ?? 'that agent'}'s next agent session — /new starts one now`;
    case 'restart':
      return 'takes effect when the daemon restarts; conversations keep their current identity until then';
    default: {
      const _exhaustive: never = row.effect;
      return String(_exhaustive);
    }
  }
}

/**
 * The same fact as effectText, in the two or three words a settings row can carry. Live changes say
 * nothing: a badge on every row would stop meaning anything.
 */
function effectLabel(row: SettingRow): string | undefined {
  switch (row.effect) {
    case 'live':
      return undefined;
    case 'next-session':
      return 'next session';
    case 'restart':
      return 'after restart';
    default: {
      const _exhaustive: never = row.effect;
      return String(_exhaustive);
    }
  }
}

/**
 * The heading a row sits under on a screen. It is presentation, but it belongs here with the rest
 * of the table: a new setting that falls through to the default is a compile error, not a row
 * stranded under the wrong heading.
 */
function settingGroup(row: SettingRow): string {
  switch (row.id) {
    case 'agent':
    case 'model':
    case 'delegation':
      return 'Agent defaults';
    case 'idle':
    case 'scope':
      return 'Conversation';
    case 'stream':
      return 'Replies';
    case 'voice':
    case 'cleanup':
      return 'Voice';
    default: {
      const _exhaustive: never = row.id;
      return String(_exhaustive);
    }
  }
}

// ─────────────────────────────── key resolution ───────────────────────────────

/** Outcome of resolving what the user typed after `/setting`. */
export type KeyResolution =
  | { kind: 'row'; row: SettingRow }
  /** A real config field that is deliberately not editable from chat. */
  | { kind: 'refused'; text: string }
  /** Not a name this gateway knows at all. */
  | { kind: 'unknown'; key: string };

/**
 * Resolve a typed key to a row.
 *
 * Accepts the short key (`model`), the short key with a target (`model.cc`), and the full config
 * path (`agents.cc.model`, `session.idleTimeoutMs`) — an operator who knows the file should not have
 * to learn a second vocabulary, and someone on a phone should not have to type the first one.
 *
 * A bare per-agent key targets the agent answering HERE: unqualified means here and now, which is
 * the only target a phone user can be expected to have in mind.
 */
export function resolveSettingKey(key: string, cfg: Config, ctx: SettingsContext): KeyResolution {
  const norm = key.trim().replace(/^\//, '').toLowerCase();
  if (!norm) return { kind: 'unknown', key };

  const rows = settingsRows(cfg);
  const target = perAgentTarget(norm, cfg);
  if (target !== undefined) {
    if (target === null) {
      return {
        kind: 'refused',
        text: `No agent named there. Configured agents: ${cfg.agents.map((a) => a.id).join(', ')}.`,
      };
    }
    const row = rows.find((r) => r.id === 'model' && r.target === target);
    if (row) return { kind: 'row', row };
  }

  const id = KEY_ALIASES[norm];
  if (id === 'model') {
    // A bare `model`: the agent answering this conversation.
    const row = rows.find((r) => r.id === 'model' && r.target === ctx.boundAgent);
    if (row) return { kind: 'row', row };
  } else if (id) {
    const row = rows.find((r) => r.id === id);
    if (row) return { kind: 'row', row };
  }

  const group = NOT_EDITABLE[norm.split('.')[0] ?? ''];
  if (group) {
    return {
      kind: 'refused',
      text:
        `\`${key}\` is not editable from chat — ${group} stays in the file, because ` +
        `${REFUSAL_REASON[group] ?? 'it is not offered here'}.\n` +
        // Platforms are the one section /reload cannot apply (see daemon/config-reload.ts).
        (group === NOT_EDITABLE.platforms
          ? 'Edit config.yaml and restart the daemon.'
          : 'Edit config.yaml, then send /reload.'),
    };
  }
  return { kind: 'unknown', key };
}

/**
 * The agent id a per-agent key names: the id for `model.cc` / `agents.cc.model`, `null` when the
 * key is shaped that way but names no configured agent, `undefined` when it is not that shape.
 */
function perAgentTarget(norm: string, cfg: Pick<Config, 'agents'>): string | null | undefined {
  const dotted = /^model\.(.+)$/.exec(norm) ?? /^agents\.(.+)\.model$/.exec(norm);
  if (!dotted) return undefined;
  const wanted = dotted[1]!;
  // Agent ids are case-sensitive in config; match case-insensitively since the key was lowercased.
  return cfg.agents.find((a) => a.id.toLowerCase() === wanted)?.id ?? null;
}

// ─────────────────────────────── values ───────────────────────────────

/** The values a setting offers as buttons. Empty means "typed value only" (see settingDetailText). */
export function settingOptions(row: SettingRow, cfg: Config, ctx: SettingsContext): SettingOption[] {
  switch (row.id) {
    case 'agent':
      return cfg.agents.map((a) => ({ raw: a.id, label: agentLabel(cfg, a.id) }));
    case 'model':
      // Only the bound agent has a live list to offer (see SettingsContext.models). The clear
      // option is offered whenever a value is set, list or no list.
      return [
        ...(row.target === ctx.boundAgent
          ? ctx.models.map((m) => ({ raw: m.value, label: m.name.trim() || m.value }))
          : []),
        ...(cfgModel(cfg, row.target) ? [{ raw: '-', label: MODEL_UNSET }] : []),
      ];
    case 'idle':
      return IDLE_PRESETS.map((p) => ({
        raw: p,
        label: p === 'off' ? 'off (never reclaim)' : p,
        title: p,
        ...(p === 'off' ? { detail: 'never reclaim' } : {}),
      }));
    case 'delegation':
      return [
        {
          raw: 'on',
          label: 'on — wait for Start before any sub-task runs',
          title: 'on',
          detail: 'wait for Start before any sub-task runs',
        },
        {
          raw: 'off',
          label: 'off — start each sub-task at once, and post a card for the record',
          title: 'off',
          detail: 'start each sub-task at once, and post a card for the record',
        },
      ];
    case 'scope':
      return SCOPE_OPTIONS.map(([value, gloss]) => ({
        raw: value,
        label: `${value} — ${gloss}`,
        title: value,
        detail: gloss,
      }));
    case 'stream':
      return [
        {
          raw: 'off',
          label: 'off — send each finished part as a whole message',
          title: 'off',
          detail: 'send each finished part as a whole message',
        },
        {
          raw: 'on',
          label: 'on — type the reply out by editing one message',
          title: 'on',
          detail: 'type the reply out by editing one message',
        },
      ];
    case 'voice':
      return [
        {
          raw: 'on',
          label: 'on — wait for ✅ Send before the agent sees it',
          title: 'on',
          detail: 'wait for ✅ Send before the agent sees it',
        },
        {
          raw: 'off',
          label: 'off — send each transcript on at once',
          title: 'off',
          detail: 'send each transcript on at once',
        },
      ];
    case 'cleanup':
      return [
        {
          raw: 'on',
          label: 'on — show a cleaned-up version too, and send that',
          title: 'on',
          detail: 'show a cleaned-up version too, and send that',
        },
        { raw: 'off', label: 'off — word for word only', title: 'off', detail: 'word for word only' },
      ];
    default: {
      const _exhaustive: never = row.id;
      return _exhaustive;
    }
  }
}

/** The configured model of an agent (undefined = unset). */
function cfgModel(cfg: Config, agentId: string | undefined): string | undefined {
  return agentId ? findAgent(cfg, agentId)?.model : undefined;
}

/**
 * Read a user-supplied value for a setting: the one place both surfaces go through, so a typed
 * `/setting idle 15m` and a tapped `15m` cannot disagree about what they did.
 */
export function parseSettingValue(
  row: SettingRow,
  raw: string,
  cfg: Config,
  ctx: SettingsContext
): ParsedSettingValue {
  const input = raw.trim();
  if (!input) return { kind: 'invalid', reason: 'No value given.' };
  switch (row.id) {
    case 'agent': {
      const match = cfg.agents.find((a) => a.id.toLowerCase() === input.toLowerCase());
      if (!match) {
        return {
          kind: 'invalid',
          reason: `No agent named \`${input}\`. Configured: ${cfg.agents.map((a) => a.id).join(', ')}.`,
        };
      }
      return { kind: 'value', value: match.id, display: agentLabel(cfg, match.id) };
    }
    case 'model':
      return parseModelValue(input, row, ctx);
    case 'delegation':
      return parseBooleanValue(input);
    case 'idle':
      return parseIdleValue(input);
    case 'scope': {
      const match = SCOPE_OPTIONS.find(([value]) => value === input.toLowerCase());
      if (!match) {
        return {
          kind: 'invalid',
          reason: `\`${input}\` is not a scope. One of: ${SCOPE_OPTIONS.map(([v]) => v).join(', ')}.`,
        };
      }
      return { kind: 'value', value: match[0], display: match[0] };
    }
    case 'stream':
    case 'voice':
    case 'cleanup':
      return parseBooleanValue(input);
    default: {
      const _exhaustive: never = row.id;
      return { kind: 'invalid', reason: String(_exhaustive) };
    }
  }
}

/**
 * A model name for `agents[].model`.
 *
 * Resolved against the live list when there is one — `/setting model glm` should behave like
 * `/model glm` does, because typing a full provider-qualified id on a phone is the thing the menu
 * exists to avoid. Three outcomes, and the third is the interesting one:
 *
 * - one match (exact id wins over substring, as in matchModels): use it;
 * - several: refuse and list them, never guess — picking one silently changes what the agent runs;
 * - none: **accept the string as typed.** The selector is not the set of names a harness accepts.
 *   claude's own `/model` documents aliases the ACP config option never lists (`opusplan`, `best`,
 *   a full model id), and `agents[].model` has always been a free string for exactly that reason.
 *   Refusing here would block a legitimate value on the strength of an incomplete list, so the ack
 *   says the name was not advertised instead.
 */
function parseModelValue(input: string, row: SettingRow, ctx: SettingsContext): ParsedSettingValue {
  if (CLEAR_TOKENS.has(input.toLowerCase())) {
    return { kind: 'value', value: undefined, display: MODEL_UNSET };
  }
  const listed = row.target === ctx.boundAgent ? ctx.models : [];
  if (listed.length === 0) return { kind: 'value', value: input, display: input };

  const match = matchModels([...listed], input);
  if (match.kind === 'one') return { kind: 'value', value: match.option.value, display: match.option.value };
  if (match.kind === 'many') {
    const shown = match.matches.slice(0, 12).map((o) => `\`${o.value}\``).join('\n');
    return {
      kind: 'invalid',
      reason: `"${input}" matches ${match.matches.length} of ${row.target}'s models:\n${shown}`,
    };
  }
  return {
    kind: 'value',
    value: input,
    display: input,
    note: `${row.target} does not advertise that name — saved as typed, so check it is one the harness accepts.`,
  };
}

/** A duration for `session.idleTimeoutMs`: `off`, or a number with a unit. */
function parseIdleValue(input: string): ParsedSettingValue {
  const lower = input.toLowerCase();
  if (lower === 'off' || lower === 'never' || lower === '0') {
    return { kind: 'value', value: 0, display: 'off' };
  }
  const m = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(lower);
  if (!m) {
    // A bare number is rejected rather than assumed: the field is milliseconds, nobody means
    // milliseconds, and guessing minutes would silently set a window 60000× off what was asked.
    return {
      kind: 'invalid',
      reason: `\`${input}\` is not a duration. Use \`off\`, or a number with a unit: \`15m\`, \`90m\`, \`4h\`.`,
    };
  }
  const n = Number(m[1]);
  const ms = m[2]!.startsWith('h') ? n * 3_600_000 : n * 60_000;
  if (ms > MAX_IDLE_MS) {
    return { kind: 'invalid', reason: 'At most 30 days (`720h`). Use `off` to never reclaim.' };
  }
  return { kind: 'value', value: ms, display: formatIdle(ms) };
}

/** Where this row's value is stored. The writer resolves an agent index against the file. */
export function settingLocation(row: SettingRow): SettingLocation {
  switch (row.id) {
    case 'agent':
      return { kind: 'path', path: ['routing', 'default'] };
    case 'model':
      return { kind: 'agent', agentId: row.target!, key: 'model' };
    case 'delegation':
      return { kind: 'path', path: ['delegation', 'confirm'] };
    case 'idle':
      return { kind: 'path', path: ['session', 'idleTimeoutMs'] };
    case 'scope':
      return { kind: 'path', path: ['session', 'scope'] };
    case 'stream':
      return { kind: 'path', path: ['stream', 'enabled'] };
    case 'voice':
      return { kind: 'path', path: ['voice', 'confirm'] };
    case 'cleanup':
      return { kind: 'path', path: ['voice', 'cleanup'] };
    default: {
      const _exhaustive: never = row.id;
      return _exhaustive;
    }
  }
}

/**
 * Read an on/off answer.
 *
 * Deliberately generous about spelling — a toggle typed from a phone arrives as whatever the person
 * had in mind, and `true`/`enable`/`1` all plainly mean the same thing here. Anything else is
 * refused rather than coerced: silently reading an unrecognized word as `off` would flip a setting
 * the user believes they just turned on.
 */
function parseBooleanValue(input: string): ParsedSettingValue {
  const on = new Set(['on', 'true', 'yes', 'y', '1', 'enable', 'enabled']);
  const off = new Set(['off', 'false', 'no', 'n', '0', 'disable', 'disabled']);
  const norm = input.toLowerCase();
  if (on.has(norm)) return { kind: 'value', value: true, display: 'on' };
  if (off.has(norm)) return { kind: 'value', value: false, display: 'off' };
  return { kind: 'invalid', reason: `\`${input}\` is not on or off.` };
}

/**
 * The value currently stored for a row, in the form a patch would write — as opposed to
 * `SettingRow.value`, which is formatted for a human. The writer compares against this to answer
 * "already that" without touching the file.
 */
export function readSettingValue(row: SettingRow, cfg: Config): string | number | boolean | undefined {
  switch (row.id) {
    case 'agent':
      return cfg.routing.default;
    case 'model':
      return cfgModel(cfg, row.target);
    case 'delegation':
      return cfg.delegation.confirm;
    case 'idle':
      return cfg.session.idleTimeoutMs;
    case 'scope':
      return cfg.session.scope;
    case 'stream':
      return cfg.stream.enabled;
    case 'voice':
      return cfg.voice?.confirm;
    case 'cleanup':
      return cfg.voice?.cleanup;
    default: {
      const _exhaustive: never = row.id;
      return _exhaustive;
    }
  }
}

// ─────────────────────────────── the outcome ───────────────────────────────

/**
 * Everything that can come of setting a value, as data rather than as a message.
 *
 * A union rather than a boolean because a click handler has no user to re-prompt: each of these has
 * to become a specific sentence, and the exhaustive switch in settingAckText makes a new outcome
 * fail to compile rather than fall through to a generic failure — which, on a button, is
 * indistinguishable from a dead one.
 */
export type SettingApplyResult =
  /** Written to the file; `row.effect` says when it lands. */
  | { kind: 'saved'; row: SettingRow; display: string; note?: string; overridden?: boolean }
  /** Already that value: nothing was written (the file's mtime is information too). */
  | { kind: 'unchanged'; row: SettingRow }
  /** The value was refused; nothing was written. */
  | { kind: 'invalid'; row: SettingRow; reason: string }
  /** The write itself failed (permissions, a file that changed shape under us). */
  | { kind: 'failed'; row: SettingRow; reason: string };

/** Render an outcome. Exhaustive: a new arm must be given words here. */
export function settingAckText(result: SettingApplyResult): string {
  switch (result.kind) {
    case 'saved': {
      const lines = [
        `✓ ${result.row.label} → ${result.display}`,
        `Saved to config.yaml · ${effectText(result.row)}.`,
      ];
      if (result.note) lines.push(result.note);
      // The runtime override wins over what was just written, so an ack that stopped at "saved"
      // would be followed by a conversation that visibly ignores it.
      if (result.overridden) {
        lines.push(
          'Note: this conversation has a `/model` override, which outranks the default until `/new`.'
        );
      }
      return lines.join('\n');
    }
    case 'unchanged':
      return `${result.row.label} is already \`${result.row.value}\` — nothing written.`;
    case 'invalid':
      return result.reason;
    case 'failed':
      return `Could not save ${result.row.label}: ${result.reason}`;
    default: {
      const _exhaustive: never = result;
      return String(_exhaustive);
    }
  }
}

// ─────────────────────────────── text surface ───────────────────────────────

/** The bare `/setting` answer for a platform that cannot carry a menu. */
export function settingsListText(cfg: Config): string {
  const rows = settingsRows(cfg);
  const lines = rows.map((row) => `\`${settingKeyOf(row)}\` — ${row.label}: \`${row.value}\``);
  return [
    'Settings saved in config.yaml:',
    ...lines,
    '',
    'Change one with `/setting <key> <value>` (e.g. `/setting idle 4h`).',
    '`/setting <key>` alone lists what that key accepts.',
  ].join('\n');
}

/** The key to type for a row (what settingsListText prints and resolveSettingKey accepts back). */
export function settingKeyOf(row: SettingRow): string {
  return row.target ? `${row.id}.${row.target}` : row.id;
}

/**
 * Why a setting cannot be set from buttons alone, and what to type instead — or undefined when its
 * button list is complete.
 *
 * One sentence, shared by the text surface and the menu, so a user who hits this gets the same
 * explanation either way. Only `model` can reach it, and the two branches are different problems:
 * the list is merely late for the bound agent, and unavailable in principle for any other.
 *
 * Keyed on the MODEL LIST rather than on "are there any options at all", which is the distinction a
 * first version got wrong: an agent that already has a model set still has one option (clear it),
 * so a value screen offering nothing but `(harness default)` looked complete while being the exact
 * case where the user needs to be told they can type a name.
 */
export function settingTypedOnlyHint(
  row: SettingRow,
  cfg: Config,
  ctx: SettingsContext
): string | undefined {
  if (row.id === 'model') {
    if (row.target === ctx.boundAgent && ctx.models.length > 0) return undefined;
    const key = settingKeyOf(row);
    return row.target === ctx.boundAgent
      ? `No model list from ${row.target} yet — it arrives with the agent's first reply. Any name still works: \`/setting ${key} <name>\`.`
      : `${row.target} is not answering this conversation, so its model list is not available here. Type a name: \`/setting ${key} <name>\`.`;
  }
  return settingOptions(row, cfg, ctx).length > 0 ? undefined : 'Type a value instead.';
}

/**
 * Whether this platform can carry a settings MENU, or must fall back to the text surface.
 *
 * Both flags, for the reason modelMenuSurface records: buttons that can never be edited could not be
 * paged, could not go back a level, and — worse — could never be retired, so they would keep
 * answering for values the user has already changed.
 */
export function settingsMenuSurface(caps: {
  buttons?: boolean;
  editButtons?: boolean;
}): 'menu' | 'text' {
  return caps.buttons && caps.editButtons ? 'menu' : 'text';
}

/** `/setting <key>`: the current value, what it accepts, and when a change lands. */
export function settingDetailText(row: SettingRow, cfg: Config, ctx: SettingsContext): string {
  const options = settingOptions(row, cfg, ctx);
  const key = settingKeyOf(row);
  const lines = [`**${row.label}** — \`${row.value}\``, settingDescription(row), ''];
  if (options.length > 0) {
    const shown = options.slice(0, DETAIL_OPTION_MAX);
    lines.push('Accepts:', ...shown.map((o) => `\`/setting ${key} ${o.raw}\` — ${o.label}`));
    if (options.length > shown.length) lines.push(`…and ${options.length - shown.length} more`);
  }
  // Shown ALONGSIDE the options, not instead of them: a model row with a value already set offers
  // "clear" and nothing else, and that list is complete-looking but not complete.
  const hint = settingTypedOnlyHint(row, cfg, ctx);
  if (hint) {
    if (options.length > 0) lines.push('');
    lines.push(hint);
  }
  lines.push('', `Changes ${effectText(row)}.`);
  return lines.join('\n');
}

/** Nothing this gateway knows by that name. Points at the list rather than guessing. */
export function settingUnknownKeyText(key: string): string {
  return (
    `No setting called \`${key}\`. \`/setting\` alone lists the ones this gateway can change; ` +
    'everything else in config.yaml is edited in the file.'
  );
}

// ─────────────────────────────── button menu ───────────────────────────────

/** Open-a-setting button: `stg:<reqId>:<index into the menu's frozen row list>`. */
export const SETTING_ROW_PREFIX = 'stg:';
/** Choose-a-value button: `stv:<reqId>:<index into the open setting's frozen option list>`. */
export const SETTING_VALUE_PREFIX = 'stv:';
/** Turn-the-page button (value level): `stp:<reqId>:<absolute page number>`. */
export const SETTING_PAGE_PREFIX = 'stp:';
/** Back-to-the-list button: `stb:<reqId>:0`. */
export const SETTING_BACK_PREFIX = 'stb:';

/** A click on a settings menu, once its id has been decoded. */
export type SettingButtonClick =
  | { kind: 'open'; reqId: string; index: number }
  | { kind: 'choose'; reqId: string; index: number }
  | { kind: 'page'; reqId: string; page: number }
  | { kind: 'back'; reqId: string };

/**
 * Max rows offered as buttons. Discord allows 25 components per message; the remainder is listed as
 * text rather than dropped, and stays settable by typing (same trade as the harness picker).
 */
export const SETTING_ROW_MAX = 20;

/** One rendered menu: what to say, and what to offer. */
export interface SettingsMenuView {
  text: string;
  buttons: Array<{ id: string; label: string }>;
  /** The page actually rendered (value level only; 0 for the row list). */
  page: number;
  pageCount: number;
  /**
   * The same screen as data, for a platform that draws its own (see `SettingsScreen`). Built only
   * when the caller asks for it, so every chat platform's view is exactly the text and buttons it
   * always was.
   */
  screen?: SettingsScreen;
}

export function settingRowButtonId(reqId: string, index: number): string {
  return formatButtonId(SETTING_ROW_PREFIX, reqId, index);
}
export function settingValueButtonId(reqId: string, index: number): string {
  return formatButtonId(SETTING_VALUE_PREFIX, reqId, index);
}
export function settingPageButtonId(reqId: string, page: number): string {
  return formatButtonId(SETTING_PAGE_PREFIX, reqId, page);
}
export function settingBackButtonId(reqId: string): string {
  return formatButtonId(SETTING_BACK_PREFIX, reqId, 0);
}

/** Decode a settings-menu button id, or null when it is some other menu's (or malformed). */
export function parseSettingButtonId(buttonId: string): SettingButtonClick | null {
  const open = parseButtonId(buttonId, SETTING_ROW_PREFIX);
  if (open) return { kind: 'open', reqId: open.reqId, index: open.n };
  const choose = parseButtonId(buttonId, SETTING_VALUE_PREFIX);
  if (choose) return { kind: 'choose', reqId: choose.reqId, index: choose.n };
  const page = parseButtonId(buttonId, SETTING_PAGE_PREFIX);
  if (page) return { kind: 'page', reqId: page.reqId, page: page.n };
  const back = parseButtonId(buttonId, SETTING_BACK_PREFIX);
  if (back) return { kind: 'back', reqId: back.reqId };
  return null;
}

/**
 * The list level: one button per setting, labelled with its current value — plus, when given, one
 * `extra` entry after them that leads somewhere other than a value (the scheduled-task list, whose
 * menu is core/schedule-menu.ts).
 *
 * `screen` asks for the structured form as well (the web UI). It is not built otherwise: a chat
 * platform would only throw it away, and keeping its construction out of the default path means
 * this table cannot change what a chat app shows.
 */
export function buildSettingsMenu(menu: {
  reqId: string;
  rows: SettingRow[];
  extra?: { id: string; label: string };
  screen?: boolean;
}): SettingsMenuView {
  const shown = menu.rows.slice(0, SETTING_ROW_MAX);
  const overflow = menu.rows.slice(SETTING_ROW_MAX);
  const buttons = shown.map((row, i) => ({
    id: settingRowButtonId(menu.reqId, i),
    label: truncateLabel(`${row.label} · ${row.value}`),
  }));
  if (menu.extra) buttons.push(menu.extra);
  let text = 'Settings — saved to config.yaml, not just this conversation. Tap one to change it.';
  if (overflow.length > 0) {
    text += `\n\n${overflow.length} more (type them): ${overflow.map((r) => `\`/setting ${settingKeyOf(r)}\``).join(', ')}`;
  }
  const screen = menu.screen ? settingsListScreen(menu.reqId, shown, menu.extra) : undefined;
  return { text, buttons, page: 0, pageCount: 1, ...(screen ? { screen } : {}) };
}

/**
 * The list level as rows for a screen: the same rows and the same button ids as the buttons above,
 * with the value split out of the label.
 */
function settingsListScreen(
  reqId: string,
  rows: SettingRow[],
  extra?: { id: string; label: string }
): SettingsScreen {
  const screenRows: SettingsScreenRow[] = rows.map((row, i) => {
    const effect = effectLabel(row);
    return {
      buttonId: settingRowButtonId(reqId, i),
      // `Default model · cc` is two facts in one chat label. On a screen the target is its own
      // line under the label, which is the whole reason this field exists.
      label: row.id === 'model' ? 'Default model' : row.label,
      ...(row.target ? { target: row.target } : {}),
      value: row.value,
      ...(effect ? { effectLabel: effect } : {}),
      group: settingGroup(row),
    };
  });
  if (extra) screenRows.push({ buttonId: extra.id, label: extra.label, group: 'More' });
  return { level: 'list', rows: screenRows };
}

/**
 * The value level: one page of what this setting accepts, plus a way back.
 *
 * Indices are absolute, never page-relative — a pick id names a position in the frozen list the
 * menu was opened with, so paging cannot make a button mean a different value than it did when it
 * was drawn. Page navigation wraps, for the reasons buildModelMenu records.
 */
export function buildSettingValueMenu(menu: {
  reqId: string;
  row: SettingRow;
  options: SettingOption[];
  page: number;
  /** Items per page; omitted means this platform declared none (core/paging.ts PAGE_SIZE). */
  pageSize?: number;
  /** Typed-only hint shown when the setting offers no options (a model with no live list). */
  hint?: string;
  /** Build the structured form too — see buildSettingsMenu. */
  screen?: boolean;
}): SettingsMenuView {
  const { reqId, row, options } = menu;
  const total = pageCount(options.length, menu.pageSize);
  const page = wrapPage(menu.page, total);
  const { start, items } = pageSlice(options, page, menu.pageSize);

  const buttons = items.map((o, i) => ({
    id: settingValueButtonId(reqId, start + i),
    label: truncateLabel((o.raw === settingCurrentRaw(row) ? '● ' : '') + o.label),
  }));
  if (total > 1) {
    buttons.push(
      { id: settingPageButtonId(reqId, (page - 1 + total) % total), label: '◀ Prev' },
      { id: settingPageButtonId(reqId, (page + 1) % total), label: 'Next ▶' }
    );
  }
  buttons.push({ id: settingBackButtonId(reqId), label: '◀ Back' });

  const head = `**${row.label}** — \`${row.value}\`\n${settingDescription(row)}`;
  // The hint rides along with the options rather than replacing them, for the reason
  // settingTypedOnlyHint records: "clear it" alone is a complete-looking list that is not complete.
  const parts = [
    menu.hint,
    // The screen's own nav row says which page this is; only the button menu needs it in the text.
    total > 1 && !menu.screen ? `page ${page + 1}/${total}` : undefined,
  ].filter((p): p is string => p !== undefined);
  const screen = menu.screen
    ? settingsValueScreen(reqId, row, items, start, page, total)
    : undefined;
  return {
    text: parts.length > 0 ? `${head}\n\n${parts.join('\n')}` : head,
    buttons,
    page,
    pageCount: total,
    ...(screen ? { screen } : {}),
  };
}

/**
 * The value level as rows for a screen. `start` is the absolute index of the first item, so a
 * pick's button id means the same value it meant when the page was drawn — the same rule the
 * buttons follow.
 */
function settingsValueScreen(
  reqId: string,
  row: SettingRow,
  items: SettingOption[],
  start: number,
  page: number,
  total: number
): SettingsScreen {
  const current = settingCurrentRaw(row);
  const options: SettingsScreenOption[] = items.map((o, i) => ({
    buttonId: settingValueButtonId(reqId, start + i),
    label: o.title ?? o.label,
    ...(o.detail ? { detail: o.detail } : {}),
    current: o.raw === current,
  }));
  return {
    level: 'values',
    options,
    nav: {
      page: page + 1,
      pageCount: total,
      ...(total > 1
        ? {
            prev: settingPageButtonId(reqId, (page - 1 + total) % total),
            next: settingPageButtonId(reqId, (page + 1) % total),
          }
        : {}),
      back: settingBackButtonId(reqId),
    },
  };
}

/**
 * The page a setting's value menu should OPEN on: the one holding its current value.
 *
 * Same reasoning as the model menu — the question behind `/setting model.cc` is usually "what is it
 * now, and what else is there", and answering the first half by making the user page to it is a
 * poor trade for one line of arithmetic. Page 0 when the current value is not in the list (a model
 * the harness no longer offers, or an alias it never advertised).
 */
export function settingValuePage(
  row: SettingRow,
  options: SettingOption[],
  size?: number
): number {
  const current = settingCurrentRaw(row);
  const index = options.findIndex((o) => o.raw === current);
  return index >= 0 ? pageOf(index, size) : 0;
}

/**
 * The raw form of a row's CURRENT value, for the ● marker and the screen's current-option mark.
 *
 * Compared against `SettingOption.raw`, which is why it cannot just be `row.value`: a row's value is
 * formatted for display (`cc · claude`, `(harness default)`) while an option's raw form is what the
 * parser takes (`cc`, `-`).
 */
export function settingCurrentRaw(row: SettingRow): string {
  switch (row.id) {
    case 'agent':
      return row.value.split(' · ')[0] ?? row.value;
    case 'model':
      return row.value === MODEL_UNSET ? '-' : row.value;
    default:
      return row.value;
  }
}

/** A click on a menu this daemon no longer knows about (superseded, or it restarted). */
export function settingsMenuExpiredText(): string {
  return 'That settings menu has expired (superseded, or the gateway restarted). Run /setting again for a fresh one.';
}

/** What the previous menu becomes when a newer one is opened in the same conversation. */
export function settingsMenuSupersededText(): string {
  return 'Settings — superseded by a newer /setting menu.';
}
