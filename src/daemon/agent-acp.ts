import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  ActiveSession,
  ClientConnection,
  ClientContext,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  InitializeResponse,
  McpServer,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { PermissionAnswer, SessionOption, SteerOutcome } from '../types.js';
import type { AgentDef, Config } from '../config/schema.js';
import type { HarnessQuota } from './harness/profile.js';
import { findAgent } from '../config/schema.js';
import { localeOf, type Locale } from '../core/i18n/index.js';
import { tRuntime } from '../core/i18n/runtime.js';
import { asksPerson } from '../core/permission-levels.js';
import type {
  AgentFactory,
  AgentSession,
  AgentStreamHandlers,
  EffortSelector,
  FollowUpSink,
  ModelSelector,
  ReclaimState,
  RunTurnInput,
  SessionMemory,
  SessionModeSelector,
} from './agent.js';
import { asUndelivered, ForkRefused, SideQuestionRefused, TurnFailure } from './agent.js';
import { forkInto, forkRefusal } from './acp-fork.js';
import { relayNativeSubagents } from './acp-native-subagents.js';
import {
  askOnFork,
  forkSupportOf,
  NO_FORK,
  sideQuestionRefusal,
  type ForkSupport,
  type SideAskHandle,
} from './acp-side-question.js';
import { steeringModeOf, type SteeringMode } from './acp-steering.js';
import {
  describeSessionFailure,
  failureReasonOf,
  readSessionFailure,
} from './session-failure.js';
import {
  killChildProcess,
  resolveConversationCwd,
  trimReason,
  watchRemoteLink,
  type AgentChild,
} from './agent-common.js';
import { PreLaunchCancelled, runPreLaunchHook } from './agent-hooks.js';
import { remoteHosts } from './remote-hosts.js';
import { agyTurnWatch, agyWindow } from './agy-acp.js';
import { createQuotaMeter, hasQuotaSource, type QuotaMeter } from './quota-meter.js';
import {
  adoptAcpChild,
  AgyMeterHelper,
  announceSessionFailure,
  authRequiredFailure,
  buildTurnPromptInput,
  clientCapabilitiesFor,
  createSteerHandler,
  createTurnPromptDriver,
  isAuthRequired,
  isNotSentRpcError,
  launchAcpChild,
  placeOnHost,
  promptBlocks,
  reconnectBlocks,
  startupFailure,
  startupSlot,
  StartupTimeout,
  watchForFoldedPrompt,
  watchHarnessLog,
  type StartupProgress,
} from './agent-acp-harness.js';
import { type AgentProvision, provisionsFor } from './provision.js';
import {
  AcpOptionState,
  reportedModes,
} from './agent-acp-options.js';
import { HARNESS_PROFILES } from './harness/index.js';
import {
  AgentUnreachable,
  canPickUp,
  isAgentAnswer,
  NO_RESUME,
  readResumeSupport,
  Redialer,
  type OutageKind,
  type RedialTiming,
  type ResumeSupport,
} from './agent-reconnect.js';
import {
  decidePermission,
  failIfRefused,
  flushPendingTools,
  hasOpenToolCall,
  isRenderableUpdate,
  isResultUsage,
  parseFormElicitation,
  permissionRequestOf,
  permissionResponse,
  trackVisibleOutput,
  translateUpdate,
  type TurnState,
} from './agent-acp-translate.js';

// Re-export split submodules so every existing caller and test import path stays unchanged.
export {
  acpMcpServers, FOLDED_PROMPT_GRACE_MS, isCursorAgent, NATIVE_TOOLS_SERVER, promptBlocks,
  remoteMcpServers, resolveHarness, startupFailureMessage, type StartupProgress,
} from './agent-acp-harness.js';
export {
  applyEffortPreference, applyModelPreference, applyPermissionLevel, applyPinnedOptions,
  customOptionsOf, effortSelectorOf, liveEffortName,
  liveModelName, modeControlOf, permissionModesOf, type ModeControl, type ModeState,
} from './agent-acp-options.js';
export {
  autonomousResultOrigin, decidePermission, isResultUsage, parseFormElicitation, PERMISSION_DECLINED_CODE,
  permissionRequestOf, permissionResponse, toolLabel, translateUpdate, type TurnState,
} from './agent-acp-translate.js';

/**
 * AgentFactory's ACP (Agent Client Protocol) implementation on the official @agentclientprotocol/sdk.
 *
 * fleetherd daemon = ACP "client/host". Each (conversationId, agentId) spawns a resident ACP agent
 * child, translating ACP `session/update` notifications back to `AgentStreamHandlers`.
 *
 * Responsibility split:
 * - `agent-acp-harness.ts`: launch resolution, MCP wiring, startup diagnostics, and harness quirks.
 * - `agent-acp-options.ts`: model / effort / mode / custom options state & normalization.
 * - `agent-acp-translate.ts`: pure `session/update`, permission, and elicitation translation.
 * - `agent-acp.ts` (this file): factory, session lifecycle, pump, watchdogs, and permission answering.
 */

/** ACP protocol version: taken from the installed SDK's PROTOCOL_VERSION, auto-aligning on upgrade. */
const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** Max wait for initialize + session/new after spawn; on timeout, treat spawn as failed instead of hanging. */
const START_TIMEOUT_MS = 30_000;

/** How long a connect agent's teardown waits for the `session/cancel` before it to be written. */
const CANCEL_FLUSH_MS = 1_000;

/**
 * How long a burst of out-of-turn output may stay silent before it is sealed and decorated.
 * A generous backstop behind `FOLLOW_UP_SEAL_GRACE_MS` so long background tool calls aren't split.
 */
const FOLLOW_UP_QUIET_MS = 180_000;

/**
 * Grace period after the harness reports a completed result before a burst of out-of-turn output
 * is sealed and decorated (shortens `FOLLOW_UP_QUIET_MS` without fragmenting per-snapshot cost).
 */
const FOLLOW_UP_SEAL_GRACE_MS = 1_500;

/**
 * Consecutive queue rejections the reader tolerates before tearing down the connection.
 * A failed prompt rejects once; a closed connection rejects forever (~1s bound before teardown).
 */
const MAX_QUEUE_REJECTIONS = 20;
const QUEUE_REJECT_BACKOFF_MS = 50;

/**
 * Extra silence a turn is allowed, as a multiple of `turnTimeoutMs`, while the harness has an
 * unfinished tool call open (Claude Code's Bash tool allows up to 600s, matching the default
 * watchdog; granted once per silence stretch so the ceiling stays finite at 30 minutes).
 */
export const TOOL_SILENCE_FACTOR = 2;

/**
 * How long a turn may run on after `/stop`'s `session/cancel` before its child is ended for it.
 * `session/cancel` is a cooperative notification; past this deadline a resumable child is ended
 * (`/kill`'s remedy) so the next message resumes via `session/load`.
 */
export const STOP_GRACE_MS = 20_000;

/** Thrown by the per-turn silence watchdog so runTurn can reap the hung subprocess before rethrowing. */
class TurnTimeoutError extends TurnFailure {
  constructor(message: string) {
    super(message, 'hung');
  }
}

export interface AcpFactoryOptions {
  /** Provisions delivered to each agent's machine on spawn (assembled by commands/start.ts). */
  provisions: readonly AgentProvision[];
  /** Replaces each harness's own quota source (HarnessProfile.quota) — for tests. */
  harnessQuota?: (def: AgentDef) => HarnessQuota | undefined;
  /** How long a lost agent is tried again, and how often (agent-reconnect.ts); for the tests. */
  redial?: RedialTiming;
}

export function createAcpAgentFactory(
  cfg: Config,
  socketPath: string,
  store: SessionMemory | undefined,
  opts: AcpFactoryOptions
): AgentFactory {
  const sessions = new Map<string, AgentSession>();
  const turnTimeoutMs = cfg.session.turnTimeoutMs;
  const locale = localeOf(cfg);
  // One reading per quota source for the whole runtime, whichever conversation asked (quota-meter.ts).
  const quota = createQuotaMeter({ harnessQuota: opts.harnessQuota });

  return {
    getOrCreate(sessionId: string, agentId: string): AgentSession {
      let s = sessions.get(sessionId);
      if (!s) {
        const def = findAgent(cfg, agentId);
        if (!def) throw new Error(`unknown agent id: ${agentId} (check the routing and agents config)`);
        s = new AcpSession(
          def,
          socketPath,
          sessionId,
          turnTimeoutMs,
          opts.provisions,
          store,
          hasQuotaSource(def) ? quota : undefined,
          opts.redial,
          locale
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

class AcpSession implements AgentSession {
  readonly conversationId: string;
  private cwd: string;

  /** Lazily-started connection handles; established on first turn, closed on dispose. */
  private proc: AgentChild | undefined;
  private conn: ClientConnection | undefined;
  private active: ActiveSession | undefined;
  /** The last `session/cancel` sent, until it is written: a connect agent's teardown waits for it. */
  private cancelSent: Promise<void> | undefined;
  private pump: Promise<void> | undefined;

  /** Active turn state and pump callbacks; undefined between turns. */
  private turnState: TurnState | undefined;
  private onTurnUpdate: ((update: SessionUpdate) => void) | undefined;
  private endTurnWait: ((response?: PromptResponse) => void) | undefined;

  /** Out-of-turn follow-up rendering state. */
  private followUpSink: FollowUpSink | undefined;
  private followUpState: { state: TurnState; sink: FollowUpSink } | undefined;
  private cancelFollowUpQuiet: (() => void) | undefined;
  private burstRendering = false;

  /** Shared in-flight startup promise and preLaunch hook abort controller. */
  private starting: Promise<void> | undefined;
  private launchHook: AbortController | undefined;

  /** Lifecycle / abort / user-wait flags. */
  private aborting = false;
  private disposed = false;
  private awaitingUser = 0;

  /** Cancel wreckage & session/load replay gate. */
  private cancelledTools = new Set<string>();
  private promptedYet = false;
  private replayFence: Promise<void> | undefined;
  private releaseReplayFence: (() => void) | undefined;
  private replayPending = false;

  /** Binary-level capabilities learned from `initialize` (kept across child rebuilds). */
  private loadSessionSupported = false;
  private resume: ResumeSupport = NO_RESUME;
  private steeringMode: SteeringMode = 'none';
  private imagePrompts = false;
  private embeddedContext = false;
  private forkSupport: ForkSupport = NO_FORK;
  private forkKnown = false;
  private forkSeed: string | undefined;

  /** Active `/btw` side questions, keyed by fork session id. */
  private readonly sideAsks = new Map<string, SideAskHandle>();
  /** Session-scoped subagent names (background subagents outlive the turn that spawned them). */
  private readonly subagentNames = new Map<string, string>();

  /** Mid-turn steering & stop coordination. */
  private joinTurn: ((blocks: ContentBlock[]) => Promise<SteerOutcome>) | undefined;
  private promptSent: Promise<void> | undefined;
  private joinedStillQueued: (() => boolean) | undefined;
  private endChildAfterStop = false;
  private turnStopped: (() => void) | undefined;
  private stoppedWhileStarting = false;
  /** Trips on `/stop` or dispose: ends a wait to redial a lost agent (agent-reconnect.ts). */
  private stopRedial: AbortController | undefined;
  private readonly stopGraceMs: number;

  /** Composed collaborators for options/modes and agy/quota metering. */
  private readonly options: AcpOptionState;
  private readonly agyMeter: AgyMeterHelper;

  constructor(
    private readonly def: AgentDef,
    private readonly socketPath: string,
    conversationId: string,
    private readonly turnTimeoutMs: number,
    private readonly provisions: readonly AgentProvision[],
    private readonly store?: SessionMemory,
    quota?: QuotaMeter,
    private readonly redialTiming?: RedialTiming,
    private readonly locale: Locale = 'en'
  ) {
    this.conversationId = conversationId;
    this.cwd = resolveConversationCwd(def, conversationId, store);
    this.stopGraceMs = turnTimeoutMs > 0 ? Math.min(STOP_GRACE_MS, turnTimeoutMs / 2) : STOP_GRACE_MS;
    this.options = new AcpOptionState(def, conversationId, store);
    this.agyMeter = new AgyMeterHelper(
      def,
      conversationId,
      this.options,
      quota,
      () => this.disposed,
      () => this.active?.sessionId
    );
  }

  // ───────────────────────── Elicitation & permission answering ─────────────────────────

  /**
   * Answer an ACP `elicitation/create`: put the agent's question to the user and block until they
   * pick. Anything unrenderable (no turn open, url mode, no options) is cancelled honestly.
   */
  private async answerElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const side = this.sideAsks.get((params as { sessionId?: string }).sessionId ?? '');
    const ask = side ? side.state.handlers.onElicit : this.turnState?.handlers.onElicit;
    if (!ask) {
      console.warn(`[acp] ${this.conversationId}: elicitation arrived with no turn to ask in; cancelling`);
      return { action: 'cancel' };
    }
    const parsed = parseFormElicitation(params);
    if (!parsed) {
      console.warn(`[acp] ${this.conversationId}: cannot render this elicitation (mode=${params.mode}); cancelling`);
      return { action: 'cancel' };
    }
    this.awaitingUser++;
    try {
      const answer = await ask(parsed);
      return answer.action === 'accept'
        ? { action: 'accept', content: answer.content }
        : { action: answer.action };
    } catch (e) {
      console.error(`[acp] ${this.conversationId}: failed to put an elicitation to the user:`, e instanceof Error ? e.message : e);
      return { action: 'cancel' };
    } finally {
      this.awaitingUser--;
    }
  }

  /**
   * Answer an ACP `session/request_permission` (Security invariant #1): approve under a level that
   * does not ask, or put it to the user under `plan` / `ask` / `edits`. A failure to ask or an
   * unanswered request is always declined, never approved.
   */
  private async answerPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!asksPerson(this.def.permissions)) return decidePermission(params);
    const ask = (this.sideAsks.get(params.sessionId)?.state ?? this.turnState ?? this.followUp(false))?.handlers.onPermission;
    const request = permissionRequestOf(params);
    let answer: PermissionAnswer;
    if (!ask) {
      answer = { kind: 'unavailable', why: 'no chat to ask in' };
    } else {
      this.awaitingUser++;
      try {
        answer = await ask(request);
      } finally {
        this.awaitingUser--;
      }
    }
    console.log(`[acp] ${this.conversationId}: permission for ${JSON.stringify(request.title)} → ${answer.kind}`);
    return permissionResponse(params, answer);
  }

  // ───────────────────────── Replay fence, handles & teardown ─────────────────────────

  private armReplayFence(): void {
    this.replayPending = true;
    this.replayFence = new Promise<void>((resolve) => {
      this.releaseReplayFence = resolve;
    });
  }

  private clearReplayFence(): void {
    this.replayPending = false;
    this.releaseReplayFence?.();
    this.releaseReplayFence = undefined;
    this.replayFence = undefined;
  }

  private openPromptWindow(): () => void {
    let release: () => void = () => {};
    const sent = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.promptSent = sent;
    return () => {
      release();
      if (this.promptSent === sent) this.promptSent = undefined;
    };
  }

  private blocksOf(input: Pick<RunTurnInput, 'prompt' | 'images' | 'files'>): ContentBlock[] {
    if (input.images?.length && !this.imagePrompts) {
      console.log(
        `[acp] ${this.conversationId}: "${this.def.id}" does not take pictures in a prompt (initialize: promptCapabilities.image is not true); ${input.images.length} go by path only`
      );
    }
    return promptBlocks(input, this.imagePrompts, this.embeddedContext);
  }

  private resetHandles(): void {
    this.proc = undefined;
    this.conn = undefined;
    this.active = undefined;
    this.pump = undefined;
    void this.closeFollowUp('stopped');
    this.promptedYet = false;
    this.clearReplayFence();
    this.options.resetChild();
  }

  private canResume(): boolean {
    return this.loadSessionSupported && !!this.store?.agentSession(this.conversationId, this.def.id);
  }

  private disposeChild(): void {
    this.aborting = true;
    this.teardown();
  }

  private teardown(): void {
    this.launchHook?.abort();
    const child = this.proc;
    const [session, connection, cancel] = [this.active, this.conn, this.cancelSent];
    this.cancelSent = undefined;
    const close = (): void => {
      try {
        session?.dispose();
        connection?.close();
      } catch (e) {
        console.debug('[acp] teardown: ignoring error while closing connection:', e instanceof Error ? e.message : e);
      }
      if (child) killChildProcess(child);
    };
    if (this.def.connect && cancel) {
      void Promise.race([cancel, new Promise<void>((r) => setTimeout(r, CANCEL_FLUSH_MS).unref())]).then(close);
    } else {
      close();
    }
    this.resetHandles();
  }

  // ───────────────────────── Startup & session opening ─────────────────────────

  private async ensureStarted(sessionToken: string, topic?: string): Promise<void> {
    if (this.active) return;
    this.starting ??= (async () => {
      const slot = startupSlot(remoteHosts.hostFor(this.def)?.id ?? 'local');
      await slot.acquire();
      try {
        await this.startSession(sessionToken, topic);
      } finally {
        slot.release();
      }
    })().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private async runPreLaunchIfConfigured(): Promise<void> {
    if (!this.def.hooks?.preLaunch) return;
    const hook = new AbortController();
    this.launchHook = hook;
    try {
      await runPreLaunchHook(this.def, { cwd: this.cwd, signal: hook.signal });
    } finally {
      if (this.launchHook === hook) this.launchHook = undefined;
    }
  }

  private async startAsFork(
    ctx: ClientContext,
    sourceId: string,
    mcpServers: () => McpServer[],
    progress: StartupProgress
  ): Promise<void> {
    const refusal = forkRefusal(this.def.id, this.forkSupport);
    if (refusal) throw new ForkRefused(refusal);
    const forked = await forkInto(ctx, {
      sourceId,
      cwd: this.cwd,
      mcpServers: mcpServers(),
      support: this.forkSupport,
      onStep: (step) => {
        progress.step = step;
      },
    });
    this.active = forked.session;
    this.options.captureOpened(forked.configOptions, forked.modes);
    this.armReplayFence();
    console.log(`[acp] ${this.conversationId}: started as a fork of ${sourceId} (${forked.session.sessionId})`);
    progress.step = 'session/set_config_option';
    await this.options.reapplyPreferences(ctx, forked.session.sessionId, this.options.initialModelHint());
    this.store?.setAgentSession(this.conversationId, this.def.id, forked.session.sessionId);
  }

  private async resumeStoredSession(
    ctx: ClientContext,
    persistedId: string,
    mcpServers: () => McpServer[],
    progress: StartupProgress
  ): Promise<boolean> {
    const attach = (
      ctx as unknown as { attachSession(r: { sessionId: string }): ActiveSession }
    ).attachSession.bind(ctx);
    const resumed = attach({ sessionId: persistedId });
    try {
      progress.step = 'session/load';
      const loaded = await ctx.request('session/load', {
        sessionId: persistedId,
        cwd: this.cwd,
        mcpServers: mcpServers(),
      });
      this.active = resumed;
      this.options.captureOpened(loaded?.configOptions, reportedModes(loaded));
      this.armReplayFence();
      console.log(`[acp] resumed persisted session for "${this.def.id}" (${persistedId})`);
      await this.options.reapplyPreferences(ctx, persistedId, this.options.modelAfterLoad());
      return true;
    } catch (err) {
      resumed.dispose();
      console.warn(
        `[acp] session/load failed for "${this.def.id}" (${persistedId}); starting a fresh session:`,
        err instanceof Error ? err.message : err
      );
      return false;
    }
  }

  private async createNewSession(
    ctx: ClientContext,
    initResult: InitializeResponse,
    mcpServers: () => McpServer[],
    progress: StartupProgress
  ): Promise<void> {
    const hint = this.options.initialModelHint();
    try {
      progress.step = 'session/new';
      const session = await ctx
        .buildSession({
          cwd: this.cwd,
          mcpServers: mcpServers(),
          ...(hint
            ? {
                _meta: {
                  model: HARNESS_PROFILES[this.def.harness].encodeModelWire?.(hint) ?? hint,
                },
              }
            : {}),
        })
        .start();
      this.active = session;
      this.options.captureOpened(session.newSessionResponse?.configOptions, reportedModes(session.newSessionResponse));
      progress.step = 'session/set_config_option';
      await this.options.reapplyPreferences(ctx, session.sessionId, hint);
      this.store?.setAgentSession(this.conversationId, this.def.id, session.sessionId);
    } catch (err) {
      if (isAuthRequired(err)) {
        throw authRequiredFailure(this.def, initResult);
      }
      throw err;
    }
  }

  private async initializeAndOpen(
    ctx: ClientContext,
    initExtra: { _meta?: Record<string, unknown> },
    mcpServers: () => McpServer[],
    progress: StartupProgress
  ): Promise<void> {
    const initResult = await ctx.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: clientCapabilitiesFor(this.def),
      ...initExtra,
    });
    progress.answered = true;
    this.loadSessionSupported = initResult.agentCapabilities?.loadSession === true;
    this.resume = readResumeSupport(initResult.agentCapabilities);
    this.steeringMode = steeringModeOf(initResult, Boolean(HARNESS_PROFILES[this.def.harness].takesPromptMidTurn));
    this.imagePrompts = initResult.agentCapabilities?.promptCapabilities?.image === true;
    this.embeddedContext = initResult.agentCapabilities?.promptCapabilities?.embeddedContext === true;
    [this.forkSupport, this.forkKnown] = [forkSupportOf(initResult), true];

    if (this.forkSeed !== undefined) {
      return this.startAsFork(ctx, this.forkSeed, mcpServers, progress);
    }
    const persistedId = this.store?.agentSession(this.conversationId, this.def.id);
    if (persistedId && this.loadSessionSupported) {
      const resumed = await this.resumeStoredSession(ctx, persistedId, mcpServers, progress);
      if (resumed) return;
    }
    await this.createNewSession(ctx, initResult, mcpServers, progress);
  }

  private async startSession(sessionToken: string, topic?: string): Promise<void> {
    if (this.active) return;

    this.cwd = resolveConversationCwd(this.def, this.conversationId, this.store);
    const provisions = provisionsFor(this.def, this.provisions);
    const placed = await placeOnHost(this.def, this.cwd, provisions);
    if (placed) this.cwd = placed.cwd;
    const place = placed?.place;

    await this.runPreLaunchIfConfigured();

    const { command, args, initExtra, child, mcpServers } = await launchAcpChild({
      def: this.def,
      cwd: this.cwd,
      socketPath: this.socketPath,
      sessionToken,
      place,
      topic,
      provisions,
    });
    this.proc = child;
    const { spawnError, stderrTail } = adoptAcpChild(
      this.def,
      child,
      () => this.proc === child,
      () => this.resetHandles()
    );

    const stream = relayNativeSubagents(
      ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      )
    );
    const app = client()
      .onRequest('session/request_permission', ({ params }): Promise<RequestPermissionResponse> => this.answerPermission(params))
      .onRequest('elicitation/create', ({ params }): Promise<CreateElicitationResponse> => this.answerElicitation(params));
    const connection = app.connect(stream);
    this.conn = connection;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const progress: StartupProgress = { answered: false, step: 'initialize' };
    try {
      await Promise.race([
        this.initializeAndOpen(connection.agent, initExtra, mcpServers, progress),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StartupTimeout()), START_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.disposeChild();
      const failed = spawnError();
      if (failed) {
        const where = place ? ` on host "${place.host.id}"` : '';
        const message = `agent "${this.def.id}" could not start${where}: ${failed.message}`;
        // A connect agent's dial is its spawn: refused or unreachable is the service being away.
        throw this.def.connect ? new AgentUnreachable(message) : new TurnFailure(message, 'startup');
      }
      if (err instanceof TurnFailure || err instanceof ForkRefused) throw err;
      const launch = `${command} ${args.join(' ')}`.trim();
      const failure = startupFailure(this.def, err, { host: place?.host.id, launch, progress, stderr: stderrTail(), timeoutMs: START_TIMEOUT_MS });
      // Closed before it answered: the service went away under the start.
      const dropped = connection.signal.aborted && !isAgentAnswer(err) && !(err instanceof StartupTimeout);
      throw dropped && this.mayRedial() ? new AgentUnreachable(failure.message) : failure;
    } finally {
      if (timer) clearTimeout(timer);
    }

    this.beginPump();
  }

  // ───────────────────────── Translation state, follow-up & update pump ─────────────────────────

  private newTranslationState(handlers: AgentStreamHandlers, inTurn: boolean): TurnState {
    const announced = new Set<string>();
    return {
      handlers,
      lastSegment: 'none',
      toolLedger: new Map(),
      toolIndexSeq: 0,
      onConfigOptions: (options) => {
        if (!options) return;
        this.options.onConfigOptions(options);
        this.agyMeter.reportScopedQuota(handlers);
      },
      onModeChanged: (modeId) => this.options.onModeChanged(modeId),
      onQuotaReport: (pools) => this.agyMeter.recordReportedQuota(pools, handlers),
      onSessionFailure: (failure) =>
        announceSessionFailure({
          def: this.def,
          conversationId: this.conversationId,
          promptedYet: this.promptedYet,
          failure,
          handlers,
          announced,
        }),
      contextWindow: this.def.contextWindow,
      subagents: this.subagentNames,
      agy:
        HARNESS_PROFILES[this.def.harness].usesAgyTurnWatch
          ? agyTurnWatch(this.def.id, (text) => handlers.onNotice?.(text), inTurn, {
              onModelCall: () => this.agyMeter.refreshAgyContext(handlers),
              window: (reported) => agyWindow(this.def, this.options.currentModelValue(), reported),
            }, this.locale)
          : undefined,
    };
  }

  private followUp(renderable: boolean): TurnState | undefined {
    if (!this.followUpSink) return undefined;
    if (!this.followUpState) {
      const handlers = this.followUpSink.handlers();
      this.followUpState = { state: this.newTranslationState(handlers, false), sink: this.followUpSink };
      this.options.reportSessionFacts(handlers);
    }
    if (!renderable) return this.followUpState.state;
    if (!this.burstRendering) {
      this.burstRendering = true;
      console.log(`[acp] ${this.conversationId}: output arrived outside a turn; rendering it as a follow-up`);
    }
    this.armFollowUpQuiet(FOLLOW_UP_QUIET_MS);
    return this.followUpState.state;
  }

  private armFollowUpQuiet(ms: number): void {
    this.cancelFollowUpQuiet?.();
    const timer = setTimeout(() => {
      console.log(`[acp] ${this.conversationId}: follow-up output went quiet; closing it`);
      void this.closeFollowUp();
    }, ms);
    this.cancelFollowUpQuiet = () => clearTimeout(timer);
  }

  private isWreckage(update: SessionUpdate): boolean {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return false;
    if (this.turnState?.stopped) return false;
    if (this.aborting) return true;
    return typeof update.toolCallId === 'string' && this.cancelledTools.has(update.toolCallId);
  }

  private async closeFollowUp(reason: 'done' | 'stopped' = 'done'): Promise<void> {
    this.cancelFollowUpQuiet?.();
    this.cancelFollowUpQuiet = undefined;
    const burst = this.followUpState;
    this.followUpState = undefined;
    if (this.burstRendering) console.log(`[acp] ${this.conversationId}: follow-up closed (${reason})`);
    this.burstRendering = false;
    if (!burst) return;
    flushPendingTools(burst.state);
    try {
      await burst.sink.close(reason);
    } catch (e) {
      console.error('[acp] follow-up sink failed to close:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * One read from the session queue; also detects when a `session/load` replay prefix has been
   * drained by racing against `setImmediate` (AsyncQueue resolves buffered items on microtasks).
   */
  private async readNext(
    session: ActiveSession
  ): Promise<Awaited<ReturnType<ActiveSession['nextUpdate']>>> {
    const read = session.nextUpdate();
    if (!this.replayPending) return read;

    const IDLE = Symbol('idle');
    const idle = new Promise<typeof IDLE>((resolve) => setImmediate(() => resolve(IDLE)));
    const first = await Promise.race([read, idle]);
    if (first !== IDLE) return first;

    console.log(`[acp] ${this.conversationId}: session/load replay consumed; rendering resumes`);
    this.clearReplayFence();
    return read;
  }

  private dispatchPumpUpdate(update: SessionUpdate): void {
    const renderable = isRenderableUpdate(update);
    if (renderable && this.isWreckage(update)) {
      console.debug(`[acp] ${this.conversationId}: dropping a trailing update for a tool the cancel killed`);
      return;
    }
    if (renderable && !this.promptedYet) {
      console.debug(`[acp] ${this.conversationId}: not rendering a ${update.sessionUpdate} from before the first prompt`);
      return;
    }
    const dest = this.turnState ?? this.followUp(renderable);
    if (!dest) {
      console.debug(
        `[acp] ${this.conversationId}: dropping a ${update.sessionUpdate} — no turn is running and no follow-up sink is installed`
      );
      return;
    }
    try {
      translateUpdate(update, dest);
    } catch (err) {
      console.error(
        `[acp] ${this.conversationId}: failed to render a ${update.sessionUpdate}:`,
        err instanceof Error ? err.stack ?? err.message : err
      );
      return;
    }
    if (this.turnState) {
      this.onTurnUpdate?.(update);
      return;
    }
    if (isResultUsage(update)) this.armFollowUpQuiet(FOLLOW_UP_SEAL_GRACE_MS);
  }

  private async pumpUpdates(session: ActiveSession): Promise<void> {
    let rejections = 0;
    for (;;) {
      if (this.active !== session) return;
      let msg: Awaited<ReturnType<ActiveSession['nextUpdate']>>;
      try {
        msg = await this.readNext(session);
        rejections = 0;
      } catch (e) {
        if (this.active !== session) return;
        this.endTurnWait?.();
        if (++rejections > MAX_QUEUE_REJECTIONS) {
          console.warn(
            `[acp] update queue for "${this.def.id}" keeps rejecting (${e instanceof Error ? e.message : e}); dropping the connection so the next turn rebuilds it`
          );
          this.teardown();
          return;
        }
        await new Promise((r) => setTimeout(r, QUEUE_REJECT_BACKOFF_MS));
        continue;
      }
      if (this.active !== session) return;
      if (msg.kind === 'stop') {
        this.endTurnWait?.(msg.response);
        continue;
      }
      this.dispatchPumpUpdate(msg.update);
    }
  }

  private beginPump(): void {
    if (!this.active || this.pump) return;
    const session = this.active;
    this.pump = this.pumpUpdates(session).catch((e) => {
      console.error('[acp] update reader stopped unexpectedly:', e instanceof Error ? e.stack ?? e.message : e);
    });
  }

  // ───────────────────────── Turn execution helpers ─────────────────────────

  private endIfStoppedWhileStarting(): void {
    if (!this.stoppedWhileStarting) return;
    console.log(`[acp] ${this.conversationId}: stopped while the agent was starting; not sending the prompt`);
    throw new Error('stopped before the prompt was sent');
  }

  private watchStop(
    state: TurnState,
    handlers: AgentStreamHandlers,
    endTurn: (err: Error) => void
  ): { stopped: () => void; clear: () => void } {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const onIgnored = (): void => {
      const secs = Math.max(1, Math.round(this.stopGraceMs / 1000));
      if (!this.canResume()) {
        console.warn(
          `[acp] ${this.conversationId}: "${this.def.id}" is still running ${this.stopGraceMs}ms after the cancel and cannot resume a stored session; leaving its process up`
        );
        handlers.onNotice?.(
          tRuntime(this.locale, 'noticeStillRunningUnresumable', { agent: this.def.id, secs })
        );
        return;
      }
      console.warn(
        `[acp] ${this.conversationId}: "${this.def.id}" is still running ${this.stopGraceMs}ms after the cancel; ending its process (the next message resumes the session)`
      );
      handlers.onNotice?.(
        tRuntime(this.locale, 'noticeStillRunningKilled', { agent: this.def.id, secs })
      );
      this.disposeChild();
      endTurn(new Error(`"${this.def.id}" did not stop in time`));
    };
    return {
      stopped: () => {
        state.stopped = true;
        deadline ??= setTimeout(onIgnored, this.stopGraceMs);
      },
      clear: () => {
        if (deadline) clearTimeout(deadline);
      },
    };
  }

  private createSilenceWatchdog(state: TurnState, host: ReturnType<typeof remoteHosts.hostFor>): {
    timedOut: Promise<never>;
    rearm: () => void;
    trigger: (err: Error) => void;
    clear: () => void;
  } {
    let hung: ((err: Error) => void) | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let toolGraceUsed = false;
    const arm = (ms: number): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => onSilence(ms), ms);
    };
    const onSilence = (waited: number): void => {
      if (host && !host.isUp) {
        arm(waited);
        return;
      }
      if (this.awaitingUser > 0) {
        arm(waited);
        return;
      }
      if (!toolGraceUsed && hasOpenToolCall(state)) {
        toolGraceUsed = true;
        const extra = this.turnTimeoutMs * TOOL_SILENCE_FACTOR;
        console.log(
          `[acp] ${this.conversationId}: quiet for ${waited}ms but a tool call is still open; allowing it ${extra}ms more`
        );
        arm(extra);
        return;
      }
      hung?.(
        new TurnTimeoutError(
          `agent "${this.def.id}" sent no update for ${waited}ms${
            toolGraceUsed ? ' with a tool call still open' : ''
          }; treating it as hung and aborting this turn`
        )
      );
    };
    const timedOut = new Promise<never>((_, reject) => {
      hung = reject;
    });
    return {
      timedOut,
      rearm: () => {
        if (this.turnTimeoutMs <= 0) return;
        toolGraceUsed = false;
        arm(this.turnTimeoutMs);
      },
      trigger: (err: Error) => hung?.(err),
      clear: () => {
        if (watchdog) clearTimeout(watchdog);
      },
    };
  }

  private async settleTurnResponse(
    state: TurnState,
    response: PromptResponse,
    sawOutput: boolean
  ): Promise<void> {
    const failure = readSessionFailure(response._meta);
    if (failure?.severity === 'error') {
      throw new TurnFailure(describeSessionFailure(failure), failureReasonOf(failure));
    }
    await this.agyMeter.settleAgyTurn(state, response, this.aborting);
    failIfRefused(response, sawOutput);
    flushPendingTools(state);
  }

  private async prepareTurnStart(input: RunTurnInput, closePromptWindow: () => void, redial: Redialer): Promise<boolean> {
    try {
      await this.startReachable(input, redial, 'start');
      await this.closeFollowUp('stopped');
      return true;
    } catch (err) {
      closePromptWindow();
      // A `/stop` while it waited to dial again: the person stopped it, nothing failed.
      if (err instanceof PreLaunchCancelled || (err instanceof AgentUnreachable && this.stopRedial?.signal.aborted)) return false;
      throw asUndelivered(err);
    }
  }

  /** Whether a failed start is worth dialling again: a connect agent, or one that can pick a turn up. */
  private mayRedial(): boolean {
    return this.def.connect !== undefined || this.resume.reconnect || this.resume.promptId;
  }

  /** ensureStarted, trying an agent it cannot reach again until the window closes (agent-reconnect.ts). */
  private async startReachable(input: RunTurnInput, redial: Redialer, kind: OutageKind): Promise<void> {
    const stop = this.stopRedial?.signal ?? new AbortController().signal;
    for (;;) {
      try {
        await this.ensureStarted(input.sessionToken, input.topic);
        redial.back();
        return;
      } catch (err) {
        if (!(err instanceof AgentUnreachable)) throw err;
        // The failed start's teardown marked the session as aborting; only a `/stop` is one.
        if (!stop.aborted) this.aborting = false;
        console.warn(`[acp] ${this.conversationId}: "${this.def.id}" is unreachable (${err.message})`);
        if (await redial.next(stop, kind)) continue;
        if (stop.aborted) throw err;
        throw new AgentUnreachable(`${err.message} (tried again for ${Math.round(redial.elapsedMs() / 1000)}s)`);
      }
    }
  }

  /**
   * After a prompt failed: what to send next when the turn can go on (agent-reconnect.ts), or
   * undefined to fail it. Throws when the connection was lost and could not be got back.
   */
  private async pickUpAfter(
    err: unknown,
    t: { conn: ClientConnection | undefined; pickingUp: boolean; original: ContentBlock[]; promptId?: string; sawText: boolean; input: RunTurnInput; redial: Redialer }
  ): Promise<{ blocks: ContentBlock[]; pickingUp: boolean } | undefined> {
    if (this.aborting || this.stopRedial?.signal.aborted) return undefined;
    if (t.pickingUp && t.promptId && isNotSentRpcError(err)) {
      console.log(`[acp] ${this.conversationId}: "${this.def.id}" never took this turn's prompt; sending it now, under the same id`);
      return { blocks: t.original, pickingUp: false };
    }
    const lost = t.conn?.signal.aborted === true && !isAgentAnswer(err);
    if (!lost || !canPickUp(this.resume, t.sawText)) return undefined;
    await this.reconnectMidTurn(err, t.input, t.redial);
    return { blocks: reconnectBlocks(t.promptId), pickingUp: true };
  }

  /** Get the same session back after the connection went away mid-turn, or throw why not. */
  private async reconnectMidTurn(err: unknown, input: RunTurnInput, redial: Redialer): Promise<void> {
    const sessionId = this.active?.sessionId ?? this.store?.agentSession(this.conversationId, this.def.id);
    console.warn(
      `[acp] ${this.conversationId}: lost the connection to "${this.def.id}" mid-turn (${err instanceof Error ? err.message : String(err)}); reconnecting`
    );
    this.teardown();
    try {
      await this.startReachable(input, redial, 'turn');
    } catch (e) {
      if (!(e instanceof AgentUnreachable) || this.stopRedial?.signal.aborted) throw e;
      throw new TurnFailure(`agent "${this.def.id}" lost its connection mid-turn and could not get it back: ${e.message}`, 'other');
    }
    // Picking up is asking the same session; a fresh one has no turn to pick up.
    if (this.active?.sessionId !== sessionId) {
      throw new TurnFailure(`agent "${this.def.id}" came back without this conversation's session, so the interrupted turn could not be picked up`, 'other');
    }
    console.log(`[acp] ${this.conversationId}: reconnected to "${this.def.id}"; picking the turn up`);
  }

  // ───────────────────────── Public AgentSession methods ─────────────────────────

  async runTurn(input: RunTurnInput, incomingHandlers: AgentStreamHandlers): Promise<void> {
    this.aborting = false;
    this.stoppedWhileStarting = false;
    const stop = new AbortController();
    this.stopRedial = stop;
    const output = trackVisibleOutput(incomingHandlers, () => this.agyMeter.quotaOnFirstOutput(incomingHandlers, this.cwd));
    const redial = new Redialer({ agent: this.def.id, notice: (text) => output.handlers.onNotice?.(text), locale: this.locale, ...this.redialTiming });
    const closePromptWindow = this.openPromptWindow();
    try {
      if (!(await this.prepareTurnStart(input, closePromptWindow, redial))) return;
      await this.runStartedTurn(input, output, closePromptWindow, redial);
    } finally {
      redial.clear();
      if (this.stopRedial === stop) this.stopRedial = undefined;
    }
  }

  private async runStartedTurn(
    input: RunTurnInput,
    output: ReturnType<typeof trackVisibleOutput>,
    closePromptWindow: () => void,
    redial: Redialer
  ): Promise<void> {
    const handlers = output.handlers;
    const state = this.newTranslationState(handlers, true);
    this.options.reportSessionFacts(handlers);
    this.agyMeter.quotaAtTurnStart(handlers);

    const host = remoteHosts.hostFor(this.def);
    const watchdog = this.createSilenceWatchdog(state, host);
    let driver = createTurnPromptDriver(this.conversationId);
    const logWatch = watchHarnessLog(this.def, this.conversationId, () => this.active?.sessionId, handlers, this.locale);
    const unwatchLink = watchRemoteLink(host, handlers, watchdog.rearm, this.locale);
    const fold = watchForFoldedPrompt(this.conversationId, this.turnTimeoutMs, state, () => this.awaitingUser > 0);
    const stopWatch = this.watchStop(state, handlers, watchdog.trigger);

    this.turnState = state;
    this.onTurnUpdate = (update) => {
      watchdog.rearm();
      if (driver.promptDone()) fold.observe(update);
    };
    watchdog.rearm();

    const promptId = this.resume.promptId ? input.promptId : undefined;
    const original = buildTurnPromptInput(this.def, input, (i) => this.blocksOf(i), promptId);
    let next = { blocks: original, pickingUp: false };
    try {
      for (;;) {
        this.endTurnWait = driver.onStop;
        this.joinedStillQueued = driver.hasQueuedPrompt;
        // Gone between the start and the prompt: nothing was sent, so it goes once the agent is back.
        if ((!this.active || !this.conn) && this.mayRedial()) await this.startReachable(input, redial, 'start').catch((e: unknown) => Promise.reject(asUndelivered(e)));
        const conn = this.conn;
        try {
          if (this.replayFence) await this.replayFence;
          this.promptedYet = true;
          this.endIfStoppedWhileStarting();
          const session = this.active!;
          driver.send(session, next.blocks);
          this.turnStopped = stopWatch.stopped;
          this.joinTurn = createSteerHandler({
            conversationId: this.conversationId,
            steeringMode: this.steeringMode,
            session,
            agentCtx: this.conn!.agent,
            driver,
            canSteer: () => !this.aborting && this.active === session,
          });
          closePromptWindow();

          const outcome = await Promise.race([driver.settled, watchdog.timedOut, driver.promptFailed, fold.folded]);
          if (outcome === 'folded') {
            flushPendingTools(state);
            return;
          }
          const response = await driver.promptDone()!;
          await this.settleTurnResponse(state, response, output.sawOutput());
          return;
        } catch (err) {
          if (err instanceof TurnTimeoutError) throw err;
          const after = await this.pickUpAfter(err, { conn, ...next, original, promptId, sawText: output.sawText(), input, redial });
          if (!after) throw err;
          next = after;
          driver = createTurnPromptDriver(this.conversationId);
          watchdog.rearm();
        }
      }
    } catch (err) {
      if (this.aborting) return;
      if (err instanceof TurnTimeoutError) {
        const reason = await logWatch.lastReason();
        this.disposeChild();
        if (reason) {
          throw new TurnTimeoutError(`${err.message}. ${this.def.harness} last logged: ${trimReason(reason)}`);
        }
      }
      if (isNotSentRpcError(err)) throw asUndelivered(err);
      throw err;
    } finally {
      watchdog.clear();
      stopWatch.clear();
      logWatch.stop();
      unwatchLink();
      fold.stop();
      this.cleanupTurnState(closePromptWindow);
      this.agyMeter.quotaAfterTurn(handlers, this.cwd);
    }
  }

  private cleanupTurnState(closePromptWindow: () => void): void {
    this.turnStopped = undefined;
    this.turnState = undefined;
    this.onTurnUpdate = undefined;
    this.endTurnWait = undefined;
    this.joinTurn = undefined;
    this.joinedStillQueued = undefined;
    closePromptWindow();
    if (this.endChildAfterStop) {
      this.endChildAfterStop = false;
      console.log(
        `[acp] ${this.conversationId}: stopped with a joined message still queued in the harness; ending the child so it cannot run it (the next message resumes the session)`
      );
      this.disposeChild();
    }
  }

  async steer(input: Pick<RunTurnInput, 'prompt' | 'images' | 'files'>): Promise<SteerOutcome> {
    if (this.promptSent) await this.promptSent;
    if (!this.joinTurn || this.aborting) return 'refused';
    return this.joinTurn(this.blocksOf(input));
  }

  canSteer(): boolean {
    return this.steeringMode !== 'none' || !this.active;
  }

  setFollowUpSink(sink: FollowUpSink): void {
    this.followUpSink = sink;
  }

  abort(): void {
    this.aborting = true;
    this.stopRedial?.abort();
    this.launchHook?.abort();
    if (this.joinedStillQueued?.()) this.endChildAfterStop = true;
    this.cancelledTools = new Set(this.turnState?.toolLedger.keys() ?? []);
    if (this.conn && this.active) {
      this.cancelSent = this.conn.agent.notify('session/cancel', { sessionId: this.active.sessionId }).catch(() => {});
    }
    if (this.turnStopped) this.turnStopped();
    else this.stoppedWhileStarting = true;
  }

  backgroundActive(): boolean {
    return !this.turnState && this.burstRendering;
  }

  supportsReconnect(): boolean {
    return this.resume.reconnect;
  }

  stopBackground(): boolean {
    if (this.turnState || !this.burstRendering || !this.followUpState || !this.conn || !this.active) return false;
    this.cancelledTools = new Set(this.followUpState.state.toolLedger.keys());
    console.log(`[acp] ${this.conversationId}: stopping background output on request`);
    void this.conn.agent.notify('session/cancel', { sessionId: this.active.sessionId });
    flushPendingTools(this.followUpState.state, false);
    void this.closeFollowUp('stopped');
    return true;
  }

  async sideQuestion(input: { prompt: string; sessionToken: string }, handlers: AgentStreamHandlers): Promise<'done' | 'stopped'> {
    if (!this.active && !this.store?.agentSession(this.conversationId, this.def.id)) {
      throw new SideQuestionRefused(`Nothing to ask ${this.def.id} about yet: it has no conversation here. Send it a message first.`);
    }
    await this.ensureStarted(input.sessionToken);
    const refusal = sideQuestionRefusal(this.def.id, this.def.harness, this.forkSupport, this.turnState !== undefined);
    if (refusal) throw new SideQuestionRefused(refusal);
    const [connection, parent] = [this.conn, this.active];
    if (!connection || !parent) throw new Error(`agent "${this.def.id}" went away before the question could be asked`);
    return askOnFork({
      ctx: connection.agent,
      parentId: parent.sessionId,
      cwd: this.cwd,
      support: this.forkSupport,
      prompt: this.blocksOf({ prompt: input.prompt }),
      state: { handlers, lastSegment: 'none', toolLedger: new Map(), toolIndexSeq: 0, subagents: new Map() },
      translate: translateUpdate,
      silenceMs: this.turnTimeoutMs,
      label: this.conversationId,
      track: (forkId, handle) => {
        if (handle) this.sideAsks.set(forkId, handle);
        else this.sideAsks.delete(forkId);
      },
    });
  }

  stopSideQuestions(): number {
    for (const handle of this.sideAsks.values()) handle.cancel();
    return this.sideAsks.size;
  }

  async forkFrom(input: { sessionId: string; sessionToken: string }): Promise<void> {
    if (this.active || this.starting || this.proc) {
      throw new Error(`agent "${this.def.id}" already has a session here; a fork must be its first`);
    }
    this.forkSeed = input.sessionId;
    try {
      await this.ensureStarted(input.sessionToken);
    } finally {
      this.forkSeed = undefined;
    }
  }

  canFork(): boolean | undefined {
    return this.forkKnown ? this.forkSupport.fork : undefined;
  }

  async ensureSession(sessionToken: string): Promise<void> {
    await this.ensureStarted(sessionToken);
  }

  private liveTarget(): { ctx: ClientContext; sessionId: string } | undefined {
    return this.conn && this.active ? { ctx: this.conn.agent, sessionId: this.active.sessionId } : undefined;
  }

  modelSelector(): ModelSelector | undefined {
    return this.options.modelSelector();
  }

  setModel(value: string): Promise<string> {
    return this.options.setModel(value, this.liveTarget());
  }

  effortSelector(): EffortSelector | undefined {
    return this.options.effortSelector();
  }

  setEffort(value: string): Promise<string> {
    return this.options.setEffort(value, this.liveTarget());
  }

  sessionOptions(): SessionOption[] | undefined {
    return this.options.sessionOptions();
  }

  setOption(id: string, value: string): Promise<SessionOption[]> {
    return this.options.setOption(id, value, this.liveTarget());
  }

  permissionModes(): SessionModeSelector | undefined {
    return this.options.permissionModes();
  }

  async applyPermissions(): Promise<void> {
    const live = this.liveTarget();
    if (!live) return;
    await this.options.reapplyPermissionLevel(live.ctx, live.sessionId);
  }

  reclaimState(): ReclaimState {
    if (!this.proc || !this.active) return 'no-child';
    return this.canResume() ? 'resumable' : 'unresumable';
  }

  dispose(): void {
    this.disposed = true;
    this.stopRedial?.abort();
    this.disposeChild();
  }
}
