import type { Config, SessionScope } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import type {
  SettingsScreen,
  SettingsScreenControl,
  SettingsScreenGroup,
  SettingsScreenNotice,
  SettingsScreenOption,
  SettingsScreenRow,
} from '../types.js';
import { agentKindOf } from './agent-menu.js';
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
 *
 * ── Why auto review is in this table ──────────────────────────────────────────
 * `review.agent` and `review.model` are the same kind of Tuesday decision as the rest: which agent
 * reviews a quiet conversation — and, when its own model is the wrong trade for the job, which
 * model reviews use — is a judgement about cost and quality, not deployment plumbing. Leaving it
 * to a file edit meant the feature could only be turned on by someone with a shell, on the machine
 * that runs the daemon. Two things make it safe enough for chat. The reviewer must be an `agy`
 * agent, because a review is one `agy -p` with every tool denied (AGENTS.md invariant 8) — so the
 * rows offer only agy agents, and a typed claude/opencode id is refused with the reason rather than
 * saved to fail at the next sweep. And the sweep re-reads `review` from the live Config at the start
 * of every pass (daemon/review.ts `reviewer()`), so a change lands on the next sweep, within a
 * minute, without restarting anything.
 */

/** The settings this gateway can write. Everything else is refused by name. */
export type SettingId =
  | 'agent'
  | 'model'
  | 'delegation'
  | 'idle'
  | 'scope'
  | 'stream'
  | 'voice'
  | 'cleanup'
  | 'review.agent'
  | 'review.model';

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
  /**
   * On a model row: the agent is one a host's pod declares (config/pods.ts), so its default is
   * written to config.yaml's `podModels` over the pod's own, and `model` is what the pod says
   * (absent: nothing). Absent for an agent config.yaml defines.
   */
  pod?: { model?: string };
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
   */
  models: readonly ModelOption[];
  /**
   * What the gateway knows of ANY agent's model list (daemon/model-catalog.ts) — the answer for
   * every agent that is not answering here. A model list only exists on a live session, and this
   * conversation has at most one, so for the others the daemon asks: from another conversation's
   * live session, from what it learned before, or by bringing a session up just to ask. Absent:
   * nothing can ask (a test, a caller without a catalog), and the hint says to type a name.
   */
  lists?: (agentId: string) => AgentModelList | undefined;
  /** The pods' agents and the model each pod gives, so a key resolves to a row that knows it. */
  pods?: PodModels;
}

/** What is known of one agent's model list. */
export type AgentModelList =
  /** Asked, and this is the answer. */
  | { kind: 'list'; options: readonly ModelOption[] }
  /** Being asked now. */
  | { kind: 'loading' }
  /** Asked, and the harness offers no model choice (no `model` select option). */
  | { kind: 'none' }
  /** Could not ask: the agent did not start. */
  | { kind: 'error'; reason: string };

/**
 * The agents the hosts' pods declare, each with the model its pod.yaml gives (config/pods.ts
 * podAgentModels). Read from pods.json by the daemon: the merged Config only has the answer, not
 * where it came from.
 */
export type PodModels = ReadonlyMap<string, string | undefined>;

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
 * Tokens that turn auto review off. `off` is the word both surfaces print, and the rest are the
 * clearing vocabulary this table already uses, so `/setting review -` does what it says everywhere
 * else rather than looking for an agent literally named "-".
 */
const REVIEW_OFF = new Set(['off', ...CLEAR_TOKENS]);

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
  // `review` alone is the reviewer: the model is the optional half, and the one a bare word would
  // surprise someone into setting ("/setting review off" must turn the feature off, not clear a
  // model that is following its agent).
  review: 'review.agent',
  'review.agent': 'review.agent',
  reviewer: 'review.agent',
  'review.model': 'review.model',
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
 * What an unset `review.model` means: the reviewer's own `model`, or the harness default when the
 * agent has none either. Deliberately not MODEL_UNSET — a review does not fall back to the harness
 * before it falls back to the agent.
 */
const REVIEW_MODEL_UNSET = "agent's own";

/** The reviewer's row value: off, the agent, never a stale id dressed up as a name. */
function reviewAgentValue(cfg: Config): string {
  return cfg.review ? agentLabel(cfg, cfg.review.agent) : 'off';
}

/** The review model's row value, with the inherited case said rather than left blank. */
function reviewModelValue(cfg: Config): string {
  if (!cfg.review) return 'off';
  return cfg.review.model ?? REVIEW_MODEL_UNSET;
}

/**
 * Every row of the settings screen, in a stable order.
 *
 * `model` expands to one row per configured agent — a deployment with two harnesses has two
 * defaults to set, and folding them into one row would make the screen lie about which one it
 * shows. Order is config order, so the rows (and therefore the button indices) are stable across
 * restarts.
 */
export function settingsRows(cfg: Config, pods?: PodModels): SettingRow[] {
  const rows: SettingRow[] = [
    {
      id: 'agent',
      label: 'Default agent',
      value: agentLabel(cfg, cfg.routing.default),
      effect: 'live',
    },
  ];
  for (const agent of cfg.agents) {
    const podModel = pods?.get(agent.id);
    rows.push({
      id: 'model',
      target: agent.id,
      label: `Default model · ${agent.id}`,
      value: agent.model ?? MODEL_UNSET,
      effect: 'next-session',
      ...(pods?.has(agent.id) ? { pod: podModel !== undefined ? { model: podModel } : {} } : {}),
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
  // Last, so every row above keeps the index a menu frozen earlier may still carry. Both are shown
  // even when review is off: the model row is where "follow the reviewer's own model" is read, and
  // hiding it would leave the screen unable to say what turning review on would use.
  rows.push(
    {
      id: 'review.agent',
      label: 'Auto review',
      value: reviewAgentValue(cfg),
      effect: 'live',
    },
    {
      id: 'review.model',
      label: 'Review model',
      value: reviewModelValue(cfg),
      effect: 'live',
    }
  );
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
    case 'review.agent':
      return (
        'Which `agy` agent reviews conversations that go quiet and writes what it learns into the ' +
        'skill library. A review is one `agy -p` with every tool denied, so only an `agy` agent can ' +
        'be named; `off` turns auto review off. The next sweep reads the new value — within a minute.'
      );
    case 'review.model':
      return (
        'The model reviews run with (`agy --model`). Unset follows the reviewer’s own model; pick one ' +
        'here to give reviews a different model from the agent’s. A change lands on the next sweep.'
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

/** effectText as a sentence of its own, for a screen's head. */
function effectSentence(row: SettingRow): string {
  switch (row.effect) {
    case 'live':
      return 'Takes effect at once.';
    case 'next-session':
      return `Takes effect from ${row.target ?? 'that agent'}'s next agent session — \`/new\` starts one now.`;
    case 'restart':
      return 'Takes effect when the daemon restarts; conversations keep their current identity until then.';
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
 *
 * The model rows are a group of their own, one row per agent under one heading, rather than a row
 * per agent each titled "Default model": with ten agents that was ten identical titles in a column,
 * and the switch for sub-agent confirmation lost among them (reported 2026-11-05).
 */
function settingGroup(row: SettingRow): string {
  switch (row.id) {
    case 'agent':
      return 'Agents';
    case 'model':
      return 'Default model';
    case 'delegation':
      return 'Sub-agents';
    case 'idle':
    case 'scope':
      return 'Conversations';
    case 'stream':
      return 'Replies';
    case 'voice':
    case 'cleanup':
      return 'Voice';
    case 'review.agent':
    case 'review.model':
      return 'Reviews';
    default: {
      const _exhaustive: never = row.id;
      return String(_exhaustive);
    }
  }
}

/** A sentence under a group heading, for what every row in it shares. */
function settingGroupNote(row: SettingRow): string | undefined {
  if (row.id === 'model') {
    return 'What each agent starts a new session with. A change applies from that agent’s next session (`/new` starts one); `/model` changes it in one topic only.';
  }
  if (row.id === 'review.agent') {
    return 'An `agy` agent reads a conversation that has gone quiet and writes what it learned into the skill library. Only `agy` agents can do this: reviews run with every tool denied.';
  }
  return undefined;
}

/**
 * One line on what a row decides, for a screen that lists every setting at once — settingDescription
 * is the paragraph a single setting's own screen has room for. A model row has none: its group says it.
 */
function settingHint(row: SettingRow): string | undefined {
  switch (row.id) {
    case 'agent':
      return 'Answers a new conversation that no routing rule claims.';
    case 'model':
      return undefined;
    case 'delegation':
      return 'Wait for your Start before an agent’s sub-tasks run. Off starts them at once; a sub-agent’s own topic still asks.';
    case 'idle':
      return 'Stop an agent that has been quiet this long. Its conversation resumes on the next message.';
    case 'scope':
      return 'What counts as one conversation: a topic, a channel, a person, or the whole gateway.';
    case 'stream':
      return 'Type each reply out as it arrives, instead of sending each part once it is finished.';
    case 'voice':
      return 'Hold a voice message’s transcript until you tap ✅ Send.';
    case 'cleanup':
      return 'Also write a voice message up as the message you meant, and send that version.';
    case 'review.agent':
      return 'Have an `agy` agent review a quiet conversation and write what it learned into the skill library. Off by default.';
    case 'review.model':
      return 'The model reviews run with. Unset follows the reviewer’s own model.';
    default: {
      const _exhaustive: never = row.id;
      return String(_exhaustive);
    }
  }
}

/**
 * How a screen lets a row be changed (`SettingsScreenControl`). The table's call rather than the
 * page's, for the reason settingGroup is here: a new setting must be given a control to compile.
 *
 * On/off settings are switches and the short closed lists are choices, both written from the row
 * itself — one tap, where the button menu needs two and a Back. The model is the one that keeps its
 * own screen: its list can run to a hundred names, has to be asked of the agent, and takes a name
 * the list does not have.
 */
export function settingControl(row: SettingRow): 'switch' | 'choice' | 'list' {
  switch (row.id) {
    case 'delegation':
    case 'stream':
    case 'voice':
    case 'cleanup':
      return 'switch';
    case 'agent':
    case 'idle':
    case 'scope':
    case 'review.agent':
      return 'choice';
    case 'model':
    case 'review.model':
      return 'list';
    default: {
      const _exhaustive: never = row.id;
      return _exhaustive;
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

  const rows = settingsRows(cfg, ctx.pods);
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
        // A chat button shows the name; a screen shows the id, which is what the status line and
        // `/model` print, with the name under it when they differ.
        ...modelList(row, cfg, ctx).map((m) => {
          const name = m.name.trim();
          return { raw: m.value, label: name || m.value, ...(name && name !== m.value ? { title: m.value, detail: name } : {}) };
        }),
        ...(readSettingValue(row, cfg) !== undefined ? [{ raw: '-', label: clearedModelLabel(row) }] : []),
      ];
    case 'review.agent': {
      // Only agy agents: a review is `agy -p` with every tool denied (AGENTS.md invariant 8).
      // Offering the others and refusing the tap would be a menu that lists what it will not write.
      const off = {
        raw: 'off',
        label: 'off — no automatic reviews',
        title: 'off',
        detail: 'no automatic reviews',
      };
      return [
        off,
        ...cfg.agents
          .filter((a) => a.harness === 'agy')
          .map((a) => ({ raw: a.id, label: agentLabel(cfg, a.id) })),
      ];
    }
    case 'review.model': {
      if (!cfg.review) return [];
      return [
        ...modelList(row, cfg, ctx).map((m) => {
          const name = m.name.trim();
          return { raw: m.value, label: name || m.value, ...(name && name !== m.value ? { title: m.value, detail: name } : {}) };
        }),
        ...(cfg.review.model !== undefined
          ? [{ raw: '-', label: clearedReviewModelLabel(cfg) }]
          : []),
      ];
    }
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
 * The agent whose model list a row offers. A per-agent model row names it in `target`; the review
 * model is the reviewer's list, because that is the model a review would actually pass to
 * `agy --model` (and the one "follow the reviewer" means).
 *
 * Exported because the daemon has to ask the SAME agent for a cold list — see conversation.ts
 * settingOptionsFor, which warms the catalog before the screen is drawn.
 */
export function modelListAgent(row: SettingRow, cfg: Config): string | undefined {
  if (row.id === 'model') return row.target;
  if (row.id === 'review.model') return cfg.review?.agent;
  return undefined;
}

/**
 * What a model row offers to choose from: the bound agent's live list when there is one, else what
 * the daemon has learned of this agent's (SettingsContext.lists). Empty when neither is known.
 */
function modelList(row: SettingRow, cfg: Config, ctx: SettingsContext): readonly ModelOption[] {
  const agentId = modelListAgent(row, cfg);
  if (!agentId) return [];
  if (agentId === ctx.boundAgent && ctx.models.length > 0) return ctx.models;
  const known = ctx.lists?.(agentId);
  return known?.kind === 'list' ? known.options : [];
}

/** What a model row falls back to when the value set here is cleared. */
function clearedModelLabel(row: SettingRow): string {
  if (row.pod?.model) return `${row.pod.model} (pod.yaml)`;
  return MODEL_UNSET;
}

/** What a review model falls back to: the reviewer's own model, named so the choice is explicit. */
function clearedReviewModelLabel(cfg: Config): string {
  return cfg.review ? `follow ${cfg.review.agent} (its own model)` : REVIEW_MODEL_UNSET;
}

/**
 * Where a model row's value comes from, for a screen to say: set from the gateway over a pod's,
 * the pod's own, config.yaml's, or nothing (the harness picks).
 */
export function modelSource(row: SettingRow, cfg: Config): 'gateway' | 'pod' | 'config' | 'unset' {
  if (row.pod) {
    if (row.target && cfg.podModels?.[row.target] !== undefined) return 'gateway';
    return row.pod.model !== undefined ? 'pod' : 'unset';
  }
  return cfgModel(cfg, row.target) !== undefined ? 'config' : 'unset';
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
      return parseModelValue(input, row, cfg, ctx);
    case 'review.agent':
      return parseReviewAgentValue(input, cfg);
    case 'review.model':
      return parseReviewModelValue(input, row, cfg, ctx);
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
function parseModelValue(
  input: string,
  row: SettingRow,
  cfg: Config,
  ctx: SettingsContext
): ParsedSettingValue {
  return parseModelName(
    input,
    modelList(row, cfg, ctx),
    row.target ?? 'the agent',
    clearedModelLabel(row)
  );
}

/**
 * A model name against a list that may be empty. The third outcome is the interesting one: a name
 * the list does not have is ACCEPTED (see parseModelValue), with `unlistedNote` saying so when the
 * row's list simply could not be asked for.
 */
function parseModelName(
  input: string,
  listed: readonly ModelOption[],
  target: string,
  cleared: string,
  unlistedNote?: string
): ParsedSettingValue {
  if (CLEAR_TOKENS.has(input.toLowerCase())) {
    return { kind: 'value', value: undefined, display: cleared };
  }
  if (listed.length === 0) {
    return {
      kind: 'value',
      value: input,
      display: input,
      ...(unlistedNote ? { note: unlistedNote } : {}),
    };
  }

  const match = matchModels([...listed], input);
  if (match.kind === 'one') return { kind: 'value', value: match.option.value, display: match.option.value };
  if (match.kind === 'many') {
    const shown = match.matches.slice(0, 12).map((o) => `\`${o.value}\``).join('\n');
    return {
      kind: 'invalid',
      reason: `"${input}" matches ${match.matches.length} of ${target}'s models:\n${shown}`,
    };
  }
  return {
    kind: 'value',
    value: input,
    display: input,
    note: `${target} does not advertise that name — saved as typed, so check it is one the harness accepts.`,
  };
}

/**
 * The reviewer: `off`, or an agy agent. Refused rather than coerced for anything else — a review
 * is `agy -p` with every tool denied (AGENTS.md invariant 8), and a claude/opencode id here would
 * be a config the schema rejects, written by a chat command that claimed it worked.
 */
function parseReviewAgentValue(input: string, cfg: Config): ParsedSettingValue {
  if (REVIEW_OFF.has(input.toLowerCase())) {
    return {
      kind: 'value',
      value: undefined,
      display: 'off',
      ...(cfg.review?.model ? { note: 'The review model set here is removed with it.' } : {}),
    };
  }
  const match = cfg.agents.find((a) => a.id.toLowerCase() === input.toLowerCase());
  if (!match) {
    const agy = cfg.agents.filter((a) => a.harness === 'agy').map((a) => a.id);
    return {
      kind: 'invalid',
      reason: agy.length
        ? `No agy agent named \`${input}\`. agy agents here: ${agy.join(', ')}.`
        : 'This deployment has no agy agent, so auto review cannot be turned on here.',
    };
  }
  if (match.harness !== 'agy') {
    return {
      kind: 'invalid',
      reason: `\`${match.id}\` is a ${match.harness} agent. A review is one \`agy -p\` with every tool denied, so only an agy agent can review.`,
    };
  }
  return { kind: 'value', value: match.id, display: agentLabel(cfg, match.id) };
}

/** A review model: only meaningful with a reviewer, and following it until one is named. */
function parseReviewModelValue(
  input: string,
  row: SettingRow,
  cfg: Config,
  ctx: SettingsContext
): ParsedSettingValue {
  if (!cfg.review) {
    return {
      kind: 'invalid',
      reason: 'Turn auto review on first: `/setting review.agent <agy agent>`.',
    };
  }
  return parseModelName(
    input,
    modelList(row, cfg, ctx),
    cfg.review.agent,
    clearedReviewModelLabel(cfg),
    `${cfg.review.agent} did not offer its model list here — saved as typed, so check it is a name \`agy --model\` accepts.`
  );
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
      // A pod's agent is not in config.yaml's `agents:`; the gateway's say over its model is.
      if (row.pod) return { kind: 'path', path: ['podModels', row.target!] };
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
    case 'review.agent':
      // Clearing this deletes the whole `review:` block — `agent` is required whenever the block
      // exists, so a lone `review.model` would be a config the next start refuses. See the
      // `emptied` substitution in daemon/settings-store.ts.
      return { kind: 'path', path: ['review', 'agent'] };
    case 'review.model':
      return { kind: 'path', path: ['review', 'model'] };
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
      // For a pod's agent, what is written here is the gateway's own entry — not the merged model,
      // which may be the pod's: clearing one that is not set must be "already", not a write.
      if (row.pod) return row.target ? cfg.podModels?.[row.target] : undefined;
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
    case 'review.agent':
      return cfg.review?.agent;
    case 'review.model':
      return cfg.review?.model;
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

/**
 * An outcome as the banner a screen shows (`SettingsScreenNotice`): the same words as the ack, and
 * whether they are good news. Exhaustive like settingAckText.
 */
export function settingNotice(result: SettingApplyResult): SettingsScreenNotice {
  switch (result.kind) {
    case 'saved':
      return { tone: 'ok', text: settingAckText(result) };
    case 'unchanged':
      return { tone: 'info', text: settingAckText(result) };
    case 'invalid':
    case 'failed':
      return { tone: 'error', text: settingAckText(result) };
    default: {
      const _exhaustive: never = result;
      return { tone: 'error', text: String(_exhaustive) };
    }
  }
}

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
  if (row.id === 'model') return modelListHint(row, cfg, ctx);
  if (row.id === 'review.model') {
    return cfg.review
      ? modelListHint(row, cfg, ctx)
      : 'Turn auto review on first: `/setting review.agent <agy agent>`.';
  }
  return settingOptions(row, cfg, ctx).length > 0 ? undefined : 'Type a value instead.';
}

/**
 * The model row's sentence: nothing when there is a list, else why there is none and what to type.
 * Each reason is its own sentence because each is a different problem: one is a moment's wait, one
 * is the harness, one is an agent that would not start. The agent is the row's list owner
 * (modelListAgent), so the review model speaks about the reviewer rather than about itself.
 */
function modelListHint(row: SettingRow, cfg: Config, ctx: SettingsContext): string | undefined {
  if (modelList(row, cfg, ctx).length > 0) return undefined;
  const agentId = modelListAgent(row, cfg);
  const typed = `\`/setting ${settingKeyOf(row)} <name>\``;
  const known = agentId ? ctx.lists?.(agentId) : undefined;
  switch (known?.kind) {
    case 'loading':
      return `Asking ${agentId} for its models… A name can be typed meanwhile: ${typed}.`;
    case 'none':
      return `${agentId} does not offer a model list: its harness reports no model choice. Type a name it accepts: ${typed}.`;
    case 'error':
      return `${agentId} did not start, so it could not be asked for its models (${known.reason}). Type a name: ${typed}.`;
    case 'list':
    case undefined:
      return agentId === ctx.boundAgent
        ? `No model list from ${agentId} yet — it arrives with the agent's first reply. Any name still works: ${typed}.`
        : `${agentId} is not answering this conversation, so its model list is not available here. Type a name: ${typed}.`;
    default: {
      const _exhaustive: never = known;
      return String(_exhaustive);
    }
  }
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
/**
 * Set-from-the-list control: `sts:<reqId>:<index into the list's frozen choices>`. Only a screen
 * carries one (a switch, or a choice in a row): a chat app's list is buttons that open a setting,
 * and never sees this prefix.
 */
export const SETTING_SET_PREFIX = 'sts:';
/**
 * Typed-value control on a value screen: `stt:<reqId>:0`, its text in the click's `value`
 * (ButtonInteraction.value). Only a screen carries one, for a setting whose list is not the whole
 * answer — a model, which a harness takes by names it never lists.
 */
export const SETTING_TYPE_PREFIX = 'stt:';

/** A click on a settings menu, once its id has been decoded. */
export type SettingButtonClick =
  | { kind: 'open'; reqId: string; index: number }
  | { kind: 'choose'; reqId: string; index: number }
  | { kind: 'set'; reqId: string; index: number }
  | { kind: 'type'; reqId: string }
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
  /**
   * What each `sts:` id on the list screen writes, by its index — the list the daemon keeps and a
   * click is resolved against. Present only with a list screen.
   */
  choices?: SettingChoice[];
}

/** One value a list screen can write without opening the setting: which row, and what to write. */
export interface SettingChoice {
  /** Index into the menu's frozen row list (the one `stg:` indices point into). */
  row: number;
  /** What parseSettingValue is handed, as if the value had been tapped on the setting's own screen. */
  raw: string;
}

/** What a list screen needs that the rows do not carry. */
export interface SettingsScreenInput {
  /** The live config: what each agent is (agentKindOf), and where each model comes from. */
  cfg: Config;
  /** What a switch or choice row can be set to — settingOptions for that row, as the daemon reads it. */
  options(row: SettingRow): SettingOption[];
  /** The agent answering the conversation the screen opens in. */
  here?: string;
  /** The outcome of the action that led here, shown above the list. */
  notice?: SettingsScreenNotice;
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
export function settingSetButtonId(reqId: string, index: number): string {
  return formatButtonId(SETTING_SET_PREFIX, reqId, index);
}
export function settingTypeButtonId(reqId: string): string {
  return formatButtonId(SETTING_TYPE_PREFIX, reqId, 0);
}

/** Decode a settings-menu button id, or null when it is some other menu's (or malformed). */
export function parseSettingButtonId(buttonId: string): SettingButtonClick | null {
  const open = parseButtonId(buttonId, SETTING_ROW_PREFIX);
  if (open) return { kind: 'open', reqId: open.reqId, index: open.n };
  const choose = parseButtonId(buttonId, SETTING_VALUE_PREFIX);
  if (choose) return { kind: 'choose', reqId: choose.reqId, index: choose.n };
  const set = parseButtonId(buttonId, SETTING_SET_PREFIX);
  if (set) return { kind: 'set', reqId: set.reqId, index: set.n };
  const type = parseButtonId(buttonId, SETTING_TYPE_PREFIX);
  if (type) return { kind: 'type', reqId: type.reqId };
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
  screen?: SettingsScreenInput;
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
  if (!menu.screen) return { text, buttons, page: 0, pageCount: 1 };
  // Every row, not the first SETTING_ROW_MAX: that cap is Discord's 25 components per message, and
  // a screen is not a message's buttons. The `stg:` index of a row past it still resolves, since
  // the daemon freezes the whole list.
  const { screen, choices } = settingsListScreen(menu.reqId, menu.rows, menu.screen, menu.extra);
  return { text, buttons, page: 0, pageCount: 1, screen, choices };
}

/**
 * The list level as rows for a screen: the same rows and the same `stg:` ids as the buttons above,
 * with the value split out of the label, and a control per row (settingControl). The `sts:` ids a
 * switch or a choice carries index `choices`, which the daemon keeps with the menu — the same
 * freeze-the-list rule `stv:` follows, so an id means the value it meant when it was drawn.
 */
function settingsListScreen(
  reqId: string,
  rows: SettingRow[],
  input: SettingsScreenInput,
  extra?: { id: string; label: string }
): { screen: SettingsScreen; choices: SettingChoice[] } {
  const choices: SettingChoice[] = [];
  const choose = (row: number, raw: string): string => {
    choices.push({ row, raw });
    return settingSetButtonId(reqId, choices.length - 1);
  };
  const groups: SettingsScreenGroup[] = [];
  const screenRows: SettingsScreenRow[] = rows.map((row, i) => {
    const group = settingGroup(row);
    if (groups.at(-1)?.name !== group) {
      const note = settingGroupNote(row);
      groups.push({ name: group, ...(note ? { note } : {}) });
    }
    return settingsScreenRow(reqId, row, i, group, input, choose);
  });
  if (extra) {
    groups.push({ name: 'More' });
    screenRows.push({ buttonId: extra.id, label: extra.label, group: 'More', control: { kind: 'link' } });
  }
  return {
    screen: {
      level: 'list',
      about:
        'These apply to every conversation. A change applies at once unless its row says when; `/model` and `/agent` change one topic only.',
      groups,
      rows: screenRows,
      ...(input.notice ? { notice: input.notice } : {}),
    },
    choices,
  };
}

/** One row of the list screen. */
function settingsScreenRow(
  reqId: string,
  row: SettingRow,
  index: number,
  group: string,
  input: SettingsScreenInput,
  choose: (row: number, raw: string) => string
): SettingsScreenRow {
  const hint = settingHint(row);
  // A model row's "next session" is said once, in its group's note, rather than on every row.
  const effect = row.id === 'model' ? undefined : effectLabel(row);
  const def = row.target ? findAgent(input.cfg, row.target) : undefined;
  const unset = row.id === 'model' && row.value === MODEL_UNSET;
  const note = row.id === 'model' ? modelValueNote(row, input.cfg) : undefined;
  return {
    buttonId: settingRowButtonId(reqId, index),
    // `Default model · cc` is two facts in one chat label. On a screen the group heading is the
    // first, so the row is named by the second.
    label: row.target ?? row.label,
    ...(row.target ? { target: row.target } : {}),
    ...(def ? { targetKind: agentKindOf(def) } : {}),
    ...(row.target && row.target === input.here ? { here: true } : {}),
    // `harness default`, not `(harness default)`: the parentheses were a chat label's way of saying
    // "not a model name", which a screen says by drawing it as a placeholder.
    value: unset ? 'harness default' : row.value,
    ...(unset ? { unset: true } : {}),
    ...(note ? { valueNote: note } : {}),
    ...(hint ? { hint } : {}),
    ...(effect ? { effectLabel: effect, effectDetail: effectText(row) } : {}),
    group,
    control: rowControl(row, index, input, choose),
  };
}

/**
 * The few words beside a pod agent's model saying whose it is. Only for a pod's agent: an agent
 * config.yaml defines has one source, and the page already says config.yaml.
 */
function modelValueNote(row: SettingRow, cfg: Config): string | undefined {
  switch (modelSource(row, cfg)) {
    case 'gateway':
      return 'set here';
    case 'pod':
      return 'pod.yaml';
    case 'config':
    case 'unset':
      return undefined;
  }
}

/** Where a model row's value comes from, as the sentence its own screen carries. */
function modelSourceSentence(row: SettingRow, cfg: Config): string | undefined {
  if (!row.pod) return undefined;
  const host = row.target ? findAgent(cfg, row.target)?.host : undefined;
  const pod = host ? `${host}'s pod.yaml` : 'its pod.yaml';
  switch (modelSource(row, cfg)) {
    case 'gateway':
      return row.pod.model
        ? `Set here, over ${pod} (\`${row.pod.model}\`). Clear it to go back to that.`
        : `Set here; ${pod} names none. Clear it to let the harness pick.`;
    case 'pod':
      return `From ${pod}. A model chosen here is kept in the gateway's config.yaml and wins over the pod's.`;
    case 'unset':
      return `Neither the gateway nor ${pod} names one, so the harness picks. A model chosen here is kept in the gateway's config.yaml.`;
    case 'config':
      return undefined;
  }
}

/** The control a row is drawn with, falling back to its own screen when the options do not fit. */
function rowControl(
  row: SettingRow,
  index: number,
  input: SettingsScreenInput,
  choose: (row: number, raw: string) => string
): SettingsScreenControl {
  const kind = settingControl(row);
  if (kind === 'list') return { kind: 'list' };
  const options = input.options(row);
  if (kind === 'switch') {
    const on = row.value === 'on';
    const other = options.find((o) => o.raw === (on ? 'off' : 'on'));
    // A switch whose other side is not on offer would be a control that cannot move.
    return other ? { kind: 'switch', on, set: choose(index, other.raw) } : { kind: 'list' };
  }
  if (options.length === 0) return { kind: 'list' };
  const current = settingCurrentRaw(row);
  return {
    kind: 'choice',
    options: options.map((o) => ({
      buttonId: choose(index, o.raw),
      label: o.title ?? o.label,
      ...(o.detail ? { detail: o.detail } : {}),
      current: o.raw === current,
    })),
  };
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
  /**
   * Build the structured form too — see buildSettingsMenu. `loading`: the list is being asked for
   * and will arrive as an edit.
   */
  screen?: { cfg: Config; notice?: SettingsScreenNotice; loading?: boolean };
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
    ? settingsValueScreen(reqId, row, items, { start, page, total }, { ...menu.screen, hint: menu.hint })
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
 * buttons follow. The head says which setting this is and what it holds now, as data, so the
 * screen draws it as a header rather than as the chat text's bold line.
 */
function settingsValueScreen(
  reqId: string,
  row: SettingRow,
  items: SettingOption[],
  at: { start: number; page: number; total: number },
  extra: { cfg: Config; notice?: SettingsScreenNotice; loading?: boolean; hint?: string }
): SettingsScreen {
  const { start, page, total } = at;
  const current = settingCurrentRaw(row);
  const options: SettingsScreenOption[] = items.map((o, i) => ({
    buttonId: settingValueButtonId(reqId, start + i),
    label: o.title ?? o.label,
    ...(o.detail ? { detail: o.detail } : {}),
    current: o.raw === current,
  }));
  const def = row.target ? findAgent(extra.cfg, row.target) : undefined;
  const unset = row.id === 'model' && row.value === MODEL_UNSET;
  const source = row.id === 'model' ? modelSourceSentence(row, extra.cfg) : undefined;
  // The review model's list is the reviewer's, so the header names that agent the way a per-agent
  // row names its own — otherwise "Now: agent's own" would leave the agent implicit.
  const listAgent = modelListAgent(row, extra.cfg);
  const listDef = listAgent && listAgent !== row.target ? findAgent(extra.cfg, listAgent) : def;
  return {
    level: 'values',
    ...(extra.loading ? { loading: true } : {}),
    // A model is taken by any name the harness accepts, listed or not (parseModelValue).
    ...(row.id === 'model' || row.id === 'review.model'
      ? { typed: { buttonId: settingTypeButtonId(reqId), placeholder: 'Or type a model name' } }
      : {}),
    head: {
      label: row.id === 'model' ? 'Default model' : row.label,
      ...(listAgent ? { target: listAgent } : {}),
      ...(listDef ? { targetKind: agentKindOf(listDef) } : {}),
      value: unset ? 'harness default' : row.value,
      ...(unset ? { unset: true } : {}),
      description: settingDescription(row),
      ...(extra.hint ? { hint: extra.hint } : {}),
      effect: effectSentence(row),
      ...(source ? { source } : {}),
    },
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
    ...(extra.notice ? { notice: extra.notice } : {}),
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
    case 'review.agent':
      // `off` has no harness suffix to strip; an agent's label does (`ag · agy`).
      return row.value === 'off' ? 'off' : (row.value.split(' · ')[0] ?? row.value);
    case 'model':
      return row.value === MODEL_UNSET ? '-' : row.value;
    case 'review.model':
      return row.value === REVIEW_MODEL_UNSET ? '-' : row.value;
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
