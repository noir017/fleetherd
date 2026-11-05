/**
 * Domain types shared across modules. Data shapes only; behavior lives in each module.
 */

import type { ConversationAddress, ConversationRef } from './core/conversation.js';

/**
 * A platform-agnostic message reference, usable for in-place edit / reaction / reply.
 *
 * Carries the full address rather than a channel string so that an operation on a
 * message inside a Telegram topic or a Slack thread still knows its lane. (Edits and
 * reactions happen not to need the lane on either API — but a ref that silently dropped
 * it was a trap for every future operation that does, and `reply` genuinely needs it.)
 */
export interface MessageRef {
  address: ConversationAddress;
  messageId: string;
}

/** Inbound message (already normalized by the Satori adapter core). */
export interface InboundMessage {
  /**
   * Where this message lives: channel, optional sub-lane (topic/thread), space, kind.
   * The single source of truth for routing, gating and every reply — see
   * core/conversation.ts for why this is a struct and not a composite string.
   */
  conversation: ConversationRef;
  /** Platform type ('discord'/'telegram'/…), for logs and type-specific behavior. Optional: absent on synthesized messages. */
  platformType?: string;
  messageId: string;
  /** Plain text content (platform markup stripped). */
  content: string;
  /** Target message id of a quote/reply (if any). */
  quoteId?: string;
  /** Original timestamp (ms); injected by the adapter so core logic never reads the system clock. */
  timestamp: number;
  /**
   * Platform URLs of attachments (image/audio/file), fetchable by the agent on demand.
   * mime/size are best-effort from the adapter (undefined if unavailable); used to decide inbound download/injection.
   *
   * `audio` is its own type (rather than folded into `file`, as it was) because it is the one
   * distinction a later decision needs and cannot recover: a voice message is transcribed (see
   * core/voice.ts), and a Feishu voice note declares no mime and no name, so once the element type
   * is flattened nothing short of downloading it says it was audio. Everywhere else it is treated
   * exactly as a file.
   */
  attachments?: Array<{
    type: 'image' | 'audio' | 'file';
    url: string;
    name?: string;
    /** Content type (e.g. `text/plain`, `image/png`), filled if the adapter can obtain it. */
    mime?: string;
    /** Byte size, filled if the adapter can obtain it; used for inline/download threshold decisions. */
    size?: number;
  }>;

  // ---- Platform-normalized supplementary fields (all optional, backward compatible) ----
  // Filled by the adapter normalization layer for gating / identity labeling / reply backfill.

  /** Sender display name; labels who's speaking in multi-party context for the agent. */
  authorName?: string;
  /** Whether the sender is a bot; used for gating (allowBots: none/mentions/all filters on this). */
  authorIsBot?: boolean;
  /** Whether this message @-mentioned the bot itself; used for gating (guild channels need a mention by default). */
  mentionedSelf?: boolean;
  /** Body of the replied-to message; used for reply backfill (feeds context to the agent). */
  quotedContent?: string;
  /** Sender name of the replied-to message; used for reply backfill (labels the quoted identity). */
  quotedAuthor?: string;
}

/**
 * Button-click interaction (normalized form of a platform's native interaction).
 * The adapter receives a Discord MESSAGE_COMPONENT interaction, auto-ACKs, and normalizes to this shape.
 */
export interface ButtonInteraction {
  /**
   * Where the click happened — resolved by the SAME profile.resolveConversation as the
   * message path, so a button clicked inside a topic reaches the conversation that
   * posted it. When these disagreed, a blocking `ask` could never match its pending
   * request and sat until timeout.
   */
  conversation: ConversationRef;
  /** Id of the message the clicked button is on. */
  messageId: string;
  /** Button custom_id (the button id given at send time; no prefix added at this layer). */
  buttonId: string;
}

/**
 * Normalized form of a slash-command invocation interaction.
 * The adapter receives a Discord APPLICATION_COMMAND interaction, auto-ACKs, and normalizes to this shape.
 */
export interface CommandInteraction {
  /** Where the command was invoked (same resolution as the message path). */
  conversation: ConversationRef;
  /** Interaction message id (the Discord interaction's own id). */
  messageId: string;
  /** Command name, e.g. 'model'. */
  name: string;
  /** Command arguments (e.g. `{ name: 'gpt-x' }`). */
  options: Record<string, unknown>;
  /**
   * Reply closure: replies via followup using the session bound to this interaction.
   * It's a self-contained closure (rather than re-sending by address) because only the
   * original session carries the interaction token needed to hit followup; doing it without
   * the session via internal is possible but requires storing token+app_id ourselves.
   */
  reply: (text: string) => Promise<void>;
}

/**
 * An available command dynamically reported by the agent (ACP).
 * From session/update's `available_commands_update`; a platform-agnostic minimal shape.
 * NOT what the platform menu is built from — that set is fixed at startup from config alone (see
 * daemon buildRegisteredSpecs). This list feeds `/skills` and the harness pickers; when one of its
 * names is invoked the daemon forwards `/<name> <input>` back to the agent as a prompt verbatim
 * (the daemon doesn't interpret the command).
 */
export interface AgentCommand {
  /** Command name (no leading /, e.g. `create_plan`). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** If the command takes input, the hint text shown to the user (ACP unstructured input.hint). */
  hint?: string;
}

/**
 * A question the AGENT asked the user, mid-turn, and is blocked on.
 *
 * From ACP `elicitation/create` (form mode) — the protocol's way for an agent to stop and ask
 * rather than guess. On the `claude` harness this is how the model's own `AskUserQuestion` tool
 * surfaces: the adapter keeps that tool disabled unless the client advertises
 * `clientCapabilities.elicitation.form`, so declaring the capability is what turns "the model
 * guesses, or asks in prose and ends its turn" into "the model asks and waits".
 *
 * Platform-agnostic on purpose: the ACP wire shape (a JSON Schema of `question_<n>` fields with
 * `oneOf` enums) is translated at the protocol boundary, so the daemon renders buttons from this
 * and never sees a schema. Multi-question forms become several rounds, asked in order.
 */
export interface AgentElicitation {
  /** The ask, shown above the first round's buttons (the question text for a single-question form). */
  message: string;
  /** One round per question, in the order the agent listed them. Never empty. */
  questions: ElicitQuestion[];
}

/** One round of an elicitation: what to ask, and the options to offer as buttons. */
export interface ElicitQuestion {
  /** Wire field key the answer must be returned under (`question_<n>`); opaque to the renderer. */
  key: string;
  /** Prompt for this round. For a single-question form this repeats AgentElicitation.message. */
  prompt: string;
  /** Choosable options. Never empty. */
  options: ElicitOption[];
  /**
   * Wire field key for this question's free-text "Other" box (`question_<n>_custom`), when the
   * form offers one. Absent means this question can ONLY be answered by picking an option.
   *
   * This is what makes a typed reply answerable at all: the answer travels under THIS key, and the
   * harness gives it precedence over the enum field (claude-agent-acp's
   * applyAskElicitationResponse: "a typed custom answer wins over the selection"). Without it the
   * only way to honour a typed reply would be to send the enum field a value the agent never
   * offered — which is exactly what ElicitOption's doc says not to do — so a question with no
   * custom key is left un-typeable rather than answered with a guess.
   */
  customKey?: string;
  /**
   * Whether the wire field takes an array (ACP multi-select), i.e. the agent asked "pick every one
   * that applies" and expects however many the user ticks.
   *
   * The daemon honours it by making the question's buttons stateful: a tap toggles a tick and a
   * Done button ends the round. That needs the posted buttons to be redrawable, so it happens only
   * where `capabilities.editButtons` is true — elsewhere the round degrades to one tap (and says
   * so), because a tick the platform can never repaint is worse than no tick at all.
   */
  multi: boolean;
}

/**
 * One choosable option. `label` and `value` are separate because ACP's `EnumOption` separates
 * them: `title` is display text and `const` is what the answer must carry. They happen to be
 * identical for claude's AskUserQuestion bridge (both are the option label), but an MCP server's
 * own elicitation is free to make them differ, and returning the display text as the answer would
 * silently give that server a value it never offered.
 *
 * `description` is the model's own reasoning for this option, and it is the whole point of asking
 * with buttons rather than in prose — a real payload reads "you already run pgvector here, so
 * reusing it costs nothing". Buttons cannot carry it, so the renderer puts it in the message body
 * above them; dropping it would leave the user picking between bare nouns.
 */
export interface ElicitOption {
  label: string;
  value: string;
  description?: string;
}

/**
 * The user's verdict on an elicitation, in ACP's own vocabulary.
 *
 * `cancel` is the answer for "nobody pressed anything": it tells the agent the question was
 * abandoned, which the harness reports back to the model as an unanswered tool call — strictly
 * better than fabricating a choice it will then act on.
 */
export type ElicitAnswer =
  | { action: 'accept'; content: Record<string, string | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' };

/**
 * An agent asking leave to run a tool (ACP `session/request_permission`), as the user is shown it.
 * Only put to the user for an agent configured `permissions: ask`.
 */
export interface AgentPermissionRequest {
  /** What the agent wants to do, in its own words — the tool call's title (`touch notes.txt`). */
  title: string;
  /** The choices the agent offered, in its order. `label` is the button; `optionId` goes back. */
  options: Array<{ optionId: string; label: string }>;
}

/**
 * What became of a permission request. Kept apart from ElicitAnswer because "nobody answered" is a
 * distinct outcome here, not a kind of cancel: the request is declined, and the agent has to be
 * told that it was NOT the user's refusal (see agent-acp.ts answerPermission).
 */
export type PermissionAnswer =
  /** The user picked one of the agent's options. */
  | { kind: 'selected'; optionId: string }
  /** Nobody answered within `waitedMs`. */
  | { kind: 'unanswered'; waitedMs: number }
  /** It could not be put to anyone (`why` says why: a platform without buttons, no lane, …). */
  | { kind: 'unavailable'; why: string }
  /** Nobody is there to ask by design — a scheduled run: answer as `permissions: auto` would. */
  | { kind: 'unattended' }
  /** Called off with its turn (`/stop`, `/new`). */
  | { kind: 'cancelled' };

/**
 * Slash-command registration spec (platform-agnostic minimal description).
 * The adapter maps it to each platform's native command structure (Discord -> Universal.Command).
 */
export interface SlashCommandSpec {
  /** Command name (1-32 chars, lowercase). */
  name: string;
  /** Command description. */
  description: string;
  /** Command arguments (optional). */
  options?: Array<{
    name: string;
    description: string;
    /** Argument type; defaults to string. */
    type?: 'string' | 'boolean' | 'number' | 'integer';
    /** Whether required; defaults to false. */
    required?: boolean;
  }>;
}

/**
 * Identifier of a conversation: which conversation an inbound message belongs to.
 * Computed by core/conversation.ts conversationKey(scope, ref) per scope
 * (per_thread/per_channel/per_user/shared).
 *
 * Deliberately NOT agent-qualified: the agent answering a conversation is a mutable
 * property of it, not part of its identity (see core/conversation.ts).
 */
export type ConversationId = string;

/**
 * What happened to a message offered to a turn that was already running (see AgentSession.steer and
 * InboundMerger), shared because the merger in core/ decides on it and the runtimes in daemon/ produce it.
 *
 * - `joined`   — the harness took it into the running turn and will see it at its next natural point
 *                (between tool calls, before its next request to the model). The turn's reply now
 *                answers it too, and the turn ends only once it has.
 * - `detached` — the harness took it, but answers it outside the turn: the turn had finished inside
 *                the harness a moment before the message got there, and the harness started a turn of
 *                its own for it (codex-acp does this). The reply arrives as background output.
 * - `refused`  — the harness has it NOT. Nothing to join, a harness that cannot, or a message that
 *                must not (a slash command). The caller still holds it and sends it after the turn.
 */
export type SteerOutcome = 'joined' | 'detached' | 'refused';

/**
 * Tool-bubble render mode (domain concept shared by the core renderer and config schema).
 * off: no render / all: render every tool / new: dedupe consecutive same-name / verbose: include full args.
 */
export type ToolMode = 'off' | 'all' | 'new' | 'verbose';

/** Tool-call (start) event (from the claude agent sdk stream). */
export interface ToolEvent {
  name: string;
  /** Input summary for preview (the renderer truncates). */
  inputPreview: string;
  /** Full args shown in verbose mode. */
  input?: unknown;
  /**
   * Monotonically increasing index, used to relate the corresponding finish event back to this start.
   * The accumulate grouping mode uses it to locate and edit the same bubble (in-place progress refresh).
   */
  index?: number;
  /**
   * Name of the subagent that ran this tool; undefined when the main agent ran it. The bubble line
   * leads with it, because otherwise a subagent's tools are indistinguishable from the main agent's
   * (see daemon/agent-acp.ts claudeAttribution).
   */
  agent?: string;
}

/**
 * Tool-finish event: emitted when a tool call ends, paired with the same-index ToolEvent (start).
 * The renderer uses it to update the matching bubble to a "done/duration" state in accumulate mode.
 */
export interface ToolFinishEvent {
  /** Tool name (same as start). */
  name: string;
  /** Index relating back to start; corresponds to ToolEvent.index. */
  index?: number;
  /** Success (true = completed normally, false = errored). */
  ok: boolean;
  /** Duration of this tool call (ms). */
  durationMs: number;
}

/**
 * A session's model selector, as the harness exposes it (ACP session config option `model`).
 *
 * Read off the live session rather than from config: `agents[].model` is an intent a harness may
 * ignore (opencode does — it reported its own default until the daemon set the option explicitly),
 * and a harness that pins its model elsewhere (claude, via ANTHROPIC_MODEL) offers no selector at
 * all, which is a different answer from "the list is empty".
 */
export interface ModelSelector {
  /** The model serving this session right now. */
  current?: string;
  /** Selectable ids with the display names the harness gave them. May be empty. */
  options: Array<{ value: string; name: string }>;
}

/**
 * A session's reasoning-effort selector (the ACP config option in the `thought_level` category).
 *
 * Its own type rather than a second use of ModelSelector, although the shape is the same, because
 * the two are not interchangeable: the effort list belongs to the CURRENT MODEL, not to the session
 * — opencode offers one only for a model with reasoning variants, and codex only for a model in its
 * own catalog — so a model switch can reshape it or take it away entirely.
 *
 * `current` is the raw value, `default` included. The footer drops `default` because it names no
 * level; a selector must not, because on claude and opencode it is one of the choices.
 */
export interface EffortSelector {
  /** The level this session is on right now. */
  current?: string;
  /** Selectable levels with the display names the harness gave them. */
  options: Array<{ value: string; name: string }>;
}

/**
 * One usage-quota pool a harness reports, e.g. agy's `gemini-5h` or `3p-weekly`.
 *
 * Kept in the harness's own vocabulary (`id` is its key, verbatim) rather than mapped onto a fixed
 * set of windows here: agy names four pools today and has renamed them before (`gemini-daily` is
 * in the shim's fallbacks for that reason), and a gateway that only understood the four would drop
 * a fifth on the floor instead of showing it.
 */
export interface QuotaPool {
  /** The harness's pool key, verbatim. */
  id: string;
  /** Fraction of the pool still available, 0…1. */
  remaining: number;
  /** When the pool refills, epoch ms. Absent when the harness did not say. */
  resetsAt?: number;
  /**
   * Whether the model serving the session spends from this pool. agy keeps separate pools for
   * Gemini and for third-party models, and only one of them moves on any given turn.
   */
  active?: boolean;
}

/**
 * What a status bar shows about the agent behind one conversation, continuously rather than once
 * per reply (the footer's job).
 *
 * Every field but `agent` is optional because every harness reports a different subset, and an
 * absent field is rendered as nothing rather than as a zero: claude reports cost and (through its
 * transcript) a prompt-cache expiry but no quota on an API key, agy reports quota but no cost,
 * codex reports context alone. A guessed value here would be read as a measurement.
 */
export interface AgentStatus {
  /** Agent id as configured (`cc`, `agy`). */
  agent: string;
  /** Short model name, as the footer prints it. */
  model?: string;
  /** Reasoning effort the harness reports. */
  effort?: string;
  /** Tokens in context over the window — the same pair `/context` quotes. */
  context?: { used: number; size: number };
  /** Cumulative session cost, as the harness reports it. */
  cost?: { amount: number; currency: string };
  /**
   * When the prompt cache written by the session's last request expires, epoch ms. Past this
   * moment the next message re-reads the whole context at full price, which is the reason anyone
   * wants to see it.
   */
  cacheExpiresAt?: number;
  /** Usage-quota pools, in the order the harness listed them. */
  quota?: QuotaPool[];
}

/**
 * The agents a conversation that has not started yet could be handed to, grouped by machine — what
 * a page with room for it lays out instead of an empty transcript (the web UI's new topic).
 *
 * Built by `core/agent-menu.ts` agentCatalog from the same grouping the `/agent` menu uses, so the
 * two cannot call one machine different things.
 */
export interface AgentCatalog {
  /**
   * The agent that answers if nobody chooses: the conversation's binding, else where it routes by
   * default. The page marks it, because "just type" is an answer too and this is who it reaches.
   */
  current: string;
  groups: AgentCatalogGroup[];
}

export interface AgentCatalogGroup {
  /** The machine: `agents[].group`, else its host, else `LOCAL_GROUP`. */
  name: string;
  agents: AgentCatalogEntry[];
}

export interface AgentCatalogEntry {
  /** The id `/agent <id>` takes. */
  id: string;
  /** `agents[].harness` as configured: a stable key to draw by, where `kind` is words to read. */
  harness: string;
  /** What it is, as its project names it (`Claude Code`), or the command for a custom harness. */
  kind: string;
  /** The model configured for it, when there is one — short, as the footer says it (no vendor prefix). */
  model?: string;
}

/**
 * Why a turn failed, as precisely as the runtime could tell. What `agents[].hooks.turnFailed`
 * matches `continue.on` against, so the words are the operator's vocabulary as much as ours.
 *
 * The first five are claude-agent-acp's own failure lanes (its AIR `sessionFailure` category, see
 * daemon/session-failure.ts) and are only ever reported for the `claude` harness — the others fail a
 * turn with nothing but text, which is `other`. The rest are the gateway's:
 *  - `provider` — the model provider failed in a lane the harness did not name;
 *  - `hung`     — the silence watchdog gave up on the turn (session.turnTimeoutMs of nothing);
 *  - `startup`  — the agent's child could not be started at all;
 *  - `preLaunch`— the operator's `hooks.preLaunch` command failed;
 *  - `restart`  — the gateway went down while the turn was running (found on the next start);
 *  - `other`    — anything else.
 */
export type TurnFailureReason =
  | 'service'
  | 'limit'
  | 'connection'
  | 'access'
  | 'request'
  | 'provider'
  | 'hung'
  | 'startup'
  | 'preLaunch'
  | 'restart'
  | 'other';

/**
 * How a conversation's last turn ended, for a surface that lists what is waiting on a person.
 *
 * Only the two endings that leave something for a person: a stopped turn leaves nothing (the person
 * stopped it), and a turn still running has no ending yet.
 */
export interface TurnOutcome {
  kind: 'done' | 'failed';
  /** When it ended, epoch ms. Compared against when the person last looked (`TopicFacts.seenAt`). */
  at: number;
  /**
   * One line to show beside the conversation's name: the reply's first line for `done` — replies
   * here are written conclusion-first — and what went wrong for `failed`. Absent when there is none.
   */
  line?: string;
  /** Only on `failed`. */
  reason?: TurnFailureReason;
}

/**
 * What the gateway knows about a conversation that a platform does not: how its last turn ended, and
 * whether a turn is about to be continued automatically (`hooks.turnFailed.continue`). Pushed to a
 * platform that lists its conversations (`PlatformAdapter.setActivity`); whether a turn is running
 * or a question is on screen the platform already knows from typing and buttons.
 */
export interface TopicActivity {
  outcome?: TurnOutcome;
  /** An automatic continue is scheduled: which attempt, out of how many, due when (epoch ms). */
  retry?: { attempt: number; max: number; at: number };
}

/**
 * Where a conversation stands, from a person's point of view (core/topic-stage.ts). The first three
 * of the `needs-you` ones are the only ones a list of things to do shows; see `needsPerson`.
 */
export type TopicStage = 'answer' | 'failed' | 'review' | 'retrying' | 'working' | 'idle';

/**
 * One row of the settings screen the web UI draws for `/setting`.
 *
 * A chat app gets a grid of buttons and has to put the label and the value into one string, which
 * is why a model row there reads `Default model · cc · (harness default)` and loses its tail to the
 * 40-character label budget. A page has room for two lines and a whole row to tap, so the menu
 * builder splits the same data into fields instead of leaving the page to find the separator again.
 *
 * `buttonId` is what a tap posts, exactly as a button's id would be: the page never derives it.
 */
export interface SettingsScreenRow {
  /** The button id that opens this row — a setting's values, or another menu. */
  buttonId: string;
  /**
   * What the row is called. A setting's name (`Idle reclaim`); for a per-agent row the agent's id,
   * since the group heading already says which setting the rows under it are.
   */
  label: string;
  /** The agent a per-agent setting applies to (`cc`, `cbc@uniagent`); absent for global ones. */
  target?: string;
  /** What that agent is — its harness as its project names it, a custom harness's command. */
  targetKind?: string;
  /** The target is the agent answering the conversation this screen was opened in. */
  here?: boolean;
  /** The current value, already formatted for display. Absent on a row that opens another menu. */
  value?: string;
  /** Nothing is set, and `value` says what that means (`harness default`): drawn as a placeholder. */
  unset?: boolean;
  /** One line on what the setting decides. Absent where the group's note says it for every row. */
  hint?: string;
  /**
   * When a change lands, where that is not "at once" and the group does not already say it
   * (`after restart`). Live settings carry none: a badge on every row would stop meaning anything.
   */
  effectLabel?: string;
  /** The whole sentence behind `effectLabel`. */
  effectDetail?: string;
  /** The section this row belongs to; consecutive rows with the same group share a heading. */
  group: string;
  /** How the value is changed from the screen. */
  control: SettingsScreenControl;
}

/**
 * How a settings row is changed, decided by the settings table (core/settings.ts settingControl)
 * rather than by the page — the page draws the kind it is given.
 *
 * - `switch`: two states. `set` is the button id that writes the OTHER one, so a tap names the
 *   value it wants rather than asking for a flip — a retried request cannot undo itself.
 * - `choice`: a short closed list, every option writable from the row itself.
 * - `list`: the row opens the setting's own value screen (`buttonId`) — a list that is long, has
 *   to be fetched, or accepts a typed value (a model).
 * - `link`: the row leads to another menu, not to a value (the scheduled tasks).
 */
export type SettingsScreenControl =
  | { kind: 'switch'; on: boolean; set: string }
  | { kind: 'choice'; options: SettingsScreenOption[] }
  | { kind: 'list' }
  | { kind: 'link' };

/** A section of the list: its heading, and a sentence that applies to every row in it. */
export interface SettingsScreenGroup {
  name: string;
  note?: string;
}

/** What the last action on this screen did — the ack a chat app gets above the menu, as a banner. */
export interface SettingsScreenNotice {
  tone: 'ok' | 'info' | 'error';
  /** Plain text; `code` spans in backticks and line breaks are kept. */
  text: string;
}

/** The setting a value screen is about, drawn above its values. */
export interface SettingsScreenHead {
  label: string;
  target?: string;
  targetKind?: string;
  value: string;
  unset?: boolean;
  /** What the setting decides (core/settings.ts settingDescription). */
  description: string;
  /** Why the list is not the whole answer, and what to type instead (settingTypedOnlyHint). */
  hint?: string;
  /** When a change lands, as a sentence. */
  effect: string;
}

/** One value of an open setting, as the web UI's value list draws it. */
export interface SettingsScreenOption {
  /** The button id that writes this value. */
  buttonId: string;
  /** The value itself (`15m`, `per_thread`, a model id). */
  label: string;
  /** What the value means, when it needs a sentence. */
  detail?: string;
  /** Whether this is the value the setting holds now. */
  current: boolean;
}

/** Paging and the way back, at the foot of a value list. */
export interface SettingsScreenNav {
  /** 1-based, for display. */
  page: number;
  pageCount: number;
  prev?: string;
  next?: string;
  back?: string;
}

/**
 * The `/setting` menu as data, for a platform that draws its own screen instead of a button grid.
 *
 * Sent only to a platform declaring `capabilities.settingsScreen` (the web UI), so a chat app's
 * output is exactly what it was: the same `text` and the same `buttons`.
 */
export type SettingsScreen =
  | {
      level: 'list';
      /** Where these settings are kept and when a change lands, said once for the whole screen. */
      about?: string;
      groups: SettingsScreenGroup[];
      rows: SettingsScreenRow[];
      notice?: SettingsScreenNotice;
    }
  | {
      level: 'values';
      head?: SettingsScreenHead;
      options: SettingsScreenOption[];
      nav: SettingsScreenNav;
      notice?: SettingsScreenNotice;
    };
