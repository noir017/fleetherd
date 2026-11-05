import type { AgentDef, Config } from '../config/schema.js';
import type { SlashCommandSpec } from '../types.js';

/**
 * The registered slash vocabulary: daemon commands, agent commands, and the generic
 * commands with their per-harness translation (pure functions).
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Native platform slash commands are GLOBAL (Telegram setMyCommands is per-bot,
 * Discord per-application/guild), while agents are PER-SESSION. Registering the
 * union of what every agent reports therefore produces a menu that cannot say who
 * owns an entry, and an entry invoked from the menu is routed like any other
 * message — i.e. to `routing.default`, not to the agent that offered it. With two
 * harnesses configured that misfires concretely: opencode's `customize-opencode`
 * was landing on the `claude` agent.
 *
 * So the registered set is instead a small, FIXED vocabulary that means the same
 * thing everywhere, translated per harness at invocation time. A harness with no
 * equivalent gets an explicit "not supported" reply rather than a prompt it will
 * misread. Harness-specific commands are not registered globally at all; they live
 * behind the bare form of that harness's agent command (see HARNESS_COMMANDS).
 *
 * ── Provenance of the table ───────────────────────────────────────────────────
 * `claude` and `opencode` were captured live over ACP (available_commands_update)
 * from the harness versions this daemon launches. `gemini` is best-effort and
 * UNVERIFIED — carried over from names the CLI documents, no install to probe.
 * `codex` was empty for the same reason gemini is thin — Zed's adapter advertised six
 * commands and no model list, so there was nothing worth translating to. It was probed
 * on 2026-09-20 against @agentclientprotocol/codex-acp 1.12.0, which advertises 42
 * (11 built in, the rest the operator's own skills as `$name`); the entries below are
 * that capture, and the ones deliberately still absent are named at their own keys.
 */

/** Harness kinds an agent can declare (mirrors AgentDefSchema.harness). */
export type Harness = AgentDef['harness'];

/**
 * Valid slash name: lowercase/digit/_/-, 1-32 chars (Discord constraint). Non-matching names are
 * skipped on registration. Here rather than in daemon.ts because routeCommandSpecs checks names an
 * operator wrote against it, and core cannot import daemon.
 */
export const SLASH_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Slash description cap (Discord 100 chars); truncated beyond. */
export const SLASH_DESC_MAX = 100;

/**
 * Commands the DAEMON answers itself — intercepted in ConversationRegistry.route() and never
 * forwarded to an agent. Defined here rather than in daemon.ts so that registration
 * (buildRegisteredSpecs) and `/help` read one list instead of two that can drift.
 *
 * `/help` deliberately shadows the harness's own `/help` (claude has one): from a chat client the
 * gateway's vocabulary is the one the user cannot discover any other way, while the harness's own
 * help is still one tap away inside its agent-command menu (`/cc`).
 *
 * `/stop` and `/new` are two commands rather than one because they answer two different asks. Both
 * end the running turn; only `/new` also destroys the context. Before `/stop` existed, "make it
 * stop" cost the user their whole conversation, since the only other interrupt was
 * `inbound.interruptOnNewMessage` — which fired as a side effect of sending another message, not
 * because anybody asked for it. That side effect is gone too (a message sent mid-turn now joins the
 * turn or waits behind it), which leaves `/stop` as the one way to cut a turn short.
 *
 * `/kill` is the third rung, between those two: it ends the agent's PROCESS and keeps the
 * conversation, the manual form of what the idle sweeper does on its own. `/stop` cannot be that
 * command, because its cancel is cooperative — it asks the harness to stop (ACP `session/cancel`),
 * and a harness wedged inside a tool call never answers. The only thing that still works then is
 * ending the child, and before `/kill` the commands that did so (`/new`, `/cd`) also threw away the
 * context the user was trying to save. Kept apart from `/stop` rather than folded into
 * it because the price differs: the next message after `/kill` pays a respawn and a session
 * reload, and "stop that reply" should not cost that every time.
 *
 * `/setting` is the only command in this list that writes to disk, and the only one whose effect
 * outlives the conversation it was typed in: it edits config.yaml (see core/settings.ts for what it
 * will and will not touch). Registered alongside the rest because the alternative — reaching the
 * machine to edit YAML and restarting, which stops every resident agent — is the cost this gateway
 * exists to remove.
 *
 * `/reload` is `/setting`'s other half: for a change made to config.yaml directly — an agent added,
 * a route edited — it applies the file to the running daemon (daemon/config-reload.ts). Without it
 * the only way was a restart, which ends every resident agent, including the one that made the edit.
 *
 * `/cd` is the one that costs the most when used, and it is here rather than in the generic
 * vocabulary because it is not a question for the harness at all: the directory is recorded against
 * the CONVERSATION and read at spawn, so every harness gets it, including the ones (agy) that
 * expose no commands of their own. Its effect on the agent is the same as `/new` — a session is
 * pinned to the directory it started in — which is why the menu it opens says so before the tap.
 */
export const DAEMON_COMMANDS: SlashCommandSpec[] = [
  { name: 'new', description: 'Start a fresh conversation (clears context)' },
  { name: 'clear', description: 'Alias of /new: start a fresh conversation' },
  { name: 'stop', description: 'Stop the current turn or background work (keeps the conversation)' },
  { name: 'kill', description: 'End the agent process (keeps the conversation; the next message resumes it)' },
  { name: 'cd', description: 'Choose the working directory (starts a fresh session there)' },
  { name: 'agent', description: 'Choose which agent answers this topic (grouped by machine)' },
  { name: 'setting', description: 'Change a saved setting (default agent, model, session)' },
  { name: 'reload', description: 'Apply an edited config.yaml without restarting the daemon' },
  { name: 'title', description: 'Name this topic (it is named automatically otherwise)' },
  { name: 'skills', description: "List the current agent's own commands" },
  { name: 'help', description: 'List the commands this gateway understands' },
];

interface GenericCommand {
  /** Menu description, phrased for the generic meaning rather than any one harness. */
  description: string;
  /**
   * Native name per harness. A MISSING key means that harness has no equivalent — the command is
   * then answered locally when `local` is set, and rejected otherwise. Never forwarded blind.
   */
  native: Partial<Record<Harness, string>>;
  /**
   * Harnesses where the DAEMON answers this itself, having no native spelling to translate to.
   *
   * These are not translations: they are questions the gateway can answer from what it already
   * holds, so a harness that never implemented the command still gets a real reply instead of
   * "not supported". Both current cases come off the ACP session rather than a slash command —
   * live usage (`usage_update`) and the session's model selector (`session/set_config_option`) —
   * which is exactly why they had no native name to translate to.
   *
   * A native spelling still WINS where one exists — `/context` on claude reaches claude's own
   * `/context`, which knows more about claude than this gateway does. The fallback fills a hole;
   * it never covers a harness that solved the problem itself.
   *
   * `/model` on claude is the deliberate exception, and it is not a violation of that rule so much
   * as a finding about what claude's own answer is. Probed live against claude-agent-acp 0.58.1:
   * `model` is NOT among the commands the adapter advertises (getAvailableSlashCommands), and a
   * forwarded `/model` is therefore just a prompt — it spends a turn and prints
   * "Current model: Opus 4.8 (1M context) … Usage: /model <name>", i.e. text you then have to type
   * against. Meanwhile the same session exposes the selector as a config option that
   * `session/set_config_option` switches. So the gateway answers it: one tap, no turn. The cost is
   * that only the five options the protocol lists can be chosen — claude's own prose names more
   * aliases (`opusplan`, `best`, a full model id) — and those stay reachable through
   * `agents[].env.ANTHROPIC_MODEL`, which is where this deployment pins its model anyway.
   *
   * A LIST rather than a flag, and populated only from what was probed live. `agy` is why that
   * distinction earns its keep: it speaks no ACP, so for a long time it could claim none of these,
   * and each entry it has since gained came from finding the channel agy actually publishes on —
   * `agy models` for the selector, `agy -p=/usage` for the quota, its `statusLine` command for the
   * context window. An honest "not supported" beats an answer that never arrives, and the way out
   * of one is evidence, not optimism.
   */
  local?: Harness[];
  /**
   * A question ABOUT the session rather than work FOR it — the gateway answers it itself while the
   * conversation is busy, instead of forwarding it (see isSessionQuery).
   *
   * Forwarding is what the translation table does, and a forwarded command is just another inbound
   * message. Through 2.0.0 that meant it cancelled the running turn (`inbound.interruptOnNewMessage`),
   * and for `/usage` the trade was absurd. Seen live on 2026-09-30: a cc turn running typecheck + the
   * full suite was cancelled mid-Bash by a `/usage` that Claude Code then answered in under 50ms
   * without calling the model (a `local_command` in the transcript) — and the work stayed stopped
   * until the user typed "继续" six minutes later and the tests were run again. A message sent
   * mid-turn no longer cancels anything, but a COMMAND still cannot join a running turn (it must be
   * the first thing in a prompt to run as one — see TurnRunner.steer), so forwarded it would wait
   * for the whole turn to end. An answer now beats a fuller one in ten minutes.
   *
   * Only while busy. An idle conversation still gets the harness's own answer, which knows more
   * than the gateway does (per-model tokens, cache, API time on claude); the gateway's copy is the
   * best that can be said without touching a session that is in the middle of something.
   */
  query?: true;
  /**
   * What the command expects after its name, for a menu to show while it is typed (`/super <job>`).
   * Registered as the spec's one required option. Only where an empty invocation means nothing:
   * `/model` alone opens a menu, `/super` alone splits no job.
   */
  arg?: { name: string; description: string };
  /**
   * Offered only on a platform that nests one topic under another — see CommandSurface. The
   * capability is the platform's, not the harness's, so translateCommand cannot decide it.
   */
  nested?: true;
  /**
   * The ACP config option whose presence lets the gateway answer this for a `custom` harness.
   *
   * A custom harness passes everything through, because nothing is known about a user's own ACP
   * program (translateCommand). An option it declares in `session/new` is something known, though,
   * and it is the very thing `local` answers from — so where a custom agent has declared it, the
   * gateway answers as it does for a preset, and where it has not, the command passes through as
   * before. Evidence, not a guess about the program. Seen on CodeBuddy 2.179.3 (2026-11-05): its
   * session/new carries `configOptions` with `{id: "model", type: "select"}` and 22 models, and it
   * advertises no `availableCommands` — so a forwarded `/model` was a prompt it answered with
   * nothing, and the turn ended in "no output to display".
   */
  customOption?: string;
}

/**
 * What a platform can show, as far as which commands are offered there.
 *
 * Exists because the generic vocabulary used to mean the same on every platform, and `/super` is
 * the first entry that does not: its sub-agents open as topics nested under the one that asked
 * (daemon/delegation.ts), which only a platform that draws its own topic list can show — the web
 * UI. Registered on Telegram it would be a menu entry whose every tap ends in a refusal.
 *
 * Omitted, a caller means the whole vocabulary regardless of platform (what a reload compares).
 */
export interface CommandSurface {
  /** Whether one topic can be nested under another (`PlatformAdapter.parentOf`). */
  nested: boolean;
}

/** Whether a command is offered on `surface`; with no surface, every command is. */
function offeredOn(cmd: GenericCommand, surface: CommandSurface | undefined): boolean {
  return !cmd.nested || !surface || surface.nested;
}

/**
 * The generic vocabulary. Deliberately small: a command earns a place here only if
 * it means the same thing on more than one harness, or is common enough that a
 * clear "unsupported" is more useful than nothing.
 */
const GENERIC_COMMANDS: Record<string, GenericCommand> = {
  compact: {
    description: 'Compact the conversation to free up context',
    native: { claude: 'compact', gemini: 'compress', codex: 'compact' },
  },
  context: {
    description: 'Show current context usage',
    native: { claude: 'context', gemini: 'stats' },
    // Probed live against opencode 1.18.18: a turn emits `usage_update {used, size, cost}` exactly
    // as claude's adapter does, so the numbers the footer already shows can answer this with no
    // harness command involved.
    //
    // CONDITIONAL, and the condition is not the harness: opencode sends the notification only for a
    // model whose context window it knows. Re-probed on 1.18.27 — `opencode/big-pickle` reports
    // `{used, size: 200000}`, while a model from a custom `provider` block with no `limit.context`
    // reports nothing at all (not a zero window — no notification), and adding `limit.context` to
    // that model makes it report. The local answer is still right for the harness; the empty case is
    // a model-config gap, which is why describeContext names the fix instead of saying "not yet".
    //
    // agy arrives at the same place by a different road: it reports no usage over its protocol at
    // all, but it does hand a context snapshot to whatever `statusLine` command its settings name,
    // in headless mode as well as the TUI (verified on 1.2.0). The daemon installs a shim there and
    // reads the numbers back at the end of each turn — see daemon/agy-statusline.ts.
    //
    // codex answers locally for the same reason opencode does, and unconditionally: probed on
    // codex-acp 1.12.0, a turn emits `usage_update {used, size}` with a real window (258400 for
    // gpt-5.6-terra). Notably this one predates the migration — Zed's adapter reported it too — so
    // it is the one context-related thing codex did not gain by switching.
    local: ['opencode', 'dsh', 'agy', 'codex'],
    // Where it IS forwarded (claude's own `/context`, gemini's `stats`), a busy conversation gets
    // the gateway's copy instead — the same answer the `local` harnesses always get.
    query: true,
  },
  model: {
    description: 'Show or change the model',
    customOption: 'model',
    // No native spelling anywhere, on purpose — see the note on `local` above for why claude's own
    // `/model` is not one worth translating to.
    native: {},
    // Probed live on both: session/new reports a `model` select with the full model list, and
    // session/set_config_option switches it (the daemon already uses that path to enforce
    // `agents[].model`). So the gateway can both show and change it without a slash command —
    // and, where the platform allows, offer the list as a menu instead of a name to type.
    //
    // agy: stream-json has no in-process switch, but `agy models` provides the selector list, and
    // setModel uses kill-and-respawn with --model and --conversation (resuming history).
    //
    // codex: session/new reports both a `models` block and a `model` configOption, switched the
    // same way. Its selector is two-level in a way the others are not, and the two levels disagree
    // about what a model id is — `models.availableModels` has 31 entries, one per model per
    // reasoning effort (`gpt-5.6-terra[medium]`, `[high]`, `[xhigh]`, `[max]`, `[ultra]`), while
    // `configOptions.model` has 6 bare ids. modelSelector reads configOptions, so the menu is the
    // 6, which is the right list to put in front of a user.
    //
    // The effort half is NOT reachable from here, and that is a harness limit rather than a choice:
    // probed on 1.12.0, `session/set_config_option {configId:"model", value:"gpt-5.6-terra[high]"}`
    // is rejected with -32602 Invalid params even though that exact string is a modelId in
    // availableModels. So `agents[].model` must name a bare id too, and effort is set in codex's
    // own config.toml (`model_reasoning_effort = "high"` at TOP level — put it after a
    // `[model_providers.x]` header and TOML silently makes it that table's key, which reads as
    // "the setting does nothing"). With it set, session/new reports `gpt-5.6-terra[high]`.
    local: ['opencode', 'claude', 'agy', 'dsh', 'codex'],
  },
  effort: {
    description: 'Show or change the reasoning effort',
    // No native spelling, for the reason `/model` has none: every harness that has a level exposes
    // it as an ACP config option, and switching that is one tap with no turn spent. Probed on
    // 2026-09-23 — claude-agent-acp 0.81.0, codex-acp 1.13.0 and opencode 2.0.14 all file the
    // option under category `thought_level` (ids `effort`, `reasoning_effort`, `effort`), and
    // `session/set_config_option` switched it on all three.
    native: {},
    // Only where that was probed. agy has no such setting (`agy -p=/effort` answers "not
    // adjustable") and folds it into the model name instead, so `/model` is its answer; dsh and
    // gemini have never been seen to offer a `thought_level` option. All three get the explicit
    // "not supported" — and on agy that also keeps `/effort` out of HARNESS_CLI_ANSWERED's path,
    // where it would have been run as a one-shot process only to print "not adjustable".
    local: ['claude', 'codex', 'opencode'],
  },
  usage: {
    description: 'Show token usage and limits',
    // codex spells it `status` — "Display session configuration and token usage", a superset of
    // what was asked for rather than a near-miss, so it is worth the translation.
    native: { claude: 'usage', codex: 'status' },
    // agy's CLI answers /usage itself, which is precisely why it cannot be forwarded: reaching the
    // resident session it would kill it (see HARNESS_CLI_ANSWERED). The gateway runs it as its own
    // one-shot process instead. Probed on 1.2.0 — four tab-separated columns of pool, metric,
    // remaining percentage and reset timestamp, answered from local state with no model invoked.
    local: ['agy'],
    // claude and codex forward it, so a busy conversation gets the gateway's snapshot instead.
    // agy never needed this: its answer is already a separate process that touches no session.
    query: true,
  },
  doctor: {
    description: "Health-check this agent's own setup",
    // No codex entry: 1.12.0 advertises nothing of the kind, and `status` is already spent on
    // /usage above. Sending it twice under two names would answer the wrong question the second time.
    native: { claude: 'doctor' },
  },
  mcp: {
    description: 'Manage MCP servers',
    native: { claude: 'mcp', gemini: 'mcp', codex: 'mcp' },
  },
  init: {
    description: "Set up this project's agent instructions file",
    // codex HAD this — Zed's adapter advertised `init`, "create an AGENTS.md file with instructions
    // for Codex" — and 1.12.0 dropped it. Left unsupported rather than forwarded as plain text: the
    // harness no longer recognises the name, so `/init` would spend a turn on a model guessing.
    native: { claude: 'init', opencode: 'init' },
  },
  review: {
    description: 'Review the current changes',
    // codex also has review-branch and review-commit, which take arguments and stay reachable
    // through the `/cx` picker; only the bare form means the same thing on every harness.
    native: { claude: 'review', opencode: 'review', codex: 'review' },
  },
  super: {
    description: 'Split a job across agents working in parallel (sub-agents)',
    // Not a harness command anywhere: `super` is a skill this gateway ships (skill-super/) and links
    // into each harness's skill directory (daemon/skill-link.ts). Forwarded unchanged, it reaches the
    // agent as a message starting with `/super`, which is what the skill's description says to act
    // on. Listed here so the menu offers it, and so the harnesses that cannot read the skill say so.
    //
    // Probed on 2026-11-02 against a test gateway (project-scripts/talkcode-super-menu/), one job
    // per harness; every one read the skill and put up the card of sub-agents it proposed:
    //   claude    Claude Code offers a skill as a slash command, so `/super` is one
    //   codex     codex-acp passes an unknown slash on as text; codex read ~/.agents/skills/super
    //   opencode  loaded it with its own `skill` tool
    //   agy       launched with --disable-slash-commands, so the slash is text; read from
    //             ~/.gemini/config/skills (the probe of agent-agy.ts had found such a slash harmless)
    // gemini and dsh are absent because skill-link.ts places no skills for them: nothing would tell
    // them what `/super` means, and an honest "not supported" beats a turn spent guessing.
    native: { claude: 'super', codex: 'super', opencode: 'super', agy: 'super' },
    arg: { name: 'job', description: 'The job to split up' },
    nested: true,
  },
};

/**
 * The agent command each harness answers to — the single source for what gets registered,
 * which spellings resolve, and whether a bare invocation can offer a command menu.
 *
 * ── Why short names ───────────────────────────────────────────────────────────
 * These are typed on a phone keyboard, in the middle of a conversation, many times a day.
 * `/opencode` was the harness enum value leaking into the UI; `/oc` is what operators
 * actually type. The full harness name stays in `aliases` so existing muscle memory (and
 * any `when.command: opencode` rule already in a config) keeps working — it is simply not
 * registered, so it costs no slot in the platform menu.
 *
 * ── Why `picker` is a separate flag ───────────────────────────────────────────
 * Registering a command and having a command list to show are different questions, and
 * `agy` is the case that proves it: it reports no command list at all and is launched with
 * `--disable-slash-commands` (a CLI-answered slash kills the session — see daemon/agent-agy.ts),
 * so a bare `/agy` could only ever answer "no command list yet". It still earns a registered
 * command, because switching a conversation to agy is the useful half. With one flag per
 * concern, a bare `/agy` acks the binding while a bare `/oc` opens opencode's own menu.
 *
 * `custom` is deliberately absent: the harness name carries no meaning to a reader, and a
 * user-supplied executable advertises no stable command set to name.
 */
interface HarnessCommand {
  /** Registered name — the short form the platform menu shows. */
  name: string;
  /** Additional spellings that resolve here. Accepted when typed, never registered. */
  aliases: string[];
  /** Whether a bare invocation can offer this harness's own reported commands. */
  picker: boolean;
}

const HARNESS_COMMANDS: Partial<Record<Harness, HarnessCommand>> = {
  claude: { name: 'cc', aliases: ['claude'], picker: true },
  opencode: { name: 'oc', aliases: ['opencode'], picker: true },
  codex: { name: 'cx', aliases: ['codex'], picker: true },
  gemini: { name: 'gm', aliases: ['gemini'], picker: true },
  agy: { name: 'agy', aliases: [], picker: false },
  dsh: { name: 'dsh', aliases: ['deepseek'], picker: true },
};

/** Reverse index (every accepted spelling → harness), built once. Names are already lowercase. */
const COMMAND_TO_HARNESS = new Map<string, Harness>(
  (Object.entries(HARNESS_COMMANDS) as Array<[Harness, HarnessCommand]>).flatMap(([harness, cmd]) =>
    [cmd.name, ...cmd.aliases].map((spelling) => [spelling, harness] as [string, Harness])
  )
);

/** The registered command name for a harness, or undefined when it has none (`custom`). */
export function harnessCommandName(harness: Harness | undefined): string | undefined {
  return harness ? HARNESS_COMMANDS[harness]?.name : undefined;
}

/** The harness a command name addresses, accepting the short form or the full harness name. */
export function harnessForCommand(name: string): Harness | undefined {
  return COMMAND_TO_HARNESS.get(name.toLowerCase());
}

/** Whether a bare `/<command>` for this harness can offer the agent's own command list. */
export function harnessHasPicker(harness: Harness | undefined): boolean {
  return harness ? (HARNESS_COMMANDS[harness]?.picker ?? false) : false;
}

/**
 * The agent a command name selects: the first configured agent of the harness it addresses.
 *
 * This is what makes a registered agent command work with no `routing.pipeline` entry at all —
 * previously `/oc` meant something only because an operator had written `when: { command: oc }`
 * by hand, so a freshly installed deployment registered a menu whose agent commands were inert
 * and were forwarded to the bound agent as the literal text "/oc".
 *
 * Deliberately keyed on HARNESS, not on agent id: the registered name comes from the harness
 * table, so resolving it through anything else could register one name and select another. An
 * operator who wants a different mapping (or a second agent of the same harness) writes a
 * pipeline rule, which outranks this — see routing.ts resolveAgent.
 */
export function agentForCommand(cfg: Pick<Config, 'agents'>, name: string): string | undefined {
  const harness = harnessForCommand(name);
  if (!harness) return undefined;
  return cfg.agents.find((a) => a.harness === harness)?.id;
}

/**
 * The harness an agent command names when this deployment configures NO agent for it — i.e. the
 * command is a real name in the vocabulary but has nothing to select here (`/agy` with no
 * `harness: agy` agent in config.yaml).
 *
 * Exists because the alternative is the failure this gateway is built to avoid: the name resolves
 * to nobody, so the message keeps its `/agy` prefix and is forwarded verbatim to whichever agent is
 * bound, which reads it as one of ITS own slash commands, finds nothing, and produces no output at
 * all. The user sees a turn that ran and said nothing, with no hint that the command was never
 * wired. Naming the missing agent costs one message and points straight at the config.
 *
 * Consulted only AFTER resolveAgent has declined the name, so both a `when.command` rule and a
 * configured harness outrank it — an operator can still point `/gm` at anything they like.
 */
export function unconfiguredHarnessCommand(
  cfg: Pick<Config, 'agents'>,
  name: string
): Harness | undefined {
  const harness = harnessForCommand(name);
  if (!harness) return undefined;
  return cfg.agents.some((a) => a.harness === harness) ? undefined : harness;
}

/** Outcome of translating one leading `/name` for a target harness. */
export type CommandTranslation =
  /** Not part of the generic vocabulary: forward untouched (power users can still type native names). */
  | { kind: 'passthrough' }
  /** Generic and supported: forward as this native name (may equal the generic one). */
  | { kind: 'translated'; native: string }
  /** Generic, no native spelling, but the daemon can answer it: handle locally, do not run a turn. */
  | { kind: 'local' }
  /** Generic but this harness has no equivalent: reject with a message, do not run a turn. */
  | { kind: 'unsupported' };

/**
 * Translate a leading command name for the harness that will receive it.
 *
 * `custom` passes through: nothing is known about a user-supplied ACP executable, so rejecting
 * its commands would break a working setup on a guess. The one exception is a command whose ACP
 * config option the agent has itself declared (`customOption`, answered by `declares`): that is
 * not a guess, and the gateway answers it as `local`. `declares` is the caller's knowledge of the
 * live session; without it, or when it answers no, a custom harness passes through as it always did.
 */
export function translateCommand(
  name: string,
  harness: Harness | undefined,
  declares?: (optionId: string) => boolean
): CommandTranslation {
  const entry = GENERIC_COMMANDS[name.toLowerCase()];
  if (!entry) return { kind: 'passthrough' };
  if (harness === 'custom' && entry.customOption && declares?.(entry.customOption)) return { kind: 'local' };
  if (!harness || harness === 'custom') return { kind: 'passthrough' };
  const native = entry.native[harness];
  if (native) return { kind: 'translated', native };
  return entry.local?.includes(harness) ? { kind: 'local' } : { kind: 'unsupported' };
}

/**
 * The config option a custom harness has to declare for the gateway to answer this command, or
 * undefined when none would (see GenericCommand.customOption).
 */
export function customOptionFor(name: string): string | undefined {
  return GENERIC_COMMANDS[name.toLowerCase()]?.customOption;
}

/** Whether a name belongs to the generic vocabulary (i.e. is subject to translation). */
export function isGenericCommand(name: string): boolean {
  return Object.hasOwn(GENERIC_COMMANDS, name.toLowerCase());
}

/**
 * Whether a generic command only asks about the session (`/usage`, `/context`), so that a busy
 * conversation can have the gateway answer it rather than forward it into the running turn — see
 * GenericCommand.query for the incident that made this a rule.
 */
export function isSessionQuery(name: string): boolean {
  return GENERIC_COMMANDS[name.toLowerCase()]?.query === true;
}

/**
 * Slash names a harness's own CLI intercepts and answers BEFORE the model ever sees them.
 *
 * These are not commands the gateway lacks a translation for — they are commands that must never
 * be written into a resident session at all, because the CLI answering one ends the session. On
 * agy, a `/model` sent into the stream-json session answers "…is answered by the CLI itself and is
 * unavailable with --input-format stream-json", sets `status:ERROR`, and EXITS with code 2: the
 * conversation's child dies and every later turn in that message goes with it. Verified on agy
 * 1.2.0 (2026-09-17); the same probe confirmed that a skill slash and an unrecognized slash are
 * both harmless, which is why this is an exact list and not "anything starting with /".
 *
 * The list is what `agy -p /help` prints, which is also how to re-derive it:
 *
 *   /agents /changelog /config /credits /effort /help /hooks /model /permissions /skills /usage
 *
 * A STATIC copy of a list the CLI can produce is a deliberate compromise, and the risk is worth
 * naming: if agy adds a twelfth command, a user who types it loses their session until this list
 * catches up. Discovering it at runtime was the alternative and it buys a worse trade — the check
 * has to answer synchronously while routing a message, so a discovered list would either block the
 * first message on a subprocess or be empty for the first seconds after a restart, which is exactly
 * when a daemon is most likely to be handed a command.
 *
 * `/help` and `/skills` appear here for completeness and are never reached: both are daemon
 * commands, intercepted upstream and answered by the gateway itself.
 */
const HARNESS_CLI_ANSWERED: Partial<Record<Harness, readonly string[]>> = {
  agy: [
    'agents',
    'changelog',
    'config',
    'credits',
    'effort',
    'help',
    'hooks',
    'model',
    'permissions',
    'skills',
    'usage',
  ],
};

/** Whether this harness's CLI would answer `/name` itself — see HARNESS_CLI_ANSWERED. */
export function isCliAnsweredCommand(name: string, harness: Harness | undefined): boolean {
  if (!harness) return false;
  return HARNESS_CLI_ANSWERED[harness]?.includes(name.toLowerCase()) ?? false;
}

/**
 * Whether a command needs a platform that nests topics — see CommandSurface. A platform without it
 * refuses the command by name rather than forwarding it into a turn that can only fail.
 */
export function needsNestedTopics(name: string): boolean {
  return GENERIC_COMMANDS[name.toLowerCase()]?.nested === true;
}

/**
 * The generic commands as registrable slash specs, in a stable (alphabetical) order — those offered
 * on `surface`, or all of them when no surface is given.
 */
export function genericCommandSpecs(surface?: CommandSurface): SlashCommandSpec[] {
  return Object.entries(GENERIC_COMMANDS)
    .filter(([, cmd]) => offeredOn(cmd, surface))
    .map(([name, cmd]) => {
      const spec: SlashCommandSpec = { name, description: cmd.description };
      if (cmd.arg) spec.options = [{ name: cmd.arg.name, description: cmd.arg.description, type: 'string', required: true }];
      return spec;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Native names this harness reaches through the generic vocabulary. Used to keep a
 * harness picker from repeating commands that already have a top-level entry.
 */
export function genericNativeNames(harness: Harness | undefined): Set<string> {
  const names = new Set<string>();
  if (!harness || harness === 'custom') return names;
  for (const cmd of Object.values(GENERIC_COMMANDS)) {
    const native = cmd.native[harness];
    if (native) names.add(native);
  }
  return names;
}

/**
 * One agent command per configured harness (`/cc`, `/oc`, `/agy`, …), deduped and ordered stably.
 *
 * `/<cmd> <prompt>` asks that agent — choosing it for a conversation that has none yet; a topic
 * whose agent already has a session keeps it, and is refused with a handover note instead (see
 * ConversationRegistry.refuseAgentSwitch). The bare `/<cmd>` binds and then offers the agent's own
 * harness-specific commands, which are deliberately NOT registered globally (see the file header
 * for why a union menu could not attribute or route them).
 *
 * Ordered by the registered name so the menu is stable across restarts and config edits.
 */
export function agentCommandSpecs(cfg: Pick<Config, 'agents'>): SlashCommandSpec[] {
  const harnesses = new Set<Harness>();
  for (const agent of cfg.agents) {
    if (HARNESS_COMMANDS[agent.harness]) harnesses.add(agent.harness);
  }
  return [...harnesses]
    .map((harness) => ({ harness, cmd: HARNESS_COMMANDS[harness]! }))
    .sort((a, b) => a.cmd.name.localeCompare(b.cmd.name))
    .map(({ harness, cmd }) => ({
      name: cmd.name,
      // Names what the command DOES, since the short name no longer says it. One phrasing for
      // every agent command — `Use <harness>` — because a menu whose entries describe the same
      // action in two different sentences reads as two different features; the bare form is then
      // advertised only on a harness that actually has a list to show. "Use", not "Switch to":
      // a topic with a session no longer switches, so the old verb promised what the tap refuses.
      description: cmd.picker
        ? `Use ${harness} — alone, lists its own commands`
        : `Use ${harness}`,
    }));
}

/** A name `routing.pipeline` gives one agent, and that agent's id. */
interface CommandRoute {
  name: string;
  agentId: string;
}

/**
 * The names `routing.pipeline` gives particular agents (`when: { command: oc2 }`) that the menu can
 * honestly offer, in the order the menu lists them.
 *
 * Only a rule whose ONE condition is the command qualifies. The menu is the same in every chat,
 * while a rule that also names a platform, channel or user matches only there — anywhere else the
 * name would reach the bound agent as the literal text `/oc2`. For the same reason the walk stops
 * at the first rule with no command condition: routing takes the first rule that matches, so that
 * one answers `/oc2 …` too wherever it applies, and the menu cannot say where that is.
 *
 * Skipped as well, because the menu already answers them: names the harness table owns (`/oc`,
 * and the unregistered `/opencode` — a `when.command: opencode` rule written before the short names
 * must not bring back the menu slot their absence saves), and daemon or generic command names. The
 * first rule for a name decides it, as in routing.
 */
function commandRoutes(cfg: Pick<Config, 'routing'>): CommandRoute[] {
  const routes: CommandRoute[] = [];
  const seen = new Set<string>();
  for (const rule of cfg.routing.pipeline) {
    const { command, ...conditions } = rule.when;
    if (command === undefined) break;
    // Normalized the way routing.ts matches it, so the registered name is the one that routes.
    const name = command.replace(/^\//, '').toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    if (Object.values(conditions).some((v) => v !== undefined)) continue;
    if (!SLASH_NAME_RE.test(name)) continue;
    if (harnessForCommand(name) || isGenericCommand(name) || DAEMON_COMMANDS.some((c) => c.name === name)) continue;
    routes.push({ name, agentId: rule.use.agent });
  }
  return routes.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Who a route selects, for a reader: the agent id, with its harness and host when they say
 * something. The name itself was made up by the operator, so on its own it tells the user nothing —
 * `/oc2` could be anything — while "oc-a2 (opencode on devbox)" is the question they are asking.
 */
function routeTarget(cfg: Pick<Config, 'agents'>, agentId: string): string {
  const def = cfg.agents.find((a) => a.id === agentId);
  // `custom` is left out for the reason agentCommandSpecs skips it: the word means nothing to a reader.
  const what = [def && def.harness !== 'custom' ? def.harness : undefined, def?.host ? `on ${def.host}` : undefined]
    .filter(Boolean)
    .join(' ');
  return what ? `${agentId} (${what})` : agentId;
}

/**
 * The names `routing.pipeline` gives particular agents, as registrable specs — the fourth layer of
 * the menu, after the agent commands (see buildRegisteredSpecs).
 *
 * An agent command is keyed on harness (see agentForCommand), so a second agent of one harness — an
 * opencode on another host beside the local one — has no registered name, and the operator wires
 * one by hand with a `when.command` rule. Typed, that already worked. But it had no menu entry and
 * no line in `/help`, so nothing on screen said the name existed: the web UI offered `/oc` to a user
 * typing `/oc2`, and nothing at all for the agent they meant.
 *
 * Described like an agent command, because it is one — the same binding, and bare, the same picker.
 */
export function routeCommandSpecs(cfg: Pick<Config, 'agents' | 'routing'>): SlashCommandSpec[] {
  return commandRoutes(cfg).map(({ name, agentId }) => {
    const harness = cfg.agents.find((a) => a.id === agentId)?.harness;
    const use = `Use ${routeTarget(cfg, agentId)}`;
    const description = harnessHasPicker(harness) ? `${use} — alone, lists its own commands` : use;
    return { name, description: description.slice(0, SLASH_DESC_MAX) };
  });
}

/** The agent a registered route name selects, or undefined when the name is not one (see commandRoutes). */
export function routeCommandAgent(cfg: Pick<Config, 'routing'>, name: string): string | undefined {
  return commandRoutes(cfg).find((r) => r.name === name)?.agentId;
}

/**
 * The `/help` body: every command this deployment answers, grouped by who answers it.
 *
 * Built from the same tables that drive registration, so a command can never appear in the
 * platform menu without appearing here (the drift that makes a help text worse than none).
 *
 * `harness` is the one currently answering the conversation: the generic vocabulary is filtered
 * to what that harness can actually do, because listing `/compact` to an agy user who will be
 * told "not supported" the moment they tap it is the silent-degradation this project avoids.
 * `surface` filters it the same way by what the platform can show (`/super` only where topics nest).
 */
export function buildHelpText(
  cfg: Pick<Config, 'agents' | 'routing'>,
  current?: { agent: string; harness: Harness | undefined },
  surface?: CommandSurface
): string {
  const lines: string[] = [];

  lines.push('**This gateway**');
  for (const cmd of DAEMON_COMMANDS) lines.push(`\`/${cmd.name}\` — ${cmd.description}`);

  const agents = agentCommandSpecs(cfg);
  const routes = commandRoutes(cfg);
  if (agents.length + routes.length > 0) {
    lines.push('', '**Agents** — `/<cmd> <prompt>` asks it; alone, lists its commands. A topic keeps the agent it started with; `/new` to choose again');
    // Named by harness rather than reusing the menu description, which repeats the line above:
    // the menu has no header to carry that explanation, this section does.
    for (const spec of agents) lines.push(`\`/${spec.name}\` — ${harnessForCommand(spec.name)}`);
    for (const route of routes) lines.push(`\`/${route.name}\` — ${routeTarget(cfg, route.agentId)}`);
  }

  // Generic names are translated to each harness's own spelling at invocation time, so what is
  // listed is what this harness will actually accept.
  const generic = genericCommandSpecs(surface).filter(
    (spec) => translateCommand(spec.name, current?.harness).kind !== 'unsupported'
  );
  if (generic.length > 0) {
    lines.push('', '**Works on the current agent**');
    for (const spec of generic) {
      const arg = spec.options?.[0];
      lines.push(`\`/${spec.name}${arg ? ` <${arg.name}>` : ''}\` — ${spec.description}`);
    }
  }

  if (current) {
    lines.push('', `Answering now: **${current.harness ?? current.agent}**`);
  }
  return lines.join('\n');
}

