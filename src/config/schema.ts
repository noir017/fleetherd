import { z } from 'zod';
import type { ToolMode as ToolModeType, TurnFailureReason } from '../types.js';
import { PlatformConfigSchema, type PlatformInstance } from '../platform/config-schemas.js';

/**
 * Config schema + defaults.
 *
 * The user-facing config surface is deliberately small: only what an operator
 * actually decides per deployment — the platform instances + credentials (typed
 * per-platform schemas, see platform/config-schemas.ts), the agent definitions,
 * the routing pipeline, the session scope/lifecycle, and the access allowlist.
 * Everything else (the hermes "experience" tuning: stream throttling, tool-bubble
 * rendering, inbound merging, attachment handling, ipc socket) is NOT configurable;
 * it lives as the frozen `EXPERIENCE` constant below and is merged in at load time.
 * Those knobs were noise — nobody tunes them, and exposing them only bloated the file.
 *
 * Written by the setup wizard (slim), validated by doctor, read by the daemon (full).
 * v0 files (single `platform:` object) are auto-migrated in memory at load
 * (config/migrate.ts); `talkcode doctor --migrate-config` rewrites the file.
 */

// Authoritative type lives in types.ts; here we only build the validation enum from it.
// `satisfies readonly ToolModeType[]` keeps the literals in sync with the domain type — change one and it fails to compile.
const TOOL_MODES = ['off', 'all', 'new', 'verbose'] as const satisfies readonly ToolModeType[];
export const ToolMode = z.enum(TOOL_MODES);
export type ToolMode = ToolModeType;

/**
 * The reasons `hooks.turnFailed.continue.on` accepts — TurnFailureReason in types.ts, which is the
 * authority. Checked both ways: `satisfies` refuses a word that is not a reason, and the assertion
 * below refuses a reason missing from the list, so an operator can always name every one.
 */
export const TURN_FAILURE_REASONS = [
  'service',
  'limit',
  'connection',
  'access',
  'request',
  'provider',
  'hung',
  'startup',
  'preLaunch',
  'restart',
  'other',
] as const satisfies readonly TurnFailureReason[];
type _EveryReasonListed = Exclude<TurnFailureReason, (typeof TURN_FAILURE_REASONS)[number]> extends never ? true : never;
const _everyReasonListed: _EveryReasonListed = true;
void _everyReasonListed;

/** Session scope: which agent session an inbound message belongs to (global default, overridable by route use.scope). */
export const SessionScope = z.enum(['per_thread', 'per_channel', 'per_user', 'shared']);
export type SessionScope = z.infer<typeof SessionScope>;

/**
 * A single agent definition. harness is a preset (claude/gemini/codex/opencode/dsh/agy); with custom,
 * command points at any ACP-speaking executable. harness-specific switches (e.g.
 * claude's --setting-sources) go through args, not the generic schema.
 *
 * Every preset speaks ACP (see daemon/agent-acp.ts); `agy` (Google Antigravity CLI) since agy 1.5,
 * through `agy acp`.
 */
const AgentDefFields = z
  .object({
    /** Unique id referenced by routing. */
    id: z.string().min(1),
    /** Preset; command is required when custom. */
    harness: z.enum(['claude', 'gemini', 'codex', 'opencode', 'dsh', 'agy', 'custom']),
    /** Executable to launch the ACP agent when harness=custom; empty for presets (resolveHarness provides a default). */
    command: z.string().optional(),
    /** Extra args appended to the harness command (harness-specific switches go here). */
    args: z.array(z.string()).default([]),
    /** Working dir (passed as ACP session/new cwd); empty = an auto-created per-agent workspace at ~/.talkcode/agents/<id>. */
    cwd: z.string().optional(),
    /** Model (best-effort via newSession; whether it takes effect depends on the harness). */
    model: z.string().optional(),
    /**
     * Override the context-window size the footer reports (tokens), replacing whatever the harness
     * sends over ACP `usage_update`. Set this when the harness UNDER-reports the window: claude-agent-acp
     * carries a hardcoded model table, and a model absent from it (e.g. `claude-opus-5`) falls back to a
     * 200k default even though the gateway serves 1M — so the same agent shows 200k or 1M depending only
     * on which model the session landed on. A local fact (the gateway's real limit), so it lives in local
     * config rather than being probed: set `contextWindow: 1000000` and the footer reads `/ 1M` regardless.
     * Unset = trust the harness's number.
     */
    contextWindow: z.number().int().positive().optional(),
    /** Env vars injected into the subprocess (credentials etc.); supports ${VAR} expansion. */
    env: z.record(z.string()).default({}),
    /**
     * Operator commands run at points in this agent's life that its harness cannot see (see
     * daemon/agent-hooks.ts). Strict, so a misspelled hook name fails the load instead of silently
     * never running. Deliberately absent from the `/setting` table: a chat-side edit here would be
     * remote shell execution.
     */
    hooks: z
      .object({
        /**
         * A `bash -lc` command run to completion before every spawn of this agent's child —
         * first message, `/new`, a respawn after idle reclaim or a crash. Non-zero exit or
         * timeout fails the startup, so the agent never starts on a half-prepared machine.
         */
        preLaunch: z.string().min(1).optional(),
        /**
         * What happens when one of this agent's turns fails (daemon/turn-outcomes.ts). Absent = what
         * always happened: the ❌ and the reason in the chat, and nothing more.
         */
        turnFailed: z
          .object({
            /**
             * Continue automatically: after a failure whose reason is in `on`, wait and then send
             * `message` to the agent as a turn of its own, up to `max` times in a row. The wait is
             * `backoffMs`, doubling with each attempt (capped at ten minutes). Anything the user
             * sends meanwhile, `/stop`, `/new` or `/kill` calls it off; a turn that ends normally
             * resets the count. Every continue is announced in the chat before it is sent.
             *
             * `message` is put in front of the agent as though the user had typed it — which is
             * why it is the operator's text and nothing the gateway composes (see AGENTS.md,
             * "Nothing of the gateway's in the agent's prompt").
             */
            continue: z
              .object({
                on: z
                  .array(z.enum(TURN_FAILURE_REASONS))
                  .min(1)
                  .default(['service', 'connection', 'limit', 'hung', 'restart']),
                message: z.string().min(1).max(2_000).default('continue'),
                max: z.number().int().min(1).max(10).default(3),
                backoffMs: z.number().int().min(1_000).max(600_000).default(30_000),
              })
              .strict()
              .optional(),
            /**
             * A `bash -lc` command run after every failed turn, on the agent's own machine, with
             * the failure as JSON in `TALKCODE_TURN_FAILURE` — to alert someone, write a log, page
             * a phone. It only reports: whether the turn continues is `continue`'s decision.
             * Bounded at a minute, and its outcome is logged, never shown in the chat.
             */
            command: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * How the daemon answers when the agent asks leave to run a tool (ACP
     * `session/request_permission`). `auto`, the default, approves — what every agent has always
     * had, with access.allowFrom as the only gate. `ask` puts the request to the user as buttons in
     * the chat, and one nobody answers is declined with the agent told so (see agent-acp.ts
     * answerPermission). Only matters for a harness that asks at all — measured 2026-10-28:
     * claude-agent-acp 0.81.2 does in its default mode; codex-acp 2.3.0 (mode `agent`) and
     * opencode 2.2.0 ran a file-writing command without asking.
     */
    permissions: z.enum(['auto', 'ask']).default('auto'),
    /**
     * The `hosts:` entry this agent runs on; absent = this machine. Over there the gateway starts
     * the harness through talkcode-remote (see remote/README.md), so `command`, `cwd`, `env` and
     * `hooks.preLaunch` all mean that host's: its PATH, its directories, its shell.
     */
    host: z.string().min(1).optional(),
    /**
     * A label the `/agent` menu groups agents under — typically where they run. Unset = the
     * agent's host id, or no group for an agent on this machine.
     */
    group: z.string().min(1).max(64).optional(),
  });

/** The cross-field rules every agent definition obeys, wherever it was written. */
function agentRules<O extends { harness: string; command?: string }, I>(
  schema: z.ZodType<O, z.ZodTypeDef, I>
) {
  return schema.refine((a) => a.harness !== 'custom' || (a.command !== undefined && a.command.length > 0), {
    message: 'command is required when harness=custom',
    path: ['command'],
  });
}

export const AgentDefSchema = agentRules(AgentDefFields);
export type AgentDef = z.infer<typeof AgentDefSchema>;

/**
 * An agent as a pod declares it, in `~/.talkcode/pod.yaml` on the host (daemon/pods.ts). The
 * gateway names it `<id>@<host>` — so a pod cannot take an id config.yaml or another pod uses — and
 * runs it on that host, so there is no `host` to give.
 *
 * Its `env` is used as written. An agent's env values are `${VAR}`-expanded again when it is started
 * (agent-common.ts expandEnv), from the GATEWAY's environment, which holds the bot tokens: a pod that
 * could write `${TELEGRAM_BOT_TOKEN}` would be handed it. Refused here rather than escaped there, so
 * the reason reaches whoever wrote the file.
 */
export const POD_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
export const PodAgentSchema = agentRules(
  AgentDefFields.omit({ host: true }).extend({
    id: z.string().regex(POD_AGENT_ID, 'id must be 1-32 chars of letters/digits/_/- and start alphanumeric (the gateway adds @<host>)'),
    env: z
      .record(
        z.string().refine((v) => !v.includes('${'), {
          message:
            'pod.yaml is used as written: ${VAR} would be expanded from the GATEWAY\'s environment. Put the value itself, or set it in this host\'s login environment',
        })
      )
      .default({}),
  })
);
export type PodAgent = z.infer<typeof PodAgentSchema>;

/** `user@host[:port]` — what ssh is given; nothing a shell would split or quote. */
const SSH_DESTINATION = z.string().regex(/^[^\s'"]+$/, 'ssh must be user@host[:port], with no spaces or quotes');

/**
 * `~/.talkcode/pod.yaml` on a host. No `agents:` (or an empty list) = no agents there.
 *
 * `peer:` joins the pod-to-pod ssh mesh (daemon/pod-peers.ts): every pod that has it can ssh to every
 * other as `<host>.pod`, with keys and host keys the gateway puts in place. Asked for by the pod
 * itself, because it is the pod that becomes reachable — the gateway never opens one host to another
 * on its own. `peer.ssh` is how the other pods reach this one, when that is not how the gateway does
 * (a container the gateway reaches by its name on a private network, the others through a published
 * port).
 */
export const PodFileSchema = z
  .object({
    agents: z.array(PodAgentSchema).default([]),
    peer: z.object({ ssh: SSH_DESTINATION.optional() }).strict().nullable().optional(),
  })
  .strict();

/** The id the gateway gives an agent a pod declared. */
export function podAgentId(id: string, host: string): string {
  return `${id}@${host}`;
}

/**
 * A machine the gateway reaches over ssh to run agents on (`hosts.<id>` in config.yaml).
 *
 * On the user side of the config line, like `voice`: it is an address and a credential. The key
 * and known_hosts default to files in the config directory rather than the operator's own
 * `~/.ssh`, because the gateway pins both (binaries.ts sshArgs, `-F none`): a connection it makes
 * never depends on an ssh config it did not write, and a changed host key fails it.
 */
export const HostDefSchema = z
  .object({
    /** `user@host`, optionally `:port` (an IPv6 literal in brackets). */
    ssh: SSH_DESTINATION,
    /** Private key. Default: `<config dir>/ssh/id_ed25519`. */
    identityFile: z.string().min(1).optional(),
    /** known_hosts holding the host's key; checked strictly. Default: `<config dir>/ssh/known_hosts`. */
    knownHostsFile: z.string().min(1).optional(),
  })
  .strict();
export type HostDef = z.infer<typeof HostDefSchema>;

/** Route match conditions (all optional; provided fields must all match; omitted = no constraint). */
export const RouteWhenSchema = z
  .object({
    platform: z.string().optional(),
    serverId: z.string().optional(),
    channelId: z.string().optional(),
    userId: z.string().optional(),
    /** Chat shape: private (DM) / thread / group (any other channel). */
    chat: z.enum(['private', 'group', 'thread']).optional(),
    /** Whether sent by a bot. */
    isBot: z.boolean().optional(),
    /** Slash command name (with or without leading /; matches messages triggering that command). */
    command: z.string().optional(),
  })
  .default({});

/** Disposition on match: which agent to use, optionally overriding scope. */
export const RouteUseSchema = z.object({
  agent: z.string(),
  scope: SessionScope.optional(),
});

export const RouteRuleSchema = z.object({ when: RouteWhenSchema, use: RouteUseSchema });
export type RouteRule = z.infer<typeof RouteRuleSchema>;

/**
 * ── Experience params (NOT user-configurable) ─────────────────────────────────
 * These were previously config sections; they are now frozen constants merged into
 * every loaded Config (see parseConfig). The runtime still reads them as cfg.stream.*,
 * cfg.tools.*, etc. — only the *file surface* dropped them. To change a value, edit it
 * here; it is a code change by design, not an operator knob.
 */
const ExperienceSchema = z.object({
  /** Turn-level session guardrails. The idle-reclaim window is a deployment choice, so it lives in the user surface instead. */
  session: z
    .object({
      /** (reserved) per-thread concurrent session cap; one-session-per-scope-key model, not enforced yet. */
      maxPerThread: z.number().int().positive().default(5),
      /**
       * Per-turn silence watchdog (ms): abort a turn if the agent emits no update for this long.
       * Bounds *silence*, not total turn length (timer resets on every agent update). On trip the
       * subprocess is force-disposed and the turn fails with ❌. Default 10 min; 0 disables.
       *
       * A turn with a tool call still open gets more than this — see TOOL_SILENCE_FACTOR in
       * agent-acp.ts. It has to: a tool is silent for exactly as long as it runs, and Claude
       * Code's Bash tool allows up to 600000ms, i.e. precisely this default, so a tool call at
       * the harness's own limit was certain to trip a watchdog meant for hangs.
       */
      turnTimeoutMs: z.number().int().nonnegative().default(600_000),
    })
    .default({}),

  /**
   * Outbound reply delivery — the TUNING half, frozen. Whether streaming happens at all is
   * `stream.enabled` on the user schema below (the same split `session` uses: the decision is the
   * operator's, the guardrails are not).
   *
   * There is no "delivery mode" enum: whether a reply streams follows from `enabled` AND what the
   * platform can do, not from a preference three values wide. The `mode: auto|edit|chunk` field
   * that used to sit here was read by nothing.
   */
  stream: z
    .object({
      /** Streaming only: flush after this many new chars accumulate. */
      charThreshold: z.number().int().positive().default(200),
      /** Streaming only: flush once this long has passed since the last write (~1/sec IM limit → 1200ms). */
      flushIntervalMs: z.number().int().positive().default(1200),
      /** Streaming only: cap for the exponential backoff after a transient edit failure. */
      maxBackoffMs: z.number().int().positive().default(10_000),
      /**
       * Override the platform's per-message edit budget (`PlatformCapabilities.maxEditsPerMessage`),
       * which bounds both streaming edits and tool-bubble refreshes. Set it only to work around a
       * platform changing its cap on you: too high and the tail of a streamed reply is refused until
       * the writer notices, too low and replies fragment into more messages than necessary.
       * Absent = trust the profile's declared value.
       */
      maxEditsPerMessage: z.number().int().positive().optional(),
      /** If the model replies with only this token, send no message. */
      silentToken: z.string().default('[SILENT]'),
    })
    .default({}),

  /**
   * The per-chat write budget every outbound path shares (core/outbound-pacer.ts).
   *
   * One budget, not one per writer: the platform counts the reply, the tool bubbles, the
   * reactions, the menus and the agent's own reverse commands as a single stream per chat. Four
   * writers each politely throttling themselves still add up to a flood — which is what produced
   * 78 Telegram 429s, with `retry after` reaching 229 seconds, in one daemon run.
   *
   * Frozen: these are guardrails, not deployment decisions. The defaults track what the platforms
   * actually enforce (Telegram: ~1 message/sec per chat, ~30/sec overall).
   */
  outbound: z
    .object({
      /** Sustained writes per second, per chat. */
      ratePerSec: z.number().positive().default(1),
      /**
       * Writes allowed back-to-back on a chat that has been idle.
       *
       * Sized so a whole ORDINARY turn — header bubble, a tool bubble and its refreshes, the reply,
       * the ✅ — goes out with no delay at all, and only sustained traffic is paced. Too small and
       * pacing becomes a latency tax on every turn that uses a tool; too large and a flood gets a
       * long head start before the rate limit bites. The failure this exists to prevent was
       * hundreds of writes, not a dozen.
       */
      burst: z.number().int().positive().default(12),
      /** Ceiling across all chats of one platform instance. */
      globalRatePerSec: z.number().positive().default(25),
      globalBurst: z.number().int().positive().default(30),
      /**
       * How long a tool-progress write may sit queued before it stops being worth sending. Past
       * this it is dropped and the renderer's next paint carries the current state instead — a
       * bubble showing where the agent was eight seconds ago is worse than one that skips ahead.
       */
      progressMaxWaitMs: z.number().int().nonnegative().default(8_000),
      /**
       * How long a finishing turn waits for its tool bubbles to land. Past this the turn stops
       * WAITING; it does not cancel — a queued write still goes out, just after the ✅. Without a
       * bound, a chat the platform paused for 229 s would hold the turn open for the same 229 s.
       */
      finalizeWaitMs: z.number().int().nonnegative().default(15_000),
      /** Ceiling on a platform-stated wait, so one absurd value cannot silence a chat for the process. */
      maxRetryAfterMs: z.number().int().positive().default(300_000),
      /** How long `stop()` spends delivering the queue before abandoning it. */
      drainMs: z.number().int().nonnegative().default(5_000),
    })
    .default({}),

  /** Tool-bubble renderer params. */
  tools: z
    .object({
      mode: ToolMode.default('all'),
      /** accumulate: edit successive progress into one bubble (hermes default) / separate: new message per tool. */
      grouping: z.enum(['separate', 'accumulate']).default('accumulate'),
      previewLimit: z.number().int().positive().default(40),
      defaultEmoji: z.string().default('⚙️'),
      emojiMap: z.record(z.string()).default({
        Read: '📖',
        Edit: '✏️',
        Write: '📝',
        Bash: '💻',
        Grep: '🔍',
        Glob: '🗂️',
        WebFetch: '🌐',
        WebSearch: '🔎',
      }),
      /**
       * First delay before repainting a bubble whose write failed for a reason that stated no wait
       * of its own; doubles up to maxRetryMs. A stated wait (Telegram's `retry after`) is used
       * verbatim instead — see ToolRenderer.armRetry.
       */
      retryIntervalMs: z.number().int().positive().default(1_200),
      /** Ceiling on that exponential retry backoff. */
      maxRetryMs: z.number().int().positive().default(30_000),
    })
    .default({}),

  /** Inbound merger params. */
  inbound: z
    .object({
      /** Merge window for rapid bursts. */
      mergeWindowMs: z.number().int().positive().default(1_500),
      /** Hard cap on the merge window: force the turn to start past this, avoiding turn starvation. */
      maxMergeWindowMs: z.number().int().positive().default(5_000),
      // No `interruptOnNewMessage` any more: a message sent mid-turn is offered to the running turn
      // or queued behind it, and `/stop` is the one way to cut a turn short (core/inbound-merger.ts).
      /** Re-fire interval (ms) for the typing-keepalive loop (Discord typing expires ~10s → 8s). */
      typingIntervalMs: z.number().int().positive().default(8000),
      /**
       * Frozen half of the gating rules (core/inbound-gate.ts shouldRespond). The
       * deployment-facing half (requireMention/freeResponseChannels/ignoredChannels/
       * allowBots + the listen allowlist) lives per platform instance as
       * `platforms.<id>.chat` — see ChatGateSchema in platform/config-schemas.ts.
       */
      gating: z
        .object({
          respondInDirect: z.boolean().default(true),
          threadParticipationExempt: z.boolean().default(true),
        })
        .default({}),
      reactions: z
        .object({
          received: z.string().default('👀'),
          done: z.string().default('✅'),
          error: z.string().default('❌'),
        })
        .default({}),
    })
    .default({}),

  /** Inbound attachment download + text-injection params. */
  attachments: z
    .object({
      enabled: z.boolean().default(true),
      /** Cache dir for downloads; default decided by the daemon (~/.config/talkcode/attachments). */
      cacheDir: z.string().optional(),
      /** Inline readable text into the prompt only if <= this many bytes (else write to disk, pass path). 100KB. */
      maxInjectBytes: z.number().int().positive().default(100_000),
      /** Don't download above this many bytes; emit a metadata line only. 25MB. */
      maxDownloadBytes: z.number().int().positive().default(26_214_400),
    })
    .default({}),

  /** IPC socket. socketPath default ~/.config/talkcode/daemon.sock (resolveSocketPath). */
  ipc: z
    .object({
      socketPath: z.string().optional(),
    })
    .default({}),
});

/** Frozen experience defaults, merged into every Config at load time. */
export const EXPERIENCE = ExperienceSchema.parse({});
type Experience = z.infer<typeof ExperienceSchema>;

/**
 * User-facing config schema — the only thing that lives in config.yaml. Validates
 * what an operator actually sets; experience params are added afterward (parseConfig).
 */
export const ConfigSchema = z
  .object({
    /** Config format version. v0 (the single `platform:` object) is auto-migrated at load; see config/migrate.ts. */
    version: z.literal(1).default(1),

    /**
     * Platform instances, keyed by instance id (what routing `when.platform` and
     * `access.allowFrom` identities reference). Each entry is a typed per-platform
     * object discriminated on `type` — credentials are schema-validated, not an
     * untyped pocket. Same type twice under different ids = multi-account; one
     * daemon drives every configured instance concurrently.
     */
    platforms: z
      .record(
        z
          .string()
          .regex(
            /^[a-z0-9][a-z0-9_-]{0,31}$/i,
            'instance id must be 1-32 chars of letters/digits/_/- and start alphanumeric'
          ),
        PlatformConfigSchema
      )
      .refine((m) => Object.keys(m).length > 0, { message: 'at least one platform instance is required' }),

    /** Agent definitions (at least one); routing selects by id. */
    agents: z.array(AgentDefSchema).min(1),

    /** Remote machines agents can run on, keyed by the id `agents[].host` names (see HostDefSchema). */
    hosts: z
      .record(
        z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/i, 'host id must be 1-32 chars of letters/digits/_/- and start alphanumeric'),
        HostDefSchema
      )
      .optional(),

    /**
     * The default model of an agent a host's pod declares, set from the gateway: `<id>@<host>` → a
     * model name. Outranks that agent's `model:` in its `~/.talkcode/pod.yaml`, and is outranked by a
     * conversation's `/model`. `/setting model.<id>@<host>` writes it; clearing it there falls back
     * to the pod's own value.
     *
     * Why a map of one field rather than a way to override a pod's agent: everything else about an
     * agent — its harness, command, env, hooks — is the pod's to say (daemon/pods.ts), and a field
     * that could reach those would be the gateway reaching into how a host runs its programs. A
     * model is a preference about the conversation, which is the gateway's. Only for pod agents: an
     * agent config.yaml defines keeps its model in `agents[].model`, so there is one place for each
     * (config/pods.ts mergePodAgents ignores a key naming one, and says so). Never read from a pod:
     * pod.yaml's schema is strict and has no such field.
     */
    podModels: z
      .record(z.string().regex(/^[^@\s]+@[^@\s]+$/, 'a podModels key is an agent a pod declares, <id>@<host>'), z.string().min(1))
      .optional(),

    routing: z.object({
      /** Agent id used when the pipeline doesn't match (must exist in agents). */
      default: z.string().min(1),
      /** Ordered routing pipeline: first rule whose when fully matches wins; otherwise default. */
      pipeline: z.array(RouteRuleSchema).default([]),
    }),

    /**
     * Conversation scope and idle reclaim. Turn-level guardrails (turnTimeoutMs/…) stay frozen in
     * EXPERIENCE; these two are here because the right answer depends on the deployment.
     */
    session: z
      .object({
        /**
         * What counts as one conversation (global default, overridable by route.use.scope).
         *
         * Defaults to per_thread: a Telegram topic / Slack thread / Discord thread is its own
         * conversation, and the channel root is another. That matches what a topic is FOR — people
         * open one per task — and it is the only scope under which two topics of one chat don't
         * share an agent's context. Use per_channel to fold every lane of a channel together.
         */
        scope: SessionScope.default('per_thread'),
        /**
         * Stop a conversation's resident agent child after this long with nothing happening in it.
         * 0 disables reclaim entirely (every child stays up until `/new` or shutdown).
         *
         * This is a knob because `scope: per_thread` makes it one: every topic anyone has ever
         * messaged holds its own harness process (a Claude Code child is hundreds of MB), and how
         * many of those a machine can carry is a property of the machine, not of this project.
         *
         * ── What it measures, and why it is safe ────────────────────────────────────────────────
         * The clock counts SILENCE AFTER the last turn ended, not turn length — a task that runs for
         * hours (subagents included) is never a candidate, because its conversation is not idle
         * while it runs. Turn length is bounded separately by EXPERIENCE.session.turnTimeoutMs.
         *
         * One gap, and it is not closable from here: work Claude Code put in the BACKGROUND
         * (`run_in_background`) outlives its turn, so its conversation genuinely does look idle
         * while the script runs. The harness knows (the SDK sends `background_tasks_changed`), but
         * claude-agent-acp does not forward that over ACP, so the gateway cannot see it. Output
         * from such a job touches the conversation as it arrives (see TurnRunner.followUpSink),
         * which keeps a chatty job warm; a job that stays silent longer than this deadline will
         * have its child — and with it the job, a descendant process — stopped. Raise the deadline
         * if that is the workload.
         *
         * Reclaim stops the process, not the conversation: the binding, the reverse-command token
         * and every agent's own session id in conversations.json are all kept, so the next message
         * respawns the child and resumes through the harness's own reload (ACP `session/load`, agy
         * `--conversation`). That is the same path a daemon restart already takes for every
         * conversation at once; this applies it one at a time. A session that cannot state it is
         * resumable is never reclaimed (see AgentSession.reclaimState).
         *
         * The only cost the user can perceive is that the first message after a reclaim waits a few
         * seconds for the respawn.
         */
        idleTimeoutMs: z.number().int().nonnegative().default(3_600_000),
      })
      .default({}),

    /** Access control (decoupled from routing). Identity format `platform:userId`. */
    access: z
      .object({
        /**
         * Allowlist of identities permitted to trigger the agent; empty = unrestricted (anyone who
         * can message the bot can trigger it). WARNING (security): agents always run with full tool
         * access (Bash / file writes), so an empty allowlist means anyone with channel access can
         * drive a fully automatic agent with no authorization gate. In any shared/public deployment,
         * fill this. loadConfig warns (does not block) when it is empty.
         */
        allowFrom: z.array(z.string()).default([]),
      })
      .default({}),

    /**
     * Automatic review of idle conversations (docs/skills.md#auto-review).
     *
     * Off unless the block names a reviewer, because a review spends the reviewer's quota on every
     * conversation that goes quiet and writes into a skill library every agent reads. The
     * deployment decision is who reviews; when a review runs and how much it sees are constants in
     * `daemon/review.ts`, and there is no daily cap.
     *
     * The reviewer is one of two things, never both (checked below):
     *  - `agent` — any agent, on any host: one throwaway session on that agent's machine, in an
     *    empty directory, with no MCP servers, every permission request refused, and the tool
     *    switches the gateway knows for that harness (daemon/review-run.ts acpReviewLaunch; agy is
     *    still one `agy -p` with every permission class denied). `model` overrides the agent's own.
     *    `args` are appended to the command for a review only, and only where the gateway knows no
     *    switch of its own (`custom`, `gemini`, `dsh`) — the operator's way to turn that harness's
     *    tools off.
     *  - `api` — an OpenAI-compatible `/chat/completions` endpoint: one request, no tools at all.
     *    `url` is the base up to and including the version segment (`http://newapi:3000/v1`), like
     *    `title.llm.baseUrl`; `${VAR}` in `url` and `key` is expanded at load like any field.
     * Either way the reviewer never touches a file itself — the gateway applies what it returns
     * through the same rules as `talkcode skills`.
     */
    review: z
      .object({
        agent: z.string().min(1).optional(),
        api: z
          .object({
            url: z.string().min(1),
            key: z.string().min(1),
            model: z.string().min(1),
          })
          .optional(),
        /** The model for an `agent` reviewer; defaults to the agent's own `model`. Not with `api`. */
        model: z.string().min(1).optional(),
        /** Extra arguments for a `custom` / `gemini` / `dsh` reviewer's command, for reviews only. */
        args: z.array(z.string()).optional(),
      })
      .optional(),

    /**
     * The managed skills' shared repository (docs/skills.md#the-repository). Without it the skills
     * still live in a git repository, a local one under the config directory; with it, that
     * repository is kept in step with this one — fetched every few minutes and around every write,
     * and every change the gateway makes pushed to it.
     *
     * On the user side of the config line, like `hosts`: it is an address and a credential. An ssh
     * URL is reached with the gateway's own key and known_hosts, pinned the same way a remote host
     * is (`-F none`, strict host key checking): the repository's host key has to be in that
     * known_hosts already, because the gateway never learns a key by itself.
     */
    skills: z
      .object({
        /** `ssh://git@host:port/owner/repo.git`, or an https URL. */
        repo: z.string().min(1),
        /** The branch to follow and push to. */
        branch: z.string().regex(/^[A-Za-z0-9._/-]+$/, 'a branch name').default('main'),
        /** Private key for an ssh URL. Default: `<config dir>/ssh/id_ed25519`, the one hosts use. */
        identityFile: z.string().min(1).optional(),
        /** known_hosts holding the repository host's key. Default: `<config dir>/ssh/known_hosts`. */
        knownHostsFile: z.string().min(1).optional(),
      })
      .strict()
      .optional(),

    /**
     * Sub-agents (`daemon/delegation.ts`): one agent handing parts of its job to other agents, each
     * in a topic of its own nested under the asking one.
     */
    delegation: z
      .object({
        /**
         * When `task-new` waits for the person to tap Start on a card listing every sub-task:
         *
         * - `true` (the default) — every sub-task waits, every time.
         * - `'first'` — an agent's first sub-task in a conversation waits; once the person has
         *   tapped Start on a card that included it, later sub-tasks for that agent in that
         *   conversation start at once and post the record card. Kept in memory only: a restart,
         *   another conversation, or a change of tier (in either direction) asks again.
         * - `false` — every sub-task starts as it is proposed; the card is posted afterwards as a
         *   record, without buttons.
         *
         * `'first'` and `false` apply only in a conversation the person talks to directly: in a
         * sub-agent's own topic (one with a parent), `task-new` still puts up the card, so an agent
         * cannot chain more agents without a tap.
         *
         * `true` is the default because spawning an agent spends the operator's machines and
         * quota, and the person is the only one who knows whether that part of the job is worth
         * starting now. Turning it off is a decision for a deployment that trusts its agents with
         * that spend. Only a person can change it: `/setting delegation` or this file. No reverse
         * command reaches it — an agent can propose sub-tasks, never decide whether they need a
         * tap.
         */
        confirm: z.union([z.boolean(), z.literal('first')]).default(true),
      })
      .default({}),

    /**
     * Reply delivery. Alongside `display`, the part of outbound rendering an operator legitimately
     * decides; the throttling and chunking guardrails stay in the frozen EXPERIENCE block.
     */
    stream: z
      .object({
        /**
         * Stream the reply by editing one message in place as text arrives.
         *
         * OFF by default, which delivers each completed text segment as a whole message instead.
         * The live effect reads better while it works, but every flush spends an edit and platforms
         * cap them per message (Feishu: 20, after which that message is refused permanently) — so
         * the long, considered reply is the one that runs out of edits mid-delivery. Sent-once text
         * has no such ceiling; the only limit left is message length, which splits cleanly. A turn
         * is not silent either way: a finished segment is sent at every tool boundary.
         *
         * Ignored on platforms that cannot edit messages (QQ/LINE/WeCom/DingTalk) — they deliver
         * whole segments regardless.
         */
        enabled: z.boolean().default(false),
      })
      .default({}),

    /**
     * Reply decoration. The one part of the streaming experience an operator legitimately
     * decides — everything else about outbound rendering (throttling, chunking, tool bubbles)
     * stays in the frozen EXPERIENCE block, but whether replies are annotated with which agent
     * and model answered is a deployment-visible preference, not a tuning knob. Both off by
     * default, so behavior is unchanged unless asked for.
     */
    display: z
      .object({
        /**
         * Standalone "which agent is answering" bubble, e.g. `🤖 cc · opus[1m]`, sent once per
         * session the moment an accepted message arrives — before the agent starts, so it doubles
         * as an immediate receipt while the subprocess spawns. /clear and /new re-arm it.
         *
         * Its model is the CONFIGURED value (agent.model, or a /model override): at receipt time
         * no agent session exists yet, so the live model the footer reports isn't knowable.
         * Header = what was asked for, footer = what actually ran.
         */
        header: z
          .object({
            enabled: z.boolean().default(false),
          })
          .default({}),
        /**
         * Trailing runtime tagline on the final message of each turn, e.g.
         * `cc · 18k / 1M (2%) · claude-opus-4-5`.
         */
        footer: z
          .object({
            enabled: z.boolean().default(false),
            /**
             * Fields and order. `agent` = the agent id that answered (`cc`/`oc`), `model` = short
             * model name, `context` = `18k / 1M (2%)`, `contextPct` = just the percentage,
             * `effort` = reasoning effort, `cwd` = working dir.
             *
             * `effort` is read from the harness's ACP config option in the `thought_level`
             * category (claude and opencode call it `effort`, codex `reasoning_effort`). opencode
             * offers one only for a model with reasoning variants; agy has none (`agy -p=/effort`
             * answers "not adjustable") and folds it into the model name instead. A harness at
             * "default" names no level, so the segment is omitted rather than printing `default`.
             *
             * The context fields need the harness to report ACP `usage_update` (claude and
             * opencode both do — opencode only for a model whose context window it knows, so a
             * custom-provider model needs a `limit.context` in opencode.json); one that doesn't
             * renders no context segment rather than a guessed number.
             */
            fields: z
              .array(z.enum(['agent', 'model', 'context', 'contextPct', 'effort', 'cwd']))
              .default(['agent', 'context', 'model', 'effort']),
          })
          .default({}),
        /**
         * Lifecycle reactions on the USER's inbound message: 👀 while the turn runs, then ✅ or ❌
         * (per-platform mapped — Telegram's allow-set turns these into 👌/👎). Default true, i.e.
         * the long-standing behavior.
         *
         * Worth turning off in a one-operator DM deployment: reactions exist to signal "seen" in a
         * busy channel, but in a private chat the reply itself already proves it, so all they do is
         * decorate every message the operator sends. Suppressing them costs no information — a
         * failed turn still reports itself in-channel via the ❌ error notice.
         *
         * Only the on/off switch is here; the emoji themselves stay in the frozen EXPERIENCE block
         * (`inbound.reactions`), which is why this toggle can't live next to them — anything nested
         * under a key EXPERIENCE owns is overwritten at load (see withExperienceDefaults).
         */
        reactions: z
          .object({
            enabled: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),

    /**
     * How a conversation's chat lane (a Telegram forum topic, a Discord thread) gets its name.
     *
     * A conversation is named ONCE, from its opening message, after its first successful turn, and
     * then left alone until `/title` or `/new`. Whether it happens at all is per-platform
     * (`autoRenameThread`); this block is only about where the name comes from.
     *
     * Without `llm` the name is the opening message cut to 40 characters — a substring, not a
     * summary, and it shows. Point `llm` at any OpenAI-compatible `/chat/completions` endpoint to
     * get a real one; a flash-tier model is the right size for the job and costs ~60 tokens per
     * conversation. A failed call falls back to the substring, so naming never depends on it.
     */
    title: z
      .object({
        llm: z
          .object({
            /** Base URL up to and including the version segment, e.g. `http://newapi:3000/v1`. */
            baseUrl: z.string().min(1),
            apiKey: z.string().min(1),
            model: z.string().min(1),
            /**
             * Deadline for the naming call.
             *
             * Generous on purpose. Nothing waits on it — the reply has already been delivered —
             * so the only thing a tight deadline buys is a conversation stuck with the fallback
             * name for good. A flash-tier model answers in 1-4s; the outliers are the upstream
             * having a moment, and those are exactly the ones worth waiting out.
             */
            timeoutMs: z.number().int().positive().default(45_000),
          })
          .optional(),
      })
      .default({}),

    /**
     * Voice messages → text. Absent = off: a voice note is handled like any other attachment (saved,
     * its path handed to the agent), which is what it always was.
     *
     * With it, a message that is ONLY audio (a voice note, or an audio file sent without a caption)
     * is transcribed, the transcript is shown in the chat labelled as one, and — once confirmed — it
     * goes to the agent as if the user had typed it. The agent is not told the words were spoken;
     * every transcription is logged to `<configDir>/voice-log.jsonl` with its audio file, and the
     * agent can read its conversation's entries with `talkcode voice-log`. See core/voice.ts.
     */
    voice: z
      .object({
        /**
         * Show each transcript with ✅ Send / ✖ Cancel buttons and wait for a tap (the default), or
         * send it on at once (`false`) — the card is still posted, marked as sent automatically, so
         * the chat always shows what the agent was given.
         *
         * On by default because a transcript is a guess: until the recognition has earned trust on
         * this deployment's voices and vocabulary, the person who spoke is the only one who can tell
         * a misheard command from a real one. Editable from chat (`/setting voice`), live.
         *
         * A platform that cannot post buttons (QQ, LINE, WeCom, DingTalk) sends on automatically
         * either way, and the card says why — a confirmation the user has no way to give would
         * leave every voice message stranded.
         */
        confirm: z.boolean().default(true),
        /**
         * Also write each voice message up as the message the speaker meant — fillers, repeats and
         * stutters dropped, self-corrections applied — and show it above the words as heard; ✅ Send
         * (and `confirm: false`) send that version, 🗣️ Send as spoken the other.
         *
         * On by default because speech is not how anyone writes a request, and the verbatim
         * transcript handed the agent every "um, then — then, no, the other one" along with it. It
         * costs a second, text-only request to the same model after the transcription (it never
         * hears the audio; core/voice.ts cleanupInstructions says why), within the same `timeoutMs`;
         * the words as heard stay on the card and in the log, and a cleanup that fails leaves them
         * standing. Off = the verbatim transcript alone, as before. Editable from chat
         * (`/setting cleanup`), live.
         */
        cleanup: z.boolean().default(true),
        /**
         * Names the transcriber should expect — hosts, services, people, jargon this deployment says
         * out loud — added to a built-in list of the gateway's own (talkcode, Claude Code, Codex…).
         * The cleanup is given the same list, to fix what was misheard.
         *
         * A name the model has not been told is spelled by ear: on 2026-10-17 "Unraid" came back as
         * "安瑞" and "昂立", and came back right in each of four runs once it was listed. Speech
         * recognition cannot know a deployment's vocabulary, and nothing else here can either, so it
         * is config.
         */
        vocabulary: z.array(z.string().min(1)).default([]),
        /**
         * The model that does the transcribing, spoken to in Gemini's own `generateContent` format.
         *
         * Gemini-native rather than OpenAI-compatible on purpose: audio goes over as `inline_data`
         * with its real mime type (Ogg, WebM, MP4…) instead of through a proxy's `input_audio`
         * format enum, and the response reports the audio's own token count. Any endpoint that
         * speaks that format works: Google's API directly, or a new-api / one-api gateway in front
         * of it (verified 2026-09-25 against newapi's google-ai-studio channels).
         */
        transcriber: z.object({
          /**
           * Base URL up to and including the version segment: `http://newapi:3000/v1beta`, or
           * `https://generativelanguage.googleapis.com/v1beta`. The request goes to
           * `<baseUrl>/models/<model>:generateContent`.
           */
          baseUrl: z.string().min(1),
          /** Sent as `x-goog-api-key`, which both Google and new-api accept for this format. */
          apiKey: z.string().min(1),
          /** e.g. `gemini-3-flash`. A flash-tier model is the right size: this is recognition, not reasoning. */
          model: z.string().min(1),
          /**
           * Deadline for one transcription, retries included.
           *
           * Not tight, because someone is waiting on the card but nothing else is. The upstream's
           * latency is erratic rather than slow — the same six-second note took 1.3 s on one call
           * and 65 s on another (2026-09-25) — so each attempt has its own shorter deadline and is
           * retried when it stalls (see daemon/voice.ts); this bounds the whole of it. Raise it for
           * long recordings, which take longer to transcribe.
           */
          timeoutMs: z.number().int().positive().default(90_000),
        }),
      })
      .optional(),
  })
  // Referential-integrity + cross-field checks (fail-fast at load). Otherwise a typo
  // would surface only when that agent/platform is used, as an obscure runtime error.
  .superRefine((cfg, ctx) => {
    const ids = new Set(cfg.agents.map((a) => a.id));
    if (!ids.has(cfg.routing.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routing', 'default'],
        message: `routing.default references a non-existent agent id "${cfg.routing.default}" (available: ${[...ids].join(', ')})`,
      });
    }
    const hostIds = new Set(Object.keys(cfg.hosts ?? {}));
    cfg.agents.forEach((a, i) => {
      if (a.host !== undefined && !hostIds.has(a.host)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agents', i, 'host'],
          message: `agent "${a.id}" names host "${a.host}", which is not under hosts: (available: ${[...hostIds].join(', ') || 'none'})`,
        });
      }
    });
    const platformIds = new Set(Object.keys(cfg.platforms));
    if (cfg.review) checkReview(cfg.review, cfg.agents, ctx);
    cfg.routing.pipeline.forEach((rule, i) => {
      if (!ids.has(rule.use.agent)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routing', 'pipeline', i, 'use', 'agent'],
          message: `pipeline[${i}].use.agent references a non-existent agent id "${rule.use.agent}" (available: ${[...ids].join(', ')})`,
        });
      }
      // when.platform matches the platform INSTANCE id (the platforms map key), not the type.
      if (rule.when.platform !== undefined && !platformIds.has(rule.when.platform)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routing', 'pipeline', i, 'when', 'platform'],
          message: `pipeline[${i}].when.platform references a non-existent platform instance "${rule.when.platform}" (available: ${[...platformIds].join(', ')})`,
        });
      }
    });
    // Cross-field platform rules that discriminatedUnion members can't express (must stay ZodObject).
    for (const [id, p] of Object.entries(cfg.platforms)) {
      if (p.type === 'slack' && p.protocol === 'http' && !p.signing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['platforms', id, 'signing'],
          message: 'slack protocol=http (Events API) requires the signing secret; set signing or use protocol=ws (Socket Mode)',
        });
      }
      if (p.type === 'lark' && p.protocol === 'http' && !p.selfUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['platforms', id, 'selfUrl'],
          message: 'lark protocol=http (webhook subscription) requires a public selfUrl; set selfUrl or use protocol=ws',
        });
      }
    }
    // Two instances cannot share a port, and the failure without this is ugly: whichever binds
    // second throws EADDRINUSE at STARTUP, after the first is already live, so the daemon comes
    // up half-working. It is not a hypothetical pairing either — line, wecom and dingtalk all
    // default to 127.0.0.1:8080, so two webhook platforms enabled together collide out of the box.
    const bound = new Map<string, string>();
    for (const [id, p] of Object.entries(cfg.platforms)) {
      if (!('port' in p) || p.port === undefined) continue;
      const where = `${'host' in p ? p.host : ''}:${p.port}`;
      const taken = bound.get(where);
      if (taken !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['platforms', id, 'port'],
          message: `platform instances "${taken}" and "${id}" both bind ${where}; give one of them a different port`,
        });
      }
      bound.set(where, id);
    }
  });

/** The slim, file-backed config (what setup writes and saveConfig serializes). */
export type UserConfig = z.infer<typeof ConfigSchema>;

/**
 * Harnesses the gateway has no tool switch for, so `review.args` is the only way to turn their
 * tools off for a review. Every other harness gets the gateway's own switches
 * (daemon/review-run.ts acpReviewLaunch), and an `args` there would be a second, conflicting say.
 */
export const REVIEW_ARGS_HARNESSES: ReadonlySet<AgentDef['harness']> = new Set(['custom', 'gemini', 'dsh']);

/** `review:` against the agents it can name: one reviewer, and only the fields that reviewer reads. */
function checkReview(
  review: NonNullable<UserConfig['review']>,
  agents: ReadonlyArray<{ id: string; harness: AgentDef['harness'] }>,
  ctx: z.RefinementCtx
): void {
  const issue = (path: string[], message: string): void =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['review', ...path], message });
  if (review.agent !== undefined && review.api !== undefined) {
    issue([], 'review names both an agent and an api; keep one of them');
    return;
  }
  if (review.api) {
    // The endpoint carries its own model; a second one beside it would leave unclear which is sent.
    if (review.model !== undefined) issue(['model'], 'review.model is for an agent reviewer; with review.api, set review.api.model');
    if (review.args !== undefined) issue(['args'], 'review.args is for an agent reviewer; an api reviewer has no command');
    return;
  }
  if (review.agent === undefined) {
    issue([], 'review needs a reviewer: review.agent (an agent id) or review.api ({url, key, model})');
    return;
  }
  const reviewer = agents.find((a) => a.id === review.agent);
  if (!reviewer) {
    issue(['agent'], `review.agent references a non-existent agent id "${review.agent}" (available: ${agents.map((a) => a.id).join(', ')})`);
    return;
  }
  if (review.args !== undefined && !REVIEW_ARGS_HARNESSES.has(reviewer.harness)) {
    issue(
      ['args'],
      `review.args is for a custom, gemini or dsh reviewer; "${reviewer.id}" is ${reviewer.harness}, whose tools the gateway turns off itself`
    );
  }
}

/** Full runtime config: user fields + the frozen experience defaults. */
export type Config = Omit<UserConfig, 'session' | 'stream'> &
  Omit<Experience, 'session' | 'stream'> & {
    session: Experience['session'] & UserConfig['session'];
    stream: Experience['stream'] & UserConfig['stream'];
  };

/** Merge the frozen experience defaults onto a parsed user config to get the runtime Config. */
export function withExperienceDefaults(u: UserConfig): Config {
  return {
    ...u,
    ...EXPERIENCE,
    // scope comes from the user; guardrails from experience.
    session: { ...EXPERIENCE.session, ...u.session },
    // Same split for delivery: `enabled` is the operator's call, the throttling knobs are not.
    // Without this the spread above would drop the user's value on the floor — a written
    // stream.enabled would work until the next restart and then silently revert.
    stream: { ...EXPERIENCE.stream, ...u.stream },
  };
}

/** All platform instances as (id + entry) objects — what the adapter factory consumes. */
export function platformInstances(cfg: Pick<Config, 'platforms'>): PlatformInstance[] {
  return Object.entries(cfg.platforms).map(([id, p]) => ({ id, ...p }));
}

/** Validate a raw object against the user schema and return the full runtime Config. Throws on invalid. */
export function parseConfig(raw: unknown): Config {
  return withExperienceDefaults(ConfigSchema.parse(raw));
}

/** Get an agent definition by id; undefined if not found. */
export function findAgent(cfg: Config, id: string): AgentDef | undefined {
  return cfg.agents.find((a) => a.id === id);
}

/**
 * Human-readable name for an agent: its harness (`opencode`, `claude`, …) rather than the config id.
 *
 * The id is an operator's shorthand — `oc`, `cc`, whatever is quick to type after a slash — and
 * means nothing to a reader of the conversation. The harness is the thing that actually answered,
 * spelled the way its project spells it. For `harness: custom` the harness name says nothing
 * either, so the id is the best available label.
 */
export function agentDisplayName(def: AgentDef | undefined, fallbackId: string): string {
  if (!def || def.harness === 'custom') return fallbackId;
  return def.harness;
}

/**
 * Whether access is unrestricted: allowFrom is empty, so anyone who can message the bot can
 * trigger an agent (which always runs with full tool access). Surfaced as a non-blocking warning
 * by loadConfig and doctor — fill access.allowFrom to lock it down in shared/public deployments.
 */
export function accessUnrestricted(cfg: Pick<UserConfig, 'access'>): boolean {
  return cfg.access.allowFrom.length === 0;
}
