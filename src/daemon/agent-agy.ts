import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { AgentDef, Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import type {
  AgentFactory,
  AgentSession,
  AgentStreamHandlers,
  AgentUsage,
  ModelSelector,
  ReclaimState,
  RunTurnInput,
} from './agent.js';
import { TurnFailure } from './agent.js';
import type { QuotaPool } from '../types.js';
import type { ConversationStore } from './conversation-store.js';
import {
  buildAgentEnv,
  buildInputPreview,
  killChildProcess,
  prepareRemoteSpawn,
  remoteAgentEnv,
  resolveConversationCwd,
  trimReason,
  truncateToolName,
  watchRemoteLink,
  type AgentChild,
} from './agent-common.js';
import { remoteHosts } from './remote-hosts.js';
import { PreLaunchCancelled, runPreLaunchHook } from './agent-hooks.js';
import {
  AGY_STATUS_FD,
  AGY_STATUS_FD_ENV,
  ensureAgyStatusLine,
  markActivePools,
  parseAgyStatusFrame,
} from './agy-statusline.js';
import { agyContextWindow, agyStepContextTokens, parseAgyCurrentModel, parseAgyUsagePools } from './agy-meters.js';
import { agentHome } from './skills-scan.js';
import {
  AGY_COMMAND,
  fetchAgyModelsFor,
  runAgyCliCommand,
  runAgyCliFor,
  type AgyCliRunner,
  type AgyModelFetcher,
} from './agy-cli.js';
import { agyToolLabel } from './agy-acp.js';

/**
 * The FALLBACK runtime for `agy` — the Google Antigravity CLI — over its own stream-json protocol.
 *
 * Since 2026-11-06 an agy agent is served by the ACP runtime (agent-acp.ts, `agy acp`), which agy
 * gained in 1.5.x; this file serves only an agent whose `env` sets `TALKCODE_AGY_RUNTIME:
 * stream-json` (agy-acp.ts agyRuntime). It stays until every host has run the ACP one, and is then
 * deleted whole — nothing outside agent-factory.ts imports it, the one-shot CLI helpers both
 * runtimes use live in agy-cli.ts, and its conversations are the ACP runtime's too (an id this file
 * stored resumes there through `session/load`, probed on 1.5.1).
 *
 * Why it was written at all: before 1.5, agy had no ACP mode. A community adapter (agy-acp) drove
 * agy through a PTY, read its internal SQLite/protobuf records, and deadlocked permanently on the
 * turn following any tool call — so this file spoke agy's own documented headless protocol directly
 * (antigravity.google/docs/cli/headless) and implemented the same AgentFactory/AgentSession contract
 * as the ACP runtime. Everything above it (TurnRunner / SessionRegistry / StreamBuffer /
 * ToolRenderer) is reused unchanged.
 *
 * Protocol mapping (verified empirically against agy 1.1.22):
 *   one resident child             ↔ an AgentSession (context retained across turns)
 *   {"event":"user","message":…}   ↔ runTurn (one line written to stdin per turn)
 *   step_update.text_delta         ↔ onText (deltas, not cumulative)
 *   step_type:"tool" ACTIVE        ↔ onToolStart
 *   step_type:"tool" DONE          ↔ onToolFinish
 *   text↔tool boundary             ↔ onSegmentBreak
 *   event:"result"                 ↔ turn end (SUCCESS; ERROR fails the turn only when the turn did
 *                                    not end in the agent's reply — see settleErrorResult)
 *   init.conversation_id           ↔ SessionStore entry, replayed via --conversation after a restart
 *   init.model                     ↔ onModel (stored at spawn, replayed at the start of every turn)
 *   agent_response DONE `usage`    ↔ onUsage — input + cache-read tokens, over a window from a
 *                                    table, since agy names none (agy-meters.ts)
 *   one-shot `agy -p=/model`       ↔ onModel when `init` named none   } run beside the turn, settled
 *   one-shot `agy -p=/usage`       ↔ onQuota                          } at its end (agy-meters.ts)
 *   status line, over fd 3         ↔ all three, on an agy older than 1.4.7, which stopped running
 *                                    the status line in `-p` (agy-statusline.ts)
 *   SIGINT                         ↔ abort (agy has no in-band cancel message)
 *
 * agy pushes no command list over the wire, so onAvailableCommands is never called and no native
 * slash commands are registered for this harness. Its own commands are reachable all the same:
 * `agy -p /help` lists them, and runAgyCliCommand answers each with a one-shot process (see
 * buildAgyArgs for why they must never enter the resident session). Skills, unlike those, ARE
 * expanded by the session itself and need nothing from this file — only the flag that used to
 * suppress them being gone.
 *
 * Models: agy has no in-process switch — the model is fixed by `--model=` at spawn. However,
 * available models can be queried via `agy models`, and switching models is performed via a
 * kill-and-respawn strategy: setModel() sets the per-session preference and triggers teardown(),
 * and the next turn respawns with the new `--model=` while resuming conversation history via
 * `--conversation=<id>`. `modelSelector()` returns the available models list, and `setModel()`
 * returns the newly applied model name.
 */

// ───────────────────────── launch command ─────────────────────────

/**
 * Build the agy launch args.
 *
 * Each preset flag below is a workaround for behavior measured against the real CLI:
 *
 * - `--input-format/--output-format stream-json`: the bidirectional resident mode. Requires both.
 * - `--print-timeout`: default is 5m and it KILLS the turn (`status:ERROR, error:"timeout waiting
 *   for response"`), which a long agent task would trip constantly. Set effectively-never here; the
 *   daemon already has its own silence watchdog (`session.turnTimeoutMs`) that bounds hung turns.
 * - `--dangerously-skip-permissions`: matches the daemon's existing stance for every harness — it is
 *   a headless client and auto-approves tool requests; access control is `access.allowFrom` (who may
 *   trigger an agent at all), not per-call prompts. Without it, tools that need approval are
 *   soft-denied silently, so the agent would appear to work while doing nothing.
 * - `--add-dir <cwd>`: agy only treats configured `trustedWorkspaces` as writable; in an untrusted
 *   cwd it silently redirects file writes to its own scratch dir instead of the project. This trusts
 *   exactly the agent's own cwd.
 * - `-p=`: print (headless) mode. The `=` is REQUIRED: agy uses Go flag parsing, so a bare `-p`
 *   swallows the next argument as its prompt value and then errors out.
 *
 * NOT passed, though it used to be: `--disable-slash-commands`. The constraint it was added for is
 * real but much narrower than the flag. Re-probed on agy 1.2.0 (2026-09-17), sending each of these
 * into one resident stream-json session:
 *
 *   `/aa-probe` (a skill under `<home>/.agents/skills`)   → expanded, answered, session alive
 *   `/aa-proj`  (a skill under `<cwd>/.agents/skills`)    → expanded, answered, session alive
 *   `/totally-not-a-real-command-xyz hello`               → reached the model as plain text, alive
 *   `/model`                                              → `status:ERROR` AND process exit code 2
 *
 * So only the commands agy's own CLI answers are fatal, and its error names the way out: "run it as
 * its own --print /model invocation". Those names are listed by `agy -p /help` and enumerated in
 * core/command-translate.ts, which keeps them out of the session and answers them with one-shot
 * processes instead — leaving the flag off, which is what brings agy's skills back.
 *
 * `def.args` is appended AFTER the presets so a user can override any of them — Go's flag parsing is
 * last-wins (verified), e.g. `args: ["--disable-slash-commands"]` gives up skill expansion in
 * exchange for a session that survives a `/model` typed by someone bypassing the gateway's menu.
 * `-p=` stays last so it can't consume a user argument.
 */
export function buildAgyArgs(
  def: AgentDef,
  cwd: string,
  conversationId?: string,
  modelOverride?: string
): string[] {
  const model = modelOverride ?? def.model;
  return [
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--print-timeout=8760h',
    '--dangerously-skip-permissions',
    `--add-dir=${cwd}`,
    ...(model ? [`--model=${model}`] : []),
    // Resume the conversation this session owned before the daemon restarted. A stale/unknown id is
    // non-fatal (agy warns on stderr and starts a fresh conversation), so no existence check is needed.
    ...(conversationId ? [`--conversation=${conversationId}`] : []),
    ...def.args,
    '-p=',
  ];
}

/** An agy child, local or on a remote host: what AgentChild has, plus fd 3 for the status line. */
type AgyChild = AgentChild & { readonly stdio: ReadonlyArray<unknown> };

/**
 * A model as the status line named it, respelled as the id `agy models` lists for it.
 *
 * The status line's `model.id` is not reliably an id: with `--model=` passed it was one
 * (`gemini-3.8-flash-high`, agy 1.2.0), and with agy left on its default it is the display name
 * (`Claude Sonnet 4.6 (Thinking)`, agy 1.2.9). `init` spells the model as an id, and so does the
 * `/model` menu, so a display name is looked up and replaced — otherwise the same model would be
 * printed two ways depending on whether anyone had picked it. Unknown names pass through as-is:
 * a display name in the footer is still better than no model at all.
 */
export function agyModelId(name: string, options: ReadonlyArray<{ value: string; name: string }> = []): string {
  return (options.find((o) => o.value === name) ?? options.find((o) => o.name === name))?.value ?? name;
}

// ───────────────────────────────── factory / session ─────────────────────────────────

export function createAgyAgentFactory(
  cfg: Config,
  socketPath: string,
  store?: ConversationStore,
  modelFetcher: AgyModelFetcher = () => fetchAgyModelsFor(cfg),
  cli: AgyCliRunner = runAgyCliCommand
): AgentFactory {
  const sessions = new Map<string, AgentSession>();
  let cachedModels: Array<{ value: string; name: string }> | undefined;
  let fetchPromise: Promise<void> | undefined;

  /**
   * Run `agy models` now, or join the run already in flight.
   *
   * A non-empty answer replaces the cache. An empty one only fills a cache that was never filled:
   * defaultFetchAgyModels reports every failure as `[]`, so letting `[]` overwrite a known list
   * would turn one network blip during a `/model` into "this harness offers no model selector".
   * A fetcher that throws leaves the cache alone, and ensureModels tries again on the next read.
   */
  function fetchModels(): Promise<void> {
    fetchPromise ??= modelFetcher()
      .then((models) => {
        if (models.length > 0 || cachedModels === undefined) cachedModels = models;
      })
      .catch((e) => {
        console.debug('[agy] failed to fetch models:', e instanceof Error ? e.message : e);
      })
      .finally(() => {
        fetchPromise = undefined;
      });
    return fetchPromise;
  }

  /** Fetch once if nothing is known yet. Fire-and-forget — awaitModels is the waiting form. */
  function ensureModels(): void {
    if (cachedModels === undefined) void fetchModels();
  }

  /**
   * Start the prefetch if needed and wait for whichever attempt is in flight.
   *
   * Read `fetchPromise` AFTER ensureModels so a caller arriving before the first prefetch settles
   * joins it rather than returning immediately on a still-empty cache. Never rejects — fetchModels
   * swallows a failed `agy models`, and a caller's job is then to report "no models offered", not to
   * fail.
   */
  async function awaitModels(): Promise<void> {
    ensureModels();
    await fetchPromise;
  }

  // Eager pre-fetch so the model list is ready when /model is invoked. Only a starting point: the
  // list is Google's and changes under a running daemon, so each `/model` re-fetches it as well
  // (AgentSession.refreshModels).
  ensureModels();

  // Point agy's status line at this daemon's shim, once per distinct home among the agy agents —
  // it is the only channel through which agy reports context usage (see agy-statusline.ts).
  const wiredHomes = new Set<string>();
  /**
   * Wire one home's status line unless it already is, and say whether it is now.
   *
   * Asked again before every spawn rather than only here at construction, because the install
   * deliberately skips a home where agy has never run (agy-statusline.ts `installStatusLine`) — and
   * on a new machine that is the normal state when the daemon comes up: the container starts the
   * daemon, and only afterwards does the operator log agy in, which is what creates the directory.
   * Checked once, that home stayed unwired until the next daemon restart and every agy turn in
   * between reported no context at all. A spawn is rare (one per conversation per child) and the
   * check is an existsSync when there is nothing to do, so asking each time costs nothing.
   */
  function wireStatusLine(home: string): boolean {
    if (wiredHomes.has(home)) return true;
    if (ensureAgyStatusLine(home) === 'skipped') return false;
    wiredHomes.add(home);
    return true;
  }
  // Still done eagerly as well: the operator's own interactive agy reads the same setting, and
  // should find the shim drawing its status line from the moment the daemon is up.
  for (const home of new Set(cfg.agents.filter((a) => a.harness === 'agy' && !a.host).map((a) => agentHome(a)))) {
    wireStatusLine(home);
  }

  /**
   * Said once per daemon, not once per turn: when it fires it fires on every turn of every agy
   * conversation, and the second time adds nothing. Only armed for a home whose status line this
   * daemon wired — with the opt-out set, or no agy config, an agy older than 1.4.7 has no other
   * channel and silence is the expected answer.
   */
  let warnedSilence = false;
  function statusSilence(): void {
    if (warnedSilence) return;
    warnedSilence = true;
    console.warn(
      `[agy] a whole turn finished with no context usage from agy's stream and no status-line frame on ` +
        `fd ${AGY_STATUS_FD}, so the footer has no context numbers. agy 1.4.7 and later report usage in ` +
        'the stream (daemon/agy-meters.ts); older ones only through the status line, which needs ' +
        '`statusLine` in ~/.gemini/antigravity-cli/settings.json to name agy-statusline and the ' +
        'descriptor to reach it (daemon/agy-statusline.ts). If agy was upgraded since, its stream may ' +
        'have moved the numbers again.'
    );
  }

  /**
   * The quota pools, per home: they belong to whoever agy is signed in as there, so every
   * conversation on a home shares one reading and at most one `agy -p=/usage` in flight.
   */
  const quotaByHome = new Map<string, { pools?: QuotaPool[]; at: number; pending?: Promise<void> }>();

  function metersFor(def: AgentDef): AgyMeters {
    // The quota belongs to an account on a machine: the same HOME on two hosts is two accounts.
    const home = def.host ? `${def.host}:${def.env['HOME'] ?? '~'}` : agentHome(def);
    return {
      async currentModel(cwd) {
        const r = await runAgyCliFor(def, 'model', cwd, cli);
        if (!r.ok) {
          console.debug(`[agy] could not ask for the default model (${def.id}):`, r.error);
          return undefined;
        }
        return parseAgyCurrentModel(r.output);
      },
      refreshQuota(cwd) {
        let entry = quotaByHome.get(home);
        if (!entry) quotaByHome.set(home, (entry = { at: 0 }));
        if (entry.pending) return entry.pending;
        // Stamped when the run starts, not when it lands, so a failing one is not retried on every
        // turn either: once a minute is plenty for a footer, and each run is a round trip to Google.
        if (Date.now() - entry.at < QUOTA_REFRESH_MS) return Promise.resolve();
        entry.at = Date.now();
        const e = entry;
        e.pending = runAgyCliFor(def, 'usage', cwd, cli)
          .then((r) => {
            if (!r.ok) {
              console.debug(`[agy] could not read the quota (${def.id}):`, r.error);
              return;
            }
            const pools = parseAgyUsagePools(r.output);
            if (pools) e.pools = pools;
          })
          .finally(() => {
            e.pending = undefined;
          });
        return e.pending;
      },
      quota: () => quotaByHome.get(home)?.pools,
    };
  }

  return {
    getOrCreate(sessionId: string, agentId: string): AgentSession {
      let s = sessions.get(sessionId);
      if (!s) {
        const def = findAgent(cfg, agentId);
        if (!def) throw new Error(`unknown agent id: ${agentId} (check the routing and agents config)`);
        s = createAgySession(
          def,
          socketPath,
          sessionId,
          store,
          () => {
            ensureModels();
            return cachedModels;
          },
          awaitModels,
          fetchModels,
          () => (wireStatusLine(agentHome(def)) ? statusSilence : undefined),
          metersFor(def)
        );
        sessions.set(sessionId, s);
      }
      return s;
    },
    peek(sessionId: string): AgentSession | undefined {
      return sessions.get(sessionId);
    },
    dispose(sessionId: string): void {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.dispose();
      sessions.delete(sessionId);
    },
  };
}

/** Max wait for the child's `init` event after spawn; on timeout treat the spawn as failed (ENOENT etc.). */
const START_TIMEOUT_MS = 30_000;

/** Longest unterminated line kept from the status pipe. A real frame is well under 200 characters. */
const MAX_STATUS_LINE_CHARS = 64 * 1024;

/**
 * How long a finished turn waits for the status line's post-turn frame (see settleUsage). It came
 * ~260ms after `result` when measured, on a ~300ms tick; this is several ticks of headroom, and
 * the footer is the only thing waiting.
 */
const USAGE_SETTLE_MS = 1_500;

/**
 * How long a finished turn waits for the one-shots started beside it (`/model`, `/usage`) before
 * building its footer without them. Each took ~3.5s on agy 1.4.7, and most turns run longer than
 * that, so the wait is usually already over; the bound is for a one-shot stuck on the network.
 */
const SIDE_QUERY_SETTLE_MS = 5_000;

/** How old a quota reading may get before a turn asks `agy -p=/usage` again. */
const QUOTA_REFRESH_MS = 60_000;

/** The one-shot side queries a session runs beside its turns (see agy-meters.ts). */
interface AgyMeters {
  /** agy's current default model, as an id — for a child whose `init` named none. Never rejects. */
  currentModel(cwd: string): Promise<string | undefined>;
  /** Re-read the quota pools, unless a recent reading or one in flight makes that pointless. */
  refreshQuota(cwd: string): Promise<void>;
  /** The latest quota reading for this agent's home. */
  quota(): QuotaPool[] | undefined;
}

function createAgySession(
  def: AgentDef,
  socketPath: string,
  /** The conversation this agent instance serves (store key half; the other half is def.id). */
  conversationId: string,
  store?: ConversationStore,
  getModels?: () => Array<{ value: string; name: string }> | undefined,
  /**
   * Await the factory's model prefetch. Distinct from getModels because `/model` needs a list
   * BEFORE the prefetch settles, and the prefetch is fire-and-forget at factory construction —
   * a `/model` in the first moments after a daemon start would otherwise read `undefined` and be
   * told the harness has no model selector, which is simply untrue.
   */
  awaitModels?: () => Promise<void>,
  /** Re-run `agy models` into the factory's cache (see AgentSession.refreshModels). */
  refreshModels?: () => Promise<void>,
  /**
   * Make sure the status line is wired for this agent's home, and get back what to call when a
   * turn finishes without a single frame — undefined when no frames are expected (the opt-out, or
   * agy still has no config there), which is what keeps a deliberate opt-out quiet. Asked at every
   * spawn; see the factory's `wireStatusLine` for why not once.
   */
  statusLineAtSpawn?: () => (() => void) | undefined,
  /** Where the model and quota come from on an agy that runs no status line in `-p` (1.4.7+). */
  meters?: AgyMeters
): AgentSession {
  /** What statusLineAtSpawn answered for the current child. */
  let onStatusSilence: (() => void) | undefined;
  /**
   * The directory this session's child runs in — and, through `--add-dir`, the one it is allowed to
   * write to. Resolved per SPAWN rather than once per session so a `/cd` that disposed the child
   * takes effect on the next turn (see resolveConversationCwd); `let`, and reassigned in
   * ensureStarted, for exactly that reason.
   */
  let cwd = resolveConversationCwd(def, conversationId, store);

  /** Lazily-started child; established on the first turn, killed on dispose. */
  let proc: AgyChild | undefined;
  /** Set once the child's `init` event arrived — the sole readiness signal (mirrors ACP's `active`). */
  let ready = false;
  /**
   * agy's conversation id for this session, as last seen on the wire. Only used to avoid redundant
   * store writes; the value that actually gets replayed is read back from the store at spawn
   * (so a /new that clears the store is honored even if this child already knew an id).
   */
  let lastSeenConversationId: string | undefined;
  /**
   * The model agy named for this child (`init.model`), in agy's own spelling.
   *
   * Held on the session instead of being pushed straight to the handlers, for two reasons: `init`
   * arrives inside ensureStarted, before the turn's sink exists, and the footer reads the model off
   * a PER-TURN record (TurnRunner's TurnRef) — so a single emit at spawn would name the model on
   * the first turn's footer and on no other. Stored here, replayed at the top of every turn.
   *
   * Often absent: agy 1.2.9 puts `model` in `init` only when `--model=` asked for one, so a
   * conversation left on agy's default is named by the status line instead (`statusModel`).
   */
  let lastSeenModel: string | undefined;
  /**
   * What this child's status line last reported (agy-statusline.ts), off the fd-3 pipe.
   *
   * The model is per CHILD, cleared on respawn with lastSeenModel: a respawn is how the model
   * changes, and the old child's name must not outlive it. Usage is per CONVERSATION and survives
   * a respawn, because `--conversation=` resumes the same window — so a turn that dies before the
   * new child's first tick still reports the last real reading rather than none.
   */
  let statusModel: string | undefined;
  let statusUsage: AgentUsage | undefined;
  /**
   * The quota pools the status line last reported. Per CONVERSATION like usage, and for a stronger
   * reason: a pool belongs to the account, so a respawn changes nothing about it.
   */
  let statusQuota: QuotaPool[] | undefined;
  /**
   * Tokens in context as agy's stream last reported them (agy-meters.ts, agy 1.4.7+). Per
   * CONVERSATION, like statusUsage and for the same reason. Kept as a count rather than a usage,
   * because the window it is shown against depends on a model that may not be known yet.
   */
  let streamTokens: number | undefined;
  /** Readings this child's stream gave. Any at all makes the status line's settle wait moot. */
  let streamReadings = 0;
  /**
   * The default model `agy -p=/model` named for this child, when its `init` named none. Per CHILD,
   * like lastSeenModel: the default is read at spawn, and a later one is a later child's.
   */
  let cliModel: string | undefined;
  /** The `/model` lookup started for this child, for a turn's end to wait on (bounded). */
  let pendingModel: Promise<void> | undefined;
  /** The `/usage` refresh the running turn started, likewise. */
  let pendingQuota: Promise<void> | undefined;
  /** The model last logged as having no known window, so the log says it once, not per turn. */
  let windowUnknownFor: string | undefined;
  /**
   * The running turn's handlers, so a frame that arrives mid-turn can be passed on as it lands
   * (see handleStatusLine). Undefined between turns.
   */
  let liveHandlers: AgentStreamHandlers | undefined;
  /** Frames this child's status line delivered; zero after a whole turn is the "channel broke" signal. */
  let statusFrames = 0;
  /** A settle wait on this child already ran its full bound without a frame; don't pay it every turn. */
  let settledInVain = false;
  /** Woken by every status frame (and by teardown), for settleUsage. */
  const statusWaiters: Array<() => void> = [];
  /**
   * Per-conversation model preference set via setModel() (/model command or menu).
   * Kept in the session closure across child respawns, and seeded from the conversation's record
   * like the ACP runtime's modelPreference — so the first child after a restart, `/new` or `/cd` is
   * spawned on the chosen model rather than started on the default and respawned by the first turn.
   */
  let modelPreference: string | undefined = store?.conversationChoice?.(conversationId, def.id, 'model');
  /** Intentional-abort flag: set by abort()/dispose() so a killed turn resolves silently. */
  let aborting = false;
  /**
   * Cancels the preLaunch hook while one runs ahead of a spawn (see agent-hooks.ts) — from teardown,
   * which both dispose() and abort() go through. Before the child exists there is nothing else for
   * them to kill, and a hook left running would spawn agy for a session already stopped or gone.
   */
  let launchHook: AbortController | undefined;

  /** The in-flight turn's sink for parsed events; undefined between turns. */
  let currentTurn: TurnSink | undefined;

  /** Resolvers waiting for the child's `init` event (only ever 0 or 1, but kept as a list for clarity). */
  const initWaiters: Array<{ res: () => void; rej: (e: Error) => void }> = [];

  function resetHandles(): void {
    proc = undefined;
    ready = false;
    lastSeenModel = undefined;
    statusModel = undefined;
    statusFrames = 0;
    settledInVain = false;
    streamReadings = 0;
    cliModel = undefined;
    pendingModel = undefined;
  }

  /**
   * The model to name for this child: `init`'s when agy gave one (it is what `--model=` resolved
   * to), else the status line's, respelled as an id, else what `agy -p=/model` said the default
   * is. Undefined only before the child has said any — the caller falls back to what was
   * configured or picked.
   */
  function servingModel(): string | undefined {
    return lastSeenModel ?? (statusModel ? agyModelId(statusModel, getModels?.()) : undefined) ?? cliModel;
  }

  /**
   * The context reading to report. The stream's, when this conversation has one, over the window
   * agy-meters.ts knows for the serving model — and then nothing else, even with no window known:
   * a status-line reading from before would be a different moment presented as this one. The
   * status line's otherwise, which is all an agy older than 1.4.7 gives.
   */
  function contextUsage(): AgentUsage | undefined {
    if (streamTokens === undefined) return statusUsage;
    const model = servingModel();
    const size = agyContextWindow(model);
    if (size) return { used: streamTokens, size };
    if (model && model !== windowUnknownFor) {
      windowUnknownFor = model;
      console.log(`[agy] no known context window for ${model}, so its footer shows no context numbers (see daemon/agy-meters.ts)`);
    }
    return undefined;
  }

  /** A reading off the stream (translateAgyEvent), passed on as it lands — see handleStatusLine. */
  function onStreamTokens(tokens: number): void {
    streamTokens = tokens;
    streamReadings++;
    const usage = contextUsage();
    if (usage) liveHandlers?.onUsage?.(usage);
  }

  /** The quota to report: the status line's when it sent one, else the last `agy -p=/usage`. */
  function quotaReading(): QuotaPool[] | undefined {
    return statusQuota ?? meters?.quota();
  }

  /**
   * Stop reading a child's status pipe. Needed explicitly because agy leaves fd 3 open in every
   * process it starts, the agent's own commands included: a dev server the agent backgrounded keeps
   * the write end alive after agy itself is gone, so the read end would otherwise never see EOF and
   * its handle would sit open for as long as that process lives.
   */
  function closeStatusPipe(child: AgyChild): void {
    const pipe = child.stdio[AGY_STATUS_FD];
    if (pipe instanceof Readable) pipe.destroy();
  }

  /** One line off a child's status pipe. Frames from a superseded child are dropped like its stdout. */
  function handleStatusLine(line: string, from: AgyChild): void {
    if (proc !== from) return;
    const status = parseAgyStatusFrame(line);
    if (!status) {
      console.debug('[agy] ignoring a status-pipe line that is not a frame:', line.slice(0, 120));
      return;
    }
    statusFrames++;
    if (status.usage) statusUsage = status.usage;
    if (status.model) statusModel = status.model;
    if (status.quota) statusQuota = status.quota;
    // Passed on as it lands, for a surface that shows the numbers while the turn runs (the web UI's
    // status bar) — the footer is unaffected, because it is built from the settled reading the
    // turn's `finally` reports, which overwrites these. A frame here can be one model step stale
    // (see settleUsage); for a live readout that is still the newest thing known.
    if (liveHandlers) {
      // Not when the stream reports usage: its reading is exact, and this one is a step behind.
      if (status.usage && streamTokens === undefined) liveHandlers.onUsage?.(status.usage);
      if (status.quota) liveHandlers.onQuota?.(markActivePools(status.quota, servingModel()));
    }
    wakeStatusWaiters();
  }

  function wakeStatusWaiters(): void {
    for (const wake of statusWaiters.splice(0)) wake();
  }

  /**
   * Context numbers, quota and — when `init` named none — the model, read at the end of the turn
   * they describe (on success, once settleUsage and settleSideQueries have had their chance). The
   * footer is built after this returns. Called from the turn's `finally`, because a turn that
   * failed still consumed the window, and the footer of the message reporting the failure should
   * say so.
   */
  function reportSettled(handlers: AgentStreamHandlers): void {
    const usage = contextUsage();
    if (usage) handlers.onUsage?.(usage);
    const model = servingModel();
    if (model) handlers.onModel?.(model);
    const quota = quotaReading();
    if (quota) handlers.onQuota?.(markActivePools(quota, model));
  }

  /**
   * Wait, bounded, for the one-shots started beside this turn, so its footer can name the model and
   * the quota they fetch. Usually over before it starts (see SIDE_QUERY_SETTLE_MS); on a quick
   * first turn it is the difference between a footer that names the model and one that does not.
   */
  async function settleSideQueries(): Promise<void> {
    const pending = [pendingModel, pendingQuota].filter((p): p is Promise<void> => p !== undefined);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SIDE_QUERY_SETTLE_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Ask the CLI for agy's default model, for a child whose `init` named none. Beside the turn
   * rather than before it: the answer takes seconds, and only the footer needs it. Skipped when the
   * status line is already reporting (an agy older than 1.4.7), which names the model itself.
   */
  function lookUpDefaultModel(child: AgyChild): void {
    if (!meters || lastSeenModel || statusFrames > 0) return;
    pendingModel = meters
      .currentModel(cwd)
      .then((model) => {
        if (proc !== child || !model) return;
        cliModel = model;
        // A turn is likely running by now; the strip can name the model before the turn ends.
        const serving = servingModel();
        if (serving) liveHandlers?.onModel?.(serving);
        const usage = contextUsage();
        if (usage) liveHandlers?.onUsage?.(usage);
      })
      .catch(() => {});
  }

  /** Start the turn's quota refresh, and pass the reading on when it lands. */
  function refreshQuota(): void {
    if (!meters || statusQuota) return;
    pendingQuota = meters
      .refreshQuota(cwd)
      .then(() => {
        const quota = meters.quota();
        if (quota) liveHandlers?.onQuota?.(markActivePools(quota, servingModel()));
      })
      .catch(() => {});
  }

  /**
   * Wait for the status line to report the turn that just ended.
   *
   * agy refreshes the snapshot after each model step, and the last step's refresh lands after the
   * turn is over. Measured on 1.2.9 (2026-09-23), twice: the frame carrying a turn's final count
   * arrived ~260-270ms AFTER `result`, and every frame before it still read the count as of the
   * previous step (`0` on a conversation's first turn, the pre-tool count in a turn that ran a
   * tool). Read at `result`, the footer was always one step stale. The file-based channel this
   * replaced had the same lag and no cheap way to wait for a write; a pipe can wait for the line.
   *
   * `atResult` is the reading when `result` arrived, and the wait ends on the first frame that
   * moves it — not on the first frame, because a tick already in flight at `result` carries the
   * stale count. Bounded by USAGE_SETTLE_MS, because agy only ticks on change: if the refresh beat
   * `result` here, nothing further comes, and the footer must not wait on it forever.
   *
   * Not waited at all when nothing can come: a child that has never reported, on a home whose
   * status line this daemon did not wire (`onStatusSilence` unset), or that already sat out a full
   * bound in vain — once is the diagnosis (onStatusSilence), every turn would be a tax. Nor when the
   * stream itself reported usage (agy 1.4.7+): its last reading lands before `result`, final, and
   * that agy runs no status line in `-p` at all.
   */
  async function settleUsage(atResult: AgentUsage | undefined): Promise<void> {
    if (streamReadings > 0) return;
    if (statusFrames === 0 && (!onStatusSilence || settledInVain)) return;
    const deadline = Date.now() + USAGE_SETTLE_MS;
    while (!aborting && proc && statusUsage?.used === atResult?.used) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        statusWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Attach the line reader to a freshly spawned child's status pipe. */
  function readStatusPipe(child: AgyChild): void {
    const pipe = child.stdio[AGY_STATUS_FD];
    // A socket whenever the spawn asked for a fourth 'pipe'. Checked rather than cast, so a change in
    // how it is opened costs the footer its numbers (and says so, via onStatusSilence) — not the spawn.
    if (!(pipe instanceof Readable)) return;
    pipe.setEncoding('utf8');
    let buf = '';
    pipe.on('data', (chunk: string) => {
      buf = consumeNdJsonLines(buf + chunk, (line) => handleStatusLine(line, child));
      // Anything agy started can write here, so a line that never ends must not grow without bound.
      if (buf.length > MAX_STATUS_LINE_CHARS) buf = '';
    });
    // Required, not tidiness: an 'error' with no listener is thrown, and this one would take the
    // whole daemon down over a footer.
    pipe.on('error', (e) => console.debug(`[agy] status pipe error (${def.id}):`, e.message));
  }

  /**
   * Detach the current child from this session and settle any in-flight turn.
   *
   * Shared by dispose() and abort() because both need the same three things in the same order:
   * stop attributing this child's output to the session, unblock the waiting turn (a killed agy
   * ends its stream without a normal `result`, so nothing else would settle it), and terminate the
   * process. Detaching synchronously — rather than waiting for the async 'exit' — is what keeps a
   * dying agy's trailing `result` ("stream input cancelled") from failing the NEXT turn.
   *
   * `reason` settles the pending turn; runTurn swallows it because `aborting` is set by both callers.
   */
  function teardown(reason: string): void {
    aborting = true;
    launchHook?.abort();
    const child = proc;
    const pending = currentTurn;
    resetHandles();
    currentTurn = undefined;
    wakeStatusWaiters(); // a settle wait on this child has nothing left to wait for
    if (child) {
      closeStatusPipe(child);
      interruptChild(child);
    }
    pending?.fail(new Error(reason));
  }

  /** Spawn the child and wait for its `init` event (which agy emits before reading any stdin). */
  async function ensureStarted(sessionToken: string): Promise<void> {
    if (ready) return;

    // Re-read the conversation's directory: a `/cd` since the last child disposed it, and this is
    // the only point at which the new one can be honored (agy takes its cwd at spawn).
    cwd = resolveConversationCwd(def, conversationId, store);
    // An agy on another machine: reach it and settle the directory there first (see agent-acp.ts).
    const host = remoteHosts.hostFor(def);
    if (host) cwd = (await prepareRemoteSpawn(def, host, cwd)).cwd;
    // The operator's preLaunch hook, before anything of the child's exists: a failure throws from
    // here with nothing to roll back. Only runTurn calls this, one turn at a time, so unlike the ACP
    // runtime there is no concurrent caller to share the run with.
    if (def.hooks?.preLaunch) {
      const hook = new AbortController();
      launchHook = hook;
      try {
        await runPreLaunchHook(def, { cwd, signal: hook.signal });
      } finally {
        if (launchHook === hook) launchHook = undefined;
      }
    }
    // Before the spawn, because agy reads its settings at startup: a status line wired after this
    // line would not be drawn by this child at all. Not on a remote host: the status line is a
    // script of THIS install (agy-statusline.ts), and an agy new enough to be worth driving from a
    // gateway (1.4.7+) reports in its stream anyway.
    onStatusSilence = host ? undefined : statusLineAtSpawn?.();

    // Replay this session's prior conversation so a daemon restart keeps the context (the ACP
    // runtime's session/load equivalent). agy owns the history on its own disk; we only remember which.
    // Keyed by (conversation, agent) so agy resumes ITS conversation here, not one belonging to
    // another agent that also answered in this topic.
    //
    // The fourth pipe is the status line's way back (agy-statusline.ts). The cast only restores what
    // the three-`pipe` overload would have inferred: @types/node types a longer stdio array as a
    // bare ChildProcess with nullable streams, and fds 0-2 here are pipes all the same.
    const args = buildAgyArgs(def, cwd, store?.agentSession(conversationId, def.id), modelPreference);
    const child: AgyChild = host
      ? host.spawn(AGY_COMMAND, args, { cwd, env: remoteAgentEnv(def, sessionToken) })
      : (spawn(AGY_COMMAND, args, {
          cwd,
          env: { ...buildAgentEnv(def, sessionToken, socketPath), [AGY_STATUS_FD_ENV]: String(AGY_STATUS_FD) },
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        }) as unknown as AgyChild);
    // Record immediately so the 'exit' callback and start-failure rollback can match by reference.
    proc = child;
    // agy sends diagnostics (auth notices, permission notes, conversation warnings) to stderr.
    child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    child.on('error', (e) => console.error(`[agy] child process error (${def.id}):`, e.message));
    child.stdout.setEncoding('utf8');
    // The line buffer is per-child, and every frame is tagged with the child that produced it: after
    // an abort (SIGINT) the dying process still emits a trailing `result` (status ERROR, "stream
    // input cancelled"), which must never be attributed to the next turn's child.
    let buf = '';
    child.stdout.on('data', (chunk: string) => {
      buf = consumeNdJsonLines(buf + chunk, (line) => handleLine(line, child));
    });
    readStatusPipe(child);
    child.on('exit', (code, signal) => onChildExit(child, code, signal));

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((res, rej) => {
          initWaiters.push({ res, rej });
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TurnFailure(startupTimeoutMessage(def.id), 'startup')), START_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // Clear the child + handles so the next turn can retry, and surface a readable reason.
      teardown('agent startup failed');
      aborting = false; // a start failure is a real error, not an intentional abort
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      initWaiters.length = 0;
    }
    lookUpDefaultModel(child);
  }

  /**
   * On child crash/kill: clear handles so the next turn rebuilds a fresh child (self-healing), and
   * fail any in-flight turn — the stream ended without a `result`, so nothing else would settle it.
   * Guarded by reference so a stale 'exit' can't clobber a post-dispose replacement child.
   */
  function onChildExit(child: AgyChild, code: number | null, signal: string | null): void {
    if (proc !== child) return;
    console.debug(`[agy] child process exited (${def.id}): code=${code} signal=${signal}; will respawn on the next turn`);
    closeStatusPipe(child);
    const pending = currentTurn;
    currentTurn = undefined;
    resetHandles();
    pending?.fail(
      new Error(`agy exited unexpectedly (code=${code} signal=${signal}) — see the log above for its stderr output`)
    );
  }

  /**
   * Route one parsed NDJSON frame: `init` completes startup, everything else feeds the active turn.
   *
   * `from` is the child that emitted the line. Frames from a superseded child are dropped: a killed
   * agy still flushes a trailing `result` before exiting, and feeding that to whatever turn is
   * current would fail an unrelated turn (or, after an abort, the very next one).
   */
  function handleLine(line: string, from: AgyChild): void {
    if (proc !== from) {
      console.debug('[agy] dropping a frame from a superseded child:', line.slice(0, 120));
      return;
    }

    let msg: AgyEvent;
    try {
      msg = JSON.parse(line) as AgyEvent;
    } catch {
      // Not our protocol (a stray banner/log line on stdout). Ignore rather than fail the turn.
      console.debug('[agy] ignoring non-JSON stdout line:', line.slice(0, 200));
      return;
    }

    if (msg.event === 'init') {
      rememberConversation(msg.init?.conversation_id ?? msg.conversation_id);
      // agy's own resolved id, when it gives one. It used to give one always — on 1.1.22 this was
      // the only place an unconfigured default was ever named — but on 1.2.9 (2026-09-23) `init`
      // carries `model` only when `--model=` was passed, and the default is named by the status
      // line alone (see servingModel).
      if (msg.init?.model) lastSeenModel = msg.init.model;
      ready = true;
      for (const w of initWaiters) w.res();
      initWaiters.length = 0;
      return;
    }

    // agy repeats conversation_id on later events; adopt it from there. That fallback stopped
    // being a fallback: on 1.1.22 the id came with `init`, and on 1.2.0 `init` carries none at all
    // and the first one to name it is the turn's own `step_update`. Both shapes work because this
    // reads whichever arrives — worth knowing before "simplifying" either branch away, since a
    // session with no recorded id resumes blank after a restart and reports no context usage.
    rememberConversation(msg.step_update?.conversation_id ?? msg.result?.conversation_id ?? msg.conversation_id);

    if (!currentTurn) {
      // Never silently: the ACP runtime forwards out-of-turn output to the conversation as a
      // follow-up message (see FollowUpSink), and agy has no such path yet because it has never
      // been seen to emit anything after `result`. If this line ever shows up in the logs, that
      // assumption is wrong and agy needs the same wiring.
      console.debug(`[agy] dropping a "${msg.event}" event that arrived outside a turn`);
      return;
    }
    currentTurn.feed(msg);
  }

  /** Persist the conversation id for post-restart `--conversation` resume (write-through on change). */
  function rememberConversation(id?: string): void {
    if (!id || id === lastSeenConversationId) return;
    lastSeenConversationId = id;
    store?.setAgentSession(conversationId, def.id, id);
  }

  return {
    conversationId,

    async runTurn(input: RunTurnInput, handlers: AgentStreamHandlers): Promise<void> {
      aborting = false;
      if (input.model && input.model !== (modelPreference ?? def.model)) {
        modelPreference = input.model;
        if (proc) teardown('model changed');
      }
      try {
        await ensureStarted(input.sessionToken);
      } catch (err) {
        // Stopped (or disposed) while the preLaunch hook ran: nothing failed, so nothing to report.
        if (err instanceof PreLaunchCancelled) return;
        throw err;
      }
      // Nothing renders from this; it only records which model to name in this turn's footer.
      const known = servingModel();
      if (known) handlers.onModel?.(known);

      const state: AgyTurnState = {
        handlers,
        agentId: def.id,
        lastSegment: 'none',
        endsInReply: false,
        sawErrorStep: false,
        toolLedger: new Map(),
        toolIndexSeq: 0,
        onContextTokens: onStreamTokens,
      };

      // Install the sink BEFORE writing the prompt, so no event can arrive unclaimed.
      liveHandlers = handlers;
      // An agy on another machine keeps working through a lost connection; say so if one lasts.
      const unwatchLink = watchRemoteLink(remoteHosts.hostFor(def), handlers, () => {});
      pendingQuota = undefined;
      refreshQuota();
      const done = new Promise<void>((resolve, reject) => {
        currentTurn = makeTurnSink(state, {
          done: () => {
            currentTurn = undefined;
            resolve();
          },
          failed: (err) => {
            currentTurn = undefined;
            reject(err);
          },
        });
      });

      // One NDJSON line = one turn. Only `text` content blocks are permitted by the protocol; any
      // other shape terminates agy's session, so the merged prompt is always sent as a plain string.
      // It is what the user sent and nothing of the gateway's. agy also gets no native tools — it does
      // not speak ACP, and its MCP servers live in a global config the gateway will not edit — so what
      // it can do here reaches it through the bundled skill alone (see daemon/skill-link.ts).
      // For the same reason a picture stays a path here: the prompt already names each one by its
      // saved file, so dropping `input.images` loses nothing agy could have used.
      if (input.images?.length) {
        console.log(`[agy] ${conversationId}: stream-json takes text only; ${input.images.length} picture(s) go by path only`);
      }
      proc!.stdin.write(JSON.stringify({ event: 'user', message: { content: input.prompt } }) + '\n');

      try {
        await done;
        await settleUsage(statusUsage);
        await settleSideQueries();
        // Asked only after a successful turn and its settle wait: by then the status line has had
        // every chance to tick — it does from the moment agy starts, before any prompt — so silence
        // is a finding, where after a turn that failed fast it would only be a race. Silence on fd 3
        // alone is not one: agy 1.4.7 runs no status line in `-p` and reports in the stream instead.
        if (statusFrames === 0 && streamReadings === 0) {
          settledInVain = true;
          onStatusSilence?.();
        }
      } catch (err) {
        if (aborting) return; // intentional abort/dispose is not an error
        throw err;
      } finally {
        unwatchLink();
        liveHandlers = undefined;
        reportSettled(handlers);
      }
    },

    abort(): void {
      // agy has no in-band cancel message, so interrupt the process itself (verified: SIGINT ends
      // the run). The next turn respawns and resumes the same conversation via --conversation, so
      // context survives an interrupt.
      teardown('turn aborted');
    },

    async ensureSession(): Promise<void> {
      // No child needed: agy's model list comes from a separate `agy models` call, not from the
      // session. So "make a selector available" means "wait for the prefetch", and deliberately
      // NOT "spawn a child" — starting one here would cost a process and teach nothing.
      await awaitModels?.();
    },

    async refreshModels(): Promise<void> {
      await refreshModels?.();
    },

    modelSelector(): ModelSelector | undefined {
      const options = getModels?.();
      if (!options || options.length === 0) return undefined;
      return {
        current: servingModel() ?? modelPreference ?? def.model,
        options,
      };
    },

    async setModel(value: string): Promise<string> {
      modelPreference = value;
      // Kill the current child. The next runTurn -> ensureStarted spawns a new one with
      // --model=<value> --conversation=<id>. Context survives via --conversation.
      teardown('model switch');
      return value;
    },

    reclaimState(): ReclaimState {
      // `ready` (the child's `init` arrived) is this runtime's readiness signal, so it is also the
      // honest test for "there is a live child worth reclaiming".
      if (!proc || !ready) return 'no-child';
      // agy replays a conversation with `--conversation=<id>` (buildAgyArgs), and the id is written
      // to the store as soon as `init` names it — so a child that is ready has, in practice, already
      // recorded one. Asked rather than assumed: without an id, a respawn would start agy blank.
      return store?.agentSession(conversationId, def.id) ? 'resumable' : 'unresumable';
    },

    dispose(): void {
      teardown('agent session disposed');
    },
  };
}

// ───────────────────────── event → handlers translation (core) ─────────────────────────

/** Readable startup-failure hint (the two realistic causes: not on PATH, or never signed in). */
function startupTimeoutMessage(agentId: string): string {
  return `agent "${agentId}" startup timed out (${START_TIMEOUT_MS}ms). Make sure \`${AGY_COMMAND}\` is executable on PATH (run \`agy install\`) and logged in (run \`agy\` once interactively to sign in).`;
}

/**
 * Interrupt a detached child: SIGINT (agy's own cancel path), backed by the shared SIGTERM→SIGKILL
 * escalation so a wedged process that ignores SIGINT can't linger — once detached, nothing else
 * tracks its pid.
 */
function interruptChild(child: AgyChild): void {
  try {
    child.kill('SIGINT');
  } catch (e) {
    console.debug('[agy] SIGINT on abort failed:', e instanceof Error ? e.message : e);
  }
  killChildProcess(child);
}

/**
 * Emit every complete newline-terminated frame in `buf` and return the trailing partial line.
 * A stdout chunk can split mid-frame (and can carry several frames), so the remainder must be
 * carried over to the next chunk rather than parsed as-is.
 */
export function consumeNdJsonLines(buf: string, onLine: (line: string) => void): string {
  let rest = buf;
  let nl: number;
  while ((nl = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (line) onLine(line);
  }
  return rest;
}

/**
 * Build the per-turn event sink: translate each frame, and settle the turn on `result` (or on a
 * translation error / child death). Kept separate from runTurn so the promise wiring stays readable
 * and the ledger flush lives next to the code that decides a turn is over.
 */
function makeTurnSink(
  state: AgyTurnState,
  settle: { done: () => void; failed: (err: Error) => void }
): TurnSink {
  return {
    feed: (msg) => {
      try {
        if (translateAgyEvent(msg, state)) {
          flushPendingTools(state);
          settle.done();
        }
      } catch (err) {
        settle.failed(err instanceof Error ? err : new Error(String(err)));
      }
    },
    fail: settle.failed,
  };
}

/** One frame of agy's stream-json output (only the fields this runtime reads). */
export interface AgyEvent {
  event?: string;
  conversation_id?: string;
  init?: { conversation_id?: string; cwd?: string; model?: string; permission_mode?: string };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    /** 'ACTIVE' while running, 'DONE' when that step finished. */
    state?: string;
    /** 'user_input' | 'agent_response' | 'tool' | 'error_message' | 'system_message' | 'checkpoint' | … */
    step_type?: string;
    tool_name?: string;
    /** Incremental text (NOT cumulative). */
    text_delta?: string;
    duration_seconds?: number;
    tool_info?: {
      name?: string;
      parameters?: unknown;
      output?: unknown;
      error?: { type?: string; message?: string };
    };
    /** That model call's token counts, on an `agent_response` DONE frame (agy 1.4.7; agy-meters.ts). */
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; total_tokens?: number };
  };
  result?: {
    conversation_id?: string;
    /** SUCCESS | ERROR | CANCELED | INTERRUPTED | INVALID | WAITING | RUNNING */
    status?: string;
    response?: string;
    error?: string;
  };
}

export interface AgyTurnState {
  handlers: AgentStreamHandlers;
  /** The agent's config id, for the notice a recovered error gets (see settleErrorResult). */
  agentId: string;
  /** 'none' start / 'text' streaming body / 'tool' just had a tool. Drives onSegmentBreak. */
  lastSegment: 'none' | 'text' | 'tool';
  /**
   * Whether the latest thing this turn produced is the agent's own reply text — set by visible text,
   * cleared by a tool or an `error_message` step. Unlike `lastSegment`, an error step clears it,
   * because what it answers is "did the reply come out AFTER whatever went wrong". It is what
   * decides whether a `status:ERROR` result is believed.
   */
  endsInReply: boolean;
  /** An `error_message` step arrived during this turn: agy hit an error and retried. */
  sawErrorStep: boolean;
  /** step_index → evolving tool state (ACTIVE then DONE arrive as separate frames). */
  toolLedger: Map<number, AgyToolRec>;
  toolIndexSeq: number;
  /**
   * Tokens in context, from a finished model step's `usage` (agy-meters.ts). A callback rather
   * than a handler call: the session can make a usage of the count only once it knows the window
   * to show it against, and that depends on a model it may still be asking about.
   */
  onContextTokens?: (tokens: number) => void;
}

interface AgyToolRec {
  /** Bubble index handed to the renderer (its own sequence, independent of agy's step_index). */
  index: number;
  name: string;
  started: boolean;
  finished: boolean;
}

/**
 * Translate one agy event into handler calls.
 * Returns true when the event ends the turn (`result`), so the caller can resolve runTurn.
 * Throws when the turn failed, so the upper layer renders ❌ with a readable reason.
 */
export function translateAgyEvent(msg: AgyEvent, st: AgyTurnState): boolean {
  if (msg.event === 'result') {
    const status = msg.result?.status ?? 'SUCCESS';
    if (status === 'ERROR' && st.endsInReply) {
      settleErrorResult(msg.result?.error, st);
      return true;
    }
    // CANCELED/INTERRUPTED are our own doing (abort); the session layer treats them as non-errors and
    // runTurn's `aborting` check swallows them, so surfacing them as errors here is still correct.
    if (status !== 'SUCCESS') {
      // agy reports a provider's refusal or outage here and nothing finer, so `provider` is as close
      // as the gateway can name it — hooks.turnFailed can still choose to continue after it.
      throw new TurnFailure(`agy turn ended with status ${status}${msg.result?.error ? `: ${msg.result.error}` : ''}`, 'provider');
    }
    return true;
  }

  if (msg.event !== 'step_update' || !msg.step_update) return false;
  const s = msg.step_update;

  if (s.step_type === 'tool') {
    ingestToolStep(s, st);
    st.endsInReply = false;
  } else if (s.step_type === 'error_message') {
    // The frame names no reason (agy 1.3.2 sends only the step's index and state; the text reaches
    // the wire only inside `result.error`), so it renders nothing — it only moves the line that
    // decides whether the turn's reply came out after the trouble.
    st.sawErrorStep = true;
    st.endsInReply = false;
  } else if (s.step_type === 'agent_response') {
    ingestResponseStep(s, st);
  }
  return false;
}

/** Model step: its text (as it streams), and once DONE, its token counts. */
function ingestResponseStep(s: NonNullable<AgyEvent['step_update']>, st: AgyTurnState): void {
  // Agent text: text_delta is incremental, so push it straight through.
  // Only agent_response carries display text; user_input/checkpoint frames are bookkeeping.
  if (s.text_delta) {
    if (st.lastSegment === 'tool') st.handlers.onSegmentBreak(); // tool → text boundary
    st.lastSegment = 'text';
    st.handlers.onText(s.text_delta);
    // Whitespace alone is not a reply: the DONE frame often carries just the closing "\n", and it
    // must neither make a reply out of nothing nor unmake the one just written.
    if (s.text_delta.trim()) st.endsInReply = true;
  }
  // The DONE frame also carries the step's usage — including a step that chose a tool and said
  // nothing, which is why this is not inside the text branch.
  const tokens = agyStepContextTokens(s);
  if (tokens !== undefined) st.onContextTokens?.(tokens);
}

/**
 * A `status:ERROR` result for a turn whose last output was the agent's own reply: the turn is done.
 *
 * agy's `result` describes the CONVERSATION, not the turn. Measured on agy 1.3.2 (2026-10-10):
 * `num_turns`, `duration_seconds` and `usage` are running totals, and `status`/`error` follow
 * suit — once a conversation has had an API error, even one agy retried past four seconds later
 * ("API error (attempt 1): INTERNAL (code 500): Internal error encountered."), every later
 * `result` in it says ERROR with that same error. That includes the turn it recovered in, every
 * turn after, and a fresh process resumed with `--conversation` whose one model call was clean.
 * Reported the same day: a scheduled run wrote its whole 2.4k-character report, was then marked ❌
 * and its schedule recorded as failed, and so was every turn in that topic afterwards.
 *
 * So the status alone cannot be believed, and what is believed instead is the stream: a turn that
 * really failed ends in an error step (retries exhausted), in a tool, or in nothing at all. One
 * whose last output is reply text written after its last error step got its answer out. Only
 * ERROR is reconsidered — CANCELED and INTERRUPTED are this daemon's own aborts, handled upstream.
 *
 * Said once, where it happened: a turn that saw an error step gets a notice, since that error is
 * plausibly this turn's and the user may wonder at the hiccup. A turn that saw none is agy
 * repeating an old error, and saying so on every later turn would be noise about something
 * already over — so it is logged and nothing more.
 */
function settleErrorResult(error: string | undefined, st: AgyTurnState): void {
  const reason = error ? trimReason(error) : 'no reason given';
  if (st.sawErrorStep) {
    console.log(`[agy] ${st.agentId}: hit an error this turn and recovered, finishing its reply: ${reason}`);
    st.handlers.onNotice?.(`⚠️ ${st.agentId} hit an error and recovered: ${reason}`);
    return;
  }
  console.log(
    `[agy] ${st.agentId}: result says ERROR but the turn ended in a reply with no error of its own; ` +
      `taking it as agy repeating an earlier, recovered one: ${reason}`
  );
}

/** Tool step: the first frame (ACTIVE) opens the bubble, DONE closes it. `tool_info.error` marks failure. */
function ingestToolStep(s: NonNullable<AgyEvent['step_update']>, st: AgyTurnState): void {
  const key = s.step_index ?? -1;
  const label = toolLabel(s.tool_info?.name ?? s.tool_name);
  let rec = st.toolLedger.get(key);
  if (!rec) {
    rec = { index: st.toolIndexSeq++, name: label, started: false, finished: false };
    st.toolLedger.set(key, rec);
  }
  // A later frame may carry a better name than the first (agy sends tool_info on both).
  if (label !== 'Tool') rec.name = label;

  if (!rec.started) {
    rec.started = true;
    if (st.lastSegment === 'text') st.handlers.onSegmentBreak(); // text → tool boundary
    st.handlers.onToolStart({
      name: rec.name,
      inputPreview: buildInputPreview(s.tool_info?.parameters),
      input: s.tool_info?.parameters,
      index: rec.index,
    });
    st.lastSegment = 'tool';
  }

  if (s.state === 'DONE' && !rec.finished) {
    rec.finished = true;
    st.handlers.onToolFinish({
      name: rec.name,
      index: rec.index,
      ok: !s.tool_info?.error,
      // agy reports the step's own duration; prefer it over wall-clock so the bubble matches the CLI.
      durationMs: Math.round((s.duration_seconds ?? 0) * 1000),
    });
  }
}

/** Turn end: close any tool bubble left open (agy omits DONE if the turn was cut short). */
function flushPendingTools(st: AgyTurnState): void {
  for (const rec of st.toolLedger.values()) {
    if (rec.started && !rec.finished) {
      rec.finished = true;
      st.handlers.onToolFinish({ name: rec.name, index: rec.index, ok: true, durationMs: 0 });
    }
  }
  st.toolLedger.clear();
}

/**
 * agy tool name → short display name, aligned with the default `tools.emojiMap` keys (see
 * config/schema.ts) so each bubble picks up the same emoji as the equivalent Claude/Codex tool.
 * Unmapped tools fall back to their own (truncated) name rather than a generic label, since agy
 * ships many specialized tools (browser_*, subagents) that are clearer named than lumped together.
 */
export function toolLabel(name?: string): string {
  if (!name) return 'Tool';
  return agyToolLabel(name) ?? truncateToolName(name);
}

/** Sink for the in-flight turn: parsed events in, settle the runTurn promise out. */
interface TurnSink {
  feed(msg: AgyEvent): void;
  fail(err: Error): void;
}
